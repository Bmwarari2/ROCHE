import type { Client } from "pg";

/**
 * pgAudit (section 5.5): the extension that writes DDL, role and write statements to the database
 * log. Created in the Harbour database where the server offers it: on Cloud SQL once the
 * `cloudsql.enable_pgaudit` flag is on (infra/modules/cloud_sql_postgres), and in the local
 * Docker image (infra/docker/postgres). A Postgres without it (a plain local install) is skipped
 * cleanly; production callers refuse to continue without it.
 */

export type PgauditState =
  /** Created now. */
  | "created"
  /** Already in the database. */
  | "present"
  /** The server does not offer the extension at all. */
  | "unavailable"
  /** Offered but not preloaded (on Cloud SQL: the `cloudsql.enable_pgaudit` flag is off). */
  | "not_loaded";

type Queryable = Pick<Client, "query">;

export async function ensurePgaudit(client: Queryable): Promise<PgauditState> {
  const offered = await client.query<{ installed_version: string | null }>(
    "SELECT installed_version FROM pg_available_extensions WHERE name = 'pgaudit'",
  );
  const row = offered.rows[0];
  if (!row) return "unavailable";
  if (row.installed_version) return "present";
  try {
    await client.query("CREATE EXTENSION IF NOT EXISTS pgaudit");
    return "created";
  } catch (error) {
    // pgaudit refuses to be created unless the server preloads it.
    if (error instanceof Error && /shared_preload_libraries/i.test(error.message)) {
      return "not_loaded";
    }
    throw error;
  }
}

/** Whether a state is acceptable where audit logging is required (production). */
export function pgauditReady(state: PgauditState): boolean {
  return state === "created" || state === "present";
}
