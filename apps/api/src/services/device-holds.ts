/**
 * What the server does with a device's reports about unsent work and with deletions of it
 * (HZ-006, HZ-040; clinical review round 4, H1 and H2). Built on the existing task engine and
 * audit trail, with no table of its own.
 *
 * - A device report showing held or unsent entries raises one task per device for the Registered
 *   Manager, due when the hold escalates (the hold's start plus `mobile.held_entries_max_days`).
 *   The task engine's overdue escalation then tells the nurse in charge and the Registered Manager
 *   at the location. A later report with nothing waiting closes it.
 * - An entry uploaded after a device reported its deletion is flagged: an audit event and a review
 *   task for the manager, so care recorded again by someone else is not counted twice unseen.
 */
import type { SyncDeviceReport } from "@harbour/contracts";
import {
  auditEvent,
  roleAssignment,
  type Transaction,
  task,
  withRequestContext,
} from "@harbour/db";
import { and, eq, inArray, isNotNull, isNull, sql } from "drizzle-orm";
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

/** The audit actions of a deletion's stages (clinical review round 4, H1). */
export const DISCARD_ACTIONS = {
  requested: "sync.entries.discard_requested",
  deleted: "sync.entries.discarded",
  failed: "sync.entries.discard_failed",
} as const;

async function heldMaxDays(tx: Transaction, tenantId: string): Promise<number> {
  const days = await rateNumber(tx, tenantId, HELD_MAX_DAYS_RATE_KEY).catch(() => null);
  return typeof days === "number" && Number.isInteger(days) && days >= 1 && days <= 31
    ? days
    : HELD_FAIL_SAFE_DAYS;
}

/** When the device's waiting work began: the hold's start, else the oldest entry's age. */
export function waitingSince(report: SyncDeviceReport): Date {
  if (report.heldSince) return new Date(report.heldSince);
  const reportedAt = new Date(report.reportedAt);
  return report.oldestAgeSeconds === null
    ? reportedAt
    : new Date(reportedAt.getTime() - report.oldestAgeSeconds * 1000);
}

/**
 * Raises, moves or closes the device's task. Runs as the system (tenant scope), because the person
 * reporting may not see the location's tasks; the task holds no personal data.
 */
export async function recordDeviceHold(
  db: Parameters<typeof withRequestContext>[0],
  access: TenantAccess,
  deviceId: string | null,
  report: SyncDeviceReport,
  now: Date,
): Promise<"raised" | "moved" | "closed" | "none"> {
  if (!deviceId) return "none";
  return withRequestContext(
    db,
    { tenantId: access.tenantId, userId: null, scope: "tenant", locationIds: [] },
    async (tx) => {
      const open = await tx
        .select()
        .from(task)
        .where(
          and(
            eq(task.kind, DEVICE_HOLD_TASK_KIND),
            eq(task.sourceType, DEVICE_HOLD_SOURCE),
            eq(task.sourceId, deviceId),
            inArray(task.status, ["open", "in_progress"]),
            isNull(task.deletedAt),
          ),
        );
      const waiting = report.held + report.unsent;
      if (waiting === 0) {
        for (const row of open) {
          await tx
            .update(task)
            .set({
              status: "done",
              statusReason: "The device reported nothing waiting to upload.",
              completedAt: now,
            })
            .where(eq(task.id, row.id));
        }
        return open.length > 0 ? "closed" : "none";
      }
      const dueAt = new Date(
        waitingSince(report).getTime() + (await heldMaxDays(tx, access.tenantId)) * DAY_MS,
      );
      const [current] = open;
      if (current) {
        if (current.dueAt.getTime() !== dueAt.getTime()) {
          await tx.update(task).set({ dueAt }).where(eq(task.id, current.id));
        }
        return "moved";
      }
      // The reporter's location when they work at one only; otherwise the whole tenant.
      const places = await tx
        .selectDistinct({ locationId: roleAssignment.locationId })
        .from(roleAssignment)
        .where(
          and(
            eq(roleAssignment.tenantUserId, access.tenantUserId),
            isNull(roleAssignment.deletedAt),
          ),
        );
      const locationId = places.length === 1 && places[0]?.locationId ? places[0].locationId : null;
      await tx.insert(task).values({
        locationId,
        kind: DEVICE_HOLD_TASK_KIND,
        title: "Unsent care entries are waiting on a device",
        requiredPermission: DISCARD_OTHERS_PERMISSION,
        sourceType: DEVICE_HOLD_SOURCE,
        sourceId: deviceId,
        assigneeRoleKey: "registered_manager",
        dueAt,
        priority: "routine",
      });
      return "raised";
    },
  );
}

/**
 * True when a device reported deleting this entry and did not later report that the deletion
 * failed. The deletion records keep their entry ids in the audit scope, so this reads the tenant's
 * deletion records (the audit trail's resource index narrows it to them).
 */
export async function reportedDeleted(tx: Transaction, entryId: string): Promise<boolean> {
  const rows = await tx
    .select({ action: auditEvent.action, resourceId: auditEvent.resourceId })
    .from(auditEvent)
    .where(
      and(
        eq(auditEvent.resourceType, "device_discard"),
        isNotNull(auditEvent.resourceId),
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
 * Flags an entry uploaded after its deletion was reported (clinical review round 4, H1): kept, as
 * every upload is, with an audit event and a review task for the manager, because the care may
 * have been recorded again. Call inside the upload's transaction, once the entry is new.
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
  if (!(await reportedDeleted(tx, entry.id))) return false;
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
