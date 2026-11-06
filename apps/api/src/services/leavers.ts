import {
  auditEvent,
  leaverRecord,
  retentionClass,
  staffProfile,
  type Transaction,
  task,
  tenantUser,
} from "@harbour/db";
import {
  accessRemovalDue,
  staffFileReviewDue,
  staffFileReviewOn,
  ukEndOfDay,
  ukIsoDate,
} from "@harbour/domain";
import { and, eq, inArray, isNull, lt, or, sql } from "drizzle-orm";
import { withSystemRights } from "./system-rights";

/**
 * The rota's answer for the leaver sweep (H-873): when the last shift the member is rostered for
 * that starts on a day ends, or null when they have none. Scheduling owns the rota; until its
 * adapter is wired (the rota builder, slice 17's port), `NO_ROTA` answers null, so access ends at
 * the end of the leaving day as before.
 */
export interface RotaPort {
  lastShiftEnding(tx: Transaction, tenantUserId: string, startingOn: string): Promise<Date | null>;
}

export const NO_ROTA: RotaPort = { lastShiftEnding: async () => null };

/** A leaver whose access the sweep ended: whose sign-in sessions the job then ends (H-879). */
export interface EndedLeaver {
  readonly tenantUserId: string;
  readonly authUserId: string | null;
}

/**
 * Rule 22 (workforce.md) and H-873: a leaver's access ends at the later of the end of the leaving
 * day and the end of the last rostered shift that starts on it, so a night worker is never cut off
 * mid-shift. The sweep, in the system's view of one organisation, ends it for every leaver due and
 * not yet ended (`app.end_leaver_access`, once each), audits each by the staff file's id, and adds
 * each one ended to `endedLeavers`. Returns how many it ended.
 */
export async function endLeaversAccess(
  tx: Transaction,
  tenantId: string,
  now: Date,
  rota: RotaPort = NO_ROTA,
  endedLeavers: EndedLeaver[] = [],
): Promise<number> {
  const today = ukIsoDate(now);
  const due = await tx
    .select({
      staffProfileId: leaverRecord.staffProfileId,
      leavingOn: leaverRecord.leavingOn,
      tenantUserId: staffProfile.tenantUserId,
      authUserId: tenantUser.authUserId,
    })
    .from(leaverRecord)
    .innerJoin(
      staffProfile,
      and(
        eq(staffProfile.tenantId, leaverRecord.tenantId),
        eq(staffProfile.id, leaverRecord.staffProfileId),
      ),
    )
    .innerJoin(
      tenantUser,
      and(
        eq(tenantUser.tenantId, staffProfile.tenantId),
        eq(tenantUser.id, staffProfile.tenantUserId),
      ),
    )
    .where(
      and(
        isNull(leaverRecord.accessRemovedAt),
        isNull(leaverRecord.deletedAt),
        lt(leaverRecord.leavingOn, today),
      ),
    );
  let ended = 0;
  for (const leaver of due) {
    const lastShift = await rota.lastShiftEnding(tx, leaver.tenantUserId, leaver.leavingOn);
    if (!accessRemovalDue(leaver.leavingOn, now, lastShift)) continue;
    try {
      // One leaver at a time, in a savepoint: one that cannot be ended (the organisation's last
      // user manager, say) never holds the others back (security review of slice 29, finding 3).
      const done = await tx.transaction(async (sp) => {
        const result = await sp.execute<{ ended: boolean }>(
          sql`SELECT app.end_leaver_access(${leaver.staffProfileId}::uuid) AS ended`,
        );
        if (!result.rows[0]?.ended) return false;
        await sp.insert(auditEvent).values({
          tenantId,
          action: "workforce.leaving.access_ended",
          resourceType: "staff_profile",
          resourceId: leaver.staffProfileId,
          scope: { by: "sweep" },
        });
        return true;
      });
      if (done) {
        ended += 1;
        endedLeavers.push({ tenantUserId: leaver.tenantUserId, authUserId: leaver.authUserId });
      }
    } catch (error) {
      const code =
        (error as { code?: string; cause?: { code?: string } }).code ??
        (error as { cause?: { code?: string } }).cause?.code ??
        "unknown";
      await tx.insert(auditEvent).values({
        tenantId,
        action: "workforce.leaving.access_ended",
        outcome: "denied",
        resourceType: "staff_profile",
        resourceId: leaver.staffProfileId,
        reason: `sweep_${code}`,
        scope: { by: "sweep" },
      });
    }
  }
  return ended;
}

/** H-874: a leaver's staff file has no date of birth, so its keep-until date cannot be set. */
export const LEAVER_BIRTH_DATE_TASK = "workforce.leaver_birth_date";
/** H-874: a leaver's staff file with no keep-until date has reached its review. */
export const STAFF_FILE_REVIEW_TASK = "workforce.staff_file_retention_review";
const HR_ROLE = "hr";
const STAFF_FILE_MANAGE = "workforce.staff_file.manage";

/**
 * H-874: at leaving, a staff file with no date of birth gets a task for HR to record it, so the
 * keep-until date (the 75th birthday) can be worked out. No location and a generic title: who left
 * is told only by the staff file it links to, to holders of the staff file permission.
 */
export async function raiseMissingBirthDateTask(
  tx: Transaction,
  staffProfileId: string,
  leavingOn: string,
): Promise<void> {
  // Written as the system, as every reminder is: the task is HR's, about no person or location,
  // which the member recording the leaving need not be able to see.
  await withSystemRights(tx, () => insertBirthDateTask(tx, staffProfileId, leavingOn));
}

async function insertBirthDateTask(
  tx: Transaction,
  staffProfileId: string,
  leavingOn: string,
): Promise<void> {
  await tx.insert(task).values({
    kind: LEAVER_BIRTH_DATE_TASK,
    title: "Record a leaver's date of birth on their staff file",
    requiredPermission: STAFF_FILE_MANAGE,
    sourceType: "staff_profile",
    sourceId: staffProfileId,
    locationId: null,
    assigneeRoleKey: HR_ROLE,
    dueAt: ukEndOfDay(leavingOn),
    priority: "routine",
    details: { staffProfileId },
  });
}

/**
 * H-874: a leaver's file still with no keep-until date comes up for a person's decision once the
 * after-leaving period has passed (`staff_file.after_leaving`, the organisation's row or the
 * default), never kept indefinitely without review: one task each, raised once.
 */
export async function raiseStaffFileReviews(
  tx: Transaction,
  tenantId: string,
  now: Date,
): Promise<number> {
  const today = ukIsoDate(now);
  const pending = await tx
    .select({ staffProfileId: leaverRecord.staffProfileId, leavingOn: leaverRecord.leavingOn })
    .from(leaverRecord)
    .where(and(isNull(leaverRecord.staffFileRetainUntil), isNull(leaverRecord.deletedAt)));
  if (pending.length === 0) return 0;
  const periods = await tx
    .select()
    .from(retentionClass)
    .where(
      and(
        eq(retentionClass.recordClass, "staff_file.after_leaving"),
        or(isNull(retentionClass.tenantId), eq(retentionClass.tenantId, tenantId)),
      ),
    );
  const row = periods.find((r) => r.tenantId === tenantId) ?? periods.find((r) => !r.tenantId);
  if (!row) return 0;
  const afterLeaving = { period: row.period, unit: row.unit as "years" | "months" };
  const raised = await tx
    .select({ sourceId: task.sourceId })
    .from(task)
    .where(
      and(
        eq(task.kind, STAFF_FILE_REVIEW_TASK),
        inArray(
          task.sourceId,
          pending.map((p) => p.staffProfileId),
        ),
      ),
    );
  const already = new Set(raised.map((r) => r.sourceId));
  let count = 0;
  for (const leaver of pending) {
    if (already.has(leaver.staffProfileId)) continue;
    if (
      !staffFileReviewDue({
        leftOn: leaver.leavingOn,
        retainUntil: null,
        afterLeaving,
        today,
      })
    ) {
      continue;
    }
    await tx.insert(task).values({
      kind: STAFF_FILE_REVIEW_TASK,
      title: "Decide how long to keep a leaver's staff file",
      requiredPermission: STAFF_FILE_MANAGE,
      sourceType: "staff_profile",
      sourceId: leaver.staffProfileId,
      locationId: null,
      assigneeRoleKey: HR_ROLE,
      dueAt: ukEndOfDay(today),
      priority: "routine",
      details: {
        staffProfileId: leaver.staffProfileId,
        reviewOn: staffFileReviewOn(leaver.leavingOn, afterLeaving),
      },
    });
    count += 1;
  }
  return count;
}
