import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createTestDatabase, type TestDatabase } from "./support/database";
import { ctx, ids, inContext, seedTwoTenants, TENANT_A, TENANT_B } from "./support/fixtures";

/**
 * Cross-tenant isolation through the database role the API uses (section 5.3, hazard HZ-011).
 * Every table with a tenant_id is checked generically, then representative writes are attempted.
 */

let db: TestDatabase;
let tenantTables: string[];

beforeAll(async () => {
  db = await createTestDatabase();
  await seedTwoTenants(db.pool("harbour_owner"));
  const { rows } = await db.pool("harbour_owner").query<{ table_name: string }>(
    `SELECT table_name FROM information_schema.columns
     WHERE table_schema = 'public' AND column_name = 'tenant_id' ORDER BY table_name`,
  );
  // Tables the application role has no grant on at all are proved closed below, not read.
  const closed = await db.pool("harbour_owner").query<{ table_name: string }>(
    `SELECT DISTINCT table_name FROM information_schema.columns
     WHERE table_schema = 'public' AND column_name = 'tenant_id'
       AND NOT has_any_column_privilege('harbour_app', 'public.' || table_name, 'SELECT')
     ORDER BY table_name`,
  );
  closedTables = closed.rows.map((r) => r.table_name);
  tenantTables = rows.map((r) => r.table_name).filter((t) => !closedTables.includes(t));
});

/**
 * Anonymous survey responses, released and waiting (scheduling.md section 16 rule 3): reached only
 * through their definer functions, never read by the application role.
 */
const CLOSED_TO_APP = ["pulse_survey_response", "pulse_survey_response_pending"];
let closedTables: string[] = [];

afterAll(async () => {
  await db?.drop();
});

const app = () => db.pool("harbour_app");

describe("hazard HZ-011 tenant isolation for harbour_app", () => {
  it("has no grant at all on the tables only definer functions reach", () => {
    expect(closedTables).toEqual(CLOSED_TO_APP);
  });

  it("sees nothing at all without a request context (fails closed)", async () => {
    for (const table of [...tenantTables, "tenant", "tenant_group"]) {
      const count = await inContext(app(), null, async (c) => {
        const { rows } = await c.query<{ n: string }>(
          `SELECT count(*) AS n FROM ${table} WHERE ${table === "tenant" || table === "tenant_group" ? "true" : "tenant_id IS NOT NULL"}`,
        );
        return Number(rows[0]?.n);
      });
      expect({ table, count }).toEqual({ table, count: 0 });
    }
  });

  it("never returns another tenant's rows from any table", async () => {
    for (const table of tenantTables) {
      const leaked = await inContext(app(), ctx(TENANT_A, ids.a.manager, "tenant"), async (c) => {
        const { rows } = await c.query<{ n: string }>(
          `SELECT count(*) AS n FROM ${table} WHERE tenant_id IS DISTINCT FROM $1 AND tenant_id IS NOT NULL`,
          [TENANT_A],
        );
        return Number(rows[0]?.n);
      });
      expect({ table, leaked }).toEqual({ table, leaked: 0 });
    }
  });

  it("sees its own data in tenant scope", async () => {
    const counts = await inContext(app(), ctx(TENANT_A, ids.a.manager, "tenant"), async (c) => {
      const people = await c.query("SELECT id FROM person");
      const tenants = await c.query<{ id: string }>("SELECT id FROM tenant");
      return { people: people.rowCount, tenants: tenants.rows.map((r) => r.id) };
    });
    expect(counts).toEqual({ people: 3, tenants: [TENANT_A] });
  });

  it("reads global reference rows and its own overrides, never another tenant's", async () => {
    const keys = await inContext(app(), ctx(TENANT_B, ids.b.manager, "tenant"), async (c) => {
      const { rows } = await c.query<{ key: string; tenant_id: string | null }>(
        "SELECT key, tenant_id FROM rate_table ORDER BY key",
      );
      return rows;
    });
    expect(keys).toEqual([{ key: "nmw.hourly.21_plus", tenant_id: null }]);
  });

  it("rejects inserting a row for another tenant", async () => {
    await expect(
      inContext(app(), ctx(TENANT_A, ids.a.manager, "tenant"), (c) =>
        c.query(
          `INSERT INTO person (tenant_id, location_id, given_name, family_name)
           VALUES ($1, $2, 'Ivy', 'Intruder')`,
          [TENANT_B, ids.b.location],
        ),
      ),
    ).rejects.toThrow(/row-level security/);
  });

  it("rejects pointing a record at another tenant's parent through a foreign key", async () => {
    await expect(
      inContext(app(), ctx(TENANT_A, ids.a.manager, "tenant"), (c) =>
        c.query(
          `INSERT INTO contact (person_id, role, given_name, family_name)
           VALUES ($1, 'other', 'Jo', 'Crosslink')`,
          [ids.b.personDev],
        ),
      ),
    ).rejects.toThrow();
  });

  it("cannot update or soft-delete another tenant's rows", async () => {
    const affected = await inContext(app(), ctx(TENANT_A, ids.a.manager, "tenant"), async (c) => {
      const updated = await c.query("UPDATE person SET preferred_name = 'Changed' WHERE id = $1", [
        ids.b.personDev,
      ]);
      const flag = await c.query("UPDATE feature_flag SET enabled = false WHERE tenant_id = $1", [
        TENANT_B,
      ]);
      return (updated.rowCount ?? 0) + (flag.rowCount ?? 0);
    });
    expect(affected).toBe(0);
  });

  it("cannot move a row into another tenant", async () => {
    await expect(
      inContext(app(), ctx(TENANT_A, ids.a.manager, "tenant"), (c) =>
        c.query("UPDATE person SET tenant_id = $1 WHERE id = $2", [TENANT_B, ids.a.personAda]),
      ),
    ).rejects.toThrow();
  });

  it("cannot delete anything (soft delete only)", async () => {
    await expect(
      inContext(app(), ctx(TENANT_A, ids.a.manager, "tenant"), (c) =>
        c.query("DELETE FROM contact WHERE person_id = $1", [ids.a.personAda]),
      ),
    ).rejects.toThrow(/permission denied/);
  });

  it("cannot create tenants or read the auth schema", async () => {
    await expect(
      inContext(app(), ctx(TENANT_A, ids.a.manager, "tenant"), (c) =>
        c.query(
          `INSERT INTO tenant (name, legal_name, legal_form) VALUES ('X', 'X Ltd', 'limited_company')`,
        ),
      ),
    ).rejects.toThrow(/permission denied/);
    await expect(
      inContext(app(), ctx(TENANT_A, ids.a.manager, "tenant"), (c) =>
        c.query("SELECT count(*) FROM auth.user"),
      ),
    ).rejects.toThrow(/permission denied/);
  });

  it("does not leak context between pooled transactions", async () => {
    await inContext(app(), ctx(TENANT_A, ids.a.manager, "tenant"), (c) => c.query("SELECT 1"));
    const count = await inContext(app(), null, async (c) => {
      const { rows } = await c.query<{ n: string }>("SELECT count(*) AS n FROM person");
      return Number(rows[0]?.n);
    });
    expect(count).toBe(0);
  });

  it("rejects a malformed tenant id instead of matching anything", async () => {
    await expect(
      inContext(app(), ctx("not-a-uuid", null, "tenant"), (c) => c.query("SELECT * FROM person")),
    ).rejects.toThrow(/invalid input syntax for type uuid/);
  });
});

describe("hazard HZ-011 membership lookup before a tenant is chosen", () => {
  it("returns every active membership for one identity and nothing else", async () => {
    const rows = await inContext(app(), null, async (c) => {
      const result = await c.query<{ tenant_id: string; tenant_name: string }>(
        "SELECT tenant_id, tenant_name FROM app.memberships_for_auth_user($1)",
        ["auth-shared-agency-worker"],
      );
      return result.rows;
    });
    expect(rows.map((r) => r.tenant_id).sort()).toEqual([TENANT_A, TENANT_B].sort());
  });

  it("returns nothing for an unknown identity", async () => {
    const rows = await inContext(app(), null, async (c) => {
      const result = await c.query("SELECT * FROM app.memberships_for_auth_user($1)", [
        "auth-nobody",
      ]);
      return result.rows;
    });
    expect(rows).toEqual([]);
  });
});

describe("hazard HZ-011 service roles", () => {
  it("lets the operator console see tenants but never people", async () => {
    const tenants = await inContext(db.pool("harbour_operator"), null, async (c) => {
      const { rows } = await c.query("SELECT id FROM tenant");
      return rows.length;
    });
    expect(tenants).toBe(2);
    await expect(
      inContext(db.pool("harbour_operator"), null, (c) => c.query("SELECT * FROM person")),
    ).rejects.toThrow(/permission denied/);
  });

  it("lets the sync role read synced tables for replication but nothing else", async () => {
    const people = await inContext(db.pool("harbour_sync"), null, async (c) => {
      const { rows } = await c.query("SELECT id FROM person");
      return rows.length;
    });
    expect(people).toBe(4);
    await expect(
      inContext(db.pool("harbour_sync"), null, (c) => c.query("SELECT * FROM contact")),
    ).rejects.toThrow(/permission denied/);
    await expect(
      inContext(db.pool("harbour_sync"), null, (c) =>
        c.query("UPDATE person SET preferred_name = 'x'"),
      ),
    ).rejects.toThrow(/permission denied/);
  });

  it("keeps the auth role inside the auth schema", async () => {
    await expect(
      inContext(db.pool("harbour_auth"), null, (c) => c.query("SELECT * FROM person")),
    ).rejects.toThrow(/permission denied/);
    const users = await inContext(db.pool("harbour_auth"), null, async (c) => {
      const { rows } = await c.query("SELECT count(*) FROM auth.user");
      return rows.length;
    });
    expect(users).toBe(1);
  });
});
