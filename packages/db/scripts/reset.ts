import pg from "pg";
import { createDatabase, dropDatabase } from "../src/admin/roles";
import { adminUrl, databaseName } from "./env";

// Drops and recreates the local database. Refuses to run in production.
if (process.env.NODE_ENV === "production")
  throw new Error("db:reset is for local development only");
const client = new pg.Client({ connectionString: adminUrl() });
await client.connect();
try {
  await dropDatabase(client, databaseName());
  await createDatabase(client, databaseName());
  console.log(`Recreated ${databaseName()}; now run db:migrate and db:seed`);
} finally {
  await client.end();
}
