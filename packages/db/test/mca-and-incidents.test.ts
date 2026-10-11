import {
  CLASSIFIER_QUESTION_KEYS,
  CONSENT_DECISION_KINDS,
  INCIDENT_TYPES,
  STATUTORY_NOTIFICATION_KINDS,
} from "@harbour/domain";
import type pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createTestDatabase, type TestDatabase } from "./support/database";
import { ctx, ids, inContext, seedTwoTenants, TENANT_A, TENANT_B } from "./support/fixtures";

/**
 * Slice 6 (consent, capacity, best interests, DoLS) and slice 7 (incidents, statutory
 * notifications, candour, investigations) in the database: person scope and the incident scope of
 * ADR-0033 (HZ-011), append-only answers and assessments (HZ-017), separation of duties on close
 * (HZ-013) and the integrity rules behind the API.
 *
 * Fixture: Ada and Ben live at North (the care worker is assigned to Ada only), Cara at South.
 */

let db: TestDatabase;
const a = ids.a;

const ASSESSMENT_ADA = "0193a000-0000-7000-8000-00000000d001";
const DOLS_ADA = "0193a000-0000-7000-8000-00000000d101";
/** Ada and Ben together at North. */
const INCIDENT_ADA_BEN = "0193a000-0000-7000-8000-00000000e001";
/** Ben alone at North. */
const INCIDENT_BEN = "0193a000-0000-7000-8000-00000000e002";
/** Nobody using the service: a utility failure at North. */
const INCIDENT_NO_PERSON = "0193a000-0000-7000-8000-00000000e003";
/** Cara (a South resident) hurt while visiting North. */
const INCIDENT_CARA_AT_NORTH = "0193a000-0000-7000-8000-00000000e004";
/** Raised by the care worker, involving nobody using the service. */
const INCIDENT_BY_CARER = "0193a000-0000-7000-8000-00000000e005";

const MCA_TABLES = [
  "consent_record",
  "capacity_assessment",
  "best_interests_decision",
  "dols_authorisation",
  "dols_legal_change_review",
] as const;

const CHECKLIST = JSON.stringify(
  Object.fromEntries(
    [
      "no_unjustified_assumptions",
      "relevant_circumstances",
      "regaining_capacity",
      "participation",
      "life_sustaining_treatment",
      "wishes_and_feelings",
      "beliefs_and_values",
      "other_factors",
      "views_of_others",
      "less_restrictive_option",
    ].map((k) => [k, { answer: "considered", note: "Talked it through with the family." }]),
  ),
);

async function seedMca(c: pg.PoolClient) {
  for (const [personId, locationId] of [
    [a.personAda, a.locationNorth],
    [a.personBen, a.locationNorth],
    [a.personCara, a.locationSouth],
  ] as const) {
    const assessmentId = personId === a.personAda ? ASSESSMENT_ADA : crypto.randomUUID();
    await c.query(
      `INSERT INTO capacity_assessment (id, person_id, decision, decision_kind, assessed_at,
         assessor_tenant_user_id, practicable_steps, stage1_impairment, stage1_description, stage2,
         inability_because_of_impairment, outcome, unable_to, reason)
       VALUES ($1, $2, 'whether to have bed rails at night', 'bed_rails', now() - interval '1 day',
         $3, '[{"step":"simple_language","detail":"Short sentences"}]', true, 'Dementia',
         '{"understand":{"able":false,"evidence":"Could not repeat the risks"}}', true,
         'lacks_capacity', '{understand}', 'Lacks capacity for this decision')`,
      [assessmentId, personId, a.manager],
    );
    const bi = await c.query<{ id: string }>(
      `INSERT INTO best_interests_decision (person_id, capacity_assessment_id, decision, decided_at,
         checklist, consultations, review_on)
       VALUES ($1, $2, 'Bed rails with bumpers at night', now(), $3,
         '[{"consultee":"family_or_friend","views":"Agrees","consultedAt":"2026-10-10T10:00:00Z"}]',
         '2027-01-10') RETURNING id`,
      [personId, assessmentId, CHECKLIST],
    );
    await c.query(
      `INSERT INTO consent_record (person_id, decision, outcome, given_by_kind, capacity_status,
         capacity_assessment_id, given_at, evidence, best_interests_decision_id)
       VALUES ($1, 'covert_medicines', 'given', 'person', 'lacks_capacity', $2, now(),
         'Best-interests meeting with the GP and pharmacist', $3)`,
      [personId, assessmentId, bi.rows[0]?.id],
    );
    const dols = await c.query<{ id: string }>(
      `INSERT INTO dols_authorisation (id, person_id, location_id, type, nation, requested_at, outcome,
         outcome_at, granted_from, granted_to)
       VALUES ($1, $2, $3, 'standard', 'england', '2026-03-01', 'granted', '2026-03-20',
         '2026-03-20', '2027-03-20') RETURNING id`,
      [personId === a.personAda ? DOLS_ADA : crypto.randomUUID(), personId, locationId],
    );
    await c.query(
      `INSERT INTO dols_legal_change_review (person_id, dols_authorisation_id) VALUES ($1, $2)`,
      [personId, dols.rows[0]?.id],
    );
  }
}

async function incidentWith(
  c: pg.PoolClient,
  id: string,
  locationId: string,
  people: readonly string[],
  raisedBy: string = a.manager,
) {
  await c.query(
    `INSERT INTO incident (id, location_id, type, occurred_at, description, raised_by, person_ids)
     VALUES ($1, $2, $3, now() - interval '1 hour', 'Fixture incident', $4, $5)`,
    [id, locationId, people.length > 0 ? "fall" : "environmental", raisedBy, people],
  );
  for (const personId of people) {
    await c.query(
      `INSERT INTO incident_person (incident_id, kind, role, person_id, injury_details)
       VALUES ($1, 'service_user', 'affected', $2, 'Graze to the left forearm')`,
      [id, personId],
    );
    await c.query(
      `INSERT INTO statutory_notification (location_id, incident_id, person_id, source_key, kind,
         due_at, retention_class)
       VALUES ($1, $2, $3, $4, 'cqc_reg16_death', now(), 'serious_incident')`,
      [locationId, id, personId, `incident:${id}:cqc_reg16_death:${personId}`],
    );
  }
  // A member of staff witnessed every incident, and every incident has an incident-wide draft.
  await c.query(
    `INSERT INTO incident_person (incident_id, kind, role, tenant_user_id)
     VALUES ($1, 'worker', 'witness', $2)`,
    [id, a.northManager],
  );
  await c.query(
    `INSERT INTO statutory_notification (location_id, incident_id, source_key, kind, due_at,
       retention_class)
     VALUES ($1, $2, $3, 'cqc_reg18_police', now(), 'serious_incident')`,
    [locationId, id, `incident:${id}:cqc_reg18_police`],
  );
  await c.query(
    `INSERT INTO classifier_answer (incident_id, question_key, value, answered_by)
     VALUES ($1, 'police.involved', '"yes"', $2)`,
    [id, a.manager],
  );
  await c.query("INSERT INTO candour_record (incident_id) VALUES ($1)", [id]);
  await c.query("INSERT INTO investigation (incident_id) VALUES ($1)", [id]);
}

beforeAll(async () => {
  db = await createTestDatabase();
  await seedTwoTenants(db.pool("harbour_owner"));
  await inContext(db.pool("harbour_owner"), ctx(TENANT_A, null, "tenant"), async (c) => {
    await seedMca(c);
    await incidentWith(c, INCIDENT_ADA_BEN, a.locationNorth, [a.personAda, a.personBen]);
    await incidentWith(c, INCIDENT_BEN, a.locationNorth, [a.personBen]);
    await incidentWith(c, INCIDENT_NO_PERSON, a.locationNorth, []);
    await incidentWith(c, INCIDENT_CARA_AT_NORTH, a.locationNorth, [a.personCara]);
    await incidentWith(c, INCIDENT_BY_CARER, a.locationNorth, [], a.carer);
    // An outbreak found across South's cases: a location-level draft.
    await c.query(
      `INSERT INTO statutory_notification (location_id, source_key, kind, due_at, retention_class)
       VALUES ($1, 'outbreak:south', 'ukhsa_outbreak', now(), 'serious_incident')`,
      [a.locationSouth],
    );
  });
});

afterAll(async () => {
  await db?.drop();
});

const app = () => db.pool("harbour_app");
const asManager = <T>(fn: (c: pg.PoolClient) => Promise<T>) =>
  inContext(app(), ctx(TENANT_A, a.manager, "tenant"), fn);
const carer = ctx(TENANT_A, a.carer, "assigned");
const north = ctx(TENANT_A, a.northManager, "locations", [a.locationNorth]);
const south = ctx(TENANT_A, a.northManager, "locations", [a.locationSouth]);

async function rows(context: ReturnType<typeof ctx>, statement: string): Promise<string[]> {
  return inContext(app(), context, async (c) => {
    const result = await c.query<{ v: string }>(statement);
    return result.rows.map((r) => r.v).sort();
  });
}

describe("hazard HZ-011 consent, capacity and DoLS records follow the person's scope", () => {
  it.each(MCA_TABLES)("%s shows each user only the people in their scope", async (table) => {
    const query = `SELECT DISTINCT person_id AS v FROM ${table}`;
    expect(await rows(carer, query)).toEqual([a.personAda]);
    expect(await rows(north, query)).toEqual([a.personAda, a.personBen].sort());
    expect(await rows(ctx(TENANT_B, ids.b.manager, "tenant"), query)).toEqual([]);
  });

  it("stops a care worker writing a consent for someone outside their scope", async () => {
    await expect(
      inContext(app(), carer, (c) =>
        c.query(
          `INSERT INTO consent_record (person_id, decision, outcome, given_by_kind, capacity_status,
             given_at, evidence)
           VALUES ($1, 'photos', 'given', 'person', 'assumed', now(), 'Asked in person')`,
          [a.personBen],
        ),
      ),
    ).rejects.toThrow(/row-level security/);
  });
});

describe("hazard HZ-011 incident scope across people and locations (ADR-0033)", () => {
  const incidents = "SELECT id::text AS v FROM incident";

  it("shows a care worker the incidents about their people and the ones they raised", async () => {
    expect(await rows(carer, incidents)).toEqual([INCIDENT_ADA_BEN, INCIDENT_BY_CARER].sort());
  });

  it("shows a location manager incidents about their people and person-free incidents there", async () => {
    expect(await rows(north, incidents)).toEqual(
      [INCIDENT_ADA_BEN, INCIDENT_BEN, INCIDENT_NO_PERSON, INCIDENT_BY_CARER].sort(),
    );
  });

  it("follows the person, not the place: Cara's incident at North is visible to South only", async () => {
    expect(await rows(north, incidents)).not.toContain(INCIDENT_CARA_AT_NORTH);
    expect(await rows(south, incidents)).toEqual([INCIDENT_CARA_AT_NORTH]);
  });

  it("shows tenant-wide roles everything and another tenant nothing", async () => {
    expect(await rows(ctx(TENANT_A, a.manager, "tenant"), incidents)).toHaveLength(5);
    expect(await rows(ctx(TENANT_B, ids.b.manager, "tenant"), incidents)).toEqual([]);
  });

  it("shows only the people in scope on an incident involving several people", async () => {
    const people = `SELECT coalesce(person_id::text, kind) AS v FROM incident_person
                    WHERE incident_id = '${INCIDENT_ADA_BEN}'`;
    expect(await rows(carer, people)).toEqual([a.personAda]);
    // Staff witnesses follow the incident's location, so the North manager sees the witness too.
    expect(await rows(north, people)).toEqual([a.personAda, a.personBen, "worker"].sort());
  });

  it("shows notifications about a person only to those who can see that person", async () => {
    const notifications = `SELECT coalesce(person_id::text, kind) AS v FROM statutory_notification
                           WHERE incident_id = '${INCIDENT_ADA_BEN}'`;
    expect(await rows(carer, notifications)).toEqual([a.personAda, "cqc_reg18_police"].sort());
    expect(await rows(north, notifications)).toEqual(
      [a.personAda, a.personBen, "cqc_reg18_police"].sort(),
    );
  });

  it("gives location-level drafts (an outbreak) location scope", async () => {
    const outbreak = "SELECT kind AS v FROM statutory_notification WHERE incident_id IS NULL";
    expect(await rows(south, outbreak)).toEqual(["ukhsa_outbreak"]);
    expect(await rows(north, outbreak)).toEqual([]);
    expect(await rows(carer, outbreak)).toEqual([]);
  });

  it.each([["classifier_answer"], ["candour_record"], ["investigation"]])(
    "lets %s follow the incident",
    async (table) => {
      const query = `SELECT incident_id::text AS v FROM ${table}`;
      expect(await rows(carer, query)).toEqual([INCIDENT_ADA_BEN, INCIDENT_BY_CARER].sort());
      expect(await rows(south, query)).toEqual([INCIDENT_CARA_AT_NORTH]);
    },
  );

  it("stops a care worker adding someone outside their scope to an incident", async () => {
    await expect(
      inContext(app(), carer, (c) =>
        c.query(
          `INSERT INTO incident_person (incident_id, kind, role, person_id)
           VALUES ($1, 'service_user', 'involved', $2)`,
          [INCIDENT_ADA_BEN, a.personBen],
        ),
      ),
    ).rejects.toThrow(/row-level security/);
  });

  it("refuses a person on an incident who is not listed on it", async () => {
    await expect(
      asManager((c) =>
        c.query(
          `INSERT INTO incident_person (incident_id, kind, role, person_id)
           VALUES ($1, 'service_user', 'witness', $2)`,
          [INCIDENT_BEN, a.personAda],
        ),
      ),
    ).rejects.toThrow(/not listed on the incident/);
  });

  it("lets a care worker raise an incident about nobody and see it afterwards", async () => {
    const id = "0193a000-0000-7000-8000-00000000e0ff";
    const seen = await inContext(app(), carer, async (c) => {
      await c.query(
        `INSERT INTO incident (id, location_id, type, occurred_at, description)
         VALUES ($1, $2, 'environmental', now(), 'The hot water is off')`,
        [id, a.locationNorth],
      );
      const { rows } = await c.query<{ raised_by: string }>(
        "SELECT raised_by FROM incident WHERE id = $1",
        [id],
      );
      return rows[0]?.raised_by;
    });
    expect(seen).toBe(a.carer);
  });
});

describe("append-only answers and assessments", () => {
  it.each([
    ["update a classifier answer", `UPDATE classifier_answer SET value = '"no"'`],
    ["delete a classifier answer", "DELETE FROM classifier_answer"],
    ["update a capacity assessment", "UPDATE capacity_assessment SET outcome = 'has_capacity'"],
    ["delete a best-interests decision", "DELETE FROM best_interests_decision"],
    ["delete an incident", "DELETE FROM incident"],
    ["delete a consent", "DELETE FROM consent_record"],
  ])("hazard HZ-017 refuses to %s", async (_label, statement) => {
    await expect(asManager((c) => c.query(statement))).rejects.toThrow(/permission denied/);
  });

  it("blocks even the owner role with the append-only trigger", async () => {
    await expect(
      inContext(db.pool("harbour_owner"), ctx(TENANT_A, null, "tenant"), (c) =>
        c.query(`UPDATE classifier_answer SET value = '"no"'`),
      ),
    ).rejects.toThrow(/append-only/);
  });
});

describe("integrity rules in the database", () => {
  it("hazard HZ-013 refuses an incident closed by the person who raised it", async () => {
    await expect(
      asManager((c) =>
        c.query(
          `UPDATE incident SET status = 'closed', closed_by = raised_by, closed_at = now(),
             closed_reason = 'Done' WHERE id = $1`,
          [INCIDENT_ADA_BEN],
        ),
      ),
    ).rejects.toThrow(/incident_closed_by_other/);
  });

  it.each([
    [
      "a submitted notification without a reference or evidence",
      `UPDATE statutory_notification SET status = 'submitted', submitted_at = now(),
         submitted_by = '${a.manager}' WHERE kind = 'cqc_reg18_police'`,
      /statutory_notification_submitted/,
    ],
    [
      "a notification marked not required without a reason",
      `UPDATE statutory_notification SET status = 'not_required' WHERE kind = 'cqc_reg18_police'`,
      /statutory_notification_not_required/,
    ],
    [
      "a DoLS outcome notification without the authorisation",
      `INSERT INTO statutory_notification (location_id, person_id, source_key, kind, due_at, retention_class)
       VALUES ('${a.locationNorth}', '${a.personAda}', 'x', 'cqc_reg18_dols_outcome', now(), 'serious_incident')`,
      /statutory_notification_dols/,
    ],
    [
      "a second draft from the same source",
      `INSERT INTO statutory_notification (location_id, incident_id, source_key, kind, due_at, retention_class)
       VALUES ('${a.locationNorth}', '${INCIDENT_BEN}', 'incident:${INCIDENT_BEN}:cqc_reg18_police',
               'cqc_reg18_police', now(), 'serious_incident')`,
      /statutory_notification_source_key/,
    ],
    [
      "an incident of an unknown type",
      `INSERT INTO incident (location_id, type, occurred_at, description, raised_by)
       VALUES ('${a.locationNorth}', 'mishap', now(), 'x', '${a.manager}')`,
      /incident_type/,
    ],
    [
      "a 'lacks capacity' outcome the two-stage test does not support",
      `INSERT INTO capacity_assessment (person_id, decision, assessed_at, assessor_name,
         stage1_impairment, outcome, reason)
       VALUES ('${a.personAda}', 'photos', now(), 'Dr Example', false, 'lacks_capacity', 'x')`,
      /capacity_assessment_lacks/,
    ],
    [
      "a best-interests decision with no consultation and no reason",
      `INSERT INTO best_interests_decision (person_id, capacity_assessment_id, decision, decided_at,
         checklist, review_on)
       VALUES ('${a.personAda}', '${ASSESSMENT_ADA}', 'x', now(), '{}', '2027-01-01')`,
      /best_interests_decision_consultation/,
    ],
    [
      "a representative's consent with no representative named",
      `INSERT INTO consent_record (person_id, decision, outcome, given_by_kind, representative_kind,
         capacity_status, given_at, evidence)
       VALUES ('${a.personAda}', 'photos', 'given', 'representative', 'lpa_health_welfare',
               'assumed', now(), 'Asked')`,
      /consent_record_representative/,
    ],
    [
      "a consent that claims an assessment without naming it",
      `INSERT INTO consent_record (person_id, decision, outcome, given_by_kind, capacity_status,
         given_at, evidence)
       VALUES ('${a.personAda}', 'photos', 'given', 'person', 'has_capacity', now(), 'Asked')`,
      /consent_record_capacity/,
    ],
    [
      "a withdrawal without a reason",
      `UPDATE consent_record SET withdrawn_at = now() WHERE person_id = '${a.personAda}'`,
      /consent_record_withdrawn/,
    ],
    [
      "a DoLS authorisation in Scotland",
      `INSERT INTO dols_authorisation (person_id, location_id, type, nation, requested_at)
       VALUES ('${a.personAda}', '${a.locationNorth}', 'urgent', 'scotland', now())`,
      /dols_authorisation_nation/,
    ],
    [
      "a DoLS outcome without its date",
      `UPDATE dols_authorisation SET outcome_at = NULL WHERE id = '${DOLS_ADA}'`,
      /dols_authorisation_outcome/,
    ],
    [
      "a legal-change review referred without the referral",
      `UPDATE dols_legal_change_review SET state = 'referred', decision = 'in_doubt', decided_at = now()
       WHERE dols_authorisation_id = '${DOLS_ADA}'`,
      /dols_legal_change_review_referred/,
    ],
  ])("refuses %s", async (_label, statement, error) => {
    await expect(asManager((c) => c.query(statement))).rejects.toThrow(error);
  });

  it("versions an incident change into record_version", async () => {
    const result = await asManager(async (c) => {
      await c.query("UPDATE incident SET severity = 'minor' WHERE id = $1", [INCIDENT_BEN]);
      const { rows } = await c.query<{ version: number; history: number }>(
        `SELECT i.version, (SELECT count(*)::int FROM record_version r
           WHERE r.table_name = 'incident' AND r.record_id = i.id) AS history
         FROM incident i WHERE i.id = $1`,
        [INCIDENT_BEN],
      );
      return rows[0];
    });
    expect(result).toEqual({ version: 2, history: 1 });
  });

  it.each([
    ["consent_record_decision", CONSENT_DECISION_KINDS],
    ["incident_type", INCIDENT_TYPES],
    ["classifier_answer_question_key", CLASSIFIER_QUESTION_KEYS],
    ["statutory_notification_kind", STATUTORY_NOTIFICATION_KINDS],
  ] as const)("keeps %s in step with the domain package", async (constraint, expected) => {
    const { rows } = await db
      .pool("harbour_owner")
      .query<{ def: string }>(
        "SELECT pg_get_constraintdef(oid) AS def FROM pg_constraint WHERE conname = $1",
        [constraint],
      );
    const listed = [...(rows[0]?.def ?? "").matchAll(/'([a-z0-9_.]+)'/g)].map((m) => m[1]);
    expect(listed).toEqual([...expected]);
  });
});
