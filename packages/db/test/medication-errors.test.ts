import type pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  MEDICATION_ERROR_KIND_SQL,
  MEDICATION_ERROR_STAGE_SQL,
  REVIEWER_ROLE_SQL,
} from "../src/schema/medicines-errors";
import { createTestDatabase, type TestDatabase } from "./support/database";
import { ctx, ids, inContext, seedTwoTenants, TENANT_A, TENANT_B } from "./support/fixtures";

/**
 * Medication errors and reviews in the database (Phase 2 slice 45; MEDS-012, MEDS-013; migration
 * 0135): another tenant sees and writes nothing; both tables follow the person's scope, and an
 * error its incident's too; an error is only on a medication incident, about one of its people,
 * with that person's medicine and dose record; a done review changes only with a new reason; the
 * code lists match the domain's.
 *
 * Fixture: Ada and Ben live at North (the care worker is assigned to Ada only), Cara at South.
 */

let db: TestDatabase;
const a = ids.a;

const ADA_ENTRY = "0193a000-0000-7000-8000-00000000e101";
const BEN_ENTRY = "0193a000-0000-7000-8000-00000000e201";
const ADA_DOSE = "0193a000-0000-7000-8000-00000000e401";
const BEN_DOSE = "0193a000-0000-7000-8000-00000000e402";
const MED_INCIDENT = "0193a000-0000-7000-8000-00000000e501";
const FALL_INCIDENT = "0193a000-0000-7000-8000-00000000e502";
const CARA_INCIDENT = "0193a000-0000-7000-8000-00000000e503";
const ADA_ERROR = "0193a000-0000-7000-8000-00000000e601";
const ADA_REVIEW = "0193a000-0000-7000-8000-00000000e701";
const CARA_REVIEW = "0193a000-0000-7000-8000-00000000e702";

const app = () => db.pool("harbour_app");
const manager = ctx(TENANT_A, a.manager, "tenant");
const carer = ctx(TENANT_A, a.carer, "assigned");
const north = ctx(TENANT_A, a.northManager, "locations", [a.locationNorth]);

async function entry(c: pg.PoolClient, id: string, personId: string) {
  await c.query(
    `INSERT INTO medication (id, person_id, medicine_id, version, origin, vmp_id, product_name,
       route_code, route_name, directions, pattern_kind, prescriber, starts_at, source_kind,
       source_reference, transcribed_by, transcribed_at)
     VALUES ($1, $2, $1, 1, 'transcribed', '90000011000001104', 'Paracetamol 500mg tablets',
       '26643006', 'Oral', 'regular', 'every_day', 'Dr A Example', now(), 'prescription',
       'Prescription, 01/11/2026', $3, now())`,
    [id, personId, a.manager],
  );
  await c.query(
    `INSERT INTO medication_schedule (medication_id, person_id, position, time, dose_kind, quantity,
       unit_code, unit_name)
     VALUES ($1, $2, 0, '08:00', 'amount', 2, '428673006', 'tablet')`,
    [id, personId],
  );
}

const dose = (c: pg.PoolClient, id: string, personId: string, entryId: string) =>
  c.query(
    `INSERT INTO medication_administration (id, person_id, medication_id, due_at, outcome, quantity,
       unit_code, given_at, recorded_by)
     VALUES ($1, $2, $3, '2026-11-02T08:00:00Z', 'given', 2, '428673006', '2026-11-02T08:05:00Z', $4)`,
    [id, personId, entryId, a.manager],
  );

const incident = (
  c: pg.PoolClient,
  id: string,
  locationId: string,
  type: string,
  people: readonly string[],
) =>
  c.query(
    `INSERT INTO incident (id, location_id, type, occurred_at, description, raised_by, person_ids)
     VALUES ($1, $2, $3, now() - interval '1 hour', 'Fixture incident', $4, $5)`,
    [id, locationId, type, a.manager, people],
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
      await c.query("RELEASE SAVEPOINT s");
      return null;
    } catch (error) {
      await c.query("ROLLBACK TO SAVEPOINT s");
      return (error as { message?: string }).message ?? "error";
    }
  });
}

const insertError = (
  id: string,
  incidentId: string,
  personId: string,
  extra: { medicationId?: string | null; administrationId?: string | null } = {},
) =>
  [
    `INSERT INTO medication_error (id, incident_id, person_id, medication_id, administration_id, kinds,
     stage, reached_person)
   VALUES ($1, $2, $3, $4, $5, ARRAY['wrong_time'], 'administration', 'no')`,
    [id, incidentId, personId, extra.medicationId ?? null, extra.administrationId ?? null],
  ] as const;

beforeAll(async () => {
  db = await createTestDatabase();
  await seedTwoTenants(db.pool("harbour_owner"));
  await inContext(app(), manager, async (c) => {
    await entry(c, ADA_ENTRY, a.personAda);
    await entry(c, BEN_ENTRY, a.personBen);
    await dose(c, ADA_DOSE, a.personAda, ADA_ENTRY);
    await dose(c, BEN_DOSE, a.personBen, BEN_ENTRY);
    await incident(c, MED_INCIDENT, a.locationNorth, "medication", [a.personAda, a.personBen]);
    await incident(c, FALL_INCIDENT, a.locationNorth, "fall", [a.personAda]);
    await incident(c, CARA_INCIDENT, a.locationSouth, "medication", [a.personCara]);
    const [sql, params] = insertError(ADA_ERROR, MED_INCIDENT, a.personAda, {
      medicationId: ADA_ENTRY,
      administrationId: ADA_DOSE,
    });
    await c.query(sql, [...params]);
    await c.query(
      `INSERT INTO medication_review (id, person_id, due_on) VALUES ($1, $2, '2026-12-01'),
         ($3, $4, '2026-12-01')`,
      [ADA_REVIEW, a.personAda, CARA_REVIEW, a.personCara],
    );
  });
});

afterAll(async () => {
  await db?.drop();
});

describe("hazard HZ-131 medication errors and reviews are isolated and follow scope (slice 45)", () => {
  it("shows another tenant nothing", async () => {
    for (const table of ["medication_error", "medication_review"]) {
      expect(await visible(ctx(TENANT_B, ids.b.manager, "tenant"), table)).toEqual([]);
    }
  });

  it("refuses another tenant writing an error or a review for this tenant's person", async () => {
    const other = ctx(TENANT_B, ids.b.manager, "tenant");
    expect(
      await refused(
        other,
        `INSERT INTO medication_review (tenant_id, person_id, due_on) VALUES ($1, $2, '2026-12-01')`,
        [TENANT_A, a.personAda],
      ),
    ).not.toBeNull();
    expect(
      await refused(
        other,
        `INSERT INTO medication_error (tenant_id, incident_id, person_id) VALUES ($1, $2, $3)`,
        [TENANT_A, MED_INCIDENT, a.personBen],
      ),
    ).not.toBeNull();
  });

  it("shows reviews only for people in scope: North sees Ada, not Cara", async () => {
    expect(await visible(north, "medication_review")).toEqual([ADA_REVIEW]);
    expect(await visible(manager, "medication_review")).toEqual([ADA_REVIEW, CARA_REVIEW].sort());
  });

  it("shows an error only to those who see its incident and its person", async () => {
    expect(await visible(manager, "medication_error")).toEqual([ADA_ERROR]);
    expect(await visible(north, "medication_error")).toEqual([ADA_ERROR]);
  });

  it("allows no delete", async () => {
    expect(await refused(manager, "DELETE FROM medication_error")).toMatch(/permission denied/);
    expect(await refused(manager, "DELETE FROM medication_review")).toMatch(/permission denied/);
  });
});

describe("hazard HZ-131 an error belongs to a medication incident and one of its people", () => {
  it("refuses an error on an incident that is not about medication", async () => {
    const [sql, params] = insertError(crypto.randomUUID(), FALL_INCIDENT, a.personAda);
    expect(await refused(manager, sql, [...params])).toMatch(/medication_error_not_on_incident/);
  });

  it("refuses an error about someone not on the incident", async () => {
    const [sql, params] = insertError(crypto.randomUUID(), CARA_INCIDENT, a.personAda);
    expect(await refused(manager, sql, [...params])).not.toBeNull();
  });

  it("refuses a second error on one incident", async () => {
    const [sql, params] = insertError(crypto.randomUUID(), MED_INCIDENT, a.personBen);
    expect(await refused(manager, sql, [...params])).toMatch(/medication_error_incident_key/);
  });

  it("refuses another person's medicine or dose record", async () => {
    await inContext(app(), manager, (c) =>
      c.query(
        "UPDATE medication_error SET medication_id = NULL, administration_id = NULL WHERE id = $1",
        [ADA_ERROR],
      ),
    );
    expect(
      await refused(manager, "UPDATE medication_error SET medication_id = $1 WHERE id = $2", [
        BEN_ENTRY,
        ADA_ERROR,
      ]),
    ).toMatch(/medication_error_medication_fk/);
    expect(
      await refused(manager, "UPDATE medication_error SET administration_id = $1 WHERE id = $2", [
        BEN_DOSE,
        ADA_ERROR,
      ]),
    ).toMatch(/medication_error_administration_fk/);
  });

  it("never moves an error to another incident or person", async () => {
    expect(
      await refused(manager, "UPDATE medication_error SET person_id = $1 WHERE id = $2", [
        a.personBen,
        ADA_ERROR,
      ]),
    ).toMatch(/medication_error_fixed_fields/);
  });

  it("refuses a controlled drug report on an error with no controlled drug, or half a report", async () => {
    expect(
      await refused(
        manager,
        "UPDATE medication_error SET controlled_drug = 'no', cd_reported_on = '2026-11-01', cd_report_reference = 'CD-1' WHERE id = $1",
        [ADA_ERROR],
      ),
    ).toMatch(/medication_error_cd_report/);
    expect(
      await refused(
        manager,
        "UPDATE medication_error SET controlled_drug = 'yes', cd_reported_on = '2026-11-01' WHERE id = $1",
        [ADA_ERROR],
      ),
    ).toMatch(/medication_error_cd_report/);
  });

  it("refuses a kind or stage not on the list", async () => {
    expect(
      await refused(manager, "UPDATE medication_error SET kinds = ARRAY['made_up'] WHERE id = $1", [
        ADA_ERROR,
      ]),
    ).toMatch(/medication_error_kinds/);
    expect(
      await refused(manager, "UPDATE medication_error SET stage = 'made_up' WHERE id = $1", [
        ADA_ERROR,
      ]),
    ).toMatch(/medication_error_stage/);
  });

  it("keeps the change history", async () => {
    await inContext(app(), manager, (c) =>
      c.query("UPDATE medication_error SET root_cause = 'Two charts in use' WHERE id = $1", [
        ADA_ERROR,
      ]),
    );
    const rows = await inContext(app(), manager, (c) =>
      c.query(
        "SELECT 1 FROM record_version WHERE table_name = 'medication_error' AND record_id = $1",
        [ADA_ERROR],
      ),
    );
    expect(rows.rowCount).toBeGreaterThan(0);
  });
});

describe("hazard HZ-131 a done review is fixed unless corrected with a reason", () => {
  it("records a review as done, then refuses a change without a new reason", async () => {
    await inContext(app(), manager, (c) =>
      c.query(
        `UPDATE medication_review SET done_on = '2026-11-01', clinician_name = 'Dr Ada Example',
           clinician_role = 'gp', outcome = 'No changes.', recorded_by = $2 WHERE id = $1`,
        [ADA_REVIEW, a.manager],
      ),
    );
    expect(
      await refused(manager, "UPDATE medication_review SET outcome = 'Stop it' WHERE id = $1", [
        ADA_REVIEW,
      ]),
    ).toMatch(/medication_review_done_needs_reason/);
    expect(
      await refused(
        manager,
        "UPDATE medication_review SET outcome = 'No changes; recheck in March.', correction_reason = 'Outcome typed in part' WHERE id = $1",
        [ADA_REVIEW],
      ),
    ).toBeNull();
  });

  it("refuses half a done record", async () => {
    expect(
      await refused(manager, "UPDATE medication_review SET done_on = '2026-11-01' WHERE id = $1", [
        CARA_REVIEW,
      ]),
    ).toMatch(/medication_review_done/);
  });

  it("refuses a carer outside Cara's scope recording her review", async () => {
    expect(await visible(carer, "medication_review")).not.toContain(CARA_REVIEW);
  });
});

describe("the code lists match the domain", () => {
  it("has the domain's error kinds, stages and reviewer roles", async () => {
    const domain = await import("@harbour/domain");
    const list = (s: string) => s.replaceAll("'", "").split(",");
    expect(list(MEDICATION_ERROR_KIND_SQL)).toEqual([...domain.MEDICATION_ERROR_KINDS]);
    expect(list(MEDICATION_ERROR_STAGE_SQL)).toEqual([...domain.MEDICATION_ERROR_STAGES]);
    expect(list(REVIEWER_ROLE_SQL)).toEqual([...domain.REVIEWER_ROLES]);
  });
});
