import { createHash, createPrivateKey, createPublicKey } from "node:crypto";
import { DEMO, type DemoUserKey, linkDemoUser } from "@harbour/db/seed";
import pg from "pg";
import { createApp } from "../src/app";
import { loadConfig } from "../src/config";
import { createLogger } from "../src/logger";
import { demoTenantRefusal, testOnlySwitchRefusal, wantsTestOnlySwitch } from "./demo-seed-guard";

/**
 * Development only: creates Better Auth accounts for the demo tenant's users and links them. It
 * runs only when asked for by name (HARBOUR_SEED_DEMO_USERS=1), and never in production (review
 * round 3), so a stray run cannot create known sign-ins anywhere else.
 * Password from HARBOUR_DEMO_PASSWORD (local default below). With HARBOUR_DEMO_MFA=off the demo
 * users may open care records without TOTP, for local end-to-end tests only; never on dev or staging.
 * Optionally HARBOUR_DEMO_OWNER_EMAIL makes the owner account use that address (e.g. Brian's, so
 * he can register a passkey on dev). With HARBOUR_DEMO_E2E_PASSKEY=1 the demo manager, owner and family member each get a
 * passkey whose key anyone can derive (`e2ePasskey`), so the web journeys step up with a second
 * factor as a person would (ADR-0072 amendment); local end-to-end tests only, never on dev or
 * staging.
 */
/** A second demo home and its one resident, outside Harbour House staff's reach. */
const MEWS_LOCATION = "0194d000-0000-7000-8000-000000000150";
const MEWS_PERSON = "0194d000-0000-7000-8600-000000000150";

type PasskeyHolder = "manager" | "owner" | "family";

/**
 * The family portal account for the end-to-end journeys (comms.md section 2.1): the invented
 * relative already on Ada Example's record as her next of kin, linked to that contact with the
 * family representative role alone. A portal session always needs MFA, so it gets the
 * end-to-end passkey too. Local testing only, with HARBOUR_DEMO_E2E_PASSKEY=1.
 */
const FAMILY_MEMBER = {
  id: "0194d000-0000-7000-8000-000000000305",
  email: "relative.example@example.invalid",
  name: "Relative Example",
  personId: "0194d000-0000-7000-8600-000000000001",
} as const;

/**
 * The end-to-end passkey: a P-256 key derived from a published phrase, so it is no secret and
 * proves nothing outside a local test database. apps/web/e2e/support.ts derives the same key for
 * Chromium's virtual authenticator. Returns the COSE public key Better Auth stores (base64) and the
 * credential id (base64url).
 */
function e2ePasskey(who: PasskeyHolder): { publicKey: string; credentialId: string } {
  // The manager's labels are the original ones; the others are prefixed, so the keys differ.
  const digest = (label: string) =>
    createHash("sha256")
      .update(`harbour e2e demo passkey: ${who === "manager" ? label : `${who} ${label}`}`)
      .digest();
  // PKCS#8 for a P-256 private key, the scalar appended (RFC 5915, public key omitted).
  const key = createPrivateKey({
    key: Buffer.concat([
      Buffer.from("3041020100301306072a8648ce3d020106082a8648ce3d030107042730250201010420", "hex"),
      digest("key"),
    ]),
    format: "der",
    type: "pkcs8",
  });
  const jwk = createPublicKey(key).export({ format: "jwk" });
  const coordinate = (value: string | undefined) => Buffer.from(value ?? "", "base64url");
  // COSE_Key (RFC 9053): {1: 2 (EC2), 3: -7 (ES256), -1: 1 (P-256), -2: x, -3: y}.
  const cose = Buffer.concat([
    Buffer.from([0xa5, 0x01, 0x02, 0x03, 0x26, 0x20, 0x01, 0x21, 0x58, 0x20]),
    coordinate(jwk.x),
    Buffer.from([0x22, 0x58, 0x20]),
    coordinate(jwk.y),
  ]);
  return {
    publicKey: cose.toString("base64"),
    credentialId: digest("credential").subarray(0, 16).toString("base64url"),
  };
}

const config = loadConfig();
if (config.NODE_ENV === "production") throw new Error("seed-users is for development only");
if (process.env.HARBOUR_SEED_DEMO_USERS !== "1") {
  throw new Error("seed-users creates demo sign-ins: set HARBOUR_SEED_DEMO_USERS=1 to run it");
}
const password = process.env.HARBOUR_DEMO_PASSWORD ?? "correct horse battery staple";
const ownerUrl =
  process.env.DATABASE_OWNER_URL ??
  "postgres://harbour_owner:harbour_owner_local@localhost:5432/harbour";
// The e2e passkey's key is public and passes MFA and step-up; MFA off opens care records with a
// password. Neither may reach a shared database (demo-seed-guard.ts).
const testOnly = wantsTestOnlySwitch(process.env);
if (testOnly) {
  const refusal = testOnlySwitchRefusal({
    env: process.env,
    nodeEnv: config.NODE_ENV,
    databaseUrls: [ownerUrl, config.DATABASE_AUTH_URL, config.DATABASE_APP_URL],
  });
  if (refusal) throw new Error(refusal);
}
const owner = new pg.Pool({ connectionString: ownerUrl, max: 2 });
const { services, close } = createApp(config, createLogger("warn"));

/** The tenant the demo manager is linked in (read in the demo tenant), or null. */
async function managerTenant(authUserId: string): Promise<string | null> {
  const client = await owner.connect();
  try {
    await client.query("BEGIN");
    await client.query("SELECT set_config('app.tenant_id', $1, true)", [DEMO.tenantId]);
    const { rows } = await client.query<{ tenant_id: string }>(
      "SELECT tenant_id FROM tenant_user WHERE id = $1 AND auth_user_id = $2",
      [DEMO.users.manager.id, authUserId],
    );
    await client.query("COMMIT");
    return rows[0]?.tenant_id ?? null;
  } finally {
    client.release();
  }
}

/** The family member's sign-in, verified email, portal-only membership and link; rerunnable. */
async function seedFamilyMember(): Promise<string> {
  const { email, name } = FAMILY_MEMBER;
  try {
    await services.auth.api.signUpEmail({ body: { email, password, name } });
  } catch {
    // Already there from an earlier run.
  }
  const { rows } = await services.authPool.query<{ id: string }>(
    "UPDATE auth.user SET email_verified = true WHERE email = $1 RETURNING id",
    [email],
  );
  const authUserId = rows[0]?.id;
  if (!authUserId) throw new Error("Could not create or find the family member");
  const client = await owner.connect();
  try {
    await client.query("BEGIN");
    await client.query(
      "SELECT set_config('app.tenant_id', $1, true), set_config('app.scope', 'tenant', true)",
      [DEMO.tenantId],
    );
    await client.query(
      `INSERT INTO tenant_user (id, display_name, email, status, auth_user_id)
       VALUES ($1, $2, $3, 'active', $4)
       ON CONFLICT (id) DO UPDATE SET auth_user_id = EXCLUDED.auth_user_id`,
      [FAMILY_MEMBER.id, name, email, authUserId],
    );
    await client.query(
      `INSERT INTO role_assignment (tenant_user_id, role_id, reason)
       SELECT $1, id, 'Demo seed' FROM role WHERE key = 'family_representative'
         AND NOT EXISTS (SELECT 1 FROM role_assignment WHERE tenant_user_id = $1)`,
      [FAMILY_MEMBER.id],
    );
    await client.query(
      `INSERT INTO family_portal_user (tenant_user_id, person_id, contact_id)
       SELECT $1, $2, id FROM contact WHERE person_id = $2 AND email = $3
         AND NOT EXISTS (
           SELECT 1 FROM family_portal_user
           WHERE tenant_user_id = $1 AND revoked_at IS NULL AND deleted_at IS NULL)
       LIMIT 1`,
      [FAMILY_MEMBER.id, FAMILY_MEMBER.personId, email],
    );
    // Say so when there is no contact to link: never claim a link that was not made.
    const { rows: links } = await client.query(
      `SELECT 1 FROM family_portal_user
       WHERE tenant_user_id = $1 AND person_id = $2 AND revoked_at IS NULL AND deleted_at IS NULL`,
      [FAMILY_MEMBER.id, FAMILY_MEMBER.personId],
    );
    if (links.length === 0) {
      throw new Error(
        `No contact on the demo person's record has the email ${email}: run the demo seed first`,
      );
    }
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
  console.log("The demo family member is linked to Ada Example's next of kin (local testing only)");
  return authUserId;
}

try {
  const passkeyHolders: [PasskeyHolder, string][] = [];
  for (const key of Object.keys(DEMO.users) as DemoUserKey[]) {
    const user = DEMO.users[key];
    const email =
      key === "owner" ? (process.env.HARBOUR_DEMO_OWNER_EMAIL ?? user.email) : user.email;
    let authUserId: string;
    try {
      const created = await services.auth.api.signUpEmail({
        body: { email, password, name: user.name },
      });
      authUserId = created.user.id;
    } catch {
      const existing = await services.authPool.query<{ id: string }>(
        "SELECT id FROM auth.user WHERE email = $1",
        [email],
      );
      const id = existing.rows[0]?.id;
      if (!id) throw new Error(`Could not create or find ${key}`);
      authUserId = id;
    }
    await linkDemoUser(owner, key, authUserId);
    console.log(`Linked demo ${key}`);
    if (testOnly && key === "manager") {
      const refusal = demoTenantRefusal(await managerTenant(authUserId), DEMO.tenantId);
      if (refusal) throw new Error(refusal);
    }
    // The owner too: only the owner holds platform.export.create, whose routes need a step-up.
    // Written after every user, so the manager's tenant check runs before any key (#80 review).
    if ((key === "manager" || key === "owner") && process.env.HARBOUR_DEMO_E2E_PASSKEY === "1") {
      passkeyHolders.push([key, authUserId]);
    }
  }
  if (process.env.HARBOUR_DEMO_E2E_PASSKEY === "1") {
    passkeyHolders.push(["family", await seedFamilyMember()]);
  }
  for (const [key, authUserId] of passkeyHolders) {
    const passkey = e2ePasskey(key);
    await services.authPool.query(
      `INSERT INTO auth.passkey (id, name, public_key, user_id, credential_id, counter,
                                 device_type, backed_up, transports, created_at)
       VALUES ($4, 'End-to-end test passkey', $1, $2, $3, 0,
               'singleDevice', false, 'internal', now())
       ON CONFLICT (id) DO NOTHING`,
      [passkey.publicKey, authUserId, passkey.credentialId, `e2e-demo-${key}-passkey`],
    );
    console.log(`The demo ${key} has the end-to-end passkey (local testing only)`);
  }
  // A second home with one invented resident nobody at Harbour House can see, so the web
  // journeys can open a record by break-glass and see it is for reading only (ADR-0071 review
  // round 2, C2-M2). Rerunnable.
  {
    const client = await owner.connect();
    try {
      await client.query("BEGIN");
      await client.query(
        "SELECT set_config('app.tenant_id', $1, true), set_config('app.scope', 'tenant', true)",
        [DEMO.tenantId],
      );
      await client.query(
        "INSERT INTO location (id, name) VALUES ($1, 'Harbour Mews') ON CONFLICT (id) DO NOTHING",
        [MEWS_LOCATION],
      );
      await client.query(
        `INSERT INTO person (id, location_id, status, given_name, family_name, nhs_number,
                             allergy_status)
         VALUES ($1, $2, 'active', 'Una', 'Example', '9990001502', 'no_known_allergies')
         ON CONFLICT (id) DO NOTHING`,
        [MEWS_PERSON, MEWS_LOCATION],
      );
      await client.query("COMMIT");
      console.log("Harbour Mews and its resident are in place for the break-glass journey");
    } finally {
      client.release();
    }
  }
  if (process.env.HARBOUR_DEMO_MFA === "off") {
    const client = await owner.connect();
    await client.query("BEGIN");
    await client.query("SELECT set_config('app.tenant_id', $1, true)", [DEMO.tenantId]);
    await client.query("UPDATE tenant_user SET mfa_required = false");
    await client.query("COMMIT");
    client.release();
    console.log("MFA requirement switched off for the demo tenant (local testing only)");
  }
} finally {
  await close();
  await owner.end();
}
