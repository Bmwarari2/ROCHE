import type {
  AcknowledgedLoneWorkerAlarm,
  LoneWorkerAlarmList,
  LoneWorkerBoard,
  LoneWorkerEventResult,
  LoneWorkerMine,
  LoneWorkerRoute,
  ProblemDetails,
} from "@harbour/contracts";
import {
  LoneWorkerAlarmReason,
  LoneWorkerAlarmState,
  LoneWorkerEventKind,
  LoneWorkerOutcome,
} from "@harbour/contracts";
import { createDatabase, createPool } from "@harbour/db";
import { DEMO } from "@harbour/db/seed";
import {
  LONE_WORKER_ALARM_REASONS,
  LONE_WORKER_ALARM_STATES,
  LONE_WORKER_EVENT_KINDS,
  LONE_WORKER_OUTCOMES,
} from "@harbour/domain";
import type pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { runEscalations, sweepLoneWorkersJob, type TaskDeps } from "../src/jobs/tasks";
import { createLogger } from "../src/logger";
import { createHarness, type Harness, LODGE } from "./support/harness";

/**
 * Lone-worker safety through the API (SCHED-012, Phase 2 slice 46; scheduling.md section 14;
 * HZ-125): off until the organisation names its on-call route; sessions and idempotent events;
 * the offline rule (a check-in made on time but sent late never counts as missed, and one that
 * arrives after the alarm resolves it as a late check-in, flagged, unless the worker is overdue
 * again); duress that looks like a check-in; the order worker, on-call, Registered Manager; re-
 * alerts until acknowledged; acknowledgement by someone else only; location evidence off by
 * default and erased at its date. Demo users: the care worker works alone; the nurse is on call;
 * the Registered Manager monitors.
 */

let h: Harness;
let appPool: pg.Pool;
let deps: TaskDeps;
const MINUTE = 60_000;
const at = (offsetMinutes: number) => new Date(Date.now() + offsetMinutes * MINUTE);
const iso = (offsetMinutes: number) => at(offsetMinutes).toISOString();

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
  init: { method?: string; body?: unknown } = {},
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

const notificationsOf = (userId: string, kind?: string) =>
  asDemoTenant(async (c) => {
    const { rows } = await c.query<{
      title: string;
      kind: string;
      acknowledged_at: Date | null;
      source_id: string;
      body: string;
    }>(
      `SELECT title, kind, acknowledged_at, source_id, body FROM notification
        WHERE recipient_tenant_user_id = $1 AND ($2::text IS NULL OR kind = $2)
        ORDER BY created_at`,
      [userId, kind ?? null],
    );
    return rows;
  });

const ROUTE = {
  steps: [
    { afterMinutes: 1, targetTenantUserId: DEMO.users.nurse.id, channels: ["push", "sms"] },
    { afterMinutes: 10, targetRoleKey: "registered_manager", channels: ["push", "email"] },
  ],
};

const start = (
  user: keyof Harness["tokens"],
  body: Partial<Record<string, unknown>> = {},
): Promise<Response> =>
  as(user, "/v1/lone-worker/sessions", {
    method: "POST",
    body: {
      id: crypto.randomUUID(),
      locationId: DEMO.locationId,
      workKind: "night_shift",
      startedAt: iso(-80),
      plannedEndAt: iso(300),
      intervalMinutes: 60,
      ...body,
    },
  });

const send = (
  user: keyof Harness["tokens"],
  sessionId: string,
  body: Partial<Record<string, unknown>>,
): Promise<Response> =>
  as(user, `/v1/lone-worker/sessions/${sessionId}/events`, {
    method: "POST",
    body: { id: crypto.randomUUID(), kind: "check_in", deviceAt: iso(0), ...body },
  });

const alarmsOfSession = (sessionId: string) =>
  asDemoTenant(async (c) => {
    const { rows } = await c.query<{
      id: string;
      reason: string;
      state: string;
      alert_count: number;
    }>(
      "SELECT id, reason, state, alert_count FROM lone_worker_alarm WHERE session_id = $1 ORDER BY raised_at",
      [sessionId],
    );
    return rows;
  });

describe("the contract keeps the lone-worker code lists in step with the domain", () => {
  it("lists every event kind, alarm reason, state and outcome", () => {
    expect([...LoneWorkerEventKind.options]).toEqual([...LONE_WORKER_EVENT_KINDS]);
    expect([...LoneWorkerAlarmReason.options]).toEqual([...LONE_WORKER_ALARM_REASONS]);
    expect([...LoneWorkerAlarmState.options]).toEqual([...LONE_WORKER_ALARM_STATES]);
    expect([...LoneWorkerOutcome.options]).toEqual([...LONE_WORKER_OUTCOMES]);
  });
});

describe("off until the organisation names its on-call route (H-539)", () => {
  it("refuses a session in words while no route is named", async () => {
    const route = await json<LoneWorkerRoute>(await as("carer", "/v1/lone-worker/route"));
    expect(route.on).toBe(false);
    expect(route.locationEvidence).toBe(false);
    const response = await start("carer");
    expect(response.status).toBe(422);
    expect((await json<ProblemDetails>(response)).detail).toMatch(/off until your organisation/);
  });

  it("only a holder of the manage permission names the route", async () => {
    expect(
      (await as("carer", "/v1/lone-worker/route", { method: "PUT", body: ROUTE })).status,
    ).toBe(403);
  });

  it("refuses a route without the Registered Manager, or reaching people only in the app", async () => {
    const noManager = await as("manager", "/v1/lone-worker/route", {
      method: "PUT",
      body: { steps: [ROUTE.steps[0]] },
    });
    expect(noManager.status).toBe(422);
    const inApp = await as("manager", "/v1/lone-worker/route", {
      method: "PUT",
      body: { steps: [{ ...ROUTE.steps[0], channels: ["in_app"] }, ROUTE.steps[1]] },
    });
    expect(inApp.status).toBe(422);
    expect((await json<ProblemDetails>(inApp)).detail).toMatch(/away from the app/);
  });

  it("switches check-ins on once a valid route is saved", async () => {
    const saved = await as("manager", "/v1/lone-worker/route", { method: "PUT", body: ROUTE });
    expect(saved.status).toBe(200);
    const route = await json<LoneWorkerRoute>(await as("carer", "/v1/lone-worker/route"));
    expect(route.on).toBe(true);
    expect(route.problems).toEqual([]);
  });
});

describe("sessions", () => {
  it("refuses a location where the worker does not work, and figures outside the organisation's", async () => {
    expect((await start("carer", { locationId: LODGE.locationId })).status).toBe(422);
    const short = await start("carer", { intervalMinutes: 1 });
    expect(short.status).toBe(422);
    expect((await json<ProblemDetails>(short)).detail).toMatch(/closer together/);
  });
});

describe("hazard HZ-125: overdue, the offline rule, and the order of escalation", () => {
  let sessionId: string;
  let alarmId: string;

  it("starts once for a replayed client id", async () => {
    sessionId = crypto.randomUUID();
    const first = await start("carer", { id: sessionId });
    expect(first.status).toBe(201);
    const again = await start("carer", { id: sessionId });
    expect(again.status).toBe(200);
    expect((await json<LoneWorkerMine>(again)).session?.id).toBe(sessionId);
    // One open session per worker.
    expect((await start("carer")).status).toBe(409);
  });

  it("reminds the worker first, while the check-in is within its grace period", async () => {
    // Due 20 minutes ago by the session's start; as at 10 minutes ago it was within grace.
    await sweepLoneWorkersJob(deps, at(-10));
    const reminders = await notificationsOf(
      DEMO.users.carer.id,
      "scheduling.lone_worker.check_in_due",
    );
    expect(reminders).toHaveLength(1);
    expect(await alarmsOfSession(sessionId)).toEqual([]);
  });

  it("raises the alarm after grace: the worker, then on-call at once, with the chain set", async () => {
    await sweepLoneWorkersJob(deps);
    const alarms = await alarmsOfSession(sessionId);
    expect(alarms).toHaveLength(1);
    expect(alarms[0]).toMatchObject({ reason: "overdue", state: "open" });
    alarmId = alarms[0]?.id ?? "";
    const worker = await notificationsOf(
      DEMO.users.carer.id,
      "scheduling.lone_worker.worker_alarm",
    );
    expect(worker[0]?.title).toMatch(/check in now/);
    const onCall = await notificationsOf(DEMO.users.nurse.id, "scheduling.lone_worker.alarm");
    expect(onCall).toHaveLength(1);
    // Push bodies carry no personal data.
    expect(onCall[0]?.body).not.toMatch(/Cat|Carer/);
    // A second sweep raises nothing more.
    await sweepLoneWorkersJob(deps);
    expect(await alarmsOfSession(sessionId)).toHaveLength(1);
  });

  it("escalates to the Registered Manager while no one acknowledges", async () => {
    await runEscalations(deps, at(11));
    const manager = await notificationsOf(DEMO.users.manager.id, "scheduling.lone_worker.alarm");
    expect(manager.some((n) => n.title.startsWith("Escalated:"))).toBe(true);
  });

  it("re-sends an open alarm to everyone on the route, even after the chain has run out", async () => {
    await sweepLoneWorkersJob(deps, at(30));
    const alarms = await alarmsOfSession(sessionId);
    expect(alarms[0]?.alert_count).toBe(2);
    const again = await notificationsOf(DEMO.users.nurse.id, "scheduling.lone_worker.alarm");
    expect(again.some((n) => n.title.startsWith("Still open:"))).toBe(true);
  });

  it("refuses a check-in from a clock far ahead", async () => {
    const response = await send("carer", sessionId, { deviceAt: iso(30) });
    expect(response.status).toBe(422);
    expect((await json<ProblemDetails>(response)).detail).toMatch(/future/);
  });

  it("a check-in made before the alarm on an offline device resolves it as late, flagged", async () => {
    const id = crypto.randomUUID();
    const response = await send("carer", sessionId, { id, deviceAt: iso(-12) });
    expect(response.status).toBe(201);
    const result = await json<LoneWorkerEventResult>(response);
    expect(result.late).toBe(true);
    expect(Math.abs(new Date(result.effectiveAt).getTime() - at(-12).getTime())).toBeLessThan(
      5_000,
    );
    const [alarm] = await alarmsOfSession(sessionId);
    expect(alarm?.state).toBe("resolved_late_check_in");
    const told = await notificationsOf(
      DEMO.users.nurse.id,
      "scheduling.lone_worker.alarm_resolved",
    );
    expect(told[0]?.title).toMatch(/late check-in arrived/);
    // Every notification about the alarm is acknowledged, so the chain stops.
    const open = (
      await notificationsOf(DEMO.users.nurse.id, "scheduling.lone_worker.alarm")
    ).filter((n) => n.acknowledged_at === null);
    expect(open).toEqual([]);
    // The same event sent again (an offline queue) records once.
    expect((await send("carer", sessionId, { id, deviceAt: iso(-12) })).status).toBe(200);
    const board = await json<LoneWorkerBoard>(await as("manager", "/v1/lone-worker/board"));
    const mine = board.items.find((i) => i.sessionId === sessionId);
    expect(mine?.status).toBe("ok");
    expect(mine?.lastCheckInLate).toBe(true);
    expect(mine?.statusWords).toBe("Checked in");
    expect(alarmId).not.toBe("");
  });

  it("an on-time check-in received late, before the sweep, never raises an alarm", async () => {
    // Next due 48 minutes from now; the check-in made 5 minutes before it arrives 5 after.
    const response = await send("carer", sessionId, { deviceAt: iso(-1) });
    expect(response.status).toBe(201);
    await sweepLoneWorkersJob(deps, at(50));
    expect((await alarmsOfSession(sessionId)).filter((a) => a.state === "open")).toEqual([]);
  });
});

describe("safe then is not safe now", () => {
  it("a late check-in that still leaves the worker overdue keeps the alarm open", async () => {
    const sessionId = crypto.randomUUID();
    expect(
      (
        await start("owner", {
          id: sessionId,
          startedAt: iso(-200),
          plannedEndAt: iso(400),
          intervalMinutes: 60,
        })
      ).status,
    ).toBe(201);
    await sweepLoneWorkersJob(deps);
    expect((await alarmsOfSession(sessionId))[0]?.state).toBe("open");
    // Made 150 minutes ago (offline all that time): next due 90 minutes ago, still overdue.
    expect((await send("owner", sessionId, { deviceAt: iso(-150) })).status).toBe(201);
    expect((await alarmsOfSession(sessionId))[0]?.state).toBe("open");
    await send("owner", sessionId, { kind: "finish" });
    await sweepLoneWorkersJob(deps);
    expect((await alarmsOfSession(sessionId))[0]?.state).toBe("resolved_by_check_in");
  });
});

describe("duress and help", () => {
  let sessionId: string;
  let duressAlarm: string;

  it("a duress check-in answers exactly as a check-in and raises an urgent alarm at once", async () => {
    const mine = await json<LoneWorkerMine>(await as("carer", "/v1/lone-worker/sessions/mine"));
    sessionId = mine.session?.id ?? "";
    const checkIn = await json<LoneWorkerEventResult>(await send("carer", sessionId, {}));
    const duress = await json<LoneWorkerEventResult>(
      await send("carer", sessionId, { kind: "duress" }),
    );
    expect(duress.kind).toBe("check_in");
    expect(duress.message).toBe(checkIn.message);
    expect(Object.keys(duress).sort()).toEqual(Object.keys(checkIn).sort());
    const alarms = await alarmsOfSession(sessionId);
    const raised = alarms.find((a) => a.reason === "duress");
    expect(raised?.state).toBe("open");
    duressAlarm = raised?.id ?? "";
    const onCall = await notificationsOf(DEMO.users.nurse.id, "scheduling.lone_worker.alarm");
    expect(onCall.some((n) => n.title === "A lone worker may be in danger")).toBe(true);
  });

  it("nothing the worker can see gives the duress away", async () => {
    const mine = await json<LoneWorkerMine>(await as("carer", "/v1/lone-worker/sessions/mine"));
    expect(mine.session?.events.map((e) => e.kind)).not.toContain("duress");
    expect(mine.session?.overdueAlarmOpen).toBe(false);
    const own = await notificationsOf(DEMO.users.carer.id);
    expect(own.some((n) => /danger|duress/i.test(`${n.title} ${n.body}`))).toBe(false);
  });

  it("a later check-in never resolves a duress alarm", async () => {
    await send("carer", sessionId, {});
    await sweepLoneWorkersJob(deps);
    const alarm = (await alarmsOfSession(sessionId)).find((a) => a.id === duressAlarm);
    expect(alarm?.state).toBe("open");
  });

  it("only a monitor other than the worker acknowledges, with what was done", async () => {
    expect(
      (
        await as("carer", `/v1/lone-worker/alarms/${duressAlarm}/acknowledge`, {
          method: "POST",
          body: { outcome: "safe_confirmed", note: "Fine", version: 1 },
        })
      ).status,
    ).toBe(403);
    expect((await as("nurse", "/v1/lone-worker/alarms")).status).toBe(403);
    const list = await json<LoneWorkerAlarmList>(await as("manager", "/v1/lone-worker/alarms"));
    const item = list.items.find((a) => a.id === duressAlarm);
    expect(item?.reasonWords).toBe("Duress");
    expect(item?.stateWords).toBe("Open");
    const response = await as("manager", `/v1/lone-worker/alarms/${duressAlarm}/acknowledge`, {
      method: "POST",
      body: {
        outcome: "help_sent",
        note: "Went round with the on-call nurse",
        version: item?.version,
      },
    });
    expect(response.status).toBe(200);
    const done = await json<AcknowledgedLoneWorkerAlarm>(response);
    expect(done.alarm.state).toBe("acknowledged");
    expect(done.incidentSuggested).toBe(true);
    const open = (
      await notificationsOf(DEMO.users.nurse.id, "scheduling.lone_worker.alarm")
    ).filter((n) => n.source_id === duressAlarm && n.acknowledged_at === null);
    expect(open).toEqual([]);
  });

  it("a help request after finishing is still accepted and alarms", async () => {
    await send("carer", sessionId, { kind: "finish" });
    const help = await send("carer", sessionId, { kind: "help" });
    expect(help.status).toBe(201);
    expect((await json<LoneWorkerEventResult>(help)).message).toMatch(/Help has been asked for/);
    expect((await alarmsOfSession(sessionId)).some((a) => a.reason === "help")).toBe(true);
    // An ordinary check-in made after finishing is refused.
    const late = await send("carer", sessionId, { deviceAt: iso(4) });
    expect(late.status).toBe(422);
  });
});

describe("location evidence (H-527)", () => {
  it("is not kept while the flag is off, then one point is kept and erased at its date", async () => {
    const sessionId = crypto.randomUUID();
    expect((await start("carer", { id: sessionId, startedAt: iso(-5) })).status).toBe(201);
    const point = { latitude: 51.5, longitude: -0.12, accuracyMetres: 20 };
    await send("carer", sessionId, { location: point });
    const stored = () =>
      asDemoTenant(async (c) =>
        Number(
          (
            await c.query<{ n: string }>(
              "SELECT count(*) AS n FROM lone_worker_location WHERE session_id = $1 AND cleared_at IS NULL",
              [sessionId],
            )
          ).rows[0]?.n,
        ),
      );
    expect(await stored()).toBe(0);
    await asDemoTenant(async (c) => {
      await c.query(
        "INSERT INTO feature_flag (location_id, flag_key, enabled) VALUES (NULL, 'scheduling.lone_worker.location', true)",
      );
      // The organisation's own period, a second, so the erasure can be seen here.
      await c.query(
        `INSERT INTO rate_table (tenant_id, key, value, unit, nation, valid_from, source, verification_status)
         VALUES ($1, 'lone_worker.location_days', 0.00001, 'days', 'all', '2000-01-01', 'test', 'verified')`,
        [DEMO.tenantId],
      );
    });
    await send("carer", sessionId, { kind: "help", location: point });
    expect(await stored()).toBe(1);
    const list = await json<LoneWorkerAlarmList>(await as("manager", "/v1/lone-worker/alarms"));
    expect(list.items.find((a) => a.sessionId === sessionId)?.location?.latitude).toBe(51.5);
    await new Promise((resolve) => setTimeout(resolve, 1500));
    await sweepLoneWorkersJob(deps);
    expect(await stored()).toBe(0);
  });
});
