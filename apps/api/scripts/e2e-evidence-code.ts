import { randomInt } from "node:crypto";
import pg from "pg";
import { loadConfig } from "../src/config";
import { evidenceCodeHash } from "../src/services/evidence-link";
import { testOnlySwitchRefusal } from "./demo-seed-guard";

/**
 * For the local evidence pack journey only (QUAL-003; HZ-050): codes go out by email, and the
 * development email adapter only records them in the API's memory, so the journey cannot read
 * one. This issues one more code for the newest live link to the given recipient, exactly as the
 * API stores it (an HMAC under the local link secret; the database works out its lifetime), and
 * prints the code. It refuses anywhere but a local development or test database, like the demo
 * seed's test-only switches, and the local secret is refused by the API in production.
 *
 * Usage: pnpm --filter @harbour/api e2e:evidence-code <recipient email>
 */
const email = process.argv[2]?.trim().toLowerCase();
if (!email?.endsWith("@example.invalid")) {
  throw new Error("Give the invented recipient's address (on example.invalid)");
}
const config = loadConfig();
const adminUrl =
  process.env.HARBOUR_TEST_ADMIN_URL?.replace(/\/[^/]*$/, "/harbour") ??
  "postgres://harbour_admin:harbour_admin_local@localhost:5432/harbour";
const refusal = testOnlySwitchRefusal({
  env: process.env,
  nodeEnv: config.NODE_ENV,
  databaseUrls: [adminUrl, config.DATABASE_APP_URL],
});
if (refusal) throw new Error(refusal);

const client = new pg.Client({ connectionString: adminUrl });
await client.connect();
try {
  const { rows } = await client.query<{ id: string; tenant_id: string }>(
    `SELECT id, tenant_id FROM evidence_pack_link
      WHERE recipient_email = $1 AND revoked_at IS NULL AND expires_at > now()
      ORDER BY issued_at DESC LIMIT 1`,
    [email],
  );
  const link = rows[0];
  if (!link) throw new Error("No live link to that recipient");
  const code = String(randomInt(0, 1_000_000)).padStart(6, "0");
  await client.query(
    `INSERT INTO evidence_pack_link_code (tenant_id, link_id, code_hash, valid_until)
     VALUES ($1, $2, $3, now() + interval '1 minute')`,
    [link.tenant_id, link.id, evidenceCodeHash(config.EVIDENCE_LINK_SECRET, link.id, code)],
  );
  console.log(code);
} finally {
  await client.end();
}
