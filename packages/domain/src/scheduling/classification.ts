/**
 * What counts as working time, and what counts towards the national minimum wage
 * (scheduling.md rules 9 and 10). The two differ, and confusing them is the commonest mistake:
 * - A sleep-in is time on call at the workplace, so all of it is working time for the Working
 *   Time Regulations (gov.uk "Calculating your working hours"), while for the minimum wage only
 *   time awake for the purposes of working counts when the worker is expected to sleep and has
 *   suitable sleeping facilities (Royal Mencap Society v Tomlinson-Blake [2021] UKSC 8); otherwise
 *   the whole shift counts.
 * - Travel between visits is working time and minimum-wage time. Home to the first visit and the
 *   last visit to home are working time for a worker with no fixed place of work, but not
 *   minimum-wage time. Commuting to a fixed workplace is neither.
 */

import { clip, mergeSpans, type Span, spanMinutes, subtractSpans } from "./intervals";
import type { TimeSpan, TravelKind, WorkPeriod, WorkPeriodKind } from "./working-time-types";

/** How the minimum wage treats a period: all of it, only the awake times, or none of it. */
export type NmwTreatment = "whole" | "awake_only" | "none";

export interface WorkingTimeClass {
  /** Counts as working time under the Working Time Regulations. */
  readonly workingTime: boolean;
  readonly nmw: NmwTreatment;
  /** Where the rule comes from, for the working shown on screen. */
  readonly source: string;
}

const KIND_CLASSES: Readonly<
  Record<Exclude<WorkPeriodKind, "travel" | "sleep_in">, WorkingTimeClass>
> = {
  work: { workingTime: true, nmw: "whole", source: "WTR 1998 reg 2 (working time)" },
  training: { workingTime: true, nmw: "whole", source: "WTR 1998 reg 2(b) (relevant training)" },
  on_call_at_workplace: {
    workingTime: true,
    nmw: "whole",
    source: "gov.uk: time on call at the workplace counts as work",
  },
  on_call_away: {
    workingTime: false,
    nmw: "none",
    source: "gov.uk: time on call away from the workplace does not count; call-outs do",
  },
};

const TRAVEL_CLASSES: Readonly<Record<TravelKind, WorkingTimeClass>> = {
  between_assignments: {
    workingTime: true,
    nmw: "whole",
    source: "gov.uk minimum wage guidance: travel from one assignment to another is working time",
  },
  home_to_first_assignment: {
    workingTime: true,
    nmw: "none",
    source:
      "gov.uk: travel between home and work counts with no fixed place of work; not minimum-wage time",
  },
  last_assignment_to_home: {
    workingTime: true,
    nmw: "none",
    source:
      "gov.uk: travel between home and work counts with no fixed place of work; not minimum-wage time",
  },
  commute_to_fixed_workplace: {
    workingTime: false,
    nmw: "none",
    source: "gov.uk: travel to and from a fixed place of work is commuting",
  },
};

const SLEEP_IN_ASLEEP_PERMITTED: WorkingTimeClass = {
  workingTime: true,
  nmw: "awake_only",
  source:
    "Working time: on call at the workplace. Minimum wage: awake for working only (Mencap 2021)",
};

const SLEEP_IN_WHOLE: WorkingTimeClass = {
  workingTime: true,
  nmw: "whole",
  source:
    "Working time: on call at the workplace. Minimum wage: the whole shift, as the worker is expected to work most of it or has no suitable sleeping facilities",
};

/** Throws a `RangeError` when a period cannot be checked (the caller's data is wrong). */
export function assertValidPeriod(period: WorkPeriod): void {
  if (!(period.end > period.start)) {
    throw new RangeError(`Period ${period.id} must end after it starts.`);
  }
  if (period.kind === "travel" && !period.travel) {
    throw new RangeError(`Travel period ${period.id} must say which journey it was.`);
  }
  if (period.kind === "sleep_in" && !period.sleepIn) {
    throw new RangeError(`Sleep-in ${period.id} must say whether sleep is expected.`);
  }
  for (const inner of [...(period.breaks ?? []), ...(period.sleepIn?.awake ?? [])]) {
    if (!(inner.end > inner.start) || inner.start < period.start || inner.end > period.end) {
      throw new RangeError(`Period ${period.id} has a break or awake time outside it.`);
    }
  }
}

export function classifyWorkingTime(period: WorkPeriod): WorkingTimeClass {
  assertValidPeriod(period);
  if (period.kind === "travel") return TRAVEL_CLASSES[period.travel as TravelKind];
  if (period.kind === "sleep_in") {
    const detail = period.sleepIn;
    return detail?.expectedToSleep && detail.suitableSleepingFacilities
      ? SLEEP_IN_ASLEEP_PERMITTED
      : SLEEP_IN_WHOLE;
  }
  return KIND_CLASSES[period.kind];
}

/** The period's working time with its breaks taken out (empty when it is not working time). */
export function netWorkingSpans(period: WorkPeriod): Span[] {
  if (!classifyWorkingTime(period).workingTime) return [];
  return subtractSpans(period, period.breaks ?? []);
}

/** Working time in minutes, elapsed (a shift over a clock change is an hour longer or shorter). */
export function workingMinutes(period: WorkPeriod): number {
  return netWorkingSpans(period).reduce((sum, s) => sum + spanMinutes(s), 0);
}

/** The parts of a period that count towards the national minimum wage. */
function nmwSpans(period: WorkPeriod): Span[] {
  const treatment = classifyWorkingTime(period).nmw;
  if (treatment === "none") return [];
  if (treatment === "whole") return netWorkingSpans(period);
  const awake = (period.sleepIn?.awake ?? [])
    .map((s) => clip(s, period))
    .filter((s): s is Span => s !== null);
  return mergeSpans(awake);
}

/**
 * Minutes that count towards the national minimum wage. A sleep-in counts only its awake times
 * when sleep is permitted; overlapping awake entries are counted once.
 */
export function nmwMinutes(period: WorkPeriod): number {
  return nmwSpans(period).reduce((sum, s) => sum + spanMinutes(s), 0);
}

/**
 * The minutes that count towards the minimum wage in a pay reference period (the hours the pay
 * rules' `nmwCheck` takes): this employer's periods only, clipped to the period, with part
 * minutes rounded up so the hours are never understated.
 */
export function nmwMinutesIn(periods: readonly WorkPeriod[], payReferencePeriod: TimeSpan): number {
  let total = 0;
  for (const period of periods) {
    if ((period.employer ?? "this") !== "this") continue;
    for (const span of nmwSpans(period)) {
      const part = clip(span, payReferencePeriod);
      if (part) total += spanMinutes(part);
    }
  }
  return Math.ceil(total);
}
