import { createDatabase } from "@harbour/db";
import { DEMO } from "@harbour/db/seed";
import { addUkDays, ukIsoDate } from "@harbour/domain";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { remindSupervisionsDue } from "../src/jobs/tasks";
import { createLogger } from "../src/logger";
import { createHarness, type Harness, OTHER } from "./support/harness";

/**
 * Supervision and appraisal reminder tasks (workforce.md rule 7; WORK-009 slice 2): one task for
 * HR's role per meeting due inside `supervision.due_window_days` or overdue, once for each due
 * date; holding the meeting closes it; a new due date raises a new one; the window comes from the
 * rate table; nothing for another organisation or for a member with no staff role in force. The
 * sweep is run at chosen days, so the dates are the rules' own.
 */

let h: Harness;
const as = (who: string, path: string, init: { method?: string; body?: unknown } = {}) =>
  h.request(path, { ...init, token: h.tokens[who], tenant: DEMO.tenantId });
const CARER = DEMO.users.carer.id;
const NURSE = DEMO.users.nurse.id;
const MANAGER = DEMO.users.manager.id;
const dev = (member: string) => `/v1/workforce/members/${member}`;
const day = (offset: number) => ukIsoDate(addUkDays(new Date(), offset));
const at = (isoDay: string) => new Date(`${isoDay}T12:00:00Z`);

async function sql<T = Record<string, unknown>>(
  text: string,
  params: unknown[] = [],
  tenantId: string = DEMO.tenantId,
) {
  const client = await h.db.pool("harbour_owner").connect();
  try {
    await client.query("BEGIN");
    await client.query(
      "SELECT set_config('app.tenant_id', $1, true), set_config('app.scope', 'tenant', true)",
      [tenantId],
    );
    const { rows } = await client.query(text, params);
    await client.query("COMMIT");
    return rows as T[];
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

type ReminderRow = {
  title: string;
  status: string;
  priority: string;
  assignee_role_key: string;
  required_permission: string;
  location_id: string | null;
  person_id: string | null;
  details: { memberId: string; meetingKind: string; reminderDueOn: string };
};
const reminders = (memberId: string, kind = "supervision") =>
  sql<ReminderRow>(
    `SELECT title, status, priority, assignee_role_key, required_permission, location_id, person_id, details
       FROM task WHERE kind = 'workforce.supervision_due' AND source_id = $1
        AND details->>'meetingKind' = $2 ORDER BY created_at`,
    [memberId, kind],
  );

const deps = () => ({
  workerPool: h.db.pool("harbour_worker"),
  appDb: createDatabase(h.db.pool("harbour_app")),
  logger: createLogger("silent"),
});

/** When the member's next supervision falls due, as the API reads it. */
async function nextSupervisionDue(memberId: string): Promise<string> {
  const response = await as("manager", `${dev(memberId)}/development`);
  expect(response.status).toBe(200);
  const record = (await response.json()) as { nextSupervision: { dueOn: string } | null };
  if (!record.nextSupervision) throw new Error("no next supervision");
  return record.nextSupervision.dueOn;
}

const hold = async (
  memberId: string,
  kind: "supervision" | "appraisal" | "spot_check",
  heldOn: string,
) => {
  const response = await as("manager", `${dev(memberId)}/supervisions`, {
    method: "POST",
    body: { kind, heldOn, note: null },
  });
  expect(response.status, await response.clone().text()).toBe(200);
};

beforeAll(async () => {
  h = await createHarness();
  // The carer and the nurse each had a supervision and an appraisal 30 days ago.
  for (const member of [CARER, NURSE]) {
    await hold(member, "supervision", day(-30));
    await hold(member, "appraisal", day(-30));
  }
});
afterAll(async () => {
  await h?.close();
});

describe("WORK-009 supervision and appraisal reminders (workforce.md rule 7)", () => {
  it("raises one reminder when two sweeps run at once (the per-organisation lock)", async () => {
    const dueOn = await nextSupervisionDue(CARER);
    const overdue = at(ukIsoDate(addUkDays(at(dueOn), 3)));
    await Promise.all([
      remindSupervisionsDue(deps(), overdue),
      remindSupervisionsDue(deps(), overdue),
    ]);
    expect((await reminders(CARER)).map((r) => r.details.reminderDueOn)).toEqual([dueOn]);
  });

  it("raises one reminder for HR's role when a supervision is overdue, and only once", async () => {
    const dueOn = await nextSupervisionDue(CARER);
    const overdue = at(ukIsoDate(addUkDays(at(dueOn), 3)));
    await remindSupervisionsDue(deps(), overdue);
    expect(await remindSupervisionsDue(deps(), overdue)).toBe(0);
    const rows = await reminders(CARER);
    expect(rows).toEqual([
      {
        title: "Hold a supervision that is due",
        status: "open",
        priority: "urgent",
        assignee_role_key: "hr",
        required_permission: "workforce.supervision.manage",
        location_id: null,
        person_id: null,
        details: { memberId: CARER, meetingKind: "supervision", reminderDueOn: dueOn },
      },
    ]);
    // The appraisal is a year away: no reminder for it yet.
    expect(await reminders(CARER, "appraisal")).toEqual([]);
  });

  it("closes the reminder when the supervision is held, and raises a new one for the next date", async () => {
    const first = await nextSupervisionDue(CARER);
    await hold(CARER, "spot_check", day(0));
    // A spot check never counts as a supervision, so it closes nothing.
    expect((await reminders(CARER)).map((r) => r.status)).toEqual(["open"]);
    await hold(CARER, "supervision", day(0));
    expect((await reminders(CARER)).map((r) => r.status)).toEqual(["cancelled"]);
    const next = await nextSupervisionDue(CARER);
    expect(next > first).toBe(true);
    // Not yet due: nothing new.
    await remindSupervisionsDue(deps(), new Date());
    expect(await reminders(CARER)).toHaveLength(1);
    // Overdue again: one new reminder, for the new date.
    await remindSupervisionsDue(deps(), at(ukIsoDate(addUkDays(at(next), 1))));
    const rows = await reminders(CARER);
    expect(rows.map((r) => [r.status, r.details.reminderDueOn])).toEqual([
      ["cancelled", first],
      ["open", next],
    ]);
  });

  it("raises nothing about one organisation's staff in another's", async () => {
    const strangers = await sql<{ n: string }>(
      `SELECT count(*) AS n FROM task t
        WHERE t.kind = 'workforce.supervision_due'
          AND NOT EXISTS (SELECT 1 FROM tenant_user u WHERE u.id = t.source_id)`,
    );
    expect(Number(strangers[0]?.n)).toBe(0);
    const elsewhere = await sql<{ n: string }>(
      "SELECT count(*) AS n FROM task WHERE kind = 'workforce.supervision_due' AND source_id = ANY($1)",
      [[CARER, NURSE]],
      OTHER.tenantId,
    );
    expect(Number(elsewhere[0]?.n)).toBe(0);
  });

  it("takes the window from the rate table: none outside it, one inside it", async () => {
    const owner = await as("owner", `${dev(MANAGER)}/supervisions`, {
      method: "POST",
      body: { kind: "supervision", heldOn: day(-30), note: null },
    });
    expect(owner.status, await owner.clone().text()).toBe(200);
    const dueOn = await nextSupervisionDue(MANAGER);
    // About a month away: outside the default window, so nothing yet.
    await remindSupervisionsDue(deps(), new Date());
    expect(await reminders(MANAGER)).toEqual([]);
    // The organisation's own figure wins over the default: with a wider window it is due now.
    await sql(
      `INSERT INTO rate_table (tenant_id, key, value, unit, nation, valid_from, source, verification_status)
       VALUES ($1, 'supervision.due_window_days', 60, 'days', 'all', '2000-01-01', 'test', 'verified')`,
      [DEMO.tenantId],
    );
    await remindSupervisionsDue(deps(), new Date());
    const [routine] = await reminders(MANAGER);
    expect(routine).toMatchObject({ priority: "routine", details: { reminderDueOn: dueOn } });
  });

  it("raises nothing for a member with no staff role in force", async () => {
    const before = (await reminders(NURSE)).length;
    await sql(
      "UPDATE role_assignment SET valid_to = now() - interval '1 day' WHERE tenant_user_id = $1",
      [NURSE],
    );
    // A year on, the nurse's supervision and appraisal would both be overdue if they were staff.
    await remindSupervisionsDue(deps(), at(day(400)));
    expect(await reminders(NURSE)).toHaveLength(before);
    expect(await reminders(NURSE, "appraisal")).toEqual([]);
  });
});
