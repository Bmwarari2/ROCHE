import {
  AcknowledgedLoneWorkerAlarm,
  AcknowledgeLoneWorkerAlarm,
  type LoneWorkerAlarmItem,
  LoneWorkerAlarmList,
  LoneWorkerAlarmState,
  LoneWorkerBoard,
  LoneWorkerEventResult,
  LoneWorkerMine,
  LoneWorkerRoute,
  RecordLoneWorkerEvent,
  SetLoneWorkerRoute,
  StartLoneWorkerSession,
} from "@harbour/contracts";
import {
  escalationChain,
  featureFlag,
  incident,
  type LoneWorkerAlarmRow,
  type LoneWorkerSessionRow,
  loneWorkerAlarm,
  loneWorkerEvent,
  loneWorkerLocation,
  loneWorkerSession,
  type Transaction,
  withRequestContext,
} from "@harbour/db";
import {
  ACKNOWLEDGE_PROBLEM_MESSAGES,
  ALARM_REASON_WORDS,
  ALARM_STATE_WORDS,
  type LoneWorkerAlarmState as AlarmState,
  acceptEvent,
  checkAcknowledge,
  checkRoute,
  checkSession,
  type EscalationStep,
  EVENT_REFUSAL_MESSAGES,
  kindShownToWorker,
  LONE_WORKER_ROUTE_KEY,
  type LoneWorkerAlarmReason,
  type LoneWorkerEventKind,
  type LoneWorkerOutcome,
  type LoneWorkerTimings,
  nextCheckInDue,
  ROUTE_PROBLEM_MESSAGES,
  type RoleAssignmentInput,
  SESSION_PROBLEM_MESSAGES,
  type SessionStatus,
} from "@harbour/domain";
import { createRoute, z } from "@hono/zod-openapi";
import { and, desc, eq, inArray, isNull } from "drizzle-orm";
import type { Context } from "hono";
import { AuditedRefusal, withAuditedRefusal, writeAudit } from "../http/audit";
import {
  type AppEnv,
  requireAnyPermission,
  requirePermission,
  type TenantAccess,
  withTenant,
} from "../http/context";
import { HttpProblem, problems } from "../http/problem";
import { accessRowsOfMember } from "../services/access-rows";
import {
  acknowledgeAlarmNotifications,
  checkInTimes,
  loneWorkerFigures,
  loneWorkerRoute,
  raiseWorkerAlarm,
  resolveAfterCheckIn,
  statusOf,
} from "../services/lone-worker";
import { toldOf } from "../services/role-holders";
import {
  conflictResponse,
  createRouter,
  errorResponses,
  jsonBody,
  notFoundResponse,
  security,
} from "./openapi";
import { audit, dbCode } from "./people-shared";

/**
 * Lone-worker safety (SCHED-012, Phase 2 slice 46; scheduling.md section 14; HZ-125). A worker
 * starts a session and checks in; an overdue check-in, a help request or a duress check-in raises
 * an alarm to the organisation's named on-call route (H-539), which keeps escalating and is sent
 * again until a person acknowledges it. Alarm rows are written only by the system (services/
 * lone-worker.ts), straight after the worker's event and by the per-minute sweep. Audit events
 * carry opaque ids only; a duress check-in is audited as a check-in event like any other, so the
 * audit trail a worker can see never gives it away.
 */

const CHECK_IN = "scheduling.lone_worker.check_in";
const MONITOR = "scheduling.lone_worker.monitor";
const MANAGE = "scheduling.lone_worker.manage";
const LOCATION_FLAG = "scheduling.lone_worker.location";
const A = {
  routeSet: "scheduling.lone_worker.route_set",
  started: "scheduling.lone_worker.session_started",
  event: "scheduling.lone_worker.event_recorded",
  viewed: "scheduling.lone_worker.alarm_viewed",
  acknowledged: "scheduling.lone_worker.alarm_acknowledged",
  board: "scheduling.lone_worker.board_viewed",
} as const;

const iso = (d: Date | null | undefined) => (d ? d.toISOString() : null);
const stateConflict = (detail: string) => new HttpProblem(409, "invalid_state", detail);
const OFF_MESSAGE =
  "Lone-worker check-ins are off until your organisation names its on-call route. Ask your Registered Manager.";

/** The system's transaction for this organisation: no user, tenant scope (`app.is_system()`). */
const asSystem = <T>(
  c: Context<AppEnv>,
  access: TenantAccess,
  fn: (tx: Transaction) => Promise<T>,
) =>
  withRequestContext(
    c.get("services").db,
    { tenantId: access.tenantId, userId: null, scope: "tenant", locationIds: [] },
    fn,
  );

/** Runs a change; the database's own refusals are audited and given in words. */
async function change<T>(
  c: Context<AppEnv>,
  access: TenantAccess,
  what: { action: string; resourceType: string; id: string | null },
  fn: (tx: Transaction) => Promise<T>,
): Promise<T> {
  try {
    return await withAuditedRefusal(c, access, () => withTenant(c, fn));
  } catch (error) {
    const code = dbCode(error);
    if (!code || !["42501", "23000", "23503", "23505", "23514"].includes(code)) throw error;
    await writeAudit(c.get("services").appPool, access, {
      action: what.action,
      outcome: "denied",
      resourceType: what.resourceType,
      ...(what.id ? { resourceId: what.id } : {}),
      reason: code === "42501" ? "refused_by_database" : "invalid_state",
      requestId: c.get("requestId"),
    });
    if (code === "42501") throw problems.forbidden();
    if (code === "23505") {
      throw stateConflict("You already have a lone-working session open. Finish it first.");
    }
    if (code === "23503")
      throw problems.invalid("A location, member or incident named was not found.");
    throw stateConflict("This cannot be changed like that now. Reload it and try again.");
  }
}

const refused = (
  problem: HttpProblem,
  action: string,
  type: string,
  id: string | null,
  reason: string,
) =>
  new AuditedRefusal(problem, {
    action,
    outcome: "denied",
    resourceType: type,
    ...(id ? { resourceId: id } : {}),
    reason,
  });

/** Whether the worker works at a location: a role or grant there carrying the check-in permission. */
function worksAt(
  rows: {
    assignments: readonly RoleAssignmentInput[];
    grants: readonly {
      permissions: readonly string[];
      locationId: string | null;
      organisationWide: boolean;
      validFrom: Date;
      validTo: Date;
      revokedAt: Date | null;
    }[];
  },
  locationId: string,
  now: Date,
): boolean {
  const active = (from: Date, to: Date | null) =>
    from.getTime() <= now.getTime() && (to === null || to.getTime() > now.getTime());
  return (
    rows.assignments.some(
      (a) =>
        active(a.validFrom, a.validTo) &&
        a.permissions.includes(CHECK_IN) &&
        (a.locationId === locationId ||
          (a.locationId === null && (a.scopeKind === "tenant" || a.organisationWide))),
    ) ||
    rows.grants.some(
      (g) =>
        g.revokedAt === null &&
        active(g.validFrom, g.validTo) &&
        g.permissions.includes(CHECK_IN) &&
        (g.locationId === locationId || (g.locationId === null && g.organisationWide)),
    )
  );
}

async function locationFlagOn(
  c: Context<AppEnv>,
  tx: Transaction,
  tenantId: string,
  locationId: string,
): Promise<boolean> {
  const overrides = await tx
    .select({
      flagKey: featureFlag.flagKey,
      locationId: featureFlag.locationId,
      enabled: featureFlag.enabled,
    })
    .from(featureFlag)
    .where(isNull(featureFlag.deletedAt));
  const flags = await c.get("services").flags.evaluateAll({ tenantId, locationId, overrides });
  return flags[LOCATION_FLAG] === true;
}

function statusWords(status: SessionStatus): string {
  switch (status.kind) {
    case "ok":
      return "Checked in";
    case "due":
      return "Check-in due";
    case "alarm":
      return status.reason === "not_finished" ? "Session not finished" : "Check-in overdue";
    case "finished":
      return "Finished";
  }
}

function dueOf(session: LoneWorkerSessionRow, times: readonly Date[]): Date | null {
  if (session.finishedAt) return null;
  return nextCheckInDue(session, times).dueAt;
}

async function alarmItem(
  tx: Transaction,
  row: LoneWorkerAlarmRow,
): Promise<z.infer<typeof LoneWorkerAlarmItem>> {
  const events = await tx
    .select()
    .from(loneWorkerEvent)
    .where(eq(loneWorkerEvent.sessionId, row.sessionId))
    .orderBy(desc(loneWorkerEvent.effectiveAt));
  const last = events.find((e) => e.kind !== "finish");
  const [point] = await tx
    .select({ p: loneWorkerLocation, at: loneWorkerEvent.effectiveAt })
    .from(loneWorkerLocation)
    .innerJoin(loneWorkerEvent, eq(loneWorkerEvent.id, loneWorkerLocation.eventId))
    .where(
      and(eq(loneWorkerLocation.sessionId, row.sessionId), isNull(loneWorkerLocation.clearedAt)),
    )
    .orderBy(desc(loneWorkerEvent.effectiveAt))
    .limit(1);
  return {
    id: row.id,
    sessionId: row.sessionId,
    workerTenantUserId: row.workerTenantUserId,
    locationId: row.locationId,
    reason: row.reason as LoneWorkerAlarmReason,
    reasonWords: ALARM_REASON_WORDS[row.reason as LoneWorkerAlarmReason],
    state: row.state as AlarmState,
    stateWords: ALARM_STATE_WORDS[row.state as AlarmState],
    dueAt: iso(row.dueAt),
    raisedAt: row.raisedAt.toISOString(),
    lastAlertedAt: row.lastAlertedAt.toISOString(),
    alertCount: row.alertCount,
    lastCheckInAt: iso(last?.effectiveAt),
    lastCheckInLate: last?.late ?? false,
    resolvedAt: iso(row.resolvedAt),
    acknowledgedBy: row.acknowledgedBy,
    acknowledgedAt: iso(row.acknowledgedAt),
    outcome: (row.outcome as LoneWorkerOutcome | null) ?? null,
    note: row.note,
    incidentId: row.incidentId,
    location:
      point?.p.latitude && point.p.longitude
        ? {
            latitude: Number(point.p.latitude),
            longitude: Number(point.p.longitude),
            accuracyMetres: point.p.accuracyMetres,
            capturedAt: point.at.toISOString(),
          }
        : null,
    version: row.version,
  };
}

const IdParam = z.object({ id: z.uuid() });
const AlarmQuery = z.object({ state: LoneWorkerAlarmState.optional() });

export const loneWorkerRouter = createRouter()
  .openapi(
    createRoute({
      method: "get",
      path: "/v1/lone-worker/route",
      tags: ["scheduling"],
      summary: "The on-call route for lone-worker alarms (H-539)",
      description:
        "Whether lone-worker check-ins are on (a valid route is saved), its steps and any problems, and whether location evidence is attached. Holders of scheduling.lone_worker.check_in, .monitor or .manage.",
      security,
      responses: { 200: jsonBody(LoneWorkerRoute, "The route"), ...errorResponses },
    }),
    async (c) => {
      const access = await requireAnyPermission(c, [MANAGE, MONITOR, CHECK_IN]);
      const body = await withTenant(c, async (tx) => {
        const route = await loneWorkerRoute(tx);
        const { problems: found } = checkRoute(route.steps);
        const overrides = await tx
          .select({
            flagKey: featureFlag.flagKey,
            locationId: featureFlag.locationId,
            enabled: featureFlag.enabled,
          })
          .from(featureFlag)
          .where(isNull(featureFlag.deletedAt));
        return { route, found, overrides };
      });
      const flags = await c.get("services").flags.evaluateAll({
        tenantId: access.tenantId,
        locationId: null,
        overrides: body.overrides,
      });
      return c.json(
        {
          on: body.route.on,
          steps: body.route.steps.map((s) => ({ ...s, channels: [...s.channels] })),
          problems:
            body.route.chainId === null
              ? [{ code: "not_named", message: "No on-call route has been named yet." }]
              : body.found.map((code) => ({ code, message: ROUTE_PROBLEM_MESSAGES[code] })),
          locationEvidence: flags[LOCATION_FLAG] === true,
        },
        200,
      );
    },
  )
  .openapi(
    createRoute({
      method: "put",
      path: "/v1/lone-worker/route",
      tags: ["scheduling"],
      summary: "Name the on-call route for lone-worker alarms (H-539)",
      description:
        "scheduling.lone_worker.manage. Step 1 is the on-call person or role, told the moment an alarm is raised; a later step is the Registered Manager; every step reaches people outside the app. A named person must be an active member. Saving a valid route switches lone-worker check-ins on. Audited.",
      security,
      request: { body: { content: { "application/json": { schema: SetLoneWorkerRoute } } } },
      responses: { 200: jsonBody(LoneWorkerRoute, "Saved"), ...errorResponses },
    }),
    async (c) => {
      const access = await requirePermission(c, MANAGE);
      const body = c.req.valid("json");
      const steps = body.steps as EscalationStep[];
      const { problems: found, chainProblems } = checkRoute(steps);
      if (found.length > 0) {
        await writeAudit(c.get("services").appPool, access, {
          action: A.routeSet,
          outcome: "denied",
          resourceType: "escalation_chain",
          reason: found[0] ?? "invalid",
          requestId: c.get("requestId"),
        });
        throw problems.invalid(
          [...found.map((p) => ROUTE_PROBLEM_MESSAGES[p]), ...chainProblems].join(" "),
        );
      }
      await change(
        c,
        access,
        { action: A.routeSet, resourceType: "escalation_chain", id: null },
        async (tx) => {
          const named = steps.flatMap((s) => (s.targetTenantUserId ? [s.targetTenantUserId] : []));
          const active = await toldOf(tx, named);
          if (named.some((id) => !active.has(id))) {
            throw refused(
              problems.invalid("A person named in the route is not an active member of staff."),
              A.routeSet,
              "escalation_chain",
              null,
              "inactive_member",
            );
          }
          const [existing] = await tx
            .select()
            .from(escalationChain)
            .where(
              and(
                eq(escalationChain.key, LONE_WORKER_ROUTE_KEY),
                isNull(escalationChain.deletedAt),
              ),
            );
          let id: string;
          if (existing) {
            await tx
              .update(escalationChain)
              .set({ steps })
              .where(eq(escalationChain.id, existing.id));
            id = existing.id;
          } else {
            const [made] = await tx
              .insert(escalationChain)
              .values({
                key: LONE_WORKER_ROUTE_KEY,
                name: "Lone-worker alarm on-call route",
                steps,
              })
              .returning({ id: escalationChain.id });
            if (!made) throw new Error("route not stored");
            id = made.id;
          }
          await audit(c, tx, access, {
            action: A.routeSet,
            resourceType: "escalation_chain",
            resourceId: id,
            scopeExtra: { steps: steps.length },
          });
        },
      );
      return c.json(
        {
          on: true,
          steps: steps.map((s) => ({ ...s, channels: [...s.channels] })),
          problems: [],
          locationEvidence: false,
        },
        200,
      );
    },
  )
  .openapi(
    createRoute({
      method: "post",
      path: "/v1/lone-worker/sessions",
      tags: ["scheduling"],
      summary: "Start a lone-working session",
      description:
        "scheduling.lone_worker.check_in, for oneself, at a location where one works. Refused in words while the organisation has named no valid on-call route (the feature is off). The check-in interval and length are within the organisation's figures. The client's id makes a retry return the first session. One open session per worker. Audited.",
      security,
      request: { body: { content: { "application/json": { schema: StartLoneWorkerSession } } } },
      responses: {
        201: jsonBody(LoneWorkerMine, "Started"),
        200: jsonBody(LoneWorkerMine, "Already started with this id"),
        ...errorResponses,
        ...conflictResponse,
      },
    }),
    async (c) => {
      const access = await requirePermission(c, CHECK_IN);
      const body = c.req.valid("json");
      const now = new Date();
      const { on, figures, works } = await asSystem(c, access, async (tx) => ({
        on: (await loneWorkerRoute(tx)).on,
        figures: await loneWorkerFigures(tx, access.tenantId),
        works: worksAt(await accessRowsOfMember(tx, access.tenantUserId), body.locationId, now),
      }));
      const deny = async (problem: HttpProblem, reason: string) => {
        await writeAudit(c.get("services").appPool, access, {
          action: A.started,
          outcome: "denied",
          resourceType: "lone_worker_session",
          resourceId: body.id,
          reason,
          requestId: c.get("requestId"),
        });
        return problem;
      };
      if (!on) throw await deny(problems.invalid(OFF_MESSAGE), "route_not_named");
      if (!works) {
        throw await deny(
          problems.invalid("You can only start a session at a location where you work."),
          "not_your_location",
        );
      }
      const input = {
        startedAt: new Date(body.startedAt),
        plannedEndAt: new Date(body.plannedEndAt),
        intervalMinutes: body.intervalMinutes,
      };
      const found = checkSession(input, figures, now);
      if (found.length > 0) {
        throw await deny(
          problems.invalid(found.map((p) => SESSION_PROBLEM_MESSAGES[p]).join(" ")),
          found[0] ?? "invalid",
        );
      }
      const result = await change(
        c,
        access,
        { action: A.started, resourceType: "lone_worker_session", id: body.id },
        async (tx) => {
          const [mine] = await tx
            .select()
            .from(loneWorkerSession)
            .where(eq(loneWorkerSession.id, body.id));
          if (mine) {
            if (mine.workerTenantUserId !== access.tenantUserId) throw problems.notFound();
            return { session: mine, created: false };
          }
          const [made] = await tx
            .insert(loneWorkerSession)
            .values({
              id: body.id,
              locationId: body.locationId,
              workerTenantUserId: access.tenantUserId,
              workKind: body.workKind,
              ...input,
            })
            .returning();
          if (!made) throw new Error("session not stored");
          await audit(c, tx, access, {
            action: A.started,
            resourceType: "lone_worker_session",
            resourceId: made.id,
            scopeExtra: { locationId: made.locationId },
          });
          return { session: made, created: true };
        },
      );
      const mine = await withTenant(c, (tx) => ownView(tx, result.session, figures, now));
      return c.json({ session: mine, on }, result.created ? 201 : 200);
    },
  )
  .openapi(
    createRoute({
      method: "get",
      path: "/v1/lone-worker/sessions/mine",
      tags: ["scheduling"],
      summary: "Your open lone-working session",
      description:
        "scheduling.lone_worker.check_in. The open session with when the next check-in is due. A duress check-in reads as an ordinary check-in here, and a duress or help alarm is never shown.",
      security,
      responses: { 200: jsonBody(LoneWorkerMine, "Yours"), ...errorResponses },
    }),
    async (c) => {
      const access = await requirePermission(c, CHECK_IN);
      const now = new Date();
      const { figures, on } = await asSystem(c, access, async (tx) => ({
        figures: await loneWorkerFigures(tx, access.tenantId),
        on: (await loneWorkerRoute(tx)).on,
      }));
      const session = await withTenant(c, async (tx) => {
        const [open] = await tx
          .select()
          .from(loneWorkerSession)
          .where(
            and(
              eq(loneWorkerSession.workerTenantUserId, access.tenantUserId),
              isNull(loneWorkerSession.finishedAt),
              isNull(loneWorkerSession.deletedAt),
            ),
          );
        return open ? ownView(tx, open, figures, now) : null;
      });
      return c.json({ session, on }, 200);
    },
  )
  .openapi(
    createRoute({
      method: "post",
      path: "/v1/lone-worker/sessions/{id}/events",
      tags: ["scheduling"],
      summary: "Check in, ask for help, raise duress or finish",
      description:
        "scheduling.lone_worker.check_in, on one's own session. The client's id makes a resend (a retry, an offline queue) record once. An event made offline is accepted from its device time and flagged when it arrives late; a device clock ahead of the server beyond the tolerance is refused, except for help and duress, which are always accepted. Help and duress raise an alarm at once; a duress check-in answers exactly as an ordinary check-in. A check-in resolves an overdue alarm unless the worker is overdue again. Location is kept only while the organisation's flag is on. Audited (duress as an event like any other).",
      security,
      request: {
        params: IdParam,
        body: { content: { "application/json": { schema: RecordLoneWorkerEvent } } },
      },
      responses: {
        201: jsonBody(LoneWorkerEventResult, "Recorded"),
        200: jsonBody(LoneWorkerEventResult, "Already recorded with this id"),
        ...errorResponses,
        ...notFoundResponse,
      },
    }),
    async (c) => {
      const access = await requirePermission(c, CHECK_IN);
      const { id: sessionId } = c.req.valid("param");
      const body = c.req.valid("json");
      const now = new Date();
      const figures = await asSystem(c, access, (tx) => loneWorkerFigures(tx, access.tenantId));
      const outcome = await change(
        c,
        access,
        { action: A.event, resourceType: "lone_worker_session", id: sessionId },
        async (tx) => {
          const [session] = await tx
            .select()
            .from(loneWorkerSession)
            .where(
              and(
                eq(loneWorkerSession.id, sessionId),
                eq(loneWorkerSession.workerTenantUserId, access.tenantUserId),
              ),
            );
          if (!session) {
            throw refused(
              problems.notFound(),
              A.event,
              "lone_worker_session",
              sessionId,
              "not_found",
            );
          }
          const [existing] = await tx
            .select()
            .from(loneWorkerEvent)
            .where(eq(loneWorkerEvent.id, body.id));
          if (existing) {
            if (existing.sessionId !== sessionId)
              throw problems.invalid("That event id is already used.");
            return { session, event: existing, created: false };
          }
          const accepted = acceptEvent(
            { kind: body.kind, deviceAt: new Date(body.deviceAt), receivedAt: now },
            session,
            figures,
          );
          if (!accepted.accepted) {
            throw refused(
              problems.invalid(EVENT_REFUSAL_MESSAGES[accepted.refusal]),
              A.event,
              "lone_worker_session",
              sessionId,
              accepted.refusal,
            );
          }
          const [event] = await tx
            .insert(loneWorkerEvent)
            .values({
              id: body.id,
              sessionId,
              kind: body.kind,
              deviceAt: new Date(body.deviceAt),
              receivedAt: now,
              effectiveAt: accepted.effectiveAt,
              late: accepted.late,
            })
            .returning();
          if (!event) throw new Error("event not stored");
          let current = session;
          if (body.kind === "finish" && !session.finishedAt) {
            const [finished] = await tx
              .update(loneWorkerSession)
              .set({ finishedAt: accepted.effectiveAt })
              .where(eq(loneWorkerSession.id, sessionId))
              .returning();
            if (finished) current = finished;
          }
          if (body.location && (await locationFlagOn(c, tx, access.tenantId, session.locationId))) {
            await tx.insert(loneWorkerLocation).values({
              eventId: event.id,
              sessionId,
              latitude: body.location.latitude.toFixed(5),
              longitude: body.location.longitude.toFixed(5),
              accuracyMetres: body.location.accuracyMetres,
              deleteAfter: new Date(now.getTime() + figures.locationDays * 86_400_000),
            });
          }
          // Duress is audited exactly as a check-in, so nothing the worker can see gives it away.
          await audit(c, tx, access, {
            action: A.event,
            resourceType: "lone_worker_session",
            resourceId: sessionId,
            scopeExtra: {
              eventId: event.id,
              kind: kindShownToWorker(body.kind),
              late: accepted.late,
            },
          });
          return { session: current, event, created: true };
        },
      );
      // The alarm side, as the system, straight away; the sweep repairs it if this fails.
      if (outcome.created) {
        try {
          await asSystem(c, access, async (tx) => {
            const kind = outcome.event.kind as LoneWorkerEventKind;
            if (kind === "help" || kind === "duress") {
              await raiseWorkerAlarm(tx, outcome.session, { id: outcome.event.id, kind }, now);
            } else {
              await resolveAfterCheckIn(tx, outcome.session, figures, now);
            }
          });
        } catch {
          c.get("services").logger.warn(
            { sessionId, eventId: outcome.event.id },
            "lone-worker alarm left to the sweep",
          );
        }
      }
      const times = await withTenant(c, (tx) => checkInTimes(tx, sessionId));
      const kind = kindShownToWorker(outcome.event.kind as LoneWorkerEventKind);
      const message =
        kind === "help"
          ? "Help has been asked for. The on-call person has been told."
          : kind === "finish"
            ? "Your session has finished."
            : "Thank you. You are checked in.";
      return c.json(
        {
          id: outcome.event.id,
          kind,
          effectiveAt: outcome.event.effectiveAt.toISOString(),
          late: outcome.event.late,
          nextDueAt: iso(dueOf(outcome.session, times)),
          message,
        },
        outcome.created ? 201 : 200,
      );
    },
  )
  .openapi(
    createRoute({
      method: "get",
      path: "/v1/lone-worker/board",
      tags: ["scheduling"],
      summary: "Lone workers now",
      description:
        "scheduling.lone_worker.monitor. Open sessions at the locations where one holds it, each with its status in words, when the next check-in is due, the last check-in (and whether it came late from an offline device) and any open alarm. Audited.",
      security,
      responses: { 200: jsonBody(LoneWorkerBoard, "Board"), ...errorResponses },
    }),
    async (c) => {
      const access = await requirePermission(c, MONITOR);
      const now = new Date();
      const { figures, on } = await asSystem(c, access, async (tx) => ({
        figures: await loneWorkerFigures(tx, access.tenantId),
        on: (await loneWorkerRoute(tx)).on,
      }));
      const items = await withTenant(c, async (tx) => {
        const sessions = await tx
          .select()
          .from(loneWorkerSession)
          .where(and(isNull(loneWorkerSession.finishedAt), isNull(loneWorkerSession.deletedAt)))
          .orderBy(loneWorkerSession.startedAt);
        const alarms =
          sessions.length === 0
            ? []
            : await tx
                .select()
                .from(loneWorkerAlarm)
                .where(
                  and(
                    eq(loneWorkerAlarm.state, "open"),
                    inArray(
                      loneWorkerAlarm.sessionId,
                      sessions.map((s) => s.id),
                    ),
                  ),
                );
        const out: z.infer<typeof LoneWorkerBoard>["items"] = [];
        for (const s of sessions) {
          const events = await tx
            .select()
            .from(loneWorkerEvent)
            .where(eq(loneWorkerEvent.sessionId, s.id))
            .orderBy(desc(loneWorkerEvent.effectiveAt));
          const checkIns = events.filter((e) => e.kind !== "finish");
          const status = statusOf(
            s,
            checkIns.map((e) => e.effectiveAt),
            figures,
            now,
          );
          out.push({
            sessionId: s.id,
            workerTenantUserId: s.workerTenantUserId,
            locationId: s.locationId,
            workKind: s.workKind as z.infer<typeof LoneWorkerBoard>["items"][number]["workKind"],
            startedAt: s.startedAt.toISOString(),
            plannedEndAt: s.plannedEndAt.toISOString(),
            intervalMinutes: s.intervalMinutes,
            status: status.kind,
            statusWords: statusWords(status),
            nextDueAt: iso(
              dueOf(
                s,
                checkIns.map((e) => e.effectiveAt),
              ),
            ),
            lastCheckInAt: iso(checkIns[0]?.effectiveAt),
            lastCheckInLate: checkIns[0]?.late ?? false,
            openAlarmIds: alarms.filter((a) => a.sessionId === s.id).map((a) => a.id),
          });
        }
        await audit(c, tx, access, {
          action: A.board,
          resourceType: "lone_worker_session",
          scopeExtra: { sessions: out.length },
        });
        return out;
      });
      return c.json({ items, on }, 200);
    },
  )
  .openapi(
    createRoute({
      method: "get",
      path: "/v1/lone-worker/alarms",
      tags: ["scheduling"],
      summary: "Lone-worker alarms",
      description:
        "scheduling.lone_worker.monitor. Alarms at the locations where one holds it, newest first, open ones only unless a state is asked for. Each says why it was raised and its state in words, the last check-in and the latest location evidence while it is kept. Audited.",
      security,
      request: { query: AlarmQuery },
      responses: { 200: jsonBody(LoneWorkerAlarmList, "Alarms"), ...errorResponses },
    }),
    async (c) => {
      const access = await requirePermission(c, MONITOR);
      const { state } = c.req.valid("query");
      const items = await withTenant(c, async (tx) => {
        const rows = await tx
          .select()
          .from(loneWorkerAlarm)
          .where(eq(loneWorkerAlarm.state, state ?? "open"))
          .orderBy(desc(loneWorkerAlarm.raisedAt))
          .limit(200);
        const out = [];
        for (const row of rows) {
          // A monitor's own alarm is not theirs to watch: someone else must see to it.
          if (row.workerTenantUserId === access.tenantUserId) continue;
          out.push(await alarmItem(tx, row));
        }
        await audit(c, tx, access, {
          action: A.viewed,
          resourceType: "lone_worker_alarm",
          scopeExtra: { alarms: out.length },
        });
        return out;
      });
      return c.json({ items }, 200);
    },
  )
  .openapi(
    createRoute({
      method: "post",
      path: "/v1/lone-worker/alarms/{id}/acknowledge",
      tags: ["scheduling"],
      summary: "Acknowledge a lone-worker alarm",
      description:
        "scheduling.lone_worker.monitor where the alarm is, by someone other than the worker, with what was done. This, not reading a notification, is what stops the alarm: it acknowledges every notification about it and ends its escalation. Anything but safe confirmed suggests an incident, which can be linked here. Audited.",
      security,
      request: {
        params: IdParam,
        body: { content: { "application/json": { schema: AcknowledgeLoneWorkerAlarm } } },
      },
      responses: {
        200: jsonBody(AcknowledgedLoneWorkerAlarm, "Acknowledged"),
        ...errorResponses,
        ...notFoundResponse,
        ...conflictResponse,
      },
    }),
    async (c) => {
      const access = await requirePermission(c, MONITOR);
      const { id } = c.req.valid("param");
      const body = c.req.valid("json");
      const now = new Date();
      const result = await change(
        c,
        access,
        { action: A.acknowledged, resourceType: "lone_worker_alarm", id },
        async (tx) => {
          const [row] = await tx.select().from(loneWorkerAlarm).where(eq(loneWorkerAlarm.id, id));
          if (!row)
            throw refused(
              problems.notFound(),
              A.acknowledged,
              "lone_worker_alarm",
              id,
              "not_found",
            );
          if (row.version !== body.version) {
            throw refused(
              problems.conflict(),
              A.acknowledged,
              "lone_worker_alarm",
              id,
              "version_conflict",
            );
          }
          const verdict = checkAcknowledge(
            { state: row.state as AlarmState, workerId: row.workerTenantUserId },
            { by: access.tenantUserId, outcome: body.outcome, note: body.note },
          );
          const [first] = verdict.problems;
          if (first) {
            const problem =
              first === "not_open"
                ? stateConflict(ACKNOWLEDGE_PROBLEM_MESSAGES[first])
                : first === "own_alarm"
                  ? new HttpProblem(
                      403,
                      "own_alarm",
                      "You cannot do this.",
                      ACKNOWLEDGE_PROBLEM_MESSAGES[first],
                    )
                  : problems.invalid(ACKNOWLEDGE_PROBLEM_MESSAGES[first]);
            throw refused(problem, A.acknowledged, "lone_worker_alarm", id, first);
          }
          if (body.incidentId) {
            const [seen] = await tx
              .select({ id: incident.id })
              .from(incident)
              .where(eq(incident.id, body.incidentId));
            if (!seen) {
              throw refused(
                problems.invalid("The incident named was not found."),
                A.acknowledged,
                "lone_worker_alarm",
                id,
                "incident_not_found",
              );
            }
          }
          const [updated] = await tx
            .update(loneWorkerAlarm)
            .set({
              state: "acknowledged",
              acknowledgedBy: access.tenantUserId,
              acknowledgedAt: now,
              outcome: body.outcome,
              note: body.note,
              incidentId: body.incidentId ?? null,
            })
            .where(and(eq(loneWorkerAlarm.id, id), eq(loneWorkerAlarm.version, body.version)))
            .returning();
          if (!updated) {
            throw refused(
              problems.conflict(),
              A.acknowledged,
              "lone_worker_alarm",
              id,
              "version_conflict",
            );
          }
          await audit(c, tx, access, {
            action: A.acknowledged,
            resourceType: "lone_worker_alarm",
            resourceId: id,
            scopeExtra: {
              outcome: body.outcome,
              incidentLinked: body.incidentId !== undefined && body.incidentId !== null,
            },
          });
          return {
            item: await alarmItem(tx, updated),
            incidentSuggested: verdict.incidentSuggested,
          };
        },
      );
      await asSystem(c, access, (tx) => acknowledgeAlarmNotifications(tx, id, now));
      return c.json({ alarm: result.item, incidentSuggested: result.incidentSuggested }, 200);
    },
  );

async function ownView(
  tx: Transaction,
  session: LoneWorkerSessionRow,
  figures: Pick<LoneWorkerTimings, "graceMinutes">,
  now: Date,
): Promise<z.infer<typeof LoneWorkerMine>["session"]> {
  const events = await tx
    .select()
    .from(loneWorkerEvent)
    .where(eq(loneWorkerEvent.sessionId, session.id))
    .orderBy(desc(loneWorkerEvent.effectiveAt));
  const times = events.filter((e) => e.kind !== "finish").map((e) => e.effectiveAt);
  const status = statusOf(session, times, figures, now);
  const [overdue] = await tx
    .select({ id: loneWorkerAlarm.id })
    .from(loneWorkerAlarm)
    .where(
      and(
        eq(loneWorkerAlarm.sessionId, session.id),
        eq(loneWorkerAlarm.state, "open"),
        inArray(loneWorkerAlarm.reason, ["overdue", "not_finished"]),
      ),
    );
  return {
    id: session.id,
    locationId: session.locationId,
    workKind: session.workKind as z.infer<typeof StartLoneWorkerSession>["workKind"],
    startedAt: session.startedAt.toISOString(),
    plannedEndAt: session.plannedEndAt.toISOString(),
    intervalMinutes: session.intervalMinutes,
    finishedAt: iso(session.finishedAt),
    status: status.kind,
    nextDueAt: iso(dueOf(session, times)),
    overdueAlarmOpen: overdue !== undefined,
    events: events.map((e) => ({
      id: e.id,
      kind: kindShownToWorker(e.kind as LoneWorkerEventKind),
      deviceAt: e.deviceAt.toISOString(),
      receivedAt: e.receivedAt.toISOString(),
      late: e.late,
    })),
    version: session.version,
  };
}
