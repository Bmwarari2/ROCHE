import {
  agencyBooking,
  personAssignment,
  shift,
  shiftAssignment,
  type Transaction,
  tenantUser,
} from "@harbour/db";
import {
  type AgencyUploadDecision,
  agencyAccessWindow,
  agencyUploadDecision,
} from "@harbour/domain";
import { and, eq, gt, inArray, isNull, lte, or } from "drizzle-orm";
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

/**
 * Booked bank or agency workers on a shift running at a location during a window (from `from` to
 * `to`) who have nobody assigned to them now (H-927 recommended answer; HZ-073): the agency worker
 * role is assigned-scope, so without people assigned they cannot see allergies or care plans. The
 * rota and the shift's handover warn, so the nurse in charge assigns people. Read with the system's
 * rights; only ids leave.
 */
export async function agencyWithoutPeople(
  tx: Transaction,
  locationId: string,
  from: Date,
  to: Date,
  now: Date,
): Promise<{ memberId: string; assignmentId: string; shiftId: string }[]> {
  return withSystemRights(tx, async () => {
    const booked = await tx
      .select({
        memberId: agencyBooking.workerId,
        assignmentId: agencyBooking.assignmentId,
        shiftId: agencyBooking.shiftId,
      })
      .from(agencyBooking)
      .innerJoin(shift, eq(shift.id, agencyBooking.shiftId))
      .innerJoin(shiftAssignment, eq(shiftAssignment.id, agencyBooking.assignmentId))
      .where(
        and(
          eq(agencyBooking.locationId, locationId),
          eq(agencyBooking.status, "confirmed"),
          isNull(shift.deletedAt),
          isNull(shiftAssignment.deletedAt),
          lte(shift.startsAt, to),
          gt(shift.endsAt, from),
          lte(shift.startsAt, now),
          gt(shift.endsAt, now),
        ),
      );
    if (booked.length === 0) return [];
    const withPeople = await tx
      .select({ memberId: personAssignment.tenantUserId })
      .from(personAssignment)
      .where(
        and(
          inArray(
            personAssignment.tenantUserId,
            booked.map((b) => b.memberId),
          ),
          isNull(personAssignment.deletedAt),
          lte(personAssignment.validFrom, now),
          or(isNull(personAssignment.validTo), gt(personAssignment.validTo, now)),
        ),
      );
    const has = new Set(withPeople.map((p) => p.memberId));
    return booked
      .filter((b) => !has.has(b.memberId))
      .sort((a, b) => a.assignmentId.localeCompare(b.assignmentId));
  });
}

/**
 * H-921 recommended answer: for a bank or agency member, each uploaded entry is checked against
 * their confirmed bookings by the time it was recorded; after the window closes it is accepted,
 * flagged late, only for the rate table's upload grace period (`access.agency.upload_grace_hours`).
 * Nothing is opened to read. Null for anyone else.
 */
export async function agencyUploadCheck(
  tx: Transaction,
  tenantId: string,
  memberId: string,
  now: Date,
): Promise<((recordedAt: Date | null) => AgencyUploadDecision) | null> {
  const [me] = await withSystemRights(tx, () =>
    tx
      .select({ isAgency: tenantUser.isAgency })
      .from(tenantUser)
      .where(eq(tenantUser.id, memberId)),
  );
  if (!me?.isAgency) return null;
  const post = await rateNumber(tx, tenantId, "access.agency.post_shift_hours");
  const grace = await rateNumber(tx, tenantId, "access.agency.upload_grace_hours");
  const bookings = await withSystemRights(tx, () =>
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
  return (recordedAt) =>
    recordedAt
      ? agencyUploadDecision(bookings, recordedAt, now, post, grace)
      : { accept: false, reason: "outside_booking" };
}
