import { DEMO, type DemoUserKey, linkDemoUser } from "@harbour/db/seed";
import pg from "pg";
import { createApp } from "../src/app";
import { loadConfig } from "../src/config";
import { createLogger } from "../src/logger";

/**
 * Development only: creates Better Auth accounts for the demo tenant's users and links them.
 * Password from HARBOUR_DEMO_PASSWORD (local default below). With HARBOUR_DEMO_MFA=off the demo
 * users may open care records without TOTP, for local end-to-end tests only; never on dev or staging.
 * Optionally HARBOUR_DEMO_OWNER_EMAIL makes the owner account use that address (e.g. Brian's, so
 * he can register a passkey on dev).
 */
/** A second demo home and its one resident, outside Harbour House staff's reach. */
const MEWS_LOCATION = "0194d000-0000-7000-8000-000000000150";
const MEWS_PERSON = "0194d000-0000-7000-8600-000000000150";

const config = loadConfig();
if (config.NODE_ENV === "production") throw new Error("seed-users is for development only");
const password = process.env.HARBOUR_DEMO_PASSWORD ?? "correct horse battery staple";
const ownerUrl =
  process.env.DATABASE_OWNER_URL ??
  "postgres://harbour_owner:harbour_owner_local@localhost:5432/harbour";
const owner = new pg.Pool({ connectionString: ownerUrl, max: 2 });
const { services, close } = createApp(config, createLogger("warn"));

try {
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
