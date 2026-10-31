import { generateKeyPairSync } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DEMO } from "@harbour/db/seed";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { SSO_DISABLED_PATHS } from "../src/auth/better-auth";
import { FACTOR_ROUTES } from "../src/auth/session-factor";
import { MOBILE_APP_ORIGIN } from "../src/auth/token-exposure";
import { loadConfig } from "../src/config";
import { createLogger } from "../src/logger";
import { createSsoHooks, createSsoKeyStore } from "../src/services/sso";
import { ageSession, createHarness, type Harness, markSessionsVerified } from "./support/harness";

/**
 * Single sign-on through the API (PLAT-005; platform.md, Phase 2: single sign-on, rules 15 to 22;
 * ADR-0091; HZ-112; migration 0095): configuration with step-up and no secret anywhere, domain
 * proof by DNS, the Better Auth sign-in started with PKCE, the callback's policy (link an active
 * member, link an invited one, refuse everyone else), and Harbour's own second factor still needed
 * for care records. The identity provider and DNS are mocked; invented members only.
 */

const KEY_REF = "harbour/sso/demo";
const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
const PEM = privateKey.export({ type: "pkcs8", format: "pem" }).toString();
const ISSUER = "https://login.example.invalid/demo";
const PROVIDER = `harbour-${DEMO.tenantId}`;
const DOMAIN = "example.invalid";
const INVITED = "0194d000-0000-7000-8000-0000000003a1";

let h: Harness;
let dir: string;
let txtFile: string;

const as = (who: string) => ({ token: h.tokens[who], tenant: DEMO.tenantId });
const send = (method: string, path: string, who: string, body?: unknown) =>
  h.request(path, { method, ...(body !== undefined ? { body } : {}), ...as(who) });
const codeOf = async (r: Response) => ((await r.json()) as { code: string }).code;

const connection = (o: Record<string, unknown> = {}) => ({
  issuer: ISSUER,
  discoveryUrl: `${ISSUER}/.well-known/openid-configuration`,
  clientId: "harbour-demo",
  privateKeyRef: KEY_REF,
  allowedRoleKeys: ["registered_manager", "care_worker"],
  enabled: false,
  expectedVersion: null,
  ...o,
});

async function owner<T = Record<string, unknown>>(text: string, values: unknown[] = []) {
  const client = await h.db.pool("harbour_owner").connect();
  try {
    await client.query("BEGIN");
    await client.query(
      "SELECT set_config('app.tenant_id', $1, true), set_config('app.scope', 'tenant', true)",
      [DEMO.tenantId],
    );
    const result = await client.query(text, values);
    await client.query("COMMIT");
    return result.rows as T[];
  } finally {
    client.release();
  }
}

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), "harbour-sso-"));
  txtFile = join(dir, "txt.json");
  writeFileSync(txtFile, "{}");
  h = await createHarness({
    SSO_TEST_KEYS: JSON.stringify({ [KEY_REF]: PEM }),
    SSO_LOOKUPS: "mock",
    SSO_MOCK_TXT: txtFile,
  });
  await owner(
    `INSERT INTO tenant_user (id, display_name, email, status)
     VALUES ($1, 'Ivy Invited', 'ivy.invited@example.invalid', 'invited')`,
    [INVITED],
  );
  await owner(
    `INSERT INTO role_assignment (tenant_user_id, role_id, location_id)
     SELECT $1, id, $2 FROM role WHERE key = 'care_worker'`,
    [INVITED, DEMO.locationId],
  );
}, 120_000);

afterAll(async () => {
  await h?.close();
  rmSync(dir, { recursive: true, force: true });
});

describe("PLAT-005 the configuration (rules 18, 19, 22)", () => {
  let version = 0;

  it("is read and changed only by platform.tenant.manage", async () => {
    const r = await send("GET", "/v1/sso", "owner");
    expect(r.status).toBe(200);
    expect(await r.json()).toEqual({ connection: null, domains: [] });
    expect((await send("GET", "/v1/sso", "carer")).status).toBe(403);
    expect((await send("PUT", "/v1/sso/connection", "carer", connection())).status).toBe(403);
  });

  it.each([
    [
      "a client secret",
      { tokenEndpointAuthentication: "client_secret_basic" },
      "client_secret_not_allowed",
    ],
    ["an http issuer", { issuer: "http://login.example.invalid" }, "issuer_not_https"],
    [
      "a key pasted in place of its name",
      { privateKeyRef: "-----BEGIN PRIVATE KEY-----" },
      "key_ref_invalid",
    ],
    [
      "a key missing from the store",
      { privateKeyRef: "harbour/sso/missing" },
      "sso_key_not_in_store",
    ],
    ["switching on with no verified domain", { enabled: true }, "sso_domain_required"],
  ])("refuses %s", async (_name, change, code) => {
    const r = await send("PUT", "/v1/sso/connection", "owner", connection(change));
    expect(r.status).toBe(422);
    const body = (await r.json()) as { code: string; detail?: string };
    expect([body.code, body.detail]).toContain(code);
  });

  it("needs a fresh step-up to change anything", async () => {
    const auth = h.db.pool("harbour_auth");
    const session = h.tokens.owner?.split(".")[0] ?? "";
    await ageSession(auth, session, 3_600);
    try {
      const r = await send("PUT", "/v1/sso/connection", "owner", connection());
      expect(r.status).toBe(403);
    } finally {
      await ageSession(auth, session, 0);
    }
  });

  it("saves a connection, audited without the key's name", async () => {
    const r = await send("PUT", "/v1/sso/connection", "owner", connection());
    expect(r.status).toBe(200);
    const saved = (await r.json()) as { providerId: string; redirectUri: string; version: number };
    expect(saved.providerId).toBe(PROVIDER);
    expect(saved.redirectUri).toContain(`/api/auth/sso/callback/${PROVIDER}`);
    version = saved.version;
    const audits = await owner<{ scope: unknown }>(
      "SELECT scope FROM audit_event WHERE action LIKE 'platform.sso.%'",
    );
    expect(audits.length).toBeGreaterThan(0);
    expect(JSON.stringify(audits)).not.toContain(KEY_REF);
    // Nothing secret anywhere in the database.
    const [row] = await owner<{ row: unknown }>("SELECT to_jsonb(c) AS row FROM sso_connection c");
    expect(JSON.stringify(row)).not.toContain("PRIVATE KEY");
  });

  it("claims a domain, refuses a public one, and verifies it only from the DNS record", async () => {
    expect((await send("POST", "/v1/sso/domains", "owner", { domain: "gmail.com" })).status).toBe(
      422,
    );
    const r = await send("POST", "/v1/sso/domains", "owner", { domain: DOMAIN });
    expect(r.status).toBe(201);
    const claim = (await r.json()) as {
      domain: { id: string; version: number };
      record: { name: string; value: string };
    };
    expect(claim.record.name).toBe(`_harbour-verification.${DOMAIN}`);
    // The token is kept only as a hash.
    const stored = await owner<{ token_sha256: string }>("SELECT token_sha256 FROM sso_domain");
    expect(JSON.stringify(stored)).not.toContain(claim.record.value.split("=")[1] ?? "x");

    let v = await send("POST", `/v1/sso/domains/${claim.domain.id}/verify`, "owner", {
      expectedVersion: claim.domain.version,
    });
    expect(v.status).toBe(422);
    expect(await codeOf(v)).toBe("sso_domain_not_proved");
    writeFileSync(
      txtFile,
      JSON.stringify({ [claim.record.name]: ["v=spf1 -all", claim.record.value] }),
    );
    v = await send("POST", `/v1/sso/domains/${claim.domain.id}/verify`, "owner", {
      expectedVersion: claim.domain.version,
    });
    expect(v.status).toBe(200);
    expect(((await v.json()) as { verifiedAt: string | null }).verifiedAt).not.toBeNull();
  });

  it("switches on, writing Better Auth's provider with the endpoints and no secret", async () => {
    const r = await send(
      "PUT",
      "/v1/sso/connection",
      "owner",
      connection({ enabled: true, expectedVersion: version }),
    );
    expect(r.status).toBe(200);
    const [row] = await h.db
      .pool("harbour_auth")
      .query<{ oidc_config: string; domain: string }>(
        "SELECT oidc_config, domain FROM auth.sso_provider WHERE provider_id = $1",
        [PROVIDER],
      )
      .then((x) => x.rows);
    expect(row?.domain).toBe(DOMAIN);
    const config = JSON.parse(row?.oidc_config ?? "{}") as Record<string, unknown>;
    expect(config).toMatchObject({
      clientId: "harbour-demo",
      tokenEndpointAuthentication: "private_key_jwt",
      tokenEndpoint: `${ISSUER}/token`,
      pkce: true,
    });
    expect(config).not.toHaveProperty("clientSecret");
    expect(row?.oidc_config).not.toContain("PRIVATE KEY");
  });

  it("keeps Better Auth's own provider routes switched off", async () => {
    for (const path of SSO_DISABLED_PATHS) {
      const r = await h.request(`/api/auth${path}`, { method: "POST", body: {}, ...as("owner") });
      expect([404, 405]).toContain(r.status);
    }
  });
});

describe("the SSO callback's policy (rules 15, 16, 20)", () => {
  const hooks = () =>
    createSsoHooks({
      appPool: h.db.pool("harbour_app"),
      keys: createSsoKeyStore(loadConfig({ SSO_TEST_KEYS: JSON.stringify({ [KEY_REF]: PEM }) })),
      logger: createLogger("silent"),
    });
  const user = (email: string, emailVerified = true) => ({
    providerId: PROVIDER,
    providerUser: { email, emailVerified },
  });

  it("links an active member with an allowed role to their own sign-in", async () => {
    const r = await hooks().resolveUser(user(DEMO.users.manager.email.toUpperCase()));
    expect(r).toMatchObject({ action: "link", profile: "preserve" });
    expect((r as { userId: string }).userId).toBe(h.authIds.manager);
  });

  it.each([
    ["a stranger", "sam.stranger@example.invalid", true, "not_a_member"],
    ["a role not allowed", DEMO.users.owner.email, true, "role_not_allowed"],
    [
      "an address the provider did not verify",
      DEMO.users.manager.email,
      false,
      "email_not_verified",
    ],
    ["an unverified domain", "manager@elsewhere.example", true, "domain_not_verified"],
  ] as const)("refuses %s", async (_name, email, verified, code) => {
    expect(await hooks().resolveUser(user(email, verified))).toMatchObject({
      action: "reject",
      code,
    });
  });

  it("refuses a provider Harbour did not make", async () => {
    expect(
      await hooks().resolveUser({ ...user(DEMO.users.manager.email), providerId: "google" }),
    ).toMatchObject({ action: "reject" });
  });

  it("lets an invited member through, then links the sign-in Better Auth created", async () => {
    expect(await hooks().resolveUser(user("ivy.invited@example.invalid"))).toEqual({
      action: "continue",
    });
    await h.db
      .pool("harbour_owner")
      .query(
        "INSERT INTO auth.user (id, name, email, email_verified) VALUES ('auth-ivy', 'Ivy Invited', 'ivy.invited@example.invalid', true)",
      );
    await hooks().linkInvitedMember(PROVIDER, "auth-ivy");
    const [member] = await owner<{ status: string; auth_user_id: string }>(
      "SELECT status, auth_user_id FROM tenant_user WHERE id = $1",
      [INVITED],
    );
    expect(member).toEqual({ status: "active", auth_user_id: "auth-ivy" });
  });

  it("gives the plugin the key from the store, and none for anything else", async () => {
    expect(await hooks().resolvePrivateKey({ providerId: PROVIDER })).toEqual({
      privateKeyPem: PEM,
    });
    expect(await hooks().resolvePrivateKey({ providerId: "google" })).toEqual({});
  });

  it("starts the sign-in at the provider with PKCE and Harbour's client id", async () => {
    const r = await h.request("/api/auth/sign-in/sso", {
      method: "POST",
      body: { providerId: PROVIDER, callbackURL: "http://localhost:3000/" },
      origin: MOBILE_APP_ORIGIN,
    });
    const body = (await r.json()) as { url?: string };
    expect(r.status, JSON.stringify(body)).toBe(200);
    const url = new URL(body.url ?? "");
    expect(`${url.origin}${url.pathname}`).toBe(`${ISSUER}/authorize`);
    expect(url.searchParams.get("client_id")).toBe("harbour-demo");
    expect(url.searchParams.get("code_challenge_method")).toBe("S256");
  });
});

describe("hazard HZ-112 SSO is never Harbour's second factor (rule 21)", () => {
  it("records a factor only on Harbour's own passkey and code routes, never on an SSO route", () => {
    expect([...FACTOR_ROUTES.keys()].some((path) => path.includes("sso"))).toBe(false);
  });

  it("refuses care records to a session that has used no Harbour factor", async () => {
    // The manager's session with its factor record taken away: the state an SSO callback leaves.
    const auth = h.db.pool("harbour_auth");
    const token = h.tokens.manager ?? "";
    const resident = "0194d000-0000-7000-8600-000000000001";
    const notes = () => h.request(`/v1/people/${resident}/notes`, as("manager"));
    expect((await notes()).status).toBe(200);
    await auth.query(
      `DELETE FROM auth.verification v USING auth.session s
        WHERE s.token = $1 AND v.identifier = 'session-factor:' || s.id`,
      [token.split(".")[0]],
    );
    try {
      const r = await notes();
      expect(r.status).toBe(403);
      expect(["mfa_verification_required", "mfa_enrolment_required"]).toContain(await codeOf(r));
    } finally {
      await markSessionsVerified(auth);
    }
    expect((await notes()).status).toBe(200);
  });
});
