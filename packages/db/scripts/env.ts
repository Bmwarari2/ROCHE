import { LOCAL_ROLE_PASSWORDS, LOGIN_ROLES, type RolePasswords } from "../src/admin/roles";

/** Local defaults match docker-compose.yml and .env.example; deployed environments set every variable. */
export const adminUrl = () =>
  process.env.DATABASE_ADMIN_URL ??
  "postgres://harbour_admin:harbour_admin_local@localhost:5432/postgres";

export const databaseName = () => process.env.HARBOUR_DATABASE_NAME ?? "harbour";

export const ownerUrl = () =>
  process.env.DATABASE_OWNER_URL ??
  `postgres://harbour_owner:${LOCAL_ROLE_PASSWORDS.harbour_owner}@localhost:5432/${databaseName()}`;

/** HARBOUR_DB_PASSWORD_HARBOUR_APP and so on; local defaults only when NODE_ENV is not production. */
export function rolePasswords(): RolePasswords {
  const entries = LOGIN_ROLES.map((role) => {
    const fromEnv = process.env[`HARBOUR_DB_PASSWORD_${role.toUpperCase()}`];
    if (!fromEnv && process.env.NODE_ENV === "production") {
      throw new Error(`HARBOUR_DB_PASSWORD_${role.toUpperCase()} must be set in production`);
    }
    return [role, fromEnv ?? LOCAL_ROLE_PASSWORDS[role]] as const;
  });
  return Object.fromEntries(entries) as RolePasswords;
}
