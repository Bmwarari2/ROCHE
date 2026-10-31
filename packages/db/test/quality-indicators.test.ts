import { phase2Indicators, QUALITY_INDICATOR_KEYS } from "@harbour/domain";
import type pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { QUALITY_INDICATOR_HIGHER_IS_BETTER, QUALITY_INDICATOR_KEY_CODES } from "../src/schema";
import { createTestDatabase, type TestDatabase } from "./support/database";
import { ctx, ids, inContext, seedTwoTenants, TENANT_A, TENANT_B } from "./support/fixtures";

/**
 * The quality dashboard in the database (QUAL-005, QUAL-006; quality.md section 22; migration
 * 0108; hazards HZ-011 and HZ-129). Targets are read by holders of quality.audit.manage and written
 * where they hold it; the counting function is called only by a holder at the location, counts
 * every record there whoever it involves, takes UK days, and returns numbers only.
 */

let db: TestDatabase;
const a = ids.a;
const ROLE_QUALITY = "0199f000-0000-7000-8000-000000000c01";
const ROLE_HOME = "0199f000-0000-7000-8000-000000000c02";
const ROOM_NORTH = "0199f000-0000-7000-8000-000000000c11";
const ROOM_SOUTH = "0199f000-0000-7000-8000-000000000c12";
const app = () => db.pool("harbour_app");
const as =
  (userId: string | null, tenant = TENANT_A, scope: "tenant" | "locations" = "tenant") =>
  <T>(fn: (c: pg.PoolClient) => Promise<T>) =>
    inContext(
      app(),
      ctx(tenant, userId, scope, scope === "locations" ? [a.locationNorth] : []),
      fn,
    );
const asQualityLead = as(a.manager);
const asHomeManager = as(a.northManager, TENANT_A, "locations");
const asCarer = as(a.carer);
const asOther = as(ids.b.manager, TENANT_B);
const ownerDb = <T>(fn: (c: pg.PoolClient) => Promise<T>) =>
  inContext(db.pool("harbour_owner"), ctx(TENANT_A, null, "tenant"), fn);

const SEPTEMBER = ["2026-09-01", "2026-09-30"] as const;
const counts = (
  location: string,
  from: string = SEPTEMBER[0],
  to: string = SEPTEMBER[1],
  targetDays = 2,
) => `SELECT app.quality_indicator_counts('${location}', '${from}', '${to}', ${targetDays}) AS c`;

async function incident(
  c: pg.PoolClient,
  location: string,
  type: string,
  occurredAt: string,
  people: readonly string[] = [],
  recordedAt = occurredAt,
): Promise<string> {
  const { rows } = await c.query<{ id: string }>(
    `INSERT INTO incident (location_id, type, occurred_at, recorded_at, description, raised_by, person_ids)
     VALUES ($1, $2, $3, $4, 'Fixture incident', $5, $6) RETURNING id`,
    [location, type, occurredAt, recordedAt, a.manager, people],
  );
  return rows[0]?.id ?? "";
}

async function leftOpen(c: pg.PoolClient, incidentId: string, at: string): Promise<void> {
  const { rows } = await c.query<{ id: string }>(
    `INSERT INTO workflow_instance (definition_key, definition_version, subject_type, subject_id, state)
     VALUES ('safety.incident', 1, 'incident', $1, 'under_review') RETURNING id`,
    [incidentId],
  );
  await c.query(
    `INSERT INTO workflow_transition (instance_id, from_state, to_state, occurred_at)
     VALUES ($1, 'open', 'under_review', $2)`,
    [rows[0]?.id, at],
  );
}

async function mark(
  c: pg.PoolClient,
  location: string,
  occurredAt: string,
  markType: string,
  supersedes: string | null = null,
  status = "present",
): Promise<string> {
  const { rows } = await c.query<{ id: string }>(
    `INSERT INTO body_map_mark (person_id, location_id, occurred_at, view, region, side, mark_type,
       status, supersedes_id, correction_reason, created_by)
     VALUES ($1, $2, $3, 'back', 'sacrum', 'centre', $4, $5, $6, $7, $8) RETURNING id`,
    [
      a.personAda,
      location,
      occurredAt,
      markType,
      status,
      supersedes,
      supersedes && status === "present" ? "Recorded as the wrong kind of mark" : null,
      a.carer,
    ],
  );
  return rows[0]?.id ?? "";
}

beforeAll(async () => {
  db = await createTestDatabase();
  await seedTwoTenants(db.pool("harbour_owner"));
  await ownerDb(async (c) => {
    await c.query(
      `INSERT INTO role (id, key, name, scope_kind, permissions) VALUES
         ($1, 'quality_lead_test', 'Quality lead', 'tenant', '{quality.audit.manage}'),
         ($2, 'home_manager_test', 'Home manager', 'location', '{quality.audit.manage}')`,
      [ROLE_QUALITY, ROLE_HOME],
    );
    await c.query("INSERT INTO role_assignment (tenant_user_id, role_id) VALUES ($1, $2)", [
      a.manager,
      ROLE_QUALITY,
    ]);
    await c.query(
      "INSERT INTO role_assignment (tenant_user_id, role_id, location_id) VALUES ($1, $2, $3)",
      [a.northManager, ROLE_HOME, a.locationNorth],
    );

    // Falls: two in September at North (one involving Cara, who lives at South), one in August,
    // one at South, and one on the evening of 30 September UTC that is 1 October in the UK.
    await incident(c, a.locationNorth, "fall", "2026-09-03T10:00:00Z", [a.personAda]);
    await incident(c, a.locationNorth, "fall", "2026-09-20T10:00:00Z", [a.personCara]);
    await incident(c, a.locationNorth, "fall", "2026-08-31T10:00:00Z", [a.personAda]);
    await incident(c, a.locationSouth, "fall", "2026-09-10T10:00:00Z", [a.personCara]);
    await incident(c, a.locationNorth, "fall", "2026-09-30T23:30:00Z", [a.personAda]);
    // Incident response: reviewed in time, reviewed late, and one never reviewed (its time is up).
    const inTime = await incident(c, a.locationNorth, "medication", "2026-09-05T09:00:00Z");
    await leftOpen(c, inTime, "2026-09-06T09:00:00Z");
    const late = await incident(c, a.locationNorth, "environmental", "2026-09-05T09:00:00Z");
    await leftOpen(c, late, "2026-09-15T09:00:00Z");
    await incident(c, a.locationNorth, "environmental", "2026-09-07T09:00:00Z");

    // Pressure ulcers: one new and later healed (counts once), one corrected to a bruise (not
    // counted), one at South.
    const ulcer = await mark(c, a.locationNorth, "2026-09-04T08:00:00Z", "pressure_ulcer");
    await mark(c, a.locationNorth, "2026-09-25T08:00:00Z", "pressure_ulcer", ulcer, "healed");
    const wrong = await mark(c, a.locationNorth, "2026-09-08T08:00:00Z", "pressure_ulcer");
    await mark(c, a.locationNorth, "2026-09-08T09:00:00Z", "bruise", wrong);
    await mark(c, a.locationSouth, "2026-09-09T08:00:00Z", "pressure_ulcer");

    // Bed-days: Ada at North from 11 September (20 days of September), Cara at South all month.
    await c.query(
      `INSERT INTO room (id, location_id, label, beds) VALUES ($1, $3, 'N1', 1), ($2, $4, 'S1', 1)`,
      [ROOM_NORTH, ROOM_SOUTH, a.locationNorth, a.locationSouth],
    );
    await c.query(
      `INSERT INTO bed_occupancy (person_id, room_id, bed, from_date, reason) VALUES
         ($1, $3, 1, '2026-09-11', 'Admission'), ($2, $4, 1, '2026-08-01', 'Admission')`,
      [a.personAda, a.personCara, ROOM_NORTH, ROOM_SOUTH],
    );

    // Reviews at North today: a care plan overdue and a risk assessment not yet due.
    await c.query(
      `INSERT INTO care_plan (person_id, location_id, status, published_version, review_due_on)
       VALUES ($1, $2, 'active', 1, (now() AT TIME ZONE 'Europe/London')::date - 3)`,
      [a.personAda, a.locationNorth],
    );
    await c.query(
      `INSERT INTO risk_assessment (person_id, template_key, template_version, hazard, who_at_risk,
         likelihood, severity, risk_rating, risk_band, controls, assessed_on, review_due_on)
       VALUES ($1, 'moving_and_handling', 'harbour-2026-10', 'Transfers', 'The person and staff',
         3, 4, 12, 'high', '{"Hoist"}', '2026-09-11',
         (now() AT TIME ZONE 'Europe/London')::date + 30)`,
      [a.personBen],
    );
  });
}, 120_000);

afterAll(async () => {
  await db?.drop();
});

describe("hazard HZ-011 quality indicator targets (migration 0108)", () => {
  it("keeps the indicator keys and their directions in step with the domain", () => {
    expect([...QUALITY_INDICATOR_KEY_CODES]).toEqual([...QUALITY_INDICATOR_KEYS]);
    const higher = phase2Indicators({ bedDaysBase: 1000 })
      .filter((d) => d.direction === "higher_is_better")
      .map((d) => d.key);
    expect([...QUALITY_INDICATOR_HIGHER_IS_BETTER]).toEqual(higher);
  });

  const TARGET =
    "INSERT INTO quality_indicator_target (location_id, indicator_key, green, amber) VALUES ($1, $2, $3, $4) RETURNING id";

  it("are set where the member holds quality.audit.manage, and versioned", async () => {
    const { rows } = await asQualityLead((c) =>
      c.query<{ id: string }>(TARGET, [null, "falls", 5, 8]),
    );
    await asHomeManager((c) => c.query(TARGET, [a.locationNorth, "falls", 4, 6]));
    await asQualityLead((c) =>
      c.query("UPDATE quality_indicator_target SET amber = 9 WHERE id = $1", [rows[0]?.id]),
    );
    const after = await asQualityLead((c) =>
      c.query("SELECT version, amber FROM quality_indicator_target WHERE id = $1", [rows[0]?.id]),
    );
    expect(after.rows).toEqual([{ version: 2, amber: "9" }]);
  });

  it("refuses a home manager the organisation default and another home's target", async () => {
    await expect(
      asHomeManager((c) => c.query(TARGET, [null, "pressure_ulcers", 1, 2])),
    ).rejects.toThrow(/row-level security/);
    await expect(
      asHomeManager((c) => c.query(TARGET, [a.locationSouth, "falls", 1, 2])),
    ).rejects.toThrow(/row-level security/);
  });

  it("shows a member without the permission and another organisation nothing", async () => {
    expect(
      (await asCarer((c) => c.query("SELECT id FROM quality_indicator_target"))).rowCount,
    ).toBe(0);
    expect(
      (await asOther((c) => c.query("SELECT id FROM quality_indicator_target"))).rowCount,
    ).toBe(0);
    expect(
      (await asHomeManager((c) => c.query("SELECT id FROM quality_indicator_target"))).rowCount,
    ).toBe(2);
  });

  it("keeps green and amber in the indicator's direction, one live target each, never deleted", async () => {
    await expect(
      asQualityLead((c) => c.query(TARGET, [a.locationSouth, "falls", 9, 2])),
    ).rejects.toThrow(/quality_indicator_target_direction/);
    await asQualityLead((c) => c.query(TARGET, [a.locationSouth, "training_compliance", 95, 85]));
    await expect(asQualityLead((c) => c.query(TARGET, [null, "falls", 1, 2]))).rejects.toThrow(
      /quality_indicator_target_organisation_key/,
    );
    await expect(
      asQualityLead((c) => c.query("DELETE FROM quality_indicator_target")),
    ).rejects.toThrow(/permission denied/);
    await expect(
      asQualityLead((c) =>
        c.query(
          "UPDATE quality_indicator_target SET indicator_key = 'complaints' WHERE indicator_key = 'falls'",
        ),
      ),
    ).rejects.toThrow(/quality_indicator_target_fixed_fields/);
  });

  it("is cleared once and then left alone", async () => {
    const { rows } = await asQualityLead((c) =>
      c.query<{ id: string }>(TARGET, [a.locationSouth, "complaints", 0, 3]),
    );
    await asQualityLead((c) =>
      c.query("UPDATE quality_indicator_target SET deleted_at = now() WHERE id = $1", [
        rows[0]?.id,
      ]),
    );
    await expect(
      asQualityLead((c) =>
        c.query("UPDATE quality_indicator_target SET green = 1 WHERE id = $1", [rows[0]?.id]),
      ),
    ).rejects.toThrow(/quality_indicator_target_cleared/);
    await asQualityLead((c) => c.query(TARGET, [a.locationSouth, "complaints", 0, 4]));
  });
});

describe("hazard HZ-129 the quality dashboard's counts (migration 0108)", () => {
  type Counts = Record<string, number | string>;
  const north = async (as_ = asQualityLead, from?: string, to?: string) =>
    (await as_((c) => c.query<{ c: Counts }>(counts(a.locationNorth, from, to)))).rows[0]?.c ?? {};

  it("counts the location's records in the period, in UK days", async () => {
    const result = await north();
    expect(result).toMatchObject({
      falls: 2,
      medicationErrors: 1,
      incidents: 5,
      pressureUlcers: 1,
      bedDays: 20,
      reviewsDue: 2,
      reviewsOverdue: 1,
      // The two falls count too: recorded in September, never reviewed, their time is up.
      incidentsDecided: 5,
      incidentsReviewedInTime: 1,
    });
  });

  it("counts every incident at the location, whoever the home manager may see", async () => {
    // Cara lives at South, so the home manager's own view of incidents leaves her fall out.
    const seen = await asHomeManager((c) =>
      c.query(
        "SELECT count(*)::int AS n FROM incident WHERE type = 'fall' AND location_id = $1 AND occurred_at >= '2026-09-01' AND occurred_at < '2026-09-30T23:00:00Z'",
        [a.locationNorth],
      ),
    );
    expect(seen.rows[0]?.n).toBe(1);
    expect((await north(asHomeManager)).falls).toBe(2);
  });

  it("returns numbers and dates only, never a row or an id", async () => {
    const result = await north();
    for (const [key, value] of Object.entries(result)) {
      if (key === "since" || key === "today") expect(value).toMatch(/^\d{4}-\d{2}-\d{2}$/);
      else expect(typeof value).toBe("number");
    }
  });

  it.each<[string, () => Promise<unknown>]>([
    [
      "a member without quality.audit.manage",
      () => asCarer((c) => c.query(counts(a.locationNorth))),
    ],
    [
      "a home manager for another home",
      () => asHomeManager((c) => c.query(counts(a.locationSouth))),
    ],
    [
      "another organisation's member for this organisation's home",
      () => asOther((c) => c.query(counts(a.locationNorth))),
    ],
    ["the system, with no member", () => as(null)((c) => c.query(counts(a.locationNorth)))],
  ])("refuses %s", async (_name, call) => {
    await expect(call()).rejects.toThrow(/quality_counts_(refused|no_member)/);
  });

  it.each<[string, string, string, number]>([
    ["a period that ends before it starts", "2026-09-30", "2026-09-01", 2],
    ["a period longer than 366 days", "2025-01-01", "2026-09-30", 2],
    ["a negative target", "2026-09-01", "2026-09-30", -1],
  ])("refuses %s", async (_name, from, to, days) => {
    await expect(
      asQualityLead((c) => c.query(counts(a.locationNorth, from, to, days))),
    ).rejects.toThrow(/quality_counts_invalid/);
  });

  it("is not executable by the owner role or by PUBLIC", async () => {
    const { rows } = await ownerDb((c) =>
      c.query<{ app: boolean; owner: boolean }>(
        `SELECT has_function_privilege('harbour_app', 'app.quality_indicator_counts(uuid, date, date, integer)', 'EXECUTE') AS app,
                has_function_privilege('harbour_auth', 'app.quality_indicator_counts(uuid, date, date, integer)', 'EXECUTE') AS owner`,
      ),
    );
    expect(rows[0]).toEqual({ app: true, owner: false });
  });
});
