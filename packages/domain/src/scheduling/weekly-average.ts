/**
 * The 48-hour average (Working Time Regulations 1998, regulation 4; scheduling.md rule 1),
 * calculated exactly as regulation 4(6) says: (A + B) / C, where A is working time in the
 * reference period, B is working time after it on as many days worked as there were excluded
 * days in it (statutory annual leave, sick leave, maternity, paternity, adoption and parental
 * leave, and days under an opt-out), and C is the number of weeks. Excluded days are neither
 * counted as zero hours nor simply dropped: later days stand in for them. Hours worked on a day
 * under an opt-out are left out of A, since the later days already stand in for that day.
 */

import { optOutInForce, weeklyAverageReferenceWeeks } from "./agreements";
import { datesFrom, MINUTES_PER_HOUR, plusDays, ukDateOf } from "./intervals";
import {
  idsIn,
  minutesByUkDate,
  type PreparedPeriod,
  preparePeriods,
  referenceWindows,
  windowRuns,
  windowSpan,
} from "./prepared";
import type { WorkingTimeRates } from "./rates";
import {
  type ExcludedDay,
  type TimeSpan,
  WORKING_TIME_CITATIONS,
  type WorkingTimeFinding,
  type WorkingTimeSetting,
  type WorkingTimeWorker,
  type WorkPeriod,
} from "./working-time-types";

/**
 * `over`: the average is above the limit (already, even if hours are still to come).
 * `provisional`: within the limit so far, but the window or the days standing in for excluded
 * days are not all known yet. `opted_out`: an opt-out covered every day of the window.
 */
export type WeeklyAverageStatus = "within" | "over" | "opted_out" | "provisional";

export interface WeeklyAverageWindow {
  readonly from: string;
  readonly to: string;
  /** C: weeks in the reference period. */
  readonly weeks: number;
  /** A: working time in the reference period, in minutes. */
  readonly workedMinutes: number;
  readonly excludedDays: number;
  /** B: working time on the days standing in for excluded days, in minutes. */
  readonly followingMinutes: number;
  /** Days worked found so far after the period (complete when it equals `excludedDays`). */
  readonly followingDays: number;
  readonly complete: boolean;
  /** (A + B) / C, in minutes per week. */
  readonly averageMinutes: number;
  readonly status: WeeklyAverageStatus;
}

export interface WeeklyAverageInput {
  readonly periods: readonly WorkPeriod[];
  readonly worker: WorkingTimeWorker;
  readonly setting: WorkingTimeSetting;
  readonly excludedDays: readonly ExcludedDay[];
  /** ISO dates: the reference periods ending on these days are checked. */
  readonly evaluateFrom: string;
  readonly evaluateTo: string;
  /** The time over which the worker's hours are fully known (planned or recorded). */
  readonly known: TimeSpan;
  readonly rates: WorkingTimeRates;
}

export function weeklyAverageWindows(input: WeeklyAverageInput): WeeklyAverageWindow[] {
  const own = preparePeriods(input.periods).filter((p) => p.own);
  const { rates, setting, worker } = input;
  const weeks = weeklyAverageReferenceWeeks(setting, rates);
  const limit = rates.weeklyMaxHours * MINUTES_PER_HOUR;
  const byDate = minutesByUkDate(own);
  const workedDates = [...byDate.entries()]
    .filter(([, m]) => m > 0)
    .map(([d]) => d)
    .sort();
  const lastWorked = workedDates[workedDates.length - 1] ?? "";
  const lastKnown = ukDateOf(new Date(input.known.end.getTime() - 1));
  const leaveDates = new Set(input.excludedDays.map((d) => d.date));
  const windows = referenceWindows(
    worker.employmentStart,
    weeks,
    setting.successiveReferencePeriodsFrom,
    input.evaluateFrom,
    input.evaluateTo,
  );
  return windows.map((w) => {
    const dates = datesFrom(w.from, w.to);
    const optedOut = new Set(dates.filter((d) => optOutInForce(worker.optOuts, d, rates)));
    const excluded = new Set([...dates.filter((d) => leaveDates.has(d)), ...optedOut]).size;
    // Days under an opt-out are excluded days: their hours are replaced by later days, never
    // counted in A as well (scheduling.md rule 2; the adviser confirms the reading, H-580).
    const worked = dates
      .filter((d) => !optedOut.has(d))
      .reduce((sum, d) => sum + (byDate.get(d) ?? 0), 0);
    let followingMinutes = 0;
    let followingDays = 0;
    for (
      let d = plusDays(w.to, 1);
      followingDays < excluded && d <= lastKnown && d <= lastWorked;
      d = plusDays(d, 1)
    ) {
      const minutes = byDate.get(d) ?? 0;
      if (minutes > 0) {
        followingDays += 1;
        followingMinutes += minutes;
      }
    }
    const span = windowSpan(w);
    const complete =
      followingDays === excluded && input.known.start <= span.start && input.known.end >= span.end;
    const averageMinutes = (worked + followingMinutes) / w.weeks;
    const status: WeeklyAverageStatus =
      optedOut.size === dates.length
        ? "opted_out"
        : averageMinutes > limit
          ? "over"
          : complete
            ? "within"
            : "provisional";
    return {
      from: w.from,
      to: w.to,
      weeks: w.weeks,
      workedMinutes: worked,
      excludedDays: excluded,
      followingMinutes,
      followingDays,
      complete,
      averageMinutes,
      status,
    };
  });
}

/** One finding per run of overlapping reference periods whose average is over the limit. */
export function weeklyAverageFindings(
  windows: readonly WeeklyAverageWindow[],
  own: readonly PreparedPeriod[],
  rates: WorkingTimeRates,
): WorkingTimeFinding[] {
  const runs = windowRuns(
    windows.filter((w) => w.status === "over"),
    (w) => w.averageMinutes,
  );
  return runs.map((run) => {
    const span = windowSpan(run);
    return {
      rule: "weekly_average",
      citation: WORKING_TIME_CITATIONS.weekly_average,
      outcome: "breach",
      conditions: [],
      basis: null,
      from: span.start,
      to: span.end,
      limitMinutes: rates.weeklyMaxHours * MINUTES_PER_HOUR,
      actualMinutes: run.worst,
      compensatoryRestMinutes: 0,
      periodIds: idsIn(own, span),
    };
  });
}
