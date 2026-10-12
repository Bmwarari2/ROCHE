import type { ProblemDetails, TaskItem, TaskList, TaskSeriesItem } from "@harbour/contracts";
import { createDatabase, createPool, withRequestContext } from "@harbour/db";
import { DEMO } from "@harbour/db/seed";
import type pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  escalateTasks,
  materialiseTaskSeries,
  reportUnroutedDaily,
  retryUnroutedTasks,
  type TaskDeps,
  TENANT_SWEEP_FAILED_ACTION,
  UNROUTED_ACTIONS,
  UNROUTED_DAILY_EVENT,
} from "../src/jobs/tasks";
import { createLogger, type Logger } from "../src/logger";
import { escalateOverdueTasks } from "../src/services/tasks";
import { createHarness, type Harness, LODGE, OTHER } from "./support/harness";

let h: Harness;
let appPool: pg.Pool;
let deps: TaskDeps;

/** Demo residents 1 to 3 are assigned to the care worker; 4 to 6 are not. */
const resident = (n: number) => `0194d000-0000-7000-8600-${n.toString(16).padStart(12, "0")}`;
const HOUR = 3_600_000;

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

/** Reads as the owner inside the demo tenant (row-level security is forced even for the owner). */
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

/**
 * How many times a sweep failed for the demo organisation. A sweep catches one organisation's
 * failure and carries on (`eachTenant`), so a test that expects a count also checks this is 0.
 */
async function sweepFailures(job: string): Promise<number> {
  return asDemoTenant(
    async (c) =>
      (
        await c.query("SELECT 1 FROM audit_event WHERE action = $1 AND scope->>'job' = $2", [
          TENANT_SWEEP_FAILED_ACTION,
          job,
        ])
      ).rowCount ?? 0,
  );
}

const json = async <T>(response: Response) => (await response.json()) as T;
const as = (
  user: keyof Harness["tokens"],
  path: string,
  init: { method?: string; body?: unknown } = {},
) => h.request(path, { token: h.tokens[user], tenant: DEMO.tenantId, ...init });

async function createTask(body: Record<string, unknown>): Promise<TaskItem> {
  const response = await as("manager", "/v1/tasks", { method: "POST", body });
  expect(response.status).toBe(201);
  return json<TaskItem>(response);
}

describe("one-off tasks", () => {
  it("lets a manager create a task about a resident and the assigned carer complete it", async () => {
    const created = await createTask({
      title: "Check skin on heels",
      personId: resident(1),
      locationId: DEMO.locationId,
      dueAt: new Date(Date.now() + HOUR).toISOString(),
    });
    expect(created).toMatchObject({
      status: "open",
      timeState: "upcoming",
      kind: "platform.manual",
    });

    const mine = await json<TaskList>(await as("carer", `/v1/tasks?personId=${resident(1)}`));
    expect(mine.items.map((t) => t.id)).toContain(created.id);

    const done = await as("carer", `/v1/tasks/${created.id}/transition`, {
      method: "POST",
      body: { to: "done", version: created.version },
    });
    expect(done.status).toBe(200);
    expect(await json<TaskItem>(done)).toMatchObject({ status: "done", timeState: "closed" });
  });

  it("hides tasks about people outside the carer's scope (hazard HZ-011)", async () => {
    const other = await createTask({
      title: "Weigh before lunch",
      personId: resident(5),
      dueAt: new Date(Date.now() + HOUR).toISOString(),
    });
    const visible = await json<TaskList>(await as("carer", "/v1/tasks"));
    expect(visible.items.map((t) => t.id)).not.toContain(other.id);
    const attempt = await as("carer", `/v1/tasks/${other.id}/transition`, {
      method: "POST",
      body: { to: "done", version: other.version },
    });
    expect(attempt.status).toBe(404);
  });

  it("refuses a skip without a reason and a stale version", async () => {
    const t = await createTask({
      title: "Offer a drink",
      personId: resident(2),
      dueAt: new Date(Date.now() + HOUR).toISOString(),
    });
    const noReason = await as("carer", `/v1/tasks/${t.id}/transition`, {
      method: "POST",
      body: { to: "skipped", version: t.version },
    });
    expect(noReason.status).toBe(422);
    expect((await json<ProblemDetails>(noReason)).detail).toBe("Say why the task was not done.");

    const stale = await as("carer", `/v1/tasks/${t.id}/transition`, {
      method: "POST",
      body: { to: "skipped", reason: "Declined, offered tea instead", version: t.version + 1 },
    });
    expect(stale.status).toBe(409);
  });

  it("stops a care worker creating or assigning tasks", async () => {
    const response = await as("carer", "/v1/tasks", {
      method: "POST",
      body: { title: "Not mine to set", dueAt: new Date().toISOString() },
    });
    expect(response.status).toBe(403);
  });

  it("hides tasks about people from someone without MFA", async () => {
    // The nurse has no second factor in the harness.
    const response = await as("nurse", `/v1/tasks?personId=${resident(1)}`);
    expect(response.status).toBe(403);
    expect((await json<ProblemDetails>(response)).code).toBe("mfa_enrolment_required");
  });

  it("refuses a task about another tenant's person as not found", async () => {
    const response = await as("manager", "/v1/tasks", {
      method: "POST",
      body: {
        title: "Cross-tenant",
        personId: "0193b000-0000-7000-8000-000000000401",
        dueAt: new Date().toISOString(),
      },
    });
    expect(response.status).toBe(404);
  });

  it("assigns a task to a member of staff", async () => {
    const t = await createTask({
      title: "Fire door check",
      locationId: DEMO.locationId,
      dueAt: new Date().toISOString(),
    });
    const response = await as("manager", `/v1/tasks/${t.id}/assign`, {
      method: "POST",
      body: { assigneeTenantUserId: DEMO.users.carer.id, version: t.version },
    });
    expect(response.status).toBe(200);
    expect((await json<TaskItem>(response)).assigneeTenantUserId).toBe(DEMO.users.carer.id);
    const mine = await json<TaskList>(await as("carer", "/v1/tasks?view=mine"));
    expect(mine.items.map((x) => x.id)).toContain(t.id);
  });
});

async function refusedCreates(action: string): Promise<number> {
  return asDemoTenant(async (c) => {
    const { rows } = await c.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM audit_event
       WHERE action = $1 AND outcome = 'denied' AND reason = 'assignee_lacks_permission'`,
      [action],
    );
    return rows[0]?.n ?? 0;
  });
}

describe("hazards HZ-004 and HZ-005 a task about a person goes only to someone who may complete it", () => {
  it("refuses, and audits, a one-off task given on creation to someone without its permission (S1)", async () => {
    const before = await refusedCreates("platform.task.create");
    const body = {
      title: "Check skin on heels",
      personId: resident(1),
      locationId: DEMO.locationId,
      dueAt: new Date(Date.now() + HOUR).toISOString(),
    };
    // The quality lead reads care records but does not write them.
    const refused = await as("manager", "/v1/tasks", {
      method: "POST",
      body: { ...body, assigneeTenantUserId: LODGE.qualityLeadId },
    });
    expect(refused.status).toBe(422);
    expect(await refusedCreates("platform.task.create")).toBe(before + 1);
    // The care worker may be given it.
    const given = await createTask({ ...body, assigneeTenantUserId: DEMO.users.carer.id });
    expect(given.assigneeTenantUserId).toBe(DEMO.users.carer.id);
    // A general task still goes to anyone.
    const general = await createTask({
      title: "Fire door check",
      locationId: DEMO.locationId,
      dueAt: new Date(Date.now() + HOUR).toISOString(),
      assigneeTenantUserId: LODGE.qualityLeadId,
    });
    expect(general.assigneeTenantUserId).toBe(LODGE.qualityLeadId);
  });

  it("refuses, and audits, a series whose rounds would go to someone without their permission (S1)", async () => {
    const before = await refusedCreates("platform.task_series.create");
    const response = await as("manager", "/v1/task-series", {
      method: "POST",
      body: {
        title: "Reposition",
        personId: resident(2),
        locationId: DEMO.locationId,
        assigneeTenantUserId: LODGE.qualityLeadId,
        recurrence: { freq: "every_hours", hours: 4, anchorTime: "02:00" },
        startsOn: new Date().toISOString().slice(0, 10),
      },
    });
    expect(response.status).toBe(422);
    expect(await refusedCreates("platform.task_series.create")).toBe(before + 1);
    const made = await asDemoTenant((c) =>
      c.query("SELECT 1 FROM task WHERE person_id = $1 AND assignee_tenant_user_id = $2", [
        resident(2),
        LODGE.qualityLeadId,
      ]),
    );
    expect(made.rowCount).toBe(0);
  });
});

describe("recurring tasks", () => {
  it("schedules a 4-hourly turn and materialises the next 48 hours at once", async () => {
    const today = new Date().toISOString().slice(0, 10);
    const response = await as("manager", "/v1/task-series", {
      method: "POST",
      body: {
        title: "Reposition",
        personId: resident(3),
        recurrence: { freq: "every_hours", hours: 4, anchorTime: "02:00" },
        startsOn: today,
        windowAfterMinutes: 30,
        evidenceRequired: true,
      },
    });
    expect(response.status).toBe(201);
    const series = await json<TaskSeriesItem>(response);
    const tasks = await json<TaskList>(
      await as(
        "manager",
        `/v1/tasks?personId=${resident(3)}&from=${new Date().toISOString()}&to=${new Date(Date.now() + 48 * HOUR).toISOString()}`,
      ),
    );
    const turns = tasks.items.filter((t) => t.seriesId === series.id);
    expect(turns.length).toBeGreaterThanOrEqual(11);
    expect(turns.length).toBeLessThanOrEqual(12);
    expect(turns.every((t) => t.evidenceRequired)).toBe(true);

    // Running the worker again creates nothing new (idempotent), and not because it failed.
    expect(await materialiseTaskSeries(deps, new Date())).toBe(0);
    expect(await sweepFailures("task-series-materialise")).toBe(0);

    const ended = await as("manager", `/v1/task-series/${series.id}/end`, {
      method: "POST",
      body: { reason: "Pressure area healed", version: series.version },
    });
    expect(ended.status).toBe(200);
    const after = await json<TaskList>(
      await as("manager", `/v1/tasks?personId=${resident(3)}&status=open`),
    );
    expect(
      after.items.filter((t) => t.seriesId === series.id && Date.parse(t.dueAt) > Date.now()),
    ).toEqual([]);
  });

  it("needs evidence to complete a task that asks for it", async () => {
    const today = new Date().toISOString().slice(0, 10);
    const series = await json<TaskSeriesItem>(
      await as("manager", "/v1/task-series", {
        method: "POST",
        body: {
          title: "Fluid round",
          personId: resident(1),
          recurrence: { freq: "every_hours", hours: 2, anchorTime: "00:00" },
          startsOn: today,
          evidenceRequired: true,
        },
      }),
    );
    const list = await json<TaskList>(await as("carer", `/v1/tasks?personId=${resident(1)}`));
    const next = list.items.find((t) => t.seriesId === series.id);
    expect(next).toBeDefined();
    const without = await as("carer", `/v1/tasks/${next?.id}/transition`, {
      method: "POST",
      body: { to: "done", version: next?.version },
    });
    expect(without.status).toBe(422);
    const withEvidence = await as("carer", `/v1/tasks/${next?.id}/transition`, {
      method: "POST",
      body: {
        to: "done",
        evidenceType: "observation",
        evidenceId: "0194d000-0000-7000-8000-00000000abcd",
        version: next?.version,
      },
    });
    expect(withEvidence.status).toBe(200);
  });

  it("refuses an impossible recurrence with a plain-English reason", async () => {
    const response = await as("manager", "/v1/task-series", {
      method: "POST",
      body: {
        title: "Bad series",
        locationId: DEMO.locationId,
        recurrence: { freq: "daily", times: ["09:00"] },
        startsOn: "2026-11-05",
        endsOn: "2026-11-01",
      },
    });
    expect(response.status).toBe(422);
    expect((await json<ProblemDetails>(response)).detail).toBe("The series ends before it starts.");
  });
});

describe("hazard HZ-008 overdue tasks escalate once", () => {
  it("tells the nurse in charge once when a task is overdue past the threshold", async () => {
    const t = await createTask({
      title: "Check pressure mattress",
      personId: resident(2),
      locationId: DEMO.locationId,
      dueAt: new Date(Date.now() - 2 * HOUR).toISOString(),
      priority: "urgent",
    });
    expect(t.timeState).toBe("escalated");
    const first = await escalateTasks(deps, new Date());
    expect(first).toBeGreaterThanOrEqual(1);
    expect(await escalateTasks(deps, new Date())).toBe(0);

    const rows = await asDemoTenant(async (c) => {
      const result = await c.query<{
        recipient_tenant_user_id: string;
        severity: string;
        title: string;
      }>(
        "SELECT recipient_tenant_user_id, severity, title FROM notification WHERE source_type = 'task' AND source_id = $1",
        [t.id],
      );
      return result.rows;
    });
    // The clinical lead (nurse) at the location; the title carries no personal data.
    expect(rows.map((r) => r.recipient_tenant_user_id)).toContain(DEMO.users.nurse.id);
    expect(rows.every((r) => r.title === "A task is overdue" && r.severity === "urgent")).toBe(
      true,
    );

    const reread = await json<TaskList>(await as("manager", `/v1/tasks?personId=${resident(2)}`));
    expect(reread.items.find((x) => x.id === t.id)?.escalated).toBe(true);
  });
});

describe("hazard HZ-008 a sync task escalates only to people who can act on it (round 5, C-H1)", () => {
  it("tells holders of the task's permission at its location, not team leaders", async () => {
    const teamLeader = "0194d000-0000-7000-8000-0000000003f1";
    const overdueAt = new Date(Date.now() - 3 * HOUR);
    const [held, ordinary] = await asDemoTenant(async (c) => {
      await c.query(
        "INSERT INTO tenant_user (id, display_name, email, status) VALUES ($1, 'Tia Lead', 'tia@example.invalid', 'active')",
        [teamLeader],
      );
      await c.query(
        `INSERT INTO role_assignment (tenant_user_id, role_id, location_id, reason)
         SELECT $1, id, $2, 'Test' FROM role WHERE key = 'team_leader' AND tenant_id = $3`,
        [teamLeader, DEMO.locationId, DEMO.tenantId],
      );
      const insert = (kind: string, permission: string) =>
        c.query<{ id: string }>(
          `INSERT INTO task (location_id, kind, title, required_permission, assignee_role_key, due_at)
           VALUES ($1, $2, 'Check', $3, 'registered_manager', $4) RETURNING id`,
          [DEMO.locationId, kind, permission, overdueAt],
        );
      return [
        (await insert("sync.device_hold", "safety.incident.manage")).rows[0]?.id,
        (await insert("platform.adhoc", "platform.task.complete")).rows[0]?.id,
      ];
    });
    await escalateTasks(deps, new Date());
    const recipients = (taskId: string | undefined) =>
      asDemoTenant(async (c) =>
        (
          await c.query<{ recipient_tenant_user_id: string }>(
            "SELECT recipient_tenant_user_id FROM notification WHERE source_type = 'task' AND source_id = $1",
            [taskId],
          )
        ).rows.map((r) => r.recipient_tenant_user_id),
      );
    const toHold = await recipients(held);
    // The Registered Manager and the nurse at the location, and the owner across the organisation.
    expect(toHold).toEqual(
      expect.arrayContaining([DEMO.users.manager.id, DEMO.users.nurse.id, DEMO.users.owner.id]),
    );
    expect(toHold).not.toContain(teamLeader);
    expect(toHold).not.toContain(DEMO.users.carer.id);
    // Other tasks are unchanged: the first responders at the location, team leaders included.
    expect(await recipients(ordinary)).toContain(teamLeader);
  });

  it("does not tell a holder of the permission at another location (round 6)", async () => {
    const lodgeLead = "0194d000-0000-7000-8000-0000000003f3";
    const overdueAt = new Date(Date.now() - 3 * HOUR);
    const [home, there] = await asDemoTenant(async (c) => {
      await c.query(
        "INSERT INTO tenant_user (id, display_name, email, status) VALUES ($1, 'Lou Lodge', 'lou@example.invalid', 'active')",
        [lodgeLead],
      );
      await c.query(
        `INSERT INTO role_assignment (tenant_user_id, role_id, location_id, reason)
         SELECT $1, id, $2, 'Test' FROM role WHERE key = 'clinical_lead' AND tenant_id = $3`,
        [lodgeLead, LODGE.locationId, DEMO.tenantId],
      );
      const insert = (locationId: string) =>
        c.query<{ id: string }>(
          `INSERT INTO task (location_id, kind, title, required_permission, assignee_role_key, due_at)
           VALUES ($1, 'sync.device_hold', 'Check', 'safety.incident.manage', 'registered_manager', $2)
           RETURNING id`,
          [locationId, overdueAt],
        );
      return [
        (await insert(DEMO.locationId)).rows[0]?.id,
        (await insert(LODGE.locationId)).rows[0]?.id,
      ];
    });
    await escalateTasks(deps, new Date());
    const recipients = (taskId: string | undefined) =>
      asDemoTenant(async (c) =>
        (
          await c.query<{ recipient_tenant_user_id: string }>(
            "SELECT recipient_tenant_user_id FROM notification WHERE source_type = 'task' AND source_id = $1",
            [taskId],
          )
        ).rows.map((r) => r.recipient_tenant_user_id),
      );
    expect(await recipients(home)).toContain(DEMO.users.manager.id);
    expect(await recipients(home)).not.toContain(lodgeLead);
    expect(await recipients(there)).toContain(lodgeLead);
    expect(await recipients(there)).not.toContain(DEMO.users.manager.id);
  });

  it("signals again once a device's task is reset after a refused close (round 6, M1)", async () => {
    const overdueAt = new Date(Date.now() - 3 * HOUR);
    const held = await asDemoTenant(
      async (c) =>
        (
          await c.query<{ id: string }>(
            `INSERT INTO task (location_id, kind, title, required_permission, assignee_role_key, due_at)
             VALUES ($1, 'sync.device_hold', 'Check', 'safety.incident.manage', 'registered_manager', $2)
             RETURNING id`,
            [DEMO.locationId, overdueAt],
          )
        ).rows[0]?.id,
    );
    const toManager = () =>
      asDemoTenant(
        async (c) =>
          (
            await c.query(
              "SELECT 1 FROM notification WHERE source_type = 'task' AND source_id = $1 AND recipient_tenant_user_id = $2",
              [held, DEMO.users.manager.id],
            )
          ).rowCount,
      );
    await escalateTasks(deps, new Date());
    expect(await toManager()).toBe(1);
    // Escalated once only.
    await escalateTasks(deps, new Date());
    expect(await toManager()).toBe(1);
    // A new hold after a refused close resets the escalation (`device-holds.ts`): it signals again.
    await asDemoTenant((c) =>
      c.query("UPDATE task SET escalation_level = 0, escalated_at = NULL WHERE id = $1", [held]),
    );
    await escalateTasks(deps, new Date());
    expect(await toManager()).toBe(2);
  });
});

describe("hazard HZ-040 a sync task whose location has no one who can act on it (round 7, M5)", () => {
  /** Runs as the owner inside the other organisation, which has no holder of the permission. */
  async function asOther<T>(fn: (c: pg.PoolClient) => Promise<T>): Promise<T> {
    const client = await h.db.pool("harbour_owner").connect();
    try {
      await client.query("BEGIN");
      await client.query(
        "SELECT set_config('app.tenant_id', $1, true), set_config('app.scope', 'tenant', true)",
        [OTHER.tenantId],
      );
      const result = await fn(client);
      await client.query("COMMIT");
      return result;
    } finally {
      client.release();
    }
  }
  const vacant = "0194e000-0000-7000-8000-000000000102";
  const overdueHold = () =>
    asOther(
      async (c) =>
        (
          await c.query<{ id: string }>(
            `INSERT INTO task (location_id, kind, title, required_permission, assignee_role_key, due_at)
             VALUES ($1, 'sync.device_hold', 'Check', 'safety.incident.manage', 'registered_manager', $2)
             RETURNING id`,
            [vacant, new Date(Date.now() - 3 * HOUR)],
          )
        ).rows[0]?.id,
    );
  const state = (taskId: string | undefined) =>
    asOther(async (c) => {
      const row = await c.query<{ escalation_level: number }>(
        "SELECT escalation_level FROM task WHERE id = $1",
        [taskId],
      );
      const told = await c.query<{ recipient_tenant_user_id: string }>(
        "SELECT recipient_tenant_user_id FROM notification WHERE source_type = 'task' AND source_id = $1",
        [taskId],
      );
      const unrouted = await c.query(
        "SELECT 1 FROM audit_event WHERE action = 'sync.escalation_unrouted' AND resource_id = $1",
        [taskId],
      );
      return {
        level: row.rows[0]?.escalation_level,
        told: told.rows.map((r) => r.recipient_tenant_user_id),
        unrouted: unrouted.rowCount,
      };
    });

  it("assigns the task to the longest-serving Registered Manager elsewhere when the post at its location is vacant, who can then see and complete it (round 8, M1)", async () => {
    await asOther((c) =>
      c.query("INSERT INTO location (id, name) VALUES ($1, 'Vacant House')", [vacant]),
    );
    const held = await overdueHold();
    await escalateTasks(deps, new Date());
    // No one at the house holds safety.incident.manage, and no one across the organisation does:
    // the Registered Manager at the other home is told, and the task is now theirs.
    expect(await state(held)).toEqual({ level: 1, told: [OTHER.managerId], unrouted: 0 });
    const [assigned] = await asOther(
      async (c) =>
        (
          await c.query<{ assignee: string | null }>(
            "SELECT assignee_tenant_user_id AS assignee FROM task WHERE id = $1",
            [held],
          )
        ).rows,
    );
    expect(assigned?.assignee).toBe(OTHER.managerId);
    // Their role covers their own home only, yet as the assignee they can list and complete it.
    const other = (path: string, init: { method?: string; body?: unknown } = {}) =>
      h.request(path, { token: h.tokens.rae, tenant: OTHER.tenantId, ...init });
    const from = new Date(Date.now() - 24 * HOUR).toISOString();
    const to = new Date(Date.now() + 24 * HOUR).toISOString();
    const list = await json<TaskList>(
      await other(`/v1/tasks?from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}`),
    );
    const item = list.items.find((t) => t.id === held);
    expect(item).toBeDefined();
    const done = await other(`/v1/tasks/${held}/transition`, {
      method: "POST",
      body: { to: "done", version: item?.version },
    });
    expect(done.status).toBe(200);
  });

  it("hazard HZ-008 gives a refused-entry review the same fallback when no one at its location can review it (#25 review round 2, M3)", async () => {
    const empty = "0194e000-0000-7000-8000-000000000103";
    await asOther((c) =>
      c.query("INSERT INTO location (id, name) VALUES ($1, 'Empty House')", [empty]),
    );
    const review = await asOther(
      async (c) =>
        (
          await c.query<{ id: string }>(
            `INSERT INTO task (location_id, kind, title, required_permission, assignee_role_key, due_at, priority)
             VALUES ($1, 'care.refused_entry_review', 'Review entries a device could not save',
                     'care.plan.write', 'clinical_lead', $2, 'urgent')
             RETURNING id`,
            [empty, new Date(Date.now() - 3 * HOUR)],
          )
        ).rows[0]?.id,
    );
    await escalateTasks(deps, new Date());
    // Nobody at the house holds care.plan.write: the longest-serving Registered Manager elsewhere is
    // told, and the review is now theirs, rather than it escalating to no one.
    expect(await state(review)).toEqual({ level: 1, told: [OTHER.managerId], unrouted: 0 });
  });

  it("never marks a task escalated when no one at all can be told, audits the gap once a day, and leaves it out of the next day's batches (security review round 7, L3)", async () => {
    const ended = await asOther(async (c) =>
      (
        await c.query<{ id: string }>(
          "UPDATE role_assignment SET deleted_at = now() WHERE deleted_at IS NULL RETURNING id",
        )
      ).rows.map((r) => r.id),
    );
    let held: string | undefined;
    try {
      held = await overdueHold();
      await escalateTasks(deps, new Date());
      await escalateTasks(deps, new Date());
      expect(await state(held)).toEqual({ level: 0, told: [], unrouted: 1 });
    } finally {
      await asOther((c) =>
        c.query("UPDATE role_assignment SET deleted_at = NULL WHERE id = ANY($1::uuid[])", [ended]),
      );
    }
    // A manager is back, but the task waits out the day before it is tried again, so tasks no one
    // can be told about never fill the batch.
    await escalateTasks(deps, new Date());
    expect(await state(held)).toEqual({ level: 0, told: [], unrouted: 1 });
  });
});

describe("hazard HZ-008 hazard HZ-073 an overdue task is never told only to someone who has left (ADR-0071 review round 2, C2-M4)", () => {
  // An invented home, Harbour Cottage, with one resident, Ivy Example; Tom, a team leader whose
  // role there ended yesterday, and Rae, its Registered Manager.
  const TOM = "0194d000-0000-7000-8000-0000000003c1";
  const RAE = "0194d000-0000-7000-8000-0000000003c2";
  const COTTAGE = "0194d000-0000-7000-8000-0000000001c1";
  const IVY = "0194d000-0000-7000-8600-0000000001c1";

  it("skips a team leader whose role has ended and tells the Registered Manager", async () => {
    const taskId = await asDemoTenant(async (c) => {
      await c.query("INSERT INTO location (id, name) VALUES ($1, 'Harbour Cottage')", [COTTAGE]);
      await c.query(
        `INSERT INTO person (id, location_id, status, given_name, family_name, nhs_number)
         VALUES ($1, $2, 'active', 'Ivy', 'Example', '9990000107')`,
        [IVY, COTTAGE],
      );
      await c.query(
        `INSERT INTO tenant_user (id, display_name, email, status) VALUES
           ($1, 'Tom Leftsoon', 'tom.leftsoon@example.invalid', 'active'),
           ($2, 'Rae Lodge', 'rae.lodge@example.invalid', 'active')`,
        [TOM, RAE],
      );
      await c.query(
        `INSERT INTO role_assignment (tenant_user_id, role_id, location_id, valid_from, valid_to)
         SELECT $1::uuid, id, $3::uuid, now() - interval '30 days', now() - interval '1 day'
           FROM role WHERE key = 'team_leader'
         UNION ALL
         SELECT $2::uuid, id, $3::uuid, now() - interval '30 days', NULL
           FROM role WHERE key = 'registered_manager'`,
        [TOM, RAE, COTTAGE],
      );
      const { rows } = await c.query<{ id: string }>(
        `INSERT INTO task (person_id, location_id, kind, title, required_permission, due_at, priority)
         VALUES ($1, $2, 'platform.manual', 'Repeat the observations', 'care.note.write',
                 now() - interval '3 hours', 'urgent')
         RETURNING id`,
        [IVY, COTTAGE],
      );
      return rows[0]?.id ?? "";
    });
    expect(await escalateTasks(deps, new Date())).toBeGreaterThanOrEqual(1);
    const told = await asDemoTenant(async (c) => {
      const result = await c.query<{ recipient_tenant_user_id: string }>(
        "SELECT recipient_tenant_user_id FROM notification WHERE source_type = 'task' AND source_id = $1",
        [taskId],
      );
      return result.rows.map((r) => r.recipient_tenant_user_id);
    });
    expect(told).toEqual([RAE]);
  });
});

describe("hazard HZ-008 hazard HZ-073 an overdue task goes down the order until someone active is told (ADR-0071 review round 3, C3-M3)", () => {
  // An invented home, Harbour Barn, with one resident, Iris Example; Ola, a team leader there who
  // has been invited but never signed in, and Ora, a Registered Manager across the organisation.
  const OLA = "0194d000-0000-7000-8000-0000000003e1";
  const ORA = "0194d000-0000-7000-8000-0000000003e2";
  const BARN = "0194d000-0000-7000-8000-0000000001e1";
  const IRIS = "0194d000-0000-7000-8600-0000000001e1";

  const overdueTask = () =>
    asDemoTenant(async (c) => {
      const { rows } = await c.query<{ id: string }>(
        `INSERT INTO task (person_id, location_id, kind, title, required_permission, due_at, priority)
         VALUES ($1, $2, 'platform.manual', 'Repeat the observations', 'care.note.write',
                 now() - interval '3 hours', 'urgent')
         RETURNING id`,
        [IRIS, BARN],
      );
      return rows[0]?.id ?? "";
    });
  const outcome = (taskId: string) =>
    asDemoTenant(async (c) => {
      const told = await c.query<{ recipient_tenant_user_id: string }>(
        "SELECT recipient_tenant_user_id FROM notification WHERE source_type = 'task' AND source_id = $1",
        [taskId],
      );
      const row = await c.query<{ escalation_level: number }>(
        "SELECT escalation_level FROM task WHERE id = $1",
        [taskId],
      );
      const audited = await c.query<{ reason: string }>(
        `SELECT reason FROM audit_event
         WHERE action = 'task.escalation_unrouted' AND resource_id = $1`,
        [taskId],
      );
      return {
        told: told.rows.map((r) => r.recipient_tenant_user_id).sort(),
        level: row.rows[0]?.escalation_level,
        unrouted: audited.rows.map((r) => r.reason),
      };
    });

  beforeAll(async () => {
    await asDemoTenant(async (c) => {
      await c.query("INSERT INTO location (id, name) VALUES ($1, 'Harbour Barn')", [BARN]);
      await c.query(
        `INSERT INTO person (id, location_id, status, given_name, family_name, nhs_number)
         VALUES ($1, $2, 'active', 'Iris', 'Example', '9990000115')`,
        [IRIS, BARN],
      );
      await c.query(
        `INSERT INTO tenant_user (id, display_name, email, status) VALUES
           ($1, 'Ola Invited', 'ola.invited@example.invalid', 'invited'),
           ($2, 'Ora Overall', 'ora.overall@example.invalid', 'active')`,
        [OLA, ORA],
      );
      await c.query(
        `INSERT INTO role_assignment (tenant_user_id, role_id, location_id, organisation_wide,
           valid_from)
         SELECT $1, id, NULL, true, now() - interval '30 days' FROM role
         WHERE key = 'registered_manager'`,
        [ORA],
      );
    });
  });

  it("tells a Registered Manager across the organisation when no one at the home leads or manages", async () => {
    const taskId = await overdueTask();
    await escalateTasks(deps, new Date());
    expect(await outcome(taskId)).toEqual({ told: [ORA], level: 1, unrouted: [] });
  });

  it("never counts a team leader who has been invited but never signed in", async () => {
    await asDemoTenant((c) =>
      c.query(
        `INSERT INTO role_assignment (tenant_user_id, role_id, location_id, valid_from)
         SELECT $1, id, $2, now() - interval '30 days' FROM role WHERE key = 'team_leader'`,
        [OLA, BARN],
      ),
    );
    const skipped = await overdueTask();
    await escalateTasks(deps, new Date());
    expect(await outcome(skipped)).toEqual({ told: [ORA], level: 1, unrouted: [] });
    // Once Ola has signed in, the team leader is told first.
    await asDemoTenant((c) =>
      c.query("UPDATE tenant_user SET status = 'active' WHERE id = $1", [OLA]),
    );
    const first = await overdueTask();
    await escalateTasks(deps, new Date());
    expect(await outcome(first)).toEqual({ told: [OLA], level: 1, unrouted: [] });
  });

  it("with no one at all, audits the gap with a coded reason and leaves the task to be tried again", async () => {
    // Ola has left, Ora's role has ended and the owner is suspended: no one active can see Iris.
    await asDemoTenant(async (c) => {
      await c.query("UPDATE tenant_user SET status = 'left' WHERE id = $1", [OLA]);
      await c.query(
        "UPDATE role_assignment SET valid_to = now() - interval '1 minute' WHERE tenant_user_id = $1",
        [ORA],
      );
      await c.query("UPDATE tenant_user SET status = 'suspended' WHERE id = $1", [
        DEMO.users.owner.id,
      ]);
    });
    try {
      const taskId = await overdueTask();
      await escalateTasks(deps, new Date());
      expect(await outcome(taskId)).toEqual({
        told: [],
        level: 0,
        unrouted: ["no_one_sees_person"],
      });
      // Within the hour it is not tried again, so it never crowds the batch.
      await escalateTasks(deps, new Date());
      expect(await outcome(taskId)).toEqual({
        told: [],
        level: 0,
        unrouted: ["no_one_sees_person"],
      });
    } finally {
      await asDemoTenant((c) =>
        c.query("UPDATE tenant_user SET status = 'active' WHERE id = $1", [DEMO.users.owner.id]),
      );
    }
  });
});

describe("hazard HZ-008 hazard HZ-073 escalation means someone other than the assignee is told (ADR-0071 review round 4, C4-M1)", () => {
  // An invented home, Harbour Byre, with one resident, Bryn Example; Ivo, a care worker there
  // assigned to Bryn. No one else works there, and the owner is suspended for the first tests.
  const IVO = "0194d000-0000-7000-8000-0000000003f7";
  const BYRE = "0194d000-0000-7000-8000-0000000001f2";
  const BRYN = "0194d000-0000-7000-8600-0000000001f2";
  const MINUTE = 60_000;

  const overdueFor = (locationId: string | null) =>
    asDemoTenant(async (c) => {
      const { rows } = await c.query<{ id: string }>(
        `INSERT INTO task (person_id, location_id, kind, title, required_permission, due_at,
           assignee_tenant_user_id)
         VALUES ($1, $2, 'platform.manual', 'Reposition', 'care.note.write',
                 now() - interval '3 hours', $3)
         RETURNING id`,
        [BRYN, locationId, IVO],
      );
      return rows[0]?.id ?? "";
    });
  const state = (taskId: string) =>
    asDemoTenant(async (c) => {
      const told = await c.query<{ recipient_tenant_user_id: string }>(
        "SELECT recipient_tenant_user_id FROM notification WHERE source_type = 'task' AND source_id = $1",
        [taskId],
      );
      const row = await c.query<{ escalation_level: number }>(
        "SELECT escalation_level FROM task WHERE id = $1",
        [taskId],
      );
      const audited = await c.query<{ reason: string }>(
        `SELECT reason FROM audit_event
         WHERE action = 'task.escalation_unrouted' AND resource_id = $1 ORDER BY seq`,
        [taskId],
      );
      return {
        told: told.rows.map((r) => r.recipient_tenant_user_id).sort(),
        level: row.rows[0]?.escalation_level,
        unrouted: audited.rows.map((r) => r.reason),
      };
    });
  const setOwner = (status: string) =>
    asDemoTenant((c) =>
      c.query("UPDATE tenant_user SET status = $2 WHERE id = $1", [DEMO.users.owner.id, status]),
    );

  beforeAll(async () => {
    await asDemoTenant(async (c) => {
      await c.query("INSERT INTO location (id, name) VALUES ($1, 'Harbour Byre')", [BYRE]);
      await c.query(
        `INSERT INTO person (id, location_id, status, given_name, family_name, nhs_number)
         VALUES ($1, $2, 'active', 'Bryn', 'Example', '9990000131')`,
        [BRYN, BYRE],
      );
      await c.query(
        `INSERT INTO tenant_user (id, display_name, email, status)
         VALUES ($1, 'Ivo Carer', 'ivo.carer@example.invalid', 'active')`,
        [IVO],
      );
      await c.query(
        `INSERT INTO role_assignment (tenant_user_id, role_id, location_id, valid_from)
         SELECT $1, id, $2, now() - interval '30 days' FROM role WHERE key = 'care_worker'`,
        [IVO, BYRE],
      );
      await c.query(
        `INSERT INTO person_assignment (tenant_user_id, person_id, valid_from)
         VALUES ($1, $2, now() - interval '30 days')`,
        [IVO, BRYN],
      );
    });
  });

  it("tells the assignee but audits the gap, keeps the level and tries again within the hour, auditing once a day", async () => {
    await setOwner("suspended");
    let taskId = "";
    try {
      const now = new Date();
      taskId = await overdueFor(BYRE);
      await escalateTasks(deps, now);
      expect(await state(taskId)).toEqual({ told: [IVO], level: 0, unrouted: ["assignee_only"] });
      // The minute run leaves it to the hourly retry; the retry finds no one either and writes
      // no second audit within the day.
      await escalateTasks(deps, new Date(now.getTime() + MINUTE));
      await retryUnroutedTasks(deps, new Date(now.getTime() + 60 * MINUTE));
      expect(await state(taskId)).toEqual({ told: [IVO], level: 0, unrouted: ["assignee_only"] });
    } finally {
      await setOwner("active");
    }
    // Someone who can act is back: the next hourly retry escalates to them.
    await retryUnroutedTasks(deps, new Date(Date.now() + 120 * MINUTE));
    expect(await state(taskId)).toEqual({
      told: [DEMO.users.owner.id, IVO].sort(),
      level: 1,
      unrouted: ["assignee_only"],
    });
  });

  it("routes a task about a person with no location to the person's home, only to those who can see them", async () => {
    // The Registered Manager at Harbour House holds the role nearest a task with no place, but
    // cannot see Bryn: the owner, who can, is told.
    const taskId = await overdueFor(null);
    await escalateTasks(deps, new Date());
    expect(await state(taskId)).toEqual({
      told: [DEMO.users.owner.id, IVO].sort(),
      level: 1,
      unrouted: [],
    });
  });

  it("gives a new task about a person the person's home when none is given (low)", async () => {
    const created = await createTask({
      title: "Check skin on heels",
      personId: resident(1),
      dueAt: new Date(Date.now() + HOUR).toISOString(),
    });
    expect(created.locationId).toBe(DEMO.locationId);
  });

  it("writes one operator line a day per organisation with unrouted safety work, counting each kind", async () => {
    const lines: { event: string; tenantId: string; counts: Record<string, number> }[] = [];
    const logger = {
      warn: (fields: { event: string; tenantId: string; counts: Record<string, number> }) =>
        lines.push(fields),
      info: () => undefined,
      error: () => undefined,
      debug: () => undefined,
    } as unknown as Logger;
    const now = new Date();
    const reported = await reportUnroutedDaily({ ...deps, logger }, now);
    const expected = await asDemoTenant(async (c) => {
      const { rows } = await c.query<{ action: string; count: number }>(
        `SELECT action, count(*)::int AS count FROM audit_event
         WHERE action = ANY($1::text[]) AND occurred_at > $2::timestamptz - interval '25 hours'
           AND occurred_at <= $2::timestamptz
         GROUP BY action`,
        [[...UNROUTED_ACTIONS], now],
      );
      return Object.fromEntries(
        UNROUTED_ACTIONS.map((a) => [a, rows.find((r) => r.action === a)?.count ?? 0]),
      );
    });
    // This organisation has unrouted tasks from the tests above (round 3 and this one).
    expect(expected["task.escalation_unrouted"]).toBeGreaterThanOrEqual(2);
    expect(reported.get(DEMO.tenantId)).toEqual(expected);
    expect(lines).toContainEqual({
      event: UNROUTED_DAILY_EVENT,
      tenantId: DEMO.tenantId,
      counts: expected,
    });
    // One line per organisation, opaque ids and counts only.
    expect(lines.filter((l) => l.tenantId === DEMO.tenantId)).toHaveLength(1);
    expect(Object.keys(lines[0] ?? {}).sort()).toEqual(["counts", "event", "tenantId"]);
  });
});

describe("hazard HZ-008 hazard HZ-018 hazard HZ-073 escalation reaches every organisation and every unrouted task (ADR-0071 review round 5)", () => {
  // An invented home, Harbour Croft, with one resident, Cai Example; Oona, a care worker there
  // assigned to Cai. No one else works there; the owner is suspended where a test needs that.
  const OONA = "0194d000-0000-7000-8000-0000000003f9";
  const CROFT = "0194d000-0000-7000-8000-0000000001f5";
  const CAI = "0194d000-0000-7000-8600-0000000001f5";
  const MINUTE = 60_000;
  const demoContext = {
    tenantId: DEMO.tenantId,
    userId: null,
    scope: "tenant" as const,
    locationIds: [],
  };

  /** Runs as the owner inside the other organisation. */
  async function asOther<T>(fn: (c: pg.PoolClient) => Promise<T>): Promise<T> {
    const client = await h.db.pool("harbour_owner").connect();
    try {
      await client.query("BEGIN");
      await client.query(
        "SELECT set_config('app.tenant_id', $1, true), set_config('app.scope', 'tenant', true)",
        [OTHER.tenantId],
      );
      const result = await fn(client);
      await client.query("COMMIT");
      return result;
    } finally {
      client.release();
    }
  }
  const setStatus = (id: string, status: string) =>
    asDemoTenant((c) => c.query("UPDATE tenant_user SET status = $2 WHERE id = $1", [id, status]));
  const levels = (ids: readonly string[]) =>
    asDemoTenant(async (c) =>
      (
        await c.query<{ escalation_level: number }>(
          "SELECT escalation_level FROM task WHERE id = ANY($1::uuid[])",
          [ids],
        )
      ).rows.map((r) => r.escalation_level),
    );
  const reasons = (taskId: string) =>
    asDemoTenant(async (c) =>
      (
        await c.query<{ reason: string }>(
          `SELECT reason FROM audit_event
           WHERE action = 'task.escalation_unrouted' AND resource_id = $1 ORDER BY seq`,
          [taskId],
        )
      ).rows.map((r) => r.reason),
    );

  beforeAll(async () => {
    await asDemoTenant(async (c) => {
      await c.query("INSERT INTO location (id, name) VALUES ($1, 'Harbour Croft')", [CROFT]);
      await c.query(
        `INSERT INTO person (id, location_id, status, given_name, family_name)
         VALUES ($1, $2, 'active', 'Cai', 'Example')`,
        [CAI, CROFT],
      );
      await c.query(
        `INSERT INTO tenant_user (id, display_name, email, status)
         VALUES ($1, 'Oona Carer', 'oona.carer@example.invalid', 'active')`,
        [OONA],
      );
      await c.query(
        `INSERT INTO role_assignment (tenant_user_id, role_id, location_id, valid_from)
         SELECT $1, id, $2, now() - interval '30 days' FROM role WHERE key = 'care_worker'`,
        [OONA, CROFT],
      );
      await c.query(
        `INSERT INTO person_assignment (tenant_user_id, person_id, valid_from)
         VALUES ($1, $2, now() - interval '30 days')`,
        [OONA, CAI],
      );
    });
  });

  it("goes on to the next organisation when one organisation's run fails, and audits the failure (C5-M2)", async () => {
    // Every alert in the demo organisation fails to be written, as a fault in its data would.
    const owner = h.db.pool("harbour_owner");
    await owner.query(
      `CREATE FUNCTION test_fail_demo_alerts() RETURNS trigger LANGUAGE plpgsql AS $$
       BEGIN
         IF NEW.tenant_id = '${DEMO.tenantId}'::uuid THEN RAISE EXCEPTION 'injected failure'; END IF;
         RETURN NEW;
       END $$`,
    );
    await owner.query(
      `CREATE TRIGGER test_fail_demo_alerts BEFORE INSERT ON notification
       FOR EACH ROW EXECUTE FUNCTION test_fail_demo_alerts()`,
    );
    const insertTask = (c: pg.PoolClient, locationId: string) =>
      c
        .query<{ id: string }>(
          `INSERT INTO task (location_id, kind, title, required_permission, due_at)
           VALUES ($1, 'platform.adhoc', 'Fire door check', 'platform.task.complete',
                   now() - interval '3 hours')
           RETURNING id`,
          [locationId],
        )
        .then((r) => r.rows[0]?.id ?? "");
    let inDemo = "";
    let inOther = "";
    try {
      inDemo = await asDemoTenant((c) => insertTask(c, DEMO.locationId));
      inOther = await asOther((c) => insertTask(c, OTHER.locationId));
      // The demo organisation comes first (by id): its failure must not stop the other's.
      expect(DEMO.tenantId < OTHER.tenantId).toBe(true);
      await escalateTasks(deps, new Date());
    } finally {
      await owner.query("DROP TRIGGER test_fail_demo_alerts ON notification");
      await owner.query("DROP FUNCTION test_fail_demo_alerts()");
    }
    // The other organisation's task escalated to its Registered Manager.
    const other = await asOther(async (c) => {
      const row = await c.query<{ escalation_level: number }>(
        "SELECT escalation_level FROM task WHERE id = $1",
        [inOther],
      );
      const told = await c.query<{ recipient_tenant_user_id: string }>(
        "SELECT recipient_tenant_user_id FROM notification WHERE source_type = 'task' AND source_id = $1",
        [inOther],
      );
      return {
        level: row.rows[0]?.escalation_level,
        told: told.rows.map((r) => r.recipient_tenant_user_id),
      };
    });
    expect(other).toEqual({ level: 1, told: [OTHER.managerId] });
    // The demo organisation's run rolled back and is audited, by job and code only.
    expect(await levels([inDemo])).toEqual([0]);
    const failed = await asDemoTenant(
      async (c) =>
        (
          await c.query<{ scope: unknown }>(
            "SELECT scope FROM audit_event WHERE action = 'platform.job.tenant_failed'",
          )
        ).rows,
    );
    expect(failed).toContainEqual({ scope: { job: "task-escalations", code: "P0001" } });
    // The next run, with the fault gone, escalates it.
    await escalateTasks(deps, new Date());
    expect(await levels([inDemo])).toEqual([1]);
  });

  it("does not count a sync task's own assignee as told: with no one else, they are told, it stays due and the gap is audited (low)", async () => {
    // A device's task with no location, given to the other organisation's only Registered
    // Manager; no one there holds safety.incident.manage across the organisation.
    const held = await asOther(
      async (c) =>
        (
          await c.query<{ id: string }>(
            `INSERT INTO task (kind, title, required_permission, assignee_tenant_user_id,
               assignee_role_key, due_at)
             VALUES ('sync.device_hold', 'Check', 'safety.incident.manage', $1,
                     'registered_manager', now() - interval '3 hours')
             RETURNING id`,
            [OTHER.managerId],
          )
        ).rows[0]?.id ?? "",
    );
    await escalateTasks(deps, new Date());
    await escalateTasks(deps, new Date(Date.now() + MINUTE));
    const state = await asOther(async (c) => {
      const row = await c.query<{ escalation_level: number; assignee: string }>(
        "SELECT escalation_level, assignee_tenant_user_id AS assignee FROM task WHERE id = $1",
        [held],
      );
      const told = await c.query<{ recipient_tenant_user_id: string }>(
        "SELECT recipient_tenant_user_id FROM notification WHERE source_type = 'task' AND source_id = $1",
        [held],
      );
      const audited = await c.query<{ reason: string }>(
        "SELECT reason FROM audit_event WHERE action = 'sync.escalation_unrouted' AND resource_id = $1",
        [held],
      );
      return {
        level: row.rows[0]?.escalation_level,
        assignee: row.rows[0]?.assignee,
        told: told.rows.map((r) => r.recipient_tenant_user_id),
        unrouted: audited.rows.map((r) => r.reason),
      };
    });
    expect(state).toEqual({
      level: 0,
      assignee: OTHER.managerId,
      told: [OTHER.managerId],
      unrouted: ["assignee_only"],
    });
  });

  it("retries every unrouted task each hour, however many, and audits a changed reason once (low)", async () => {
    const start = Date.now();
    const retry = (minutes: number) =>
      withRequestContext(deps.appDb, demoContext, (tx) =>
        // Two to a page, so five tasks take three pages.
        escalateOverdueTasks(tx, DEMO.tenantId, new Date(start + minutes * MINUTE), "retry", 2),
      );
    await setStatus(DEMO.users.owner.id, "suspended");
    let ids: string[] = [];
    try {
      ids = await asDemoTenant(async (c) =>
        (
          await c.query<{ id: string }>(
            `INSERT INTO task (person_id, location_id, kind, title, required_permission, due_at,
               assignee_tenant_user_id)
             SELECT $1, $2, 'platform.manual', 'Reposition', 'care.note.write',
                    now() - interval '3 hours' - make_interval(mins => n), $3
             FROM generate_series(1, 5) AS n
             RETURNING id`,
            [CAI, CROFT, OONA],
          )
        ).rows.map((r) => r.id),
      );
      await escalateTasks(deps, new Date(start));
      for (const id of ids) expect(await reasons(id)).toEqual(["assignee_only"]);
      // Oona leaves: on the hourly retry, which takes every page, each reason changes and is
      // audited again; the next retry within the day writes nothing more.
      await setStatus(OONA, "suspended");
      await retry(60);
      await retry(120);
      for (const id of ids) {
        expect(await reasons(id)).toEqual(["assignee_only", "no_one_sees_person"]);
      }
      expect(await levels(ids)).toEqual([0, 0, 0, 0, 0]);
    } finally {
      await setStatus(OONA, "active");
      await setStatus(DEMO.users.owner.id, "active");
    }
    // Someone who can act is back: the next retry escalates all five, not only the first page.
    await retry(180);
    expect(await levels(ids)).toEqual([1, 1, 1, 1, 1]);
  });

  it("refuses a task about a person placed at a home other than theirs (low)", async () => {
    const body = {
      title: "Check skin on heels",
      personId: resident(1),
      dueAt: new Date(Date.now() + HOUR).toISOString(),
    };
    const refused = await as("manager", "/v1/tasks", {
      method: "POST",
      body: { ...body, locationId: LODGE.locationId },
    });
    expect(refused.status).toBe(422);
    expect((await json<ProblemDetails>(refused)).detail).toContain("placed where they live");
    const placed = await createTask({ ...body, locationId: DEMO.locationId });
    expect(placed.locationId).toBe(DEMO.locationId);
  });
});
