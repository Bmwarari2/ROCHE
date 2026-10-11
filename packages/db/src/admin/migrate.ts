import { fileURLToPath } from "node:url";
import { drizzle } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import type { Pool } from "pg";

export const MIGRATIONS_FOLDER = fileURLToPath(new URL("../../drizzle", import.meta.url));

/** Applies all pending migrations. Must run as harbour_owner. */
export async function runMigrations(ownerPool: Pool): Promise<void> {
  await migrate(drizzle(ownerPool), { migrationsFolder: MIGRATIONS_FOLDER });
}
