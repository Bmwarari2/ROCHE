/**
 * Test support for the working time rules: the figures from the real rate table, UK wall-clock
 * times, and workers and settings with invented details only. Clock changes in 2026: forward on
 * Sunday 29 March, back on Sunday 25 October.
 */

import { resolveWorkingTimeRates, type WorkingTimeRates } from "../src/scheduling/rates";
import {
  checkWorkingTime,
  type WorkingTimeInput,
  type WorkingTimeReport,
} from "../src/scheduling/working-time";
import type {
  WorkingTimeFinding,
  WorkingTimeRule,
  WorkingTimeSetting,
  WorkingTimeWorker,
  WorkPeriod,
} from "../src/scheduling/working-time-types";
import { fromUkWallClock } from "../src/shared/time";
import { readRateTable } from "./rate-table";

export function tableWorkingTimeRates(on = "2026-10-31"): WorkingTimeRates {
  return resolveWorkingTimeRates(readRateTable(), "england", on);
}

/** "2026-10-24 20:00" in UK time (the first, BST, occurrence in the autumn overlap). */
export function uk(text: string): Date {
  const [date = "", time = "00:00"] = text.split(" ");
  const [y, m, d] = date.split("-").map(Number) as [number, number, number];
  const [h, min] = time.split(":").map(Number) as [number, number];
  return fromUkWallClock(y, m, d, h, min);
}

export function shift(
  id: string,
  from: string,
  to: string,
  extra: Partial<WorkPeriod> = {},
): WorkPeriod {
  return { id, kind: "work", start: uk(from), end: uk(to), ...extra };
}

function plusDays(isoDate: string, days: number): string {
  const date = new Date(`${isoDate}T00:00:00Z`);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

/**
 * A shift from `start` to `end` (the next day when `end` is not after `start`) on each date from
 * `from` to `to` whose weekday (1 Monday to 7 Sunday) is listed.
 */
export function pattern(
  prefix: string,
  from: string,
  to: string,
  weekdays: readonly number[],
  start: string,
  end: string,
  extra: Partial<WorkPeriod> = {},
): WorkPeriod[] {
  const periods: WorkPeriod[] = [];
  for (let d = from; d <= to; d = plusDays(d, 1)) {
    const weekday = new Date(`${d}T00:00:00Z`).getUTCDay() || 7;
    if (!weekdays.includes(weekday)) continue;
    const endDate = end <= start ? plusDays(d, 1) : d;
    periods.push(shift(`${prefix}-${d}`, `${d} ${start}`, `${endDate} ${end}`, extra));
  }
  return periods;
}

export const ADULT: WorkingTimeWorker = {
  dateOfBirth: "1990-05-01",
  employmentStart: "2025-01-06",
  optOuts: [],
  designatedNightWorker: false,
  specialHazards: false,
  contractProvidesWorkAfter22: false,
};

/** 17 in autumn 2026; 18 on 15 June 2027. */
export const YOUNG: WorkingTimeWorker = { ...ADULT, dateOfBirth: "2009-06-15" };

export const SETTING: WorkingTimeSetting = {
  derogations: [],
  successiveReferencePeriodsFrom: null,
  agreedReferencePeriodWeeks: null,
  agreedNightReferencePeriodWeeks: null,
  agreedNightTime: null,
  weeklyRestBasis: "each_week",
  weeklyRestPeriodsFrom: null,
  weeklyRestMayIncludeDailyRest: false,
  hospitalOrSimilarEstablishment: false,
};

export const CARE_HOME: WorkingTimeSetting = { ...SETTING, derogations: ["special_case"] };

export function check(
  periods: readonly WorkPeriod[],
  options: Partial<WorkingTimeInput> & { readonly on: string; readonly to?: string },
): WorkingTimeReport {
  const { on, to, ...rest } = options;
  return checkWorkingTime({
    worker: ADULT,
    setting: SETTING,
    periods,
    excludedDays: [],
    evaluateFrom: on,
    evaluateTo: to ?? on,
    known: { start: uk("2024-01-01 00:00"), end: uk("2028-01-01 00:00") },
    rates: tableWorkingTimeRates(),
    ...rest,
  });
}

export function findingsFor(
  report: WorkingTimeReport,
  rule: WorkingTimeRule,
): readonly WorkingTimeFinding[] {
  return report.findings.filter((f) => f.rule === rule);
}

export const HOUR = 60;
