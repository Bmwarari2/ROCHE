import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { BUILTIN_ROLES } from "@harbour/domain";
import type pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createTestDatabase, type TestDatabase } from "./support/database";
import { ctx, inContext, seedTwoTenants, TENANT_B } from "./support/fixtures";

/**
 * Built-in role definitions against the backfills (migration 0137 and the 0038 pattern). A tenant
 * keeps its own copy of each built-in role, made when it was created, so every permission a
 * definition gains later, and every built-in role added later, must reach existing tenants
 * through a backfill migration. The ratchet: the baseline is each role as the first definitions
 * on `main` gave it (`fixtures/builtin-roles-baseline.json`); a definition may hold only what the
 * baseline gave it, what a backfill grants it, or what the migration that created it gave it.
 * Adding a permission to a built-in role without a backfill fails here.
 */

const DRIZZLE = fileURLToPath(new URL("../drizzle/", import.meta.url));
const baseline = JSON.parse(
  readFileSync(new URL("./fixtures/builtin-roles-baseline.json", import.meta.url), "utf8"),
) as { roles: Record<string, string[]> };

const migrations = readdirSync(DRIZZLE)
  .filter((f) => /^\d{4}_.*\.sql$/.test(f))
  .sort()
  .map((f) => ({ file: f, sql: readFileSync(`${DRIZZLE}${f}`, "utf8") }));

/** Every `('role_key', ARRAY['permission', ...])` grant in a backfill, by role. */
function backfilled(): Map<string, Set<string>> {
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
    const grants = backfilled();
    const made = created();
    const unbackfilled: Record<string, string[]> = {};
    for (const role of BUILTIN_ROLES) {
      const from = baseline.roles[role.key] ?? [...(made.get(role.key) ?? [])];
      if (baseline.roles[role.key] === undefined && !made.has(role.key)) {
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

  async function rerun(file: string) {
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
    await rerun("0137_builtin_role_backfill.sql");
    await rerun("0137_builtin_role_backfill.sql");
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
