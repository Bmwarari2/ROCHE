import { readFileSync } from "node:fs";
import type pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createTestDatabase, type TestDatabase } from "./support/database";
import { ctx, ids, inContext, seedTwoTenants, TENANT_A, TENANT_B } from "./support/fixtures";

/**
 * Covert records, self-administration assessments and homely remedies in the database (Phase 2
 * slice 38; migration 0142; HZ-026, HZ-120). Ada and Ben live at North House, Cara at South
 * House. The manager holds both medicines permissions across the organisation; the north deputy
 * holds medicines.record.manage at North House only (no covert permission); the carer is assigned
 * to Ada and holds neither.
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

const ROLE_OWNER = "0199d142-0000-7000-8000-000000000501";
const ROLE_DEPUTY = "0199d142-0000-7000-8000-000000000502";
const ROLE_GIVER = "0199d142-0000-7000-8000-000000000503";
const ADA_ENTRY = "0199d142-0000-7000-8000-00000000f101";
const BEN_ENTRY = "0199d142-0000-7000-8000-00000000f201";
const CARA_ENTRY = "0199d142-0000-7000-8000-00000000f301";
const PROTOCOL = "0199d142-0000-7000-8000-00000000a101";
const DOSE = "0199d142-0000-7000-8000-00000000a201";
let lacks = "";
let lacksOther = "";
let hasCapacity = "";
let bestInterests = "";
let covert = "";

async function entry(c: pg.PoolClient, id: string, personId: string) {
  await c.query(
    `INSERT INTO medication (id, person_id, medicine_id, version, origin, vmp_id, product_name,
       route_code, route_name, directions, prescriber, starts_at, source_kind, source_reference,
       transcribed_by, transcribed_at, prn_dose, indication)
     VALUES ($1, $2, $1, 1, 'transcribed', '90000011000001104', 'Paracetamol 500mg tablets',
       '26643006', 'Oral', 'when_required', 'Dr A Example', now(), 'prescription',
       'Prescription, 01/11/2026', $3, now(),
       '{"kind": "amount", "quantity": 2, "unitCode": "428673006", "unitName": "tablet"}'::jsonb,
       'Pain')`,
    [id, personId, a.manager],
  );
}

async function capacity(c: pg.PoolClient, kind: string, outcome: string): Promise<string> {
  const lacking = outcome === "lacks_capacity";
  const r = await c.query(
    `INSERT INTO capacity_assessment (person_id, decision, decision_kind, assessed_at,
       assessor_tenant_user_id, stage1_impairment, stage1_description, stage2,
       inability_because_of_impairment, outcome, unable_to, reason)
     VALUES ($1, 'whether to take medicines hidden in food', $2, now() - interval '2 days', $3,
       $4, 'Dementia', '{}', $5, $6, $7, 'Recorded') RETURNING id`,
    [
      a.personAda,
      kind,
      a.manager,
      lacking,
      lacking ? true : null,
      outcome,
      lacking ? "{understand}" : "{}",
    ],
  );
  return r.rows[0].id;
}

const covertSql = `INSERT INTO covert_medication_record (person_id, medication_id, medicine_id,
    capacity_assessment_id, best_interests_decision_id, attendees, method, pharmacist_advice,
    starts_on, review_on)
  VALUES ($1, $2, $2, $3, $4, $5::jsonb, 'In yoghurt', 'May be crushed', current_date,
    current_date + 30) RETURNING id`;
const BOTH = JSON.stringify([
  { role: "prescriber", name: "Dr A Example" },
  { role: "pharmacist", name: "B Example" },
]);

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

beforeAll(async () => {
  db = await createTestDatabase();
  await seedTwoTenants(db.pool("harbour_owner"));
  await owner(async (c) => {
    await c.query(
      `INSERT INTO role (id, key, name, scope_kind, permissions, is_builtin) VALUES
         ($1, 'owner', 'Owner', 'tenant',
           '{people.person.read,medicines.record.manage,medicines.covert.manage,medicines.emar.administer}', true),
         ($2, 'deputy_manager', 'Deputy', 'location',
           '{people.person.read,medicines.record.manage}', true)`,
      [ROLE_OWNER, ROLE_DEPUTY],
    );
    await c.query(
      `INSERT INTO role (id, key, name, scope_kind, permissions, is_builtin)
       VALUES ($1, 'care_giver_test', 'Care worker giving medicines', 'assigned',
         '{people.person.read,medicines.emar.administer}', false)`,
      [ROLE_GIVER],
    );
    await c.query(
      `INSERT INTO role_assignment (tenant_user_id, role_id, location_id) VALUES
         ($1, $2, NULL), ($3, $4, $5), ($6, $7, NULL)`,
      [a.manager, ROLE_OWNER, a.northManager, ROLE_DEPUTY, a.locationNorth, a.carer, ROLE_GIVER],
    );
    await entry(c, ADA_ENTRY, a.personAda);
    await entry(c, BEN_ENTRY, a.personBen);
    await entry(c, CARA_ENTRY, a.personCara);
    lacks = await capacity(c, "covert_medicines", "lacks_capacity");
    lacksOther = await capacity(c, "sharing", "lacks_capacity");
    hasCapacity = await capacity(c, "covert_medicines", "has_capacity");
    bestInterests = (
      await c.query(
        `INSERT INTO best_interests_decision (person_id, capacity_assessment_id, decision,
           decided_at, checklist, consultations, review_on)
         VALUES ($1, $2, 'Give it in yoghurt', now() - interval '1 day', '{}'::jsonb,
           '[{"consultee":"family_or_friend","views":"Agrees"}]', '2099-01-10') RETURNING id`,
        [a.personAda, lacks],
      )
    ).rows[0].id;
  });
});

afterAll(async () => {
  await db?.drop();
});

describe("hazard HZ-026 covert records in the database (migration 0142)", () => {
  it("stores one on a lack of capacity for covert medicines and its best-interests decision, copying the medicine", async () => {
    covert = await inContext(app(), manager, async (c) => {
      const r = await c.query(covertSql, [a.personAda, ADA_ENTRY, lacks, bestInterests, BOTH]);
      return r.rows[0].id as string;
    });
    const row = await owner((c) =>
      c.query("SELECT medicine_id FROM covert_medication_record WHERE id = $1", [covert]),
    );
    expect(row.rows[0].medicine_id).toBe(ADA_ENTRY);
  });

  it.each([
    [
      "an assessment finding capacity",
      () => [hasCapacity, bestInterests, BOTH],
      /lack_of_capacity/,
    ],
    [
      "an assessment of another decision",
      () => [lacksOther, bestInterests, BOTH],
      /lack_of_capacity/,
    ],
    [
      "no pharmacist",
      () => [lacks, bestInterests, JSON.stringify([{ role: "prescriber", name: "Dr A Example" }])],
      /prescriber_and_pharmacist/,
    ],
  ])("refuses %s", async (_name, args, message) => {
    const [cap, bi, attendees] = args();
    const r = await attempt(manager, covertSql, [a.personAda, BEN_ENTRY, cap, bi, attendees]);
    expect(r).toMatch(message);
  });

  it("refuses another person's medicine, and a member without medicines.covert.manage", async () => {
    expect(
      await attempt(manager, covertSql, [a.personAda, BEN_ENTRY, lacks, bestInterests, BOTH]),
    ).not.toBeNull();
    expect(
      await attempt(north, covertSql, [a.personAda, ADA_ENTRY, lacks, bestInterests, BOTH]),
    ).toMatch(/^42501/);
  });

  it("needs a new reason for every change, and is closed once ended", async () => {
    const change = (reason: string | null) =>
      attempt(
        manager,
        "UPDATE covert_medication_record SET method = 'In jam', change_reason = $2 WHERE id = $1",
        [covert, reason],
      );
    expect(await change(null)).toMatch(/needs_reason/);
    expect(await change("Pharmacist advised jam")).toBeNull();
    expect(await change("Pharmacist advised jam")).toMatch(/needs_reason/);
    expect(
      await attempt(
        manager,
        `UPDATE covert_medication_record SET ended_on = current_date, ended_reason = 'Takes it openly',
           change_reason = 'Takes it openly' WHERE id = $1`,
        [covert],
      ),
    ).toBeNull();
    expect(await change("Another")).toMatch(/closed/);
  });

  it("shows records only in scope, never to another organisation, and allows no delete", async () => {
    expect(await visible(manager, "covert_medication_record")).toBe(1);
    expect(await visible(carer, "covert_medication_record")).toBe(1);
    expect(await visible(other, "covert_medication_record")).toBe(0);
    expect(await attempt(manager, "DELETE FROM covert_medication_record")).toMatch(/^42501/);
  });
});

describe("hazard HZ-120 self-administration assessments in the database (migration 0142)", () => {
  const insert = `INSERT INTO self_administration_assessment (person_id, medicine_ids, choice,
      capacity, dexterity, storage, level, assessed_on, review_on, assessed_by)
    VALUES ($1, $2, 'wants_to', 'assumed', 'able', $3, 'self_administers', current_date,
      current_date + 90, $4)`;

  it("stores one for the person's own medicines, refusing another person's and unsafe levels", async () => {
    expect(
      await attempt(manager, insert, [a.personAda, [ADA_ENTRY], "lockable_storage", a.manager]),
    ).toBeNull();
    expect(
      await attempt(manager, insert, [a.personAda, [BEN_ENTRY], "lockable_storage", a.manager]),
    ).toMatch(/other_medicine/);
    expect(
      await attempt(manager, insert, [a.personAda, [ADA_ENTRY], "no_lockable_storage", a.manager]),
    ).toMatch(/^23514/);
    expect(
      await attempt(manager, insert, [a.personAda, [ADA_ENTRY], "lockable_storage", a.carer]),
    ).toMatch(/not_the_assessor/);
    expect(
      await attempt(carer, insert, [a.personAda, [ADA_ENTRY], "lockable_storage", a.carer]),
    ).toMatch(/^42501/);
  });

  it("is append-only and isolated", async () => {
    expect(await attempt(manager, "UPDATE self_administration_assessment SET notes = 'x'")).toMatch(
      /^42501/,
    );
    expect(await visible(other, "self_administration_assessment")).toBe(0);
    expect(await visible(manager, "self_administration_assessment")).toBe(1);
  });
});

describe("hazard HZ-120 homely remedies in the database (migration 0142)", () => {
  const protocolSql = `INSERT INTO homely_remedy_protocol (id, location_id, product_name, indication,
      dose_quantity, unit_name, min_interval_hours, max_daily_quantity, max_days,
      authorised_member_ids, approved_by_name, approved_by_role, approved_on, review_on)
    VALUES ($1, $2, 'Simple linctus', 'Dry cough', 5, 'ml', 4, 20, 2, $3, 'Dr A Example', 'gp',
      current_date, current_date + 365)`;
  const doseSql = `INSERT INTO homely_remedy_administration (id, person_id, protocol_id,
      protocol_version, outcome, quantity, reason, given_at, given_by, allergies_checked)
    VALUES ($1, $2, $3, $4, 'given', 5, 'Cough', now(), $5, true)`;

  it("lets only a holder of medicines.record.manage at the home write a protocol", async () => {
    expect(await attempt(carer, protocolSql, [PROTOCOL, a.locationNorth, [a.carer]])).toMatch(
      /^42501/,
    );
    expect(await attempt(north, protocolSql, [PROTOCOL, a.locationSouth, [a.carer]])).toMatch(
      /^42501/,
    );
    expect(await attempt(north, protocolSql, [PROTOCOL, a.locationNorth, [a.carer]])).toBeNull();
  });

  it("stores a dose only by a named member recording it themselves, at the protocol's home, on its current version, with allergies checked", async () => {
    const fresh = () => crypto.randomUUID();
    expect(await attempt(manager, doseSql, [fresh(), a.personAda, PROTOCOL, 1, a.manager])).toMatch(
      /outside_protocol/,
    );
    // Recorded under another member's id: refused, whoever is named.
    expect(await attempt(manager, doseSql, [fresh(), a.personAda, PROTOCOL, 1, a.carer])).toMatch(
      /not_the_recorder/,
    );
    expect(
      await attempt(manager, doseSql, [fresh(), a.personCara, PROTOCOL, 1, a.manager]),
    ).not.toBeNull();
    expect(await attempt(carer, doseSql, [fresh(), a.personAda, PROTOCOL, 2, a.carer])).toMatch(
      /outside_protocol/,
    );
    expect(
      await attempt(carer, doseSql.replace(", true)", ", false)"), [
        fresh(),
        a.personAda,
        PROTOCOL,
        1,
        a.carer,
      ]),
    ).toMatch(/^23514/);
    // The north deputy holds no medicines.emar.administer and is not named: refused (the guard
    // runs before the write policy, which the self-administration case proves).
    expect(
      await attempt(north, doseSql, [fresh(), a.personAda, PROTOCOL, 1, a.northManager]),
    ).not.toBeNull();
    expect(await attempt(carer, doseSql, [DOSE, a.personAda, PROTOCOL, 1, a.carer])).toBeNull();
  });

  it("marks a dose entered in error with a new row, and is append-only", async () => {
    const mark = `INSERT INTO homely_remedy_administration (id, person_id, protocol_id,
        protocol_version, outcome, given_at, given_by, supersedes_id, correction_reason)
      VALUES ($1, $2, $3, 1, 'entered_in_error', now(), $4, $5, 'Wrong person')`;
    expect(
      await attempt(manager, mark, [crypto.randomUUID(), a.personBen, PROTOCOL, a.manager, DOSE]),
    ).not.toBeNull();
    expect(
      await attempt(manager, mark, [crypto.randomUUID(), a.personAda, PROTOCOL, a.manager, DOSE]),
    ).toBeNull();
    expect(
      await attempt(manager, "UPDATE homely_remedy_administration SET reason = 'x'"),
    ).not.toBeNull();
  });

  it("needs a new reason to change a protocol, and closes it once withdrawn", async () => {
    const change = (reason: string | null) =>
      attempt(
        north,
        "UPDATE homely_remedy_protocol SET max_days = 1, change_reason = $2 WHERE id = $1",
        [PROTOCOL, reason],
      );
    expect(await change(null)).toMatch(/needs_reason/);
    expect(await change("GP asked for one day")).toBeNull();
    expect(
      await attempt(
        north,
        `UPDATE homely_remedy_protocol SET withdrawn_at = now(), withdrawn_reason = 'Stopped',
           change_reason = 'Stopped' WHERE id = $1`,
        [PROTOCOL],
      ),
    ).toBeNull();
    expect(await change("Again")).toMatch(/closed/);
    expect(await visible(other, "homely_remedy_protocol")).toBe(0);
  });
});

describe("existing tenants' built-in roles gain medicines.covert.manage (migration 0142)", () => {
  it("adds it once to the deputy, audited, leaving the owner who held it unchanged", async () => {
    const sql = readFileSync(
      new URL("../drizzle/0142_medicines_covert_self_admin.sql", import.meta.url),
      "utf8",
    );
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
    expect(
      roles.rows.map((r) => [r.key, r.permissions.includes("medicines.covert.manage")]),
    ).toEqual([
      ["deputy_manager", true],
      ["owner", true],
    ]);
    const audited = await owner((c) =>
      c.query(
        `SELECT resource_id FROM audit_event
          WHERE action = 'platform.role.permissions_migrated'
            AND scope ->> 'migration' = '0142_medicines_covert_self_admin'`,
      ),
    );
    expect(audited.rows.map((r) => r.resource_id)).toEqual([ROLE_DEPUTY]);
  });
});
