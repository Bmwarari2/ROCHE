import { createHash } from "node:crypto";
import {
  absence,
  agencyBooking,
  bankHoliday,
  payProfile,
  payRuleSet,
  payRun,
  payRunException,
  payRunLine,
  shift,
  sleepInAwakePeriod,
  staffProfile,
  type Transaction,
  tenant,
  timesheetEntry,
} from "@harbour/db";
import {
  ABSENCE_RATE_KEYS,
  awrClock,
  awrWeeksFromShifts,
  payRunLine as calculateLine,
  canonicalInput,
  type Enhancement,
  PAY_RATE_KEYS,
  type PayEntry,
  type PayLine,
  type PayLineInput,
  type PayProfile,
  type PayRates,
  type PayRuleSetFull,
  periodsOfIncapacity,
  qualifyingDaysIn,
  type RateNation,
  RateNotFoundError,
  type RateRow,
  resolveAbsenceRates,
  resolvePayRates,
  ukEndOfDay,
  ukIsoDate,
  ukStartOfDay,
} from "@harbour/domain";
import { and, desc, eq, gt, gte, inArray, isNull, lt, lte, or } from "drizzle-orm";
import { rateRows } from "./rates";
import { withSystemRights } from "./system-rights";

/**
 * Pay calculation runs (scheduling.md section 18): what a run reads (approved time, sickness, the
 * staff file's date of birth, an agency worker's bookings, the rate table and the nation's bank
 * holidays), read with the system's rights so only the result leaves, and the lines and exceptions
 * a calculation writes in the caller's own name.
 */

export type Nation = Exclude<RateNation, "uk" | "all">;
export type RunRow = typeof payRun.$inferSelect;
export type RuleSetRow = typeof payRuleSet.$inferSelect;
export type LineRow = typeof payRunLine.$inferSelect;

export const sha256 = (text: string) => createHash("sha256").update(text).digest("hex");

export async function nationOfTenant(tx: Transaction): Promise<Nation> {
  const [t] = await withSystemRights(tx, () => tx.select({ nation: tenant.nation }).from(tenant));
  return (t?.nation ?? "england") as Nation;
}

/** Rule 1: the approved rule set in force on a date, the latest version. */
export async function ruleSetInForce(tx: Transaction, on: string): Promise<RuleSetRow | null> {
  const [row] = await tx
    .select()
    .from(payRuleSet)
    .where(
      and(
        eq(payRuleSet.status, "approved"),
        lte(payRuleSet.effectiveFrom, on),
        isNull(payRuleSet.deletedAt),
      ),
    )
    .orderBy(desc(payRuleSet.versionNumber))
    .limit(1);
  return row ?? null;
}

export function ruleSetFull(row: RuleSetRow, bankHolidays: readonly string[]): PayRuleSetFull {
  return {
    id: row.id,
    version: row.versionNumber,
    roleRates: row.roleRates as Record<string, number>,
    enhancements: row.enhancements as Enhancement[],
    stackEnhancements: row.stackEnhancements,
    sleepInFlatPence: row.sleepInFlatPence,
    mileagePencePerMile: row.mileagePencePerMile,
    onCallFlatPence: row.onCallFlatPence,
    nightStartMinute: row.nightStartMinute,
    nightEndMinute: row.nightEndMinute,
    bankHolidays: [...new Set([...bankHolidays, ...row.extraBankHolidays])].sort(),
    overtimeAfterMinutes: row.overtimeAfterMinutes,
    rolledUpHoliday: row.rolledUpHoliday,
  };
}

/** The rate rows the pay and absence rules read: stored with the run so it reproduces. */
export async function payRateRows(tx: Transaction): Promise<RateRow[]> {
  return rateRows(tx, [...Object.values(PAY_RATE_KEYS), ...Object.values(ABSENCE_RATE_KEYS)]);
}

/** The pay rates for a period, or null when the table lacks a figure (`rate_missing`). */
export function payRatesOrNull(
  rows: readonly RateRow[],
  nation: Nation,
  on: string,
  tenantId: string,
): PayRates | null {
  try {
    return resolvePayRates(rows, nation, on, tenantId);
  } catch (error) {
    // Only a missing figure is an exception to put right; anything else is a fault.
    if (error instanceof RateNotFoundError) return null;
    throw error;
  }
}

/** The previous totals a correction compares with: the latest locked run of the period. */
async function previousTotals(tx: Transaction, run: RunRow): Promise<Map<string, number> | null> {
  if (run.kind !== "correction" || !run.correctsRunId) return null;
  const original = run.correctsRunId;
  const [latest] = await tx
    .select()
    .from(payRun)
    .where(
      and(
        eq(payRun.status, "locked"),
        or(eq(payRun.id, original), eq(payRun.correctsRunId, original)),
      ),
    )
    .orderBy(desc(payRun.lockedAt))
    .limit(1);
  if (!latest) return new Map();
  const lines = await tx
    .select({ memberId: payRunLine.memberId, total: payRunLine.totalPence })
    .from(payRunLine)
    .where(and(eq(payRunLine.runId, latest.id), eq(payRunLine.calculation, latest.calculation)));
  return new Map(lines.map((l) => [l.memberId, l.total]));
}

/** Rule 3: each member's inputs for a period, read with the system's rights. */
export async function lineInputs(
  tx: Transaction,
  run: RunRow,
  set: PayRuleSetFull,
  rows: readonly RateRow[],
  nation: Nation,
  tenantId: string,
  rates: PayRates | null,
): Promise<PayLineInput[]> {
  const range = { start: ukStartOfDay(run.periodStart), end: ukEndOfDay(run.periodEnd) };
  return withSystemRights(tx, async () => {
    const entries = await tx
      .select()
      .from(timesheetEntry)
      .where(
        and(
          gte(timesheetEntry.startedAt, range.start),
          lt(timesheetEntry.startedAt, range.end),
          isNull(timesheetEntry.deletedAt),
        ),
      );
    // Approved entries that started before the period (up to the longest entry) but run into it:
    // their days are worked days, never sick days, in this period (rule 6).
    const earlier = await tx
      .select()
      .from(timesheetEntry)
      .where(
        and(
          gte(timesheetEntry.startedAt, new Date(range.start.getTime() - 2 * 86_400_000)),
          lt(timesheetEntry.startedAt, range.start),
          gt(timesheetEntry.endedAt, range.start),
          eq(timesheetEntry.status, "approved"),
          isNull(timesheetEntry.deletedAt),
        ),
      );
    const ids = entries.map((e) => e.id);
    const correctors =
      ids.length === 0
        ? []
        : await tx
            .select({ supersedesId: timesheetEntry.supersedesId })
            .from(timesheetEntry)
            .where(
              and(
                inArray(timesheetEntry.supersedesId, ids),
                eq(timesheetEntry.status, "approved"),
                isNull(timesheetEntry.deletedAt),
              ),
            );
    const superseded = new Set(correctors.map((c) => c.supersedesId as string));
    const awake =
      ids.length === 0
        ? []
        : await tx
            .select()
            .from(sleepInAwakePeriod)
            .where(inArray(sleepInAwakePeriod.timesheetEntryId, ids));
    const profiles = await tx.select().from(payProfile).where(isNull(payProfile.deletedAt));
    const profileOf = new Map(profiles.map((p) => [p.memberId, p]));
    const members = new Set<string>([
      ...profiles.filter((p) => p.frequency === run.frequency).map((p) => p.memberId),
      ...entries.filter((e) => !profileOf.has(e.workerId)).map((e) => e.workerId),
    ]);
    const memberIds = [...members].sort();
    const births =
      memberIds.length === 0
        ? []
        : await tx
            .select({ id: staffProfile.tenantUserId, dob: staffProfile.dateOfBirth })
            .from(staffProfile)
            .where(inArray(staffProfile.tenantUserId, memberIds));
    const dobOf = new Map(births.map((b) => [b.id, b.dob as string | null]));
    const sick =
      memberIds.length === 0
        ? []
        : await tx
            .select()
            .from(absence)
            .where(
              and(
                inArray(absence.memberId, memberIds),
                eq(absence.kind, "sickness"),
                inArray(absence.state, ["approved", "recorded"]),
                isNull(absence.deletedAt),
              ),
            );
    const absenceRates = (() => {
      try {
        return resolveAbsenceRates(rows, nation, run.periodStart, tenantId);
      } catch {
        return null;
      }
    })();
    const previous = await previousTotals(tx, run);
    const out: PayLineInput[] = [];
    for (const memberId of memberIds) {
      const p = profileOf.get(memberId);
      const profile: PayProfile | null = p
        ? {
            employment: p.employment as PayProfile["employment"],
            roleKey: p.roleKey,
            dateOfBirth: dobOf.get(memberId) ?? null,
            apprenticeshipStartedOn: p.apprenticeshipStartedOn,
            irregularHours: p.irregularHours,
            leaveYearStart: p.leaveYearStart,
            qualifyingWeekdays: [...p.qualifyingWeekdays].sort(),
            sspAverageWeeklyEarningsPence: p.sspAverageWeeklyEarningsPence,
            statePensionAgeOn: p.statePensionAgeOn,
          }
        : null;
      const own = entries.filter((e) => e.workerId === memberId);
      const current: PayEntry[] = own
        .filter((e) => e.status === "approved" && !superseded.has(e.id))
        .sort((x, y) => x.startedAt.getTime() - y.startedAt.getTime() || x.id.localeCompare(y.id))
        .map((e) => ({
          id: e.id,
          kind: e.kind as PayEntry["kind"],
          start: e.startedAt,
          end: e.endedAt,
          breaks: (e.breaks as { start: string; end: string }[]).map((b) => ({
            start: new Date(b.start),
            end: new Date(b.end),
          })),
          travel: e.travel as PayEntry["travel"],
          mileageTenths: e.mileageTenths,
          awake: awake
            .filter((a) => a.timesheetEntryId === e.id)
            .sort((x, y) => x.startedAt.getTime() - y.startedAt.getTime())
            .map((a) => ({ start: a.startedAt, end: a.endedAt })),
        }));
      const drafts = own
        .filter((e) => e.status === "draft")
        .map((e) => e.id)
        .sort();
      // Rule 6: sickness in the period inside a period of incapacity, and what was paid before it.
      let sickness: PayLineInput["sickness"] = null;
      const spells = sick.filter((s) => s.memberId === memberId);
      if (spells.length > 0 && absenceRates && profile) {
        const periods =
          periodsOfIncapacity(
            spells.map((s) => ({ id: s.id, startsOn: s.startsOn, endsOn: s.endsOn })),
            run.periodEnd,
            absenceRates,
          ) ?? [];
        const weekdays = new Set(profile.qualifyingWeekdays);
        const inPeriod = periods.filter((x) =>
          x.days.some((d) => d >= run.periodStart && d <= run.periodEnd),
        );
        if (inPeriod.length > 0) {
          sickness = {
            days: inPeriod
              .flatMap((x) => x.days)
              .filter((d) => d >= run.periodStart && d <= run.periodEnd)
              .sort(),
            daysAlreadyPaid: qualifyingDaysIn(
              (inPeriod[0]?.days ?? []).filter((d) => d < run.periodStart),
              weekdays,
            ).length,
          };
        }
      }
      // Rule 7: an agency worker's AWR clock from their bookings.
      let awr: PayLineInput["awr"] = null;
      if (profile?.employment === "agency" && rates) {
        const starts = await tx
          .select({ startsAt: shift.startsAt })
          .from(agencyBooking)
          .innerJoin(shift, eq(shift.id, agencyBooking.shiftId))
          .where(and(eq(agencyBooking.workerId, memberId), eq(agencyBooking.status, "confirmed")));
        const clock = awrClock(
          awrWeeksFromShifts(
            starts.map((s) => s.startsAt),
            run.periodEnd,
          ),
          rates,
        );
        awr = {
          qualifyingWeeks: clock.qualifyingWeeks,
          qualifiedFromWeek: clock.qualifiedFromWeek,
        };
      }
      out.push({
        memberId,
        period: {
          start: run.periodStart,
          end: run.periodEnd,
          frequency: run.frequency as "weekly" | "monthly",
        },
        ruleSet: set,
        profile,
        entries: current,
        unapprovedEntryIds: drafts,
        alsoWorkedOn: [
          ...new Set(
            earlier
              .filter((e) => e.workerId === memberId)
              .flatMap((e) => {
                const out: string[] = [];
                for (
                  let d = ukIsoDate(range.start);
                  d <= ukIsoDate(new Date(e.endedAt.getTime() - 1)) && d <= run.periodEnd;
                  d = ukIsoDate(new Date(ukStartOfDay(d).getTime() + 36 * 3_600_000))
                ) {
                  out.push(d);
                }
                return out;
              }),
          ),
        ].sort(),
        sickness,
        awr,
        previousTotalPence: previous === null ? null : (previous.get(memberId) ?? 0),
      });
    }
    return out;
  });
}

/** The nation's bank holidays in a period (docs/specs/calendar.md). */
export async function bankHolidaysIn(
  tx: Transaction,
  nation: Nation,
  from: string,
  to: string,
): Promise<string[]> {
  const rows = await tx
    .select({ date: bankHoliday.date })
    .from(bankHoliday)
    .where(
      and(eq(bankHoliday.nation, nation), gte(bankHoliday.date, from), lte(bankHoliday.date, to)),
    );
  return rows.map((r) => r.date).sort();
}

/** The figures of a line row as the domain gives them, to compare a recalculation (rule 10). */
export function figuresOf(line: PayLine | LineRow): Record<string, number | string | null> {
  return {
    paidMinutes: line.paidMinutes,
    nmwMinutes: line.nmwMinutes,
    basicPence: line.basicPence,
    premiumPence: line.premiumPence,
    sleepInPence: line.sleepInPence,
    onCallPence: line.onCallPence,
    mileagePence: line.mileagePence,
    nmwTopUpPence: line.nmwTopUpPence,
    rolledUpHolidayPence: line.rolledUpHolidayPence,
    sspPence: line.sspPence,
    totalPence: line.totalPence,
    differencePence: line.differencePence,
    holidayAccruedMinutes: line.holidayAccruedMinutes,
    nmwBand: line.nmwBand,
    aeCategory: line.aeCategory,
    qualifyingEarningsPence: line.qualifyingEarningsPence,
  };
}

/** Rule 9: an override carries forward only while the line's inputs are unchanged. */
export async function priorOverride(
  tx: Transaction,
  runId: string,
  calculation: number,
  memberId: string,
  kind: string,
  ref: string | null,
  hash: string,
) {
  const rows = await tx
    .select()
    .from(payRunException)
    .where(
      and(
        eq(payRunException.runId, runId),
        eq(payRunException.calculation, calculation - 1),
        eq(payRunException.memberId, memberId),
        eq(payRunException.kind, kind),
        eq(payRunException.lineInputHash, hash),
        eq(payRunException.status, "overridden"),
      ),
    );
  return rows.find((r) => r.ref === ref) ?? null;
}

export { calculateLine };

/**
 * A line's input hash: its canonical inputs and the rates they were calculated at, so an override
 * never outlives a change in the rate table (rule 9; clinical review).
 */
export function lineHash(canonical: string, rates: PayRates | null): string {
  return sha256(`${canonical}\n${canonicalInput(rates)}`);
}

/** The rates in force on each day, for SSP (whose rate changes by day). */
export function ratesByDay(
  rows: readonly RateRow[],
  nation: Nation,
  tenantId: string,
): (date: string) => PayRates | null {
  const cache = new Map<string, PayRates | null>();
  return (date) => {
    if (!cache.has(date)) cache.set(date, payRatesOrNull(rows, nation, date, tenantId));
    return cache.get(date) ?? null;
  };
}
