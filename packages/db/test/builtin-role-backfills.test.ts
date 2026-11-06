import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { BUILTIN_ROLES } from "@harbour/domain";
import type pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createTestDatabase, type TestDatabase } from "./support/database";
import { ctx, inContext, seedTwoTenants, TENANT_B } from "./support/fixtures";

/**
 * Built-in roles are copied into a tenant when it is created, so a permission the built-in
 * definitions grant later reaches an existing tenant only through a data migration (as 0031, 0038
 * and 0116 do). The baseline is the built-in definitions on main when this check was added
 * (support/builtin-roles-baseline.json, 1 November 2026); every grant since must be backfilled by
 * a migration naming that role and permission and auditing it (platform.role.permissions_migrated).
 * Then the pay runs backfill (migration 0116) is re-run against a copy that lacks the permissions.
 */

const DRIZZLE = fileURLToPath(new URL("../drizzle/", import.meta.url));
const baseline: Record<string, readonly string[]> = JSON.parse(
  readFileSync(
    fileURLToPath(new URL("./support/builtin-roles-baseline.json", import.meta.url)),
    "utf8",
  ),
);
const MIGRATIONS = readdirSync(DRIZZLE).filter((f) => /^\d{4}_.*\.sql$/.test(f));

/** The permissions each role-permission migration adds for each built-in key, read from the file. */
function backfills(): Map<string, Set<string>> {
  const granted = new Map<string, Set<string>>();
  for (const file of MIGRATIONS) {
    const sql = readFileSync(`${DRIZZLE}${file}`, "utf8");
    if (!sql.includes("platform.role.permissions_migrated")) continue;
    for (const match of sql.matchAll(/\('([a-z_]+)', ARRAY\[([^\]]*)\]\)/g)) {
      const key = match[1] ?? "";
      const set = granted.get(key) ?? new Set<string>();
      for (const p of (match[2] ?? "").matchAll(/'([^']+)'/g)) set.add(p[1] ?? "");
      granted.set(key, set);
    }
  }
  return granted;
}

describe("existing tenants' built-in role copies keep up with the built-in definitions", () => {
  it("backfills every grant made since the baseline in a migration", () => {
    const before = baseline;
    const granted = backfills();
    const missing: string[] = [];
    for (const role of BUILTIN_ROLES) {
      // A built-in role new since the baseline has no copies in existing tenants to update.
      const had = before[role.key];
      if (!had) continue;
      for (const permission of role.permissions) {
        if (had.includes(permission)) continue;
        if (!granted.get(role.key)?.has(permission)) missing.push(`${role.key}: ${permission}`);
      }
    }
    expect(missing, "add a backfill like migration 0116's for each").toEqual([]);
  });

  it("names no grant the built-in definitions do not make (migration 0116)", () => {
    const sql = readFileSync(`${DRIZZLE}0116_pay_runs.sql`, "utf8");
    for (const match of sql.matchAll(/\('([a-z_]+)', ARRAY\[([^\]]*)\]\)/g)) {
      const role = BUILTIN_ROLES.find((r) => r.key === match[1]);
      for (const p of (match[2] ?? "").matchAll(/'([^']+)'/g)) {
        expect(role?.permissions as readonly string[] | undefined).toContain(p[1]);
      }
    }
  });
});

describe("the pay permissions reach existing tenants' Owner and Finance (migration 0116)", () => {
  let db: TestDatabase;
  const SECTION = { begin: "-- BEGIN role backfill 0116", end: "-- END role backfill 0116" };
  const asOwner = <T>(fn: (c: pg.PoolClient) => Promise<T>) =>
    inContext(db.pool("harbour_owner"), ctx(TENANT_B, null, "tenant"), fn);

  async function rerun() {
    const file = readFileSync(`${DRIZZLE}0116_pay_runs.sql`, "utf8");
    const sql = file.slice(file.indexOf(SECTION.begin), file.indexOf(SECTION.end));
    const client = await db.pool("harbour_owner").connect();
    try {
      await client.query("BEGIN");
      for (const statement of sql.split("--> statement-breakpoint")) {
        if (statement.replace(/--.*$/gm, "").trim()) await client.query(statement);
      }
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  beforeAll(async () => {
    db = await createTestDatabase();
    await seedTwoTenants(db.pool("harbour_owner"));
  });
  afterAll(async () => {
    await db?.drop();
  });

  it("adds them once to each copy that lacks them, audited as the system", async () => {
    // Copies as a tenant created before pay runs held them: without the pay permissions.
    await asOwner((c) =>
      c.query(
        `INSERT INTO role (key, name, scope_kind, permissions, is_builtin) VALUES
           ('owner', 'Owner', 'tenant', '{people.person.read}', true),
           ('finance', 'Finance', 'none', '{finance.billing.manage,scheduling.pay.manage}', true),
           ('care_worker', 'Care worker', 'location', '{people.person.read}', true)`,
      ),
    );
    await rerun();
    await rerun();
    const roles = await asOwner((c) =>
      c.query<{ key: string; permissions: string[] }>(
        "SELECT key, permissions FROM role WHERE is_builtin AND key IN ('owner', 'finance', 'care_worker') ORDER BY key",
      ),
    );
    expect(roles.rows.map((r) => [r.key, r.permissions])).toEqual([
      ["care_worker", ["people.person.read"]],
      ["finance", ["finance.billing.manage", "scheduling.pay.manage", "scheduling.pay.approve"]],
      ["owner", ["people.person.read", "scheduling.pay.manage", "scheduling.pay.approve"]],
    ]);
    const audit = await asOwner((c) =>
      c.query<{ actor: string; key: string; added: string[] }>(
        `SELECT actor_auth_user_id AS actor, scope ->> 'roleKey' AS key, scope -> 'added' AS added
         FROM audit_event WHERE action = 'platform.role.permissions_migrated'
           AND scope ->> 'migration' = '0116_pay_runs' ORDER BY 2`,
      ),
    );
    expect(audit.rows.map((r) => [r.actor, r.key, r.added])).toEqual([
      ["system", "finance", ["scheduling.pay.approve"]],
      ["system", "owner", ["scheduling.pay.manage", "scheduling.pay.approve"]],
    ]);
  });
});

/**
 * Migration 0137's ratchet (folded in from its own file): the baseline is each role as the first
 * definitions on `main` gave it; a definition may hold only what that baseline gave it, what a
 * backfill grants it, or what the migration that created it gave it.
 */
const firstBaseline = JSON.parse(
  readFileSync(new URL("./fixtures/builtin-roles-baseline.json", import.meta.url), "utf8"),
) as { roles: Record<string, string[]> };

const migrations = MIGRATIONS.slice()
  .sort()
  .map((f) => ({ file: f, sql: readFileSync(`${DRIZZLE}${f}`, "utf8") }));

/** Every `('role_key', ARRAY['permission', ...])` grant in a backfill, by role. */
function allBackfills(): Map<string, Set<string>> {
  const grants = new Map<string, Set<string>>();
  for (const { sql } of migrations) {
    for (const m of sql.matchAll(/\('([a-z_]+)',\s*ARRAY\[([^\]]*)\]\)/g)) {
      const set = grants.get(m[1] ?? "") ?? new Set<string>();
      for (const p of (m[2] ?? "").matchAll(/'([^']+)'/g)) set.add(p[1] ?? "");
      grants.set(m[1] ?? "", set);
    }
  }
  return grants;
}

/** Built-in roles a backfill creates: `('key', 'Name', 'Description', ARRAY[...], 'scope')`. */
function created(): Map<string, Set<string>> {
  const roles = new Map<string, Set<string>>();
  for (const { sql } of migrations) {
    for (const m of sql.matchAll(
      /\('([a-z_]+)',\s*'[^']*',\s*'(?:[^']|'')*',\s*ARRAY\[([^\]]*)\],\s*'[a-z]+'\)/g,
    )) {
      roles.set(
        m[1] ?? "",
        new Set([...(m[2] ?? "").matchAll(/'([^']+)'/g)].map((p) => p[1] ?? "")),
      );
    }
  }
  return roles;
}

describe("built-in roles reach existing tenants (the backfill ratchet)", () => {
  it("gives every built-in role only what its baseline, a backfill or its creation gave it", () => {
    const grants = allBackfills();
    const made = created();
    const unbackfilled: Record<string, string[]> = {};
    for (const role of BUILTIN_ROLES) {
      const from = firstBaseline.roles[role.key] ?? [...(made.get(role.key) ?? [])];
      if (firstBaseline.roles[role.key] === undefined && !made.has(role.key)) {
        unbackfilled[role.key] = [
          "(the role itself: no migration creates it for existing tenants)",
        ];
        continue;
      }
      const reach = new Set([...from, ...(grants.get(role.key) ?? [])]);
      const missing = (role.permissions as readonly string[]).filter((p) => !reach.has(p));
      if (missing.length > 0) unbackfilled[role.key] = missing;
    }
    expect(unbackfilled, "add a backfill migration in the 0038 pattern").toEqual({});
  });
});

describe("migration 0137 brings an existing tenant's built-in roles up to date", () => {
  let db: TestDatabase;

  beforeAll(async () => {
    db = await createTestDatabase();
    await seedTwoTenants(db.pool("harbour_owner"));
  }, 120_000);

  afterAll(async () => {
    await db?.drop();
  });

  const asOwner = <T>(tenantId: string, fn: (c: pg.PoolClient) => Promise<T>) =>
    inContext(db.pool("harbour_owner"), ctx(tenantId, null, "tenant"), fn);

  async function rerunFile(file: string) {
    const sql = readFileSync(`${DRIZZLE}${file}`, "utf8");
    const client = await db.pool("harbour_owner").connect();
    try {
      await client.query("BEGIN");
      for (const statement of sql.split("--> statement-breakpoint")) {
        if (statement.replace(/--.*$/gm, "").trim()) await client.query(statement);
      }
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  it("adds the missing grants and roles once, audited as the system", async () => {
    // A tenant made before the staff file: an HR copy without its permissions, and no speak-up
    // or employee relations role.
    await asOwner(TENANT_B, async (c) => {
      await c.query(
        "DELETE FROM role WHERE key IN ('speak_up_guardian', 'employee_relations_lead')",
      );
      await c.query(
        `INSERT INTO role (key, name, scope_kind, permissions, is_builtin) VALUES
           ('hr', 'HR', 'tenant', '{workforce.staff.read}', true)
         ON CONFLICT DO NOTHING`,
      );
    });
    await rerunFile("0137_builtin_role_backfill.sql");
    await rerunFile("0137_builtin_role_backfill.sql");
    const roles = await asOwner(TENANT_B, (c) =>
      c.query<{ key: string; permissions: string[] }>(
        `SELECT key, permissions FROM role
          WHERE key IN ('hr', 'speak_up_guardian', 'employee_relations_lead') ORDER BY key`,
      ),
    );
    expect(roles.rows.map((r) => r.key)).toEqual([
      "employee_relations_lead",
      "hr",
      "speak_up_guardian",
    ]);
    const hr = roles.rows.find((r) => r.key === "hr");
    expect(hr?.permissions).toEqual(
      expect.arrayContaining([
        "workforce.staff_file.read",
        "workforce.hr_document.read",
        "workforce.ldss.manage",
      ]),
    );
    // Each permission once, however often the migration runs.
    expect(new Set(hr?.permissions).size).toBe(hr?.permissions.length);
    const audit = await asOwner(TENANT_B, (c) =>
      c.query<{ key: string }>(
        `SELECT scope ->> 'roleKey' AS key FROM audit_event
          WHERE action = 'platform.role.permissions_migrated'
            AND scope ->> 'migration' = '0137_builtin_role_backfill'
            AND scope ->> 'roleKey' IN ('hr', 'speak_up_guardian', 'employee_relations_lead')
          ORDER BY 1`,
      ),
    );
    expect(audit.rows.map((r) => r.key)).toEqual([
      "employee_relations_lead",
      "hr",
      "speak_up_guardian",
    ]);
  });
});
