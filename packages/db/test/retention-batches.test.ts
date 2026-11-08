import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createTestDatabase, type TestDatabase } from "./support/database";
import { ctx, ids, inContext, seedTwoTenants, TENANT_A, TENANT_B } from "./support/fixtures";

/**
 * Destruction batches (retention sweeps plan 5.4 and 5.5, slice 6; ADR-0135; migration 0161): only
 * the system proposes a batch and its items; they are read in tenant-wide scope only and never by
 * another organisation; a batch moves once, from proposed to cancelled, by a holder of
 * platform.retention.manage in their own name, and is never deleted; items are append-only.
 */

let db: TestDatabase;
const app = () => db.pool("harbour_app");
const owner = () => db.pool("harbour_owner");
const ROLE = "0193a000-0000-7000-8000-0000000006a1";
const system = (tenantId: string) => ctx(tenantId, null, "tenant");

async function propose(tenantId: string, recordClass: string): Promise<string> {
  return inContext(app(), system(tenantId), async (c) => {
    const { rows } = await c.query<{ id: string }>(
      `INSERT INTO destruction_batch (record_class, rule, item_count, tables, proposed_at)
       VALUES ($1, '{"period": 8, "unit": "years"}', 1, '{"care_note": 1}', now()) RETURNING id`,
      [recordClass],
    );
    const id = rows[0]?.id as string;
    await c.query(
      `INSERT INTO destruction_batch_item (batch_id, table_name, record_id, record_class, due_on, subject_kind, subject_ids)
       VALUES ($1, 'care_note', app.uuid_v7(), $2, '2020-01-01', 'person', ARRAY[app.uuid_v7()])`,
      [id, recordClass],
    );
    return id;
  });
}

const count = (context: ReturnType<typeof ctx>, table: string) =>
  inContext(app(), context, async (c) => {
    const { rows } = await c.query<{ n: number }>(`SELECT count(*)::int AS n FROM ${table}`);
    return rows[0]?.n;
  });

const cancel = (batchId: string, by: string, reason = "rule_under_review") =>
  inContext(app(), ctx(TENANT_A, by, "tenant"), (c) =>
    c.query(
      `UPDATE destruction_batch SET status = 'cancelled', cancelled_at = now(), cancelled_by = $2,
         cancel_reason = $3 WHERE id = $1 RETURNING version`,
      [batchId, by, reason],
    ),
  );

let batchA: string;

beforeAll(async () => {
  db = await createTestDatabase();
  await seedTwoTenants(owner());
  await inContext(owner(), system(TENANT_A), async (c) => {
    await c.query(
      `INSERT INTO role (id, key, name, scope_kind, permissions)
       VALUES ($1, 'records', 'Records', 'tenant', '{platform.retention.manage}')`,
      [ROLE],
    );
    await c.query(
      "INSERT INTO role_assignment (tenant_user_id, role_id, location_id) VALUES ($1, $2, NULL)",
      [ids.a.manager, ROLE],
    );
  });
  batchA = await propose(TENANT_A, "care_record");
  await propose(TENANT_B, "care_record");
}, 120_000);

afterAll(async () => {
  await db?.drop();
});

describe("destruction_batch and destruction_batch_item", () => {
  it("shows each organisation only its own, in tenant-wide scope only", async () => {
    for (const table of ["destruction_batch", "destruction_batch_item"]) {
      expect(await count(ctx(TENANT_A, ids.a.manager, "tenant"), table)).toBe(1);
      expect(await count(ctx(TENANT_B, ids.b.manager, "tenant"), table)).toBe(1);
      expect(
        await count(ctx(TENANT_A, ids.a.northManager, "locations", [ids.a.locationNorth]), table),
      ).toBe(0);
    }
  });

  it("is proposed by the system only, as proposed, and never for another organisation", async () => {
    // A person never proposes a batch or an item.
    await expect(
      inContext(app(), ctx(TENANT_A, ids.a.manager, "tenant"), (c) =>
        c.query(
          `INSERT INTO destruction_batch (record_class, rule, item_count, tables, proposed_at)
           VALUES ('complaint', '{}', 1, '{}', now())`,
        ),
      ),
    ).rejects.toThrow(/row-level security/);
    await expect(
      inContext(app(), ctx(TENANT_A, ids.a.manager, "tenant"), (c) =>
        c.query(
          `INSERT INTO destruction_batch_item (batch_id, table_name, record_id, record_class, due_on, subject_kind)
           VALUES ($1, 'care_note', app.uuid_v7(), 'care_record', '2020-01-01', 'none')`,
          [batchA],
        ),
      ),
    ).rejects.toThrow(/row-level security/);
    // Nor already cancelled, nor in another organisation's name.
    await expect(
      inContext(app(), system(TENANT_A), (c) =>
        c.query(
          `INSERT INTO destruction_batch (record_class, rule, item_count, tables, proposed_at, status,
             cancelled_at, cancelled_by, cancel_reason)
           VALUES ('complaint', '{}', 1, '{}', now(), 'cancelled', now(), $1, 'other')`,
          [ids.a.manager],
        ),
      ),
    ).rejects.toThrow(/row-level security/);
    await expect(
      inContext(app(), system(TENANT_A), (c) =>
        c.query(
          `INSERT INTO destruction_batch (tenant_id, record_class, rule, item_count, tables, proposed_at)
           VALUES ($1, 'complaint', '{}', 1, '{}', now())`,
          [TENANT_B],
        ),
      ),
    ).rejects.toThrow(/row-level security/);
  });

  it("holds one proposed batch per class at a time", async () => {
    await expect(propose(TENANT_A, "care_record")).rejects.toThrow(
      /destruction_batch_one_proposed/,
    );
  });

  it("refuses an item with a subject kind of none that names someone", async () => {
    await expect(
      inContext(app(), system(TENANT_A), (c) =>
        c.query(
          `INSERT INTO destruction_batch_item (batch_id, table_name, record_id, record_class, due_on, subject_kind, subject_ids)
           VALUES ($1, 't', app.uuid_v7(), 'care_record', '2020-01-01', 'none', ARRAY[app.uuid_v7()])`,
          [batchA],
        ),
      ),
    ).rejects.toThrow(/destruction_batch_item_subject_ids/);
  });

  it("is cancelled only by a holder of platform.retention.manage, in their own name, once", async () => {
    // The carer holds no such permission: the row is not theirs to change.
    const refused = await cancel(batchA, ids.a.carer);
    expect(refused.rowCount).toBe(0);
    // Nor in someone else's name.
    await expect(
      inContext(app(), ctx(TENANT_A, ids.a.manager, "tenant"), (c) =>
        c.query(
          `UPDATE destruction_batch SET status = 'cancelled', cancelled_at = now(), cancelled_by = $2,
             cancel_reason = 'other' WHERE id = $1`,
          [batchA, ids.a.carer],
        ),
      ),
    ).rejects.toThrow(/row-level security/);
    // Never with free text.
    await expect(cancel(batchA, ids.a.manager, "Ada asked us to")).rejects.toThrow(
      /destruction_batch_cancelled/,
    );
    const done = await cancel(batchA, ids.a.manager);
    expect(done.rows[0]?.version).toBe(2);
    // Cancelled is final, and what was proposed never changes.
    await expect(
      inContext(app(), ctx(TENANT_A, ids.a.manager, "tenant"), (c) =>
        c.query(
          "UPDATE destruction_batch SET status = 'proposed', cancelled_at = NULL, cancelled_by = NULL, cancel_reason = NULL WHERE id = $1",
          [batchA],
        ),
      ),
    ).rejects.toThrow(/never changes/);
    // Its earlier version is kept.
    const versions = await inContext(owner(), system(TENANT_A), (c) =>
      c.query(
        "SELECT 1 FROM record_version WHERE table_name = 'destruction_batch' AND record_id = $1",
        [batchA],
      ),
    );
    expect(versions.rowCount).toBe(1);
  });

  it("never changes the proposal itself, even as the owner", async () => {
    await expect(
      inContext(owner(), system(TENANT_B), (c) =>
        c.query("UPDATE destruction_batch SET item_count = 2"),
      ),
    ).rejects.toThrow(/proposal never changes/);
  });

  it("is never deleted, and its items never change, by the application or the owner", async () => {
    for (const pool of [app(), owner()]) {
      for (const statement of [
        "DELETE FROM destruction_batch",
        "UPDATE destruction_batch_item SET due_on = '2000-01-01'",
        "DELETE FROM destruction_batch_item",
      ]) {
        await expect(
          inContext(pool, system(TENANT_A), (c) => c.query(statement)),
        ).rejects.toThrow();
      }
    }
    expect(await count(system(TENANT_A), "destruction_batch")).toBe(1);
    expect(await count(system(TENANT_A), "destruction_batch_item")).toBe(1);
  });
});
