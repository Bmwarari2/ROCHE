import { generateKeyPairSync } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createDatabase } from "@harbour/db";
import { DEMO } from "@harbour/db/seed";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createAuth, isBlockedSsoPath, SSO_DISABLED_PATHS } from "../src/auth/better-auth";
import { FACTOR_ROUTES } from "../src/auth/session-factor";
import { loadConfig } from "../src/config";
import { createLogger } from "../src/logger";
import {
  createSsoHooks,
  createSsoKeyStore,
  discoverPublic,
  isPublicAddress,
} from "../src/services/sso";
import {
  ageSession,
  createHarness,
  type Harness,
  markSessionsVerified,
  OTHER,
} from "./support/harness";

/**
 * Single sign-on through the API (PLAT-005; platform.md, Phase 2: single sign-on, rules 15 to 22;
 * ADR-0091; HZ-112; migration 0095): configuration with step-up and no secret anywhere, domain
 * proof by DNS, the Better Auth sign-in started with PKCE, the callback's policy (link an active
 * member, link an invited one, refuse everyone else), and Harbour's own second factor still needed
 * for care records. The identity provider and DNS are mocked; invented members only.
 */

const KEY_REF = `harbour/sso/${DEMO.tenantId}/demo`;
const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
const PEM = privateKey.export({ type: "pkcs8", format: "pem" }).toString();
const ISSUER = "https://login.example.invalid/demo";
const PROVIDER = `harbour-${DEMO.tenantId}`;
const DOMAIN = "example.invalid";
const NOTES = "/v1/people/0194d000-0000-7000-8600-000000000001/notes";
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
  // Single sign-on is off by default (platform.sso); this organisation switches it on.
  await owner("INSERT INTO feature_flag (flag_key, enabled) VALUES ('platform.sso', true)");
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
      { privateKeyRef: `harbour/sso/${DEMO.tenantId}/missing` },
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
      db: createDatabase(h.db.pool("harbour_app")),
      authPool: h.db.pool("harbour_auth"),
      keys: createSsoKeyStore(loadConfig({ SSO_TEST_KEYS: JSON.stringify({ [KEY_REF]: PEM }) })),
      logger: createLogger("silent"),
    });
  const user = (email: string, emailVerified = true, accountId = `sub-${email.toLowerCase()}`) => ({
    providerId: PROVIDER,
    accountKey: { issuer: ISSUER, accountId },
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
    // Linked only for a sign-in that came through this provider (#33 review L1).
    await hooks().linkInvitedMember(PROVIDER, "auth-ivy");
    expect(
      (
        await owner<{ status: string }>("SELECT status FROM tenant_user WHERE id = $1", [INVITED])
      )[0]?.status,
    ).toBe("invited");
    await h.db
      .pool("harbour_owner")
      .query(
        "INSERT INTO auth.account (id, account_id, provider_id, user_id, created_at, updated_at) VALUES ('acc-ivy', 'sub-ivy', $1, 'auth-ivy', now(), now())",
        [PROVIDER],
      );
    await hooks().linkInvitedMember(PROVIDER, "auth-ivy");
    const [member] = await owner<{ status: string; auth_user_id: string }>(
      "SELECT status, auth_user_id FROM tenant_user WHERE id = $1",
      [INVITED],
    );
    expect(member).toEqual({ status: "active", auth_user_id: "auth-ivy" });
  });

  it("H2: refuses a provider account already linked to another sign-in, through this issuer or another organisation's", async () => {
    // The manager's provider account is linked to the carer's sign-in (as if another
    // organisation's provider with the same issuer had linked it).
    await h.db
      .pool("harbour_owner")
      .query(
        "INSERT INTO auth.account (id, account_id, provider_id, user_id, created_at, updated_at) VALUES ('acc-taken', 'sub-taken', $1, $2, now(), now())",
        [PROVIDER, h.authIds.carer],
      );
    expect(
      await hooks().resolveUser(user(DEMO.users.manager.email, true, "sub-taken")),
    ).toMatchObject({ action: "reject", code: "sso_account_bound_elsewhere" });
  });

  it("gives the plugin the key from the store, and none for anything else", async () => {
    expect(await hooks().resolvePrivateKey({ providerId: PROVIDER })).toEqual({
      privateKeyPem: PEM,
    });
    expect(await hooks().resolvePrivateKey({ providerId: "google" })).toEqual({});
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

describe("#33 security review", () => {
  it.each([
    ["a private address", "https://10.0.0.1"],
    ["loopback by name", "https://localhost"],
    ["a name that resolves to a private address", "https://vm"],
    ["cloud metadata", "https://169.254.169.254"],
    ["plain http", "http://idp.example.test"],
  ])("H1: discovery to %s is refused, with a generic error", async (_name, issuer) => {
    await expect(
      discoverPublic(issuer, `${issuer}/.well-known/openid-configuration`),
    ).rejects.toThrow(/^sso_discovery_failed$/);
  });

  const publicNet = (addresses: Record<string, string[]>, document: Record<string, unknown>) => ({
    lookup: async (host: string) => addresses[host] ?? [],
    fetchJson: async () => document,
  });
  const goodDocument = {
    issuer: "https://idp.example.test/demo",
    authorization_endpoint: "https://idp.example.test/demo/authorize",
    token_endpoint: "https://idp.example.test/demo/token",
    jwks_uri: "https://idp.example.test/demo/jwks",
    userinfo_endpoint: "https://idp.example.test/demo/userinfo",
    response_types_supported: ["code"],
    subject_types_supported: ["public"],
    id_token_signing_alg_values_supported: ["RS256"],
  };

  it("M: discovery against a public provider succeeds, with normalised endpoints", async () => {
    const endpoints = await discoverPublic(
      "https://idp.example.test/demo",
      "https://idp.example.test/demo/.well-known/openid-configuration",
      publicNet({ "idp.example.test": ["203.0.113.10"] }, goodDocument),
    );
    expect(endpoints.tokenEndpoint).toBe("https://idp.example.test/demo/token");
    expect(endpoints.jwksEndpoint).toBe("https://idp.example.test/demo/jwks");
  });

  it.each([
    [
      "the provider resolving to a private address",
      { "idp.example.test": ["10.1.2.3"] },
      goodDocument,
    ],
    [
      "an endpoint on a private host",
      { "idp.example.test": ["203.0.113.10"], "inside.example.test": ["192.168.1.5"] },
      { ...goodDocument, token_endpoint: "https://inside.example.test/token" },
    ],
    [
      "a mismatched issuer",
      { "idp.example.test": ["203.0.113.10"] },
      { ...goodDocument, issuer: "https://other.example.test" },
    ],
  ])("M: discovery is refused for %s", async (_name, addresses, document) => {
    await expect(
      discoverPublic(
        "https://idp.example.test/demo",
        "https://idp.example.test/demo/.well-known/openid-configuration",
        publicNet(addresses, document),
      ),
    ).rejects.toThrow(/^sso_discovery_failed$/);
  });

  it("public address check", () => {
    for (const ip of [
      "10.0.0.1",
      "127.0.0.1",
      "169.254.169.254",
      "192.168.0.1",
      "100.64.0.1",
      "::1",
      "fe80::1",
      "fd00::1",
    ])
      expect(isPublicAddress(ip), ip).toBe(false);
    for (const ip of ["203.0.113.10", "8.8.8.8", "2001:4860:4860::8888"])
      expect(isPublicAddress(ip), ip).toBe(true);
  });

  it("H1: the connection is checked before any discovery, and discovery errors say nothing of the provider", async () => {
    // A key outside the organisation's prefix is refused before discovery would run.
    const r = await send(
      "PUT",
      "/v1/sso/connection",
      "owner",
      connection({ enabled: true, privateKeyRef: "harbour/sso/other/demo", expectedVersion: 1 }),
    );
    expect(r.status).toBe(422);
  });

  it("M2: no identity provider is ever a trusted origin", () => {
    const auth = createAuth(loadConfig({}), h.db.pool("harbour_auth"));
    const trusted = auth.options.trustedOrigins as string[];
    expect(Array.isArray(trusted)).toBe(true);
    expect(trusted.some((o) => o.includes("login.example.invalid"))).toBe(false);
  });

  it("H2: a new issuer switches SSO off until the domains are proved again", async () => {
    const [before] = await owner<{ version: number }>("SELECT version FROM sso_connection");
    const r = await send(
      "PUT",
      "/v1/sso/connection",
      "owner",
      connection({
        issuer: "https://login2.example.invalid/demo",
        discoveryUrl: "https://login2.example.invalid/demo/.well-known/openid-configuration",
        enabled: true,
        expectedVersion: before?.version,
      }),
    );
    expect(r.status).toBe(200);
    expect(((await r.json()) as { enabled: boolean }).enabled).toBe(false);
    const domains = await owner<{ verified_at: Date | null }>(
      "SELECT verified_at FROM sso_domain WHERE removed_at IS NULL",
    );
    expect(domains.every((d) => d.verified_at === null)).toBe(true);
    const provider = await h.db
      .pool("harbour_auth")
      .query("SELECT 1 FROM auth.sso_provider WHERE provider_id = $1", [PROVIDER]);
    expect(provider.rows).toHaveLength(0);
  });

  it("H1/H2: an SSO session reaches only its organisation, and only a few auth routes", async () => {
    const auth = h.db.pool("harbour_auth");
    const token = (h.tokens.manager ?? "").split(".")[0];
    await auth.query("UPDATE auth.session SET sso_tenant_id = $2 WHERE token = $1", [
      token,
      OTHER.tenantId,
    ]);
    try {
      expect((await h.request(NOTES, as("manager"))).status).toBe(403);
      // Better Auth's own routes: only reading itself, signing out and confirming a code.
      for (const path of [
        "/api/auth/list-sessions",
        "/api/auth/passkey/generate-register-options",
      ]) {
        const r = await h.request(path, as("manager"));
        expect(r.status, path).toBe(403);
        expect(await codeOf(r)).toBe("sso_session_limited");
      }
      const linking = await h.request("/api/auth/link-social", {
        method: "POST",
        body: {},
        ...as("manager"),
      });
      expect(linking.status).toBe(403);
      expect((await h.request("/api/auth/get-session", as("manager"))).status).toBe(200);
    } finally {
      await auth.query("UPDATE auth.session SET sso_tenant_id = NULL WHERE token = $1", [token]);
    }
    expect((await h.request(NOTES, as("manager"))).status).toBe(200);
  });

  it("H2: no one, not even the mobile app, is given other sessions' tokens", async () => {
    const r = await h.request("/api/auth/list-sessions", {
      ...as("manager"),
      origin: "harbour://",
    });
    expect(r.status).toBe(200);
    expect(JSON.stringify(await r.json())).not.toMatch(/"token"/);
  });

  it("H3: an invited member whose address already has a Harbour sign-in is told to sign in first", async () => {
    await h.db
      .pool("harbour_owner")
      .query(
        "INSERT INTO auth.user (id, name, email, email_verified) VALUES ('auth-zed', 'Zed Existing', 'zed.existing@example.invalid', true)",
      );
    await owner(
      `INSERT INTO tenant_user (id, display_name, email, status)
       VALUES ('0194d000-0000-7000-8000-0000000003c1', 'Zed Existing', 'zed.existing@example.invalid', 'invited')`,
    );
    await owner(
      `INSERT INTO role_assignment (tenant_user_id, role_id, location_id)
       SELECT '0194d000-0000-7000-8000-0000000003c1', id, $1 FROM role WHERE key = 'care_worker'`,
      [DEMO.locationId],
    );
    // The connection is on and its domain proved (again, after the issuer change above).
    await owner("UPDATE sso_connection SET enabled = true");
    await owner(
      "UPDATE sso_domain SET verified_at = now(), verified_by = $1 WHERE removed_at IS NULL",
      [DEMO.users.owner.id],
    );
    const hooks = createSsoHooks({
      db: createDatabase(h.db.pool("harbour_app")),
      authPool: h.db.pool("harbour_auth"),
      keys: createSsoKeyStore(loadConfig({})),
      logger: createLogger("silent"),
    });
    expect(
      await hooks.resolveUser({
        providerId: PROVIDER,
        accountKey: { issuer: ISSUER, accountId: "sub-zed" },
        providerUser: { email: "zed.existing@example.invalid", emailVerified: true },
      }),
    ).toMatchObject({ action: "reject", code: "sign_in_first" });
  });

  it("the platform.sso flag is off by default: no configuration and no sign-in until it is on", async () => {
    await owner("UPDATE feature_flag SET enabled = false WHERE flag_key = 'platform.sso'");
    try {
      expect((await send("GET", "/v1/sso", "owner")).status).toBe(403);
      const start = await h.request("/api/auth/sign-in/sso", {
        method: "POST",
        body: { providerId: PROVIDER, callbackURL: "http://localhost:3000/" },
        origin: "http://localhost:3000",
      });
      expect(start.status).toBe(404);
      const callback = await h.request(`/api/auth/sso/callback/${PROVIDER}?code=x&state=y`);
      expect(callback.status).toBe(404);
    } finally {
      await owner("UPDATE feature_flag SET enabled = true WHERE flag_key = 'platform.sso'");
    }
  });

  it("L2: SAML and the provider-less callback are refused before Better Auth", async () => {
    for (const path of [
      "/api/auth/sso/callback",
      `/api/auth/sso/saml2/sp/acs/${PROVIDER}`,
      "/api/auth/sso/saml2/sp/metadata",
      `/api/auth/sso/saml2/logout/${PROVIDER}`,
    ]) {
      expect(isBlockedSsoPath(path), path).toBe(true);
      const r = await h.request(path, { method: "POST", body: {} });
      expect(r.status, path).toBe(404);
    }
    expect(isBlockedSsoPath(`/api/auth/sso/callback/${PROVIDER}`)).toBe(false);
  });
});
