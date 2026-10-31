/**
 * The agreements that change how the working time limits apply (scheduling.md rules 2, 3 and 6):
 * a worker's opt-out from the 48-hour average, the night time an agreement sets, and the length
 * of the reference periods. Figures come from the rate table.
 */

import { addPeriod } from "../platform/retention";
import { isoDateOf, MINUTES_PER_DAY, MINUTES_PER_HOUR, plusDays } from "./intervals";
import type { WorkingTimeRates } from "./rates";
import type { NightTime, OptOutAgreement, WorkingTimeSetting } from "./working-time-types";

export type OptOutIssue =
  /** Reg 5(3): a notice period in the agreement may not exceed the maximum; it is capped. */
  "notice_too_long" | "notice_not_positive" | "ends_before_signed" | "notice_before_signed";

/** Problems with a recorded opt-out, for the screen that records it. */
export function checkOptOutAgreement(
  agreement: OptOutAgreement,
  rates: WorkingTimeRates,
): OptOutIssue[] {
  const issues: OptOutIssue[] = [];
  const notice = agreement.noticePeriod;
  if (notice) {
    if (!(notice.amount > 0) || !Number.isInteger(notice.amount))
      issues.push("notice_not_positive");
    else if (
      plusNotice(agreement.signedOn, notice) >
      plusMonths(agreement.signedOn, rates.optOutMaxNoticeMonths)
    ) {
      issues.push("notice_too_long");
    }
  }
  if (agreement.endsOn !== null && agreement.endsOn < agreement.signedOn) {
    issues.push("ends_before_signed");
  }
  if (agreement.noticeGivenOn !== null && agreement.noticeGivenOn < agreement.signedOn) {
    issues.push("notice_before_signed");
  }
  return issues;
}

function plusMonths(isoDate: string, months: number): string {
  return isoDateOf(addPeriod(new Date(`${isoDate}T00:00:00Z`), months, "months"));
}

function plusNotice(isoDate: string, notice: NonNullable<OptOutAgreement["noticePeriod"]>): string {
  return notice.unit === "days"
    ? plusDays(isoDate, notice.amount)
    : plusMonths(isoDate, notice.amount);
}

/**
 * The last day an opt-out is in force, or null while it has no end. Notice runs from the day
 * after it is given, for the agreement's own period (capped at the maximum) or the default; the
 * 48-hour limit applies again from the day after the notice ends.
 */
export function optOutLastDay(agreement: OptOutAgreement, rates: WorkingTimeRates): string | null {
  let last = agreement.endsOn;
  if (agreement.noticeGivenOn !== null) {
    const given = agreement.noticeGivenOn;
    const cap = plusMonths(given, rates.optOutMaxNoticeMonths);
    const notice = agreement.noticePeriod;
    const byAgreement =
      notice && notice.amount > 0
        ? plusNotice(given, notice)
        : plusDays(given, rates.optOutDefaultNoticeDays);
    const end = byAgreement < cap ? byAgreement : cap;
    if (last === null || end < last) last = end;
  }
  return last;
}

/** True when any of the worker's opt-outs is in force on an ISO date. */
export function optOutInForce(
  agreements: readonly OptOutAgreement[],
  isoDate: string,
  rates: WorkingTimeRates,
): boolean {
  return agreements.some((a) => {
    if (isoDate < a.signedOn) return false;
    const last = optOutLastDay(a, rates);
    return last === null || isoDate <= last;
  });
}

export type NightTimeIssue = "not_minutes_of_day" | "too_short" | "misses_core_hours";

/**
 * Checks night time set by an agreement (reg 2): at least the minimum length, and covering the
 * core hours (midnight to 5 a.m.). Measured on the clock face of an ordinary night.
 */
export function checkNightTime(night: NightTime, rates: WorkingTimeRates): NightTimeIssue[] {
  const valid = (m: number) => Number.isInteger(m) && m >= 0 && m < MINUTES_PER_DAY;
  if (!valid(night.startMinute) || !valid(night.endMinute)) return ["not_minutes_of_day"];
  const issues: NightTimeIssue[] = [];
  const length = minutesAfter(night.startMinute, night.endMinute) || MINUTES_PER_DAY;
  if (length < rates.nightMinHours * MINUTES_PER_HOUR) issues.push("too_short");
  const coreStart = minutesAfter(night.startMinute, rates.nightCoreStartMinute);
  const coreLength = minutesAfter(rates.nightCoreStartMinute, rates.nightCoreEndMinute);
  if (coreStart + coreLength > length) issues.push("misses_core_hours");
  return issues;
}

/** Minutes from one minute of the day to the next time the clock shows another. */
function minutesAfter(from: number, to: number): number {
  return (to - from + MINUTES_PER_DAY) % MINUTES_PER_DAY;
}

/** The night time in force: the agreed one if valid, else the default; an invalid one throws. */
export function nightTimeFor(setting: WorkingTimeSetting, rates: WorkingTimeRates): NightTime {
  const agreed = setting.agreedNightTime;
  if (agreed === null) {
    return { startMinute: rates.nightDefaultStartMinute, endMinute: rates.nightDefaultEndMinute };
  }
  const issues = checkNightTime(agreed, rates);
  if (issues.length > 0)
    throw new RangeError(`Agreed night time is not valid: ${issues.join(", ")}.`);
  return agreed;
}

function agreedWeeks(weeks: number | null, rates: WorkingTimeRates): number | null {
  if (weeks === null) return null;
  if (!Number.isInteger(weeks) || weeks < 1 || weeks > rates.agreementMaxReferencePeriodWeeks) {
    throw new RangeError(
      "An agreed reference period must be a whole number of weeks up to the maximum.",
    );
  }
  return weeks;
}

/**
 * Weeks in the 48-hour reference period (reg 4(3), (5), 23(b)): an agreement's figure up to the
 * maximum; otherwise the longer special-case period where reg 21 applies; otherwise the standard.
 */
export function weeklyAverageReferenceWeeks(
  setting: WorkingTimeSetting,
  rates: WorkingTimeRates,
): number {
  const agreed = agreedWeeks(setting.agreedReferencePeriodWeeks, rates);
  if (agreed !== null) return agreed;
  return setting.derogations.includes("special_case")
    ? rates.specialCaseReferencePeriodWeeks
    : rates.referencePeriodWeeks;
}

/** Weeks in the night work reference period (reg 6(3)): an agreement's figure, else the standard. */
export function nightAverageReferenceWeeks(
  setting: WorkingTimeSetting,
  rates: WorkingTimeRates,
): number {
  return (
    agreedWeeks(setting.agreedNightReferencePeriodWeeks, rates) ?? rates.nightReferencePeriodWeeks
  );
}
