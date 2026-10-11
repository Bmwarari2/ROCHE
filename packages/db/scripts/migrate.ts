import pg from "pg";
import { runMigrations } from "../src/admin/migrate";
import { ownerUrl } from "./env";

const pool = new pg.Pool({ connectionString: ownerUrl(), max: 1 });
try {
  await runMigrations(pool);
  console.log("Migrations applied");
} finally {
  await pool.end();
}
