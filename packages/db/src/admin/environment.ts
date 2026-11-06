/**
 * What a database is for (`app.database_environment`, migration 0110; ADR-0080, HZ-113): `dev` and
 * `test` databases accept the invented dm+d fixture, any other mark or none refuses it. The deploy's
 * migrate task marks each environment's database from `HARBOUR_ENV`; local set-up marks a database
 * on this machine `dev`; test databases are marked `test`. A database once marked anything else is
 * never marked `dev` or `test` again (the table's guard), so a laptop pointed at a deployed database,
 * even through a forwarded port, cannot open it to the fixture.
 */

interface Queryable {
  query(text: string, values?: unknown[]): Promise<unknown>;
}

const ENVIRONMENT = /^[a-z]{2,20}$/;

/** Marks the connected database (as its owner). */
export async function markDatabaseEnvironment(db: Queryable, environment: string): Promise<void> {
  if (!ENVIRONMENT.test(environment)) {
    throw new Error(`Refusing to mark a database with an unexpected environment: ${environment}`);
  }
  await db.query(
    `INSERT INTO app.database_environment (environment) VALUES ($1)
     ON CONFLICT (singleton) DO UPDATE
       SET environment = EXCLUDED.environment, marked_at = now(), marked_by = session_user`,
    [environment],
  );
}

const LOCAL_HOSTS = new Set(["localhost", "127.0.0.1", "::1", "[::1]"]);

/**
 * True when a connection string points at this machine and nowhere else: a local host and no
 * `host` or `hostaddr` parameter, which libpq would follow instead.
 */
export function isLocalDatabaseUrl(url: string): boolean {
  try {
    const parsed = new URL(url);
    return (
      LOCAL_HOSTS.has(parsed.hostname) &&
      !parsed.searchParams.has("host") &&
      !parsed.searchParams.has("hostaddr")
    );
  } catch {
    return false;
  }
}

/**
 * The mark for a database being migrated: `HARBOUR_ENV` when set (a deployed environment); else
 * `production` under `NODE_ENV=production`; else `dev` only for a database on this machine;
 * otherwise `unknown`, which refuses the fixture.
 */
export function environmentToMark(input: {
  readonly harbourEnv: string | undefined;
  readonly nodeEnv: string | undefined;
  readonly ownerUrl: string;
}): string {
  const named = input.harbourEnv?.trim().toLowerCase();
  if (named) return named;
  if (input.nodeEnv === "production") return "production";
  return isLocalDatabaseUrl(input.ownerUrl) ? "dev" : "unknown";
}
