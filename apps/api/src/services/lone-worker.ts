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
  role,
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
  PORTAL_ONLY_PERMISSIONS,
  realertDue,
  resolveOnCheckIn,
  type SessionStatus,
  sessionStatus,
} from "@harbour/domain";
import { and, eq, gt, inArray, isNull, ne, sql } from "drizzle-orm";
import { publish } from "../outbox";
import { rateNumber } from "./rates";
import { roleHolders, toldOf } from "./role-holders";
import { permissionHolders } from "./safety";

/**
 * Lone-worker safety (SCHED-012; scheduling.md section 17; HZ-125): the alarm side. Everything
 * here runs as the system (no user, tenant scope), from the API straight after a worker's event
 * and from the per-minute sweep, which repairs anything the API did not finish. Alarm rows are
 * written by nobody else (migration 0113). Notifications carry no personal data: the title and
 * body are generic and the link opens the alarm, where access is checked again.
 *
 * Lone-worker alarms escalate here, not through the general escalation engine (review round 1:
 * clinical H2 and H3, security H1 and H2): every recipient is worked out with the worker removed
 * before any fallback, so a duress alarm never reaches the worker and a step that resolves only
 * to the worker falls through to the next people at once; and only holders of the monitor
 * permission where the alarm is are told (security M2), since only they can open and acknowledge
 * it. Their notifications carry no escalation chain, so acknowledging a notification in the
 * centre never stops the escalation (clinical M6): only acknowledging the alarm does.
 */

export const LONE_WORKER_UNROUTED_ACTION = "scheduling.lone_worker.unrouted";
export const LONE_WORKER_ROUTE_MISSING_ACTION = "scheduling.lone_worker.route_missing";
export const LONE_WORKER_ALARM_KIND = "scheduling.lone_worker.alarm";
export const LONE_WORKER_MONITOR = "scheduling.lone_worker.monitor";
const CLOCK_DRIFT_KEY = "sync.clock_drift_flag_minutes";
/** Who is told when nobody named on the route can be, in order (H-1030). */
const LAST_RESORT_ROLES = ["registered_manager", "owner"] as const;
/**
 * The route used when the organisation's was removed or broken after sessions started: the
 * Registered Manager (then the owner) at once. Step 1 is always told when the alarm is raised, so
 * its minutes are never read.
 */
const FALLBACK_ROUTE: readonly EscalationStep[] = [
  { afterMinutes: 1, targetRoleKey: "registered_manager", channels: ["in_app", "push", "email"] },
];
/**
 * How far back the sweep looks for a help or duress press with no alarm: the API raises it at
 * once, so this only repairs a failure; a week covers any outage the service could have had.
 */
const UNALARMED_LOOKBACK_DAYS = 7;
const DAY_MS = 86_400_000;
/** Sessions and alarms looked at per organisation per minute, oldest first. */
const SWEEP_BATCH = 2000;

export interface LoneWorkerFigures extends LoneWorkerTimings {
  readonly realertMinutes: number;
  readonly intervalMinMinutes: number;
  readonly intervalMaxMinutes: number;
  readonly sessionMaxHours: number;
  readonly locationDays: number;
}

/**
 * The organisation's figures (rate table, tenant override first); never literals. A tenant
 * override can never make the alarm silent: re-alerting is at least every minute and the grace
 * period never negative (clinical review L4).
 */
export async function loneWorkerFigures(
  tx: Transaction,
  tenantId: string,
): Promise<LoneWorkerFigures> {
  const n = (key: string) => rateNumber(tx, tenantId, key);
  return {
    graceMinutes: Math.max(0, await n(LONE_WORKER_RATE_KEYS.graceMinutes)),
    offlineFlagMinutes: await n(LONE_WORKER_RATE_KEYS.offlineFlagMinutes),
    clockDriftMinutes: await n(CLOCK_DRIFT_KEY),
    realertMinutes: Math.max(1, await n(LONE_WORKER_RATE_KEYS.realertMinutes)),
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
  readonly version: number | null;
}

/** The named on-call route, and whether it is valid (the feature is on only then; H-539). */
export async function loneWorkerRoute(tx: Transaction): Promise<RouteState> {
  const [chain] = await tx
    .select()
    .from(escalationChain)
    .where(and(eq(escalationChain.key, LONE_WORKER_ROUTE_KEY), isNull(escalationChain.deletedAt)));
  if (!chain) return { chainId: null, steps: [], on: false, version: null };
  const steps = chain.steps as EscalationStep[];
  return {
    chainId: chain.id,
    steps,
    on: checkRoute(steps).problems.length === 0,
    version: chain.version,
  };
}

/**
 * Whom a step can tell for a worker's alarm at a location: its named person or role, with the
 * worker removed first, kept to holders of the monitor permission there; when that leaves nobody,
 * the Registered Manager, then the owner, on the same terms.
 */
export async function stepRecipients(
  tx: Transaction,
  step: EscalationStep,
  workerId: string,
  locationId: string,
  now: Date,
): Promise<string[]> {
  const monitors = new Set(await permissionHolders(tx, LONE_WORKER_MONITOR, locationId, now));
  const usable = (ids: Iterable<string>) =>
    [...new Set(ids)].filter((id) => id !== workerId && monitors.has(id)).sort();
  const direct: string[] = [];
  if (step.targetTenantUserId) direct.push(...(await toldOf(tx, [step.targetTenantUserId])));
  if (step.targetRoleKey) {
    direct.push(...(await roleHolders(tx, [step.targetRoleKey], [locationId], now)));
  }
  const found = usable(direct);
  if (found.length > 0) return found;
  for (const key of LAST_RESORT_ROLES) {
    const fallback = usable(await roleHolders(tx, [key], [locationId], now));
    if (fallback.length > 0) return fallback;
  }
  return [];
}

/** Whether the route would reach anyone but the worker at a location (checked at session start). */
export async function routeReachesSomeone(
  tx: Transaction,
  steps: readonly EscalationStep[],
  workerId: string,
  locationId: string,
  now: Date,
): Promise<boolean> {
  for (const step of steps.length > 0 ? steps : FALLBACK_ROUTE) {
    if ((await stepRecipients(tx, step, workerId, locationId, now)).length > 0) return true;
  }
  return false;
}

/**
 * Who the route may name (security review M2): a role key must be a staff role of the
 * organisation carrying the monitor permission, and a named person an active member who holds it
 * somewhere; families, the people receiving care, inspectors and visitors are never on it.
 */
export async function routeTargetProblems(
  tx: Transaction,
  steps: readonly EscalationStep[],
  now: Date,
): Promise<string[]> {
  const problems: string[] = [];
  const keys = [...new Set(steps.flatMap((s) => (s.targetRoleKey ? [s.targetRoleKey] : [])))];
  if (keys.length > 0) {
    const roles = await tx
      .select({ key: role.key, permissions: role.permissions })
      .from(role)
      .where(and(inArray(role.key, keys), isNull(role.archivedAt)));
    for (const key of keys) {
      const found = roles.filter((r) => r.key === key);
      const fit = found.some(
        (r) =>
          r.permissions.includes(LONE_WORKER_MONITOR) &&
          !r.permissions.some((p) => (PORTAL_ONLY_PERMISSIONS as readonly string[]).includes(p)),
      );
      if (!fit) {
        problems.push(
          `The role "${key}" cannot be on the route: it must be a staff role that can see and acknowledge lone-worker alarms.`,
        );
      }
    }
  }
  const named = [
    ...new Set(steps.flatMap((s) => (s.targetTenantUserId ? [s.targetTenantUserId] : []))),
  ];
  if (named.length > 0) {
    const monitors = new Set(await permissionHolders(tx, LONE_WORKER_MONITOR, null, now));
    if (named.some((id) => !monitors.has(id))) {
      problems.push(
        "A person named on the route must be an active member of staff who can see and acknowledge lone-worker alarms.",
      );
    }
  }
  return problems;
}

/**
 * The times that show the worker was there, for when the next check-in is due: every event but
 * the finish (a duress press must look like a check-in, so it counts too), and the times a
 * monitor acknowledged an alarm as safe confirmed (a confirmed contact restarts the interval, so
 * acknowledging an alarm never raises it again a minute later; clinical review M2).
 */
export async function signsOfWorker(tx: Transaction, sessionId: string): Promise<Date[]> {
  const rows = await tx
    .select({ at: loneWorkerEvent.effectiveAt })
    .from(loneWorkerEvent)
    .where(and(eq(loneWorkerEvent.sessionId, sessionId), ne(loneWorkerEvent.kind, "finish")));
  return [...rows.map((r) => r.at), ...(await safeContacts(tx, sessionId))];
}

/** When monitors confirmed the worker safe on an alarm about this session. */
async function safeContacts(tx: Transaction, sessionId: string): Promise<Date[]> {
  const rows = await tx
    .select({ at: loneWorkerAlarm.acknowledgedAt })
    .from(loneWorkerAlarm)
    .where(
      and(eq(loneWorkerAlarm.sessionId, sessionId), eq(loneWorkerAlarm.outcome, "safe_confirmed")),
    );
  return rows.flatMap((r) => (r.at ? [r.at] : []));
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

async function auditUnrouted(tx: Transaction, alarm: LoneWorkerAlarmRow, step: number | "all") {
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
 * session started) the Registered Manager and owner at once, audited, so an alarm is never silent.
 */
async function routeForAlarm(
  tx: Transaction,
  alarm: LoneWorkerAlarmRow,
): Promise<readonly EscalationStep[]> {
  const route = await loneWorkerRoute(tx);
  if (route.on) return route.steps;
  await tx.insert(auditEvent).values({
    tenantId: alarm.tenantId,
    action: LONE_WORKER_ROUTE_MISSING_ACTION,
    outcome: "error",
    resourceType: "lone_worker_alarm",
    resourceId: alarm.id,
    reason: "route_missing",
    scope: { reasonCode: "route_missing", locationId: alarm.locationId },
  });
  return FALLBACK_ROUTE;
}

async function notifyAlarm(
  tx: Transaction,
  alarm: LoneWorkerAlarmRow,
  recipients: readonly string[],
  channels: readonly Channel[],
  title: string,
  tag: string,
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
        dedupeKey: `lone_worker_alarm:${alarm.id}:${tag}:${recipient}`,
      })
      .onConflictDoNothing();
  }
}

/**
 * The first alert. Step 1 is told at once; a step that reaches nobody (after the worker is removed
 * and the fallback tried) is audited and the next step is told straight away, so nobody waits for
 * a step that cannot be sent. Then the worker is told, in words that are true (clinical review
 * M3): overdue, "check in now"; help, whether anyone has been reached; duress, nothing, ever.
 * Returns how many people were told; nobody at all is audited as unrouted for the whole route.
 */
async function alertFirst(tx: Transaction, alarm: LoneWorkerAlarmRow, now: Date): Promise<number> {
  const steps = await routeForAlarm(tx, alarm);
  const reason = alarm.reason as LoneWorkerAlarmReason;
  let told = 0;
  let index = 0;
  for (; index < steps.length; index++) {
    const step = steps[index];
    if (!step) break;
    const recipients = await stepRecipients(
      tx,
      step,
      alarm.workerTenantUserId,
      alarm.locationId,
      now,
    );
    if (recipients.length === 0) {
      await auditUnrouted(tx, alarm, index);
      continue;
    }
    told += recipients.length;
    await notifyAlarm(tx, alarm, recipients, step.channels, ALARM_TITLES[reason], `s${index}`);
    break;
  }
  if (told === 0) await auditUnrouted(tx, alarm, "all");
  await tx
    .update(loneWorkerAlarm)
    .set({ escalationStep: Math.min(index + 1, Math.max(steps.length, 1)) })
    .where(eq(loneWorkerAlarm.id, alarm.id));
  if (reason !== "duress") {
    const reached = told > 0;
    await tx
      .insert(notification)
      .values({
        recipientTenantUserId: alarm.workerTenantUserId,
        kind: "scheduling.lone_worker.worker_alarm",
        severity: "urgent",
        title:
          reason === "help"
            ? "Your request for help has been sent"
            : "Your check-in is overdue: check in now if you are safe",
        body: reached
          ? reason === "help"
            ? "The on-call person has been told. Stay where it is safe."
            : "The on-call person has been told. Checking in tells them you are safe."
          : "Nobody could be reached yet. If you are in danger, call 999.",
        link: "/lone-worker",
        channels: ["in_app", "push"],
        sourceType: "lone_worker_alarm",
        sourceId: alarm.id,
        locationId: alarm.locationId,
        dedupeKey: `lone_worker_worker_alarm:${alarm.id}`,
      })
      .onConflictDoNothing();
  }
  return told;
}

/**
 * Later steps by their minutes after the alarm was raised, while it is open: each step's people
 * are told once ("Escalated: ..."); a step that reaches nobody is audited and passed.
 */
async function escalateDue(tx: Transaction, alarm: LoneWorkerAlarmRow, now: Date): Promise<number> {
  const steps = await routeForAlarm(tx, alarm);
  const reason = alarm.reason as LoneWorkerAlarmReason;
  let next = alarm.escalationStep;
  let told = 0;
  while (next < steps.length) {
    const step = steps[next];
    if (!step || alarm.raisedAt.getTime() + step.afterMinutes * 60_000 > now.getTime()) break;
    const recipients = await stepRecipients(
      tx,
      step,
      alarm.workerTenantUserId,
      alarm.locationId,
      now,
    );
    if (recipients.length === 0) await auditUnrouted(tx, alarm, next);
    else {
      told += recipients.length;
      await notifyAlarm(
        tx,
        alarm,
        recipients,
        step.channels,
        `Escalated: ${ALARM_TITLES[reason]}`,
        `s${next}`,
      );
    }
    next++;
  }
  if (next !== alarm.escalationStep) {
    await tx
      .update(loneWorkerAlarm)
      .set({ escalationStep: next })
      .where(and(eq(loneWorkerAlarm.id, alarm.id), eq(loneWorkerAlarm.state, "open")));
  }
  return told;
}

/** A re-alert: everyone on every step at once (never silent, even after the chain has run out). */
async function realert(tx: Transaction, alarm: LoneWorkerAlarmRow, now: Date): Promise<number> {
  const steps = await routeForAlarm(tx, alarm);
  const reason = alarm.reason as LoneWorkerAlarmReason;
  const everyone = new Set<string>();
  const channels = new Set<Channel>();
  for (const step of steps) {
    for (const id of await stepRecipients(
      tx,
      step,
      alarm.workerTenantUserId,
      alarm.locationId,
      now,
    )) {
      everyone.add(id);
    }
    for (const c of step.channels) channels.add(c);
  }
  if (everyone.size === 0) {
    await auditUnrouted(tx, alarm, "all");
    return 0;
  }
  await notifyAlarm(
    tx,
    alarm,
    [...everyone],
    [...channels],
    `Still open: ${ALARM_TITLES[reason]}`,
    `a${alarm.alertCount}`,
  );
  return everyone.size;
}

async function insertAlarm(
  tx: Transaction,
  values: typeof loneWorkerAlarm.$inferInsert,
): Promise<LoneWorkerAlarmRow | null> {
  const [row] = await tx.insert(loneWorkerAlarm).values(values).onConflictDoNothing().returning();
  return row ?? null;
}

/**
 * Raises the alarm for a help or duress event. One open alarm per session and kind: a further
 * press while one is open is recorded and re-sends the open alarm to the route at once instead of
 * starting another (security review M4). Returns how many people were told (0 when nobody could
 * be), or null when nothing was raised or re-sent.
 */
export async function raiseWorkerAlarm(
  tx: Transaction,
  session: LoneWorkerSessionRow,
  event: { id: string; kind: "help" | "duress" },
  now: Date,
): Promise<number | null> {
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
  if (alarm) {
    const told = await alertFirst(tx, alarm, now);
    await publishAlarm(tx, alarm, "scheduling.lone_worker.alarm_raised");
    return told;
  }
  const [open] = await tx
    .select()
    .from(loneWorkerAlarm)
    .where(
      and(
        eq(loneWorkerAlarm.sessionId, session.id),
        eq(loneWorkerAlarm.reason, event.kind),
        eq(loneWorkerAlarm.state, "open"),
      ),
    );
  if (!open || open.triggerEventId === event.id) return null;
  // Re-sent at most once a minute however often it is pressed.
  if (now.getTime() - open.lastAlertedAt.getTime() < 60_000) return null;
  const [bumped] = await tx
    .update(loneWorkerAlarm)
    .set({ lastAlertedAt: now, alertCount: open.alertCount + 1 })
    .where(and(eq(loneWorkerAlarm.id, open.id), eq(loneWorkerAlarm.state, "open")))
    .returning();
  return bumped ? realert(tx, bumped, now) : null;
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

/**
 * Acknowledges every notification about an alarm. Runs in the monitor's own transaction (under
 * tenant-wide scope for the notification table) or the system's, so an acknowledged alarm never
 * goes on being sent (clinical review M7).
 */
export async function acknowledgeAlarmNotifications(
  tx: Transaction,
  alarmId: string,
  now: Date,
): Promise<void> {
  await tx
    .update(notification)
    .set({ acknowledgedAt: now, escalateAt: null })
    .where(
      and(
        eq(notification.sourceType, "lone_worker_alarm"),
        eq(notification.sourceId, alarmId),
        isNull(notification.acknowledgedAt),
      ),
    );
}

/** Everyone told about an alarm (not the worker), to tell them how it ended. */
async function alertedAbout(tx: Transaction, alarm: LoneWorkerAlarmRow): Promise<string[]> {
  const rows = await tx
    .selectDistinct({ id: notification.recipientTenantUserId })
    .from(notification)
    .where(
      and(
        eq(notification.sourceType, "lone_worker_alarm"),
        eq(notification.sourceId, alarm.id),
        eq(notification.kind, LONE_WORKER_ALARM_KIND),
      ),
    );
  return rows.map((r) => r.id).filter((id) => id !== alarm.workerTenantUserId);
}

const RESOLVED_WORDS: Record<
  "resolved_by_check_in" | "resolved_late_check_in" | "resolved_by_finish",
  { title: string; body: string }
> = {
  resolved_by_check_in: {
    title: "A lone worker checked in after the alarm",
    body: "Open the alarm to see when they checked in.",
  },
  resolved_late_check_in: {
    title: "A lone worker's late check-in arrived: they were safe when they made it",
    body: "Their device was offline. Open the alarm to see when they last checked in.",
  },
  resolved_by_finish: {
    title: "A lone worker finished their session after the alarm",
    body: "Open the alarm to see when they finished.",
  },
};

/**
 * Re-evaluates a session's open overdue or unfinished alarms after a check-in or the finish (from
 * the API or the sweep). Only ordinary check-ins, confirmed contacts and the finish count here: a
 * help or duress press never resolves an alarm or tells anyone the worker "checked in" (clinical
 * review M1, security review M1). Resolved only when the worker is not overdue again
 * (`resolveOnCheckIn`); a check-in made before the alarm was raised, stuck on an offline device,
 * resolves it as a late check-in, and everyone alerted is told the worker was safe at that time.
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
    .where(
      and(
        eq(loneWorkerEvent.sessionId, session.id),
        inArray(loneWorkerEvent.kind, ["check_in", "finish"]),
      ),
    );
  const checkIns = events.filter((e) => e.kind === "check_in");
  const finishEvent = events.find((e) => e.kind === "finish");
  const finished = session.finishedAt !== null && finishEvent !== undefined;
  const after = finished
    ? ({ kind: "finished" } as const)
    : statusOf(
        session,
        [...checkIns.map((e) => e.effectiveAt), ...(await safeContacts(tx, session.id))],
        figures,
        now,
      );
  let resolved = 0;
  for (const alarm of open) {
    // What resolves it: the finish when the session has finished, else the latest check-in (by
    // the time it was made) among those received since the alarm was raised.
    const latest = checkIns
      .filter((e) => e.receivedAt.getTime() >= alarm.raisedAt.getTime())
      .sort((x, y) => y.effectiveAt.getTime() - x.effectiveAt.getTime())[0];
    const by = finished ? finishEvent : latest;
    if (!by) continue;
    const outcome = resolveOnCheckIn(
      { reason: alarm.reason as LoneWorkerAlarmReason, raisedAt: alarm.raisedAt },
      by.effectiveAt,
      after,
      finished,
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
    const words = RESOLVED_WORDS[outcome.state];
    for (const recipient of told) {
      await tx
        .insert(notification)
        .values({
          recipientTenantUserId: recipient,
          kind: "scheduling.lone_worker.alarm_resolved",
          severity: "info",
          title: words.title,
          body: words.body,
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
  const status = statusOf(session, await signsOfWorker(tx, session.id), figures, now);
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
  await alertFirst(tx, alarm, now);
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
  const [later] = await tx.select().from(loneWorkerAlarm).where(eq(loneWorkerAlarm.id, alarm.id));
  if (later?.state === "open") await escalateDue(tx, later, now);
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
  await realert(tx, bumped, now);
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
    .orderBy(loneWorkerSession.startedAt)
    .limit(SWEEP_BATCH);
  // Longest unsent first, so nothing is ever left behind by the batch size (clinical review L1).
  const openAlarms = await tx
    .select()
    .from(loneWorkerAlarm)
    .where(eq(loneWorkerAlarm.state, "open"))
    .orderBy(loneWorkerAlarm.lastAlertedAt)
    .limit(SWEEP_BATCH);
  // Help and duress events with no alarm of their own and none of their kind open or closed after
  // they arrived (a press while one was open is covered by it): the API's raise failed, so raise
  // them now.
  const unalarmed = await tx
    .select({ event: loneWorkerEvent, session: loneWorkerSession })
    .from(loneWorkerEvent)
    .innerJoin(loneWorkerSession, eq(loneWorkerSession.id, loneWorkerEvent.sessionId))
    .leftJoin(loneWorkerAlarm, eq(loneWorkerAlarm.triggerEventId, loneWorkerEvent.id))
    .where(
      and(
        inArray(loneWorkerEvent.kind, ["help", "duress"]),
        isNull(loneWorkerAlarm.id),
        gt(loneWorkerEvent.receivedAt, new Date(now.getTime() - UNALARMED_LOOKBACK_DAYS * DAY_MS)),
        sql`NOT EXISTS (
          SELECT 1 FROM lone_worker_alarm c
           WHERE c.session_id = ${loneWorkerEvent.sessionId} AND c.reason = ${loneWorkerEvent.kind}
             AND c.raised_at <= ${loneWorkerEvent.receivedAt}
             AND (c.state = 'open' OR c.updated_at >= ${loneWorkerEvent.receivedAt}))`,
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
        )) !== null
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
  // Notifications about alarms no longer open are acknowledged, so a closed alarm is never sent
  // on (a repair for an acknowledgement whose clean-up did not finish; clinical review M7).
  await isolated(tx, tenantId, "notification", null, async (sp) => {
    await sp
      .update(notification)
      .set({ acknowledgedAt: now, escalateAt: null })
      .where(
        and(
          eq(notification.sourceType, "lone_worker_alarm"),
          isNull(notification.acknowledgedAt),
          sql`${notification.sourceId} IN (SELECT id::text FROM lone_worker_alarm WHERE state <> 'open')`,
        ),
      );
    return 0;
  });
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
