import type pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createTestDatabase, type TestDatabase } from "./support/database";
import { ctx, ids, inContext, seedTwoTenants, TENANT_A, TENANT_B } from "./support/fixtures";

/**
 * The medicines record in the database (Phase 2 slice 16; MEDS-001; migration 0111): another
 * tenant sees and writes nothing, every table follows the person's scope, what a version says
 * never changes, the check, stop, replacement and withdrawal are set once each, a new version
 * follows the one before it for the same product, a schedule's times are written with their
 * entry, nothing is deleted by the application, and a completed reconciliation is frozen.
 *
 * Fixture: Ada and Ben live at North (the care worker is assigned to Ada only), Cara at South.
 * dm+d identifiers are invented, with the SNOMED CT shape; the check digit is the API's (isDmdId).
 */

let db: TestDatabase;
const a = ids.a;

const VMP = "90000011000001104";
const OTHER_VMP = "90000041000001103";
const ADA_V1 = "0193a000-0000-7000-8000-00000000e101";
const ADA_V2 = "0193a000-0000-7000-8000-00000000e102";
const BEN_V1 = "0193a000-0000-7000-8000-00000000e201";
const CARA_V1 = "0193a000-0000-7000-8000-00000000e301";
const REC_ADA = "0193a000-0000-7000-8000-00000000e401";

const app = () => db.pool("harbour_app");
const manager = ctx(TENANT_A, a.manager, "tenant");
const carer = ctx(TENANT_A, a.carer, "assigned");
const north = ctx(TENANT_A, a.northManager, "locations", [a.locationNorth]);

async function entry(
  c: pg.PoolClient,
  id: string,
  personId: string,
  extra: { version?: number; medicineId?: string; replacesId?: string | null; vmp?: string } = {},
) {
  const version = extra.version ?? 1;
  await c.query(
    `INSERT INTO medication (id, person_id, medicine_id, version, replaces_id, origin, vmp_id,
       product_name, route_code, route_name, directions, pattern_kind, prescriber, starts_at,
       source_kind, source_reference, transcribed_by, transcribed_at)
     VALUES ($1, $2, $3, $4, $5, 'transcribed', $6, 'Paracetamol 500mg tablets', '26643006',
       'Oral', 'regular', 'every_day', 'Dr A Example', now(), 'prescription',
       'Prescription, 01/11/2026', $7, now())`,
    [
      id,
      personId,
      extra.medicineId ?? id,
      version,
      extra.replacesId ?? null,
      extra.vmp ?? VMP,
      a.manager,
    ],
  );
  await c.query(
    `INSERT INTO medication_schedule (medication_id, person_id, position, time, dose_kind, quantity,
       unit_code, unit_name)
     VALUES ($1, $2, 0, '08:00', 'amount', 2, '428673006', 'tablet')`,
    [id, personId],
  );
}

beforeAll(async () => {
  db = await createTestDatabase();
  await seedTwoTenants(db.pool("harbour_owner"));
  await inContext(app(), manager, async (c) => {
    await entry(c, ADA_V1, a.personAda);
    await entry(c, BEN_V1, a.personBen);
    await entry(c, CARA_V1, a.personCara);
    await c.query(
      `INSERT INTO medication_reconciliation (id, person_id, trigger, triggered_at, started_by,
         started_at, entries_at_start)
       VALUES ($1, $2, 'change', now(), $3, now(), '[]'::jsonb)`,
      [REC_ADA, a.personAda, a.manager],
    );
  });
});

afterAll(async () => {
  await db?.drop();
});

async function visible(context: ReturnType<typeof ctx>, table = "medication"): Promise<string[]> {
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

describe("hazard HZ-011 the medicines record is isolated by tenant and follows the person's scope", () => {
  it("shows another tenant nothing, in any medicines table", async () => {
    for (const table of [
      "medication",
      "medication_schedule",
      "medication_reconciliation",
      "medication_reconciliation_source",
      "medication_reconciliation_item",
      "medication_reconciliation_decision",
    ]) {
      expect(await visible(ctx(TENANT_B, ids.b.manager, "tenant"), table)).toEqual([]);
    }
  });

  it("refuses another tenant writing to one of this tenant's people", async () => {
    expect(
      await refused(
        ctx(TENANT_B, ids.b.manager, "tenant"),
        `UPDATE medication SET check_by = $1, check_at = now(), check_outcome = 'matches_source',
           state = 'checked' WHERE id = $2 RETURNING id`,
        [ids.b.manager, ADA_V1],
      ),
    ).toBeNull();
    const [row] = await inContext(
      app(),
      manager,
      async (c) => (await c.query("SELECT check_at FROM medication WHERE id = $1", [ADA_V1])).rows,
    );
    expect(row?.check_at).toBeNull();
  });

  it("shows tenant-wide roles every entry, a care worker only their people's, a location role its own", async () => {
    expect(await visible(manager)).toEqual([ADA_V1, BEN_V1, CARA_V1].sort());
    expect(await visible(carer)).toEqual([ADA_V1]);
    expect(await visible(north)).toEqual([ADA_V1, BEN_V1].sort());
    expect(await visible(carer, "medication_schedule")).toHaveLength(1);
  });

  it("refuses recording an entry for a person outside the member's scope", async () => {
    expect(
      await refused(
        north,
        `INSERT INTO medication (person_id, medicine_id, version, origin, vmp_id, product_name,
           route_code, route_name, directions, pattern_kind, prescriber, starts_at, source_kind,
           source_reference, transcribed_by, transcribed_at)
         SELECT $1, gen_random_uuid(), 1, 'transcribed', $2, 'X', '1', 'Oral', 'regular',
           'every_day', 'Dr A Example', now(), 'prescription', 'ref', $3, now()`,
        [a.personCara, VMP, a.northManager],
      ),
    ).toBe("42501");
  });
});

describe("hazard HZ-005 what an entry version says never changes; the rest is set once", () => {
  it("refuses changing the product, dose times or source of a version", async () => {
    expect(
      await refused(manager, "UPDATE medication SET product_name = 'Other' WHERE id = $1", [
        ADA_V1,
      ]),
    ).toBe("23514");
    expect(
      await refused(
        manager,
        "UPDATE medication_schedule SET time = '09:00' WHERE medication_id = $1",
        [ADA_V1],
      ),
    ).toBe("42501");
  });

  it("refuses a second check by the transcriber, and a second check once one is recorded", async () => {
    expect(
      await refused(
        manager,
        `UPDATE medication SET check_by = $1, check_at = now(), check_outcome = 'matches_source',
           state = 'checked' WHERE id = $2`,
        [a.manager, ADA_V1],
      ),
    ).toBe("23514");
    expect(
      await refused(
        manager,
        `UPDATE medication SET check_by = $1, check_at = now(), check_outcome = 'matches_source',
           state = 'checked' WHERE id = $2`,
        [a.northManager, ADA_V1],
      ),
    ).toBeNull();
    expect(
      await refused(
        manager,
        `UPDATE medication SET check_outcome = 'differs_from_source', check_difference = 'x',
           state = 'difference_found' WHERE id = $1`,
        [ADA_V1],
      ),
    ).toBe("23514");
  });

  it("refuses a state that contradicts the recorded check, stop or replacement", async () => {
    expect(
      await refused(manager, "UPDATE medication SET state = 'stopped' WHERE id = $1", [BEN_V1]),
    ).toBe("23514");
  });

  it("replaces a recorded stop only with an earlier one", async () => {
    const stop = (when: string) =>
      refused(
        manager,
        `UPDATE medication SET state = 'stopped', stop_by = $1, stop_at = now(),
           stop_effective_at = now() + $2::interval, stop_reason = 'Stopped by the GP',
           stop_source_kind = 'prescriber_instruction', stop_source_reference = 'GP letter'
         WHERE id = $3`,
        [a.manager, when, CARA_V1],
      );
    expect(await stop("3 days")).toBeNull();
    expect(await stop("5 days")).toBe("23514");
    expect(await stop("1 day")).toBeNull();
  });

  it("never deletes an entry, a time, a source or a line for the application", async () => {
    expect(await refused(manager, "DELETE FROM medication WHERE id = $1", [BEN_V1])).toBe("42501");
    expect(
      await refused(manager, "DELETE FROM medication_schedule WHERE medication_id = $1", [BEN_V1]),
    ).toBe("42501");
    expect(
      await refused(manager, "UPDATE medication SET deleted_at = now() WHERE id = $1", [BEN_V1]),
    ).toBe("42501");
  });
});

describe("hazard HZ-004 a new version follows the one it replaces, for the same product", () => {
  it("takes the next version of the same medicine, and refuses a second from the same version", async () => {
    expect(
      await inContext(app(), manager, async (c) => {
        await entry(c, ADA_V2, a.personAda, { version: 2, medicineId: ADA_V1, replacesId: ADA_V1 });
        return "ok";
      }),
    ).toBe("ok");
    expect(
      await refused(
        manager,
        `INSERT INTO medication (person_id, medicine_id, version, replaces_id, origin, vmp_id,
           product_name, route_code, route_name, directions, pattern_kind, prescriber, starts_at,
           source_kind, source_reference, transcribed_by, transcribed_at)
         VALUES ($1, $2, 2, $2, 'transcribed', $3, 'X', '1', 'Oral', 'regular', 'every_day',
           'Dr A Example', now(), 'prescription', 'ref', $4, now())`,
        [a.personAda, ADA_V1, VMP, a.manager],
      ),
    ).toBe("23514");
  });

  it("refuses a version for another product, and one that skips a number", async () => {
    const insert = (version: number, vmp: string) =>
      refused(
        manager,
        `INSERT INTO medication (person_id, medicine_id, version, replaces_id, origin, vmp_id,
           product_name, route_code, route_name, directions, pattern_kind, prescriber, starts_at,
           source_kind, source_reference, transcribed_by, transcribed_at)
         VALUES ($1, $2, $3, $4, 'transcribed', $5, 'X', '1', 'Oral', 'regular', 'every_day',
           'Dr A Example', now(), 'prescription', 'ref', $6, now())`,
        [a.personAda, ADA_V1, version, ADA_V2, vmp, a.manager],
      );
    expect(await insert(3, OTHER_VMP)).toBe("23514");
    expect(await insert(5, VMP)).toBe("23514");
  });

  it("refuses a new version that arrives already checked", async () => {
    expect(
      await refused(
        manager,
        `INSERT INTO medication (person_id, medicine_id, version, origin, vmp_id, state,
           check_by, check_at, check_outcome, product_name, route_code, route_name, directions,
           pattern_kind, prescriber, starts_at, source_kind, source_reference, transcribed_by,
           transcribed_at)
         SELECT $1, gen_random_uuid(), 1, 'transcribed', $2, 'checked', $3, now(),
           'matches_source', 'X', '1', 'Oral', 'regular', 'every_day', 'Dr A Example', now(),
           'prescription', 'ref', $4, now()`,
        [a.personBen, OTHER_VMP, a.northManager, a.manager],
      ),
    ).not.toBeNull();
  });

  it("writes a schedule's times only with their entry", async () => {
    expect(
      await refused(
        manager,
        `INSERT INTO medication_schedule (medication_id, person_id, position, time, dose_kind,
           quantity, unit_code, unit_name)
         VALUES ($1, $2, 1, '20:00', 'amount', 1, '428673006', 'tablet')`,
        [BEN_V1, a.personBen],
      ),
    ).toBe("23514");
  });

  it("refuses a dose with a range the wrong way round, or a time that is not HH:MM", async () => {
    const time = (t: string, kind: string, q: string) =>
      inContext(app(), manager, async (c) => {
        await c.query("SAVEPOINT s");
        try {
          await entry(c, crypto.randomUUID(), a.personBen, { vmp: OTHER_VMP });
          await c.query(
            `INSERT INTO medication_schedule (medication_id, person_id, position, time, dose_kind,
               quantity, from_quantity, to_quantity, unit_code, unit_name)
             SELECT id, person_id, 5, $1, $2, ${q}, '428673006', 'tablet'
               FROM medication WHERE vmp_id = $3 AND person_id = $4`,
            [t, kind, OTHER_VMP, a.personBen],
          );
          return null;
        } catch (error) {
          return (error as { code?: string }).code;
        } finally {
          await c.query("ROLLBACK TO SAVEPOINT s");
        }
      });
    expect(await time("8:00", "amount", "1, NULL, NULL")).toBe("23514");
    expect(await time("09:00", "range", "NULL, 2, 1")).toBe("23514");
  });
});

describe("hazard HZ-004 a withdrawn version gives the medicine back to the one before it", () => {
  // v1 is replaced by v2; v2 was transcribed in error and is withdrawn; v3 then replaces v1.
  const W1 = "0193a000-0000-7000-8000-00000000e311";
  const W2 = "0193a000-0000-7000-8000-00000000e312";
  const W3 = "0193a000-0000-7000-8000-00000000e313";
  const FROM = "2026-11-02T08:00:00Z";
  const replace = (by: string, from = FROM) =>
    refused(
      manager,
      `UPDATE medication SET state = 'replaced', replaced_by_id = $1, replaced_from = $2
        WHERE id = $3`,
      [by, from, W1],
    );

  it("moves the replacement to a new version once the version it named is withdrawn", async () => {
    await inContext(app(), manager, async (c) => {
      await entry(c, W1, a.personCara, { vmp: OTHER_VMP });
      await entry(c, W2, a.personCara, {
        version: 2,
        medicineId: W1,
        replacesId: W1,
        vmp: OTHER_VMP,
      });
    });
    expect(await replace(W2)).toBeNull();
    await inContext(app(), manager, async (c) => {
      await entry(c, W3, a.personCara, {
        version: 3,
        medicineId: W1,
        replacesId: W1,
        vmp: OTHER_VMP,
      });
    });
    // Not while v2 stands: a replacement is recorded once.
    expect(await replace(W3)).toBe("23514");
    expect(
      await refused(
        manager,
        `UPDATE medication SET state = 'withdrawn', withdrawn_by = $1, withdrawn_at = now(),
           withdrawn_reason = 'Transcribed in error' WHERE id = $2`,
        [a.manager, W2],
      ),
    ).toBeNull();
    // Never to a later time than the one recorded, and once moved it is set again.
    expect(await replace(W3, "2026-11-03T08:00:00Z")).toBe("23514");
    expect(await replace(W3)).toBeNull();
    expect(await replace(W2)).toBe("23514");
  });
});

describe("hazard HZ-001 the medicines record holds only this person's documents", () => {
  it("refuses a source document that belongs to another person", async () => {
    const doc = await inContext(app(), manager, async (c) => {
      const { rows } = await c.query<{ id: string }>(
        `INSERT INTO document (category, title, retention_class, storage_key, content_type,
           size_bytes, sha256, person_id, file_name)
         VALUES ('person_document', 'Prescription', 'care_record', 'k', 'application/pdf', 1,
           repeat('0', 64), $1, 'prescription.pdf') RETURNING id::text`,
        [a.personBen],
      );
      return (rows[0] as { id: string }).id;
    });
    expect(
      await refused(manager, "UPDATE medication SET source_document_id = $1 WHERE id = $2", [
        doc,
        ADA_V1,
      ]),
    ).not.toBeNull();
    expect(
      await refused(
        manager,
        `INSERT INTO medication (id, person_id, medicine_id, version, origin, vmp_id, product_name,
           route_code, route_name, directions, pattern_kind, prescriber, starts_at, source_kind,
           source_reference, source_document_id, transcribed_by, transcribed_at)
         SELECT $1, $5, $1, 1, 'transcribed', $2, 'X', '1', 'Oral', 'regular',
           'every_day', 'Dr A Example', now(), 'prescription', 'ref', $3, $4, now()`,
        ["0193a000-0000-7000-8000-00000000e321", "90000051000001100", doc, a.manager, a.personAda],
      ),
    ).toBe("23503");
  });
});

describe("hazard HZ-121 a completed reconciliation is the record of what was decided", () => {
  it("takes sources and decisions while open, and nothing once completed", async () => {
    let sourceId = "";
    await inContext(app(), manager, async (c) => {
      sourceId = (
        await c.query<{ id: string }>(
          `INSERT INTO medication_reconciliation_source (reconciliation_id, person_id, kind,
             reference, received_at)
           VALUES ($1, $2, 'gp_record', 'GP summary', now()) RETURNING id`,
          [REC_ADA, a.personAda],
        )
      ).rows[0]?.id as string;
      await c.query(
        `INSERT INTO medication_reconciliation_decision (reconciliation_id, person_id, entry_id,
           kind, decision, decided_by, decided_at)
         VALUES ($1, $2, $3, 'query', '{"kind":"query"}', $4, now())`,
        [REC_ADA, a.personAda, ADA_V2, a.manager],
      );
    });
    expect(
      await refused(
        manager,
        `UPDATE medication_reconciliation SET status = 'completed', completed_by = $1,
           completed_at = now(), allergies_compared = 'yes', person_involved = 'no' WHERE id = $2`,
        [a.manager, REC_ADA],
      ),
    ).toBe("23514");
    expect(
      await refused(
        manager,
        `UPDATE medication_reconciliation SET status = 'completed', completed_by = $1,
           completed_at = now(), allergies_compared = 'yes', person_involved = 'yes' WHERE id = $2`,
        [a.manager, REC_ADA],
      ),
    ).toBeNull();
    expect(
      await refused(
        manager,
        `INSERT INTO medication_reconciliation_source (reconciliation_id, person_id, kind,
           reference, received_at) VALUES ($1, $2, 'gp_record', 'Another', now())`,
        [REC_ADA, a.personAda],
      ),
    ).toBe("23514");
    expect(
      await refused(
        manager,
        `INSERT INTO medication_reconciliation_item (reconciliation_id, person_id, source_id,
           as_written, says) VALUES ($1, $2, $3, 'Paracetamol 1g four times a day', 'continue')`,
        [REC_ADA, a.personAda, sourceId],
      ),
    ).toBe("23514");
    expect(
      await refused(
        manager,
        'UPDATE medication_reconciliation_decision SET decision = \'{"kind":"query","x":1}\' WHERE reconciliation_id = $1',
        [REC_ADA],
      ),
    ).toBe("23514");
    expect(
      await refused(
        manager,
        "UPDATE medication_reconciliation SET no_discharge_letter_reason = 'x' WHERE id = $1",
        [REC_ADA],
      ),
    ).toBe("23514");
  });

  it("lets retention, never the application, mark a completed one deleted, and never undo it", async () => {
    const owner = db.pool("harbour_owner");
    const as = (pool: pg.Pool, sql: string) =>
      inContext(pool, manager, async (c) => {
        await c.query("SAVEPOINT s");
        try {
          await c.query(sql, [REC_ADA]);
          return null;
        } catch (error) {
          await c.query("ROLLBACK TO SAVEPOINT s");
          return (error as { code?: string }).code ?? "error";
        }
      });
    const mark = "UPDATE medication_reconciliation SET deleted_at = now() WHERE id = $1";
    const undo = "UPDATE medication_reconciliation SET deleted_at = NULL WHERE id = $1";
    expect(await as(app(), mark)).toBe("23514");
    expect(await as(owner, mark)).toBeNull();
    expect(await as(owner, undo)).toBe("23514");
  });

  it("keeps one open reconciliation per person", async () => {
    const start = () =>
      refused(
        manager,
        `INSERT INTO medication_reconciliation (person_id, trigger, triggered_at, started_by,
           started_at, entries_at_start) VALUES ($1, 'change', now(), $2, now(), '[]'::jsonb)`,
        [a.personBen, a.manager],
      );
    expect(await start()).toBeNull();
    expect(await start()).toBe("23505");
  });
});

describe("hazard HZ-005 dm+d codes until the reference data lands (slice 10)", () => {
  it("stores dm+d identifiers by shape, and needs a foreign key once a VMP or AMP table exists", async () => {
    // Slice 10 adds the dm+d reference tables. Until then the VMP and AMP are validated
    // identifiers (isDmdId in the API; the shape here). When a table for VMPs or AMPs appears,
    // this test fails until an expand step adds the foreign keys from every column that holds
    // one (medicines.md section 11).
    const owner = db.pool("harbour_owner");
    const tableFor = async (kind: "vmp" | "amp") =>
      (
        await owner.query(
          `SELECT 1 FROM information_schema.tables
            WHERE table_schema = 'public' AND table_name ~ $1`,
          [`(^|_)${kind}s?(_|$)`],
        )
      ).rowCount ?? 0;
    const hasForeignKey = async (table: string, column: string) =>
      ((
        await owner.query(
          `SELECT 1 FROM pg_constraint c JOIN pg_class t ON t.oid = c.conrelid
            WHERE t.relname = $1 AND c.contype = 'f'
              AND EXISTS (SELECT 1 FROM unnest(c.conkey) k JOIN pg_attribute a
                          ON a.attrelid = c.conrelid AND a.attnum = k WHERE a.attname = $2)`,
          [table, column],
        )
      ).rowCount ?? 0) > 0;
    for (const kind of ["vmp", "amp"] as const) {
      const exists = (await tableFor(kind)) > 0;
      for (const table of ["medication", "medication_reconciliation_item"]) {
        expect(await hasForeignKey(table, `${kind}_id`), `${table}.${kind}_id`).toBe(exists);
      }
    }
    // Every other column is valid, so only the identifier's shape is refused.
    const id = "0193a000-0000-7000-8000-00000000e331";
    const insert = (vmp: string, amp: string | null) =>
      refused(
        manager,
        `INSERT INTO medication (id, person_id, medicine_id, version, origin, vmp_id, amp_id,
           product_name, route_code, route_name, directions, pattern_kind, prescriber, starts_at,
           source_kind, source_reference, transcribed_by, transcribed_at)
         VALUES ($1, $2, $1, 1, 'transcribed', $3, $4, 'Lactulose 3.35g/5ml oral solution',
           '26643006', 'Oral', 'regular', 'every_day', 'Dr A Example', now(), 'prescription',
           'Prescription, 01/11/2026', $5, now())`,
        [id, a.personBen, vmp, amp, a.manager],
      );
    expect(await insert("Lactulose", null)).toBe("23514");
    expect(await insert("90000051000001100", "Lactulose")).toBe("23514");
  });
});
