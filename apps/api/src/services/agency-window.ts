import { agencyBooking, shift, shiftAssignment, type Transaction, tenantUser } from "@harbour/db";
import { agencyAccessWindow } from "@harbour/domain";
import { and, eq, isNull } from "drizzle-orm";
import { rateNumber } from "./rates";
import { withSystemRights } from "./system-rights";

/**
 * The end of the booked shift whose access window is open now for a bank or agency member
 * (ADR-0088), or null. The database closes everything else outside the window; search uses the
 * shift's end so its own window matches. Read with the system's rights: the member cannot read
 * their own bookings.
 */
export async function currentBookedShiftEnd(
  tx: Transaction,
  memberId: string,
  now: Date,
  postShiftHours: number,
): Promise<Date | null> {
  const rows = await withSystemRights(tx, () =>
    tx
      .select({ start: shift.startsAt, end: shift.endsAt })
      .from(agencyBooking)
      .innerJoin(shift, eq(shift.id, agencyBooking.shiftId))
      .innerJoin(shiftAssignment, eq(shiftAssignment.id, agencyBooking.assignmentId))
      .where(
        and(
          eq(agencyBooking.workerId, memberId),
          eq(agencyBooking.status, "confirmed"),
          isNull(shift.deletedAt),
          isNull(shiftAssignment.deletedAt),
        ),
      ),
  );
  const open = rows
    .filter((r) => agencyAccessWindow([r], now, postShiftHours) !== null)
    .sort((a, b) => b.end.getTime() - a.end.getTime());
  return open[0]?.end ?? null;
}

/**
 * When a bank or agency member's access window ends now (the open booked shift's end plus the
 * rate table's hours), or null for anyone else. A member with no open window gets nothing anyway:
 * their roles reach nothing (ADR-0088).
 */
export async function agencyWindowEnd(
  tx: Transaction,
  tenantId: string,
  memberId: string,
  now: Date = new Date(),
): Promise<Date | null> {
  const [me] = await tx
    .select({ isAgency: tenantUser.isAgency })
    .from(tenantUser)
    .where(eq(tenantUser.id, memberId));
  if (!me?.isAgency) return null;
  const hours = await rateNumber(tx, tenantId, "access.agency.post_shift_hours");
  const end = await currentBookedShiftEnd(tx, memberId, now, hours);
  return end ? new Date(end.getTime() + hours * 3_600_000) : now;
}
