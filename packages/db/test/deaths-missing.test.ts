import {
  DEATH_RECORD_STATUSES,
  DEATH_STEP_OUTCOMES,
  DEATH_STEPS,
  MISSING_EPISODE_STATUSES,
  MISSING_TIMELINE_KINDS,
} from "@harbour/domain";
import type pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createTestDatabase, type TestDatabase } from "./support/database";
import { ctx, ids, inContext, seedTwoTenants, TENANT_A, TENANT_B } from "./support/fixtures";

/**
 * Deaths and missing persons in the database (slice 37; migration 0099; hazards HZ-011, HZ-013,
 * HZ-127): never across organisations, only for people in scope, never deleted; steps and
 * timelines append-only; a finished death record or a closed episode never changes; one open
 * episode per person; each step of a search once; and the codes kept in step with the domain.
 */

let db: TestDatabase;
const a = ids.a;
const app = () => db.pool("harbour_app");
const asManager = <T>(fn: (c: pg.PoolClient) => Promise<T>) =>
  inContext(app(), ctx(TENANT_A, a.manager, "tenant"), fn);
/** The carer is assigned to Ada only. */
const asCarer = <T>(fn: (c: pg.PoolClient) => Promise<T>) =>
  inContext(app(), ctx(TENANT_A, a.carer, "assigned"), fn);
const asOtherTenant = <T>(fn: (c: pg.PoolClient) => Promise<T>) =>
  inContext(app(), ctx(TENANT_B, ids.b.manager, "tenant"), fn);
const ownerDb = <T>(fn: (c: pg.PoolClient) => Promise<T>) =>
  inContext(db.pool("harbour_owner"), ctx(TENANT_A, null, "tenant"), fn);
const INCIDENT = "0199f000-0000-7000-8000-0000000037a1";
let exitId = "";
let deathId = "";
let episodeId = "";

const one = async <T extends pg.QueryResultRow>(
  c: pg.PoolClient,
  text: string,
  values: unknown[],
) => (await c.query<T>(text, values)).rows[0];

beforeAll(async () => {
  db = await createTestDatabase();
  await seedTwoTenants(db.pool("harbour_owner"));
  await ownerDb(async (c) => {
    await c.query(
      `INSERT INTO incident (id, location_id, type, occurred_at, description, raised_by, person_ids)
       VALUES ($1, $2, 'missing_person', now() - interval '1 hour', 'Fixture incident', $3, $4)`,
      [INCIDENT, a.locationNorth, a.manager, [a.personAda]],
    );
    const exit = await one<{ id: string }>(
      c,
      `INSERT INTO exit_record (person_id, location_id, kind, state, regulator, left_at,
         learning_disability_or_autism, death_expected)
       VALUES ($1, $2, 'death', 'recorded', 'cqc', now() - interval '2 hours', false, true) RETURNING id`,
      [a.personBen, a.locationNorth],
    );
    exitId = exit?.id ?? "";
  });
}, 120_000);

afterAll(async () => {
  await db?.drop();
});

describe("hazard HZ-013 the death record (migration 0099)", () => {
  it("records a death record and its steps, and the codes match the domain", async () => {
    const death = await asManager((c) =>
      one<{ id: string }>(
        c,
        `INSERT INTO death_record (person_id, location_id, exit_record_id, died_at,
           learning_disability_or_autism, review_due_at, expected)
         VALUES ($1, $2, $3, now() - interval '2 hours', false, now() + interval '28 days', true)
         RETURNING id`,
        [a.personBen, a.locationNorth, exitId],
      ),
    );
    deathId = death?.id ?? "";
    await asManager((c) =>
      c.query(
        `INSERT INTO death_step (death_record_id, person_id, step, outcome, at)
         VALUES ($1, $2, 'verification_of_death', 'done', now())`,
        [deathId, a.personBen],
      ),
    );
    const constraint = async (name: string) =>
      ownerDb(async (c) => {
        const row = await one<{ def: string }>(
          c,
          "SELECT pg_get_constraintdef(oid) AS def FROM pg_constraint WHERE conname = $1",
          [name],
        );
        return row?.def ?? "";
      });
    for (const status of DEATH_RECORD_STATUSES) {
      expect(await constraint("death_record_status")).toContain(`'${status}'`);
    }
    for (const step of DEATH_STEPS.filter((s) => s !== "mortality_review")) {
      expect(await constraint("death_step_step")).toContain(`'${step}'`);
    }
    expect(await constraint("death_step_step")).not.toContain("'mortality_review'");
    for (const outcome of DEATH_STEP_OUTCOMES) {
      expect(await constraint("death_step_outcome")).toContain(`'${outcome}'`);
    }
    for (const status of MISSING_EPISODE_STATUSES) {
      expect(await constraint("missing_episode_status")).toContain(`'${status}'`);
    }
    for (const kind of MISSING_TIMELINE_KINDS) {
      expect(await constraint("missing_event_kind")).toContain(`'${kind}'`);
    }
  });

  it("refuses a step not needed without a reason, and a review without findings and lessons", async () => {
    await expect(
      asManager((c) =>
        c.query(
          `INSERT INTO death_step (death_record_id, person_id, step, outcome, at)
           VALUES ($1, $2, 'family_informed', 'not_needed', now())`,
          [deathId, a.personBen],
        ),
      ),
    ).rejects.toThrow(/death_step_text/);
    await expect(
      asManager((c) =>
        c.query("UPDATE death_record SET reviewed_at = now(), reviewed_by = $2 WHERE id = $1", [
          deathId,
          a.manager,
        ]),
      ),
    ).rejects.toThrow(/death_record_review/);
  });

  it("keeps the steps append-only and the record's subject fixed", async () => {
    await expect(
      asManager((c) =>
        c.query("UPDATE death_step SET note = 'changed' WHERE death_record_id = $1", [deathId]),
      ),
    ).rejects.toThrow();
    await expect(
      asManager((c) => c.query("DELETE FROM death_step WHERE death_record_id = $1", [deathId])),
    ).rejects.toThrow();
    await expect(
      asManager((c) => c.query("UPDATE death_record SET died_at = now() WHERE id = $1", [deathId])),
    ).rejects.toThrow(/death_record_fixed_fields/);
    await expect(
      asManager((c) => c.query("DELETE FROM death_record WHERE id = $1", [deathId])),
    ).rejects.toThrow();
  });

  it("closes only in the closer's own name, and a closed record never changes", async () => {
    await expect(
      asManager((c) =>
        c.query(
          "UPDATE death_record SET status = 'closed', closed_at = now(), closed_by = $2 WHERE id = $1",
          [deathId, a.carer],
        ),
      ),
    ).rejects.toThrow(/death_record_closer_not_you/);
    await asManager((c) =>
      c.query(
        "UPDATE death_record SET status = 'closed', closed_at = now(), closed_by = $2 WHERE id = $1",
        [deathId, a.manager],
      ),
    );
    await expect(
      asManager((c) =>
        c.query("UPDATE death_record SET judged_by = 'Dr Example, GP' WHERE id = $1", [deathId]),
      ),
    ).rejects.toThrow(/death_record_finished/);
  });

  it("hazard HZ-011 shows a death record to no one outside the person's scope or organisation", async () => {
    const seen = (as: typeof asManager) =>
      as(async (c) => (await c.query("SELECT id FROM death_record")).rows.length);
    expect(await seen(asManager)).toBe(1);
    // The carer is assigned to Ada, not Ben.
    expect(await seen(asCarer)).toBe(0);
    expect(await seen(asOtherTenant)).toBe(0);
    await expect(
      asOtherTenant((c) =>
        c.query(
          `INSERT INTO death_step (tenant_id, death_record_id, person_id, step, outcome, at)
           VALUES ($1, $2, $3, 'family_informed', 'done', now())`,
          [TENANT_A, deathId, a.personBen],
        ),
      ),
    ).rejects.toThrow();
  });
});

describe("hazard HZ-127 the missing person episode and the Herbert Protocol profile (migration 0099)", () => {
  it("records an episode and its timeline, each step of the search once", async () => {
    const episode = await asCarer((c) =>
      one<{ id: string }>(
        c,
        `INSERT INTO missing_episode (person_id, location_id, incident_id)
         VALUES ($1, $2, $3) RETURNING id`,
        [a.personAda, a.locationNorth, INCIDENT],
      ),
    );
    episodeId = episode?.id ?? "";
    const add = (kind: string, extra: Record<string, string> = {}) =>
      asCarer((c) =>
        c.query(
          `INSERT INTO missing_event (episode_id, person_id, kind, at, reference, area, note)
           VALUES ($1, $2, $3, now(), $4, $5, $6)`,
          [
            episodeId,
            a.personAda,
            kind,
            extra.reference ?? null,
            extra.area ?? null,
            extra.note ?? null,
          ],
        ),
      );
    await add("noticed_missing");
    await expect(add("noticed_missing")).rejects.toThrow(/missing_event_once/);
    await add("search", { area: "The garden" });
    await add("search", { area: "The car park" });
    await expect(add("police_called")).rejects.toThrow(/missing_event_text/);
    await expect(add("search")).rejects.toThrow(/missing_event_text/);
    await add("police_called", { reference: "CAD 1234" });
    await expect(add("found", { note: "Here" })).rejects.toThrow(/missing_event_text/);
    // A second open episode for the same person is refused.
    await expect(
      asCarer((c) =>
        c.query(
          `INSERT INTO missing_episode (person_id, location_id, incident_id) VALUES ($1, $2, $3)`,
          [a.personAda, a.locationNorth, INCIDENT],
        ),
      ),
    ).rejects.toThrow(/missing_episode_one_open/);
  });

  it("keeps the timeline append-only, and a closed episode closed", async () => {
    await expect(
      asCarer((c) =>
        c.query("UPDATE missing_event SET note = 'x' WHERE episode_id = $1", [episodeId]),
      ),
    ).rejects.toThrow();
    await expect(
      asCarer((c) => c.query("DELETE FROM missing_event WHERE episode_id = $1", [episodeId])),
    ).rejects.toThrow();
    await expect(
      asCarer((c) =>
        c.query(
          "UPDATE missing_episode SET status = 'closed', closed_at = now(), closed_by = $2 WHERE id = $1",
          [episodeId, a.manager],
        ),
      ),
    ).rejects.toThrow(/missing_episode_closer_not_you/);
    await asManager((c) =>
      c.query(
        "UPDATE missing_episode SET status = 'closed', closed_at = now(), closed_by = $2 WHERE id = $1",
        [episodeId, a.manager],
      ),
    );
    await expect(
      asManager((c) =>
        c.query("UPDATE missing_episode SET immediate_risk = true WHERE id = $1", [episodeId]),
      ),
    ).rejects.toThrow(/missing_episode_closed/);
  });

  it("keeps a profile to the parts the police need first, reviewed in the reviewer's own name", async () => {
    const insert = (by: string, description: string) =>
      asManager((c) =>
        c.query(
          `INSERT INTO herbert_profile (person_id, physical_description, places_likely, reviewed_on, reviewed_by)
           VALUES ($1, $2, 'Her old home on Example Street', '2026-10-31', $3)`,
          [a.personAda, description, by],
        ),
      );
    await expect(insert(a.manager, "Tall")).rejects.toThrow(/herbert_profile_required/);
    await expect(insert(a.carer, "Tall, slim, white hair")).rejects.toThrow();
    await insert(a.manager, "Tall, slim, white hair");
    await expect(
      asManager((c) =>
        c.query(
          "UPDATE herbert_profile SET reviewed_on = '2026-11-01', reviewed_by = $2 WHERE person_id = $1",
          [a.personAda, a.carer],
        ),
      ),
    ).rejects.toThrow(/herbert_profile_reviewer_not_you/);
  });

  it("hazard HZ-011 shows episodes, timelines and profiles to no one outside scope or the organisation", async () => {
    for (const table of ["missing_episode", "missing_event", "herbert_profile"]) {
      const count = (as: typeof asManager) =>
        as(async (c) => (await c.query(`SELECT id FROM ${table}`)).rows.length);
      expect({ table, n: await count(asManager) }).not.toEqual({ table, n: 0 });
      expect({ table, n: await count(asOtherTenant) }).toEqual({ table, n: 0 });
    }
    // Out of the carer's scope: Ben's death steps.
    expect(
      await asCarer(async (c) => (await c.query("SELECT id FROM death_step")).rows.length),
    ).toBe(0);
  });
});
