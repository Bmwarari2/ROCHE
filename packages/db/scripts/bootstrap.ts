import pg from "pg";
import { bootstrapRoles, ensureDatabase } from "../src/admin/roles";
import { adminUrl, databaseName, rolePasswords } from "./env";

// Creates or updates the cluster roles and the database. Idempotent; run as an administrator.
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
