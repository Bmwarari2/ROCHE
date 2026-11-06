import { readFileSync } from "node:fs";
import type pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createTestDatabase, type TestDatabase } from "./support/database";
import { ctx, ids, inContext, seedTwoTenants, TENANT_A, TENANT_B } from "./support/fixtures";

/**
 * PRN protocols, outcomes and medicine lists in the database (Phase 2 slice 28; migration 0143;
 * HZ-117). Ada and Ben live at North House, Cara at South House. The manager holds the medicines
 * permissions across the organisation; the north deputy holds medicines.record.manage at North
 * House only; the carer is assigned to Ada with medicines.emar.administer.
 */

let db: TestDatabase;
const a = ids.a;
const app = () => db.pool("harbour_app");
const manager = ctx(TENANT_A, a.manager, "tenant");
const north = ctx(TENANT_A, a.northManager, "locations", [a.locationNorth]);
const carer = ctx(TENANT_A, a.carer, "assigned");
const other = ctx(TENANT_B, ids.b.manager, "tenant");
const owner = <T>(fn: (c: pg.PoolClient) => Promise<T>) =>
  inContext(db.pool("harbour_owner"), ctx(TENANT_A, null, "tenant"), fn);

const ROLE_OWNER = "0199d143-0000-7000-8000-000000000501";
const ROLE_DEPUTY = "0199d143-0000-7000-8000-000000000502";
const ROLE_GIVER = "0199d143-0000-7000-8000-000000000503";
const ADA_PRN = "0199d143-0000-7000-8000-00000000f101";
const ADA_REGULAR = "0199d143-0000-7000-8000-00000000f102";
const CARA_PRN = "0199d143-0000-7000-8000-00000000f301";
const ADA_DOSE = "0199d143-0000-7000-8000-00000000d101";
const ADA_SCHEDULED = "0199d143-0000-7000-8000-00000000d102";
let protocol = "";

async function prnEntry(c: pg.PoolClient, id: string, personId: string) {
  await c.query(
    `INSERT INTO medication (id, person_id, medicine_id, version, origin, vmp_id, product_name,
       route_code, route_name, directions, prescriber, starts_at, source_kind, source_reference,
       transcribed_by, transcribed_at, prn_dose, indication, prn_max_per_24h)
     VALUES ($1, $2, $1, 1, 'transcribed', '90000051000001100', 'Lactulose', '26643006', 'Oral',
       'when_required', 'Dr A Example', now() - interval '1 day', 'prescription',
       'Prescription, 01/11/2026', $3, now() - interval '1 day',
       '{"kind": "amount", "quantity": 15, "unitCode": "258773002", "unitName": "ml"}'::jsonb,
       'Constipation', 60)`,
    [id, personId, a.manager],
  );
}

async function attempt(
  context: ReturnType<typeof ctx>,
  sql: string,
  params: unknown[] = [],
): Promise<string | null> {
  return inContext(app(), context, async (c) => {
    await c.query("SAVEPOINT s");
    try {
      await c.query(sql, params);
      return null;
    } catch (error) {
      await c.query("ROLLBACK TO SAVEPOINT s");
      const e = error as { code?: string; message?: string };
      return `${e.code}:${e.message}`;
    }
  });
}

async function visible(context: ReturnType<typeof ctx>, table: string): Promise<number> {
  return inContext(app(), context, async (c) => {
    const r = await c.query(`SELECT count(*)::int AS n FROM ${table}`);
    return r.rows[0].n as number;
  });
}

const protocolSql = `INSERT INTO prn_protocol (person_id, medication_id, medicine_id, purpose, triggers,
    non_drug_alternatives, expected_effect, agreed_with_name, agreed_with_role, agreed_on, review_on)
  VALUES ($1, $2, $2, 'Constipation', ARRAY['No bowel movement for two days'], ARRAY['Fluids'],
    'Bowel movement', 'Dr A Example', 'prescriber', current_date, current_date + 90) RETURNING id`;
const outcomeSql = `INSERT INTO prn_outcome (id, person_id, administration_id, outcome, observed_at,
    recorded_by, supersedes_id, correction_reason)
  VALUES ($1, $2, $3, 'effective', now(), $4, $5, $6)`;

beforeAll(async () => {
  db = await createTestDatabase();
  await seedTwoTenants(db.pool("harbour_owner"));
  await owner(async (c) => {
    await c.query(
      `INSERT INTO role (id, key, name, scope_kind, permissions, is_builtin) VALUES
         ($1, 'owner', 'Owner', 'tenant',
           '{people.person.read,medicines.record.manage,medicines.list.manage,medicines.emar.administer}', true),
         ($2, 'deputy_manager', 'Deputy', 'location', '{people.person.read,medicines.record.manage}', true),
         ($3, 'care_giver_test', 'Care worker giving medicines', 'assigned',
           '{people.person.read,medicines.emar.administer}', false)`,
      [ROLE_OWNER, ROLE_DEPUTY, ROLE_GIVER],
    );
    await c.query(
      `INSERT INTO role_assignment (tenant_user_id, role_id, location_id) VALUES
         ($1, $2, NULL), ($3, $4, $5), ($6, $7, NULL)`,
      [a.manager, ROLE_OWNER, a.northManager, ROLE_DEPUTY, a.locationNorth, a.carer, ROLE_GIVER],
    );
    await prnEntry(c, ADA_PRN, a.personAda);
    await prnEntry(c, CARA_PRN, a.personCara);
    await c.query(
      `INSERT INTO medication (id, person_id, medicine_id, version, origin, vmp_id, product_name,
         route_code, route_name, directions, pattern_kind, prescriber, starts_at, source_kind,
         source_reference, transcribed_by, transcribed_at)
       VALUES ($1, $2, $1, 1, 'transcribed', '90000011000001104', 'Paracetamol 500mg tablets',
         '26643006', 'Oral', 'regular', 'every_day', 'Dr A Example', now() - interval '1 day',
         'prescription', 'Prescription, 01/11/2026', $3, now() - interval '1 day')`,
      [ADA_REGULAR, a.personAda, a.manager],
    );
    await c.query(
      `INSERT INTO medication_schedule (medication_id, person_id, position, time, dose_kind,
         quantity, unit_code, unit_name)
       VALUES ($1, $2, 0, '08:00', 'amount', 2, '428673006', 'tablet')`,
      [ADA_REGULAR, a.personAda],
    );
    await c.query(
      `INSERT INTO medication_administration (id, person_id, medication_id, due_at, outcome,
         quantity, unit_code, given_at, recorded_by) VALUES
         ($1, $2, $3, NULL, 'given', 15, '258773002', now() - interval '2 hours', $5),
         ($4, $2, $6, now() - interval '3 hours', 'given', 2, '428673006',
           now() - interval '3 hours', $5)`,
      [ADA_DOSE, a.personAda, ADA_PRN, ADA_SCHEDULED, a.manager, ADA_REGULAR],
    );
  });
});

afterAll(async () => {
  await db?.drop();
});

describe("hazard HZ-117 the organisation's medicine lists (migration 0143)", () => {
  const add = `INSERT INTO medicine_list_item (list, vmp_id, product_name)
    VALUES ('psychotropic', $1, 'Lorazepam 1mg tablets') RETURNING id`;

  it("is written only by a holder of medicines.list.manage, read by every member, never by another organisation", async () => {
    expect(await attempt(carer, add, ["90000071000001107"])).toMatch(/^42501/);
    expect(await attempt(north, add, ["90000071000001107"])).toMatch(/^42501/);
    expect(await attempt(manager, add, ["90000071000001107"])).toBeNull();
    expect(await attempt(manager, add, ["90000071000001107"])).toMatch(/^23505/);
    expect(await visible(carer, "medicine_list_item")).toBe(1);
    expect(await visible(other, "medicine_list_item")).toBe(0);
  });

  it("never changes its product, and is closed once removed", async () => {
    expect(
      await attempt(manager, "UPDATE medicine_list_item SET vmp_id = '90000011000001104'"),
    ).toMatch(/never change/);
    expect(
      await attempt(
        manager,
        "UPDATE medicine_list_item SET removed_at = now(), removed_reason = 'Mistake'",
      ),
    ).toBeNull();
    expect(await attempt(manager, "UPDATE medicine_list_item SET reason = 'Again'")).toMatch(
      /closed/,
    );
    expect(await attempt(manager, "DELETE FROM medicine_list_item")).toMatch(/^42501/);
  });
});

describe("hazard HZ-117 PRN protocols in the database (migration 0143)", () => {
  it("is for one of the person's current when-required entries, copying the medicine", async () => {
    expect(await attempt(manager, protocolSql, [a.personAda, ADA_REGULAR])).toMatch(
      /needs_current_when_required_entry/,
    );
    expect(await attempt(manager, protocolSql, [a.personAda, CARA_PRN])).not.toBeNull();
    protocol = await inContext(app(), north, async (c) => {
      const r = await c.query(protocolSql, [a.personAda, ADA_PRN]);
      return r.rows[0].id as string;
    });
    expect(await attempt(manager, protocolSql, [a.personAda, ADA_PRN])).toMatch(/^23505/);
  });

  it("is written only with medicines.record.manage at the person's home", async () => {
    expect(await attempt(north, protocolSql, [a.personCara, CARA_PRN])).not.toBeNull();
    expect(await attempt(carer, protocolSql, [a.personAda, ADA_PRN])).toMatch(/^42501/);
  });

  it("needs a new reason for every change, and is closed once withdrawn", async () => {
    const change = (reason: string | null) =>
      attempt(
        north,
        "UPDATE prn_protocol SET purpose = 'Hard stools', change_reason = $2 WHERE id = $1",
        [protocol, reason],
      );
    expect(await change(null)).toMatch(/needs_reason/);
    expect(await change("Reviewed with the GP")).toBeNull();
    expect(
      await attempt(
        north,
        `UPDATE prn_protocol SET withdrawn_on = current_date, withdrawn_reason = 'Stopped',
           change_reason = 'Stopped' WHERE id = $1`,
        [protocol],
      ),
    ).toBeNull();
    expect(await change("Again")).toMatch(/closed/);
    expect(await visible(other, "prn_protocol")).toBe(0);
    expect(await attempt(manager, "DELETE FROM prn_protocol")).toMatch(/^42501/);
  });
});

describe("hazard HZ-117 PRN outcomes in the database (migration 0143)", () => {
  const fresh = () => crypto.randomUUID();

  it("stores an outcome of a when-required dose by the member recording it, once per dose", async () => {
    expect(
      await attempt(carer, outcomeSql, [fresh(), a.personAda, ADA_SCHEDULED, a.carer, null, null]),
    ).toMatch(/not_for_this_dose/);
    expect(
      await attempt(carer, outcomeSql, [fresh(), a.personAda, ADA_DOSE, a.manager, null, null]),
    ).toMatch(/not_the_recorder/);
    const first = fresh();
    expect(
      await attempt(carer, outcomeSql, [first, a.personAda, ADA_DOSE, a.carer, null, null]),
    ).toBeNull();
    expect(
      await attempt(carer, outcomeSql, [fresh(), a.personAda, ADA_DOSE, a.carer, null, null]),
    ).toMatch(/^23505/);
    expect(
      await attempt(carer, outcomeSql, [fresh(), a.personAda, ADA_DOSE, a.carer, first, "Wrong"]),
    ).toBeNull();
  });

  it("is append-only and isolated", async () => {
    expect(await attempt(manager, "UPDATE prn_outcome SET note = 'x'")).toMatch(/^42501/);
    expect(await visible(other, "prn_outcome")).toBe(0);
    expect(await visible(carer, "prn_outcome")).toBe(2);
  });
});

describe("existing tenants' built-in roles gain medicines.list.manage (migration 0143)", () => {
  it("adds it once to the deputy, audited", async () => {
    const sql = readFileSync(new URL("../drizzle/0143_prn_protocols.sql", import.meta.url), "utf8");
    const start = sql.indexOf("ALTER TABLE public.role NO FORCE ROW LEVEL SECURITY;");
    const statements = sql
      .slice(start)
      .split("--> statement-breakpoint")
      .map((s) => s.trim())
      .filter(Boolean);
    for (let run = 0; run < 2; run++) {
      for (const statement of statements) await db.pool("harbour_owner").query(statement);
    }
    const roles = await owner((c) =>
      c.query<{ key: string; permissions: string[] }>(
        "SELECT key, permissions FROM role WHERE id = ANY ($1) ORDER BY key",
        [[ROLE_OWNER, ROLE_DEPUTY]],
      ),
    );
    expect(roles.rows.map((r) => [r.key, r.permissions.includes("medicines.list.manage")])).toEqual(
      [
        ["deputy_manager", true],
        ["owner", true],
      ],
    );
    const audited = await owner((c) =>
      c.query(
        `SELECT resource_id FROM audit_event
          WHERE action = 'platform.role.permissions_migrated'
            AND scope ->> 'migration' = '0143_prn_protocols'`,
      ),
    );
    expect(audited.rows.map((r) => r.resource_id)).toEqual([ROLE_DEPUTY]);
  });
});
