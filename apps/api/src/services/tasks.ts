import type { Recurrence, TaskItem } from "@harbour/contracts";
import { auditEvent, notification, person, type Transaction, task, taskSeries } from "@harbour/db";
import {
  isPermission,
  occurrences,
  PLAN_ACTION_TASK_KIND,
  permissionsAtLocation,
  personStatusAllows,
  type RoundTime,
  roundTimes,
  type TaskStatus,
  taskTimeState,
} from "@harbour/domain";
import { and, eq, gt, inArray, isNull, lt, sql } from "drizzle-orm";
import { accessRowsOfMember } from "./access-rows";
import {
  COVER_TASK_KIND,
  fallbackRecipients,
  PERMISSION_ESCALATED_TASK_KINDS,
  permissionHolders,
} from "./device-holds";
import { rateNumber } from "./rates";
import { roleHolders, toldOf } from "./role-holders";
import { type StaffLookup, staffNames } from "./staff";
import { membersSeeingPerson, RECORD_READ_PERMISSION } from "./staff-views";

/** How far ahead recurring tasks exist as rows, so devices can sync tomorrow's round tonight. */
export const MATERIALISE_AHEAD_HOURS = 48;
/** A worker outage never floods the round with stale tasks: at most this much is backfilled. */
export const MAX_BACKFILL_HOURS = 1;
export const TASK_ESCALATION_RATE_KEY = "task.overdue_escalation_minutes";

type TaskRow = typeof task.$inferSelect;
type SeriesRow = typeof taskSeries.$inferSelect;

const iso = (d: Date | null) => (d ? d.toISOString() : null);

/** The names of the staff the tasks name (assignee, completed by), for `toTaskItem`. */
export function taskStaff(
  tx: Transaction,
  rows: readonly Pick<TaskRow, "assigneeTenantUserId" | "completedBy">[],
): Promise<StaffLookup> {
  return staffNames(
    tx,
    rows.flatMap((r) => [r.assigneeTenantUserId, r.completedBy]),
  );
}

export function toTaskItem(
  row: TaskRow,
  now: Date,
  escalateAfterMinutes: number,
  staff: StaffLookup,
): TaskItem {
  return {
    id: row.id,
    seriesId: row.seriesId,
    kind: row.kind,
    title: row.title,
    personId: row.personId,
    locationId: row.locationId,
    assigneeTenantUserId: row.assigneeTenantUserId,
    assigneeStaff: staff(row.assigneeTenantUserId),
    dueAt: row.dueAt.toISOString(),
    windowStart: iso(row.windowStart),
    windowEnd: iso(row.windowEnd),
    priority: row.priority === "urgent" ? "urgent" : "routine",
    status: row.status as TaskStatus,
    statusReason: row.statusReason,
    timeState: taskTimeState(
      {
        status: row.status as TaskStatus,
        dueAt: row.dueAt,
        windowStart: row.windowStart,
        windowEnd: row.windowEnd,
      },
      now,
      escalateAfterMinutes,
    ),
    evidenceRequired: row.evidenceRequired,
    evidenceType: row.evidenceType,
    evidenceId: row.evidenceId,
    evidenceAfterClose: row.evidenceAfterClose,
    catchUp: row.restoreCode === "caught_up",
    restoredDone: row.restoreCode === "answered_while_stopped",
    completedAt: iso(row.completedAt),
    completedBy: row.completedBy,
    completedByStaff: staff(row.completedBy),
    escalated: row.escalationLevel > 0,
    details: (row.details ?? null) as TaskItem["details"],
    version: row.version,
  };
}

export async function escalationMinutes(tx: Transaction, tenantId: string): Promise<number> {
  return rateNumber(tx, tenantId, TASK_ESCALATION_RATE_KEY);
}

/**
 * The rounds of a series in [from, to), each with its window. A care plan round's window comes from
 * the real instants of its neighbours (`roundTimes`, care.md rule 14; HZ-004), the series holding
 * the tenant's figures as the most either side; every other series keeps its fixed window.
 */
export function seriesRoundTimes(series: SeriesRow, from: Date, to: Date): RoundTime[] {
  const rule = {
    rule: series.recurrence as Recurrence,
    startsOn: series.startsOn,
    endsOn: series.endsOn,
  };
  if (series.kind === PLAN_ACTION_TASK_KIND) {
    return roundTimes(rule, from, to, {
      beforeMinutes: series.windowBeforeMinutes,
      afterMinutes: series.windowAfterMinutes,
    });
  }
  return occurrences(rule, from, to).map((dueAt) => ({
    dueAt,
    windowStart: new Date(dueAt.getTime() - series.windowBeforeMinutes * 60_000),
    windowEnd: new Date(dueAt.getTime() + series.windowAfterMinutes * 60_000),
  }));
}

/**
 * Creates the tasks of a series that fall due before `now + MATERIALISE_AHEAD_HOURS`. Idempotent:
 * the unique (series, due time) index drops duplicates, so the worker and the API may both run it.
 */
export async function materialiseSeries(
  tx: Transaction,
  series: SeriesRow,
  now: Date,
): Promise<number> {
  if (!series.active) return 0;
  if (series.personId) {
    // A person in hospital, on leave or no longer receiving care is off rounds (people.md rule
    // 1): nothing is materialised, and the series picks up again from now when they return.
    const [who] = await tx
      .select({ status: person.status })
      .from(person)
      .where(eq(person.id, series.personId));
    if (!who || !personStatusAllows(who.status, "point_of_care_rounds")) return 0;
  }
  const earliest = new Date(now.getTime() - MAX_BACKFILL_HOURS * 3_600_000);
  const from =
    series.materialisedUntil && series.materialisedUntil.getTime() > earliest.getTime()
      ? series.materialisedUntil
      : series.materialisedUntil
        ? earliest
        : now;
  const to = new Date(now.getTime() + MATERIALISE_AHEAD_HOURS * 3_600_000);
  if (from.getTime() >= to.getTime()) return 0;
  // A new round goes to the series' assignee only while they could still be given it (their role
  // or grant in force, and for a round about a person, able to see the person); otherwise it is
  // left for its role to pick up (ADR-0071 review round 2).
  const assignee =
    series.assigneeTenantUserId !== null &&
    (anyoneMayBeGiven(series) || (await mayBeGiven(tx, series.assigneeTenantUserId, series, now)))
      ? series.assigneeTenantUserId
      : null;
  let created = 0;
  for (const { dueAt, windowStart, windowEnd } of seriesRoundTimes(series, from, to)) {
    const inserted = await tx
      .insert(task)
      .values({
        seriesId: series.id,
        locationId: series.locationId,
        personId: series.personId,
        kind: series.kind,
        title: series.title,
        requiredPermission: series.requiredPermission,
        sourceType: series.sourceType,
        sourceId: series.sourceId,
        assigneeTenantUserId: assignee,
        assigneeRoleKey: series.assigneeRoleKey,
        dueAt,
        windowStart,
        windowEnd,
        priority: series.priority,
        evidenceRequired: series.evidenceRequired,
      })
      .onConflictDoNothing()
      .returning({ id: task.id });
    created += inserted.length;
  }
  await tx.update(taskSeries).set({ materialisedUntil: to }).where(eq(taskSeries.id, series.id));
  return created;
}

/** An overdue sync task that no one could be told about (clinical review round 7, M5). */
export const ESCALATION_UNROUTED_ACTION = "sync.escalation_unrouted";

/**
 * Any other overdue task that could not be escalated (ADR-0071 review rounds 3 and 4, C3-M3 and
 * C4-M1), with a coded reason (`UnroutedReason`).
 */
export const TASK_ESCALATION_UNROUTED_ACTION = "task.escalation_unrouted";

const DAY_MS = 86_400_000;

/**
 * Why an overdue task was not escalated (ADR-0071 review rounds 3 and 4): no one other than its
 * assignee could be told (`assignee_only`, who is still told), or no one at all, about a person
 * (`no_one_sees_person`) or about no one (`no_one_reaches_location`).
 */
export type UnroutedReason = "assignee_only" | "no_one_sees_person" | "no_one_reaches_location";

/**
 * Audits an overdue task that could not be escalated, as the system (no actor): on the first
 * occurrence, then at most once a day per task and reason while it stays so (review rounds 4 and
 * 5), so the audit does not grow with each hourly retry, and a changed reason is recorded. For a sync task, the organisation has no Registered
 * Manager and no holder of the task's permission; for any other, no first responder, Registered
 * Manager or holder of care.plan.write other than its assignee can see it. It is never marked
 * escalated, so a later run tries again.
 */
async function recordUnrouted(
  tx: Transaction,
  t: TaskRow,
  now: Date,
  action: string = ESCALATION_UNROUTED_ACTION,
  reason: UnroutedReason | null = null,
): Promise<void> {
  const since = new Date(now.getTime() - DAY_MS);
  const [recent] = await tx
    .select({ id: auditEvent.id })
    .from(auditEvent)
    .where(
      and(
        eq(auditEvent.resourceType, "task"),
        eq(auditEvent.resourceId, t.id),
        eq(auditEvent.action, action),
        reason ? eq(auditEvent.reason, reason) : isNull(auditEvent.reason),
        gt(auditEvent.occurredAt, since),
      ),
    )
    .limit(1);
  if (recent) return;
  await tx.insert(auditEvent).values({
    tenantId: t.tenantId,
    action,
    outcome: "error",
    resourceType: "task",
    resourceId: t.id,
    ...(reason ? { reason } : {}),
    scope: {
      kind: t.kind,
      locationId: t.locationId,
      requiredPermission: t.requiredPermission,
      dueAt: t.dueAt.toISOString(),
      ...(reason ? { reasonCode: reason } : {}),
    },
  });
}

/** The permission of those told last about an overdue task: they can act on the care plan. */
const PLAN_WRITE_PERMISSION = "care.plan.write";

/**
 * Roles told first about an overdue task at a location: the clinical leads and team leaders whose
 * roles reach it, at every home; no rota is checked.
 */
export const OVERDUE_FIRST_RESPONDERS = ["clinical_lead", "team_leader"] as const;

/**
 * Which overdue tasks a run takes (review round 4): `due`, those not audited as unrouted in the
 * last day (every minute, so a batch is never crowded by tasks no one can be told about; security
 * review round 7, L3); `retry`, the tasks other than sync tasks audited as unrouted in the last
 * day (hourly, every one of them, oldest first, in pages; review round 5), so someone who has
 * just started is told within the hour while the audit is written at most once a day.
 */
export type EscalationRun = "due" | "retry";

/** Overdue tasks read at a time (a page; tests pass a smaller one). */
const ESCALATION_PAGE = 500;

/** Tells each recipient once that a task is overdue (the key carries the task, and for a sync task its version). */
async function notifyOverdue(
  tx: Transaction,
  t: TaskRow,
  recipients: ReadonlySet<string>,
): Promise<void> {
  // A device's task whose escalation was reset (a new hold after a refused close, or a reopen, at
  // most once a day; clinical reviews rounds 6 and 7) signals again: its key carries its version.
  const occurrence = PERMISSION_ESCALATED_TASK_KINDS.includes(t.kind) ? `:v${t.version}` : "";
  for (const recipient of recipients) {
    await tx
      .insert(notification)
      .values({
        recipientTenantUserId: recipient,
        kind: "platform.task.overdue",
        severity: t.priority === "urgent" ? "urgent" : "warning",
        title: "A task is overdue",
        body: "Open the task list to see what is late.",
        link: t.personId ? `/people/${t.personId}` : "/tasks",
        channels: t.priority === "urgent" ? ["in_app", "push"] : ["in_app"],
        sourceType: "task",
        sourceId: t.id,
        personId: t.personId,
        locationId: t.locationId,
        dedupeKey: `task_overdue:${t.id}${occurrence}:${recipient}`,
      })
      .onConflictDoNothing();
  }
}

/**
 * Raises one notification per overdue task once it passes the escalation threshold (hazard HZ-008:
 * one escalation, not a stream). Recipients: the assignee (while active), and the first of these
 * with anyone other than the assignee (ADR-0071 review rounds 3 and 4, C3-M3 and C4-M1): the
 * clinical leads and team leaders whose roles reach the task's location; a Registered Manager
 * whose role reaches it (there, or across the organisation); the holders of care.plan.write. For
 * a task about a person, each tier keeps only those who can see the person, and a task with no
 * location takes the person's. Everyone told is active (`TOLD`). Escalation means someone other
 * than the assignee is told: with no one else, the assignee is still told, but the task is not
 * marked escalated, the gap is audited (`task.escalation_unrouted`, `assignee_only`,
 * `no_one_sees_person` or `no_one_reaches_location`, at most once a day) and the hourly `retry`
 * run tries again.
 *
 * The sync tasks (a device holding entries, an entry uploaded after or before its deletion) go only
 * to people who can act on them (clinical review round 5, C-H1): the assignee, and the holders of
 * the task's required permission at its location; a task assigned to one Registered Manager with
 * no location goes to that manager and the holders across the organisation, and one with neither
 * goes to the holders anywhere. The assignee is never counted as told (review round 5): with no
 * one but an active assignee, they are told, the task is not marked escalated, and the gap is
 * audited (`sync.escalation_unrouted`, `assignee_only`). With no one at the location and no
 * assignee, it is assigned to the longest-serving Registered Manager anywhere (else holder of the
 * permission anywhere), who alone is told; with no one at all it is not marked escalated, and the
 * gap is audited (clinical reviews round 7, M5 and round 8, M1).
 */
export async function escalateOverdueTasks(
  tx: Transaction,
  tenantId: string,
  now: Date,
  run: EscalationRun = "due",
  pageSize: number = ESCALATION_PAGE,
): Promise<number> {
  const minutes = await escalationMinutes(tx, tenantId);
  const threshold = new Date(now.getTime() - minutes * 60_000);
  const dayAgo = new Date(now.getTime() - DAY_MS);
  const auditedUnrouted = (action: string) => sql`EXISTS (
          SELECT 1 FROM audit_event a
          WHERE a.tenant_id = ${task.tenantId} AND a.resource_type = 'task'
            AND a.resource_id = ${task.id}::text AND a.action = ${action}
            AND a.occurred_at > ${dayAgo})`;
  const lateAt = sql`coalesce(${task.windowEnd}, ${task.dueAt})`;
  const page = (after: TaskRow | null) =>
    tx
      .select()
      .from(task)
      .where(
        and(
          inArray(task.status, ["open", "in_progress"]),
          eq(task.escalationLevel, 0),
          isNull(task.deletedAt),
          lt(lateAt, threshold),
          run === "due"
            ? // A task no one could be told about waits for the hourly retry (any other task) or a
              // day (a sync task), so it cannot crowd out the batch (security review round 7, L3).
              sql`NOT ${auditedUnrouted(ESCALATION_UNROUTED_ACTION)}
                AND NOT ${auditedUnrouted(TASK_ESCALATION_UNROUTED_ACTION)}`
            : and(
                auditedUnrouted(TASK_ESCALATION_UNROUTED_ACTION),
                sql`NOT ${auditedUnrouted(ESCALATION_UNROUTED_ACTION)}`,
              ),
          after
            ? sql`(${lateAt}, ${task.id}) > (${after.windowEnd ?? after.dueAt}::timestamptz, ${after.id}::uuid)`
            : undefined,
        ),
      )
      .orderBy(lateAt, task.id)
      .limit(pageSize);
  let escalated = 0;
  // The minute run takes one page: what it cannot route drops out of the next run's. The hourly
  // retry takes every page, oldest first, so each unrouted task is retried every hour, however
  // many there are (ADR-0071 review round 5).
  for (let overdue = await page(null); overdue.length > 0; ) {
    for (const t of overdue) {
      const recipients = new Set<string>();
      let assignTo: string | null = null;
      // The assignee is told only while active (review round 3, C3-M3).
      const assignee =
        t.assigneeTenantUserId && (await toldOf(tx, [t.assigneeTenantUserId])).size > 0
          ? t.assigneeTenantUserId
          : null;
      if (assignee) recipients.add(assignee);
      if (PERMISSION_ESCALATED_TASK_KINDS.includes(t.kind)) {
        // The task's own assignee is never counted as told about its escalation (ADR-0071 review
        // round 5): the holders of its permission other than the assignee are told.
        const holders = (
          await permissionHolders(tx, t.requiredPermission, t.locationId, now, t.personId)
        ).filter((id) => id !== t.assigneeTenantUserId);
        for (const id of holders) recipients.add(id);
        if (holders.length === 0 && assignee) {
          // Only its active assignee can act on it: they are still told, but the task is not marked
          // escalated, and the gap is audited (`assignee_only`, as for any other task, C4-M1). It is
          // not moved to someone else, who would already hold their own task for the device.
          await notifyOverdue(tx, t, recipients);
          await recordUnrouted(tx, t, now, ESCALATION_UNROUTED_ACTION, "assignee_only");
          continue;
        }
        // Nobody can act at the location (a vacant post): the task is assigned to the longest-serving
        // Registered Manager anywhere in the organisation (else holder of the permission anywhere),
        // who is told and, as its assignee, can see and complete it (clinical reviews round 7 M5
        // and round 8 M1). For a task about a person, the first of them who can open the person:
        // being its assignee does not show a person task (ADR-0071 review round 1, C-M4).
        if (holders.length === 0) {
          const [fallback] = (
            await fallbackRecipients(tx, t.requiredPermission, now, t.personId, t.locationId)
          ).filter((id) => id !== t.assigneeTenantUserId);
          if (!fallback) {
            // Never marked escalated with no one told: it stays due, and the gap is audited daily.
            await recordUnrouted(tx, t, now);
            continue;
          }
          recipients.add(fallback);
          assignTo = fallback;
        }
      } else {
        // Down the order until someone other than the assignee is told (review rounds 3 and 4). A
        // task about a person with no location takes the person's, and each tier keeps only those
        // who can see the person.
        const placeId = t.locationId ?? (t.personId ? await personLocation(tx, t.personId) : null);
        const others = (ids: readonly string[]) =>
          ids.filter((id) => id !== t.assigneeTenantUserId);
        const seeing = async (ids: string[]) =>
          t.personId === null
            ? ids
            : membersSeeingPerson(tx, ids, t.personId, RECORD_READ_PERMISSION, now);
        const tier = async (keys: readonly string[]) =>
          others(await seeing(await roleHolders(tx, keys, placeId ? [placeId] : null, now)));
        let responders = await tier(OVERDUE_FIRST_RESPONDERS);
        if (responders.length === 0) responders = await tier(["registered_manager"]);
        if (responders.length === 0) {
          responders = others(
            await permissionHolders(tx, PLAN_WRITE_PERMISSION, placeId, now, t.personId),
          );
        }
        if (responders.length === 0) {
          // Escalation means someone other than the assignee is told (C4-M1): the assignee is still
          // told, but the task is not marked escalated, and the gap is audited.
          await notifyOverdue(tx, t, recipients);
          await recordUnrouted(
            tx,
            t,
            now,
            TASK_ESCALATION_UNROUTED_ACTION,
            assignee
              ? "assignee_only"
              : t.personId
                ? "no_one_sees_person"
                : "no_one_reaches_location",
          );
          continue;
        }
        for (const r of responders) recipients.add(r);
      }
      await notifyOverdue(tx, t, recipients);
      await tx
        .update(task)
        .set({
          escalationLevel: 1,
          escalatedAt: now,
          ...(assignTo ? { assigneeTenantUserId: assignTo } : {}),
        })
        .where(eq(task.id, t.id));
      escalated += 1;
    }
    const last = overdue.at(-1);
    overdue = run === "retry" && last && overdue.length === pageSize ? await page(last) : [];
  }
  return escalated;
}

/** Where a person lives, or null when they cannot be read. */
async function personLocation(tx: Transaction, personId: string): Promise<string | null> {
  const [row] = await tx
    .select({ locationId: person.locationId })
    .from(person)
    .where(eq(person.id, personId));
  return row?.locationId ?? null;
}

/**
 * The permission a general task names (a manual task about no person): it is allocated to anyone,
 * so its assignee completes it without holding anything more.
 */
export const GENERAL_TASK_PERMISSION = "platform.task.manage";

/**
 * Task kinds given to an owner who deliberately does not hold the permission they name: an
 * investigation action is done by whoever the investigation names (safety.incident.manage only
 * lets others close it). The Care mode sync tasks (`PERMISSION_ESCALATED_TASK_KINDS`) are the
 * other case: with no one at their location who can act, the escalation gives one to the
 * longest-serving Registered Manager elsewhere, who completes it as its assignee although they
 * hold its permission nowhere there (H-142). Nobody else can be given one without the permission
 * (the assign route checks it).
 */
export const OWNER_TASK_KINDS: readonly string[] = ["safety.investigation_action"];

/** Whether a task's assignee completes it whatever they hold (a general task or an owner's). */
export function anyoneMayBeGiven(row: {
  readonly kind: string;
  readonly requiredPermission: string;
}): boolean {
  return (
    row.requiredPermission === GENERAL_TASK_PERMISSION ||
    OWNER_TASK_KINDS.includes(row.kind) ||
    // A cover task routes like the sync tasks but is never given past its permission: only a
    // rota manager at its home acts on it (security review of the cover task, finding 1).
    (PERMISSION_ESCALATED_TASK_KINDS.includes(row.kind) && row.kind !== COVER_TASK_KIND)
  );
}

/**
 * Whether being a task's assignee still lets this member of staff complete it, now (S1 follow-on;
 * HZ-004, HZ-005): only while they could still be given it (`mayBeAssigned`), so an acting-up
 * grant that has expired or been revoked, or a role that has ended, no longer lets them mark an
 * urgent task done or skipped, or complete it with an entry, and silence its escalation. General
 * tasks, an owner's investigation actions and the sync tasks the escalation gives to a manager
 * elsewhere (H-142) are exempt (`anyoneMayBeGiven`).
 */
export async function assigneeMayComplete(
  tx: Transaction,
  tenantUserId: string,
  row: {
    readonly kind: string;
    readonly assigneeTenantUserId: string | null;
    readonly requiredPermission: string;
    readonly locationId: string | null;
  },
  now: Date,
): Promise<boolean> {
  if (row.assigneeTenantUserId !== tenantUserId) return false;
  if (anyoneMayBeGiven(row)) return true;
  return mayBeAssigned(tx, tenantUserId, row, now);
}

/**
 * Whether a member of staff may complete a task at its location: they hold its required
 * permission there (a role assigned there or tenant-wide, or a grant). Being a task's assignee lets
 * them complete it, so a task is only ever given to someone who could complete it anyway (S1;
 * HZ-004, HZ-005). Fails closed: rows the caller cannot read count as nothing held.
 */
export async function mayBeAssigned(
  tx: Transaction,
  tenantUserId: string,
  row: { readonly requiredPermission: string; readonly locationId: string | null },
  now: Date,
): Promise<boolean> {
  if (!isPermission(row.requiredPermission)) return false;
  const rows = await accessRowsOfMember(tx, tenantUserId);
  return permissionsAtLocation(rows.assignments, rows.grants, row.locationId, now).has(
    row.requiredPermission,
  );
}

/**
 * Whether a task may be given to a member of staff now: they may complete it at its location
 * (`mayBeAssigned`), and, for a task about a person, both `people.person.read` and its
 * permission reach that person under their own scope (`membersSeeingPerson`; ADR-0071 review
 * round 1, C-M4). Row-level security shows a task about a person only to those who can see the
 * person, assignee or not, so a task given to anyone else would sit where no one can see it.
 */
export async function mayBeGiven(
  tx: Transaction,
  tenantUserId: string,
  row: {
    readonly requiredPermission: string;
    readonly locationId: string | null;
    readonly personId: string | null;
  },
  now: Date,
): Promise<boolean> {
  if (!(await mayBeAssigned(tx, tenantUserId, row, now))) return false;
  if (row.personId === null || !isPermission(row.requiredPermission)) return true;
  const seeing = await membersSeeingPerson(
    tx,
    [tenantUserId],
    row.personId,
    row.requiredPermission,
    now,
  );
  return seeing.length === 1;
}
