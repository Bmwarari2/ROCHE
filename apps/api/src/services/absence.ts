import { absence, shift, shiftAssignment, shiftCoverNeed, type Transaction } from "@harbour/db";
import {
  type AbsenceState,
  AWAY_STATES,
  absentOn,
  assignmentsNeedingCover,
  ukIsoDate,
  ukStartOfDay,
} from "@harbour/domain";
import { and, eq, gte, inArray, isNull, lte, or, sql } from "drizzle-orm";
import { publish } from "../outbox";
import { withSystemRights } from "./system-rights";

/**
 * Absences and the rota (scheduling.md section 15 rules 7 and 8; HZ-123, HZ-124). Whether a
 * rostered member is away is read with the system's rights, because their absence may belong to
 * another home whose managers the reader is not: only the yes or no leaves (never the kind, the
 * dates or anything about health), so the rota never counts an absent member as care on the floor
 * and never puts them on a shift they will not work.
 */

/** The ISO date `days` after another (calendar days). */
const plusDays = (isoDate: string, days: number) =>
  new Date(Date.parse(`${isoDate}T12:00:00Z`) + days * 86_400_000).toISOString().slice(0, 10);

export type AwayAbsence = {
  readonly state: AbsenceState;
  readonly startsOn: string;
  readonly endsOn: string | null;
};

/** Each member's absences that take them away (approved or recorded), by member. */
export async function awayAbsences(
  tx: Transaction,
  memberIds: readonly string[],
): Promise<Map<string, AwayAbsence[]>> {
  const wanted = [...new Set(memberIds)];
  const out = new Map<string, AwayAbsence[]>();
  if (wanted.length === 0) return out;
  const rows = await withSystemRights(tx, () =>
    tx
      .select({
        memberId: absence.memberId,
        state: absence.state,
        startsOn: absence.startsOn,
        endsOn: absence.endsOn,
      })
      .from(absence)
      .where(
        and(
          inArray(absence.memberId, wanted),
          inArray(absence.state, [...AWAY_STATES]),
          isNull(absence.deletedAt),
        ),
      ),
  );
  for (const r of rows) {
    out.set(r.memberId, [
      ...(out.get(r.memberId) ?? []),
      { state: r.state as AbsenceState, startsOn: r.startsOn, endsOn: r.endsOn },
    ]);
  }
  return out;
}

/** Every UK date a shift touches (a night touches the date it ends on; a long shift, each between). */
export function shiftDates(s: { readonly startsAt: Date; readonly endsAt: Date }): string[] {
  const first = ukIsoDate(s.startsAt);
  const last = ukIsoDate(new Date(s.endsAt.getTime() - 1));
  const dates = [first];
  for (let d = plusDays(first, 1); d <= last; d = plusDays(d, 1)) dates.push(d);
  return dates;
}

/** The assignments whose member is away on the shift (rule 7): counted as open, flagged. */
export async function assignmentsAway(
  tx: Transaction,
  pairs: readonly {
    readonly assignmentId: string;
    readonly workerId: string;
    readonly startsAt: Date;
    readonly endsAt: Date;
  }[],
): Promise<Set<string>> {
  const away = await awayAbsences(
    tx,
    pairs.map((p) => p.workerId),
  );
  return new Set(
    pairs
      .filter((p) => absentOn(away.get(p.workerId) ?? [], shiftDates(p)))
      .map((p) => p.assignmentId),
  );
}

/** Whether a member is away on any date a shift touches (rule 8). */
export async function memberAwayFor(
  tx: Transaction,
  workerId: string,
  s: { readonly startsAt: Date; readonly endsAt: Date },
): Promise<boolean> {
  const away = await awayAbsences(tx, [workerId]);
  return absentOn(away.get(workerId) ?? [], shiftDates(s));
}

type AbsenceRow = typeof absence.$inferSelect;
const DAY_MS = 86_400_000;

/**
 * Raises a cover need for each live assignment of the absent member on a shift touching the
 * absence (rule 7; HZ-123), at any home of the organisation, in the caller's transaction and name:
 * the assignments are found with the system's rights (ids and times only) and each need is raised
 * through `app.raise_cover_need`, which checks the caller and the absence again and marks a
 * published shift as changed since publication. Returns how many were raised; each is an outbox
 * event for the rota's managers.
 */
export async function raiseCoverNeeds(tx: Transaction, row: AbsenceRow): Promise<number> {
  const from = new Date(Date.parse(`${row.startsOn}T00:00:00Z`) - 2 * DAY_MS);
  const live = await withSystemRights(tx, () =>
    tx
      .select({
        assignmentId: shiftAssignment.id,
        shiftId: shiftAssignment.shiftId,
        workerId: shiftAssignment.workerId,
        locationId: shiftAssignment.locationId,
        startsAt: shift.startsAt,
        endsAt: shift.endsAt,
      })
      .from(shiftAssignment)
      .innerJoin(
        shift,
        and(eq(shift.tenantId, shiftAssignment.tenantId), eq(shift.id, shiftAssignment.shiftId)),
      )
      .where(
        and(
          eq(shiftAssignment.workerId, row.memberId),
          isNull(shiftAssignment.deletedAt),
          isNull(shift.deletedAt),
          gte(shift.endsAt, from),
          // A day either side: the UK dates are checked exactly below.
          ...(row.endsOn
            ? [lte(shift.startsAt, new Date(Date.parse(`${row.endsOn}T00:00:00Z`) + 2 * DAY_MS))]
            : []),
        ),
      ),
  );
  const needing = assignmentsNeedingCover(
    { memberId: row.memberId, startsOn: row.startsOn, endsOn: row.endsOn },
    live.map((l) => ({
      assignmentId: l.assignmentId,
      shiftId: l.shiftId,
      workerId: l.workerId,
      dates: shiftDates(l),
    })),
  );
  let raised = 0;
  for (const n of needing) {
    const at = live.find((l) => l.assignmentId === n.assignmentId);
    if (!at) continue;
    const made = await tx.execute<{ id: string | null }>(
      sql`SELECT app.raise_cover_need(${n.assignmentId}::uuid, ${row.id}::uuid) AS id`,
    );
    if (!made.rows[0]?.id) continue;
    raised += 1;
    await publish(tx, {
      context: "scheduling",
      aggregateType: "shift",
      aggregateId: n.shiftId,
      type: "scheduling.cover_needed",
      payload: { shiftId: n.shiftId, absenceId: row.id, locationId: at.locationId },
    });
  }
  return raised;
}

/** Resolves the open cover needs of an absence, or of an assignment, once. */
export async function resolveCoverNeeds(
  tx: Transaction,
  by: { readonly absenceId?: string; readonly assignmentId?: string },
  resolution: "assignment_removed" | "absence_ended",
  /** For an absence that ended early: only needs on shifts starting after this UK date. */
  after?: string,
): Promise<number> {
  const conditions = [
    isNull(shiftCoverNeed.resolvedAt),
    or(
      by.absenceId ? eq(shiftCoverNeed.absenceId, by.absenceId) : undefined,
      by.assignmentId ? eq(shiftCoverNeed.assignmentId, by.assignmentId) : undefined,
    ),
  ];
  let ids: string[] | null = null;
  if (after) {
    const rows = await tx
      .select({ id: shiftCoverNeed.id })
      .from(shiftCoverNeed)
      .innerJoin(
        shift,
        and(eq(shift.tenantId, shiftCoverNeed.tenantId), eq(shift.id, shiftCoverNeed.shiftId)),
      )
      // Shifts starting from UK midnight after the last day (BST or GMT alike).
      .where(and(...conditions, gte(shift.startsAt, ukStartOfDay(plusDays(after, 1)))));
    ids = rows.map((r) => r.id);
    if (ids.length === 0) return 0;
  }
  const done = await tx
    .update(shiftCoverNeed)
    .set({ resolvedAt: new Date(), resolution })
    .where(and(...conditions, ...(ids ? [inArray(shiftCoverNeed.id, ids)] : [])))
    .returning({ id: shiftCoverNeed.id });
  return done.length;
}
