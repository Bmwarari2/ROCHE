import {
  auditEvent,
  escalationChain,
  type LoneWorkerAlarmRow,
  type LoneWorkerSessionRow,
  loneWorkerAlarm,
  loneWorkerEvent,
  loneWorkerLocation,
  loneWorkerSession,
  notification,
  type Transaction,
} from "@harbour/db";
import {
  type Channel,
  checkRoute,
  type EscalationStep,
  LONE_WORKER_RATE_KEYS,
  LONE_WORKER_ROUTE_KEY,
  type LoneWorkerAlarmReason,
  type LoneWorkerAlarmState,
  type LoneWorkerTimings,
  nextEscalationAt,
  realertDue,
  resolveOnCheckIn,
  type SessionStatus,
  sessionStatus,
} from "@harbour/domain";
import { and, eq, gt, inArray, isNull, ne, sql } from "drizzle-orm";
import { chainStepRecipients } from "../jobs/tasks";
import { publish } from "../outbox";
import { rateNumber } from "./rates";

/**
 * Lone-worker safety (SCHED-012; scheduling.md section 14; HZ-125): the alarm side. Everything
 * here runs as the system (no user, tenant scope), from the API straight after a worker's event
 * and from the per-minute sweep, which repairs anything the API did not finish. Alarm rows are
 * written by nobody else (migration 0113). Notifications carry no personal data: the title and
 * body are generic and the link opens the alarm, where access is checked again.
 */

export const LONE_WORKER_UNROUTED_ACTION = "scheduling.lone_worker.unrouted";
export const LONE_WORKER_ROUTE_MISSING_ACTION = "scheduling.lone_worker.route_missing";
export const LONE_WORKER_ALARM_KIND = "scheduling.lone_worker.alarm";
const CLOCK_DRIFT_KEY = "sync.clock_drift_flag_minutes";

export interface LoneWorkerFigures extends LoneWorkerTimings {
  readonly realertMinutes: number;
  readonly intervalMinMinutes: number;
  readonly intervalMaxMinutes: number;
  readonly sessionMaxHours: number;
  readonly locationDays: number;
}

/** The organisation's figures (rate table, tenant override first); never literals. */
export async function loneWorkerFigures(
  tx: Transaction,
  tenantId: string,
): Promise<LoneWorkerFigures> {
  const n = (key: string) => rateNumber(tx, tenantId, key);
  return {
    graceMinutes: await n(LONE_WORKER_RATE_KEYS.graceMinutes),
    offlineFlagMinutes: await n(LONE_WORKER_RATE_KEYS.offlineFlagMinutes),
    clockDriftMinutes: await n(CLOCK_DRIFT_KEY),
    realertMinutes: await n(LONE_WORKER_RATE_KEYS.realertMinutes),
    intervalMinMinutes: await n(LONE_WORKER_RATE_KEYS.intervalMinMinutes),
    intervalMaxMinutes: await n(LONE_WORKER_RATE_KEYS.intervalMaxMinutes),
    sessionMaxHours: await n(LONE_WORKER_RATE_KEYS.sessionMaxHours),
    locationDays: await n(LONE_WORKER_RATE_KEYS.locationDays),
  };
}

export interface RouteState {
  readonly chainId: string | null;
  readonly steps: readonly EscalationStep[];
  readonly on: boolean;
}

/** The named on-call route, and whether it is valid (the feature is on only then; H-539). */
export async function loneWorkerRoute(tx: Transaction): Promise<RouteState> {
  const [chain] = await tx
    .select()
    .from(escalationChain)
    .where(and(eq(escalationChain.key, LONE_WORKER_ROUTE_KEY), isNull(escalationChain.deletedAt)));
  if (!chain) return { chainId: null, steps: [], on: false };
  const steps = chain.steps as EscalationStep[];
  return { chainId: chain.id, steps, on: checkRoute(steps).problems.length === 0 };
}

/** The effective times of a session's events that show the worker was there (all but finish). */
export async function checkInTimes(tx: Transaction, sessionId: string): Promise<Date[]> {
  const rows = await tx
    .select({ at: loneWorkerEvent.effectiveAt })
    .from(loneWorkerEvent)
    .where(and(eq(loneWorkerEvent.sessionId, sessionId), ne(loneWorkerEvent.kind, "finish")));
  return rows.map((r) => r.at);
}

export function statusOf(
  session: LoneWorkerSessionRow,
  times: readonly Date[],
  figures: Pick<LoneWorkerTimings, "graceMinutes">,
  now: Date,
): SessionStatus {
  return sessionStatus(
    {
      startedAt: session.startedAt,
      plannedEndAt: session.plannedEndAt,
      intervalMinutes: session.intervalMinutes,
      finishedAt: session.finishedAt,
    },
    times,
    figures,
    now,
  );
}

const ALARM_TITLES: Record<LoneWorkerAlarmReason, string> = {
  overdue: "A lone worker has not checked in",
  not_finished: "A lone worker has not finished their session",
  duress: "A lone worker may be in danger",
  help: "A lone worker has asked for help",
};
const ALARM_BODY = "Open the alarm, contact the worker and record what you did.";

async function auditUnrouted(tx: Transaction, alarm: LoneWorkerAlarmRow, step: number) {
  await tx.insert(auditEvent).values({
    tenantId: alarm.tenantId,
    action: LONE_WORKER_UNROUTED_ACTION,
    outcome: "error",
    resourceType: "lone_worker_alarm",
    resourceId: alarm.id,
    reason: "no_recipient",
    scope: { reasonCode: "no_recipient", step, locationId: alarm.locationId },
  });
}

/**
 * The route in force for an alarm: the organisation's, or (if it was removed or broken after the
 * session started) the Registered Manager at once, audited, so an alarm is never silent.
 */
async function routeForAlarm(tx: Transaction, alarm: LoneWorkerAlarmRow): Promise<RouteState> {
  const route = await loneWorkerRoute(tx);
  if (route.on) return route;
  await tx.insert(auditEvent).values({
    tenantId: alarm.tenantId,
    action: LONE_WORKER_ROUTE_MISSING_ACTION,
    outcome: "error",
    resourceType: "lone_worker_alarm",
    resourceId: alarm.id,
    reason: "route_missing",
    scope: { reasonCode: "route_missing", locationId: alarm.locationId },
  });
  const fallback: EscalationStep[] = [
    { afterMinutes: 1, targetRoleKey: "registered_manager", channels: ["in_app", "push", "email"] },
    { afterMinutes: 2, targetRoleKey: "owner", channels: ["in_app", "push", "email"] },
  ];
  return { chainId: null, steps: fallback, on: false };
}

async function notifyAlarm(
  tx: Transaction,
  alarm: LoneWorkerAlarmRow,
  recipients: readonly string[],
  channels: readonly Channel[],
  escalation: { chainId: string; steps: readonly EscalationStep[] } | null,
  now: Date,
  title: string,
) {
  for (const recipient of recipients) {
    await tx
      .insert(notification)
      .values({
        recipientTenantUserId: recipient,
        kind: LONE_WORKER_ALARM_KIND,
        severity: "urgent",
        title,
        body: ALARM_BODY,
        link: `/lone-worker/alarms/${alarm.id}`,
        channels: [...new Set<Channel>(["in_app", ...channels])],
        sourceType: "lone_worker_alarm",
        sourceId: alarm.id,
        locationId: alarm.locationId,
        dedupeKey: `lone_worker_alarm:${alarm.id}:${alarm.alertCount}:${recipient}`,
        ...(escalation
          ? {
              escalationChainId: escalation.chainId,
              escalationStep: 1,
              escalateAt: nextEscalationAt(escalation.steps, {
                createdAt: now,
                stepsFired: 1,
                acknowledgedAt: null,
              }),
            }
          : {}),
      })
      .onConflictDoNothing();
  }
}

/**
 * Tells the route about an alarm. First alert: the worker (overdue and unfinished: "check in now";
 * help: "help is being called"; duress: nothing, ever), then step 1 at once with the chain set so
 * the later steps (the Registered Manager) follow by their minutes until someone acknowledges.
 * A re-alert goes to every step's people at once. Nobody to tell, even through the fallback, is
 * audited as unrouted; the later steps still fire.
 */
export async function alertRoute(
  tx: Transaction,
  alarm: LoneWorkerAlarmRow,
  now: Date,
  first: boolean,
): Promise<number> {
  const route = await routeForAlarm(tx, alarm);
  const title = first
    ? ALARM_TITLES[alarm.reason as LoneWorkerAlarmReason]
    : `Still open: ${ALARM_TITLES[alarm.reason as LoneWorkerAlarmReason]}`;
  let told = 0;
  if (first && alarm.reason !== "duress") {
    await tx
      .insert(notification)
      .values({
        recipientTenantUserId: alarm.workerTenantUserId,
        kind: "scheduling.lone_worker.worker_alarm",
        severity: "urgent",
        title:
          alarm.reason === "help"
            ? "Your request for help has been sent"
            : "Your check-in is overdue: check in now if you are safe",
        body:
          alarm.reason === "help"
            ? "The on-call person has been told. Stay where it is safe."
            : "The on-call person has been told. Checking in tells them you are safe.",
        link: "/lone-worker",
        channels: ["in_app", "push"],
        sourceType: "lone_worker_alarm",
        sourceId: alarm.id,
        locationId: alarm.locationId,
        dedupeKey: `lone_worker_worker_alarm:${alarm.id}`,
      })
      .onConflictDoNothing();
  }
  const steps = first ? route.steps.slice(0, 1) : route.steps;
  for (const [index, step] of steps.entries()) {
    const recipients = (await chainStepRecipients(tx, step, alarm.locationId, now)).filter(
      (r) => r !== alarm.workerTenantUserId,
    );
    if (recipients.length === 0) {
      await auditUnrouted(tx, alarm, index);
      continue;
    }
    told += recipients.length;
    const escalation =
      first && route.chainId && route.steps.length > 1
        ? { chainId: route.chainId, steps: route.steps }
        : null;
    await notifyAlarm(tx, alarm, recipients, step.channels, escalation, now, title);
  }
  // The fallback route has no chain row: its later steps go out now rather than never.
  if (first && !route.chainId) {
    for (const [index, step] of route.steps.slice(1).entries()) {
      const recipients = (await chainStepRecipients(tx, step, alarm.locationId, now)).filter(
        (r) => r !== alarm.workerTenantUserId,
      );
      if (recipients.length === 0) await auditUnrouted(tx, alarm, index + 1);
      else await notifyAlarm(tx, alarm, recipients, step.channels, null, now, title);
    }
  }
  return told;
}

async function insertAlarm(
  tx: Transaction,
  values: typeof loneWorkerAlarm.$inferInsert,
): Promise<LoneWorkerAlarmRow | null> {
  const [row] = await tx.insert(loneWorkerAlarm).values(values).onConflictDoNothing().returning();
  return row ?? null;
}

/** Raises the alarm for a help or duress event (once: the event id is unique). */
export async function raiseWorkerAlarm(
  tx: Transaction,
  session: LoneWorkerSessionRow,
  event: { id: string; kind: "help" | "duress" },
  now: Date,
): Promise<LoneWorkerAlarmRow | null> {
  const alarm = await insertAlarm(tx, {
    tenantId: session.tenantId,
    sessionId: session.id,
    locationId: session.locationId,
    workerTenantUserId: session.workerTenantUserId,
    reason: event.kind,
    triggerEventId: event.id,
    raisedAt: now,
    lastAlertedAt: now,
  });
  if (!alarm) return null;
  await alertRoute(tx, alarm, now, true);
  await publishAlarm(tx, alarm, "scheduling.lone_worker.alarm_raised");
  return alarm;
}

async function publishAlarm(
  tx: Transaction,
  alarm: LoneWorkerAlarmRow,
  type: `scheduling.lone_worker.${string}`,
) {
  await publish(tx, {
    context: "scheduling",
    aggregateType: "lone_worker_alarm",
    aggregateId: alarm.id,
    type,
    payload: { alarmId: alarm.id, sessionId: alarm.sessionId, reason: alarm.reason },
  });
}

/** Acknowledges every notification about an alarm, and the escalations they started. */
export async function acknowledgeAlarmNotifications(
  tx: Transaction,
  alarmId: string,
  now: Date,
): Promise<void> {
  const sent = await tx
    .update(notification)
    .set({ acknowledgedAt: now, escalateAt: null })
    .where(
      and(
        eq(notification.sourceType, "lone_worker_alarm"),
        eq(notification.sourceId, alarmId),
        isNull(notification.acknowledgedAt),
      ),
    )
    .returning({ id: notification.id });
  const all = await tx
    .select({ id: notification.id })
    .from(notification)
    .where(
      and(eq(notification.sourceType, "lone_worker_alarm"), eq(notification.sourceId, alarmId)),
    );
  const ids = [...new Set([...sent, ...all].map((n) => n.id))];
  if (ids.length === 0) return;
  await tx
    .update(notification)
    .set({ acknowledgedAt: now, escalateAt: null })
    .where(
      and(
        eq(notification.sourceType, "notification"),
        inArray(notification.sourceId, ids),
        isNull(notification.acknowledgedAt),
      ),
    );
}

/** Everyone told about an alarm (not the worker), to tell them how it ended. */
async function alertedAbout(tx: Transaction, alarm: LoneWorkerAlarmRow): Promise<string[]> {
  const direct = await tx
    .selectDistinct({ id: notification.recipientTenantUserId, nid: notification.id })
    .from(notification)
    .where(
      and(
        eq(notification.sourceType, "lone_worker_alarm"),
        eq(notification.sourceId, alarm.id),
        eq(notification.kind, LONE_WORKER_ALARM_KIND),
      ),
    );
  const escalated =
    direct.length === 0
      ? []
      : await tx
          .selectDistinct({ id: notification.recipientTenantUserId })
          .from(notification)
          .where(
            and(
              eq(notification.sourceType, "notification"),
              inArray(
                notification.sourceId,
                direct.map((d) => d.nid),
              ),
            ),
          );
  return [...new Set([...direct, ...escalated].map((r) => r.id))].filter(
    (id) => id !== alarm.workerTenantUserId,
  );
}

/**
 * Re-evaluates a session's open overdue or unfinished alarm after a check-in (from the API or the
 * sweep). Resolved only when the worker is not overdue again (`resolveOnCheckIn`); a check-in made
 * before the alarm was raised, stuck on an offline device, resolves it as a late check-in, and
 * everyone alerted is told the worker was safe at that time.
 */
export async function resolveAfterCheckIn(
  tx: Transaction,
  session: LoneWorkerSessionRow,
  figures: Pick<LoneWorkerTimings, "graceMinutes">,
  now: Date,
): Promise<number> {
  const open = await tx
    .select()
    .from(loneWorkerAlarm)
    .where(
      and(
        eq(loneWorkerAlarm.sessionId, session.id),
        eq(loneWorkerAlarm.state, "open"),
        inArray(loneWorkerAlarm.reason, ["overdue", "not_finished"]),
      ),
    );
  if (open.length === 0) return 0;
  const events = await tx
    .select()
    .from(loneWorkerEvent)
    .where(and(eq(loneWorkerEvent.sessionId, session.id), ne(loneWorkerEvent.kind, "finish")));
  const after = statusOf(
    session,
    events.map((e) => e.effectiveAt),
    figures,
    now,
  );
  const finished = session.finishedAt !== null;
  let resolved = 0;
  for (const alarm of open) {
    // What resolves it: the finish when the session has finished, else the latest check-in (by
    // the time it was made) among those received since the alarm was raised.
    const finishEvent = finished
      ? (
          await tx
            .select()
            .from(loneWorkerEvent)
            .where(
              and(eq(loneWorkerEvent.sessionId, session.id), eq(loneWorkerEvent.kind, "finish")),
            )
        )[0]
      : undefined;
    const latest = events
      .filter((e) => e.receivedAt.getTime() >= alarm.raisedAt.getTime())
      .sort((x, y) => y.effectiveAt.getTime() - x.effectiveAt.getTime())[0];
    const by = finishEvent ?? latest;
    if (!by) continue;
    const outcome = resolveOnCheckIn(
      { reason: alarm.reason as LoneWorkerAlarmReason, raisedAt: alarm.raisedAt },
      by.effectiveAt,
      finished ? { kind: "finished" } : after,
    );
    if (outcome.kind !== "resolved") continue;
    const [row] = await tx
      .update(loneWorkerAlarm)
      .set({ state: outcome.state, resolvedAt: now, resolvedByEventId: by.id })
      .where(and(eq(loneWorkerAlarm.id, alarm.id), eq(loneWorkerAlarm.state, "open")))
      .returning();
    if (!row) continue;
    resolved++;
    const told = await alertedAbout(tx, row);
    await acknowledgeAlarmNotifications(tx, row.id, now);
    const late = outcome.state === "resolved_late_check_in";
    for (const recipient of told) {
      await tx
        .insert(notification)
        .values({
          recipientTenantUserId: recipient,
          kind: "scheduling.lone_worker.alarm_resolved",
          severity: "info",
          title: late
            ? "A lone worker's late check-in arrived: they were safe when they made it"
            : "A lone worker checked in after the alarm",
          body: late
            ? "Their device was offline. Open the alarm to see when they last checked in."
            : "Open the alarm to see when they checked in.",
          link: `/lone-worker/alarms/${row.id}`,
          channels: ["in_app", "push"],
          sourceType: "lone_worker_alarm_resolved",
          sourceId: row.id,
          locationId: row.locationId,
          dedupeKey: `lone_worker_alarm_resolved:${row.id}:${recipient}`,
        })
        .onConflictDoNothing();
    }
    await publishAlarm(tx, row, "scheduling.lone_worker.alarm_resolved");
  }
  return resolved;
}

/**
 * The per-minute sweep for one organisation (system context): reminds workers whose check-in is
 * due, raises alarms past the grace period, raises any help or duress alarm the API did not, re-
 * evaluates open alarms after late check-ins, re-alerts open alarms, and erases location evidence
 * at its date. Returns how many alarms it raised or re-alerted.
 */
export const LONE_WORKER_SWEEP_ITEM_FAILED_ACTION = "scheduling.lone_worker.sweep_item_failed";

/**
 * Runs one piece of the sweep in a savepoint, so one session or alarm that fails (a bad row, a
 * refused write) never holds up the alarms of everyone else in the organisation (HZ-125). The
 * failure is audited with its database code only and counted; the next minute tries again.
 */
async function isolated(
  tx: Transaction,
  tenantId: string,
  resourceType: string,
  resourceId: string | null,
  fn: (sp: Transaction) => Promise<number>,
): Promise<number> {
  try {
    return await tx.transaction((sp) => fn(sp));
  } catch (error) {
    const code =
      (error as { code?: string }).code ??
      (error as { cause?: { code?: string } }).cause?.code ??
      "unknown";
    await tx.insert(auditEvent).values({
      tenantId,
      action: LONE_WORKER_SWEEP_ITEM_FAILED_ACTION,
      outcome: "error",
      resourceType,
      ...(resourceId ? { resourceId } : {}),
      reason: "sweep_failed",
      scope: { reasonCode: "sweep_failed", code },
    });
    return 0;
  }
}

async function sweepSession(
  tx: Transaction,
  tenantId: string,
  session: LoneWorkerSessionRow,
  hasOverdue: boolean,
  figures: LoneWorkerFigures,
  now: Date,
): Promise<number> {
  if (hasOverdue) {
    await resolveAfterCheckIn(tx, session, figures, now);
    return 0;
  }
  const status = statusOf(session, await checkInTimes(tx, session.id), figures, now);
  if (status.kind === "due") {
    if (session.reminderSentFor?.getTime() === status.dueAt.getTime()) return 0;
    await tx
      .insert(notification)
      .values({
        recipientTenantUserId: session.workerTenantUserId,
        kind: "scheduling.lone_worker.check_in_due",
        severity: "warning",
        title: "Your lone-working check-in is due",
        body: "Check in to say you are safe.",
        link: "/lone-worker",
        channels: ["in_app", "push"],
        sourceType: "lone_worker_session",
        sourceId: session.id,
        locationId: session.locationId,
        dedupeKey: `lone_worker_due:${session.id}:${status.dueAt.toISOString()}`,
      })
      .onConflictDoNothing();
    await tx
      .update(loneWorkerSession)
      .set({ reminderSentFor: status.dueAt })
      .where(eq(loneWorkerSession.id, session.id));
    return 0;
  }
  if (status.kind !== "alarm") return 0;
  const alarm = await insertAlarm(tx, {
    tenantId,
    sessionId: session.id,
    locationId: session.locationId,
    workerTenantUserId: session.workerTenantUserId,
    reason: status.reason,
    dueAt: status.dueAt,
    raisedAt: now,
    lastAlertedAt: now,
  });
  if (!alarm) return 0;
  await alertRoute(tx, alarm, now, true);
  await publishAlarm(tx, alarm, "scheduling.lone_worker.alarm_raised");
  return 1;
}

async function sweepAlarm(
  tx: Transaction,
  alarm: LoneWorkerAlarmRow,
  figures: LoneWorkerFigures,
  now: Date,
): Promise<number> {
  const [session] = await tx
    .select()
    .from(loneWorkerSession)
    .where(eq(loneWorkerSession.id, alarm.sessionId));
  // An overdue alarm on a session finished since is resolved instead.
  if (
    session?.finishedAt &&
    (alarm.reason === "overdue" || alarm.reason === "not_finished") &&
    (await resolveAfterCheckIn(tx, session, figures, now)) > 0
  )
    return 0;
  const [current] = await tx.select().from(loneWorkerAlarm).where(eq(loneWorkerAlarm.id, alarm.id));
  if (
    !current ||
    !realertDue(
      { state: current.state as LoneWorkerAlarmState, lastAlertedAt: current.lastAlertedAt },
      figures.realertMinutes,
      now,
    )
  )
    return 0;
  const [bumped] = await tx
    .update(loneWorkerAlarm)
    .set({ lastAlertedAt: now, alertCount: current.alertCount + 1 })
    .where(and(eq(loneWorkerAlarm.id, alarm.id), eq(loneWorkerAlarm.state, "open")))
    .returning();
  if (!bumped) return 0;
  await alertRoute(tx, bumped, now, false);
  return 1;
}

/**
 * The per-minute sweep for one organisation (system context): raises any help or duress alarm
 * the API did not, reminds workers whose check-in is due, raises alarms past the grace period,
 * re-evaluates open alarms after late check-ins, re-alerts open alarms, and erases location
 * evidence at its date. Each piece runs in its own savepoint (`isolated`). Returns how many alarms
 * it raised or re-alerted.
 */
export async function sweepLoneWorkers(
  tx: Transaction,
  tenantId: string,
  now: Date,
): Promise<number> {
  let acted = 0;
  const open = await tx
    .select()
    .from(loneWorkerSession)
    .where(and(isNull(loneWorkerSession.finishedAt), isNull(loneWorkerSession.deletedAt)))
    .limit(2000);
  const openAlarms = await tx
    .select()
    .from(loneWorkerAlarm)
    .where(eq(loneWorkerAlarm.state, "open"))
    .limit(2000);
  // Help and duress events with no alarm (the API's own raise failed): raise them now.
  const unalarmed = await tx
    .select({ event: loneWorkerEvent, session: loneWorkerSession })
    .from(loneWorkerEvent)
    .innerJoin(loneWorkerSession, eq(loneWorkerSession.id, loneWorkerEvent.sessionId))
    .leftJoin(loneWorkerAlarm, eq(loneWorkerAlarm.triggerEventId, loneWorkerEvent.id))
    .where(
      and(
        inArray(loneWorkerEvent.kind, ["help", "duress"]),
        isNull(loneWorkerAlarm.id),
        gt(loneWorkerEvent.receivedAt, new Date(now.getTime() - 7 * 86_400_000)),
      ),
    );
  if (open.length > 0 || openAlarms.length > 0 || unalarmed.length > 0) {
    const figures = await loneWorkerFigures(tx, tenantId);
    for (const { event, session } of unalarmed) {
      acted += await isolated(tx, tenantId, "lone_worker_event", event.id, async (sp) =>
        (await raiseWorkerAlarm(
          sp,
          session,
          { id: event.id, kind: event.kind as "help" | "duress" },
          now,
        ))
          ? 1
          : 0,
      );
    }
    for (const session of open) {
      const hasOverdue = openAlarms.some(
        (a) =>
          a.sessionId === session.id && (a.reason === "overdue" || a.reason === "not_finished"),
      );
      acted += await isolated(tx, tenantId, "lone_worker_session", session.id, (sp) =>
        sweepSession(sp, tenantId, session, hasOverdue, figures, now),
      );
    }
    // Open alarms keep being sent until a person acknowledges them (never silent; HZ-125).
    for (const alarm of openAlarms) {
      acted += await isolated(tx, tenantId, "lone_worker_alarm", alarm.id, (sp) =>
        sweepAlarm(sp, alarm, figures, now),
      );
    }
  }
  // Location evidence is erased at its date (H-527), last and on its own, judged on the
  // database's clock as the table's guard judges it.
  await isolated(tx, tenantId, "lone_worker_location", null, async (sp) => {
    await sp
      .update(loneWorkerLocation)
      .set({ latitude: null, longitude: null, accuracyMetres: null, clearedAt: sql`now()` })
      .where(
        and(sql`${loneWorkerLocation.deleteAfter} <= now()`, isNull(loneWorkerLocation.clearedAt)),
      );
    return 0;
  });
  return acted;
}
