import pg from "pg";
import { environmentToMark, markDatabaseEnvironment } from "../src/admin/environment";
import { runMigrations } from "../src/admin/migrate";
import { ownerUrl } from "./env";

const pool = new pg.Pool({ connectionString: ownerUrl(), max: 1 });
try {
  await runMigrations(pool);
  console.log("Migrations applied");
  // What the database is for (ADR-0080): only dev and test accept the invented dm+d fixture.
  const environment = environmentToMark({
    harbourEnv: process.env.HARBOUR_ENV,
    nodeEnv: process.env.NODE_ENV,
    ownerUrl: ownerUrl(),
  });
  await markDatabaseEnvironment(pool, environment);
  console.log(`Database marked ${environment}`);
} finally {
  await pool.end();
}
