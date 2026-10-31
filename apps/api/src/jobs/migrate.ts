import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import {
  bootstrapRoles,
  ensureDatabase,
  environmentToMark,
  LOCAL_ROLE_PASSWORDS,
  LOGIN_ROLES,
  markDatabaseEnvironment,
  type RolePasswords,
  runMigrations,
} from "@harbour/db/admin";
import {
  findOverlaps,
  parseBankHolidays,
  parseRates,
  parseRetention,
  seedReferenceData,
} from "@harbour/db/seed";
import pg from "pg";
import { createLogger } from "../logger";

/**
 * One-off bootstrap and migration task (infra `migrate` task definition; locally the same steps are
 * `pnpm db:bootstrap && pnpm db:migrate && pnpm db:seed`). Idempotent: safe to run on every deploy.
 *
 * 1. As the RDS master user: create or update the Harbour roles and the database.
 * 2. As harbour_owner: apply migrations, mark what the database is for (`HARBOUR_ENV`), then load
 *    the statutory figures and retention schedule.
 * 3. On the PowerSync bucket-storage instance: create its login role.
 *
 * The admin connection arrives as parts (DATABASE_HOST, DATABASE_ADMIN_USER, ...) because RDS rotates
 * the master password and it may contain characters reserved in URLs.
 */

const env = process.env;
const logger = createLogger(env.LOG_LEVEL ?? "info");
const production = env.NODE_ENV === "production";

function adminUrl(
  database: string,
  host?: string,
  port?: string,
  user?: string,
  password?: string,
): string {
  if (!host || !user || !password) throw new Error("Admin connection details are missing");
  const url = new URL(`postgres://${host}`);
  url.port = port ?? "5432";
  url.username = encodeURIComponent(user);
  url.password = encodeURIComponent(password);
  url.pathname = `/${database}`;
  if (env.DATABASE_SSL_MODE) url.searchParams.set("sslmode", env.DATABASE_SSL_MODE);
  return url.toString();
}

function rolePasswords(): RolePasswords {
  return Object.fromEntries(
    LOGIN_ROLES.map((role) => {
      const value = env[`HARBOUR_DB_PASSWORD_${role.toUpperCase()}`];
      if (!value && production)
        throw new Error(`HARBOUR_DB_PASSWORD_${role.toUpperCase()} is not set`);
      return [role, value ?? LOCAL_ROLE_PASSWORDS[role]];
    }),
  ) as RolePasswords;
}

const quote = (value: string) => `'${value.replaceAll("'", "''")}'`;

async function withClient<T>(url: string, fn: (client: pg.Client) => Promise<T>): Promise<T> {
  const client = new pg.Client({ connectionString: url });
  await client.connect();
  try {
    return await fn(client);
  } finally {
    await client.end();
  }
}

function referenceDocument(name: string): string {
  // Bundled next to dist/migrate.js by build.mjs; in development, read from docs/specs.
  const bundled = fileURLToPath(new URL(`./${name}`, import.meta.url));
  const source = fileURLToPath(new URL(`../../../../docs/specs/${name}`, import.meta.url));
  return readFileSync(existsSync(bundled) ? bundled : source, "utf8");
}

const databaseName = env.DATABASE_NAME ?? "harbour";
const admin =
  env.DATABASE_ADMIN_URL ??
  adminUrl(
    "postgres",
    env.DATABASE_HOST,
    env.DATABASE_PORT,
    env.DATABASE_ADMIN_USER,
    env.DATABASE_ADMIN_PASSWORD,
  );

await withClient(admin, async (client) => {
  await bootstrapRoles(client, rolePasswords());
  await ensureDatabase(client, databaseName);
});
logger.info("roles and database in place");

const ownerUrl =
  env.DATABASE_OWNER_URL ??
  `postgres://harbour_owner:${LOCAL_ROLE_PASSWORDS.harbour_owner}@localhost:5432/${databaseName}`;
const owner = new pg.Pool({ connectionString: ownerUrl, max: 2 });
try {
  const bundledMigrations = fileURLToPath(new URL("./drizzle", import.meta.url));
  await runMigrations(owner, existsSync(bundledMigrations) ? bundledMigrations : undefined);
  logger.info("migrations applied");
  // What this database is for (ADR-0080, HZ-113): only dev and test accept the invented dm+d
  // fixture; a database once marked anything else is never marked dev or test again.
  const environment = environmentToMark({
    harbourEnv: env.HARBOUR_ENV,
    nodeEnv: env.NODE_ENV,
    ownerUrl,
  });
  await markDatabaseEnvironment(owner, environment);
  logger.info({ environment }, "database marked");
  const rates = parseRates(referenceDocument("rates.md"));
  const overlaps = findOverlaps(rates);
  if (overlaps.length > 0)
    throw new Error(`rates.md has overlapping periods: ${overlaps.join("; ")}`);
  const result = await seedReferenceData(
    owner,
    rates,
    parseRetention(referenceDocument("retention.md")),
    parseBankHolidays(referenceDocument("calendar.md")),
  );
  logger.info(result, "reference data loaded");
} finally {
  await owner.end();
}

if (env.SYNC_STORAGE_HOST) {
  const password = env.HARBOUR_DB_PASSWORD_POWERSYNC_STORAGE;
  if (!password) throw new Error("HARBOUR_DB_PASSWORD_POWERSYNC_STORAGE is not set");
  const storageDb = env.SYNC_STORAGE_DATABASE ?? "powersync_storage";
  await withClient(
    adminUrl(
      storageDb,
      env.SYNC_STORAGE_HOST,
      env.SYNC_STORAGE_PORT,
      env.SYNC_STORAGE_ADMIN_USER,
      env.SYNC_STORAGE_ADMIN_PASSWORD,
    ),
    async (client) => {
      const role = await client.query("SELECT 1 FROM pg_roles WHERE rolname = 'powersync_storage'");
      const verb = (role.rowCount ?? 0) > 0 ? "ALTER" : "CREATE";
      await client.query(
        `${verb} ROLE powersync_storage LOGIN NOSUPERUSER NOBYPASSRLS PASSWORD ${quote(password)}`,
      );
      await client.query(
        `GRANT CREATE ON DATABASE ${storageDb.replace(/[^a-z0-9_]/g, "")} TO powersync_storage`,
      );
    },
  );
  logger.info("powersync storage role in place");
}
