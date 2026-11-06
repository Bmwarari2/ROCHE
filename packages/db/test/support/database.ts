import { randomBytes } from "node:crypto";
import pg from "pg";
import { markDatabaseEnvironment } from "../../src/admin/environment";
import { runMigrations } from "../../src/admin/migrate";
import {
  bootstrapRoles,
  createDatabase,
  dropDatabase,
  LOCAL_ROLE_PASSWORDS,
  type LoginRole,
} from "../../src/admin/roles";

/**
 * Disposable databases for integration tests. Each test file gets its own freshly migrated
 * database, so tests can run in parallel and never share state. Needs a Postgres superuser:
 * HARBOUR_TEST_ADMIN_URL (default: the local `harbour_admin` role, see docs/runbooks).
 */

export const DEFAULT_ADMIN_URL =
  "postgres://harbour_admin:harbour_admin_local@localhost:5432/postgres";

export interface TestDatabase {
  readonly name: string;
  readonly url: (role: LoginRole) => string;
  readonly pool: (role: LoginRole) => pg.Pool;
  readonly drop: () => Promise<void>;
}

function adminUrl(): string {
  return process.env.HARBOUR_TEST_ADMIN_URL ?? DEFAULT_ADMIN_URL;
}

function urlFor(role: LoginRole, database: string): string {
  const base = new URL(adminUrl());
  base.username = role;
  base.password = LOCAL_ROLE_PASSWORDS[role];
  base.pathname = `/${database}`;
  return base.toString();
}

export async function withAdminClient<T>(
  fn: (client: pg.Client) => Promise<T>,
  database?: string,
): Promise<T> {
  const url = new URL(adminUrl());
  if (database) url.pathname = `/${database}`;
  const client = new pg.Client({ connectionString: url.toString() });
  await client.connect();
  try {
    return await fn(client);
  } finally {
    await client.end();
  }
}

let rolesReady: Promise<void> | undefined;

/** Roles are cluster-wide; bootstrap them once per process, tolerating concurrent workers. */
async function ensureRoles(): Promise<void> {
  rolesReady ??= withAdminClient(async (client) => {
    await client.query("SELECT pg_advisory_lock(424242)");
    try {
      await bootstrapRoles(client, LOCAL_ROLE_PASSWORDS);
    } finally {
      await client.query("SELECT pg_advisory_unlock(424242)");
    }
  });
  return rolesReady;
}

export async function createTestDatabase(): Promise<TestDatabase> {
  await ensureRoles();
  const name = `harbour_test_${randomBytes(6).toString("hex")}`;
  await withAdminClient((client) => createDatabase(client, name));

  const pools = new Map<LoginRole, pg.Pool>();
  const pool = (role: LoginRole): pg.Pool => {
    let existing = pools.get(role);
    if (!existing) {
      existing = new pg.Pool({ connectionString: urlFor(role, name), max: 4 });
      // pool.end() resolves before its clients' sockets close, so dropping the database WITH
      // (FORCE) can terminate a connection that is still closing (57P01). That is expected at
      // teardown; any other error on an idle connection is not.
      existing.on("error", (error: Error & { code?: string }) => {
        if (error.code !== "57P01") throw error;
      });
      pools.set(role, existing);
    }
    return existing;
  };

  await runMigrations(pool("harbour_owner"));
  // A test database: the invented dm+d fixture may load here (ADR-0080).
  await markDatabaseEnvironment(pool("harbour_owner"), "test");

  return {
    name,
    url: (role) => urlFor(role, name),
    pool,
    drop: async () => {
      await Promise.all([...pools.values()].map((p) => p.end()));
      await withAdminClient((client) => dropDatabase(client, name));
    },
  };
}
