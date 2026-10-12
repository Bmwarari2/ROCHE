import type {
  CarePlanActionItem,
  CarePlanDetail,
  HandoverDetail,
  HandoverList,
  PersonSummary,
  ProblemDetails,
  RoundView,
  TaskItem,
} from "@harbour/contracts";
import { HandoverItemKind } from "@harbour/contracts";
import { createDatabase, createPool } from "@harbour/db";
import { DEMO } from "@harbour/db/seed";
import { HANDOVER_ITEM_KINDS, MEDICINES_ACTION_MESSAGE } from "@harbour/domain";
import type pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  compileHandovers,
  escalateTasks,
  generatePlanTaskSeries,
  type TaskDeps,
} from "../src/jobs/tasks";
import { createLogger } from "../src/logger";
import { PLAN_CHANGED_REASON } from "../src/services/plan-tasks";
import { createHarness, type Harness, LODGE, OTHER } from "./support/harness";

/**
 * Phase 1 slice 5 through the API: care plan actions generate the shift's rounds (care.md rule
 * 14, CARE-013), the round view, and the shift handover with its notes, acknowledgements and late
 * additions (care.md rule 8, COMMS-006). Demo residents 1 to 3 are assigned to the care worker; the
 * Registered Manager covers the whole of Harbour House; the nurse (the nurse in charge) has no MFA
 * in the harness, so the manager and the care worker read and write here.
 */

let h: Harness;
let appPool: pg.Pool;
let deps: TaskDeps;

const resident = (n: number) => `0194d000-0000-7000-8600-${n.toString(16).padStart(12, "0")}`;
const MIN = 60_000;
const HOUR = 60 * MIN;
const newId = () => {
  const hex = Date.now().toString(16).padStart(12, "0");
  const rand = crypto.randomUUID().replace(/-/g, "");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-7${rand.slice(0, 3)}-8${rand.slice(3, 6)}-${rand.slice(6, 18)}`;
};

beforeAll(async () => {
  h = await createHarness();
  appPool = createPool(h.db.url("harbour_app"));
  deps = {
    workerPool: h.db.pool("harbour_worker"),
    appDb: createDatabase(appPool),
    logger: createLogger("silent"),
  };
}, 120_000);

afterAll(async () => {
  await appPool?.end();
  await h?.close();
});

const json = async <T>(response: Response) => (await response.json()) as T;
const as = (
  user: keyof Harness["tokens"],
  path: string,
  init: { method?: string; body?: unknown; tenant?: string } = {},
) => h.request(path, { token: h.tokens[user], tenant: DEMO.tenantId, ...init });

async function asDemoTenant<T>(fn: (c: pg.PoolClient) => Promise<T>): Promise<T> {
  const client = await h.db.pool("harbour_owner").connect();
  try {
    await client.query("BEGIN");
    await client.query(
      "SELECT set_config('app.tenant_id', $1, true), set_config('app.scope', 'tenant', true)",
      [DEMO.tenantId],
    );
    const result = await fn(client);
    await client.query("COMMIT");
    return result;
  } finally {
    client.release();
  }
}

const query = <T extends pg.QueryResultRow>(text: string, params: unknown[] = []) =>
  asDemoTenant(async (c) => (await c.query<T>(text, params)).rows);

const rate = async (key: string) =>
  Number(
    (await query<{ value: string }>("SELECT value FROM rate_table WHERE key = $1", [key]))[0]
      ?.value,
  );

const plansPath = (n: number) => `/v1/people/${resident(n)}/care-plans`;
const roundPath = (locationId: string = DEMO.locationId) => `/v1/locations/${locationId}/round`;
const handoversPath = (locationId: string = DEMO.locationId) =>
  `/v1/locations/${locationId}/handovers`;

async function publish(n: number, plan: CarePlanDetail): Promise<CarePlanDetail> {
  const response = await as("manager", `${plansPath(n)}/${plan.id}/publish`, {
    method: "POST",
    body: { version: plan.version },
  });
  expect(response.status).toBe(200);
  return json<CarePlanDetail>(response);
}

const planTasks = (personId: string, seriesId?: string) =>
  query<{
    id: string;
    series_id: string;
    source_id: string;
    title: string;
    status: string;
    status_reason: string | null;
    cancel_code: string | null;
    due_at: Date;
    window_start: Date;
    window_end: Date;
    evidence_required: boolean;
    required_permission: string;
    assignee_role_key: string;
  }>(
    `SELECT id, series_id, source_id, title, status, status_reason, cancel_code, due_at, window_start,
            window_end, evidence_required, required_permission, assignee_role_key
     FROM task WHERE person_id = $1 AND kind = 'care.plan_action'
       AND ($2::uuid IS NULL OR series_id = $2::uuid)
     ORDER BY due_at`,
    [personId, seriesId ?? null],
  );

describe("contract enumerations stay in step with the domain rules", () => {
  it("lists the handover item kinds in the domain's order", () => {
    expect(HandoverItemKind.options).toEqual([...HANDOVER_ITEM_KINDS]);
  });
});

// ------------------------------------------------------------------------------------------------
// Care plan rounds (care.md rule 14)
// ------------------------------------------------------------------------------------------------

describe("care.md rule 14: care plan actions generate the shift's rounds (CARE-013)", () => {
  let v1: CarePlanDetail;
  let turns: CarePlanActionItem;

  it("hazard HZ-024 publishing a plan generates each task-generating action's rounds, once", async () => {
    const draft = await json<CarePlanDetail>(
      await as("manager", plansPath(4), { method: "POST", body: {} }),
    );
    await as("manager", `${plansPath(4)}/${draft.id}/sections/skin`, {
      method: "PUT",
      body: {
        need: "Fragile skin on both heels.",
        outcome: "I want my skin to stay healthy.",
        version: 0,
      },
    });
    for (const body of [
      {
        action: "Help to change position",
        roleKey: "care_worker",
        recurrence: { freq: "every_hours", hours: 4, anchorTime: "02:00" },
        generatesTasks: true,
        evidenceRequired: true,
      },
      { action: "Apply barrier cream when the skin is red", generatesTasks: false },
    ]) {
      const created = await as("manager", `${plansPath(4)}/${draft.id}/sections/skin/actions`, {
        method: "POST",
        body,
      });
      expect(created.status).toBe(201);
    }
    v1 = await publish(4, draft);
    const actions = v1.sections[0]?.actions ?? [];
    turns = actions.find((a) => a.generatesTasks) as CarePlanActionItem;
    expect(turns.taskSeriesId).not.toBeNull();
    expect(actions.find((a) => !a.generatesTasks)?.taskSeriesId).toBeNull();

    const rows = await planTasks(resident(4));
    // Four-hourly for the next 48 hours.
    expect(rows.length).toBeGreaterThanOrEqual(11);
    expect(rows.length).toBeLessThanOrEqual(12);
    const before = await rate("care_plan.task_window_before_minutes");
    const after = await rate("care_plan.task_window_after_minutes");
    for (const row of rows) {
      expect(row).toMatchObject({
        series_id: turns.taskSeriesId,
        source_id: turns.id,
        title: "Care plan: skin",
        status: "open",
        evidence_required: true,
        required_permission: "care.note.write",
        assignee_role_key: "care_worker",
      });
      expect(row.window_end.getTime() - row.due_at.getTime()).toBe(after * MIN);
      expect(row.due_at.getTime() - row.window_start.getTime()).toBe(before * MIN);
    }

    // Generating again (the hourly sweep) changes nothing.
    expect(await generatePlanTaskSeries(deps)).toBe(0);
    expect(await planTasks(resident(4))).toHaveLength(rows.length);
  });

  it("hazard HZ-004 a new version carries an unchanged action's rounds forward, never cancelling or making one twice", async () => {
    const draft = await json<CarePlanDetail>(
      await as("manager", plansPath(4), { method: "POST", body: { copyFromActive: true } }),
    );
    const copy = draft.sections[0]?.actions.find((a) => a.generatesTasks) as CarePlanActionItem;
    expect(copy.basedOnActionId).toBe(turns.id);
    expect(copy.taskSeriesId).toBeNull();
    // New wording, same schedule: the rounds carry on and show the new words.
    const reworded = await as("manager", `${plansPath(4)}/${draft.id}/actions/${copy.id}`, {
      method: "PUT",
      body: { action: "Help to change position using the slide sheet", version: copy.version },
    });
    expect(reworded.status).toBe(200);
    const before = await planTasks(resident(4));
    const v2 = await publish(4, draft);
    const carried = v2.sections[0]?.actions.find((a) => a.generatesTasks) as CarePlanActionItem;
    expect(carried.taskSeriesId).toBe(turns.taskSeriesId);
    const after = await planTasks(resident(4));
    expect(after.map((t) => [t.id, t.status])).toEqual(before.map((t) => [t.id, t.status]));
    expect(after.every((t) => t.source_id === carried.id)).toBe(true);
    const [series] = await query<{ source_id: string; active: boolean }>(
      "SELECT source_id, active FROM task_series WHERE id = $1",
      [turns.taskSeriesId],
    );
    expect(series).toEqual({ source_id: carried.id, active: true });
    turns = carried;
  });

  it("hazard HZ-024 ends a changed action's rounds with the reason and starts the new schedule", async () => {
    const draft = await json<CarePlanDetail>(
      await as("manager", plansPath(4), { method: "POST", body: { copyFromActive: true } }),
    );
    const copy = draft.sections[0]?.actions.find((a) => a.generatesTasks) as CarePlanActionItem;
    await as("manager", `${plansPath(4)}/${draft.id}/actions/${copy.id}`, {
      method: "PUT",
      body: {
        recurrence: { freq: "every_hours", hours: 2, anchorTime: "00:00" },
        version: copy.version,
      },
    });
    const v3 = await publish(4, draft);
    const changed = v3.sections[0]?.actions.find((a) => a.generatesTasks) as CarePlanActionItem;
    expect(changed.taskSeriesId).not.toBe(turns.taskSeriesId);
    const [old] = await query<{ active: boolean; inactive_code: string | null }>(
      "SELECT active, inactive_code FROM task_series WHERE id = $1",
      [turns.taskSeriesId],
    );
    expect(old).toEqual({ active: false, inactive_code: null });
    const oldRounds = await planTasks(resident(4), turns.taskSeriesId ?? undefined);
    const future = oldRounds.filter((t) => t.due_at.getTime() > Date.now());
    expect(future.length).toBeGreaterThan(0);
    expect(
      future.every((t) => t.status === "cancelled" && t.status_reason === PLAN_CHANGED_REASON),
    ).toBe(true);
    const newRounds = await planTasks(resident(4), changed.taskSeriesId ?? undefined);
    expect(newRounds.length).toBeGreaterThanOrEqual(23);
    turns = changed;
  });

  it("hazard HZ-003 a plan change takes the pause code off the old schedule's rounds, so a return never brings them back", async () => {
    // Rounds paused while the person was away (people.md rule 1), as the lifecycle codes them.
    const paused = await query<{ id: string }>(
      `UPDATE task SET status = 'cancelled', status_reason = 'Paused while the person is away',
         cancel_code = 'paused_while_away'
       WHERE series_id = $1 AND due_at > now() + interval '1 day' RETURNING id`,
      [turns.taskSeriesId],
    );
    expect(paused.length).toBeGreaterThan(0);
    const draft = await json<CarePlanDetail>(
      await as("manager", plansPath(4), { method: "POST", body: { copyFromActive: true } }),
    );
    const copy = draft.sections[0]?.actions.find((a) => a.generatesTasks) as CarePlanActionItem;
    const removed = await as("manager", `${plansPath(4)}/${draft.id}/actions/${copy.id}`, {
      method: "PUT",
      body: { removed: true, version: copy.version },
    });
    expect(removed.status).toBe(200);
    await publish(4, draft);
    const rows = await query<{ cancel_code: string | null; status_reason: string }>(
      "SELECT cancel_code, status_reason FROM task WHERE id = ANY($1)",
      [paused.map((p) => p.id)],
    );
    expect(
      rows.every((r) => r.cancel_code === null && r.status_reason === PLAN_CHANGED_REASON),
    ).toBe(true);
    const live = await query(
      `SELECT id FROM task_series WHERE person_id = $1 AND source_type = 'care_plan_action'
         AND (active OR inactive_code IS NOT NULL)`,
      [resident(4)],
    );
    expect(live).toEqual([]);
  });

  it("hazard HZ-003 refuses a medicines action that generates tasks: doses come from the MAR", async () => {
    const draft = await json<CarePlanDetail>(
      await as("manager", plansPath(4), { method: "POST", body: { copyFromActive: true } }),
    );
    await as("manager", `${plansPath(4)}/${draft.id}/sections/medicines`, {
      method: "PUT",
      body: {
        need: "Needs prompting to take tablets.",
        outcome: "I take my tablets with breakfast.",
        version: 0,
      },
    });
    const refused = await as("manager", `${plansPath(4)}/${draft.id}/sections/medicines/actions`, {
      method: "POST",
      body: {
        action: "Prompt to take morning tablets",
        roleKey: "care_worker",
        recurrence: { freq: "daily", times: ["08:00"] },
        generatesTasks: true,
      },
    });
    expect(refused.status).toBe(422);
    expect((await json<ProblemDetails>(refused)).detail).toBe(MEDICINES_ACTION_MESSAGE);
    const asNeeded = await as("manager", `${plansPath(4)}/${draft.id}/sections/medicines/actions`, {
      method: "POST",
      body: { action: "Offer a drink of water with tablets", generatesTasks: false },
    });
    expect(asNeeded.status).toBe(201);
  });

  let sweptSeries = "";

  it("the hourly sweep makes the rounds of a plan published before slice 5, once, and audits it", async () => {
    const actionId = newId();
    await asDemoTenant(async (c) => {
      const plan = await c.query<{ id: string }>(
        `INSERT INTO care_plan (person_id, location_id, status, published_version, review_due_on)
         VALUES ($1, $2, 'active', 1, (now() + interval '20 days')::date) RETURNING id`,
        [resident(6), DEMO.locationId],
      );
      const section = await c.query<{ id: string }>(
        `INSERT INTO care_plan_section (person_id, plan_id, domain, need, outcome)
         VALUES ($1, $2, 'nutrition_and_hydration', 'Drinks little unless offered.',
                 'I want a cup of tea when I wake.') RETURNING id`,
        [resident(6), plan.rows[0]?.id],
      );
      await c.query(
        `INSERT INTO care_plan_action (id, person_id, plan_id, section_id, action, role_key, recurrence, generates_tasks)
         VALUES ($1, $2, $3, $4, 'Offer a drink and record it', 'care_worker',
                 '{"freq":"daily","times":["09:00","21:00"]}', true)`,
        [actionId, resident(6), plan.rows[0]?.id, section.rows[0]?.id],
      );
    });
    expect(await generatePlanTaskSeries(deps)).toBe(1);
    expect(await generatePlanTaskSeries(deps)).toBe(0);
    const [linked] = await query<{ task_series_id: string }>(
      "SELECT task_series_id FROM care_plan_action WHERE id = $1",
      [actionId],
    );
    sweptSeries = linked?.task_series_id ?? "";
    expect(sweptSeries).not.toBe("");
    const rounds = await planTasks(resident(6), sweptSeries);
    expect(rounds.length).toBeGreaterThanOrEqual(3);
    expect(rounds.every((r) => r.title === "Care plan: nutrition and hydration")).toBe(true);
    const audits = await query<{ action: string; actor_tenant_user_id: string | null }>(
      "SELECT action, actor_tenant_user_id FROM audit_event WHERE resource_id = $1 AND action = 'care.plan.tasks.generate'",
      [resident(6)],
    );
    expect(audits).toEqual([{ action: "care.plan.tasks.generate", actor_tenant_user_id: null }]);
  });

  it("refuses ending a care plan's rounds by the task series route: the plan changes them", async () => {
    const [series] = await query<{ version: number }>(
      "SELECT version FROM task_series WHERE id = $1",
      [sweptSeries],
    );
    const response = await as("manager", `/v1/task-series/${sweptSeries}/end`, {
      method: "POST",
      body: { reason: "No longer needed", version: series?.version },
    });
    expect(response.status).toBe(422);
    expect((await json<ProblemDetails>(response)).detail).toBe(
      "These rounds come from the care plan. Change the plan to stop or change them.",
    );
  });

  it("hazard HZ-008 an overdue care plan round escalates once to the nurse in charge, naming its location", async () => {
    const [round] = await query<{ id: string }>(
      `UPDATE task SET due_at = now() - interval '3 hours', window_start = now() - interval '210 minutes',
         window_end = now() - interval '2 hours'
       WHERE id = (SELECT id FROM task WHERE series_id = $1 ORDER BY due_at LIMIT 1) RETURNING id`,
      [sweptSeries],
    );
    expect(await escalateTasks(deps)).toBeGreaterThanOrEqual(1);
    const told = await query<{
      recipient_tenant_user_id: string;
      location_id: string;
      person_id: string;
    }>(
      "SELECT recipient_tenant_user_id, location_id, person_id FROM notification WHERE source_type = 'task' AND source_id = $1",
      [round?.id],
    );
    expect(told.map((n) => n.recipient_tenant_user_id)).toContain(DEMO.users.nurse.id);
    expect(
      told.every((n) => n.location_id === DEMO.locationId && n.person_id === resident(6)),
    ).toBe(true);
    await escalateTasks(deps);
    expect(
      await query("SELECT id FROM notification WHERE source_type = 'task' AND source_id = $1", [
        round?.id,
      ]),
    ).toHaveLength(told.length);
  });

  it("hazard HZ-003 a stay in hospital pauses a plan's rounds and the return brings the same rounds back, with one series", async () => {
    const statusChange = async (to: string) => {
      const person = await json<PersonSummary>(await as("manager", `/v1/people/${resident(6)}`));
      const response = await as("manager", `/v1/people/${resident(6)}/status`, {
        method: "POST",
        body: { to, effectiveAt: new Date().toISOString(), version: person.version },
      });
      expect(response.status).toBe(200);
    };
    const coming = (await planTasks(resident(6), sweptSeries)).filter(
      (t) => t.status === "open" && t.due_at.getTime() > Date.now() + MIN,
    );
    expect(coming.length).toBeGreaterThan(0);
    await statusChange("in_hospital");
    const away = await query<{ status: string; cancel_code: string | null }>(
      "SELECT status, cancel_code FROM task WHERE id = ANY($1)",
      [coming.map((t) => t.id)],
    );
    expect(
      away.every((t) => t.status === "cancelled" && t.cancel_code === "paused_while_away"),
    ).toBe(true);
    // The hourly sweep while the person is away: the series still belongs to its action.
    expect(await generatePlanTaskSeries(deps)).toBe(0);
    await statusChange("active");
    const back = await query<{ status: string }>("SELECT status FROM task WHERE id = ANY($1)", [
      coming.map((t) => t.id),
    ]);
    expect(back.every((t) => t.status === "open")).toBe(true);
    const live = await query(
      `SELECT id FROM task_series WHERE person_id = $1 AND source_type = 'care_plan_action'
         AND (active OR inactive_code IS NOT NULL)`,
      [resident(6)],
    );
    expect(live).toHaveLength(1);
    const dueTimes = (await planTasks(resident(6), sweptSeries)).map((t) => t.due_at.getTime());
    expect(new Set(dueTimes).size).toBe(dueTimes.length);
  });
});

// ------------------------------------------------------------------------------------------------
// The round view
// ------------------------------------------------------------------------------------------------

async function createTask(body: Record<string, unknown>): Promise<TaskItem> {
  const response = await as("manager", "/v1/tasks", { method: "POST", body });
  expect(response.status).toBe(201);
  return json<TaskItem>(response);
}

describe("the round view (CARE-013)", () => {
  it("hazard HZ-001 lists the shift's open tasks by floor and room, each stop with the point-of-care header", async () => {
    const turn = await createTask({
      title: "Check the pressure mattress",
      personId: resident(4),
      locationId: DEMO.locationId,
      dueAt: new Date(Date.now() + 10 * MIN).toISOString(),
    });
    const fridge = await createTask({
      title: "Check the fridge temperature",
      locationId: DEMO.locationId,
      dueAt: new Date(Date.now() + 5 * MIN).toISOString(),
    });
    const response = await as("manager", roundPath());
    expect(response.status).toBe(200);
    const view = await json<RoundView>(response);
    expect(["day", "night"]).toContain(view.shift.name);
    expect(view.complete).toBe(true);
    expect(Date.parse(view.readAt)).toBeLessThanOrEqual(Date.now());
    expect(view.areas.map((a) => a.area)).toEqual(["Ground", null]);
    const stops = view.areas[0]?.stops ?? [];
    // Rooms in natural order.
    const rooms = stops.map((s) => Number(s.roomLabel));
    expect(rooms).toEqual([...rooms].sort((a, b) => a - b));
    const room4 = stops.find((s) => s.personId === resident(4));
    expect(room4?.person?.allergies.map((a) => a.substance).sort()).toEqual(["Latex", "Peanut"]);
    expect(room4?.tasks.map((t) => t.id)).toContain(turn.id);
    // A care plan round shows the action as the active plan words it.
    const room6 = stops.find((s) => s.personId === resident(6));
    const planRound = room6?.tasks.find((t) => t.kind === "care.plan_action");
    expect(planRound?.planAction).toMatchObject({
      action: "Offer a drink and record it",
      domain: "nutrition_and_hydration",
      publishedVersion: 1,
    });
    expect(planRound?.timeState).toBe("escalated");
    // A task about nobody (the fridge) is its own stop at the end.
    expect(view.areas[1]?.stops.map((s) => [s.personId, s.tasks.map((t) => t.id)])).toEqual([
      [null, [fridge.id]],
    ]);
  });

  it("hazard HZ-011 shows a care worker only the people assigned to them", async () => {
    await createTask({
      title: "Help with a wash",
      personId: resident(1),
      locationId: DEMO.locationId,
      dueAt: new Date(Date.now() + 15 * MIN).toISOString(),
    });
    const view = await json<RoundView>(await as("carer", roundPath()));
    const people = view.areas.flatMap((a) => a.stops.map((s) => s.personId));
    expect(people).toContain(resident(1));
    expect(people.every((p) => [resident(1), resident(2), resident(3)].includes(p ?? ""))).toBe(
      true,
    );
  });

  it("refuses a location outside the viewer's scope, a half-given window and one over 24 hours", async () => {
    expect((await as("manager", roundPath(LODGE.locationId))).status).toBe(404);
    expect((await as("owner", roundPath(LODGE.locationId))).status).toBe(200);
    // Another organisation's location does not exist for this one (HZ-011).
    expect((await as("owner", roundPath(OTHER.locationId))).status).toBe(404);
    const from = new Date().toISOString();
    expect((await as("manager", `${roundPath()}?from=${from}`)).status).toBe(422);
    const to = new Date(Date.now() + 25 * HOUR).toISOString();
    expect((await as("manager", `${roundPath()}?from=${from}&to=${to}`)).status).toBe(422);
  });

  it("audits each view by location and count, never content", async () => {
    const audits = await query<{ scope: { locationId: string; count: number } }>(
      "SELECT scope FROM audit_event WHERE action = 'care.round.view' AND actor_tenant_user_id = $1",
      [DEMO.users.manager.id],
    );
    expect(audits.length).toBeGreaterThan(0);
    expect(audits[0]?.scope.locationId).toBe(DEMO.locationId);
    expect(JSON.stringify(audits)).not.toContain("fridge");
  });
});

// ------------------------------------------------------------------------------------------------
// The shift handover
// ------------------------------------------------------------------------------------------------

const vitalsHigh = {
  chart: "vitals",
  respirationRate: 26,
  spo2: 91,
  onOxygen: false,
  systolic: 88,
  pulse: 132,
  consciousness: "alert",
  temperature: 39.4,
};

describe("the shift handover (care.md rule 8, COMMS-006)", () => {
  let shift: RoundView["shift"];
  let inShift: string;
  let current: HandoverDetail;

  const note = (
    n: number,
    tags: string[],
    occurredAt: string,
    user: "carer" | "manager" = "carer",
  ) =>
    as(user, `/v1/people/${resident(n)}/notes`, {
      method: "POST",
      body: { category: "health", body: "Recorded for the handover.", tags, occurredAt },
    });
  const compile = (user: keyof Harness["tokens"], body: Record<string, unknown> = {}) =>
    as(user, handoversPath(), { method: "POST", body });

  beforeAll(async () => {
    shift = (await json<RoundView>(await as("manager", roundPath()))).shift;
    inShift = new Date(
      Math.max(Date.parse(shift.start) + 1000, Date.now() - 2 * MIN),
    ).toISOString();
  });

  it("hazard HZ-018 compiles every safety-critical item of the shift in the system's view, whoever asks", async () => {
    expect((await note(1, ["fall"], inShift)).status).toBe(201);
    expect((await note(2, ["refusal"], inShift)).status).toBe(201);
    await asDemoTenant((c) =>
      c.query(
        `INSERT INTO body_map_mark (person_id, location_id, occurred_at, view, region, side, mark_type)
         VALUES ($1, $2, $3, 'front', 'left_shin', 'left', 'bruise')`,
        [resident(3), DEMO.locationId, inShift],
      ),
    );
    const vitals = await as("manager", `/v1/people/${resident(5)}/observations`, {
      method: "POST",
      body: { occurredAt: inShift, values: vitalsHigh },
    });
    expect(vitals.status).toBe(201);

    // The care worker compiles: their view leaves out the people outside their scope...
    const response = await compile("carer");
    expect(response.status).toBe(200);
    const theirs = await json<HandoverDetail>(response);
    expect(theirs.shift).toEqual(shift);
    const kinds = (d: HandoverDetail, n: number) =>
      d.items.filter((i) => i.personId === resident(n)).map((i) => i.kind);
    expect(kinds(theirs, 1)).toContain("fall");
    expect(kinds(theirs, 2)).toContain("refusal");
    expect(kinds(theirs, 3)).toContain("body_map_mark");
    expect(kinds(theirs, 5)).toEqual([]);
    expect(theirs.hiddenItemCount).toBeGreaterThanOrEqual(2);
    expect(theirs.people.map((p) => p.id).sort()).toEqual(
      [resident(1), resident(2), resident(3)].sort(),
    );
    expect(theirs.open).toBe(true);
    expect(theirs.you).toMatchObject({ acknowledged: false, itemsSeen: null });

    // ...but the handover itself was compiled in the system's view, so nothing was missed.
    current = await json<HandoverDetail>(await as("manager", `${handoversPath()}/${theirs.id}`));
    expect(current.hiddenItemCount).toBe(0);
    expect(kinds(current, 5)).toContain("news2");
    // The urgent alert the score raised is one item, however many people it reached.
    expect(kinds(current, 5).filter((k) => k === "alert")).toHaveLength(1);
    expect(current.itemCount).toBe(theirs.itemCount);

    const audits = await query<{ action: string; actor_tenant_user_id: string }>(
      "SELECT action, actor_tenant_user_id FROM audit_event WHERE resource_id = $1 ORDER BY occurred_at",
      [theirs.id],
    );
    expect(audits[0]).toEqual({
      action: "care.handover.compile",
      actor_tenant_user_id: DEMO.users.carer.id,
    });
  });

  it("hazard HZ-018 records each acknowledgement once, for the items it held", async () => {
    const ackId = newId();
    const ack = (user: "carer" | "manager", body: Record<string, unknown>) =>
      as(user, `${handoversPath()}/${current.id}/acknowledgements`, { method: "POST", body });
    const first = await ack("carer", { id: ackId, itemsSeen: current.itemCount });
    expect(first.status).toBe(201);
    expect((await json<HandoverDetail>(first)).you).toMatchObject({
      acknowledged: true,
      itemsSeen: current.itemCount,
      unseenKeys: [],
    });
    expect((await ack("carer", { id: ackId, itemsSeen: current.itemCount })).status).toBe(201);
    // The same id from someone else is not theirs to replay.
    expect((await ack("manager", { id: ackId, itemsSeen: 0 })).status).toBe(422);
    const tooMany = await ack("manager", { itemsSeen: current.itemCount + 1 });
    expect(tooMany.status).toBe(422);
    expect((await ack("manager", { itemsSeen: current.itemCount })).status).toBe(201);
    const after = await json<HandoverDetail>(
      await as("manager", `${handoversPath()}/${current.id}`),
    );
    expect(
      after.acknowledgements.filter((a) => a.tenantUserId === DEMO.users.carer.id),
    ).toHaveLength(1);
    expect(after.acknowledgedBy.sort()).toEqual(
      [DEMO.users.carer.id, DEMO.users.manager.id].sort(),
    );
    expect(after.pending).toEqual([]);
  });

  it("hazard HZ-018 appends a late addition and asks again, for the new item only, those who can see it", async () => {
    const before = current.itemCount;
    expect((await note(3, ["fall"], inShift)).status).toBe(201);
    const refreshed = await json<HandoverDetail>(await compile("manager"));
    expect(refreshed.id).toBe(current.id);
    const added = refreshed.items.filter((i) => i.lateAddition);
    expect(added.map((i) => [i.kind, i.personId])).toEqual([["fall", resident(3)]]);
    expect(refreshed.itemCount).toBe(before + 1);
    expect(refreshed.pending.sort()).toEqual([DEMO.users.carer.id, DEMO.users.manager.id].sort());

    const carerView = await json<HandoverDetail>(
      await as("carer", `${handoversPath()}/${current.id}`),
    );
    expect(carerView.you).toMatchObject({
      acknowledged: false,
      unseenKeys: added.map((i) => i.key),
    });
    // Told at once: a fall cannot wait (HZ-008), with a title that names nobody.
    const told = await query<{
      severity: string;
      channels: string[];
      title: string;
      location_id: string;
    }>(
      `SELECT severity, channels, title, location_id FROM notification
       WHERE kind = 'care.handover.updated' AND recipient_tenant_user_id = $1 AND source_id = $2`,
      [DEMO.users.carer.id, current.id],
    );
    expect(told).toEqual([
      {
        severity: "urgent",
        channels: ["in_app", "push"],
        title: "A handover has new items",
        location_id: DEMO.locationId,
      },
    ]);
    for (const user of ["carer", "manager"] as const) {
      await as(user, `${handoversPath()}/${current.id}/acknowledgements`, {
        method: "POST",
        body: { itemsSeen: refreshed.itemCount },
      });
    }

    // A late addition about someone outside the care worker's scope asks only those who see it.
    const vitals = await as("manager", `/v1/people/${resident(5)}/observations`, {
      method: "POST",
      body: { occurredAt: new Date().toISOString(), values: vitalsHigh },
    });
    expect(vitals.status).toBe(201);
    const again = await json<HandoverDetail>(await compile("manager"));
    expect(again.itemCount).toBeGreaterThan(refreshed.itemCount);
    expect(again.pending).toEqual([DEMO.users.manager.id]);
    const carerAgain = await json<HandoverDetail>(
      await as("carer", `${handoversPath()}/${current.id}`),
    );
    expect(carerAgain.you).toMatchObject({ acknowledged: true, unseenKeys: [] });
    expect(
      await query(
        `SELECT id FROM notification WHERE kind = 'care.handover.updated' AND recipient_tenant_user_id = $1`,
        [DEMO.users.carer.id],
      ),
    ).toHaveLength(1);
    current = again;
  });

  it("hazard HZ-018 takes notes on an open handover and its items, never on an item out of scope", async () => {
    const path = `${handoversPath()}/${current.id}/notes`;
    const fall = current.items.find((i) => i.kind === "fall" && i.personId === resident(1));
    const id = newId();
    const general = await as("carer", path, {
      method: "POST",
      body: { id, body: "The lift on the first floor is out of order." },
    });
    expect(general.status).toBe(201);
    expect((await as("carer", path, { method: "POST", body: { id, body: "Again." } })).status).toBe(
      201,
    );
    const onItem = await as("carer", path, {
      method: "POST",
      body: { itemKey: fall?.key, body: "GP called back; observe tonight." },
    });
    const saved = await json<HandoverDetail>(onItem);
    expect(saved.notes.map((n) => [n.itemKey, n.personId, n.body])).toEqual([
      [null, null, "The lift on the first floor is out of order."],
      [fall?.key, resident(1), "GP called back; observe tonight."],
    ]);
    const outOfScope = current.items.find((i) => i.personId === resident(5));
    const refused = await as("carer", path, {
      method: "POST",
      body: { itemKey: outOfScope?.key, body: "Seen." },
    });
    expect(refused.status).toBe(422);
    expect((await json<ProblemDetails>(refused)).detail).toBe("That item is not on this handover.");
  });

  it("hazard HZ-018 the worker locks the last shift's handover and appends entries synced late", async () => {
    await compileHandovers(deps);
    const list = await json<HandoverList>(await as("manager", handoversPath()));
    const last = list.items.find((i) => Date.parse(i.shift.end) === Date.parse(shift.start));
    expect(last).toBeDefined();
    expect(last?.lockedAt).not.toBeNull();
    expect(last?.open).toBe(false);
    // Nobody has acknowledged it and the shift it hands over to has started.
    expect(last?.unacknowledged).toBe(true);
    const lastId = last?.id ?? "";
    const closed = await as("carer", `${handoversPath()}/${lastId}/notes`, {
      method: "POST",
      body: { body: "Too late for this one." },
    });
    expect(closed.status).toBe(422);
    expect((await json<ProblemDetails>(closed)).detail).toBe(
      "This handover has closed. Record anything new on the person's record, where the next handover finds it.",
    );
    await as("manager", `${handoversPath()}/${lastId}/acknowledgements`, {
      method: "POST",
      body: { itemsSeen: last?.itemCount },
    });

    // A fall recorded offline during that shift arrives now.
    const during = new Date(Date.parse(shift.start) - 30 * MIN).toISOString();
    expect((await note(1, ["fall"], during)).status).toBe(201);
    await compileHandovers(deps);
    const refreshed = await json<HandoverDetail>(
      await as("manager", `${handoversPath()}/${lastId}`),
    );
    expect(refreshed.lockedAt).toBe(last?.lockedAt);
    expect(refreshed.items.filter((i) => i.lateAddition).map((i) => [i.kind, i.personId])).toEqual([
      ["fall", resident(1)],
    ]);
    expect(refreshed.pending).toEqual([DEMO.users.manager.id]);
    const told = await query<{ severity: string }>(
      `SELECT severity FROM notification WHERE kind = 'care.handover.updated'
         AND recipient_tenant_user_id = $1 AND source_id = $2`,
      [DEMO.users.manager.id, lastId],
    );
    expect(told).toEqual([{ severity: "urgent" }]);
    // Nothing new: the next run writes nothing.
    await compileHandovers(deps);
    const [row] = await query<{ version: number }>("SELECT version FROM handover WHERE id = $1", [
      lastId,
    ]);
    expect(row?.version).toBe(refreshed.version);
  });

  it("refuses a shift that has not started, a location out of scope and a role without the permission", async () => {
    const tomorrow = new Date(Date.now() + 26 * HOUR).toISOString();
    const future = await compile("manager", { at: tomorrow });
    expect(future.status).toBe(422);
    expect((await as("manager", handoversPath(LODGE.locationId))).status).toBe(404);
    expect(
      (await as("manager", handoversPath(LODGE.locationId), { method: "POST", body: {} })).status,
    ).toBe(404);
    expect((await as("quality", handoversPath())).status).toBe(403);
    expect((await as("owner", handoversPath(OTHER.locationId))).status).toBe(404);
    expect(
      (await as("owner", handoversPath(OTHER.locationId), { method: "POST", body: {} })).status,
    ).toBe(404);
    expect((await as("manager", `${handoversPath()}/${newId()}`)).status).toBe(404);
  });

  it("audits every read and write of a handover by record id, never its content", async () => {
    const rows = await query<{ action: string; scope: unknown }>(
      `SELECT action, scope FROM audit_event
       WHERE action LIKE 'care.handover.%' AND actor_tenant_user_id IS NOT NULL`,
    );
    const actions = new Set(rows.map((r) => r.action));
    for (const action of [
      "care.handover.compile",
      "care.handover.refresh",
      "care.handover.view",
      "care.handover.list",
      "care.handover.acknowledge",
      "care.handover.note.create",
    ]) {
      expect(actions).toContain(action);
    }
    expect(JSON.stringify(rows)).not.toContain("GP called back");
  });
});
