/**
 * Night work (Working Time Regulations 1998, regulations 2 and 6; scheduling.md rule 7). Night
 * time is UK wall-clock time (23:00 to 06:00 unless an agreement sets another), so the night the
 * clocks go back holds 8 hours of it and the night they go forward 6. No opt-out lifts the night
 * limits, and leave is not taken out of the night average (unlike the 48-hour average).
 */

import { nightAverageReferenceWeeks, nightTimeFor } from "./agreements";
import {
  clip,
  DAYS_PER_WEEK,
  dailyWindows,
  daysFrom,
  HOURS_PER_DAY,
  longestFreeMinutes,
  MINUTES_PER_DAY,
  MINUTES_PER_HOUR,
  mondayOnOrBefore,
  overlapMinutes,
  plusDays,
  plusMinutes,
  type Span,
  ukDateOf,
  ukDays,
} from "./intervals";
import {
  busySpans,
  duties,
  idsIn,
  netMinutesIn,
  type PreparedPeriod,
  referenceWindows,
  windowRuns,
  windowSpan,
} from "./prepared";
import type { WorkingTimeRates } from "./rates";
import {
  derogationFor,
  type NightTime,
  type TimeSpan,
  WORKING_TIME_CITATIONS,
  type WorkingTimeFinding,
  type WorkingTimeRule,
  type WorkingTimeSetting,
  type WorkingTimeWorker,
} from "./working-time-types";

export interface NightWorkerAssessment {
  readonly nightWorker: boolean;
  readonly basis: "designated" | "pattern";
  /** Days on which the worker worked, by the UK date each duty started. */
  readonly daysWorked: number;
  /** Of those, days with at least the minimum hours of working time in night time. */
  readonly nightDays: number;
}

/** Minutes of working time inside night time. */
export function nightMinutes(spans: readonly Span[], night: NightTime): number {
  let total = 0;
  for (const span of spans) {
    total += overlapMinutes(dailyWindows(span, night.startMinute, night.endMinute), span);
  }
  return total;
}

/**
 * A night worker works at least the minimum hours of their daily working time in night time "as
 * a normal course", which reg 2 says means on the majority of the days they work; or is one by
 * contract or agreement.
 */
export function assessNightWorker(
  own: readonly PreparedPeriod[],
  worker: WorkingTimeWorker,
  night: NightTime,
  window: Span,
  rates: WorkingTimeRates,
): NightWorkerAssessment {
  const perDay = new Map<string, number>();
  for (const duty of duties(own)) {
    if (!clip(duty, window)) continue;
    const day = ukDateOf(duty.start);
    const spans = duty.members.flatMap((m) => m.net);
    perDay.set(day, (perDay.get(day) ?? 0) + nightMinutes(spans, night));
  }
  const threshold = rates.nightWorkerMinNightHours * MINUTES_PER_HOUR;
  const nightDays = [...perDay.values()].filter((m) => m >= threshold).length;
  const daysWorked = perDay.size;
  if (worker.designatedNightWorker) {
    return { nightWorker: true, basis: "designated", daysWorked, nightDays };
  }
  // why: "the majority of days" means more than half, so twice the count beats the total.
  const MAJORITY_FACTOR = 2;
  return {
    nightWorker: nightDays * MAJORITY_FACTOR > daysWorked,
    basis: "pattern",
    daysWorked,
    nightDays,
  };
}

export interface NightAverageWindow {
  readonly from: string;
  readonly to: string;
  readonly weeks: number;
  /** A: normal working hours in the period (occasional overtime left out), in minutes. */
  readonly normalMinutes: number;
  /** B: days in the period. */
  readonly days: number;
  /** C: hours of weekly rest taken under reg 11, divided by 24. */
  readonly weeklyRestDays: number;
  /** A / (B - C): minutes per 24 hours. */
  readonly averageMinutes: number;
  readonly complete: boolean;
  readonly over: boolean;
}

export interface NightContext {
  readonly prepared: readonly PreparedPeriod[];
  readonly worker: WorkingTimeWorker;
  readonly setting: WorkingTimeSetting;
  readonly rates: WorkingTimeRates;
  readonly evaluateFrom: string;
  readonly evaluateTo: string;
  readonly known: TimeSpan;
}

/**
 * Regulation 6(5): the average is A / (B - C). C counts, in each week, the longest rest up to the
 * weekly rest entitlement, so rest not taken is never subtracted.
 */
export function nightAverageWindows(ctx: NightContext): NightAverageWindow[] {
  const own = ctx.prepared.filter((p) => p.own);
  const normal = own.filter((p) => !p.period.occasionalOvertime);
  const busy = busySpans(own);
  const weeks = nightAverageReferenceWeeks(ctx.setting, ctx.rates);
  const limit = ctx.rates.nightAverageMaxHours * MINUTES_PER_HOUR;
  const weeklyRest = ctx.rates.weeklyRestHours * MINUTES_PER_HOUR;
  const anchor = ctx.setting.weeklyRestPeriodsFrom ?? mondayOnOrBefore(ctx.worker.employmentStart);
  return referenceWindows(
    ctx.worker.employmentStart,
    weeks,
    ctx.setting.successiveReferencePeriodsFrom,
    ctx.evaluateFrom,
    ctx.evaluateTo,
  ).map((w) => {
    const span = windowSpan(w);
    const days = daysFrom(w.from, w.to) + 1;
    let restMinutes = 0;
    const first = Math.floor(daysFrom(anchor, w.from) / DAYS_PER_WEEK);
    const last = Math.floor(daysFrom(anchor, w.to) / DAYS_PER_WEEK);
    for (let k = first; k <= last; k++) {
      const from = plusDays(anchor, k * DAYS_PER_WEEK);
      const block = clip(ukDays(from, plusDays(from, DAYS_PER_WEEK - 1)), span) as Span;
      restMinutes += Math.min(longestFreeMinutes(busy, block), weeklyRest);
    }
    const weeklyRestDays = restMinutes / MINUTES_PER_DAY;
    const normalMinutes = netMinutesIn(normal, span);
    const averageMinutes = normalMinutes / (days - weeklyRestDays);
    return {
      from: w.from,
      to: w.to,
      weeks: w.weeks,
      normalMinutes,
      days,
      weeklyRestDays,
      averageMinutes,
      complete: ctx.known.start <= span.start && ctx.known.end >= span.end,
      over: averageMinutes > limit,
    };
  });
}

function nightFinding(
  rule: WorkingTimeRule,
  span: Span,
  limit: number,
  actual: number,
  ids: readonly string[],
  setting: WorkingTimeSetting,
): WorkingTimeFinding {
  const basis = derogationFor(rule, setting.derogations);
  return {
    rule,
    citation: WORKING_TIME_CITATIONS[rule],
    outcome: basis ? "conditional" : "breach",
    conditions: basis ? ["health_and_safety_protection"] : [],
    basis,
    from: span.start,
    to: span.end,
    limitMinutes: limit,
    actualMinutes: actual,
    compensatoryRestMinutes: 0,
    periodIds: ids,
  };
}

export function nightAverageFindings(
  windows: readonly NightAverageWindow[],
  own: readonly PreparedPeriod[],
  ctx: NightContext,
): WorkingTimeFinding[] {
  const runs = windowRuns(
    windows.filter((w) => w.over),
    (w) => w.averageMinutes,
  );
  const limit = ctx.rates.nightAverageMaxHours * MINUTES_PER_HOUR;
  return runs.map((run) => {
    const span = windowSpan(run);
    return nightFinding("night_average", span, limit, run.worst, idsIn(own, span), ctx.setting);
  });
}

/**
 * Special hazards (reg 6(7)): no more than the limit in any 24 hours in which the night worker
 * works at night. The busiest 24 hours start as a spell of work starts or end as one ends.
 */
export function nightHazardFindings(ctx: NightContext, range: Span): WorkingTimeFinding[] {
  const own = ctx.prepared.filter((p) => p.own);
  const night = nightTimeFor(ctx.setting, ctx.rates);
  const limit = ctx.rates.nightHazardMaxHours * MINUTES_PER_HOUR;
  const spans = own.flatMap((p) => p.net);
  const anchors = spans
    .flatMap((s) => [s.start, plusMinutes(s.end, -MINUTES_PER_DAY)])
    .sort((a, b) => a.getTime() - b.getTime());
  const runs: { start: Date; end: Date; worst: number }[] = [];
  for (const anchor of anchors) {
    const window = { start: anchor, end: plusMinutes(anchor, HOURS_PER_DAY * MINUTES_PER_HOUR) };
    if (!clip(window, range)) continue;
    const worked = netMinutesIn(own, window);
    if (worked <= limit) continue;
    const inWindow = spans.map((s) => clip(s, window)).filter((s): s is Span => s !== null);
    if (nightMinutes(inWindow, night) === 0) continue;
    const last = runs[runs.length - 1];
    if (last && window.start < last.end) {
      if (window.end > last.end) last.end = window.end;
      last.worst = Math.max(last.worst, worked);
    } else {
      runs.push({ start: window.start, end: window.end, worst: worked });
    }
  }
  return runs.map((run) =>
    nightFinding("night_hazard", run, limit, run.worst, idsIn(own, run), ctx.setting),
  );
}
