import { auditEvent, leaverRecord, staffProfile, type Transaction, tenantUser } from "@harbour/db";
import { accessRemovalDue, ukIsoDate } from "@harbour/domain";
import { and, eq, isNotNull, isNull, lt, ne, sql } from "drizzle-orm";

/**
 * Rule 22 (workforce.md): a leaver's access ends at the end of the leaving day. The sweep, in the
 * system's view of one organisation, ends it for every leaver whose leaving date has passed and
 * whose access has not ended yet (`app.end_leaver_access`, once each), and audits each by the
 * staff file's id. Returns how many it ended.
 */
export async function endLeaversAccess(
  tx: Transaction,
  tenantId: string,
  now: Date,
): Promise<number> {
  const today = ukIsoDate(now);
  const due = await tx
    .select({ staffProfileId: leaverRecord.staffProfileId, leavingOn: leaverRecord.leavingOn })
    .from(leaverRecord)
    .where(
      and(
        isNull(leaverRecord.accessRemovedAt),
        isNull(leaverRecord.deletedAt),
        lt(leaverRecord.leavingOn, today),
      ),
    );
  let ended = 0;
  for (const leaver of due) {
    if (!accessRemovalDue(leaver.leavingOn, today)) continue;
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
      if (done) ended += 1;
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
  return ended + (await endRelinkedLeaversAccess(tx, tenantId, today));
}

/**
 * Rule 8 of the HR link after a withdrawn leaving (integrations.md section 11; HZ-133): a member
 * reinstated after a wrong leaving date was withdrawn, whose leaving Thapsus-HR then gave again,
 * loses access once that day is over, through `app.end_relinked_leaver_access` (the leaver guard
 * keeps the first ending as it was). Each in a savepoint; audited by the staff file's id.
 */
async function endRelinkedLeaversAccess(
  tx: Transaction,
  tenantId: string,
  today: string,
): Promise<number> {
  const due = await tx
    .select({ staffProfileId: leaverRecord.staffProfileId })
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
        isNotNull(leaverRecord.accessRemovedAt),
        isNull(leaverRecord.deletedAt),
        lt(leaverRecord.leavingOn, today),
        ne(tenantUser.status, "left"),
      ),
    );
  let ended = 0;
  for (const leaver of due) {
    try {
      const done = await tx.transaction(async (sp) => {
        const result = await sp.execute<{ ended: boolean }>(
          sql`SELECT app.end_relinked_leaver_access(${leaver.staffProfileId}::uuid) AS ended`,
        );
        return result.rows[0]?.ended === true;
      });
      if (!done) continue;
      ended += 1;
      await tx.insert(auditEvent).values({
        tenantId,
        action: "workforce.leaving.access_ended",
        resourceType: "staff_profile",
        resourceId: leaver.staffProfileId,
        scope: { by: "sweep", after: "withdrawn_leaving" },
      });
    } catch {
      await tx.insert(auditEvent).values({
        tenantId,
        action: "workforce.leaving.access_ended",
        outcome: "denied",
        resourceType: "staff_profile",
        resourceId: leaver.staffProfileId,
        reason: "sweep_relinked",
        scope: { by: "sweep" },
      });
    }
  }
  return ended;
}
