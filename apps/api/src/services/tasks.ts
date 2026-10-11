import type { Recurrence, TaskItem } from "@harbour/contracts";
import {
  accessGrant,
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
  permissionsAtLocation,
  personStatusAllows,
  type RoleAssignmentInput,
  type ScopeKind,
  type TaskStatus,
  taskTimeState,
} from "@harbour/domain";
import { and, eq, inArray, isNull, lt, or, sql } from "drizzle-orm";
import { rateNumber } from "./rates";

/** How far ahead recurring tasks exist as rows, so devices can sync tomorrow's round tonight. */
export const MATERIALISE_AHEAD_HOURS = 48;
/** A worker outage never floods the round with stale tasks: at most this much is backfilled. */
export const MAX_BACKFILL_HOURS = 1;
export const TASK_ESCALATION_RATE_KEY = "task.overdue_escalation_minutes";

type TaskRow = typeof task.$inferSelect;
type SeriesRow = typeof taskSeries.$inferSelect;

const iso = (d: Date | null) => (d ? d.toISOString() : null);

export function toTaskItem(row: TaskRow, now: Date, escalateAfterMinutes: number): TaskItem {
  return {
    id: row.id,
    seriesId: row.seriesId,
    kind: row.kind,
    title: row.title,
    personId: row.personId,
    locationId: row.locationId,
    assigneeTenantUserId: row.assigneeTenantUserId,
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
    escalated: row.escalationLevel > 0,
    details: (row.details ?? null) as TaskItem["details"],
    version: row.version,
  };
}

export async function escalationMinutes(tx: Transaction, tenantId: string): Promise<number> {
  return rateNumber(tx, tenantId, TASK_ESCALATION_RATE_KEY);
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
  const due = occurrences(
    {
      rule: series.recurrence as Recurrence,
      startsOn: series.startsOn,
      endsOn: series.endsOn,
    },
    from,
    to,
  );
  let created = 0;
  for (const dueAt of due) {
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
        windowStart: new Date(dueAt.getTime() - series.windowBeforeMinutes * 60_000),
        windowEnd: new Date(dueAt.getTime() + series.windowAfterMinutes * 60_000),
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

/** Roles told first about an overdue task at a location: the nurse or senior on shift. */
export const OVERDUE_FIRST_RESPONDERS = ["clinical_lead", "team_leader"] as const;

/**
 * Raises one notification per overdue task once it passes the escalation threshold (hazard HZ-008:
 * one escalation, not a stream). Recipients: the assignee, and the clinical leads and team leaders
 * at the task's location; the Registered Manager when nobody holds those roles there.
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
      ),
    )
    .limit(500);
  for (const t of overdue) {
    const recipients = new Set<string>();
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
    let responders = await atLocation(OVERDUE_FIRST_RESPONDERS);
    if (responders.length === 0) responders = await atLocation(["registered_manager"]);
    for (const r of responders) recipients.add(r.id);
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
          dedupeKey: `task_overdue:${t.id}:${recipient}`,
        })
        .onConflictDoNothing();
    }
    await tx.update(task).set({ escalationLevel: 1, escalatedAt: now }).where(eq(task.id, t.id));
  }
  return overdue.length;
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
