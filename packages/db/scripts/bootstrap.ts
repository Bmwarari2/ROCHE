import pg from "pg";
import { ensurePgaudit, pgauditReady } from "../src/admin/extensions";
import { bootstrapRoles, ensureDatabase } from "../src/admin/roles";
import { adminUrl, databaseName, rolePasswords } from "./env";

// Creates or updates the cluster roles and the database, then pgAudit in the database where the
// server offers it. Idempotent; run as an administrator.
const client = new pg.Client({ connectionString: adminUrl() });
await client.connect();
try {
  await bootstrapRoles(client, rolePasswords());
  const { created } = await ensureDatabase(client, databaseName());
  if (created) console.log(`Created database ${databaseName()}`);
  console.log("Roles are in place");
} finally {
  await client.end();
}

const url = new URL(adminUrl());
url.pathname = `/${databaseName()}`;
const database = new pg.Client({ connectionString: url.toString() });
await database.connect();
try {
  const state = await ensurePgaudit(database);
  if (state === "created" || state === "present") {
    console.log(`pgaudit is ${state === "created" ? "created" : "in place"}`);
  } else if (process.env.NODE_ENV === "production") {
    throw new Error(`pgaudit is ${state}: turn on cloudsql.enable_pgaudit (docs/runbooks)`);
  } else if (!pgauditReady(state)) {
    console.log(
      `pgaudit skipped: this Postgres ${state === "unavailable" ? "does not offer it" : "does not preload it"}`,
    );
  }
} finally {
  await database.end();
}
