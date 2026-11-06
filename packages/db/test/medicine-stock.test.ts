import { randomUUID } from "node:crypto";
import { DISPOSAL_REASONS, ORDER_STATUSES, STOCK_MOVEMENTS, STORAGE_KINDS } from "@harbour/domain";
import type pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  DISPOSAL_REASON_CODES,
  ORDER_STATUS_CODES,
  STOCK_MOVEMENT_CODES,
  STORAGE_KIND_CODES,
} from "../src/schema";
import { createTestDatabase, type TestDatabase } from "./support/database";
import { ctx, ids, inContext, seedTwoTenants, TENANT_A, TENANT_B } from "./support/fixtures";

/**
 * Medicines stock, ordering, disposal and temperatures in the database (slice 42; MEDS-008;
 * migration 0138; HZ-132): another organisation sees nothing; person tables follow the person's
 * scope and location tables the location's; movements follow the item's balance and are never
 * edited; a controlled drug has no item; a disposal's witness confirms it themselves, once; an
 * order's lines change only while it is a draft; a reading's range comes from the rate table and
 * one out of range names its task.
 *
 * Fixture: Ada and Ben live at North (the care worker is assigned to Ada only), Cara at South.
 */

let db: TestDatabase;
const a = ids.a;
const app = () => db.pool("harbour_app");
const manager = ctx(TENANT_A, a.manager, "tenant");
const carer = ctx(TENANT_A, a.carer, "assigned");
const north = ctx(TENANT_A, a.northManager, "locations", [a.locationNorth]);
const other = ctx(TENANT_B, ids.b.manager, "tenant");
const PARACETAMOL = "90000041000001107";
const MORPHINE = "90000081000001109";
const ADA_MED = "0193a000-0000-7000-8000-00000000e101";
const ADA_CD = "0193a000-0000-7000-8000-00000000e102";
const CARA_MED = "0193a000-0000-7000-8000-00000000e103";

async function refused(
  context: ReturnType<typeof ctx>,
  fn: (c: pg.PoolClient) => Promise<unknown>,
) {
  return inContext(app(), context, async (c) => {
    await c.query("SAVEPOINT s");
    try {
      await fn(c);
      return null;
    } catch (error) {
      await c.query("ROLLBACK TO SAVEPOINT s");
      return (error as { message?: string }).message ?? "error";
    }
  });
}

async function med(c: pg.PoolClient, id: string, personId: string, vmp: string, cd: string | null) {
  await c.query(
    `INSERT INTO medication (id, person_id, medicine_id, version, origin, vmp_id, product_name,
       route_code, route_name, directions, pattern_kind, prescriber, starts_at, source_kind,
       source_reference, transcribed_by, transcribed_at, cd_schedule)
     VALUES ($1, $2, $1, 1, 'transcribed', $3, 'Example tablets', '26643006', 'Oral',
       'regular', 'every_day', 'Dr A Example', now(), 'prescription', 'Prescription, 01/11/2026',
       $4, now(), $5)`,
    [id, personId, vmp, a.manager, cd],
  );
}

const openItem = (c: pg.PoolClient, personId: string, medId: string, vmp: string) =>
  c.query<{ id: string }>(
    `INSERT INTO medicine_stock_item (person_id, medication_id, vmp_id, product_name, unit_code,
       unit_name, opened_by)
     VALUES ($1, $2, $3, 'Example tablets', '428673006', 'tablet', $4) RETURNING id::text`,
    [personId, medId, vmp, a.manager],
  );

const move = (
  c: pg.PoolClient,
  v: {
    item: string;
    person: string;
    seq: number;
    movement: string;
    change: number;
    balance: number;
    reason?: string;
  },
) =>
  c.query(
    `INSERT INTO medicine_stock_movement (item_id, person_id, seq, movement, change, balance_after,
       reason, recorded_by)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
    [v.item, v.person, v.seq, v.movement, v.change, v.balance, v.reason ?? null, a.manager],
  );

let ADA_ITEM = "";
let CARA_ITEM = "";

beforeAll(async () => {
  db = await createTestDatabase();
  await seedTwoTenants(db.pool("harbour_owner"));
  await inContext(db.pool("harbour_owner"), null, (c) =>
    c.query(
      `INSERT INTO rate_table (key, value, unit, nation, valid_from, source, verification_status)
       VALUES ('medicines.fridge_min_celsius', 2, 'celsius', 'all', '2000-01-01', 'rates.md', 'master-prompt'),
              ('medicines.fridge_max_celsius', 8, 'celsius', 'all', '2000-01-01', 'rates.md', 'master-prompt'),
              ('medicines.room_max_celsius', 25, 'celsius', 'all', '2000-01-01', 'rates.md', 'master-prompt'),
              ('medicines.disposal.witness_required', 1, 'flag', 'all', '2000-01-01', 'rates.md', 'to-verify')
       ON CONFLICT DO NOTHING`,
    ),
  );
  // The care worker can witness disposals: medicines.stock.manage at North.
  await inContext(db.pool("harbour_owner"), ctx(TENANT_A, null, "tenant"), async (c) => {
    await c.query(
      `INSERT INTO role (id, key, name, scope_kind, permissions) VALUES
         ('0199f420-0000-7000-8000-000000000501', 'stock', 'Stock', 'location', '{medicines.stock.manage}')`,
    );
    await c.query(
      `INSERT INTO role_assignment (tenant_user_id, role_id, location_id)
       VALUES ($1, '0199f420-0000-7000-8000-000000000501', $2),
              ($3, '0199f420-0000-7000-8000-000000000501', $4)`,
      [a.carer, a.locationNorth, a.northManager, a.locationSouth],
    );
  });
  await inContext(app(), manager, async (c) => {
    await med(c, ADA_MED, a.personAda, PARACETAMOL, null);
    await med(c, ADA_CD, a.personAda, MORPHINE, "2");
    await med(c, CARA_MED, a.personCara, PARACETAMOL, null);
    ADA_ITEM = (await openItem(c, a.personAda, ADA_MED, PARACETAMOL)).rows[0]?.id as string;
    CARA_ITEM = (await openItem(c, a.personCara, CARA_MED, PARACETAMOL)).rows[0]?.id as string;
    await move(c, {
      item: ADA_ITEM,
      person: a.personAda,
      seq: 1,
      movement: "receipt",
      change: 28,
      balance: 28,
    });
  });
}, 120_000);

afterAll(async () => {
  await db?.drop();
});

describe("hazard HZ-132 MEDS-008 medicines stock in the database", () => {
  it("keeps the code lists in step with packages/domain", () => {
    expect([...STOCK_MOVEMENT_CODES]).toEqual([...STOCK_MOVEMENTS]);
    expect([...DISPOSAL_REASON_CODES]).toEqual([...DISPOSAL_REASONS]);
    expect([...ORDER_STATUS_CODES]).toEqual([...ORDER_STATUSES]);
    expect([...STORAGE_KIND_CODES]).toEqual([...STORAGE_KINDS]);
  });

  it("never opens an item for a controlled drug: its register keeps its stock", async () => {
    expect(await refused(manager, (c) => openItem(c, a.personAda, ADA_CD, MORPHINE))).toBe(
      "medicine_stock_item_controlled_drug",
    );
    expect(await refused(manager, (c) => openItem(c, a.personAda, ADA_MED, MORPHINE))).toBe(
      "medicine_stock_item_entry",
    );
  });

  it("follows each movement from the last balance, in sequence, and never edits one", async () => {
    expect(
      await refused(manager, (c) =>
        move(c, {
          item: ADA_ITEM,
          person: a.personAda,
          seq: 2,
          movement: "returned",
          change: -2,
          balance: 25,
        }),
      ),
    ).toBe("medicine_stock_movement_balance");
    expect(
      await refused(manager, (c) =>
        move(c, {
          item: ADA_ITEM,
          person: a.personAda,
          seq: 3,
          movement: "returned",
          change: -2,
          balance: 26,
        }),
      ),
    ).toBe("medicine_stock_movement_seq");
    expect(
      await refused(manager, (c) =>
        move(c, {
          item: ADA_ITEM,
          person: a.personAda,
          seq: 2,
          movement: "receipt",
          change: -2,
          balance: 26,
        }),
      ),
    ).toMatch(/medicine_stock_movement_sign/);
    expect(
      await refused(manager, (c) =>
        move(c, {
          item: ADA_ITEM,
          person: a.personAda,
          seq: 2,
          movement: "count_adjustment",
          change: -1,
          balance: 27,
        }),
      ),
    ).toMatch(/medicine_stock_movement_refs/);
    expect(
      await refused(manager, (c) =>
        move(c, {
          item: ADA_ITEM,
          person: a.personAda,
          seq: 2,
          movement: "count_adjustment",
          change: -1,
          balance: 27,
          reason: "Counted 27",
        }),
      ),
    ).toBeNull();
    // A balance may go below zero: a dose is never blocked by stock.
    expect(
      await refused(manager, (c) =>
        move(c, {
          item: CARA_ITEM,
          person: a.personCara,
          seq: 1,
          movement: "returned",
          change: -1,
          balance: -1,
        }),
      ),
    ).toBeNull();
    expect(
      await refused(manager, (c) => c.query("UPDATE medicine_stock_movement SET reason = 'x'")),
    ).toMatch(/permission denied/);
  });

  it("has a disposal confirmed by its own witness, once, and refuses no witness where the policy needs one", async () => {
    const dispose = (c: pg.PoolClient, witness: string | null, reason: string | null) =>
      c.query<{ id: string }>(
        `INSERT INTO medicine_disposal (item_id, person_id, location_id, quantity, reason,
           recorded_by, witness_id, no_witness_reason)
         VALUES ($1, $2, $3, 1, 'dropped_or_spoilt', $4, $5, $6) RETURNING id::text`,
        [ADA_ITEM, a.personAda, a.locationNorth, a.manager, witness, reason],
      );
    expect(await refused(manager, (c) => dispose(c, null, "Only one of us on shift tonight"))).toBe(
      "medicine_disposal_witness_required",
    );
    expect(await refused(manager, (c) => dispose(c, a.manager, null))).toMatch(
      /medicine_disposal_witness/,
    );
    // A witness who could never confirm it (medicines.stock.manage only at South) is refused.
    expect(await refused(manager, (c) => dispose(c, a.northManager, null))).toBe(
      "medicine_disposal_witness_cannot",
    );
    const id = await inContext(
      app(),
      manager,
      async (c) => (await dispose(c, a.carer, null)).rows[0]?.id,
    );
    expect(
      await refused(manager, (c) =>
        c.query("UPDATE medicine_disposal SET witnessed_at = now() WHERE id = $1", [id]),
      ),
    ).toBe("medicine_disposal_witness");
    expect(
      await refused(carer, (c) =>
        c.query("UPDATE medicine_disposal SET witnessed_at = now() WHERE id = $1", [id]),
      ),
    ).toBeNull();
    expect(
      await refused(carer, (c) =>
        c.query("UPDATE medicine_disposal SET witnessed_at = now() WHERE id = $1", [id]),
      ),
    ).toBe("medicine_disposal_witness");
  });

  it("changes an order's lines only while it is a draft, and moves it only by its steps", async () => {
    const order = await inContext(
      app(),
      manager,
      async (c) =>
        (
          await c.query<{ id: string }>(
            "INSERT INTO medicine_order (location_id, cycle_starts_on) VALUES ($1, '2026-11-30') RETURNING id::text",
            [a.locationNorth],
          )
        ).rows[0]?.id,
    );
    const line = (c: pg.PoolClient, medId: string, person: string, vmp: string) =>
      c.query(
        `INSERT INTO medicine_order_line (order_id, person_id, medication_id, vmp_id, product_name,
           quantity, unit_code)
         VALUES ($1, $2, $3, $4, 'Example tablets', 56, '428673006')`,
        [order, person, medId, vmp],
      );
    expect(await refused(manager, (c) => line(c, ADA_CD, a.personAda, MORPHINE))).toBe(
      "medicine_order_line_entry",
    );
    expect(await refused(manager, (c) => line(c, CARA_MED, a.personCara, PARACETAMOL))).toBe(
      "medicine_order_line_entry",
    );
    expect(await refused(manager, (c) => line(c, ADA_MED, a.personAda, PARACETAMOL))).toBeNull();
    expect(
      await refused(manager, (c) =>
        c.query("UPDATE medicine_order SET status = 'received' WHERE id = $1", [order]),
      ),
    ).toBe("medicine_order_step");
    await inContext(app(), manager, (c) =>
      c.query("UPDATE medicine_order SET status = 'submitted', sent_via = 'manual' WHERE id = $1", [
        order,
      ]),
    );
    expect(await refused(manager, (c) => line(c, ADA_MED, a.personAda, PARACETAMOL))).toBe(
      "medicine_order_line_fixed",
    );
  });

  it("takes a reading's range from the rate table, and an out-of-range one names its task", async () => {
    const storage = await inContext(
      app(),
      manager,
      async (c) =>
        (
          await c.query<{ id: string }>(
            "INSERT INTO medicine_storage (location_id, kind, name) VALUES ($1, 'fridge', 'Medicines fridge') RETURNING id::text",
            [a.locationNorth],
          )
        ).rows[0]?.id,
    );
    const reading = (c: pg.PoolClient, tenths: number, taskId: string | null) =>
      c.query<{ out_of_range: boolean; low_tenths: number; high_tenths: number }>(
        `INSERT INTO medicine_temperature_reading (storage_id, location_id, reading_tenths, task_id,
           recorded_by)
         VALUES ($1, $2, $3, $4, app.current_user_id())
         RETURNING out_of_range, low_tenths, high_tenths`,
        [storage, a.locationNorth, tenths, taskId],
      );
    const inRange = await inContext(
      app(),
      manager,
      async (c) => (await reading(c, 50, null)).rows[0],
    );
    expect(inRange).toEqual({ out_of_range: false, low_tenths: 20, high_tenths: 80 });
    expect(await refused(manager, (c) => reading(c, 90, null))).toBe(
      "medicine_temperature_reading_task",
    );
    const taskId = randomUUID();
    await inContext(app(), manager, (c) =>
      c.query(
        `INSERT INTO task (id, kind, title, location_id, source_type, source_id, due_at, priority,
           required_permission)
         VALUES ($1, 'medicines.temperature.out_of_range', 'Medicines storage out of range', $2,
           'medicine_storage', $3, now(), 'urgent', 'medicines.stock.manage')`,
        [taskId, a.locationNorth, storage],
      ),
    );
    const out = await inContext(
      app(),
      manager,
      async (c) => (await reading(c, 90, taskId)).rows[0],
    );
    expect(out?.out_of_range).toBe(true);
    expect(
      await refused(manager, (c) =>
        c.query("UPDATE medicine_temperature_reading SET reading_tenths = 50"),
      ),
    ).toMatch(/permission denied/);
  });

  it("keeps stock to the person's scope and the location tables to the location's", async () => {
    const seen = (context: ReturnType<typeof ctx>) =>
      inContext(app(), context, async (c) => ({
        items: (await c.query("SELECT person_id FROM medicine_stock_item")).rowCount,
        storage: (await c.query("SELECT 1 FROM medicine_storage")).rowCount,
        orders: (await c.query("SELECT 1 FROM medicine_order")).rowCount,
      }));
    expect(await seen(manager)).toEqual({ items: 2, storage: 1, orders: 1 });
    expect((await seen(north)).items).toBe(1);
    expect((await seen(carer)).items).toBe(1);
    expect(await seen(other)).toEqual({ items: 0, storage: 0, orders: 0 });
    const everyTable = await inContext(app(), other, async (c) => {
      let total = 0;
      for (const t of [
        "medicine_stock_item",
        "medicine_stock_movement",
        "medicine_disposal",
        "medicine_order_cycle",
        "medicine_order",
        "medicine_order_line",
        "medicine_storage",
        "medicine_temperature_reading",
      ]) {
        total += (await c.query(`SELECT 1 FROM ${t}`)).rowCount ?? 0;
      }
      return total;
    });
    expect(everyTable).toBe(0);
  });
});
