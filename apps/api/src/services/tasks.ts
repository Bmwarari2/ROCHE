import type { Recurrence, TaskItem } from "@harbour/contracts";
import {
  accessGrant,
  auditEvent,
  notification,
  person,
  role,
  roleAssignment,
  type Transaction,
  task,
  taskSeries,
} from "@harbour/db";
import {
  type AccessGrantInput,
  isPermission,
  occurrences,
  PLAN_ACTION_TASK_KIND,
  permissionsAtLocation,
  personStatusAllows,
  type RoleAssignmentInput,
  type RoundTime,
  roundTimes,
  type ScopeKind,
  type TaskStatus,
  taskTimeState,
} from "@harbour/domain";
import { and, eq, gt, inArray, isNull, lt, or, sql } from "drizzle-orm";
import {
  fallbackRecipients,
  PERMISSION_ESCALATED_TASK_KINDS,
  permissionHolders,
} from "./device-holds";
import { rateNumber } from "./rates";
import { type StaffLookup, staffNames } from "./staff";

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
        assigneeTenantUserId: series.assigneeTenantUserId,
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
 * Audits an overdue task no one could be told about, at most once a day per task, as the system
 * (no actor): the organisation has no Registered Manager and no holder of the task's permission.
 */
async function recordUnrouted(tx: Transaction, t: TaskRow, now: Date): Promise<void> {
  const since = new Date(now.getTime() - 86_400_000);
  const [recent] = await tx
    .select({ id: auditEvent.id })
    .from(auditEvent)
    .where(
      and(
        eq(auditEvent.resourceType, "task"),
        eq(auditEvent.resourceId, t.id),
        eq(auditEvent.action, ESCALATION_UNROUTED_ACTION),
        gt(auditEvent.occurredAt, since),
      ),
    )
    .limit(1);
  if (recent) return;
  await tx.insert(auditEvent).values({
    tenantId: t.tenantId,
    action: ESCALATION_UNROUTED_ACTION,
    outcome: "error",
    resourceType: "task",
    resourceId: t.id,
    scope: {
      kind: t.kind,
      locationId: t.locationId,
      requiredPermission: t.requiredPermission,
      dueAt: t.dueAt.toISOString(),
    },
  });
}

/** Roles told first about an overdue task at a location: the nurse or senior on shift. */
export const OVERDUE_FIRST_RESPONDERS = ["clinical_lead", "team_leader"] as const;

/**
 * Raises one notification per overdue task once it passes the escalation threshold (hazard HZ-008:
 * one escalation, not a stream). Recipients: the assignee, and the clinical leads and team leaders
 * at the task's location; the Registered Manager when nobody holds those roles there.
 *
 * The sync tasks (a device holding entries, an entry uploaded after or before its deletion) go only
 * to people who can act on them (clinical review round 5, C-H1): the assignee, and the holders of
 * the task's required permission at its location; a task assigned to one Registered Manager with
 * no location goes to that manager alone, and one with neither goes to the holders anywhere. With
 * no one at the location, it is assigned to the longest-serving Registered Manager anywhere (else
 * holder of the permission anywhere), who alone is told; with no one at all it is not marked
 * escalated, and the gap is audited (clinical reviews round 7, M5 and round 8, M1).
 */
export async function escalateOverdueTasks(
  tx: Transaction,
  tenantId: string,
  now: Date,
): Promise<number> {
  const minutes = await escalationMinutes(tx, tenantId);
  const threshold = new Date(now.getTime() - minutes * 60_000);
  const overdue = await tx
    .select()
    .from(task)
    .where(
      and(
        inArray(task.status, ["open", "in_progress"]),
        eq(task.escalationLevel, 0),
        isNull(task.deletedAt),
        lt(sql`coalesce(${task.windowEnd}, ${task.dueAt})`, threshold),
        // A task no one could be told about today waits a day, so it cannot crowd out the batch
        // (security review round 7, L3).
        sql`NOT EXISTS (
          SELECT 1 FROM audit_event a
          WHERE a.tenant_id = ${task.tenantId} AND a.resource_type = 'task'
            AND a.resource_id = ${task.id}::text AND a.action = ${ESCALATION_UNROUTED_ACTION}
            AND a.occurred_at > ${new Date(now.getTime() - 86_400_000)})`,
      ),
    )
    .orderBy(sql`coalesce(${task.windowEnd}, ${task.dueAt})`)
    .limit(500);
  let escalated = 0;
  for (const t of overdue) {
    const recipients = new Set<string>();
    let assignTo: string | null = null;
    if (t.assigneeTenantUserId) recipients.add(t.assigneeTenantUserId);
    const atLocation = (keys: readonly string[]) =>
      tx
        .selectDistinct({ id: roleAssignment.tenantUserId })
        .from(roleAssignment)
        .innerJoin(role, eq(role.id, roleAssignment.roleId))
        .where(
          and(
            inArray(role.key, [...keys]),
            isNull(roleAssignment.deletedAt),
            t.locationId
              ? or(isNull(roleAssignment.locationId), eq(roleAssignment.locationId, t.locationId))
              : undefined,
          ),
        );
    if (PERMISSION_ESCALATED_TASK_KINDS.includes(t.kind)) {
      if (t.locationId || !t.assigneeTenantUserId) {
        const holders = await permissionHolders(tx, t.requiredPermission, t.locationId, now);
        for (const id of holders) recipients.add(id);
      }
      // Nobody can act at the location (a vacant post): the task is assigned to the longest-serving
      // Registered Manager anywhere in the organisation (else holder of the permission anywhere),
      // who is told and, as its assignee, can see and complete it (clinical reviews round 7 M5
      // and round 8 M1).
      if (recipients.size === 0) {
        const [fallback] = await fallbackRecipients(tx, t.requiredPermission, now);
        if (!fallback) {
          // Never marked escalated with no one told: it stays due, and the gap is audited daily.
          await recordUnrouted(tx, t, now);
          continue;
        }
        recipients.add(fallback);
        assignTo = fallback;
      }
    } else {
      let responders = await atLocation(OVERDUE_FIRST_RESPONDERS);
      if (responders.length === 0) responders = await atLocation(["registered_manager"]);
      for (const r of responders) recipients.add(r.id);
    }
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
  return escalated;
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
    PERMISSION_ESCALATED_TASK_KINDS.includes(row.kind)
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
  const assignments = await tx
    .select({
      roleKey: role.key,
      scopeKind: role.scopeKind,
      permissions: role.permissions,
      locationId: roleAssignment.locationId,
      validFrom: roleAssignment.validFrom,
      validTo: roleAssignment.validTo,
    })
    .from(roleAssignment)
    .innerJoin(role, eq(role.id, roleAssignment.roleId))
    .where(
      and(
        eq(roleAssignment.tenantUserId, tenantUserId),
        isNull(roleAssignment.deletedAt),
        isNull(role.archivedAt),
      ),
    );
  const grants = await tx
    .select({
      permissions: accessGrant.permissions,
      locationId: accessGrant.locationId,
      validFrom: accessGrant.validFrom,
      validTo: accessGrant.validTo,
      revokedAt: accessGrant.revokedAt,
    })
    .from(accessGrant)
    .where(and(eq(accessGrant.tenantUserId, tenantUserId), isNull(accessGrant.deletedAt)));
  return permissionsAtLocation(
    assignments.map((a): RoleAssignmentInput => ({ ...a, scopeKind: a.scopeKind as ScopeKind })),
    grants as AccessGrantInput[],
    row.locationId,
    now,
  ).has(row.requiredPermission);
}
