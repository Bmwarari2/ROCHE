import { agencyBooking, shift, shiftAssignment, type Transaction } from "@harbour/db";
import { agencyAccessWindow } from "@harbour/domain";
import { and, eq, isNull } from "drizzle-orm";
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
