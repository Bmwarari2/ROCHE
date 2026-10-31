import { SURVEY_STATES } from "@harbour/domain";
import type pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PULSE_SURVEY_STATE_CODES } from "../src/schema";
import { createTestDatabase, type TestDatabase, withAdminClient } from "./support/database";
import { ctx, ids, inContext, seedTwoTenants, TENANT_A, TENANT_B } from "./support/fixtures";

/**
 * Staff wellbeing and voice in the database (scheduling.md section 16; migration 0115; SCHED-011).
 * Covered here:
 * - cross-tenant denial;
 * - the anonymous response table is closed to the application role and holds no member;
 * - a second response is refused, and so is a member who does not work at the home;
 * - results are refused while the survey is open and below the minimum group size;
 * - an organisation can raise the size but never lower it;
 * - recognition is never to oneself;
 * - a manager sees a check-in only while it is shared, and only the member shares it;
 * - the guards and the append-only rules.
 * All the people here are invented.
 */

let db: TestDatabase;
const asAdmin = <T>(fn: (c: pg.Client) => Promise<T>) => withAdminClient(fn, db.name);
const a = ids.a;
const app = () => db.pool("harbour_app");
const asOwnerRole = <T>(tenantId: string, fn: (c: pg.PoolClient) => Promise<T>) =>
  inContext(db.pool("harbour_owner"), ctx(tenantId, null, "tenant"), fn);
/** Holds scheduling.wellbeing.manage at North House only. */
const asNorth = <T>(fn: (c: pg.PoolClient) => Promise<T>) =>
  inContext(app(), ctx(TENANT_A, a.northManager, "locations", [a.locationNorth]), fn);
const asMember = <T>(member: string, fn: (c: pg.PoolClient) => Promise<T>) =>
  inContext(app(), ctx(TENANT_A, member, "assigned"), fn);
const asOtherTenant = <T>(fn: (c: pg.PoolClient) => Promise<T>) =>
  inContext(app(), ctx(TENANT_B, ids.b.manager, "tenant"), fn);

const ROLE_MANAGER = "0199d115-0000-7000-8000-000000000501";
const ROLE_WORKER = "0199d115-0000-7000-8000-000000000502";
/** Six invented care workers at North House, and one at South House. */
const WORKERS = [1, 2, 3, 4, 5, 6].map((n) => `0199d115-0000-7000-8000-00000000060${n}`);
const SOUTH_WORKER = "0199d115-0000-7000-8000-000000000611";
const QUESTIONS = [
  { id: "q1", kind: "scale", text: "How supported do you feel at work?" },
  { id: "q2", kind: "free_text", text: "What one thing would help?" },
];
const today = () =>
  new Intl.DateTimeFormat("en-CA", { timeZone: "Europe/London" }).format(new Date());

const code = async (p: Promise<unknown>) =>
  p.then(
    () => "ok",
    (e: { message?: string; code?: string }) => e.message ?? e.code ?? "error",
  );

async function newSurvey(location: string | null = a.locationNorth): Promise<string> {
  return asNorth(async (c) => {
    const { rows } = await c.query<{ id: string }>(
      `INSERT INTO pulse_survey (location_id, title, questions, opens_on, closes_on)
       VALUES ($1, 'Autumn pulse', $2, $3, $3) RETURNING id`,
      [location, JSON.stringify(QUESTIONS), today()],
    );
    return rows[0]?.id as string;
  });
}
const move = (survey: string, state: string) =>
  asNorth((c) => c.query("UPDATE pulse_survey SET state = $2 WHERE id = $1", [survey, state]));
const answer = (member: string, survey: string, answers: unknown) =>
  asMember(member, (c) =>
    c.query("SELECT app.submit_pulse_response($1, $2)", [survey, JSON.stringify(answers)]),
  );
const results = (survey: string) =>
  asNorth(async (c) => {
    const { rows } = await c.query<{ r: Record<string, unknown> }>(
      "SELECT app.pulse_survey_results($1) AS r",
      [survey],
    );
    return rows[0]?.r as {
      visible: boolean;
      reason?: string;
      respondents?: number;
      minGroupSize: number;
      questions?: { id: string; visible: boolean; counts?: number[]; texts?: string[] }[];
    };
  });

beforeAll(async () => {
  db = await createTestDatabase();
  await seedTwoTenants(db.pool("harbour_owner"));
  await asAdmin((c) =>
    c.query(
      `INSERT INTO rate_table (key, value, unit, nation, valid_from, source, verification_status)
       SELECT 'wellbeing.survey_min_group_size', 5, 'count', 'all', '2000-01-01', 'Test', 'to-verify'
       WHERE NOT EXISTS (SELECT 1 FROM rate_table
         WHERE key = 'wellbeing.survey_min_group_size' AND tenant_id IS NULL)`,
    ),
  );
  await asOwnerRole(TENANT_A, async (c) => {
    await c.query(
      `INSERT INTO tenant_user (id, display_name, email, status)
       SELECT id, 'Worker ' || n, 'worker' || n || '@example.invalid', 'active'
       FROM unnest($1::uuid[]) WITH ORDINALITY AS w(id, n)`,
      [[...WORKERS, SOUTH_WORKER]],
    );
    await c.query(
      `INSERT INTO role (id, key, name, scope_kind, permissions, is_builtin) VALUES
         ($1, 'registered_manager', 'Manager', 'location',
          '{scheduling.wellbeing.manage,scheduling.wellbeing.self}', true),
         ($2, 'care_worker_wellbeing', 'Care worker', 'assigned', '{scheduling.wellbeing.self}', false)`,
      [ROLE_MANAGER, ROLE_WORKER],
    );
    await c.query(
      "INSERT INTO role_assignment (tenant_user_id, role_id, location_id) VALUES ($1, $2, $3)",
      [a.northManager, ROLE_MANAGER, a.locationNorth],
    );
    for (const w of WORKERS) {
      await c.query(
        "INSERT INTO role_assignment (tenant_user_id, role_id, location_id) VALUES ($1, $2, $3)",
        [w, ROLE_WORKER, a.locationNorth],
      );
    }
    await c.query(
      "INSERT INTO role_assignment (tenant_user_id, role_id, location_id) VALUES ($1, $2, $3)",
      [SOUTH_WORKER, ROLE_WORKER, a.locationSouth],
    );
    // Only members on a staff file from before a survey opens may answer it.
    for (const w of [...WORKERS, SOUTH_WORKER]) {
      await c.query(
        `INSERT INTO staff_profile (tenant_user_id, location_id, job_title, starts_on)
         VALUES ($1, $2, 'Care worker', '2026-09-01')`,
        [w, w === SOUTH_WORKER ? a.locationSouth : a.locationNorth],
      );
    }
  });
}, 120_000);

afterAll(async () => {
  await db?.drop();
});

describe("SCHED-011 pulse surveys", () => {
  it("keeps the state lists in step", () => {
    expect([...PULSE_SURVEY_STATE_CODES]).toEqual([...SURVEY_STATES]);
  });

  it("refuses an answer to a draft, from another home, twice, or out of shape", async () => {
    const survey = await newSurvey();
    expect(await code(answer(WORKERS[0] as string, survey, { q1: 4 }))).toBe(
      "pulse_survey_not_found",
    );
    await move(survey, "open");
    expect(await code(answer(SOUTH_WORKER, survey, { q1: 4 }))).toBe("pulse_survey_not_found");
    expect(await code(answer(WORKERS[0] as string, survey, { q1: 9 }))).toBe(
      "pulse_response_invalid",
    );
    expect(await code(answer(WORKERS[0] as string, survey, { q9: 3 }))).toBe(
      "pulse_response_invalid",
    );
    expect(await code(answer(WORKERS[0] as string, survey, {}))).toBe("pulse_response_invalid");
    expect(await code(answer(WORKERS[0] as string, survey, { q1: 4 }))).toBe("ok");
    expect(await code(answer(WORKERS[0] as string, survey, { q1: 2 }))).toBe(
      "pulse_already_answered",
    );
    // The survey is fixed once open, and never goes back.
    expect(
      await code(
        asNorth((c) =>
          c.query("UPDATE pulse_survey SET title = 'Changed' WHERE id = $1", [survey]),
        ),
      ),
    ).toBe("pulse_survey_fixed");
    await move(survey, "closed");
    expect(await code(move(survey, "open"))).toBe("pulse_survey_wrong_state");
    expect(await code(answer(WORKERS[1] as string, survey, { q1: 4 }))).toBe(
      "pulse_survey_not_open",
    );
  });

  it("keeps a response apart from its member until the survey closes, then releases it", async () => {
    const survey = await newSurvey();
    await move(survey, "open");
    await answer(WORKERS[1] as string, survey, { q1: 3, q2: "Longer handovers" });
    const columns = await asAdmin((c) =>
      c.query<{ column_name: string }>(
        `SELECT column_name FROM information_schema.columns
         WHERE table_schema = 'public' AND table_name = 'pulse_survey_response' ORDER BY 1`,
      ),
    );
    expect(columns.rows.map((r) => r.column_name)).toEqual([
      "answers",
      "id",
      "submitted_week",
      "survey_id",
      "tenant_id",
    ]);
    const waiting = await asAdmin((c) =>
      c.query("SELECT 1 FROM pulse_survey_response_pending WHERE survey_id = $1", [survey]),
    );
    expect(waiting.rowCount).toBe(1);
    const before = await asAdmin((c) =>
      c.query("SELECT 1 FROM pulse_survey_response WHERE survey_id = $1", [survey]),
    );
    expect(before.rowCount).toBe(0);
    // Nothing is audited as it arrives.
    const early = await asAdmin((c) =>
      c.query(
        "SELECT 1 FROM audit_event WHERE action = 'scheduling.pulse_survey.responded' AND resource_id = $1",
        [survey],
      ),
    );
    expect(early.rowCount).toBe(0);
    await move(survey, "closed");
    const stored = await asAdmin((c) =>
      c.query<{ id: string; dow: number; linked: number }>(
        `SELECT r.id, extract(isodow FROM r.submitted_week)::int AS dow,
           (SELECT count(*)::int FROM pulse_survey_participation p
             WHERE p.survey_id = r.survey_id AND p.xmin = r.xmin) AS linked
         FROM pulse_survey_response r WHERE r.survey_id = $1`,
        [survey],
      ),
    );
    expect(stored.rows).toHaveLength(1);
    expect(stored.rows[0]?.dow).toBe(1);
    // A random UUID (version 4), and no shared transaction with the participation row.
    expect(stored.rows[0]?.id.charAt(14)).toBe("4");
    expect(stored.rows[0]?.linked).toBe(0);
    const left = await asAdmin((c) =>
      c.query("SELECT 1 FROM pulse_survey_response_pending WHERE survey_id = $1", [survey]),
    );
    expect(left.rowCount).toBe(0);
    const audited = await asAdmin((c) =>
      c.query<{ actor: string | null; scope: unknown }>(
        `SELECT actor_tenant_user_id AS actor, scope FROM audit_event
         WHERE action = 'scheduling.pulse_survey.responded' AND resource_id = $1`,
        [survey],
      ),
    );
    expect(audited.rows).toEqual([{ actor: null, scope: { actor: "anonymous" } }]);
    for (const table of ["pulse_survey_response", "pulse_survey_response_pending"]) {
      expect(
        await code(
          asNorth((c) => c.query(`SELECT * FROM ${table} WHERE survey_id = $1`, [survey])),
        ),
      ).toMatch(/permission denied/);
    }
    // The member sees that they took part; a manager sees no one's taking part.
    const mine = await asMember(WORKERS[1] as string, (c) =>
      c.query("SELECT survey_id FROM pulse_survey_participation WHERE survey_id = $1", [survey]),
    );
    expect(mine.rowCount).toBe(1);
    const theirs = await asNorth((c) =>
      c.query("SELECT 1 FROM pulse_survey_participation WHERE survey_id = $1", [survey]),
    );
    expect(theirs.rowCount).toBe(0);
  });

  it("refuses the home's survey managers and anyone not on a staff file before it opened", async () => {
    const survey = await newSurvey();
    await move(survey, "open");
    expect(await code(answer(a.northManager, survey, { q1: 4 }))).toBe(
      "pulse_response_not_eligible",
    );
    // A member given a staff file after the survey opened cannot answer it.
    const late = "0199d115-0000-7000-8000-000000000621";
    await asOwnerRole(TENANT_A, async (c) => {
      await c.query(
        "INSERT INTO tenant_user (id, display_name, email, status) VALUES ($1, 'Late Starter', 'late@example.invalid', 'active')",
        [late],
      );
      await c.query(
        "INSERT INTO role_assignment (tenant_user_id, role_id, location_id) VALUES ($1, $2, $3)",
        [late, ROLE_WORKER, a.locationNorth],
      );
      await c.query(
        `INSERT INTO staff_profile (tenant_user_id, location_id, job_title, starts_on)
         VALUES ($1, $2, 'Care worker', '2026-11-01')`,
        [late, a.locationNorth],
      );
    });
    expect(await code(answer(late, survey, { q1: 4 }))).toBe("pulse_response_not_eligible");
  });

  it("shows results only once closed and at the minimum group size, each question likewise", async () => {
    const survey = await newSurvey();
    await move(survey, "open");
    for (const [i, w] of WORKERS.slice(0, 4).entries()) {
      await answer(w, survey, { q1: (i % 5) + 1, q2: `Idea ${String.fromCharCode(68 - i)}` });
    }
    expect(await results(survey)).toMatchObject({ visible: false, reason: "still_open" });
    await answer(WORKERS[4] as string, survey, { q1: 5 });
    await move(survey, "closed");
    const shown = await results(survey);
    expect(shown).toMatchObject({ visible: true, respondents: 5, minGroupSize: 5 });
    const [scale, text] = shown.questions ?? [];
    // Each point has one answer, below the size: none shows.
    expect(scale).toMatchObject({
      id: "q1",
      visible: true,
      counts: [null, null, null, null, null],
    });
    // Only four answered the free-text question: below the size, it is not shown.
    expect(text).toEqual({
      id: "q2",
      kind: "free_text",
      text: "What one thing would help?",
      visible: false,
    });
  });

  it("hides results below the size, with no count, and an organisation cannot lower it", async () => {
    const survey = await newSurvey();
    await move(survey, "open");
    for (const w of WORKERS.slice(0, 3)) await answer(w, survey, { q1: 2 });
    await move(survey, "closed");
    const hidden = await results(survey);
    expect(hidden).toEqual({ visible: false, reason: "too_few", minGroupSize: 5 });
    await asOwnerRole(TENANT_A, (c) =>
      c.query(
        `INSERT INTO rate_table (tenant_id, key, value, unit, nation, valid_from, source, verification_status)
         VALUES ($1, 'wellbeing.survey_min_group_size', 2, 'count', 'all', '2000-01-01', 'Own', 'verified')`,
        [TENANT_A],
      ),
    );
    expect(await results(survey)).toEqual({ visible: false, reason: "too_few", minGroupSize: 5 });
    await asOwnerRole(TENANT_A, (c) =>
      c.query(
        "UPDATE rate_table SET value = 8 WHERE tenant_id = $1 AND key = 'wellbeing.survey_min_group_size'",
        [TENANT_A],
      ),
    );
    expect((await results(survey)).minGroupSize).toBe(8);
    // A care worker, or another home's manager, gets no results at all.
    expect(
      await code(
        asMember(WORKERS[0] as string, (c) =>
          c.query("SELECT app.pulse_survey_results($1)", [survey]),
        ),
      ),
    ).toBe("pulse_survey_not_found");
  });

  it("keeps surveys inside their organisation", async () => {
    const survey = await newSurvey();
    const seen = await asOtherTenant((c) =>
      c.query("SELECT 1 FROM pulse_survey WHERE id = $1", [survey]),
    );
    expect(seen.rowCount).toBe(0);
    expect(
      await code(asOtherTenant((c) => c.query("SELECT app.pulse_survey_results($1)", [survey]))),
    ).toBe("pulse_survey_not_found");
  });
});

describe("SCHED-011 recognition and check-ins", () => {
  it("thanks a colleague, never oneself, seen by both and the home's manager only", async () => {
    const give = (from: string, to: string) =>
      asMember(from, (c) =>
        c.query(
          "INSERT INTO recognition (from_member_id, to_member_id, location_id, message) VALUES ($1, $2, $3, 'Thank you for staying late')",
          [from, to, a.locationNorth],
        ),
      );
    expect(await code(give(WORKERS[0] as string, WORKERS[0] as string))).toMatch(
      /row-level security|recognition_not_self/,
    );
    // The recipient must work at the home named.
    expect(await code(give(WORKERS[0] as string, SOUTH_WORKER))).toMatch(/row-level security/);
    expect(await code(give(WORKERS[0] as string, WORKERS[1] as string))).toBe("ok");
    const count = (fn: typeof asNorth) =>
      fn((c) => c.query("SELECT 1 FROM recognition")).then((r) => r.rowCount);
    expect(await count((f) => asMember(WORKERS[1] as string, f))).toBe(1);
    expect(await count(asNorth)).toBe(1);
    expect(await count((f) => asMember(WORKERS[2] as string, f))).toBe(0);
    expect(
      await code(
        asMember(WORKERS[0] as string, (c) => c.query("UPDATE recognition SET message = 'x'")),
      ),
    ).toMatch(/permission denied/);
  });

  it("shows a check-in to the manager only while the member shares it", async () => {
    const me = WORKERS[2] as string;
    const { rows } = await asMember(me, (c) =>
      c.query<{ id: string }>(
        "INSERT INTO wellbeing_check_in (member_id, location_id, mood, note) VALUES ($1, $2, 2, 'A hard week') RETURNING id",
        [me, a.locationNorth],
      ),
    );
    const id = rows[0]?.id as string;
    const managerSees = () =>
      asNorth((c) => c.query("SELECT 1 FROM wellbeing_check_in WHERE id = $1", [id])).then(
        (r) => r.rowCount,
      );
    expect(await managerSees()).toBe(0);
    // Nobody records a check-in for someone else.
    expect(
      await code(
        asNorth((c) =>
          c.query(
            "INSERT INTO wellbeing_check_in (member_id, location_id, mood) VALUES ($1, $2, 3)",
            [me, a.locationNorth],
          ),
        ),
      ),
    ).toMatch(/row-level security/);
    await asMember(me, (c) =>
      c.query("UPDATE wellbeing_check_in SET shared_at = now() WHERE id = $1", [id]),
    );
    expect(await managerSees()).toBe(1);
    // The manager cannot change it, and the member changes only whether it is shared.
    const changed = await asNorth((c) =>
      c.query("UPDATE wellbeing_check_in SET shared_at = NULL WHERE id = $1", [id]),
    );
    expect(changed.rowCount).toBe(0);
    expect(
      await code(
        asMember(me, (c) => c.query("UPDATE wellbeing_check_in SET mood = 5 WHERE id = $1", [id])),
      ),
    ).toBe("wellbeing_check_in_fixed");
    await asMember(me, (c) =>
      c.query("UPDATE wellbeing_check_in SET shared_at = NULL WHERE id = $1", [id]),
    );
    expect(await managerSees()).toBe(0);
    const other = await asOtherTenant((c) =>
      c.query("SELECT 1 FROM wellbeing_check_in WHERE id = $1", [id]),
    );
    expect(other.rowCount).toBe(0);
  });
});
