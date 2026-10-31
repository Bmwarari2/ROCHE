import { createHmac } from "node:crypto";
import type { ProblemDetails } from "@harbour/contracts";
import { DEMO } from "@harbour/db/seed";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { factorIdentifier } from "../src/auth/session-factor";
import { MOBILE_APP_ORIGIN } from "../src/auth/token-exposure";
import { createHarness, type Harness, PASSWORD } from "./support/harness";

/**
 * MFA counts for care records only when the session itself used a second factor (#43 review M5,
 * ADR-0072, HZ-112): a passkey or an authenticator code at sign-in, or a code confirmed on the
 * session. Having one enrolled is not enough, and a session from before the check fails closed.
 * The nurse is the subject: the harness leaves them with no second factor.
 */

let h: Harness;
const resident = (n: number) => `0194d000-0000-7000-8600-${n.toString(16).padStart(12, "0")}`;
const notes = `/v1/people/${resident(1)}/notes`;
const auth = () => h.db.pool("harbour_auth");

beforeAll(async () => {
  h = await createHarness();
}, 120_000);

afterAll(async () => {
  await h?.close();
});

const get = (token: string, path: string) => h.request(path, { token, tenant: DEMO.tenantId });
const code = async (response: Response) => ((await response.json()) as ProblemDetails).code;

/** A password sign-in as the mobile app makes it (only that origin is given a bearer token). */
async function passwordSignIn(): Promise<Response> {
  return h.request("/api/auth/sign-in/email", {
    method: "POST",
    body: { email: DEMO.users.nurse.email, password: PASSWORD },
    origin: MOBILE_APP_ORIGIN,
  });
}

async function sessionIdOf(token: string): Promise<string> {
  const { rows } = await auth().query<{ id: string }>(
    "SELECT id FROM auth.session WHERE token = $1",
    [token.split(".")[0]],
  );
  return rows[0]?.id ?? "";
}

/** A Better Auth call as the mobile app makes it: POST with a body, GET without. */
function authCall(token: string, path: string, body?: unknown): Promise<Response> {
  return h.request(path, {
    method: body === undefined ? "GET" : "POST",
    token,
    origin: MOBILE_APP_ORIGIN,
    ...(body === undefined ? {} : { body }),
  });
}

const authCode = async (response: Response) => ((await response.json()) as { code?: string }).code;

/** RFC 6238 with Better Auth's defaults (SHA-1, 6 digits, 30 seconds), from an otpauth URI. */
function totpFrom(uri: string): string {
  const secret = new URL(uri).searchParams.get("secret") ?? "";
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
  let bits = "";
  for (const char of secret.replace(/=+$/, "").toUpperCase()) {
    bits += alphabet.indexOf(char).toString(2).padStart(5, "0");
  }
  const key = Buffer.from((bits.match(/.{8}/g) ?? []).map((b) => Number.parseInt(b, 2)));
  const counter = Buffer.alloc(8);
  counter.writeBigUInt64BE(BigInt(Math.floor(Date.now() / 30_000)));
  const mac = createHmac("sha1", key).update(counter).digest();
  const offset = (mac[mac.length - 1] ?? 0) & 0xf;
  return ((mac.readUInt32BE(offset) & 0x7fffffff) % 1_000_000).toString().padStart(6, "0");
}

describe("a passkey holder", () => {
  let token = "";

  beforeAll(async () => {
    const signIn = await passwordSignIn();
    expect(signIn.status).toBe(200);
    token = signIn.headers.get("set-auth-token") ?? "";
    expect(token).not.toBe("");
    await auth().query(
      `INSERT INTO auth.passkey (id, name, public_key, user_id, credential_id, counter, device_type, backed_up)
       VALUES ('pk-test', 'Test key', 'not-a-real-key', $1, 'credential-test', 0, 'singleDevice', false)`,
      [h.authIds.nurse],
    );
  });

  it("hazard HZ-112 is refused care records on a password-only session, told to use the passkey", async () => {
    const refused = await get(token, notes);
    expect(refused.status).toBe(403);
    expect(await code(refused)).toBe("mfa_verification_required");
    // Nothing that is not a care record is held back.
    expect((await get(token, "/v1/me")).status).toBe(200);
  });

  it("hazard HZ-112 cannot enrol its own authenticator app or passkey, or remove the member's, on a password-only session", async () => {
    const enable = await authCall(token, "/api/auth/two-factor/enable", { password: PASSWORD });
    expect(enable.status).toBe(403);
    expect(await authCode(enable)).toBe("MFA_VERIFICATION_REQUIRED");
    const options = await authCall(token, "/api/auth/passkey/generate-register-options");
    expect(options.status).toBe(403);
    expect(await authCode(options)).toBe("MFA_VERIFICATION_REQUIRED");
    const register = await authCall(token, "/api/auth/passkey/verify-registration", {
      response: {},
    });
    expect(register.status).toBe(403);
    const remove = await authCall(token, "/api/auth/passkey/delete-passkey", { id: "pk-test" });
    expect(remove.status).toBe(403);
    // Nothing changed: no authenticator app, the passkey still there, care records still refused.
    const { rows } = await auth().query<{ n: number }>(
      `SELECT (SELECT count(*) FROM auth.two_factor WHERE user_id = $1)::int
            + (SELECT count(*) FROM auth.passkey WHERE user_id = $1 AND id <> 'pk-test')::int AS n`,
      [h.authIds.nurse],
    );
    expect(rows[0]?.n).toBe(0);
    expect(await code(await get(token, notes))).toBe("mfa_verification_required");
  });

  it("hazard HZ-112 opens care records once the session signed in with the passkey", async () => {
    const id = await sessionIdOf(token);
    await auth().query(
      `INSERT INTO auth.verification (id, identifier, value, expires_at)
       VALUES (gen_random_uuid()::text, $1, 'passkey', now() + interval '1 hour')`,
      [factorIdentifier(id)],
    );
    expect((await get(token, notes)).status).toBe(200);
    // A session that used its passkey may add another.
    expect((await authCall(token, "/api/auth/passkey/generate-register-options")).status).toBe(200);
  });

  it("hazard HZ-112 refuses again once the passkey is removed, even on that session", async () => {
    await auth().query("DELETE FROM auth.passkey WHERE id = 'pk-test'");
    const refused = await get(token, notes);
    expect(refused.status).toBe(403);
    expect(await code(refused)).toBe("mfa_enrolment_required");
  });
});

describe("an authenticator app holder", () => {
  let totpUri = "";
  let enrolling = "";
  let signedIn = "";

  it("hazard HZ-112 a first enrolment proves only the password: the replacing session counts no factor until the person signs in with it", async () => {
    const signIn = await passwordSignIn();
    enrolling = signIn.headers.get("set-auth-token") ?? "";
    expect((await get(enrolling, notes)).status).toBe(403);

    const enable = await h.request("/api/auth/two-factor/enable", {
      method: "POST",
      token: enrolling,
      origin: MOBILE_APP_ORIGIN,
      body: { password: PASSWORD },
    });
    expect(enable.status).toBe(200);
    totpUri = ((await enable.json()) as { totpURI: string }).totpURI;

    // A wrong code proves nothing.
    const wrong = await h.request("/api/auth/two-factor/verify-totp", {
      method: "POST",
      token: enrolling,
      origin: MOBILE_APP_ORIGIN,
      body: { code: "000000" === totpFrom(totpUri) ? "111111" : "000000" },
    });
    expect(wrong.status).toBe(401);
    expect(await code(await get(enrolling, notes))).toBe("mfa_enrolment_required");

    const verify = await h.request("/api/auth/two-factor/verify-totp", {
      method: "POST",
      token: enrolling,
      origin: MOBILE_APP_ORIGIN,
      body: { code: totpFrom(totpUri) },
    });
    expect(verify.status).toBe(200);
    // Turning two-factor on replaces the session (Better Auth); the new one carries the code.
    const replaced = verify.headers.get("set-auth-token") ?? "";
    expect(replaced).not.toBe("");
    expect((await get(enrolling, notes)).status).toBe(401);
    enrolling = replaced;
    // The code that completes a first enrolment records no factor (#63 security review, M1):
    // someone holding only the password could otherwise enrol their own app and use it at once.
    const refused = await get(enrolling, notes);
    expect(refused.status).toBe(403);
    expect(await code(refused)).toBe("mfa_verification_required");
    const { rows } = await auth().query<{ n: number }>(
      "SELECT count(*)::int AS n FROM auth.verification WHERE identifier = $1",
      [factorIdentifier(await sessionIdOf(enrolling))],
    );
    expect(rows[0]?.n).toBe(0);
    // Once enrolled, a code confirmed on the session counts.
    const confirmed = await authCall(enrolling, "/api/auth/two-factor/verify-totp", {
      code: totpFrom(totpUri),
    });
    expect(confirmed.status).toBe(200);
    expect((await get(enrolling, notes)).status).toBe(200);
  });

  it("hazard HZ-112 refuses a session from before the check (no record of a factor) until it confirms a code", async () => {
    const id = await sessionIdOf(enrolling);
    await auth().query("DELETE FROM auth.verification WHERE identifier = $1", [
      factorIdentifier(id),
    ]);
    const refused = await get(enrolling, notes);
    expect(refused.status).toBe(403);
    expect(await code(refused)).toBe("mfa_verification_required");

    // Confirming a code on the session itself steps it up.
    const verify = await h.request("/api/auth/two-factor/verify-totp", {
      method: "POST",
      token: enrolling,
      origin: MOBILE_APP_ORIGIN,
      body: { code: totpFrom(totpUri) },
    });
    expect(verify.status).toBe(200);
    expect((await get(enrolling, notes)).status).toBe(200);
  });

  it("hazard HZ-112 opens care records for a new sign-in completed with the code", async () => {
    const signIn = await passwordSignIn();
    expect(signIn.status).toBe(200);
    expect(((await signIn.json()) as { twoFactorRedirect?: boolean }).twoFactorRedirect).toBe(true);
    expect(signIn.headers.get("set-auth-token")).toBeNull();
    const cookie = signIn.headers
      .getSetCookie()
      .map((c) => c.split(";")[0])
      .join("; ");

    const verify = await h.request("/api/auth/two-factor/verify-totp", {
      method: "POST",
      origin: MOBILE_APP_ORIGIN,
      headers: { cookie },
      body: { code: totpFrom(totpUri) },
    });
    expect(verify.status).toBe(200);
    const token = verify.headers.get("set-auth-token") ?? "";
    expect(token).not.toBe("");
    expect((await get(token, notes)).status).toBe(200);
    const { rows } = await auth().query<{ value: string }>(
      "SELECT value FROM auth.verification WHERE identifier = $1",
      [factorIdentifier(await sessionIdOf(token))],
    );
    expect(rows.map((r) => r.value)).toEqual(["totp"]);
    signedIn = token;
  });

  it("hazard HZ-112 refuses a code on a session after five wrong ones", async () => {
    await auth().query("DELETE FROM auth.verification WHERE identifier = $1", [
      factorIdentifier(await sessionIdOf(signedIn)),
    ]);
    const right = totpFrom(totpUri);
    const wrong = right === "000000" ? "111111" : "000000";
    for (let i = 0; i < 5; i++) {
      expect(
        (await authCall(signedIn, "/api/auth/two-factor/verify-totp", { code: wrong })).status,
      ).toBe(401);
    }
    const blocked = await authCall(signedIn, "/api/auth/two-factor/verify-totp", { code: right });
    expect(blocked.status).toBe(429);
    expect(await code(await get(signedIn, notes))).toBe("mfa_verification_required");
  });

  it("hazard HZ-112 checks at most five codes from twenty sent at once on one session", async () => {
    const signIn = await passwordSignIn();
    const cookie = signIn.headers
      .getSetCookie()
      .map((c) => c.split(";")[0])
      .join("; ");
    const verify = await h.request("/api/auth/two-factor/verify-totp", {
      method: "POST",
      origin: MOBILE_APP_ORIGIN,
      headers: { cookie },
      body: { code: totpFrom(totpUri) },
    });
    const token = verify.headers.get("set-auth-token") ?? "";
    expect(token).not.toBe("");
    await auth().query("DELETE FROM auth.verification WHERE identifier = $1", [
      factorIdentifier(await sessionIdOf(token)),
    ]);
    const right = totpFrom(totpUri);
    const wrong = right === "000000" ? "111111" : "000000";
    const statuses = await Promise.all(
      Array.from({ length: 20 }, () =>
        authCall(token, "/api/auth/two-factor/verify-totp", { code: wrong }).then((r) => r.status),
      ),
    );
    expect(statuses.filter((s) => s === 401).length).toBeLessThanOrEqual(5);
    expect(statuses.filter((s) => s === 429).length).toBeGreaterThanOrEqual(15);
    expect(
      (await authCall(token, "/api/auth/two-factor/verify-totp", { code: right })).status,
    ).toBe(429);
  });
});
