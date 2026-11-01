import type { Client } from "pg";

/**
 * Cluster-level roles (ADR-0002). Roles are not created by migrations because they span
 * databases and need CREATEROLE; an administrator (RDS master user locally `harbour_admin`) runs
 * this once per cluster via `pnpm db:bootstrap`. Passwords come from the environment or secrets
 * manager; local and CI defaults are only for disposable databases.
 */
export const LOGIN_ROLES = [
  "harbour_owner",
  "harbour_app",
  "harbour_auth",
  "harbour_sync",
  "harbour_operator",
  "harbour_worker",
  // The dm+d release job (slice 75): calls the loader's functions and reads the dm+d tables, and
  // nothing else, since it parses an archive fetched from the internet (migration 0131).
  "harbour_dmd_job",
] as const;

export type LoginRole = (typeof LOGIN_ROLES)[number];

/**
 * Owners of security-definer functions, each with only the privileges its functions need:
 * `harbour_membership_reader` (the membership lookup), `harbour_invitation_owner` (invitation
 * lookup, acceptance, the first owner's invitation and the lapsed-invitation sweep; migration
 * 0054), `harbour_evidence_link_reader` (an evidence pack link found by its token; migration 0057),
 * `harbour_family_reader` (whether a family session may see a feed update, `app.family_can_see`;
 * migration 0061), `harbour_notice_resolver` (Thapsus reading and resolving objections to
 * sub-processor notices; migration 0067), `harbour_sample_owner` (counting sample and real people
 * and removing a sample batch; migration 0069), `harbour_import_owner` (deleting an import's
 * staged rows when its batch closes, and undoing a committed import; migration 0088),
 * `harbour_dmd_loader` (the dm+d release loader's functions, the only writer of the dm+d reference
 * tables; migration 0110, ADR-0080).
 */
export const NOLOGIN_ROLES = [
  "harbour_membership_reader",
  "harbour_invitation_owner",
  "harbour_evidence_link_reader",
  "harbour_family_reader",
  "harbour_notice_resolver",
  "harbour_sample_owner",
  "harbour_import_owner",
  "harbour_dmd_loader",
] as const;

export type RolePasswords = Record<LoginRole, string>;

/** Local and CI defaults. Never used outside a disposable database. */
export const LOCAL_ROLE_PASSWORDS: RolePasswords = {
  harbour_owner: "harbour_owner_local",
  harbour_app: "harbour_app_local",
  harbour_auth: "harbour_auth_local",
  harbour_sync: "harbour_sync_local",
  harbour_operator: "harbour_operator_local",
  harbour_worker: "harbour_worker_local",
  harbour_dmd_job: "harbour_dmd_job_local",
};

const quoteLiteral = (value: string): string => `'${value.replaceAll("'", "''")}'`;

async function roleExists(client: Client, role: string): Promise<boolean> {
  const result = await client.query("SELECT 1 FROM pg_roles WHERE rolname = $1", [role]);
  return (result.rowCount ?? 0) > 0;
}

export async function bootstrapRoles(client: Client, passwords: RolePasswords): Promise<void> {
  for (const role of LOGIN_ROLES) {
    const verb = (await roleExists(client, role)) ? "ALTER" : "CREATE";
    // NOBYPASSRLS everywhere: no Harbour role may skip row-level security.
    await client.query(
      `${verb} ROLE ${role} LOGIN NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE PASSWORD ${quoteLiteral(passwords[role])}`,
    );
  }
  for (const role of NOLOGIN_ROLES) {
    if (!(await roleExists(client, role))) {
      await client.query(`CREATE ROLE ${role} NOLOGIN NOBYPASSRLS`);
    }
  }
  // The owner must be able to hand ownership of the definer functions to their NOLOGIN roles.
  // The membership reader's grant predates this; the invitation owner's is SET only, never
  // INHERIT, so its USING (true) policies never apply to harbour_owner's own queries.
  await client.query("GRANT harbour_membership_reader TO harbour_owner");
  await client.query(
    "GRANT harbour_invitation_owner TO harbour_owner WITH INHERIT FALSE, SET TRUE",
  );
  await client.query(
    "GRANT harbour_evidence_link_reader TO harbour_owner WITH INHERIT FALSE, SET TRUE",
  );
  await client.query("GRANT harbour_family_reader TO harbour_owner WITH INHERIT FALSE, SET TRUE");
  await client.query("GRANT harbour_notice_resolver TO harbour_owner WITH INHERIT FALSE, SET TRUE");
  await client.query("GRANT harbour_sample_owner TO harbour_owner WITH INHERIT FALSE, SET TRUE");
  await client.query("GRANT harbour_import_owner TO harbour_owner WITH INHERIT FALSE, SET TRUE");
  await client.query("GRANT harbour_dmd_loader TO harbour_owner WITH INHERIT FALSE, SET TRUE");
  // PowerSync needs logical replication. RDS does not allow the REPLICATION attribute and uses
  // the rds_replication role instead.
  try {
    await client.query("ALTER ROLE harbour_sync REPLICATION");
  } catch {
    await client.query("GRANT rds_replication TO harbour_sync");
  }
}

export async function createDatabase(client: Client, name: string): Promise<void> {
  if (!/^[a-z_][a-z0-9_]{0,62}$/.test(name)) {
    throw new Error(`Refusing to create database with unsafe name: ${name}`);
  }
  await client.query(`CREATE DATABASE ${name} OWNER harbour_owner ENCODING 'UTF8'`);
  // pg-boss keeps its job tables in its own schema, created and owned by the worker role.
  await client.query(`GRANT CREATE ON DATABASE ${name} TO harbour_worker`);
}

/** Creates the database if it is missing and (re)applies database-level grants. Idempotent. */
export async function ensureDatabase(client: Client, name: string): Promise<{ created: boolean }> {
  const exists = await client.query("SELECT 1 FROM pg_database WHERE datname = $1", [name]);
  if ((exists.rowCount ?? 0) === 0) {
    await createDatabase(client, name);
    return { created: true };
  }
  if (!/^[a-z_][a-z0-9_]{0,62}$/.test(name)) throw new Error(`Unsafe database name: ${name}`);
  await client.query(`GRANT CREATE ON DATABASE ${name} TO harbour_worker`);
  return { created: false };
}

export async function dropDatabase(client: Client, name: string): Promise<void> {
  if (!/^[a-z_][a-z0-9_]{0,62}$/.test(name)) {
    throw new Error(`Refusing to drop database with unsafe name: ${name}`);
  }
  await client.query(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`);
}
