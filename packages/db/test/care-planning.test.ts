import { PCSP_DOMAINS } from "@harbour/domain";
import type pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createTestDatabase, type TestDatabase } from "./support/database";
import { ctx, ids, inContext, seedTwoTenants, TENANT_A, TENANT_B } from "./support/fixtures";

/**
 * Care plans, risk assessments, stored assessments, activities, visits and advance care records
 * (slice 4b) follow the person's scope (HZ-011), keep their append-only and supersede rules
 * (HZ-017), and hold at most one active resuscitation record of each kind (HZ-015).
 */

let db: TestDatabase;
const a = ids.a;
const NEW_TABLES = [
  "care_plan",
  "care_plan_section",
  "care_plan_action",
  "risk_assessment",
  "assessment",
  "activity_record",
  "visit_log",
  "advance_care_record",
] as const;

const PLAN_ADA = "0193a000-0000-7000-8000-00000000c001";
const PLAN_BEN = "0193a000-0000-7000-8000-00000000c002";
const PLAN_CARA = "0193a000-0000-7000-8000-00000000c003";
const SECTION_ADA = "0193a000-0000-7000-8000-00000000c101";
const ASSESSMENT_ADA = "0193a000-0000-7000-8000-00000000c201";

/** One row in every new table for each of Ada (North, assigned), Ben (North) and Cara (South). */
async function seedCareRecords(c: pg.PoolClient) {
  const people = [
    [a.personAda, a.locationNorth, PLAN_ADA],
    [a.personBen, a.locationNorth, PLAN_BEN],
    [a.personCara, a.locationSouth, PLAN_CARA],
  ] as const;
  for (const [personId, locationId, planId] of people) {
    await c.query(
      `INSERT INTO care_plan (id, person_id, location_id, status, published_version, review_due_on)
       VALUES ($1, $2, $3, 'active', 1, '2026-11-11')`,
      [planId, personId, locationId],
    );
    const section = await c.query<{ id: string }>(
      `INSERT INTO care_plan_section (id, person_id, plan_id, domain, need, outcome)
       VALUES ($1, $2, $3, 'mobility', 'Needs help to stand.', 'I want to walk to the garden.')
       RETURNING id`,
      [personId === a.personAda ? SECTION_ADA : crypto.randomUUID(), personId, planId],
    );
    await c.query(
      `INSERT INTO care_plan_action (person_id, plan_id, section_id, action, role_key, recurrence, generates_tasks)
       VALUES ($1, $2, $3, 'Walk with a frame to the garden', 'care_worker',
               '{"freq":"daily","times":["10:00"]}', true)`,
      [personId, planId, section.rows[0]?.id],
    );
    await c.query(
      `INSERT INTO risk_assessment (person_id, template_key, template_version, hazard, who_at_risk,
         likelihood, severity, risk_rating, risk_band, controls, assessed_on, review_due_on)
       VALUES ($1, 'moving_and_handling', 'harbour-2026-10', 'Transfers', 'The person and staff',
         3, 4, 12, 'high', '{"Hoist"}', '2026-10-11', '2026-11-11')`,
      [personId],
    );
    await c.query(
      `INSERT INTO assessment (id, person_id, location_id, occurred_at, tool_key, tool_version, answers, score, band, next_due_on)
       VALUES ($1, $2, $3, now(), 'must', 'bapen-2011', '{}', 0, 'low', '2026-11-11')`,
      [personId === a.personAda ? ASSESSMENT_ADA : crypto.randomUUID(), personId, locationId],
    );
    await c.query(
      `INSERT INTO activity_record (person_id, location_id, occurred_at, activity, format, attendance, engagement)
       VALUES ($1, $2, now(), 'Music for health', 'one_to_one', 'attended', 'engaged_throughout')`,
      [personId, locationId],
    );
    await c.query(
      `INSERT INTO visit_log (person_id, location_id, occurred_at, kind, visitor_name)
       VALUES ($1, $2, now() - interval '1 hour', 'facilitated_visit', 'Visitor Example')`,
      [personId, locationId],
    );
    await c.query(
      `INSERT INTO advance_care_record (person_id, kind, cpr_decision, clinician_name, clinician_role, completed_on)
       VALUES ($1, 'dnacpr', 'do_not_attempt_cpr', 'Dr Example', 'GP', '2026-10-01')`,
      [personId],
    );
  }
}

beforeAll(async () => {
  db = await createTestDatabase();
  await seedTwoTenants(db.pool("harbour_owner"));
  await inContext(db.pool("harbour_owner"), ctx(TENANT_A, null, "tenant"), seedCareRecords);
});

afterAll(async () => {
  await db?.drop();
});

const app = () => db.pool("harbour_app");
const asManager = <T>(fn: (c: pg.PoolClient) => Promise<T>) =>
  inContext(app(), ctx(TENANT_A, a.manager, "tenant"), fn);

async function visiblePeoplePerTable(context: ReturnType<typeof ctx>) {
  return inContext(app(), context, async (c) => {
    const seen: Record<string, string[]> = {};
    for (const table of NEW_TABLES) {
      const { rows } = await c.query<{ person_id: string }>(
        `SELECT DISTINCT person_id FROM ${table} ORDER BY person_id`,
      );
      seen[table] = rows.map((r) => r.person_id);
    }
    return seen;
  });
}

describe("hazard HZ-011 care planning records follow the person's scope", () => {
  it("shows a care worker only their assigned person in every new table", async () => {
    const seen = await visiblePeoplePerTable(ctx(TENANT_A, a.carer, "assigned"));
    for (const table of NEW_TABLES)
      expect({ table, people: seen[table] }).toEqual({
        table,
        people: [a.personAda],
      });
  });

  it("shows a location manager the people at their location and nobody elsewhere", async () => {
    const seen = await visiblePeoplePerTable(
      ctx(TENANT_A, a.northManager, "locations", [a.locationNorth]),
    );
    for (const table of NEW_TABLES) {
      expect({ table, people: seen[table] }).toEqual({
        table,
        people: [a.personAda, a.personBen].sort(),
      });
    }
  });

  it("shows another tenant nothing", async () => {
    const seen = await visiblePeoplePerTable(ctx(TENANT_B, ids.b.manager, "tenant"));
    for (const table of NEW_TABLES)
      expect({ table, people: seen[table] }).toEqual({ table, people: [] });
  });

  it("stops a care worker writing for someone outside their scope", async () => {
    await expect(
      inContext(app(), ctx(TENANT_A, a.carer, "assigned"), (c) =>
        c.query(
          `INSERT INTO activity_record (person_id, location_id, occurred_at, activity, format, attendance)
           VALUES ($1, $2, now(), 'Quiz', 'one_to_one', 'declined')`,
          [a.personBen, a.locationNorth],
        ),
      ),
    ).rejects.toThrow(/row-level security/);
  });

  it("refuses a child row that claims a different person from its plan", async () => {
    await expect(
      asManager((c) =>
        c.query(
          `INSERT INTO care_plan_section (person_id, plan_id, domain) VALUES ($1, $2, 'skin')`,
          [a.personBen, PLAN_ADA],
        ),
      ),
    ).rejects.toThrow(/care_plan_section_plan_fk/);
  });
});

describe("hazard HZ-017 assessments, activities and visits are append-only", () => {
  it.each([
    ["update an assessment", "UPDATE assessment SET score = 9"],
    ["delete an assessment", "DELETE FROM assessment"],
    ["update an activity", "UPDATE activity_record SET activity = 'changed'"],
    ["delete a visit", "DELETE FROM visit_log"],
    ["update a visit", "UPDATE visit_log SET visitor_name = 'changed'"],
  ])("refuses to %s", async (_label, statement) => {
    await expect(asManager((c) => c.query(statement))).rejects.toThrow(/permission denied/);
  });

  it("blocks even the owner role with the append-only trigger", async () => {
    await expect(
      inContext(db.pool("harbour_owner"), ctx(TENANT_A, null, "tenant"), (c) =>
        c.query("UPDATE assessment SET band = 'high'"),
      ),
    ).rejects.toThrow(/append-only/);
  });

  it("records a correction that supersedes the original, with a reason, for the same person", async () => {
    const rows = await asManager(async (c) => {
      await c.query(
        `INSERT INTO assessment (person_id, location_id, occurred_at, tool_key, tool_version, answers, score, band, supersedes_id, correction_reason)
         VALUES ($1, $2, now(), 'must', 'bapen-2011', '{}', 1, 'medium', $3, 'Wrong height entered')`,
        [a.personAda, a.locationNorth, ASSESSMENT_ADA],
      );
      const { rows } = await c.query<{ band: string; supersedes_id: string | null }>(
        "SELECT band, supersedes_id FROM assessment WHERE person_id = $1 ORDER BY recorded_at, band",
        [a.personAda],
      );
      return rows;
    });
    expect(rows).toEqual([
      { band: "low", supersedes_id: null },
      { band: "medium", supersedes_id: ASSESSMENT_ADA },
    ]);
  });

  it.each([
    [
      "without a reason",
      `INSERT INTO assessment (person_id, location_id, occurred_at, tool_key, tool_version, answers, supersedes_id)
       VALUES ($1, $2, now(), 'must', 'bapen-2011', '{}', $3)`,
      a.personAda,
      /assessment_correction_reason/,
    ],
    [
      "for another person",
      `INSERT INTO assessment (person_id, location_id, occurred_at, tool_key, tool_version, answers, supersedes_id, correction_reason)
       VALUES ($1, $2, now(), 'must', 'bapen-2011', '{}', $3, 'Wrong person')`,
      a.personBen,
      /assessment_supersedes_fk/,
    ],
  ])("refuses a correction %s", async (_label, statement, personId, error) => {
    await expect(
      asManager((c) => c.query(statement, [personId, a.locationNorth, ASSESSMENT_ADA])),
    ).rejects.toThrow(error);
  });

  it("accepts a device-generated visit id once and ignores a replayed upload", async () => {
    const id = "0193a000-0000-7000-8000-00000000beef";
    const count = await inContext(app(), ctx(TENANT_A, a.carer, "assigned"), async (c) => {
      for (let i = 0; i < 2; i++) {
        await c.query(
          `INSERT INTO visit_log (id, person_id, location_id, occurred_at, kind, visitor_name)
           VALUES ($1, $2, $3, now(), 'visit_out', 'Visitor Example') ON CONFLICT (id) DO NOTHING`,
          [id, a.personAda, a.locationNorth],
        );
      }
      const { rows } = await c.query("SELECT id FROM visit_log WHERE id = $1", [id]);
      return rows.length;
    });
    expect(count).toBe(1);
  });
});

describe("integrity rules in the database", () => {
  it("hazard HZ-015 only one advance care record of each kind is active", async () => {
    const insertDnacpr = (c: pg.PoolClient) =>
      c.query(
        `INSERT INTO advance_care_record (person_id, kind, cpr_decision, clinician_name, clinician_role, completed_on)
         VALUES ($1, 'dnacpr', 'do_not_attempt_cpr', 'Dr Example', 'GP', '2026-10-05')`,
        [a.personAda],
      );
    await expect(asManager(insertDnacpr)).rejects.toThrow(/advance_care_record_one_active/);
    // Superseding the active record first makes room for the new one, and both stay readable.
    const statuses = await asManager(async (c) => {
      await c.query(
        `UPDATE advance_care_record SET status = 'superseded'
         WHERE person_id = $1 AND kind = 'dnacpr' AND status = 'active'`,
        [a.personAda],
      );
      await insertDnacpr(c);
      const { rows } = await c.query<{ status: string }>(
        "SELECT status FROM advance_care_record WHERE person_id = $1 AND kind = 'dnacpr' ORDER BY status",
        [a.personAda],
      );
      return rows.map((r) => r.status);
    });
    expect(statuses).toEqual(["active", "superseded"]);
  });

  it.each([
    [
      "a DNACPR that says attempt CPR",
      `INSERT INTO advance_care_record (person_id, kind, cpr_decision, completed_on)
       VALUES ($1, 'dnacpr', 'attempt_cpr', '2026-10-01')`,
      /advance_care_record_cpr/,
    ],
    [
      "a ReSPECT plan with no CPR recommendation",
      `INSERT INTO advance_care_record (person_id, kind, completed_on) VALUES ($1, 'respect', '2026-10-01')`,
      /advance_care_record_cpr/,
    ],
    [
      "a second active care plan",
      `INSERT INTO care_plan (person_id, location_id, status, published_version)
       VALUES ($1, '${a.locationNorth}', 'active', 2)`,
      /care_plan_one_active/,
    ],
    [
      "an active plan with no published version",
      `INSERT INTO care_plan (person_id, location_id, status) VALUES ($1, '${a.locationNorth}', 'superseded')`,
      /care_plan_published/,
    ],
    [
      "a sign-off by a representative with no authority",
      `INSERT INTO care_plan (person_id, location_id, sign_off_kind, sign_off_representative_name)
       VALUES ($1, '${a.locationNorth}', 'representative', 'Eve Example')`,
      /care_plan_sign_off/,
    ],
    [
      "a care plan section outside the 16 domains",
      `INSERT INTO care_plan_section (person_id, plan_id, domain) VALUES ($1, '${PLAN_ADA}', 'astrology')`,
      /care_plan_section_domain/,
    ],
    [
      "a risk rating that is not likelihood times severity",
      `INSERT INTO risk_assessment (person_id, template_key, template_version, hazard, who_at_risk,
         likelihood, severity, risk_rating, assessed_on, review_due_on)
       VALUES ($1, 'choking', 'harbour-2026-10', 'Choking', 'Ada', 2, 2, 5, '2026-10-11', '2026-11-11')`,
      /risk_assessment_rating/,
    ],
    [
      "a task-generating action with no schedule",
      `INSERT INTO care_plan_action (person_id, plan_id, section_id, action, generates_tasks)
       VALUES ($1, '${PLAN_ADA}', '${SECTION_ADA}', 'Turn', true)`,
      /care_plan_action_schedule/,
    ],
    [
      "a visit restriction without a reason",
      `INSERT INTO visit_log (person_id, location_id, occurred_at, kind, visitor_name, restrictions_applied)
       VALUES ($1, '${a.locationNorth}', now(), 'facilitated_visit', 'Visitor Example', true)`,
      /visit_log_restriction_reason/,
    ],
    [
      "a group activity with no session",
      `INSERT INTO activity_record (person_id, location_id, occurred_at, activity, format, attendance)
       VALUES ($1, '${a.locationNorth}', now(), 'Quiz', 'group', 'attended')`,
      /activity_record_group_session/,
    ],
  ])("refuses %s", async (_label, statement, error) => {
    await expect(asManager((c) => c.query(statement, [a.personAda]))).rejects.toThrow(error);
  });

  it("keeps the database list of need domains in step with the domain package", async () => {
    const { rows } = await db
      .pool("harbour_owner")
      .query<{ def: string }>(
        `SELECT pg_get_constraintdef(oid) AS def FROM pg_constraint WHERE conname = 'care_plan_section_domain'`,
      );
    const listed = [...(rows[0]?.def ?? "").matchAll(/'([a-z_]+)'/g)].map((m) => m[1]);
    expect(listed).toEqual([...PCSP_DOMAINS]);
  });

  it("versions a care plan change into record_version", async () => {
    const result = await asManager(async (c) => {
      await c.query("UPDATE care_plan SET review_due_on = '2026-10-20' WHERE id = $1", [PLAN_ADA]);
      const plan = await c.query<{ version: number }>(
        "SELECT version FROM care_plan WHERE id = $1",
        [PLAN_ADA],
      );
      const history = await c.query<{ record_version: number }>(
        "SELECT record_version FROM record_version WHERE table_name = 'care_plan' AND record_id = $1",
        [PLAN_ADA],
      );
      return { version: plan.rows[0]?.version, history: history.rows.map((r) => r.record_version) };
    });
    expect(result).toEqual({ version: 2, history: [1] });
  });
});
