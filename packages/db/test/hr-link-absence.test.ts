import type pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createTestDatabase, type TestDatabase } from "./support/database";
import { ctx, ids, inContext, seedTwoTenants, TENANT_A, TENANT_B } from "./support/fixtures";

/**
 * Thapsus-HR absences in the database (integrations.md section 11.3; slice 88; migration 0142;
 * hazards HZ-123, HZ-133): copies are written by the link's sync alone, read-only to people, keep
 * where they came from, and stay in their organisation; the sync's cover-need function refuses a
 * person and a Harbour absence. Invented people only.
 */

let db: TestDatabase;
const a = ids.a;
const b = ids.b;
const app = () => db.pool("harbour_app");
const asSystem = <T>(fn: (c: pg.PoolClient) => Promise<T>) =>
  inContext(app(), ctx(TENANT_A, null, "tenant"), fn);
/** A rota manager across the organisation. */
const asManager = <T>(fn: (c: pg.PoolClient) => Promise<T>) =>
  inContext(app(), ctx(TENANT_A, a.manager, "tenant"), fn);
const asOtherTenant = <T>(fn: (c: pg.PoolClient) => Promise<T>) =>
  inContext(app(), ctx(TENANT_B, b.manager, "tenant"), fn);

const copy = (c: pg.PoolClient, hrId: string, over = "") =>
  c.query<{ id: string }>(
    `INSERT INTO absence (member_id, location_id, kind, starts_on, ends_on, state, source, hr_id${over ? ", created_by" : ""})
     VALUES ($1, $2, 'sickness', '2026-12-01', '2026-12-03', 'recorded', 'thapsus_hr', $3${over ? ", $4" : ""})
     RETURNING id`,
    over ? [a.carer, a.locationNorth, hrId, over] : [a.carer, a.locationNorth, hrId],
  );

let copied = "";

beforeAll(async () => {
  db = await createTestDatabase();
  await seedTwoTenants(db.pool("harbour_owner"));
  await inContext(db.pool("harbour_owner"), ctx(TENANT_A, null, "tenant"), async (c) => {
    await c.query(
      `INSERT INTO role (id, key, name, scope_kind, permissions) VALUES
         ('0199f400-0000-7000-8000-000000000001', 'rota_manager', 'Rota manager', 'tenant',
          '{scheduling.rota.manage,scheduling.rota.approve,scheduling.rota.read}')`,
    );
    await c.query(
      "INSERT INTO role_assignment (tenant_user_id, role_id) VALUES ($1, '0199f400-0000-7000-8000-000000000001')",
      [a.manager],
    );
  });
  copied = (await asSystem((c) => copy(c, "abs_1"))).rows[0]?.id as string;
});

afterAll(async () => {
  await db?.drop();
});

describe("hazard HZ-133 a Thapsus-HR absence is the sync's copy, read-only to people (rule 2)", () => {
  it("lets a rota manager read it, never another organisation", async () => {
    expect(
      (await asManager((c) => c.query("SELECT 1 FROM absence WHERE id = $1", [copied]))).rows,
    ).toHaveLength(1);
    expect((await asOtherTenant((c) => c.query("SELECT 1 FROM absence"))).rows).toHaveLength(0);
  });

  it("refuses a person writing a Thapsus-HR copy", async () => {
    await expect(asManager((c) => copy(c, "abs_2", a.manager))).rejects.toThrow(
      /row-level security/,
    );
  });

  it("refuses a person changing or cancelling it", async () => {
    const changed = await asManager((c) =>
      c.query("UPDATE absence SET state = 'cancelled' WHERE id = $1", [copied]),
    );
    expect(changed.rowCount).toBe(0);
  });

  it("keeps where it came from, and allows only dates and type", async () => {
    await expect(
      asSystem((c) =>
        c.query("UPDATE absence SET source = 'harbour', hr_id = NULL WHERE id = $1", [copied]),
      ),
    ).rejects.toThrow(/absence_source_fixed|absence_source/);
    await expect(
      asSystem((c) =>
        c.query(
          `INSERT INTO absence (member_id, location_id, kind, starts_on, ends_on, state, source, hr_id)
           VALUES ($1, $2, 'maternity', '2026-12-01', '2027-06-01', 'recorded', 'thapsus_hr', 'abs_3')`,
          [a.carer, a.locationNorth],
        ),
      ),
    ).rejects.toThrow(/absence_source/);
  });

  it("refuses a second live copy of one Thapsus-HR absence", async () => {
    await expect(asSystem((c) => copy(c, "abs_1"))).rejects.toThrow(/absence_hr_key/);
  });

  it("lets the sync end or cancel its copy", async () => {
    await asSystem((c) =>
      c.query("UPDATE absence SET ends_on = '2026-12-02' WHERE id = $1", [copied]),
    );
    await asSystem((c) =>
      c.query("UPDATE absence SET state = 'cancelled' WHERE id = $1", [copied]),
    );
    copied = (await asSystem((c) => copy(c, "abs_1"))).rows[0]?.id as string;
    expect(copied).toBeTruthy();
  });
});

describe("hazard HZ-123 the sync's cover needs are its own (migration 0142)", () => {
  it("refuses a person calling the sync's cover-need function", async () => {
    await expect(
      asManager((c) =>
        c.query("SELECT app.raise_hr_cover_need($1::uuid, $2::uuid)", [copied, copied]),
      ),
    ).rejects.toThrow(/cover_need_not_allowed/);
  });

  it("refuses the sync raising one for an absence that is not a Thapsus-HR copy", async () => {
    const own = await asManager((c) =>
      c.query<{ id: string }>(
        `INSERT INTO absence (member_id, location_id, kind, starts_on, ends_on, state)
         VALUES ($1, $2, 'annual_leave', '2026-12-10', '2026-12-11', 'recorded') RETURNING id`,
        [a.carer, a.locationNorth],
      ),
    );
    await expect(
      asSystem((c) =>
        c.query("SELECT app.raise_hr_cover_need($1::uuid, $2::uuid)", [copied, own.rows[0]?.id]),
      ),
    ).rejects.toThrow(/cover_need_not_allowed/);
  });
});
