/**
 * Daily rest, weekly rest and rest breaks (Working Time Regulations 1998, regulations 10 to 12;
 * scheduling.md rules 4 and 5), for adults and young workers. Rest is measured in elapsed time:
 * 20:00 to 07:00 is 10 hours on the night the clocks go forward, although the clock face says
 * 11. A rest break inside a shift is not a rest period, and a sleep-in is working time, so
 * neither counts as rest.
 */

import {
  clip,
  DAYS_PER_WEEK,
  daysFrom,
  longestFreeMinutes,
  MINUTES_PER_DAY,
  MINUTES_PER_HOUR,
  mondayOnOrBefore,
  plusDays,
  plusMinutes,
  type Span,
  spanMinutes,
  ukDateOf,
  ukDays,
} from "./intervals";
import {
  busySpans,
  duties,
  exceptionHolds,
  idsIn,
  netMinutesIn,
  type PreparedPeriod,
} from "./prepared";
import type { WorkingTimeRates } from "./rates";
import {
  type AdultDerogationBasis,
  derogationFor,
  WORKING_TIME_CITATIONS,
  type WorkingTimeFinding,
  type WorkingTimeRule,
  type WorkingTimeSetting,
  type WorkingTimeWorker,
  type YoungWorkerException,
} from "./working-time-types";

export interface RestContext {
  /** Prepared periods for this employer and, for young workers, others. */
  readonly prepared: readonly PreparedPeriod[];
  readonly worker: WorkingTimeWorker;
  readonly setting: WorkingTimeSetting;
  readonly rates: WorkingTimeRates;
  /** The UK days whose rules are checked. */
  readonly range: Span;
  /** When the young worker rules stop applying. */
  readonly youngUntil: Date;
}

interface Candidate {
  from: Date;
  to: Date;
  actual: number;
  ids: Set<string>;
}

function finding(
  rule: WorkingTimeRule,
  c: { from: Date; to: Date; actual: number; ids: Iterable<string> },
  limit: number,
  outcome:
    | { kind: "breach" }
    | { kind: "derogated"; basis: AdultDerogationBasis; compensatory: number }
    | { kind: "excepted"; basis: YoungWorkerException["basis"] | null },
): WorkingTimeFinding {
  const base = {
    rule,
    citation: WORKING_TIME_CITATIONS[rule],
    from: c.from,
    to: c.to,
    limitMinutes: limit,
    actualMinutes: c.actual,
    periodIds: [...c.ids],
  };
  if (outcome.kind === "breach") {
    return { ...base, outcome: "breach", conditions: [], basis: null, compensatoryRestMinutes: 0 };
  }
  if (outcome.kind === "derogated") {
    return {
      ...base,
      outcome: "conditional",
      conditions: ["compensatory_rest"],
      basis: outcome.basis,
      compensatoryRestMinutes: outcome.compensatory,
    };
  }
  return {
    ...base,
    outcome: "conditional",
    conditions: ["reason_recorded"],
    basis: outcome.basis,
    compensatoryRestMinutes: 0,
  };
}

function hasException(
  prepared: readonly PreparedPeriod[],
  window: Span,
  basis: YoungWorkerException["basis"],
): boolean {
  return prepared.some(
    (p) =>
      p.own &&
      p.net.some((s) => clip(s, window)) &&
      exceptionHolds(p.period.youngWorkerException, basis),
  );
}

/**
 * Daily rest (reg 10): in each 24 hours from the start of a spell of work there must be a rest
 * of the minimum length (11 consecutive hours, 12 for a young worker). Windows that overlap are
 * reported once.
 */
export function dailyRestFindings(ctx: RestContext): WorkingTimeFinding[] {
  const own = ctx.prepared.filter((p) => p.own);
  const busy = busySpans(own);
  const findings: WorkingTimeFinding[] = [];
  for (const young of [true, false]) {
    const required =
      (young ? ctx.rates.youngDailyRestHours : ctx.rates.dailyRestHours) * MINUTES_PER_HOUR;
    const candidates: Candidate[] = [];
    for (const spell of busy) {
      const anchor = spell.start;
      if (!clip({ start: anchor, end: plusMinutes(anchor, 1) }, ctx.range)) continue;
      if (young !== anchor < ctx.youngUntil) continue;
      const window = { start: anchor, end: plusMinutes(anchor, MINUTES_PER_DAY) };
      const free = longestFreeMinutes(busy, window);
      if (free >= required) continue;
      const last = candidates[candidates.length - 1];
      const ids = idsIn(own, window);
      if (last && window.start < last.to) {
        last.to = window.end;
        last.actual = Math.min(last.actual, free);
        for (const id of ids) last.ids.add(id);
      } else {
        candidates.push({ from: window.start, to: window.end, actual: free, ids: new Set(ids) });
      }
    }
    for (const c of candidates) {
      const window = { start: c.from, end: c.to };
      if (young) {
        findings.push(
          finding(
            "young_daily_rest",
            c,
            required,
            hasException(own, window, "split_or_short_duration")
              ? { kind: "excepted", basis: "split_or_short_duration" }
              : { kind: "breach" },
          ),
        );
      } else {
        const basis = derogationFor("daily_rest", ctx.setting.derogations);
        findings.push(
          finding(
            "daily_rest",
            c,
            required,
            basis
              ? { kind: "derogated", basis, compensatory: required - c.actual }
              : { kind: "breach" },
          ),
        );
      }
    }
  }
  return findings;
}

interface Rest {
  readonly start: Date | null;
  readonly end: Date | null;
}

function restsAround(busy: readonly Span[]): Rest[] {
  const rests: Rest[] = [];
  let previous: Date | null = null;
  for (const spell of busy) {
    rests.push({ start: previous, end: spell.start });
    previous = spell.end;
  }
  rests.push({ start: previous, end: null });
  return rests;
}

/** Minutes of a rest inside a block, and its whole length (Infinity when open-ended). */
function restParts(rest: Rest, block: Span): { inside: number; whole: number } {
  const part = clip({ start: rest.start ?? block.start, end: rest.end ?? block.end }, block);
  const whole =
    rest.start && rest.end ? spanMinutes({ start: rest.start, end: rest.end }) : Infinity;
  return { inside: part ? spanMinutes(part) : 0, whole };
}

/**
 * Weekly rest (reg 11). Periods start each Monday at 00:00 UK time (or as an agreement sets),
 * for a fortnight from the week employment began where the employer chose fortnightly rest.
 * An adult's weekly rest may not include the daily rest (reg 11(7)) unless the setting records
 * the reasons that allow it, so a rest must run the weekly figure plus the daily figure in all.
 */
export function weeklyRestFindings(ctx: RestContext): WorkingTimeFinding[] {
  const own = ctx.prepared.filter((p) => p.own);
  const busy = busySpans(own);
  const rests = restsAround(busy);
  const anchor = ctx.setting.weeklyRestPeriodsFrom ?? mondayOnOrBefore(ctx.worker.employmentStart);
  const findings: WorkingTimeFinding[] = [];
  const rangeFrom = ukDateOf(ctx.range.start);
  const rangeTo = ukDateOf(new Date(ctx.range.end.getTime() - 1));
  for (const young of [true, false]) {
    const fortnightly = !young && ctx.setting.weeklyRestBasis === "each_fortnight";
    const length = fortnightly ? FORTNIGHT_WEEKS * DAYS_PER_WEEK : DAYS_PER_WEEK;
    const first = Math.floor(daysFrom(anchor, rangeFrom) / length);
    const last = Math.floor(daysFrom(anchor, rangeTo) / length);
    for (let k = first; k <= last; k++) {
      const from = plusDays(anchor, k * length);
      const block = ukDays(from, plusDays(from, length - 1));
      if (young !== block.start < ctx.youngUntil) continue;
      if (netMinutesIn(own, block) === 0) continue;
      const result: WeeklyRestShortfall | null = young
        ? youngWeeklyRest(rests, block, ctx.rates)
        : adultWeeklyRest(rests, block, fortnightly, ctx);
      if (!result) continue;
      const c = { from: block.start, to: block.end, actual: result.actual, ids: idsIn(own, block) };
      if (young) {
        const basis = (["technical_or_organisational", "split_or_short_duration"] as const).find(
          (b) => result.allowedBy?.includes(b) && hasException(own, block, b),
        );
        findings.push(
          finding(
            "young_weekly_rest",
            c,
            result.limit,
            basis ? { kind: "excepted", basis } : { kind: "breach" },
          ),
        );
      } else {
        const basis = derogationFor("weekly_rest", ctx.setting.derogations);
        findings.push(
          finding(
            "weekly_rest",
            c,
            result.limit,
            basis
              ? { kind: "derogated", basis, compensatory: result.limit - result.actual }
              : { kind: "breach" },
          ),
        );
      }
    }
  }
  return findings;
}

interface WeeklyRestShortfall {
  readonly limit: number;
  readonly actual: number;
  /** Young workers: the recorded reasons that could allow the shortfall (reg 11(8)). */
  readonly allowedBy?: readonly YoungWorkerException["basis"][];
}

// why: a fortnight is two weeks (reg 11(2) "14-day period"); the hours come from the rate table.
const FORTNIGHT_WEEKS = 2;

function adultWeeklyRest(
  rests: readonly Rest[],
  block: Span,
  fortnightly: boolean,
  ctx: RestContext,
): WeeklyRestShortfall | null {
  const weekly = ctx.rates.weeklyRestHours * MINUTES_PER_HOUR;
  const extra = ctx.setting.weeklyRestMayIncludeDailyRest
    ? 0
    : ctx.rates.dailyRestHours * MINUTES_PER_HOUR;
  const credits = rests
    .map((r) => restParts(r, block))
    .map((p) => Math.max(0, Math.min(p.inside, p.whole - extra)))
    .sort((a, b) => b - a);
  const [best = 0, second = 0] = credits;
  if (!fortnightly) return best >= weekly ? null : { limit: weekly, actual: best };
  const fortnight = ctx.rates.fortnightlyRestHours * MINUTES_PER_HOUR;
  if (best >= fortnight || second >= weekly) return null;
  return {
    limit: fortnight,
    actual: Math.max(best, Math.min(best, weekly) + Math.min(second, weekly)),
  };
}

/**
 * A young worker's 48 hours (reg 11(3)) may be reduced to the minimum for technical or
 * organisation reasons, or interrupted for split or short work (reg 11(8)), with the reason
 * recorded; adding up interrupted rest needs the full figure in all.
 */
function youngWeeklyRest(
  rests: readonly Rest[],
  block: Span,
  rates: WorkingTimeRates,
): WeeklyRestShortfall | null {
  const required = rates.youngWeeklyRestHours * MINUTES_PER_HOUR;
  const inside = rests.map((r) => restParts(r, block).inside).sort((a, b) => b - a);
  const best = inside[0] ?? 0;
  if (best >= required) return null;
  const allowedBy: YoungWorkerException["basis"][] = [];
  if (best >= rates.youngWeeklyRestReducedMinHours * MINUTES_PER_HOUR) {
    allowedBy.push("technical_or_organisational");
  }
  if (inside.reduce((sum, m) => sum + m, 0) >= required) allowedBy.push("split_or_short_duration");
  return { limit: required, actual: best, allowedBy };
}

/**
 * Rest breaks (reg 12). A duty of more than the threshold needs one uninterrupted break of the
 * minimum inside it (not at its start or end); two shorter breaks do not add up. A young
 * worker's threshold counts hours for other employers that day (reg 12(5)), and their break
 * should be one block "if possible": shorter breaks adding up are allowed with a reason.
 */
export function restBreakFindings(ctx: RestContext): WorkingTimeFinding[] {
  const own = ctx.prepared.filter((p) => p.own);
  const others = ctx.prepared.filter((p) => !p.own);
  const findings: WorkingTimeFinding[] = [];
  for (const duty of duties(own)) {
    if (!clip({ start: duty.start, end: plusMinutes(duty.start, 1) }, ctx.range)) continue;
    const young = duty.start < ctx.youngUntil;
    const longest = duty.breaks.reduce((m, b) => Math.max(m, spanMinutes(b)), 0);
    const total = duty.breaks.reduce((sum, b) => sum + spanMinutes(b), 0);
    const ids = duty.members.map((m) => m.period.id);
    const c = { from: duty.start, to: duty.end, actual: longest, ids };
    if (young) {
      const day = ukDays(ukDateOf(duty.start), ukDateOf(duty.start));
      const minutes = duty.minutes + netMinutesIn(others, day);
      const threshold = ctx.rates.youngBreakThresholdHours * MINUTES_PER_HOUR;
      const required = ctx.rates.youngBreakMinutes;
      if (minutes <= threshold || longest >= required) continue;
      findings.push(
        finding(
          "young_rest_break",
          c,
          required,
          total >= required ? { kind: "excepted", basis: null } : { kind: "breach" },
        ),
      );
    } else {
      const threshold = ctx.rates.breakThresholdHours * MINUTES_PER_HOUR;
      const required = ctx.rates.breakMinutes;
      if (duty.minutes <= threshold || longest >= required) continue;
      const basis = derogationFor("rest_break", ctx.setting.derogations);
      findings.push(
        finding(
          "rest_break",
          c,
          required,
          basis ? { kind: "derogated", basis, compensatory: required } : { kind: "breach" },
        ),
      );
    }
  }
  return findings;
}
