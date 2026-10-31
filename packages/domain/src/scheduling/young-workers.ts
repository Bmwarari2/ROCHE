/**
 * Young workers (Working Time Regulations 1998, regulations 2, 5A, 6A and 27A; scheduling.md
 * rule 8). A worker is a young worker until 00:00 UK time on the birthday in the rate table, and
 * only their time before that instant is checked against these limits. The daily and weekly
 * limits are absolute, not averages; they count hours for every employer; the week starts at
 * midnight between Sunday and Monday; and no opt-out lifts them.
 */

import {
  birthdayInstant,
  clip,
  DAYS_PER_WEEK,
  dailyWindows,
  datesFrom,
  MINUTES_PER_HOUR,
  mondayOnOrBefore,
  plusDays,
  type Span,
  ukDay,
  ukDays,
} from "./intervals";
import { exceptionHolds, idsIn, netMinutesIn, type PreparedPeriod } from "./prepared";
import type { WorkingTimeRates } from "./rates";
import {
  WORKING_TIME_CITATIONS,
  type WorkingTimeFinding,
  type WorkingTimeRule,
  type WorkingTimeSetting,
  type WorkingTimeWorker,
} from "./working-time-types";

/** When the young worker rules stop applying to a worker. */
export function youngWorkerUntil(worker: WorkingTimeWorker, rates: WorkingTimeRates): Date {
  return birthdayInstant(worker.dateOfBirth, rates.youngUntilAgeYears);
}

export interface YoungContext {
  readonly prepared: readonly PreparedPeriod[];
  readonly worker: WorkingTimeWorker;
  readonly setting: WorkingTimeSetting;
  readonly rates: WorkingTimeRates;
  readonly evaluateFrom: string;
  readonly evaluateTo: string;
}

function maxFinding(
  rule: WorkingTimeRule,
  span: Span,
  limit: number,
  actual: number,
  own: readonly PreparedPeriod[],
): WorkingTimeFinding {
  const excepted = own.some(
    (p) =>
      p.net.some((s) => clip(s, span)) &&
      exceptionHolds(p.period.youngWorkerException, "continuity_or_surge"),
  );
  return {
    rule,
    citation: WORKING_TIME_CITATIONS[rule],
    outcome: excepted ? "conditional" : "breach",
    conditions: excepted ? ["reason_recorded"] : [],
    basis: excepted ? "continuity_or_surge" : null,
    from: span.start,
    to: span.end,
    limitMinutes: limit,
    actualMinutes: actual,
    compensatoryRestMinutes: 0,
    periodIds: idsIn(own, span),
  };
}

/**
 * The daily and weekly limits (reg 5A), counting hours for other employers, unless the work was
 * needed for continuity of service or a surge in demand with no adult available and education
 * unaffected (reg 27A(1)), recorded with its reason.
 */
export function youngMaxHoursFindings(ctx: YoungContext): WorkingTimeFinding[] {
  const until = youngWorkerUntil(ctx.worker, ctx.rates);
  const own = ctx.prepared.filter((p) => p.own);
  const findings: WorkingTimeFinding[] = [];
  const daily = ctx.rates.youngDailyMaxHours * MINUTES_PER_HOUR;
  for (const date of datesFrom(ctx.evaluateFrom, ctx.evaluateTo)) {
    const span = youngPart(ukDay(date), until);
    if (!span) continue;
    const minutes = netMinutesIn(ctx.prepared, span);
    if (minutes > daily) findings.push(maxFinding("young_daily_max", span, daily, minutes, own));
  }
  const weekly = ctx.rates.youngWeeklyMaxHours * MINUTES_PER_HOUR;
  for (
    let monday = mondayOnOrBefore(ctx.evaluateFrom);
    monday <= ctx.evaluateTo;
    monday = plusDays(monday, DAYS_PER_WEEK)
  ) {
    const span = youngPart(ukDays(monday, plusDays(monday, DAYS_PER_WEEK - 1)), until);
    if (!span) continue;
    const minutes = netMinutesIn(ctx.prepared, span);
    if (minutes > weekly) findings.push(maxFinding("young_weekly_max", span, weekly, minutes, own));
  }
  return findings;
}

function youngPart(span: Span, until: Date): Span | null {
  return span.start < until
    ? { start: span.start, end: span.end < until ? span.end : until }
    : null;
}

/**
 * No work in the restricted period (reg 6A): 22:00 to 06:00, or 23:00 to 07:00 where the
 * contract provides for work after 22:00. Only in a hospital or similar establishment, in the
 * reg 27A(1) circumstances recorded on every period worked in it, is it allowed, and then with
 * adult supervision where needed and equivalent compensatory rest (reg 27A(4)).
 */
export function youngRestrictedPeriodFindings(ctx: YoungContext): WorkingTimeFinding[] {
  const until = youngWorkerUntil(ctx.worker, ctx.rates);
  const own = ctx.prepared.filter((p) => p.own);
  const late = ctx.worker.contractProvidesWorkAfter22;
  const start = late
    ? ctx.rates.youngRestrictedLateStartMinute
    : ctx.rates.youngRestrictedStartMinute;
  const end = late ? ctx.rates.youngRestrictedLateEndMinute : ctx.rates.youngRestrictedEndMinute;
  const range = youngPart(ukDays(ctx.evaluateFrom, ctx.evaluateTo), until);
  if (!range) return [];
  const findings: WorkingTimeFinding[] = [];
  for (const window of dailyWindows(range, start, end)) {
    const restricted = youngPart(window, until) as Span;
    const minutes = netMinutesIn(own, restricted);
    if (minutes === 0) continue;
    const involved = own.filter((p) => p.net.some((s) => clip(s, restricted)));
    const excepted =
      ctx.setting.hospitalOrSimilarEstablishment &&
      involved.every((p) => exceptionHolds(p.period.youngWorkerException, "continuity_or_surge"));
    findings.push({
      rule: "young_restricted_period",
      citation: WORKING_TIME_CITATIONS.young_restricted_period,
      outcome: excepted ? "conditional" : "breach",
      conditions: excepted ? ["adult_supervision", "compensatory_rest"] : [],
      basis: excepted ? "continuity_or_surge" : null,
      from: restricted.start,
      to: restricted.end,
      limitMinutes: 0,
      actualMinutes: minutes,
      compensatoryRestMinutes: excepted ? minutes : 0,
      periodIds: involved.map((p) => p.period.id),
    });
  }
  return findings;
}
