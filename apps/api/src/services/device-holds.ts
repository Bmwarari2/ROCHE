/**
 * What the server does with a device's reports about unsent work and with deletions of it
 * (HZ-006, HZ-040; clinical reviews round 4 H1 and H2 and round 5; security review round 5). Built
 * on the existing task engine and audit trail, with no table of its own.
 *
 * - A device report showing held, unsent or blocked entries raises one task per device for the
 *   Registered Manager, due when the hold escalates (the hold's start plus
 *   `mobile.held_entries_max_days`). The task goes to the location where the reporter works or
 *   last worked (their most recent role assignment, including one just removed); when no location
 *   is known, each Registered Manager in the organisation gets one, assigned to them, so it is
 *   never invisible to the people who must act. Overdue, it escalates only to holders of its
 *   permission at that location (`services/tasks.ts`).
 * - A report's times are never later than the server received it, and a later report never moves
 *   the task's due time later. A report with nothing waiting closes the task only when it comes
 *   from whoever raised it or from someone holding `safety.incident.manage`; recording a deletion
 *   of the device's held entries ("deleted") closes it too. Each reporter may have only a few
 *   devices' tasks open. Every raise, move and close is audited with opaque ids.
 * - An entry uploaded after its own owner's device reported deleting it is flagged, as is an entry
 *   a deletion lists that had already reached the server: an audit event and a review task for the
 *   manager, so care recorded again is not counted twice unseen.
 */
import type { SyncDeviceReport } from "@harbour/contracts";
import {
  activityRecord,
  auditEvent,
  bodyMapMark,
  careNote,
  observation,
  role,
  roleAssignment,
  type Transaction,
  task,
  visitLog,
  withRequestContext,
} from "@harbour/db";
import { can } from "@harbour/domain";
import { and, desc, eq, gt, inArray, isNotNull, isNull, lte, or, sql } from "drizzle-orm";
import { auditInTx } from "../http/audit";
import type { TenantAccess } from "../http/context";
import { rateNumber } from "./rates";

/** Who resolves held entries and is told when a deleted entry arrives: Registered Manager, deputy and nurse. */
export const DISCARD_OTHERS_PERMISSION = "safety.incident.manage" as const;

export const HELD_MAX_DAYS_RATE_KEY = "mobile.held_entries_max_days";
const HELD_FAIL_SAFE_DAYS = 1;
const DAY_MS = 86_400_000;

export const DEVICE_HOLD_TASK_KIND = "sync.device_hold";
export const DEVICE_HOLD_SOURCE = "device_hold";
export const REPORTED_DELETED_TASK_KIND = "sync.entry_reported_deleted";
export const UPLOADED_BEFORE_DELETION_TASK_KIND = "sync.entry_deleted_after_upload";

/**
 * Task kinds that escalate only to holders of their required permission at their location (clinical
 * review round 5, C-H1): the people who can act on them.
 */
export const PERMISSION_ESCALATED_TASK_KINDS: readonly string[] = [
  DEVICE_HOLD_TASK_KIND,
  REPORTED_DELETED_TASK_KIND,
  UPLOADED_BEFORE_DELETION_TASK_KIND,
];

/** Devices whose task one reporter may have open at once (security review round 5, S-M1; HZ-008). */
export const DEVICE_HOLD_TASKS_PER_REPORTER = 3;

/** Entries a deletion lists that had already reached the server, flagged one by one at most. */
export const UPLOADED_BEFORE_DELETION_FLAGS_PER_RECORD = 20;

/** The audit actions of a deletion's stages (clinical review round 4, H1). */
export const DISCARD_ACTIONS = {
  requested: "sync.entries.discard_requested",
  deleted: "sync.entries.discarded",
  failed: "sync.entries.discard_failed",
} as const;

/** The audit actions of a device's task (security review round 5, S-M1). */
export const DEVICE_HOLD_ACTIONS = {
  raised: "sync.device_hold.raised",
  moved: "sync.device_hold.moved",
  closed: "sync.device_hold.closed",
  closeRefused: "sync.device_hold.close_refused",
  capped: "sync.device_hold.capped",
} as const;

type Db = Parameters<typeof withRequestContext>[0];

async function heldMaxDays(tx: Transaction, tenantId: string): Promise<number> {
  const days = await rateNumber(tx, tenantId, HELD_MAX_DAYS_RATE_KEY).catch(() => null);
  return typeof days === "number" && Number.isInteger(days) && days >= 1 && days <= 31
    ? days
    : HELD_FAIL_SAFE_DAYS;
}

/**
 * The report's times as the server takes them: never later than it received the report (security
 * review round 5, S-M1; HZ-010). A device clock running fast can bring a due time earlier, never
 * push it later.
 */
export function clampReportTimes(
  report: SyncDeviceReport,
  receivedAt: Date,
): { readonly reportedAt: Date; readonly heldSince: Date | null; readonly clamped: boolean } {
  const sent = new Date(report.reportedAt);
  const reportedAt = sent.getTime() > receivedAt.getTime() ? receivedAt : sent;
  const held = report.heldSince ? new Date(report.heldSince) : null;
  const heldSince = held && held.getTime() > reportedAt.getTime() ? reportedAt : held;
  return {
    reportedAt,
    heldSince,
    clamped: reportedAt !== sent || (held !== null && heldSince !== held),
  };
}

/** When the device's waiting work began: the hold's start, else the oldest entry's age. */
export function waitingSince(report: SyncDeviceReport, receivedAt: Date): Date {
  const { reportedAt, heldSince } = clampReportTimes(report, receivedAt);
  if (heldSince) return heldSince;
  return report.oldestAgeSeconds === null
    ? reportedAt
    : new Date(reportedAt.getTime() - report.oldestAgeSeconds * 1000);
}

/** Entries the device still has to deal with: held, unsent, and left by a deletion that failed. */
export function waitingCount(report: SyncDeviceReport): number {
  return report.held + report.unsent + report.blocked;
}

/** The system's view of the tenant, acting for the person whose request this is. */
const systemFor = (access: TenantAccess) => ({
  tenantId: access.tenantId,
  userId: access.tenantUserId,
  scope: "tenant" as const,
  locationIds: [] as string[],
});

/**
 * Where the reporter works or last worked: the location of their most recent role assignment that
 * names one, including an assignment just removed (an agency worker's ends with their shift). Null
 * when none names a location.
 */
export async function reporterLocation(
  tx: Transaction,
  tenantUserId: string,
): Promise<string | null> {
  const [latest] = await tx
    .select({ locationId: roleAssignment.locationId })
    .from(roleAssignment)
    .where(
      and(eq(roleAssignment.tenantUserId, tenantUserId), isNotNull(roleAssignment.locationId)),
    )
    .orderBy(
      // A live assignment first, then the most recently changed.
      sql`(${roleAssignment.deletedAt} IS NULL) DESC`,
      desc(sql`coalesce(${roleAssignment.deletedAt}, ${roleAssignment.updatedAt})`),
    )
    .limit(1);
  return latest?.locationId ?? null;
}

/** Live role assignments now: not deleted, started, and not expired. */
const liveAssignment = (now: Date) =>
  and(
    isNull(roleAssignment.deletedAt),
    lte(roleAssignment.validFrom, now),
    or(isNull(roleAssignment.validTo), gt(roleAssignment.validTo, now)),
  );

/** Every Registered Manager in the organisation, by tenant_user id. */
async function registeredManagers(tx: Transaction, now: Date): Promise<string[]> {
  const rows = await tx
    .selectDistinct({ id: roleAssignment.tenantUserId })
    .from(roleAssignment)
    .innerJoin(role, eq(role.id, roleAssignment.roleId))
    .where(and(eq(role.key, "registered_manager"), liveAssignment(now)));
  return rows.map((r) => r.id);
}

/**
 * Who holds `permission` at a location (or anywhere, for a task with no location), through a live
 * role assignment there or across the organisation. Used to escalate the tasks above.
 */
export async function permissionHolders(
  tx: Transaction,
  permission: string,
  locationId: string | null,
  now: Date,
): Promise<string[]> {
  const rows = await tx
    .selectDistinct({ id: roleAssignment.tenantUserId })
    .from(roleAssignment)
    .innerJoin(role, eq(role.id, roleAssignment.roleId))
    .where(
      and(
        sql`${permission} = ANY(${role.permissions})`,
        isNull(role.archivedAt),
        liveAssignment(now),
        locationId
          ? or(isNull(roleAssignment.locationId), eq(roleAssignment.locationId, locationId))
          : undefined,
      ),
    );
  return rows.map((r) => r.id);
}

export type DeviceHoldOutcome =
  | "raised"
  | "moved"
  | "kept"
  | "closed"
  | "close_refused"
  | "capped"
  | "none";

const openDeviceTasks = (deviceId: string) =>
  and(
    eq(task.kind, DEVICE_HOLD_TASK_KIND),
    eq(task.sourceType, DEVICE_HOLD_SOURCE),
    eq(task.sourceId, deviceId),
    inArray(task.status, ["open", "in_progress"]),
    isNull(task.deletedAt),
  );

async function closeTasks(
  tx: Transaction,
  access: TenantAccess,
  rows: ReadonlyArray<{ readonly id: string }>,
  deviceId: string,
  reason: string,
  because: "report" | "deletion",
  now: Date,
  requestId: string | undefined,
): Promise<void> {
  for (const row of rows) {
    await tx
      .update(task)
      .set({
        status: "done",
        statusReason: reason,
        completedAt: now,
        completedBy: access.tenantUserId,
      })
      .where(eq(task.id, row.id));
    await auditInTx(tx, access, {
      action: DEVICE_HOLD_ACTIONS.closed,
      resourceType: "task",
      resourceId: row.id,
      scope: { deviceId, because },
      requestId,
    });
  }
}

/**
 * Raises, moves or closes the device's task (see the module comment). Runs as the system (tenant
 * scope) acting for the reporter, because the person reporting may not see the location's tasks;
 * the task holds no personal data.
 */
export async function recordDeviceHold(
  db: Db,
  access: TenantAccess,
  deviceId: string | null,
  report: SyncDeviceReport,
  receivedAt: Date,
  requestId?: string,
): Promise<DeviceHoldOutcome> {
  if (!deviceId) return "none";
  return withRequestContext(db, systemFor(access), async (tx) => {
    const open = await tx.select().from(task).where(openDeviceTasks(deviceId));

    if (waitingCount(report) === 0) {
      if (open.length === 0) return "none";
      // Only whoever raised the task, or someone who can act on it, closes it with a report.
      const mayClose =
        can(access.effective, DISCARD_OTHERS_PERMISSION) ||
        open.every((t) => t.createdBy === access.tenantUserId);
      if (!mayClose) {
        await auditInTx(tx, access, {
          action: DEVICE_HOLD_ACTIONS.closeRefused,
          outcome: "denied",
          resourceType: "task",
          resourceId: open[0]?.id,
          scope: { deviceId },
          requestId,
        });
        return "close_refused";
      }
      await closeTasks(
        tx,
        access,
        open,
        deviceId,
        "The device reported nothing waiting to upload.",
        "report",
        receivedAt,
        requestId,
      );
      return "closed";
    }

    const dueAt = new Date(
      waitingSince(report, receivedAt).getTime() + (await heldMaxDays(tx, access.tenantId)) * DAY_MS,
    );
    if (open.length > 0) {
      // A report may bring the due time earlier, never later (S-M1).
      let moved = false;
      for (const row of open) {
        if (dueAt.getTime() < row.dueAt.getTime()) {
          await tx.update(task).set({ dueAt }).where(eq(task.id, row.id));
          await auditInTx(tx, access, {
            action: DEVICE_HOLD_ACTIONS.moved,
            resourceType: "task",
            resourceId: row.id,
            scope: { deviceId, dueAt: dueAt.toISOString() },
            requestId,
          });
          moved = true;
        }
      }
      return moved ? "moved" : "kept";
    }

    // A few devices' tasks per reporter at most (S-M1; HZ-008).
    const theirs = await tx
      .selectDistinct({ sourceId: task.sourceId })
      .from(task)
      .where(
        and(
          eq(task.kind, DEVICE_HOLD_TASK_KIND),
          eq(task.createdBy, access.tenantUserId),
          inArray(task.status, ["open", "in_progress"]),
          isNull(task.deletedAt),
        ),
      );
    if (theirs.length >= DEVICE_HOLD_TASKS_PER_REPORTER) {
      await auditInTx(tx, access, {
        action: DEVICE_HOLD_ACTIONS.capped,
        outcome: "denied",
        resourceType: "task",
        scope: { deviceId, open: theirs.length },
        requestId,
      });
      return "capped";
    }

    const locationId = await reporterLocation(tx, access.tenantUserId);
    // No location known: each Registered Manager gets the task, assigned to them, so it is never
    // visible only to tenant-wide roles (C-H1). With no Registered Manager, tenant-wide roles see it.
    const assignees: ReadonlyArray<string | null> = locationId
      ? [null]
      : await registeredManagers(tx, receivedAt).then((ids) => (ids.length > 0 ? ids : [null]));
    for (const assignee of assignees) {
      const [created] = await tx
        .insert(task)
        .values({
          locationId,
          kind: DEVICE_HOLD_TASK_KIND,
          title: "Unsent care entries are waiting on a device",
          requiredPermission: DISCARD_OTHERS_PERMISSION,
          sourceType: DEVICE_HOLD_SOURCE,
          sourceId: deviceId,
          assigneeTenantUserId: assignee,
          assigneeRoleKey: "registered_manager",
          dueAt,
          priority: "routine",
        })
        .returning({ id: task.id });
      await auditInTx(tx, access, {
        action: DEVICE_HOLD_ACTIONS.raised,
        resourceType: "task",
        resourceId: created?.id,
        scope: { deviceId, locationId, assigneeTenantUserId: assignee, dueAt: dueAt.toISOString() },
        requestId,
      });
    }
    return "raised";
  });
}

/**
 * A deletion of the device's held entries, or of its unsent entries at sign-out, was recorded as
 * done: the device's task closes (clinical review round 5, C-M3), because the device's id changes
 * with its next database and would otherwise leave the task open for good.
 */
export async function closeDeviceHoldOnDeletion(
  db: Db,
  access: TenantAccess,
  deviceId: string | null,
  now: Date,
  requestId?: string,
): Promise<number> {
  if (!deviceId) return 0;
  return withRequestContext(db, systemFor(access), async (tx) => {
    const rows = await tx
      .select({ id: task.id, createdBy: task.createdBy })
      .from(task)
      .where(openDeviceTasks(deviceId));
    // As with a report, only a task the sender raised, unless they can act on any (S-M1).
    const manager = can(access.effective, DISCARD_OTHERS_PERMISSION);
    const open = rows.filter((r) => manager || r.createdBy === access.tenantUserId);
    await closeTasks(
      tx,
      access,
      open,
      deviceId,
      "The device's held entries were deleted, with the deletion recorded.",
      "deletion",
      now,
      requestId,
    );
    return open.length;
  });
}

/**
 * True when the uploader's own device reported deleting this entry and did not later report that
 * the deletion failed (security review round 5, S-M2 and L1). Only deletions whose owner is the
 * uploader count, so another member of staff cannot mark someone's entries; the audit trail's
 * resource index narrows the read to the tenant's deletion records.
 */
export async function reportedDeleted(
  tx: Transaction,
  entryId: string,
  uploaderTenantUserId: string,
): Promise<boolean> {
  const rows = await tx
    .select({ action: auditEvent.action, resourceId: auditEvent.resourceId })
    .from(auditEvent)
    .where(
      and(
        eq(auditEvent.resourceType, "device_discard"),
        isNotNull(auditEvent.resourceId),
        sql`${auditEvent.scope} ->> 'ownerTenantUserId' = ${uploaderTenantUserId}`,
        sql`${auditEvent.scope} -> 'entryIds' ? ${entryId}`,
      ),
    );
  const failed = new Set(
    rows.filter((r) => r.action === DISCARD_ACTIONS.failed).map((r) => r.resourceId),
  );
  return rows.some(
    (r) =>
      (r.action === DISCARD_ACTIONS.requested || r.action === DISCARD_ACTIONS.deleted) &&
      !failed.has(r.resourceId),
  );
}

/**
 * Flags an entry uploaded after its owner's device reported deleting it (clinical review round 4,
 * H1): kept, as every upload is, with an audit event and a review task for the manager, because
 * the care may have been recorded again. Call inside the upload's transaction, once the entry is
 * new.
 */
export async function flagIfReportedDeleted(
  tx: Transaction,
  access: TenantAccess,
  entry: {
    readonly resourceType: string;
    readonly id: string;
    readonly personId: string;
    readonly locationId: string | null;
    readonly requestId: string | undefined;
  },
): Promise<boolean> {
  if (!(await reportedDeleted(tx, entry.id, access.tenantUserId))) return false;
  await auditInTx(tx, access, {
    action: "sync.entry.after_discard",
    resourceType: entry.resourceType,
    resourceId: entry.id,
    scope: { reportedDeleted: true },
    requestId: entry.requestId,
  });
  await tx.insert(task).values({
    personId: entry.personId,
    locationId: entry.locationId,
    kind: REPORTED_DELETED_TASK_KIND,
    title: "Check an entry a device reported deleted: it has now been uploaded",
    requiredPermission: DISCARD_OTHERS_PERMISSION,
    sourceType: entry.resourceType,
    sourceId: entry.id,
    assigneeRoleKey: "registered_manager",
    dueAt: new Date(),
    priority: "routine",
  });
  return true;
}

/** The tables a device writes care entries to, with their resource names. */
const CARE_ENTRY_TABLES = [
  { resourceType: "care_note", table: careNote },
  { resourceType: "observation", table: observation },
  { resourceType: "body_map_mark", table: bodyMapMark },
  { resourceType: "activity_record", table: activityRecord },
  { resourceType: "visit_log", table: visitLog },
] as const;

/**
 * Entries a deletion lists that had already reached the server, written by the deletion's owner
 * (clinical review round 5, C-L2): a response lost on the way back leaves the device thinking an
 * entry unsent, so its deletion would mislead. Each is kept and flagged: an audit event, and a
 * review task for the manager (at most a few per deletion record; HZ-008). Runs as the system
 * acting for the sender.
 */
export async function flagEntriesAlreadyUploaded(
  db: Db,
  access: TenantAccess,
  discard: {
    readonly id: string;
    readonly ownerTenantUserId: string | null;
    readonly entryIds: readonly string[];
  },
  requestId?: string,
): Promise<number> {
  if (!discard.ownerTenantUserId || discard.entryIds.length === 0) return 0;
  const owner = discard.ownerTenantUserId;
  return withRequestContext(db, systemFor(access), async (tx) => {
    let flagged = 0;
    for (const { resourceType, table } of CARE_ENTRY_TABLES) {
      const found = await tx
        .select({ id: table.id, personId: table.personId, locationId: table.locationId })
        .from(table)
        .where(and(inArray(table.id, [...discard.entryIds]), eq(table.createdBy, owner)));
      for (const entry of found) {
        await auditInTx(tx, access, {
          action: "sync.entry.before_discard",
          resourceType,
          resourceId: entry.id,
          scope: { discardId: discard.id },
          requestId,
        });
        if (flagged < UPLOADED_BEFORE_DELETION_FLAGS_PER_RECORD) {
          await tx.insert(task).values({
            personId: entry.personId,
            locationId: entry.locationId,
            kind: UPLOADED_BEFORE_DELETION_TASK_KIND,
            title: "Check an entry a device deleted: it had already reached Harbour",
            requiredPermission: DISCARD_OTHERS_PERMISSION,
            sourceType: resourceType,
            sourceId: entry.id,
            assigneeRoleKey: "registered_manager",
            dueAt: new Date(),
            priority: "routine",
          });
        }
        flagged += 1;
      }
    }
    return flagged;
  });
}
