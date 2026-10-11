import { createHash, randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import {
  AUTHORITY_ROLES,
  BREAK_GLASS_REASON_CODES,
  BUILTIN_ROLES,
  CARE_PLAN_CHANGE_KINDS,
  FAMILY_INVOLVEMENT_KINDS,
  INFORMATION_SOURCES,
  PERSON_STATUSES,
  PROPERTY_CATEGORIES,
  PROPERTY_ITEM_STATUSES,
  ROOM_STATUSES,
  SHARING_BASES,
  SHARING_SECTIONS,
} from "@harbour/domain";
import type pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createTestDatabase, type TestDatabase } from "./support/database";
import { ctx, ids, inContext, seedTwoTenants, TENANT_A, TENANT_B } from "./support/fixtures";

/**
 * Slice 8 (the residential people lifecycle) in the database: every new table follows the
 * person's scope or its own (HZ-011), beds never hold two people and people never hold two beds
 * (HZ-001), decisions, reviews and weekly reports are append-only (HZ-017), share-link tokens are
 * stored hashed, the code lists match the domain, and existing tenants' role copies gain the new
 * permissions once.
 *
 * Fixture: Ada and Ben live at North (the care worker is assigned to Ada only), Cara at South.
 */

let db: TestDatabase;
const a = ids.a;

const ROOM_N1 = "0193a000-0000-7000-8000-00000000f001";
const ROOM_N2 = "0193a000-0000-7000-8000-00000000f002";
const ROOM_S1 = "0193a000-0000-7000-8000-00000000f003";
const ROOM_N3 = "0193a000-0000-7000-8000-00000000f004";
const DECISION_ADA = "0193a000-0000-7000-8000-00000000f101";

const PERSON_TABLES = [
  "pre_admission_assessment",
  "admission_decision",
  "admission_condition",
  "bed_occupancy",
  "welcome_checklist_item",
  "property_item",
  "key_issue",
  "care_plan_change",
  "review_record",
  "hospital_transfer",
  "exit_record",
  "exit_checklist_item",
  "sharing_decision",
  "about_me_share_link",
] as const;

const tokenHash = () => createHash("sha256").update(randomBytes(32)).digest("hex");

/** One row in every person table for one person. */
async function seedPerson(c: pg.PoolClient, personId: string, locationId: string, roomId: string) {
  const assessment = await c.query<{ id: string }>(
    `INSERT INTO pre_admission_assessment (person_id, service_id, placement_type_sought,
       information_sources, person_involved, status)
     VALUES ($1, $2, 'permanent', '{person,gp}', true, 'decided') RETURNING id`,
    [personId, a.service],
  );
  const decision = await c.query<{ id: string }>(
    `INSERT INTO admission_decision (id, person_id, assessment_id, can_meet_needs, reasons,
       decided_by, decided_at)
     VALUES ($1, $2, $3, 'yes_with_conditions', 'We can meet these needs with the right mattress.',
       $4, now() - interval '40 days') RETURNING id`,
    [
      personId === a.personAda ? DECISION_ADA : crypto.randomUUID(),
      personId,
      assessment.rows[0]?.id,
      a.manager,
    ],
  );
  await c.query(
    `INSERT INTO admission_condition (person_id, decision_id, position, condition, met_by, met_at)
     VALUES ($1, $2, 0, 'Pressure-relieving mattress in place', $3, now() - interval '39 days')`,
    [personId, decision.rows[0]?.id, a.manager],
  );
  const placement = await c.query<{ id: string }>(
    `INSERT INTO placement (person_id, service_id, room_id, type, start_date, admission_decision_id)
     VALUES ($1, $2, $3, 'permanent', '2026-09-01', $4) RETURNING id`,
    [personId, a.service, roomId, decision.rows[0]?.id],
  );
  await c.query(
    `INSERT INTO bed_occupancy (person_id, room_id, bed, from_date, reason)
     VALUES ($1, $2, 1, '2026-09-01', 'Admission')`,
    [personId, roomId],
  );
  await c.query(
    `INSERT INTO welcome_checklist_item (person_id, placement_id, item_key, title, required,
       safety_critical, allow_not_applicable)
     VALUES ($1, $2, 'photo_taken', 'Photo taken for identification', true, true, true)`,
    [personId, placement.rows[0]?.id],
  );
  await c.query(
    `INSERT INTO property_item (person_id, description, category, received_on, recorded_by,
       ack_signer, ack_name, ack_signed_at)
     VALUES ($1, 'Reading glasses in a blue case', 'sensory_aid', '2026-09-01', $2, 'person',
       'Signed by the person', now() - interval '40 days')`,
    [personId, a.manager],
  );
  await c.query(
    `INSERT INTO key_issue (person_id, label, issued_on, issued_to)
     VALUES ($1, 'Room key', '2026-09-01', 'person')`,
    [personId],
  );
  await c.query(
    `INSERT INTO review_record (person_id, kind, held_on, outcome)
     VALUES ($1, 'care_plan', '2026-10-01', 'No change needed')`,
    [personId],
  );
  await c.query(
    `INSERT INTO care_plan_change (person_id, kind, occurred_on) VALUES ($1, 'fall', '2026-10-02')`,
    [personId],
  );
  await c.query(
    `INSERT INTO hospital_transfer (person_id, location_id, left_at, hospital_name, pack, returned_at)
     VALUES ($1, $2, now() - interval '3 days', 'Example General Hospital', '{}', now())`,
    [personId, locationId],
  );
  const exit = await c.query<{ id: string }>(
    `INSERT INTO exit_record (person_id, location_id, kind, state, regulator,
       learning_disability_or_autism)
     VALUES ($1, $2, 'discharge', 'planned', 'cqc', false) RETURNING id`,
    [personId, locationId],
  );
  await c.query(
    `INSERT INTO exit_checklist_item (person_id, exit_record_id, item_key, title, owner)
     VALUES ($1, $2, 'destination_recorded', 'Where the person is going recorded', 'people')`,
    [personId, exit.rows[0]?.id],
  );
  const sharing = await c.query<{ id: string }>(
    `INSERT INTO sharing_decision (person_id, recipient_kind, sections, basis, consent_given_by,
       valid_from, valid_to)
     VALUES ($1, 'link', '{about_me}', 'consent', 'person', now(), now() + interval '30 days')
     RETURNING id`,
    [personId],
  );
  await c.query(
    `INSERT INTO about_me_share_link (person_id, sharing_decision_id, token_hash, expires_at)
     VALUES ($1, $2, $3, now() + interval '7 days')`,
    [personId, sharing.rows[0]?.id, tokenHash()],
  );
}

beforeAll(async () => {
  db = await createTestDatabase();
  await seedTwoTenants(db.pool("harbour_owner"));
  await inContext(db.pool("harbour_owner"), ctx(TENANT_A, null, "tenant"), async (c) => {
    await c.query(
      `INSERT INTO room (id, location_id, label, beds) VALUES
         ($1, $5, 'N1', 2), ($2, $5, 'N2', 1), ($3, $6, 'S1', 1), ($4, $5, 'N3', 1)`,
      [ROOM_N1, ROOM_N2, ROOM_S1, ROOM_N3, a.locationNorth, a.locationSouth],
    );
    await seedPerson(c, a.personAda, a.locationNorth, ROOM_N1);
    await seedPerson(c, a.personBen, a.locationNorth, ROOM_N2);
    await seedPerson(c, a.personCara, a.locationSouth, ROOM_S1);
    await c.query(`INSERT INTO welcome_checklist_template (items) VALUES ('[]')`);
    for (const locationId of [a.locationNorth, a.locationSouth]) {
      await c.query(
        `INSERT INTO break_glass_weekly_report (location_id, week_start, week_end, repeat_threshold,
           summary)
         VALUES ($1, '2026-10-04T23:00:00Z', '2026-10-11T23:00:00Z', 3, '{"totalEvents":0}')`,
        [locationId],
      );
    }
  });
  await inContext(db.pool("harbour_owner"), ctx(TENANT_B, null, "tenant"), async (c) => {
    await c.query(`INSERT INTO welcome_checklist_template (items) VALUES ('[]')`);
    await c.query(
      `INSERT INTO break_glass_weekly_report (location_id, week_start, week_end, repeat_threshold,
         summary)
       VALUES ($1, '2026-10-04T23:00:00Z', '2026-10-11T23:00:00Z', 3, '{"totalEvents":0}')`,
      [ids.b.location],
    );
  });
});

afterAll(async () => {
  await db?.drop();
});

const app = () => db.pool("harbour_app");
const asManager = <T>(fn: (c: pg.PoolClient) => Promise<T>) =>
  inContext(app(), ctx(TENANT_A, a.manager, "tenant"), fn);
const asOwner = <T>(fn: (c: pg.PoolClient) => Promise<T>) =>
  inContext(db.pool("harbour_owner"), ctx(TENANT_A, null, "tenant"), fn);
const carer = ctx(TENANT_A, a.carer, "assigned");
const north = ctx(TENANT_A, a.northManager, "locations", [a.locationNorth]);

async function rows(context: ReturnType<typeof ctx>, statement: string): Promise<string[]> {
  return inContext(app(), context, async (c) => {
    const result = await c.query<{ v: string }>(statement);
    return result.rows.map((r) => r.v).sort();
  });
}

describe("hazard HZ-011 the lifecycle tables follow the person's scope", () => {
  it.each(PERSON_TABLES)("%s shows each user only the people in their scope", async (table) => {
    const query = `SELECT DISTINCT person_id::text AS v FROM ${table}`;
    expect(await rows(carer, query)).toEqual([a.personAda]);
    expect(await rows(north, query)).toEqual([a.personAda, a.personBen].sort());
    expect(await rows(ctx(TENANT_A, a.manager, "tenant"), query)).toHaveLength(3);
    expect(await rows(ctx(TENANT_B, ids.b.manager, "tenant"), query)).toEqual([]);
  });

  it("stops a care worker recording property for someone outside their scope", async () => {
    await expect(
      inContext(app(), carer, (c) =>
        c.query(
          `INSERT INTO property_item (person_id, description, category, received_on, recorded_by,
             ack_signer, ack_name, ack_signed_at)
           VALUES ($1, 'Watch', 'watch', '2026-10-01', $2, 'person', 'Signed', now())`,
          [a.personBen, a.carer],
        ),
      ),
    ).rejects.toThrow(/row-level security/);
  });

  it("keeps each tenant's welcome checklist template to itself", async () => {
    const query = "SELECT tenant_id::text AS v FROM welcome_checklist_template";
    expect(await rows(ctx(TENANT_A, a.manager, "tenant"), query)).toEqual([TENANT_A]);
    expect(await rows(ctx(TENANT_B, ids.b.manager, "tenant"), query)).toEqual([TENANT_B]);
  });

  it("shows the weekly break-glass report to tenant-wide roles and the location's managers only", async () => {
    const query = "SELECT location_id::text AS v FROM break_glass_weekly_report";
    expect(await rows(ctx(TENANT_A, a.manager, "tenant"), query)).toEqual(
      [a.locationNorth, a.locationSouth].sort(),
    );
    expect(await rows(north, query)).toEqual([a.locationNorth]);
    expect(await rows(carer, query)).toEqual([]);
    expect(await rows(ctx(TENANT_B, ids.b.manager, "tenant"), query)).toEqual([ids.b.location]);
  });
});

describe("hazard HZ-001 a bed holds one person and a person holds one bed", () => {
  const occupy = (personId: string, roomId: string, bed: number, from: string, to: string | null) =>
    asManager((c) =>
      c.query(
        `INSERT INTO bed_occupancy (person_id, room_id, bed, from_date, to_date, reason)
         VALUES ($1, $2, $3, $4, $5, 'Test move')`,
        [personId, roomId, bed, from, to],
      ),
    );

  it("refuses a second occupant of the same bed on the same day", async () => {
    await expect(occupy(a.personCara, ROOM_N1, 1, "2026-10-05", null)).rejects.toThrow(
      /bed_occupancy_bed_no_overlap/,
    );
  });

  it("refuses a person in two beds at once", async () => {
    await expect(occupy(a.personAda, ROOM_N1, 2, "2026-10-05", null)).rejects.toThrow(
      /bed_occupancy_person_no_overlap/,
    );
  });

  it("allows the next person into a bed on the day the last one left (half-open ranges)", async () => {
    await asOwner(async (c) => {
      // Ben leaves N2 and Cara leaves S1 on 10 October; Cara moves into N2 that day.
      await c.query(
        `UPDATE bed_occupancy SET to_date = '2026-10-10'
         WHERE person_id = ANY ($1) AND to_date IS NULL`,
        [[a.personBen, a.personCara]],
      );
    });
    await expect(
      occupy(a.personCara, ROOM_N2, 1, "2026-10-10", "2026-10-11"),
    ).resolves.toBeTruthy();
    await expect(occupy(a.personCara, ROOM_N2, 1, "2026-10-09", "2026-10-10")).rejects.toThrow(
      /bed_occupancy/,
    );
  });

  it("holds even when the writer cannot see the other occupant", async () => {
    // The care worker sees only Ada; Ben's period in N2 is invisible to them but still counts.
    const visible = await rows(carer, "SELECT person_id::text AS v FROM bed_occupancy");
    expect(visible).not.toContain(a.personBen);
    await expect(
      inContext(app(), carer, (c) =>
        c.query(
          `INSERT INTO bed_occupancy (person_id, room_id, bed, from_date, to_date, reason)
           VALUES ($1, $2, 1, '2026-10-01', '2026-10-03', 'Test move')`,
          [a.personAda, ROOM_N2],
        ),
      ),
    ).rejects.toThrow(/bed_occupancy/);
  });

  it("ignores periods corrected away (soft-deleted)", async () => {
    await asOwner((c) =>
      c.query(
        `INSERT INTO bed_occupancy (person_id, room_id, bed, from_date, to_date, reason, deleted_at)
         VALUES ($1, $2, 1, '2026-08-01', '2026-08-05', 'Recorded in error', now())`,
        [a.personBen, ROOM_N3],
      ),
    );
    await expect(
      occupy(a.personCara, ROOM_N3, 1, "2026-08-02", "2026-08-03"),
    ).resolves.toBeTruthy();
  });

  it("refuses a bed the room does not have", async () => {
    await expect(occupy(a.personCara, ROOM_N3, 2, "2026-11-01", null)).rejects.toThrow(
      /does not have that bed/,
    );
  });
});

describe("append-only decisions, reviews and weekly reports", () => {
  it.each([
    ["update a decision to admit", "UPDATE admission_decision SET reasons = 'Changed later on'"],
    ["delete a decision to admit", "DELETE FROM admission_decision"],
    ["update a review record", "UPDATE review_record SET outcome = 'Changed'"],
    ["delete a weekly report", "DELETE FROM break_glass_weekly_report"],
    ["delete a property item", "DELETE FROM property_item"],
    ["delete a sharing decision", "DELETE FROM sharing_decision"],
  ])("hazard HZ-017 refuses to %s", async (_label, statement) => {
    await expect(asManager((c) => c.query(statement))).rejects.toThrow(/permission denied/);
  });

  it("blocks even the owner role with the append-only trigger", async () => {
    await expect(
      asOwner((c) => c.query("UPDATE review_record SET outcome = 'Changed'")),
    ).rejects.toThrow(/append-only/);
  });

  it("records a correction as a new decision that supersedes the first, once", async () => {
    const superseding = (reason: string | null) =>
      asManager((c) =>
        c.query(
          `INSERT INTO admission_decision (person_id, assessment_id, can_meet_needs, reasons,
             decided_by, decided_at, supersedes_id, correction_reason)
           SELECT person_id, assessment_id, 'no', 'We cannot now meet the needs at night.',
             decided_by, now(), id, $2 FROM admission_decision WHERE id = $1`,
          [DECISION_ADA, reason],
        ),
      );
    await expect(superseding(null)).rejects.toThrow(/admission_decision_correction_reason/);
    await expect(superseding("Night staffing changed")).resolves.toBeTruthy();
    await expect(superseding("Again")).rejects.toThrow(/admission_decision_superseded_once/);
  });
});

describe("share links store the token's hash only", () => {
  it("refuses anything that is not a SHA-256 hex digest", async () => {
    await expect(
      asManager((c) =>
        c.query(
          `INSERT INTO about_me_share_link (person_id, sharing_decision_id, token_hash, expires_at)
           SELECT person_id, sharing_decision_id, 'the-raw-token-value', now() + interval '1 day'
           FROM about_me_share_link LIMIT 1`,
        ),
      ),
    ).rejects.toThrow(/about_me_share_link_token_hash/);
  });

  it("never stores the same hash twice", async () => {
    const hash = tokenHash();
    const insert = () =>
      asManager((c) =>
        c.query(
          `INSERT INTO about_me_share_link (person_id, sharing_decision_id, token_hash, expires_at)
           SELECT person_id, sharing_decision_id, $1, now() + interval '1 day'
           FROM about_me_share_link LIMIT 1`,
          [hash],
        ),
      );
    await insert();
    await expect(insert()).rejects.toThrow(/about_me_share_link_token_hash_key/);
  });
});

describe("integrity rules in the database", () => {
  it.each([
    [
      "cash as a property item",
      `INSERT INTO property_item (person_id, description, category, received_on, recorded_by,
         ack_signer, ack_name, ack_signed_at)
       VALUES ('${a.personAda}', 'Twenty pounds', 'cash', '2026-10-01', '${a.manager}', 'person', 'x', now())`,
      /property_item_category/,
    ],
    [
      "a property item counted as none",
      `INSERT INTO property_item (person_id, description, category, quantity, received_on,
         recorded_by, ack_signer, ack_name, ack_signed_at)
       VALUES ('${a.personAda}', 'Socks', 'clothing', 0, '2026-10-01', '${a.manager}', 'person', 'x', now())`,
      /property_item_quantity/,
    ],
    [
      "an item nobody could sign for without the reason",
      `INSERT INTO property_item (person_id, description, category, received_on, recorded_by,
         ack_signer, ack_signed_at)
       VALUES ('${a.personAda}', 'Cardigan', 'clothing', '2026-10-01', '${a.manager}', 'unable_to_sign', now())`,
      /property_item_acknowledgement/,
    ],
    [
      "a disposal witnessed by the person disposing",
      `UPDATE property_item SET status = 'disposed', disposed_on = '2026-10-05',
         disposal_reason = 'Worn out', disposed_by = '${a.manager}', disposal_witnessed_by = '${a.manager}'
       WHERE person_id = '${a.personAda}'`,
      /property_item_disposed/,
    ],
    [
      "a lost item without its incident",
      `UPDATE property_item SET status = 'lost', lost_on = '2026-10-05' WHERE person_id = '${a.personAda}'`,
      /property_item_lost/,
    ],
    [
      "a key both returned and lost",
      `UPDATE key_issue SET returned_on = '2026-10-02', reported_lost_on = '2026-10-03'
       WHERE person_id = '${a.personAda}'`,
      /key_issue_once/,
    ],
    [
      "a sharing decision for a family member without the contact",
      `INSERT INTO sharing_decision (person_id, recipient_kind, sections, basis, consent_given_by,
         valid_from, valid_to)
       VALUES ('${a.personAda}', 'family', '{daily_updates}', 'consent', 'person', now(), now() + interval '1 day')`,
      /sharing_decision_recipient/,
    ],
    [
      "a sharing decision that never expires",
      `INSERT INTO sharing_decision (person_id, recipient_kind, sections, basis, valid_from)
       VALUES ('${a.personAda}', 'link', '{about_me}', 'consent', now())`,
      /valid_to/,
    ],
    [
      "a sharing decision for an unknown section",
      `INSERT INTO sharing_decision (person_id, recipient_kind, sections, basis, valid_from, valid_to)
       VALUES ('${a.personAda}', 'link', '{bank_details}', 'consent', now(), now() + interval '1 day')`,
      /sharing_decision_sections/,
    ],
    [
      "a withdrawal without a reason",
      `UPDATE sharing_decision SET withdrawn_at = now() WHERE person_id = '${a.personAda}'`,
      /sharing_decision_withdrawn/,
    ],
    [
      "a death recorded without the place",
      `INSERT INTO exit_record (person_id, location_id, kind, state, regulator, left_at,
         learning_disability_or_autism)
       VALUES ('${a.personAda}', '${a.locationNorth}', 'death', 'recorded', 'cqc', now(), false)`,
      /exit_record_death|exit_record_one_open/,
    ],
    [
      "a second open exit for the same person",
      `INSERT INTO exit_record (person_id, location_id, kind, state, regulator,
         learning_disability_or_autism)
       VALUES ('${a.personAda}', '${a.locationNorth}', 'transfer', 'planned', 'cqc', false)`,
      /exit_record_one_open/,
    ],
    [
      "an exit checklist item marked not required where it must be done",
      `UPDATE exit_checklist_item SET status = 'not_required', reason = 'No', done_by = '${a.manager}',
         done_at = now() WHERE person_id = '${a.personAda}'`,
      /exit_checklist_item_not_required/,
    ],
    [
      "a welcome item ticked without who did it",
      `UPDATE welcome_checklist_item SET status = 'done' WHERE person_id = '${a.personAda}'`,
      /welcome_checklist_item_done/,
    ],
    [
      "a second open hospital transfer",
      `INSERT INTO hospital_transfer (person_id, location_id, left_at, hospital_name, pack) VALUES
         ('${a.personAda}', '${a.locationNorth}', now(), 'Example General Hospital', '{}'),
         ('${a.personAda}', '${a.locationNorth}', now(), 'Example General Hospital', '{}')`,
      /hospital_transfer_one_open/,
    ],
    [
      "a family involvement review without its kind",
      `INSERT INTO review_record (person_id, kind, held_on) VALUES ('${a.personAda}', 'family_involvement', '2026-10-01')`,
      /review_record_family/,
    ],
    [
      "a room status outside the list",
      `UPDATE room SET status = 'occupied' WHERE id = '${ROOM_N1}'`,
      /room_status/,
    ],
    [
      "a trial that ends before the admission",
      `UPDATE placement SET type = 'trial', trial_ends_on = '2026-08-01' WHERE person_id = '${a.personAda}'`,
      /placement_trial_end/,
    ],
    [
      "'no communication needs' with needs listed or nobody confirming it",
      `UPDATE person SET communication_needs_status = 'none_identified' WHERE id = '${a.personAda}'`,
      /person_communication_none_identified/,
    ],
    [
      "a break-glass reason code outside the list",
      `INSERT INTO break_glass_event (tenant_user_id, person_id, justification, expires_at, reason_code)
       VALUES ('${a.manager}', '${a.personAda}', 'Covering the unit tonight for a colleague',
         now() + interval '1 hour', 'curiosity')`,
      /break_glass_reason_code/,
    ],
  ])("refuses %s", async (_label, statement, error) => {
    await expect(asManager((c) => c.query(statement))).rejects.toThrow(error);
  });

  it("starts communication needs as not recorded, never as none", async () => {
    const { rows: found } = await asOwner((c) =>
      c.query<{ status: string }>(
        "SELECT communication_needs_status AS status FROM person WHERE id = $1",
        [a.personBen],
      ),
    );
    expect(found[0]?.status).toBe("not_recorded");
  });

  it("versions a property change into record_version", async () => {
    const result = await asManager(async (c) => {
      await c.query("UPDATE property_item SET quantity = 2 WHERE person_id = $1", [a.personBen]);
      const { rows: found } = await c.query<{ version: number; history: number }>(
        `SELECT p.version, (SELECT count(*)::int FROM record_version r
           WHERE r.table_name = 'property_item' AND r.record_id = p.id) AS history
         FROM property_item p WHERE p.person_id = $1`,
        [a.personBen],
      );
      return found[0];
    });
    expect(result).toEqual({ version: 2, history: 1 });
  });

  it("hazard HZ-006 keeps the status time in step when only the status is written", async () => {
    const changed = await asOwner(async (c) => {
      await c.query(
        `UPDATE person SET status = 'discharged', discharged_at = '2026-10-09T15:30:00Z'
         WHERE id = $1`,
        [a.personCara],
      );
      const { rows: found } = await c.query<{ at: Date }>(
        "SELECT status_changed_at AS at FROM person WHERE id = $1",
        [a.personCara],
      );
      await c.query(
        `UPDATE person SET status = 'active', discharged_at = NULL,
           status_changed_at = '2026-10-09T16:00:00Z' WHERE id = $1`,
        [a.personCara],
      );
      const { rows: explicit } = await c.query<{ at: Date }>(
        "SELECT status_changed_at AS at FROM person WHERE id = $1",
        [a.personCara],
      );
      return { derived: found[0]?.at, explicit: explicit[0]?.at };
    });
    expect(changed.derived?.toISOString()).toBe("2026-10-09T15:30:00.000Z");
    expect(changed.explicit?.toISOString()).toBe("2026-10-09T16:00:00.000Z");
  });
});

describe("code lists match the domain", () => {
  const listed = async (constraint: string) => {
    const { rows: found } = await db
      .pool("harbour_owner")
      .query<{ def: string }>(
        "SELECT pg_get_constraintdef(oid) AS def FROM pg_constraint WHERE conname = $1",
        [constraint],
      );
    return [...(found[0]?.def ?? "").matchAll(/'([a-z0-9_.]+)'/g)].map((m) => m[1]);
  };

  it.each([
    ["property_item_category", PROPERTY_CATEGORIES],
    ["property_item_status", PROPERTY_ITEM_STATUSES],
    ["care_plan_change_kind", CARE_PLAN_CHANGE_KINDS],
    ["sharing_decision_sections", SHARING_SECTIONS],
    ["sharing_decision_basis", SHARING_BASES],
    ["sharing_decision_authority_role", AUTHORITY_ROLES],
    ["break_glass_reason_code", BREAK_GLASS_REASON_CODES],
    ["room_status", ROOM_STATUSES],
    ["pre_admission_assessment_sources", INFORMATION_SOURCES],
  ] as const)("keeps %s in step with the domain package", async (constraint, expected) => {
    expect(await listed(constraint)).toEqual([...expected]);
  });

  it("keeps the family involvement kinds in step (after the review kind)", async () => {
    expect((await listed("review_record_family")).slice(1)).toEqual([...FAMILY_INVOLVEMENT_KINDS]);
  });

  it("keeps the person statuses in the domain's order", async () => {
    const { rows: found } = await db.pool("harbour_owner").query<{ label: string }>(
      `SELECT e.enumlabel AS label FROM pg_enum e JOIN pg_type t ON t.oid = e.enumtypid
       WHERE t.typname = 'person_status' ORDER BY e.enumsortorder`,
    );
    expect(found.map((r) => r.label)).toEqual([...PERSON_STATUSES]);
  });
});

describe("existing tenants' role copies gain the new permissions (migration 0022)", () => {
  const migration = readFileSync(
    fileURLToPath(new URL("../drizzle/0022_builtin_role_permissions.sql", import.meta.url)),
    "utf8",
  );

  async function runMigration() {
    const client = await db.pool("harbour_owner").connect();
    try {
      await client.query("BEGIN");
      for (const statement of migration.split("--> statement-breakpoint")) {
        if (statement.trim()) await client.query(statement);
      }
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  const roleRows = () =>
    asOwner((c) =>
      c.query<{ key: string; permissions: string[]; version: number; builtin: boolean }>(
        `SELECT key, permissions, version, is_builtin AS builtin FROM role ORDER BY key, is_builtin`,
      ),
    ).then((r) => r.rows);

  it("lists the same roles as the built-in definitions", () => {
    for (const permission of [
      "people.movement.record",
      "people.property.manage",
      "safety.incident.read",
    ]) {
      const holders = BUILTIN_ROLES.filter((r) =>
        (r.permissions as readonly string[]).includes(permission),
      ).map((r) => r.key);
      for (const key of holders) {
        const line = migration.split("\n").find((l) => l.includes(`('${key}', ARRAY[`)) ?? "";
        expect(line, `${key} should gain ${permission}`).toContain(`'${permission}'`);
      }
      const named = migration
        .split("\n")
        .filter((l) => l.includes(`'${permission}'`) && l.trim().startsWith("('"))
        .map((l) => l.trim().slice(2, l.trim().indexOf("',")));
      expect(named.sort()).toEqual([...holders].sort());
    }
  });

  it("adds them once, as a new version of each copy, and leaves custom roles alone", async () => {
    await asOwner(async (c) => {
      await c.query(
        `INSERT INTO role (key, name, scope_kind, permissions, is_builtin) VALUES
           ('clinical_lead', 'Clinical lead or nurse', 'location', '{care.plan.write}', true),
           ('team_leader', 'Team leader', 'location', '{care.note.write,people.movement.record}', true),
           ('night_nurse', 'Night nurse (custom)', 'location', '{care.plan.write}', false)`,
      );
    });
    await runMigration();
    const after = await roleRows();
    const role = (key: string) => after.find((r) => r.key === key);
    expect(role("care_worker")).toMatchObject({
      permissions: ["people.person.read", "safety.incident.read"],
      version: 2,
    });
    expect(role("clinical_lead")).toMatchObject({
      permissions: [
        "care.plan.write",
        "people.movement.record",
        "people.property.manage",
        "safety.incident.read",
      ],
      version: 2,
    });
    expect(role("team_leader")?.permissions).toEqual([
      "care.note.write",
      "people.movement.record",
      "people.property.manage",
      "safety.incident.read",
    ]);
    expect(role("night_nurse")).toMatchObject({ permissions: ["care.plan.write"], version: 1 });

    const history = await asOwner((c) =>
      c.query<{ n: number }>(
        `SELECT count(*)::int AS n FROM record_version WHERE table_name = 'role'
         AND record_id = (SELECT id FROM role WHERE key = 'care_worker')`,
      ),
    );
    expect(history.rows[0]?.n).toBe(1);

    await runMigration();
    expect(await roleRows()).toEqual(after);
  });

  it("audits each copy migration 0022 changed once, as the system, in the tenant's chain (0024)", async () => {
    const audit = readFileSync(
      fileURLToPath(new URL("../drizzle/0024_builtin_role_permissions_audit.sql", import.meta.url)),
      "utf8",
    );
    const runAudit = async () => {
      const client = await db.pool("harbour_owner").connect();
      try {
        await client.query("BEGIN");
        for (const statement of audit.split("--> statement-breakpoint")) {
          if (statement.trim()) await client.query(statement);
        }
        await client.query("COMMIT");
      } finally {
        client.release();
      }
    };
    const events = () =>
      asOwner((c) =>
        c.query<{ key: string; actor: string; roles: string[]; added: string[] }>(
          `SELECT r.key, e.actor_auth_user_id AS actor, e.actor_role_keys AS roles,
             ARRAY(SELECT jsonb_array_elements_text(e.scope -> 'added')) AS added
           FROM audit_event e JOIN role r ON r.id::text = e.resource_id
           WHERE e.action = 'platform.role.permissions_migrated' ORDER BY r.key`,
        ),
      ).then((r) => r.rows);
    await runAudit();
    const first = await events();
    expect(first.find((e) => e.key === "clinical_lead")).toEqual({
      key: "clinical_lead",
      actor: "system",
      roles: ["system"],
      added: ["people.movement.record", "people.property.manage", "safety.incident.read"],
    });
    expect(first.find((e) => e.key === "team_leader")?.added).toEqual([
      "people.property.manage",
      "safety.incident.read",
    ]);
    expect(first.map((e) => e.key)).not.toContain("night_nurse");
    await runAudit();
    expect(await events()).toEqual(first);
    const broken = await asOwner((c) =>
      c.query<{ at: string | null }>("SELECT app.verify_audit_chain() AS at"),
    );
    expect(broken.rows[0]?.at).toBeNull();
  });

  it("restores forced row-level security on the role table", async () => {
    const { rows: found } = await db
      .pool("harbour_owner")
      .query<{ forced: boolean }>(
        "SELECT relforcerowsecurity AS forced FROM pg_class WHERE relname = 'role'",
      );
    expect(found[0]?.forced).toBe(true);
  });
});

describe("slice 8 review fixes (migration 0023)", () => {
  it("keeps About Me, the pre-admission assessment and property out of device replication", async () => {
    const { rows: published } = await db
      .pool("harbour_owner")
      .query<{ table: string }>(
        "SELECT tablename AS table FROM pg_publication_tables WHERE pubname = 'powersync'",
      );
    const tables = published.map((r) => r.table);
    for (const table of ["about_me", "pre_admission_assessment", "property_item"]) {
      expect(tables).not.toContain(table);
      await expect(
        inContext(db.pool("harbour_sync"), null, (c) => c.query(`SELECT 1 FROM ${table}`)),
      ).rejects.toThrow(/permission denied/);
    }
  });

  it("hazard HZ-007 records who set the allergy status and when, not who last edited the person", async () => {
    const found = await asManager(async (c) => {
      await c.query("UPDATE person SET allergy_status = 'unknown' WHERE id = $1", [a.personBen]);
      await c.query("UPDATE person SET allergy_status = 'no_known_allergies' WHERE id = $1", [
        a.personBen,
      ]);
      const { rows: set } = await c.query<{ by: string | null; at: Date | null }>(
        `SELECT allergy_status_confirmed_by AS by, allergy_status_confirmed_at AS at
         FROM person WHERE id = $1`,
        [a.personBen],
      );
      return set[0];
    });
    expect(found?.by).toBe(a.manager);
    expect(found?.at).not.toBeNull();
    const after = await inContext(app(), north, async (c) => {
      await c.query("UPDATE person SET preferred_name = 'Benny' WHERE id = $1", [a.personBen]);
      const { rows: kept } = await c.query<{ by: string | null }>(
        "SELECT allergy_status_confirmed_by AS by FROM person WHERE id = $1",
        [a.personBen],
      );
      return kept[0]?.by;
    });
    expect(after).toBe(a.manager);
  });

  it("codes the tasks the lifecycle cancels, and only cancelled tasks carry a code", async () => {
    await expect(
      asManager((c) =>
        c.query(
          `INSERT INTO task (kind, title, required_permission, due_at, status, cancel_code)
           VALUES ('care.reposition', 'Reposition', 'care.note.write', now(), 'open',
             'paused_while_away')`,
        ),
      ),
    ).rejects.toThrow(/task_cancel_code/);
    await expect(
      asManager((c) =>
        c.query(
          `INSERT INTO task (kind, title, required_permission, due_at, status, cancel_code)
           VALUES ('care.reposition', 'Reposition', 'care.note.write', now(), 'cancelled',
             'because')`,
        ),
      ),
    ).rejects.toThrow(/task_cancel_code/);
  });
});
