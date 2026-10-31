import { ABUSE_TYPES, ENQUIRY_FINDINGS, SAFEGUARDING_WORKFLOW } from "@harbour/domain";
import type pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createTestDatabase, type TestDatabase } from "./support/database";
import { ctx, ids, inContext, seedTwoTenants, TENANT_A, TENANT_B } from "./support/fixtures";

/**
 * The safeguarding log in the database (Phase 2 slice 13; SAFE-006; migration 0075): another
 * tenant sees nothing, scope follows the incident scope of ADR-0033 with the concern's one person,
 * no DELETE, every change versioned, and the integrity rules behind the API (a reason for not
 * referring, Making Safeguarding Personal and the DBS decision before the concern ends; HZ-126).
 *
 * Fixture: Ada and Ben live at North (the care worker is assigned to Ada only), Cara at South.
 */

let db: TestDatabase;
const a = ids.a;

const CONCERN_ADA = "0193a000-0000-7000-8000-00000000f001";
const CONCERN_BEN = "0193a000-0000-7000-8000-00000000f002";
const CONCERN_CARA = "0193a000-0000-7000-8000-00000000f003";
/** Raised by the care worker about Ben, whom they are not assigned to. */
const CONCERN_BEN_BY_CARER = "0193a000-0000-7000-8000-00000000f004";

async function concern(
  c: pg.PoolClient,
  id: string,
  personId: string,
  locationId: string,
  raisedBy: string = a.manager,
) {
  await c.query(
    `INSERT INTO safeguarding_concern (id, location_id, person_id, abuse_types, description,
       raised_at, raised_by, referral_due_at, protective_measures, protective_measures_updated_at)
     VALUES ($1, $2, $3, '{neglect}', 'Fixture concern', now(), $4, now() + interval '24 hours',
       'Two staff for personal care', now())`,
    [id, locationId, personId, raisedBy],
  );
}

beforeAll(async () => {
  db = await createTestDatabase();
  await seedTwoTenants(db.pool("harbour_owner"));
  await inContext(db.pool("harbour_owner"), ctx(TENANT_A, null, "tenant"), async (c) => {
    await concern(c, CONCERN_ADA, a.personAda, a.locationNorth);
    await concern(c, CONCERN_BEN, a.personBen, a.locationNorth);
    await concern(c, CONCERN_CARA, a.personCara, a.locationSouth);
    await concern(c, CONCERN_BEN_BY_CARER, a.personBen, a.locationNorth, a.carer);
  });
});

afterAll(async () => {
  await db?.drop();
});

const app = () => db.pool("harbour_app");
const manager = ctx(TENANT_A, a.manager, "tenant");
const carer = ctx(TENANT_A, a.carer, "assigned");
const north = ctx(TENANT_A, a.northManager, "locations", [a.locationNorth]);
const south = ctx(TENANT_A, a.northManager, "locations", [a.locationSouth]);

async function visible(context: ReturnType<typeof ctx>): Promise<string[]> {
  return inContext(app(), context, async (c) => {
    const result = await c.query<{ id: string }>("SELECT id::text FROM safeguarding_concern");
    return result.rows.map((r) => r.id).sort();
  });
}

describe("hazard HZ-011 the safeguarding log is isolated by tenant and scoped as incidents", () => {
  it("shows another tenant nothing", async () => {
    expect(await visible(ctx(TENANT_B, ids.b.manager, "tenant"))).toEqual([]);
  });

  it("shows tenant-wide roles every concern", async () => {
    expect(await visible(manager)).toHaveLength(4);
  });

  it("shows a care worker the concerns about their people and the ones they raised", async () => {
    expect(await visible(carer)).toEqual([CONCERN_ADA, CONCERN_BEN_BY_CARER].sort());
  });

  it("follows the person, not the place", async () => {
    expect(await visible(north)).toEqual([CONCERN_ADA, CONCERN_BEN, CONCERN_BEN_BY_CARER].sort());
    expect(await visible(south)).toEqual([CONCERN_CARA]);
  });

  it("stops another tenant writing into this tenant's log", async () => {
    await expect(
      inContext(app(), ctx(TENANT_B, ids.b.manager, "tenant"), (c) =>
        c.query(
          `INSERT INTO safeguarding_concern (tenant_id, location_id, person_id, abuse_types,
             description, raised_at, referral_due_at)
           VALUES ($1, $2, $3, '{physical}', 'Cross-tenant', now(), now())`,
          [TENANT_A, a.locationNorth, a.personAda],
        ),
      ),
    ).rejects.toThrow(/row-level security|foreign key/);
  });

  it("stops a care worker raising a concern in someone else's name about a person they cannot see", async () => {
    await expect(
      inContext(app(), carer, (c) =>
        c.query(
          `INSERT INTO safeguarding_concern (location_id, person_id, abuse_types, description,
             raised_at, raised_by, referral_due_at)
           VALUES ($1, $2, '{physical}', 'Not mine', now(), $3, now())`,
          [a.locationSouth, a.personCara, a.manager],
        ),
      ),
    ).rejects.toThrow(/row-level security/);
  });

  it("never lets the application delete a concern", async () => {
    await expect(
      inContext(app(), manager, (c) =>
        c.query("DELETE FROM safeguarding_concern WHERE id = $1", [CONCERN_ADA]),
      ),
    ).rejects.toThrow(/permission denied/);
  });
});

describe("hazard HZ-126 a safeguarding concern is never dropped or closed without its records", () => {
  const update = (statement: string, values: unknown[] = []) =>
    inContext(app(), manager, (c) => c.query(statement, values));

  it("keeps the code lists in step with the domain", async () => {
    const { rows } = await db.pool("harbour_owner").query<{ name: string; def: string }>(
      `SELECT conname AS name, pg_get_constraintdef(oid) AS def FROM pg_constraint
       WHERE conrelid = 'public.safeguarding_concern'::regclass AND contype = 'c'`,
    );
    const def = (name: string) => rows.find((r) => r.name === name)?.def ?? "";
    for (const t of ABUSE_TYPES) expect(def("safeguarding_concern_abuse_types")).toContain(t.value);
    for (const s of SAFEGUARDING_WORKFLOW.states)
      expect(def("safeguarding_concern_state")).toContain(`'${s}'`);
    for (const f of ENQUIRY_FINDINGS) expect(def("safeguarding_concern_finding")).toContain(f);
  });

  it("refuses an unknown abuse type and an empty list", async () => {
    await expect(
      update("UPDATE safeguarding_concern SET abuse_types = '{bullying}' WHERE id = $1", [
        CONCERN_ADA,
      ]),
    ).rejects.toThrow(/safeguarding_concern_abuse_types/);
    await expect(
      update("UPDATE safeguarding_concern SET abuse_types = '{}' WHERE id = $1", [CONCERN_ADA]),
    ).rejects.toThrow(/safeguarding_concern_abuse_types/);
  });

  it("refuses a decision not to refer without a reason and who decided", async () => {
    await expect(
      update("UPDATE safeguarding_concern SET state = 'no_referral' WHERE id = $1", [CONCERN_ADA]),
    ).rejects.toThrow(/safeguarding_concern_no_referral/);
  });

  it("refuses a referral without the local authority and when", async () => {
    await expect(
      update("UPDATE safeguarding_concern SET state = 'referred' WHERE id = $1", [CONCERN_ADA]),
    ).rejects.toThrow(/safeguarding_concern_referral/);
  });

  it("refuses closing without the person's outcomes (Making Safeguarding Personal)", async () => {
    await expect(
      update(
        `UPDATE safeguarding_concern SET state = 'closed', finding = 'substantiated',
           closed_at = now(), closed_by = $2, closed_reason = 'Done'
         WHERE id = $1`,
        [CONCERN_BEN, a.manager],
      ),
    ).rejects.toThrow(/safeguarding_concern_msp_before_close/);
  });

  it("refuses ending a concern without the DBS decision when staff were removed for harm", async () => {
    await expect(
      update(
        `UPDATE safeguarding_concern SET state = 'no_referral', staff_removed_for_harm = true,
           no_referral_reason = 'Local authority advised no referral', no_referral_decided_by = $2
         WHERE id = $1`,
        [CONCERN_BEN, a.manager],
      ),
    ).rejects.toThrow(/safeguarding_concern_dbs_before_end/);
  });

  it("versions every change for the history view", async () => {
    const before = await inContext(app(), manager, async (c) => {
      const r = await c.query<{ version: number }>(
        "SELECT version FROM safeguarding_concern WHERE id = $1",
        [CONCERN_ADA],
      );
      return r.rows[0]?.version ?? 0;
    });
    await update(
      `UPDATE safeguarding_concern SET protective_measures = 'One-to-one at night',
         protective_measures_updated_at = now() WHERE id = $1`,
      [CONCERN_ADA],
    );
    const { rows } = await inContext(db.pool("harbour_owner"), ctx(TENANT_A, null, "tenant"), (c) =>
      c.query<{ version: number; versions: string }>(
        `SELECT c.version, (SELECT count(*) FROM record_version v
            WHERE v.table_name = 'safeguarding_concern' AND v.record_id = c.id)::text AS versions
         FROM safeguarding_concern c WHERE c.id = $1`,
        [CONCERN_ADA],
      ),
    );
    expect(rows[0]?.version).toBe(before + 1);
    expect(Number(rows[0]?.versions)).toBeGreaterThan(0);
  });
});
