import {
  absence,
  location,
  notification,
  shift,
  shiftAssignment,
  shiftCoverNeed,
  type Transaction,
  task,
} from "@harbour/db";
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
import { COVER_TASK_KIND, permissionHolders } from "./device-holds";

export { COVER_TASK_KIND };

import { rateNumber } from "./rates";
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
    const coverNeedId = made.rows[0]?.id;
    if (!coverNeedId) continue;
    raised += 1;
    await publish(tx, {
      context: "scheduling",
      aggregateType: "shift",
      aggregateId: n.shiftId,
      type: "scheduling.cover_needed",
      payload: { coverNeedId, shiftId: n.shiftId, absenceId: row.id, locationId: at.locationId },
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
  await closeCoverTasks(
    tx,
    done.map((d) => d.id),
  );
  return done.length;
}

export const COVER_TASK_SOURCE = "shift_cover_need";
export const COVER_TASK_PERMISSION = "scheduling.rota.manage";
export const COVER_TASK_LEAD_RATE_KEY = "scheduling.cover_task_lead_minutes";

const OPEN_TASK = ["open", "in_progress"];
const coverLock = (tx: Transaction, coverNeedId: string) =>
  tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${`cover_need_task:${coverNeedId}`}))`);

/**
 * Raises the task for a cover need (rule 7; HZ-123), from the worker as the system: one per need,
 * at the shift's home, for the holders of `scheduling.rota.manage` there, due
 * `scheduling.cover_task_lead_minutes` before the shift starts (at once, and urgent, when that has
 * passed), escalating as the sync tasks do (to the holders of its permission, else a manager
 * elsewhere). The rota managers at the home are told at once. Nothing is raised for a need already
 * resolved or a shift already started, and a lock shared with `closeCoverTasks` means a resolution
 * racing the worker never leaves a task open. The task names the shift only, never the member or
 * why they are away. Returns the task's id, or null.
 */
export async function raiseCoverTask(
  tx: Transaction,
  tenantId: string,
  coverNeedId: string,
  now: Date,
): Promise<string | null> {
  await coverLock(tx, coverNeedId);
  const [need] = await tx
    .select({
      shiftId: shiftCoverNeed.shiftId,
      locationId: shiftCoverNeed.locationId,
      resolvedAt: shiftCoverNeed.resolvedAt,
      startsAt: shift.startsAt,
      nation: location.nation,
    })
    .from(shiftCoverNeed)
    .innerJoin(
      shift,
      and(eq(shift.tenantId, shiftCoverNeed.tenantId), eq(shift.id, shiftCoverNeed.shiftId)),
    )
    .innerJoin(
      location,
      and(
        eq(location.tenantId, shiftCoverNeed.tenantId),
        eq(location.id, shiftCoverNeed.locationId),
      ),
    )
    .where(eq(shiftCoverNeed.id, coverNeedId));
  if (!need || need.resolvedAt || need.startsAt <= now) return null;
  const [open] = await tx
    .select({ id: task.id })
    .from(task)
    .where(
      and(
        eq(task.kind, COVER_TASK_KIND),
        eq(task.sourceType, COVER_TASK_SOURCE),
        eq(task.sourceId, coverNeedId),
        isNull(task.deletedAt),
      ),
    )
    .limit(1);
  if (open) return null;
  const leadMinutes = await rateNumber(
    tx,
    tenantId,
    COVER_TASK_LEAD_RATE_KEY,
    need.nation,
    ukIsoDate(now),
  );
  const leadDue = new Date(need.startsAt.getTime() - leadMinutes * 60_000);
  const late = leadDue <= now;
  const [created] = await tx
    .insert(task)
    .values({
      kind: COVER_TASK_KIND,
      title: "A rostered shift needs cover",
      requiredPermission: COVER_TASK_PERMISSION,
      locationId: need.locationId,
      sourceType: COVER_TASK_SOURCE,
      sourceId: coverNeedId,
      dueAt: late ? now : leadDue,
      priority: late ? "urgent" : "routine",
      details: { shiftId: need.shiftId, shiftStartsAt: need.startsAt.toISOString() },
    })
    // One per need (`task_cover_need_key`), whatever a racing relay does.
    .onConflictDoNothing()
    .returning({ id: task.id });
  if (!created) return null;
  const managers = await permissionHolders(tx, COVER_TASK_PERMISSION, need.locationId, now, null, {
    preferAtLocation: true,
  });
  for (const recipient of managers) {
    await tx
      .insert(notification)
      .values({
        recipientTenantUserId: recipient,
        kind: COVER_TASK_KIND,
        severity: late ? "urgent" : "warning",
        title: "A rostered shift needs cover",
        body: "A shift needs cover. Open the rota.",
        link: "/tasks",
        channels: late ? ["in_app", "push"] : ["in_app"],
        sourceType: "task",
        sourceId: created.id,
        locationId: need.locationId,
        dedupeKey: `cover_needed:${created.id}:${recipient}`,
      })
      .onConflictDoNothing();
  }
  return created.id;
}

/**
 * Closes the open tasks of resolved cover needs (rule 7): with the system's rights, for those
 * needs only, because the person resolving (a manager at the absent member's home) may not see the
 * shift's home. Cancelled as "cover no longer needed" (nothing of why), under the lock `raiseCoverTask` takes.
 */
export async function closeCoverTasks(
  tx: Transaction,
  coverNeedIds: readonly string[],
): Promise<number> {
  if (coverNeedIds.length === 0) return 0;
  for (const id of [...coverNeedIds].sort()) await coverLock(tx, id);
  return withSystemRights(tx, async () => {
    const closed = await tx
      .update(task)
      .set({
        status: "cancelled",
        statusReason: "Ended: cover no longer needed",
      })
      .where(
        and(
          eq(task.kind, COVER_TASK_KIND),
          eq(task.sourceType, COVER_TASK_SOURCE),
          inArray(task.sourceId, [...coverNeedIds]),
          inArray(task.status, OPEN_TASK),
          isNull(task.deletedAt),
        ),
      )
      .returning({ id: task.id });
    return closed.length;
  });
}
