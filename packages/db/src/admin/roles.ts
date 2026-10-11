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
] as const;

export type LoginRole = (typeof LOGIN_ROLES)[number];

export const NOLOGIN_ROLES = ["harbour_membership_reader"] as const;

export type RolePasswords = Record<LoginRole, string>;

/** Local and CI defaults. Never used outside a disposable database. */
export const LOCAL_ROLE_PASSWORDS: RolePasswords = {
  harbour_owner: "harbour_owner_local",
  harbour_app: "harbour_app_local",
  harbour_auth: "harbour_auth_local",
  harbour_sync: "harbour_sync_local",
  harbour_operator: "harbour_operator_local",
  harbour_worker: "harbour_worker_local",
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
  // The owner must be able to hand ownership of the membership lookup function to its NOLOGIN role.
  await client.query("GRANT harbour_membership_reader TO harbour_owner");
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
}

export async function dropDatabase(client: Client, name: string): Promise<void> {
  if (!/^[a-z_][a-z0-9_]{0,62}$/.test(name)) {
    throw new Error(`Refusing to drop database with unsafe name: ${name}`);
  }
  await client.query(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`);
}
