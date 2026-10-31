import { createHash } from "node:crypto";
import {
  agencyBooking,
  type clockEvent,
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
import { and, eq, gte, isNull, lte } from "drizzle-orm";
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
            lte(locationInduction.inductedOn, ukIsoDate(now)),
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

/** Raises an urgent task for the Registered Manager at a location about a clock exception. */
export async function raiseClockException(
  tx: Transaction,
  locationId: string,
  eventId: string,
  title: string,
) {
  await withSystemRights(tx, () =>
    tx.insert(task).values({
      kind: "scheduling.clock_exception",
      title,
      requiredPermission: "scheduling.rota.approve",
      locationId,
      sourceType: "clock_event",
      sourceId: eventId,
      assigneeRoleKey: CLOCK_EXCEPTION_ROLE,
      dueAt: new Date(),
      priority: "urgent",
    }),
  );
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
