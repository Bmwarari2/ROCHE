import type { ProblemDetails, TaskItem, TaskList, TaskSeriesItem } from "@harbour/contracts";
import { createDatabase, createPool } from "@harbour/db";
import { DEMO } from "@harbour/db/seed";
import type pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { escalateTasks, materialiseTaskSeries, type TaskDeps } from "../src/jobs/tasks";
import { createLogger } from "../src/logger";
import { createHarness, type Harness } from "./support/harness";

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

    // Running the worker again creates nothing new (idempotent).
    expect(await materialiseTaskSeries(deps, new Date())).toBe(0);

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
});
