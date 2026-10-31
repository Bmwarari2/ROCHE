import { createHash } from "node:crypto";
import {
  agencyBooking,
  clockEvent,
  locationInduction,
  rosterOverride,
  shift,
  shiftAssignment,
  staffProfile,
  type Transaction,
  task,
  timesheetEntry,
  workingTimeOptOut,
  workingTimeResult,
} from "@harbour/db";
import {
  checkWorkingTime,
  optOutAgreement,
  overrideCovers,
  type RosterBlocker,
  resolveWorkingTimeRates,
  type TimesheetFact,
  timesheetWorkPeriods,
  ukIsoDate,
  WORKING_TIME_RATE_KEYS,
  workingTimeWindow,
} from "@harbour/domain";
import { and, eq, exists, gte, isNull, lte, or, sql } from "drizzle-orm";
import { rateRows } from "./rates";
import {
  DEFAULT_WORKING_TIME_SETTING,
  nationOfLocation,
  type ShiftRow,
  shiftEligibility,
  WORKING_TIME_NOTES,
} from "./rota";
import { withSystemRights } from "./system-rights";

/**
 * Time and attendance (scheduling.md section 16; HZ-010, HZ-124): the rule on the day at clock-in,
 * the draft a clock-out makes, and the working time result stored when time is approved. Other
 * members' and other locations' rows are read with the system's rights and only the answer leaves.
 */

export type TimesheetRow = typeof timesheetEntry.$inferSelect;
export type ClockEventRow = typeof clockEvent.$inferSelect;

/** Who an exception on the clock goes to (the organisation may give the role to anyone). */
export const CLOCK_EXCEPTION_ROLE = "registered_manager";

export const timesheetFact = (r: TimesheetRow): TimesheetFact => ({
  id: r.id,
  workerId: r.workerId,
  kind: r.kind as TimesheetFact["kind"],
  start: r.startedAt,
  end: r.endedAt,
  breaks: (r.breaks as { start: string; end: string }[]).map((b) => ({
    start: new Date(b.start),
    end: new Date(b.end),
  })),
  travel: r.travel as TimesheetFact["travel"],
  status: r.status as "draft" | "approved",
  supersedesId: r.supersedesId,
});

/**
 * Rule 3 (HZ-124; H-920): whether the member may start the shift now: the rostering rule on the
 * shift's dates, with an override that already covers the assignment, and for a bank or agency
 * worker an induction at the location. Returns the problems found, empty when none.
 */
export async function clockInProblems(
  tx: Transaction,
  tenantId: string,
  s: ShiftRow,
  workerId: string,
  isAgency: boolean,
  now: Date,
): Promise<("not_eligible" | "no_induction")[]> {
  const problems: ("not_eligible" | "no_induction")[] = [];
  const decision = await shiftEligibility(tx, tenantId, s, workerId, null, now);
  if (!decision.allowed) {
    const overrides = await withSystemRights(tx, () =>
      tx
        .select({ keys: rosterOverride.blockerKeys })
        .from(rosterOverride)
        .innerJoin(shiftAssignment, eq(shiftAssignment.id, rosterOverride.assignmentId))
        .where(
          and(
            eq(shiftAssignment.shiftId, s.id),
            eq(shiftAssignment.workerId, workerId),
            isNull(shiftAssignment.deletedAt),
          ),
        ),
    );
    const blockers = decision.blockers as readonly RosterBlocker[];
    if (
      !overrideCovers(
        overrides.flatMap((o) => o.keys),
        blockers,
      )
    )
      problems.push("not_eligible");
  }
  if (isAgency) {
    const inducted = await withSystemRights(tx, () =>
      tx
        .select({ id: locationInduction.id })
        .from(locationInduction)
        .where(
          and(
            eq(locationInduction.workerId, workerId),
            eq(locationInduction.locationId, s.locationId),
            // By the shift's date, not the upload's: an induction after the shift never covers it.
            lte(locationInduction.inductedOn, ukIsoDate(s.startsAt)),
          ),
        )
        .limit(1),
    );
    if (inducted.length === 0) problems.push("no_induction");
  }
  return problems;
}

/** The member's live assignment of a shift, with the shift, read with the system's rights. */
export async function ownShift(
  tx: Transaction,
  workerId: string,
  shiftId: string,
): Promise<ShiftRow | null> {
  const rows = await withSystemRights(tx, () =>
    tx
      .select({ s: shift })
      .from(shiftAssignment)
      .innerJoin(shift, eq(shift.id, shiftAssignment.shiftId))
      .where(
        and(
          eq(shiftAssignment.shiftId, shiftId),
          eq(shiftAssignment.workerId, workerId),
          isNull(shiftAssignment.deletedAt),
          isNull(shift.deletedAt),
        ),
      ),
  );
  return rows[0]?.s ?? null;
}

/**
 * A shift the member was on, or booked for, even if the assignment, booking or shift has since been
 * removed or cancelled: a late upload for it is kept and flagged, never dropped (rule 1; HZ-010).
 */
export async function formerShift(
  tx: Transaction,
  workerId: string,
  shiftId: string,
): Promise<ShiftRow | null> {
  const rows = await withSystemRights(tx, () =>
    tx
      .select({ s: shift })
      .from(shift)
      .where(
        and(
          eq(shift.id, shiftId),
          or(
            exists(
              tx
                .select({ one: sql`1` })
                .from(shiftAssignment)
                .where(
                  and(
                    eq(shiftAssignment.shiftId, shift.id),
                    eq(shiftAssignment.workerId, workerId),
                  ),
                ),
            ),
            exists(
              tx
                .select({ one: sql`1` })
                .from(agencyBooking)
                .where(
                  and(eq(agencyBooking.shiftId, shift.id), eq(agencyBooking.workerId, workerId)),
                ),
            ),
          ),
        ),
      ),
  );
  return rows[0]?.s ?? null;
}

/** A bank or agency member's confirmed booking of a shift (ADR-0088), with the shift. */
export async function bookedShift(
  tx: Transaction,
  workerId: string,
  shiftId: string,
): Promise<ShiftRow | null> {
  const rows = await withSystemRights(tx, () =>
    tx
      .select({ s: shift })
      .from(agencyBooking)
      .innerJoin(shift, eq(shift.id, agencyBooking.shiftId))
      .innerJoin(shiftAssignment, eq(shiftAssignment.id, agencyBooking.assignmentId))
      .where(
        and(
          eq(agencyBooking.shiftId, shiftId),
          eq(agencyBooking.workerId, workerId),
          eq(agencyBooking.status, "confirmed"),
          isNull(shift.deletedAt),
          isNull(shiftAssignment.deletedAt),
        ),
      ),
  );
  return rows[0]?.s ?? null;
}

/** What a clock exception task says, by the most serious flag (fixed text, ids only). */
export const CLOCK_EXCEPTION_TITLES: Readonly<Record<string, string>> = {
  not_eligible: "Check a clock-in: a check the shift needs was missing or had lapsed",
  no_induction: "Check a clock-in: no induction at this location",
  no_booking: "Check a clock event: the booking had been cancelled",
  not_on_shift: "Check a clock event: the shift or assignment had been removed",
  no_permission: "Check a clock event: the member no longer records their own time",
  other_location: "Check a clock event: recorded at another location than the shift's",
  no_shift: "Check a clock-in recorded offline with no shift: the checks could not run",
};
const EXCEPTION_ORDER = Object.keys(CLOCK_EXCEPTION_TITLES);

/** The flags that raise a clock exception task, most serious first (outside_access_window alone does not). */
export function exceptionFlags(flags: Iterable<string>, kind: string): string[] {
  const set = new Set(flags);
  if (kind !== "in") set.delete("no_shift");
  return EXCEPTION_ORDER.filter((f) => set.has(f));
}

/**
 * Raises an urgent task for the Registered Manager at a location about a clock exception, at most
 * one open per worker and shift (HZ-008: alert fatigue), titled by the most serious check.
 */
export async function raiseClockException(
  tx: Transaction,
  event: { id: string; locationId: string; workerId: string; shiftId: string | null },
  flags: readonly string[],
) {
  const first = flags[0];
  if (!first) return;
  await withSystemRights(tx, async () => {
    if (event.shiftId) {
      const [open] = await tx
        .select({ id: task.id })
        .from(task)
        .innerJoin(clockEvent, eq(clockEvent.id, task.sourceId))
        .where(
          and(
            eq(task.kind, "scheduling.clock_exception"),
            eq(task.sourceType, "clock_event"),
            eq(task.status, "open"),
            eq(clockEvent.workerId, event.workerId),
            eq(clockEvent.shiftId, event.shiftId),
          ),
        )
        .limit(1);
      if (open) return;
    }
    await tx.insert(task).values({
      kind: "scheduling.clock_exception",
      title: CLOCK_EXCEPTION_TITLES[first] ?? "Check a clock event",
      requiredPermission: "scheduling.rota.approve",
      locationId: event.locationId,
      sourceType: "clock_event",
      sourceId: event.id,
      assigneeRoleKey: CLOCK_EXCEPTION_ROLE,
      dueAt: new Date(),
      priority: "urgent",
    });
  });
}

/**
 * A refused online clock-in leaves the shift short: an urgent task for the person in charge, at
 * most one open per shift (HZ-123, HZ-008).
 */
export async function raiseRefusedClockIn(tx: Transaction, s: ShiftRow) {
  await withSystemRights(tx, async () => {
    const [open] = await tx
      .select({ id: task.id })
      .from(task)
      .where(
        and(
          eq(task.kind, "scheduling.clock_in_refused"),
          eq(task.sourceType, "shift"),
          eq(task.sourceId, s.id),
          eq(task.status, "open"),
        ),
      )
      .limit(1);
    if (open) return;
    await tx.insert(task).values({
      kind: "scheduling.clock_in_refused",
      title: "A clock-in was refused: check the shift is covered",
      requiredPermission: "scheduling.rota.approve",
      locationId: s.locationId,
      sourceType: "shift",
      sourceId: s.id,
      assigneeRoleKey: CLOCK_EXCEPTION_ROLE,
      dueAt: new Date(),
      priority: "urgent",
    });
  });
}

/**
 * Rule 7: the working time check over a worker's approved, current entries (actual breaks), their
 * opt-outs on file and the default setting, for the approved entry's dates; stored with a hash of
 * its inputs. Advice only. Read with the system's rights: every location's time counts.
 */
export async function storeWorkingTimeResult(
  tx: Transaction,
  entry: TimesheetRow,
  trigger: "timesheet_approved" | "requested",
): Promise<{ id: string; breaches: number; conditionals: number; notes: string[] }> {
  const nation = await nationOfLocation(tx, entry.locationId);
  const from = ukIsoDate(entry.startedAt);
  const to = ukIsoDate(new Date(entry.endedAt.getTime() - 1));
  const rates = resolveWorkingTimeRates(
    await rateRows(tx, Object.values(WORKING_TIME_RATE_KEYS)),
    nation,
    from,
  );
  const lookBack = Math.max(rates.referencePeriodWeeks, rates.nightReferencePeriodWeeks);
  const { from: windowStart, to: windowEnd } = workingTimeWindow(from, to, lookBack);
  const { profile, entries, optOuts } = await withSystemRights(tx, async () => {
    const [p] = await tx
      .select({ dateOfBirth: staffProfile.dateOfBirth, startsOn: staffProfile.startsOn })
      .from(staffProfile)
      .where(and(eq(staffProfile.tenantUserId, entry.workerId), isNull(staffProfile.deletedAt)));
    const rows = await tx
      .select()
      .from(timesheetEntry)
      .where(
        and(
          eq(timesheetEntry.workerId, entry.workerId),
          isNull(timesheetEntry.deletedAt),
          gte(timesheetEntry.endedAt, windowStart),
          lte(timesheetEntry.startedAt, windowEnd),
        ),
      );
    const outs = await tx
      .select()
      .from(workingTimeOptOut)
      .where(
        and(eq(workingTimeOptOut.workerId, entry.workerId), isNull(workingTimeOptOut.deletedAt)),
      );
    return { profile: p ?? null, entries: rows, optOuts: outs };
  });
  const facts = entries.map(timesheetFact);
  const notes = [
    "From approved time, with the opt-outs on file and the organisation's default working-time setting (no derogation recorded yet).",
    WORKING_TIME_NOTES.advice,
  ];
  let findings: Record<string, unknown>[] = [];
  if (!profile?.dateOfBirth || !profile.startsOn) {
    notes.unshift(WORKING_TIME_NOTES.noDateOfBirth);
  } else {
    const report = checkWorkingTime({
      worker: {
        dateOfBirth: profile.dateOfBirth,
        employmentStart: profile.startsOn,
        optOuts: optOuts.map((o) =>
          optOutAgreement({
            signedOn: o.signedOn,
            endsOn: o.endsOn,
            noticeAmount: o.noticeAmount,
            noticeUnit: o.noticeUnit as "days" | "months" | null,
            noticeGivenOn: o.noticeGivenOn,
          }),
        ),
        designatedNightWorker: false,
        specialHazards: false,
        contractProvidesWorkAfter22: false,
      },
      setting: DEFAULT_WORKING_TIME_SETTING,
      periods: timesheetWorkPeriods(facts),
      excludedDays: [],
      evaluateFrom: from,
      evaluateTo: to,
      known: { start: windowStart, end: windowEnd },
      rates,
    });
    findings = report.findings.map((f) => ({
      rule: f.rule,
      citation: f.citation,
      outcome: f.outcome,
      conditions: [...f.conditions],
      from: f.from.toISOString(),
      to: f.to.toISOString(),
      limitMinutes: f.limitMinutes,
      actualMinutes: f.actualMinutes,
      compensatoryRestMinutes: f.compensatoryRestMinutes,
      entryIds: [...f.periodIds],
    }));
  }
  const inputHash = createHash("sha256")
    .update(
      JSON.stringify({
        entries: facts
          .filter((f) => f.status === "approved")
          .map((f) => [
            f.id,
            f.start.toISOString(),
            f.end.toISOString(),
            f.breaks.length,
            f.supersedesId,
          ]),
        optOuts: optOuts.map((o) => [o.id, o.version]),
        from,
        to,
        profile: profile ? [profile.dateOfBirth, profile.startsOn] : null,
      }),
    )
    .digest("hex");
  const breaches = findings.filter((f) => f.outcome === "breach").length;
  const conditionals = findings.filter((f) => f.outcome === "conditional").length;
  const [row] = await withSystemRights(tx, () =>
    tx
      .insert(workingTimeResult)
      .values({
        workerId: entry.workerId,
        locationId: entry.locationId,
        evaluateFrom: from,
        evaluateTo: to,
        findings,
        breaches,
        conditionals,
        inputHash,
        trigger,
      })
      .returning({ id: workingTimeResult.id }),
  );
  if (!row) throw new Error("result not stored");
  return { id: row.id, breaches, conditionals, notes };
}
