import type pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createTestDatabase, type TestDatabase } from "./support/database";
import { ctx, ids, inContext, seedTwoTenants, TENANT_A, TENANT_B } from "./support/fixtures";

/**
 * Administrations in the database (Phase 2 slice 22; MEDS-002; migration 0123): another tenant
 * sees and writes nothing and every table follows the person's scope; an administration and its
 * witness are append-only; one original record per scheduled dose and one correction per record;
 * a correction stays with its record's person, entry and dose; the server's clock is the record's;
 * the witness is never the recorder; a dosing record never changes and its check is set once; rule
 * 13's tags, interval and maximum are fixed on a version.
 *
 * Fixture: Ada and Ben live at North (the care worker is assigned to Ada only), Cara at South.
 * dm+d identifiers are invented, with the SNOMED CT shape.
 */

let db: TestDatabase;
const a = ids.a;

const ADA_ENTRY = "0193a000-0000-7000-8000-00000000f101";
const ADA_VARIABLE = "0193a000-0000-7000-8000-00000000f102";
const BEN_ENTRY = "0193a000-0000-7000-8000-00000000f201";
const CARA_ENTRY = "0193a000-0000-7000-8000-00000000f301";
const ADA_DOSE = "0193a000-0000-7000-8000-00000000f401";
const BEN_DOSE = "0193a000-0000-7000-8000-00000000f402";
const CARA_DOSE = "0193a000-0000-7000-8000-00000000f403";
const DOSING = "0193a000-0000-7000-8000-00000000f501";
const DUE = "2026-11-02T08:00:00Z";

const app = () => db.pool("harbour_app");
const manager = ctx(TENANT_A, a.manager, "tenant");
const carer = ctx(TENANT_A, a.carer, "assigned");
const north = ctx(TENANT_A, a.northManager, "locations", [a.locationNorth]);

async function entry(c: pg.PoolClient, id: string, personId: string, vmp = "90000011000001104") {
  await c.query(
    `INSERT INTO medication (id, person_id, medicine_id, version, origin, vmp_id, product_name,
       route_code, route_name, directions, pattern_kind, prescriber, starts_at, source_kind,
       source_reference, transcribed_by, transcribed_at, tags)
     VALUES ($1, $2, $1, 1, 'transcribed', $3, 'Paracetamol 500mg tablets', '26643006', 'Oral',
       'regular', 'every_day', 'Dr A Example', now(), 'prescription', 'Prescription, 01/11/2026',
       $4, now(), ARRAY['paracetamol'])`,
    [id, personId, vmp, a.manager],
  );
  await c.query(
    `INSERT INTO medication_schedule (medication_id, person_id, position, time, dose_kind, quantity,
       unit_code, unit_name)
     VALUES ($1, $2, 0, '08:00', 'amount', 2, '428673006', 'tablet')`,
    [id, personId],
  );
}

const insertDose = (
  c: pg.PoolClient,
  id: string,
  personId: string,
  entryId: string,
  extra: { supersedes?: string; reason?: string; dueAt?: string | null } = {},
) =>
  c.query(
    `INSERT INTO medication_administration (id, person_id, medication_id, due_at, outcome, quantity,
       unit_code, given_at, recorded_by, supersedes_id, correction_reason)
     VALUES ($1, $2, $3, $4, 'given', 2, '428673006', $5, $6, $7, $8)`,
    [
      id,
      personId,
      entryId,
      extra.dueAt === undefined ? DUE : extra.dueAt,
      DUE,
      a.manager,
      extra.supersedes ?? null,
      extra.reason ?? null,
    ],
  );

async function visible(context: ReturnType<typeof ctx>, table: string): Promise<string[]> {
  return inContext(app(), context, async (c) => {
    const result = await c.query<{ id: string }>(`SELECT id::text FROM ${table}`);
    return result.rows.map((r) => r.id).sort();
  });
}

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
  await inContext(app(), manager, async (c) => {
    await entry(c, ADA_ENTRY, a.personAda);
    await entry(c, BEN_ENTRY, a.personBen);
    await entry(c, CARA_ENTRY, a.personCara);
    await c.query(
      `INSERT INTO medication (id, person_id, medicine_id, version, origin, vmp_id, product_name,
         route_code, route_name, directions, pattern_kind, prescriber, starts_at, source_kind,
         source_reference, transcribed_by, transcribed_at)
       VALUES ($1, $2, $1, 1, 'transcribed', '90000071000001107', 'Warfarin 1mg tablets',
         '26643006', 'Oral', 'regular', 'every_day', 'Dr A Example', now(), 'prescription',
         'Anticoagulant clinic', $3, now())`,
      [ADA_VARIABLE, a.personAda, a.manager],
    );
    await c.query(
      `INSERT INTO medication_schedule (medication_id, person_id, position, time, dose_kind,
         unit_code, unit_name)
       VALUES ($1, $2, 0, '18:00', 'variable', '428673006', 'tablet')`,
      [ADA_VARIABLE, a.personAda],
    );
    await insertDose(c, ADA_DOSE, a.personAda, ADA_ENTRY);
    await insertDose(c, BEN_DOSE, a.personBen, BEN_ENTRY);
    await insertDose(c, CARA_DOSE, a.personCara, CARA_ENTRY);
    await c.query(
      `INSERT INTO medication_dosing_record (id, person_id, medication_id, source_kind,
         source_reference, doses, recorded_by)
       VALUES ($1, $2, $3, 'clinic_letter', 'Anticoagulant clinic, 01/11/2026',
         '[{"date": "2026-11-02", "time": "18:00", "quantity": 3}]'::jsonb, $4)`,
      [DOSING, a.personAda, ADA_VARIABLE, a.manager],
    );
  });
});

afterAll(async () => {
  await db?.drop();
});

const TABLES = [
  "medication_administration",
  "medication_dosing_record",
  "medication_administration_witness",
];

describe("hazard HZ-011 administrations are isolated by tenant and follow the person's scope", () => {
  it("shows another tenant nothing, in any administrations table", async () => {
    for (const table of TABLES) {
      expect(await visible(ctx(TENANT_B, ids.b.manager, "tenant"), table)).toEqual([]);
    }
  });

  it("refuses another tenant writing an administration for this tenant's person", async () => {
    expect(
      await refused(
        ctx(TENANT_B, ids.b.manager, "tenant"),
        `INSERT INTO medication_administration (id, tenant_id, person_id, medication_id, outcome,
           given_at, recorded_by)
         VALUES (gen_random_uuid(), $1, $2, $3, 'refused', now(), $4)`,
        [TENANT_A, a.personAda, ADA_ENTRY, ids.b.manager],
      ),
    ).not.toBeNull();
  });

  it("shows a care worker only their people's records, a location role its own", async () => {
    expect(await visible(manager, "medication_administration")).toEqual(
      [ADA_DOSE, BEN_DOSE, CARA_DOSE].sort(),
    );
    expect(await visible(carer, "medication_administration")).toEqual([ADA_DOSE]);
    expect(await visible(north, "medication_administration")).toEqual([ADA_DOSE, BEN_DOSE].sort());
    expect(await visible(carer, "medication_dosing_record")).toEqual([DOSING]);
  });

  it("refuses recording a dose for a person outside the member's scope", async () => {
    expect(
      await refused(
        carer,
        `INSERT INTO medication_administration (id, person_id, medication_id, outcome, given_at,
           recorded_by)
         VALUES (gen_random_uuid(), $1, $2, 'refused', now(), $3)`,
        [a.personBen, BEN_ENTRY, a.carer],
      ),
    ).not.toBeNull();
  });
});

describe("hazard HZ-001 an administration is tied to one person", () => {
  it("refuses a record whose entry, or the record it corrects, is another person's", async () => {
    expect(
      await refused(
        manager,
        `INSERT INTO medication_administration (id, person_id, medication_id, outcome, given_at,
           recorded_by)
         VALUES (gen_random_uuid(), $1, $2, 'refused', now(), $3)`,
        [a.personAda, BEN_ENTRY, a.manager],
      ),
    ).toBe("23503");
    expect(
      await refused(
        manager,
        `INSERT INTO medication_administration (id, person_id, medication_id, due_at, outcome,
           quantity, unit_code, given_at, recorded_by, supersedes_id, correction_reason)
         VALUES (gen_random_uuid(), $1, $2, $3, 'given', 2, '428673006', now(), $4, $5, 'Wrong')`,
        [a.personAda, ADA_ENTRY, DUE, a.manager, BEN_DOSE],
      ),
      // The insert trigger refuses it before the composite key would.
    ).toMatch(/^(23503|23514)$/);
  });
});

describe("hazard HZ-004 one record per dose, and a record never changes", () => {
  it("never updates or deletes an administration or a witness for the application", async () => {
    expect(
      await refused(
        manager,
        "UPDATE medication_administration SET outcome = 'refused' WHERE id = $1",
        [ADA_DOSE],
      ),
    ).toBe("42501");
    expect(
      await refused(manager, "DELETE FROM medication_administration WHERE id = $1", [ADA_DOSE]),
    ).toBe("42501");
  });

  it("keeps one original record per scheduled dose, and one correction per record", async () => {
    expect(
      await refused(
        manager,
        `INSERT INTO medication_administration (id, person_id, medication_id, due_at, outcome,
           given_at, recorded_by)
         VALUES (gen_random_uuid(), $1, $2, $3, 'refused', now(), $4)`,
        [a.personAda, ADA_ENTRY, DUE, a.manager],
      ),
    ).toBe("23505");
    const first = "0193a000-0000-7000-8000-00000000f601";
    expect(
      await inContext(app(), manager, async (c) => {
        await insertDose(c, first, a.personAda, ADA_ENTRY, {
          supersedes: ADA_DOSE,
          reason: "Recorded against the wrong time",
        });
        return "ok";
      }),
    ).toBe("ok");
    expect(
      await refused(
        manager,
        `INSERT INTO medication_administration (id, person_id, medication_id, due_at, outcome,
           given_at, recorded_by, supersedes_id, correction_reason)
         VALUES (gen_random_uuid(), $1, $2, $3, 'refused', now(), $4, $5, 'Again')`,
        [a.personAda, ADA_ENTRY, DUE, a.manager, ADA_DOSE],
      ),
    ).toBe("23505");
  });

  it("refuses a correction that moves to another dose or entry, or has no reason", async () => {
    const move = (dueAt: string | null, entryId: string, reason: string | null) =>
      refused(
        manager,
        `INSERT INTO medication_administration (id, person_id, medication_id, due_at, outcome,
           given_at, recorded_by, supersedes_id, correction_reason)
         VALUES (gen_random_uuid(), $1, $2, $3, 'refused', now(), $4, $5, $6)`,
        [a.personAda, entryId, dueAt, a.manager, "0193a000-0000-7000-8000-00000000f601", reason],
      );
    expect(await move("2026-11-03T08:00:00Z", ADA_ENTRY, "Wrong day")).toBe("23514");
    expect(await move(DUE, ADA_VARIABLE, "Wrong medicine")).toBe("23514");
    expect(await move(DUE, ADA_ENTRY, null)).toBe("23514");
  });

  it("stores the server's time, and a dose given before it was recorded only with an earlier time", async () => {
    const id = "0193a000-0000-7000-8000-00000000f602";
    const stored = await inContext(app(), manager, async (c) => {
      await c.query(
        `INSERT INTO medication_administration (id, person_id, medication_id, outcome, reason_code,
           given_at, recorded_by, recorded_at)
         VALUES ($1, $2, $3, 'omitted', 'asleep', now(), $4, '2001-01-01T00:00:00Z')`,
        [id, a.personBen, BEN_ENTRY, a.manager],
      );
      const { rows } = await c.query<{ server: boolean }>(
        "SELECT recorded_at > now() - interval '1 minute' AS server FROM medication_administration WHERE id = $1",
        [id],
      );
      return rows[0]?.server;
    });
    expect(stored).toBe(true);
    expect(
      await refused(
        manager,
        `INSERT INTO medication_administration (id, person_id, medication_id, outcome, quantity,
           unit_code, given_at, recorded_by, given_before_recorded_reason)
         VALUES (gen_random_uuid(), $1, $2, 'given', 2, '428673006', now() + interval '1 hour',
           $3, 'Given in an emergency')`,
        [a.personBen, BEN_ENTRY, a.manager],
      ),
    ).toBe("23514");
  });
});

describe("hazard HZ-116 a second signature is a second person", () => {
  it("refuses the recorder or the giver as the witness, and takes another member once", async () => {
    const witness = (member: string) =>
      refused(
        manager,
        `INSERT INTO medication_administration_witness (person_id, administration_id, witness_id,
           method)
         VALUES ($1, $2, $3, 'step_up')`,
        [a.personBen, BEN_DOSE, member],
      );
    expect(await witness(a.manager)).toBe("23514");
    // Nor the member who gave it, when someone else recorded it.
    const given = "0193a000-0000-7000-8000-00000000f603";
    await inContext(app(), manager, async (c) => {
      await c.query(
        `INSERT INTO medication_administration (id, person_id, medication_id, outcome, reason_code,
           given_at, recorded_by, administered_by)
         VALUES ($1, $2, $3, 'refused', 'declined', now(), $4, $5)`,
        [given, a.personBen, BEN_ENTRY, a.manager, a.northManager],
      );
    });
    expect(
      await refused(
        manager,
        `INSERT INTO medication_administration_witness (person_id, administration_id, witness_id,
           method)
         VALUES ($1, $2, $3, 'step_up')`,
        [a.personBen, given, a.northManager],
      ),
    ).toBe("23514");
    expect(await witness(a.carer)).toBeNull();
    expect(await witness(a.northManager)).toBe("23505");
  });
});

describe("hazard HZ-005 a dosing record says what its source says", () => {
  it("never changes what it says, sets its check once, and never by the recorder", async () => {
    expect(
      await refused(
        manager,
        `UPDATE medication_dosing_record SET doses = '[{"date": "2026-11-02", "time": "18:00", "quantity": 4}]'::jsonb
          WHERE id = $1`,
        [DOSING],
      ),
    ).toBe("23514");
    const check = (by: string) =>
      refused(
        manager,
        `UPDATE medication_dosing_record SET check_by = $1, check_at = now(),
           check_outcome = 'matches_source' WHERE id = $2`,
        [by, DOSING],
      );
    expect(await check(a.manager)).toBe("23514");
    expect(await check(a.carer)).toBeNull();
    expect(await check(a.northManager)).toBe("23514");
    expect(
      await refused(manager, "DELETE FROM medication_dosing_record WHERE id = $1", [DOSING]),
    ).toBe("42501");
  });
});

describe("hazard HZ-004 rule 13's tags, interval and maximum are fixed on a version", () => {
  it("refuses changing them, and a maximum on a regular entry", async () => {
    expect(
      await refused(manager, "UPDATE medication SET tags = '{}' WHERE id = $1", [ADA_ENTRY]),
    ).toBe("23514");
    expect(
      await refused(manager, "UPDATE medication SET minimum_interval_minutes = 240 WHERE id = $1", [
        ADA_ENTRY,
      ]),
    ).toBe("23514");
    expect(
      await refused(
        manager,
        `INSERT INTO medication (person_id, medicine_id, version, origin, vmp_id, product_name,
           route_code, route_name, directions, pattern_kind, prescriber, starts_at, source_kind,
           source_reference, transcribed_by, transcribed_at, prn_max_per_24h, id)
         SELECT $1, $3, 1, 'transcribed', '90000041000001103', 'X', '1', 'Oral', 'regular',
           'every_day', 'Dr A Example', now(), 'prescription', 'ref', $2, now(), 8, $3`,
        [a.personBen, a.manager, "0193a000-0000-7000-8000-00000000f701"],
      ),
    ).toBe("23514");
  });
});
