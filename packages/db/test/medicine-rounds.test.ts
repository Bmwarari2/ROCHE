import { randomUUID } from "node:crypto";
import type pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createTestDatabase, type TestDatabase } from "./support/database";
import { ctx, ids, inContext, seedTwoTenants, TENANT_A, TENANT_B } from "./support/fixtures";

/**
 * Conflict review in the database (Phase 2 slice 48; MEDS-002; migration 0134): a second record
 * of a dose uploaded from a device is kept as sent, follows the person's scope, never changes and
 * is resolved once, a correction named when it was corrected.
 */

let db: TestDatabase;
const a = ids.a;
const ENTRY = "0193a000-0000-7000-8000-00000000d101";
const STANDING = "0193a000-0000-7000-8000-00000000d201";
const CONFLICT = "0193a000-0000-7000-8000-00000000d301";
const DUE = "2026-11-02T08:00:00Z";

const app = () => db.pool("harbour_app");
const manager = ctx(TENANT_A, a.manager, "tenant");
const carer = ctx(TENANT_A, a.carer, "assigned");

async function refused(context: ReturnType<typeof ctx>, sql: string, params: unknown[] = []) {
  return inContext(app(), context, async (c) => {
    await c.query("SAVEPOINT s");
    try {
      await c.query(sql, params);
      return null;
    } catch (error) {
      await c.query("ROLLBACK TO SAVEPOINT s");
      return (error as { code?: string }).code ?? "error";
    }
  });
}

beforeAll(async () => {
  db = await createTestDatabase();
  await seedTwoTenants(db.pool("harbour_owner"));
  await inContext(app(), manager, async (c: pg.PoolClient) => {
    await c.query(
      `INSERT INTO medication (id, person_id, medicine_id, version, origin, vmp_id, product_name,
         route_code, route_name, directions, pattern_kind, prescriber, starts_at, source_kind,
         source_reference, transcribed_by, transcribed_at)
       VALUES ($1, $2, $1, 1, 'transcribed', '90000011000001104', 'Paracetamol 500mg tablets',
         '26643006', 'Oral', 'regular', 'every_day', 'Dr A Example', now(), 'prescription',
         'Prescription', $3, now())`,
      [ENTRY, a.personBen, a.manager],
    );
    await c.query(
      `INSERT INTO medication_administration (id, person_id, medication_id, due_at, outcome,
         quantity, unit_code, given_at, recorded_by)
       VALUES ($1, $2, $3, $4, 'given', 2, '428673006', $4, $5)`,
      [STANDING, a.personBen, ENTRY, DUE, a.manager],
    );
    await c.query(
      `INSERT INTO medication_administration_conflict (id, person_id, client_record_id,
         medication_id, due_at, standing_id, uploaded, uploaded_by)
       VALUES ($1, $2, $3, $4, $5, $6, '{"outcome": "given"}'::jsonb, $7)`,
      [CONFLICT, a.personBen, randomUUID(), ENTRY, DUE, STANDING, a.carer],
    );
  });
});

afterAll(async () => {
  await db?.drop();
});

const visible = (context: ReturnType<typeof ctx>) =>
  inContext(app(), context, async (c) =>
    (
      await c.query<{ id: string }>("SELECT id::text FROM medication_administration_conflict")
    ).rows.map((r) => r.id),
  );

describe("hazard HZ-011 a conflict follows the person's scope", () => {
  it("shows another tenant nothing, and a care worker only their own people's", async () => {
    expect(await visible(ctx(TENANT_B, ids.b.manager, "tenant"))).toEqual([]);
    expect(await visible(manager)).toEqual([CONFLICT]);
    expect(await visible(carer)).toEqual([]);
  });
});

describe("hazard HZ-004 a second record is kept as sent and resolved once", () => {
  it("never changes what it holds, needs a reason and a correction when corrected, and resolves once", async () => {
    expect(
      await refused(
        manager,
        `UPDATE medication_administration_conflict SET uploaded = '{}'::jsonb WHERE id = $1`,
        [CONFLICT],
      ),
    ).toBe("23514");
    const resolve = (resolution: string, note: string | null, correction: string | null) =>
      refused(
        manager,
        `UPDATE medication_administration_conflict SET resolved_by = $1, resolved_at = now(),
           resolution = $2, resolution_note = $3, correction_id = $4 WHERE id = $5`,
        [a.manager, resolution, note, correction, CONFLICT],
      );
    expect(await resolve("first_stands", null, null)).toBe("23514");
    expect(await resolve("corrected", "Both were given", null)).toBe("23514");
    expect(await resolve("first_stands", "The same dose, sent twice", null)).toBeNull();
    expect(await resolve("first_stands", "Again", null)).toBe("23514");
    expect(
      await refused(manager, "DELETE FROM medication_administration_conflict WHERE id = $1", [
        CONFLICT,
      ]),
    ).toBe("42501");
  });
});
