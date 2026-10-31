import { createSign, generateKeyPairSync, type KeyObject } from "node:crypto";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { DEMO } from "@harbour/db/seed";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createHarness, type Harness } from "./support/harness";

/**
 * Single sign-on end to end (PLAT-005; ADR-0091; #33 review M1): Better Auth's real sign-in and
 * callback against a local mock identity provider. The provider is trusted only through
 * SSO_TEST_IDP_ORIGINS, a test-only setting production refuses; everything else is as deployed:
 * private_key_jwt with a key from the key store, PKCE, the ID token verified against the
 * provider's keys, the callback's policy, the invited member linked, and the session bound to the
 * organisation. Invented members only.
 */

const PROVIDER = `harbour-${DEMO.tenantId}`;
const KEY_REF = `harbour/sso/${DEMO.tenantId}/demo`;
const CLIENT_ID = "harbour-demo";
const INVITED = "0194d000-0000-7000-8000-0000000003b1";
const INVITED_EMAIL = "una.invited@example.invalid";

const clientKey = generateKeyPairSync("rsa", { modulusLength: 2048 }).privateKey;
const idpKey = generateKeyPairSync("rsa", { modulusLength: 2048 });

let h: Harness;
let idp: Server;
let issuer = "";
/** Who the mock provider says signs in next. */
let nextUser = { sub: "sub-una", email: INVITED_EMAIL };

const b64url = (value: Buffer | string) => Buffer.from(value).toString("base64url");

function idToken(key: KeyObject, claims: Record<string, unknown>): string {
  const head = b64url(JSON.stringify({ alg: "RS256", kid: "k1", typ: "JWT" }));
  const body = b64url(JSON.stringify(claims));
  const signature = createSign("RSA-SHA256").update(`${head}.${body}`).sign(key);
  return `${head}.${body}.${b64url(signature)}`;
}

function startIdp(): Promise<void> {
  idp = createServer((req, res) => {
    const json = (status: number, body: unknown) => {
      res.writeHead(status, { "content-type": "application/json" });
      res.end(JSON.stringify(body));
    };
    const now = Math.floor(Date.now() / 1000);
    if (req.url?.startsWith("/jwks")) {
      return json(200, {
        keys: [
          { ...idpKey.publicKey.export({ format: "jwk" }), kid: "k1", alg: "RS256", use: "sig" },
        ],
      });
    }
    if (req.url?.startsWith("/token") && req.method === "POST") {
      return json(200, {
        access_token: "at-1",
        token_type: "Bearer",
        expires_in: 300,
        id_token: idToken(idpKey.privateKey, {
          iss: issuer,
          aud: CLIENT_ID,
          sub: nextUser.sub,
          email: nextUser.email,
          email_verified: true,
          name: "Una Invited",
          iat: now,
          exp: now + 300,
        }),
      });
    }
    if (req.url?.startsWith("/userinfo")) {
      return json(200, {
        sub: nextUser.sub,
        email: nextUser.email,
        email_verified: true,
        name: "Una Invited",
      });
    }
    return json(404, {});
  });
  return new Promise((resolve) => idp.listen(0, "127.0.0.1", resolve));
}

async function owner(text: string, values: unknown[] = []) {
  const client = await h.db.pool("harbour_owner").connect();
  try {
    await client.query("BEGIN");
    await client.query(
      "SELECT set_config('app.tenant_id', $1, true), set_config('app.scope', 'tenant', true)",
      [DEMO.tenantId],
    );
    const result = await client.query(text, values);
    await client.query("COMMIT");
    return result.rows;
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

/** Starts a sign-in, plays the provider's redirect back, and returns the callback's response. */
async function signInThroughProvider(): Promise<Response> {
  const start = await h.request("/api/auth/sign-in/sso", {
    method: "POST",
    body: { providerId: PROVIDER, callbackURL: "http://localhost:3000/" },
    origin: "http://localhost:3000",
  });
  const body = (await start.json()) as { url?: string };
  expect(start.status, JSON.stringify(body)).toBe(200);
  const url = new URL(body.url ?? "");
  expect(`${url.origin}${url.pathname}`).toBe(`${issuer}/authorize`);
  expect(url.searchParams.get("client_id")).toBe(CLIENT_ID);
  expect(url.searchParams.get("code_challenge_method")).toBe("S256");
  const cookies = (start.headers.getSetCookie?.() ?? []).map((c) => c.split(";")[0]).join("; ");
  const state = url.searchParams.get("state") ?? "";
  return h.request(
    `/api/auth/sso/callback/${PROVIDER}?code=code-1&state=${encodeURIComponent(state)}`,
    {
      headers: { cookie: cookies },
    },
  );
}

beforeAll(async () => {
  await startIdp();
  issuer = `http://127.0.0.1:${(idp.address() as AddressInfo).port}`;
  h = await createHarness({
    SSO_TEST_KEYS: JSON.stringify({
      [KEY_REF]: clientKey.export({ type: "pkcs8", format: "pem" }).toString(),
    }),
    SSO_LOOKUPS: "mock",
    SSO_TEST_IDP_ORIGINS: issuer,
  });
  await owner(
    `INSERT INTO tenant_user (id, display_name, email, status) VALUES ($1, 'Una Invited', $2, 'invited')`,
    [INVITED, INVITED_EMAIL],
  );
  await owner(
    `INSERT INTO role_assignment (tenant_user_id, role_id, location_id)
     SELECT $1, id, $2 FROM role WHERE key = 'care_worker'`,
    [INVITED, DEMO.locationId],
  );
  // The organisation's connection and verified domain, and Better Auth's projection of it with
  // the local provider's endpoints (what the API writes after discovery).
  await owner(
    `INSERT INTO sso_connection (provider_id, issuer, discovery_url, client_id, private_key_ref,
       allowed_role_keys, enabled)
     VALUES ($1, 'https://idp.example.invalid', 'https://idp.example.invalid/.well-known/openid-configuration',
       $2, $3, '{care_worker,registered_manager}', true)`,
    [PROVIDER, CLIENT_ID, KEY_REF],
  );
  await owner(
    `INSERT INTO sso_domain (domain, token_sha256, verified_at, verified_by)
     VALUES ('example.invalid', repeat('a', 64), now(), $1)`,
    [DEMO.users.owner.id],
  );
  await h.db.pool("harbour_auth").query(
    `INSERT INTO auth.sso_provider (id, issuer, oidc_config, provider_id, domain)
     VALUES ($1, $2, $3, $1, 'example.invalid')`,
    [
      PROVIDER,
      issuer,
      JSON.stringify({
        issuer,
        clientId: CLIENT_ID,
        authorizationEndpoint: `${issuer}/authorize`,
        tokenEndpoint: `${issuer}/token`,
        jwksEndpoint: `${issuer}/jwks`,
        userInfoEndpoint: `${issuer}/userinfo`,
        tokenEndpointAuthentication: "private_key_jwt",
        pkce: true,
        scopes: ["openid", "email", "profile"],
      }),
    ],
  );
}, 120_000);

afterAll(async () => {
  await h?.close();
  await new Promise((resolve) => idp?.close(resolve));
});

describe("PLAT-005 a real SSO sign-in (#33 review M1)", () => {
  it("signs an invited member in, links them, and binds the session to the organisation", async () => {
    const callback = await signInThroughProvider();
    expect([302, 303]).toContain(callback.status);
    expect(callback.headers.get("location") ?? "").not.toContain("error");
    const [member] = await owner("SELECT status, auth_user_id FROM tenant_user WHERE id = $1", [
      INVITED,
    ]);
    expect(member?.status).toBe("active");
    expect(member?.auth_user_id).toBeTruthy();
    const auth = h.db.pool("harbour_auth");
    const accounts = await auth.query(
      "SELECT account_id FROM auth.account WHERE user_id = $1 AND provider_id = $2",
      [member?.auth_user_id, PROVIDER],
    );
    expect(accounts.rows.map((r) => r.account_id)).toEqual(["sub-una"]);
    const bound = await auth.query(
      `SELECT v.value FROM auth.verification v JOIN auth.session s
         ON v.identifier = 'session-sso-tenant:' || s.id WHERE s.user_id = $1`,
      [member?.auth_user_id],
    );
    expect(bound.rows.map((r) => r.value)).toEqual([DEMO.tenantId]);
  });

  it("refuses a stranger the provider vouches for, and creates nothing", async () => {
    nextUser = { sub: "sub-stranger", email: "sam.stranger@example.invalid" };
    const callback = await signInThroughProvider();
    expect(callback.headers.get("location") ?? "").toContain("error");
    const users = await h.db
      .pool("harbour_auth")
      .query("SELECT 1 FROM auth.user WHERE email = 'sam.stranger@example.invalid'");
    expect(users.rows).toHaveLength(0);
  });

  it("refuses the same provider account presented for a different member (H2)", async () => {
    // The provider now says sub-una is the manager: the account belongs to Una's sign-in.
    nextUser = { sub: "sub-una", email: DEMO.users.manager.email };
    const callback = await signInThroughProvider();
    expect(callback.headers.get("location") ?? "").toContain("error");
  });
});
