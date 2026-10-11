import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createTestDatabase, type TestDatabase, withAdminClient } from "./support/database";
import { ctx, ids, inContext, seedTwoTenants, TENANT_A, TENANT_B } from "./support/fixtures";

/** Append-only audit trail with a per-tenant hash chain, and versioned mutable aggregates. */

let db: TestDatabase;

beforeAll(async () => {
  db = await createTestDatabase();
  await seedTwoTenants(db.pool("harbour_owner"));
});

afterAll(async () => {
  await db?.drop();
});

const app = () => db.pool("harbour_app");
const managerA = () => ctx(TENANT_A, ids.a.manager, "tenant");

async function appendAudit(tenantId: string, userId: string, action: string, n = 1) {
  await inContext(app(), ctx(tenantId, userId, "tenant"), async (c) => {
    for (let i = 0; i < n; i++) {
      await c.query(
        `INSERT INTO audit_event (tenant_id, actor_tenant_user_id, action, resource_type, resource_id, ip)
         VALUES ($1, $2, $3, 'person', $4, '192.0.2.10')`,
        [tenantId, userId, action, ids.a.personAda],
      );
    }
  });
}

describe("audit_event", () => {
  it("accepts appends and forms an intact hash chain per tenant", async () => {
    await appendAudit(TENANT_A, ids.a.manager, "people.person.view", 5);
    await appendAudit(TENANT_B, ids.b.manager, "people.person.view", 2);
    const broken = await inContext(app(), managerA(), async (c) => {
      const { rows } = await c.query<{ broken: string | null }>(
        "SELECT app.verify_audit_chain() AS broken",
      );
      return rows[0]?.broken;
    });
    expect(broken).toBeNull();

    const positions = await inContext(app(), managerA(), async (c) => {
      const { rows } = await c.query<{ chain_position: string }>(
        "SELECT chain_position FROM audit_event ORDER BY chain_position",
      );
      return rows.map((r) => Number(r.chain_position));
    });
    expect(positions).toEqual([1, 2, 3, 4, 5]);
  });

  it("refuses updates and deletes from the application role", async () => {
    await expect(
      inContext(app(), managerA(), (c) => c.query("UPDATE audit_event SET action = 'tampered'")),
    ).rejects.toThrow(/permission denied/);
    await expect(
      inContext(app(), managerA(), (c) => c.query("DELETE FROM audit_event")),
    ).rejects.toThrow(/permission denied/);
  });

  it("gives even the owning role no rows to update or delete", async () => {
    const affected = await inContext(db.pool("harbour_owner"), managerA(), async (c) => {
      const updated = await c.query("UPDATE audit_event SET action = 'tampered'");
      const deleted = await c.query("DELETE FROM audit_event");
      return (updated.rowCount ?? 0) + (deleted.rowCount ?? 0);
    });
    expect(affected).toBe(0);
  });

  it("raises an error when a session that can see rows tries to change them", async () => {
    // Simulates a future policy mistake: the trigger is the last line of defence.
    await expect(
      withAdminClient(
        (admin) =>
          admin.query("UPDATE audit_event SET action = 'tampered' WHERE chain_position = 1"),
        db.name,
      ),
    ).rejects.toThrow(/append-only/);
  });

  it("detects tampering by someone who bypasses the triggers", async () => {
    // A superuser on the test database, simulating an attacker with direct database access.
    await withAdminClient(async (admin) => {
      await admin.query("ALTER TABLE audit_event DISABLE TRIGGER append_only");
      await admin.query(
        "UPDATE audit_event SET action = 'people.person.export' WHERE tenant_id = $1 AND chain_position = 3",
        [TENANT_A],
      );
      await admin.query("ALTER TABLE audit_event ENABLE TRIGGER append_only");
    }, db.name);
    const broken = await inContext(app(), managerA(), async (c) => {
      const { rows } = await c.query<{ broken: string | null }>(
        "SELECT app.verify_audit_chain() AS broken",
      );
      return rows[0]?.broken;
    });
    expect(Number(broken)).toBe(3);
  });

  it("records platform events without a tenant, hidden from every tenant", async () => {
    await inContext(app(), null, (c) =>
      c.query("INSERT INTO audit_event (action, outcome) VALUES ('auth.sign_in', 'denied')"),
    );
    const visibleToTenant = await inContext(app(), managerA(), async (c) => {
      const { rows } = await c.query("SELECT 1 FROM audit_event WHERE action = 'auth.sign_in'");
      return rows.length;
    });
    expect(visibleToTenant).toBe(0);
    const visibleToOperator = await inContext(db.pool("harbour_operator"), null, async (c) => {
      const { rows } = await c.query("SELECT 1 FROM audit_event WHERE action = 'auth.sign_in'");
      return rows.length;
    });
    expect(visibleToOperator).toBe(1);
  });

  it("refuses a tenant event written while acting for another tenant", async () => {
    await expect(
      inContext(app(), managerA(), (c) =>
        c.query("INSERT INTO audit_event (tenant_id, action) VALUES ($1, 'x')", [TENANT_B]),
      ),
    ).rejects.toThrow(/row-level security/);
  });
});

describe("versioned mutable aggregates", () => {
  it("bumps the version and keeps the previous row in record_version", async () => {
    await inContext(app(), managerA(), (c) =>
      c.query("UPDATE person SET preferred_name = 'Addie' WHERE id = $1", [ids.a.personAda]),
    );
    const result = await inContext(app(), managerA(), async (c) => {
      const person = await c.query<{ version: number; updated_by: string }>(
        "SELECT version, updated_by FROM person WHERE id = $1",
        [ids.a.personAda],
      );
      const history = await c.query<{
        record_version: number;
        data: { preferred_name: string | null };
      }>(
        "SELECT record_version, data FROM record_version WHERE table_name = 'person' AND record_id = $1",
        [ids.a.personAda],
      );
      return { person: person.rows[0], history: history.rows };
    });
    expect(result.person).toEqual({ version: 2, updated_by: ids.a.manager });
    expect(result.history).toEqual([
      { record_version: 1, data: expect.objectContaining({ preferred_name: null }) },
    ]);
  });

  it("does not let a client set the version or rewrite who created the row", async () => {
    await inContext(app(), managerA(), (c) =>
      c.query("UPDATE person SET version = 99, created_by = $2 WHERE id = $1", [
        ids.a.personBen,
        ids.a.carer,
      ]),
    );
    const row = await inContext(app(), managerA(), async (c) => {
      const { rows } = await c.query<{ version: number; created_by: string | null }>(
        "SELECT version, created_by FROM person WHERE id = $1",
        [ids.a.personBen],
      );
      return rows[0];
    });
    expect(row).toEqual({ version: 2, created_by: null });
  });

  it("refuses overlapping statutory rate periods", async () => {
    await expect(
      inContext(db.pool("harbour_owner"), null, (c) =>
        c.query(
          `INSERT INTO rate_table (key, value, unit, nation, valid_from, source, verification_status)
           VALUES ('nmw.hourly.21_plus', 13.00, 'GBP_per_hour', 'uk', '2026-10-01', 'test', 'test')`,
        ),
      ),
    ).rejects.toThrow(/rate_table_no_overlap/);
  });
});
