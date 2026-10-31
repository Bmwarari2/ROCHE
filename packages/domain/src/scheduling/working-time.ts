/**
 * Working Time compliance for one worker (SCHED-003; scheduling.md section 4). The rota checks a
 * planned week before it is published and time and attendance checks the recorded hours; both
 * call `checkWorkingTime` with the periods they hold. Hours are elapsed time; days, weeks, night
 * time and the restricted period are UK local time. Every figure comes from the rate table.
 *
 * The result is advice for a manager, never a block on its own: a breach is shown with its
 * regulation, and a departure the law allows only on conditions (compensatory rest, adult
 * supervision, protection, a recorded reason) says which conditions apply.
 */

import { nightAverageReferenceWeeks, nightTimeFor } from "./agreements";
import { DAYS_PER_WEEK, plusDays, ukDays } from "./intervals";
import {
  assessNightWorker,
  type NightAverageWindow,
  type NightWorkerAssessment,
  nightAverageFindings,
  nightAverageWindows,
  nightHazardFindings,
} from "./night";
import { preparePeriods } from "./prepared";
import type { WorkingTimeRates } from "./rates";
import { dailyRestFindings, restBreakFindings, weeklyRestFindings } from "./rest";
import {
  type WeeklyAverageWindow,
  weeklyAverageFindings,
  weeklyAverageWindows,
} from "./weekly-average";
import type {
  ExcludedDay,
  TimeSpan,
  WorkingTimeFinding,
  WorkingTimeSetting,
  WorkingTimeWorker,
  WorkPeriod,
} from "./working-time-types";
import {
  youngMaxHoursFindings,
  youngRestrictedPeriodFindings,
  youngWorkerUntil,
} from "./young-workers";

export interface WorkingTimeInput {
  readonly worker: WorkingTimeWorker;
  readonly setting: WorkingTimeSetting;
  /**
   * The worker's planned or recorded periods. Include the reference period before
   * `evaluateFrom` (and the days after it that stand in for excluded days), and, for a young
   * worker, hours declared for other employers.
   */
  readonly periods: readonly WorkPeriod[];
  readonly excludedDays: readonly ExcludedDay[];
  /** ISO dates (UK) whose rules are checked: findings start, or reference periods end, here. */
  readonly evaluateFrom: string;
  readonly evaluateTo: string;
  /** The time over which the periods are complete; outside it, averages are provisional. */
  readonly known: TimeSpan;
  readonly rates: WorkingTimeRates;
}

export interface WorkingTimeReport {
  /** In time order, then by rule. */
  readonly findings: readonly WorkingTimeFinding[];
  readonly weeklyAverage: readonly WeeklyAverageWindow[];
  readonly nightWorker: NightWorkerAssessment;
  /** Shown for a night worker; empty otherwise. */
  readonly nightAverage: readonly NightAverageWindow[];
  /** The instant the young worker rules stop applying. */
  readonly youngWorkerUntil: Date;
}

export function checkWorkingTime(input: WorkingTimeInput): WorkingTimeReport {
  if (input.evaluateTo < input.evaluateFrom) {
    throw new RangeError("The last date to check must not be before the first.");
  }
  const { worker, setting, rates } = input;
  const prepared = preparePeriods(input.periods);
  const own = prepared.filter((p) => p.own);
  const range = ukDays(input.evaluateFrom, input.evaluateTo);
  const until = youngWorkerUntil(worker, rates);
  const night = nightTimeFor(setting, rates);

  const weeklyAverage = weeklyAverageWindows(input);
  const nightWindowFrom = plusDays(
    input.evaluateTo,
    1 - nightAverageReferenceWeeks(setting, rates) * DAYS_PER_WEEK,
  );
  const nightWorker = assessNightWorker(
    own,
    worker,
    night,
    ukDays(nightWindowFrom, input.evaluateTo),
    rates,
  );
  const nightCtx = {
    prepared,
    worker,
    setting,
    rates,
    evaluateFrom: input.evaluateFrom,
    evaluateTo: input.evaluateTo,
    known: input.known,
  };
  const nightAverage = nightWorker.nightWorker ? nightAverageWindows(nightCtx) : [];
  const restCtx = { prepared, worker, setting, rates, range, youngUntil: until };
  const youngCtx = {
    prepared,
    worker,
    setting,
    rates,
    evaluateFrom: input.evaluateFrom,
    evaluateTo: input.evaluateTo,
  };

  const findings = [
    ...weeklyAverageFindings(weeklyAverage, own, rates),
    ...dailyRestFindings(restCtx),
    ...weeklyRestFindings(restCtx),
    ...restBreakFindings(restCtx),
    ...nightAverageFindings(nightAverage, own, nightCtx),
    ...(nightWorker.nightWorker && worker.specialHazards
      ? nightHazardFindings(nightCtx, range)
      : []),
    ...youngMaxHoursFindings(youngCtx),
    ...youngRestrictedPeriodFindings(youngCtx),
  ].sort((a, b) => a.from.getTime() - b.from.getTime() || a.rule.localeCompare(b.rule));

  return { findings, weeklyAverage, nightWorker, nightAverage, youngWorkerUntil: until };
}
