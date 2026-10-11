import pg from "pg";
import { bootstrapRoles, createDatabase } from "../src/admin/roles";
import { adminUrl, databaseName, rolePasswords } from "./env";

// Creates the cluster roles and the database. Run once per cluster as an administrator.
const client = new pg.Client({ connectionString: adminUrl() });
await client.connect();
try {
  await bootstrapRoles(client, rolePasswords());
  const exists = await client.query("SELECT 1 FROM pg_database WHERE datname = $1", [
    databaseName(),
  ]);
  if ((exists.rowCount ?? 0) === 0) {
    await createDatabase(client, databaseName());
    console.log(`Created database ${databaseName()}`);
  }
  console.log("Roles are in place");
} finally {
  await client.end();
}
