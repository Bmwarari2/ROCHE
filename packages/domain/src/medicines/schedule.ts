/**
 * Regular medicine schedules (medicines.md rules 3 and 4; HZ-003, HZ-005, HZ-009). A schedule is
 * the prescribed wall-clock times in UK time with the dose at each time, on a pattern of days.
 * Doses are expanded to instants with the IANA time-zone database (`fromUkWallClock`), never by
 * adding 24 hours, over the MAR cycle (`medicines.ordering_cycle_days` from the rate table,
 * starting on the tenant's cycle start date).
 *
 * Clock changes (the HZ-009 rule, for the CSO to confirm, H-22): a time in the hour skipped when
 * the clocks go forward is due an hour later (01:30 becomes 02:30 BST) and flagged; a time in the
 * hour repeated when the clocks go back is due once, at its first (BST) occurrence, and flagged.
 * If a moved time lands on another prescribed time of the same medicine, both doses stay on the
 * MAR and both are flagged for the nurse in charge: Harbour never merges or drops a dose.
 *
 * Non-daily patterns name the day on every MAR row, so a weekly medicine is never read as daily.
 * Harbour applies the prescribed times as written: it never suggests a time, a gap or a dose.
 */

import { WEEKDAYS, type Weekday } from "../platform/tasks";
import {
  fromUkWallClock,
  toUkWallClock,
  ukOffsetMinutes,
  ukWallClockOccurrences,
} from "../shared/time";
import { checkDose, type Dose, type DoseIssue, type DoseUnit, formatDose } from "./dose";
import type { MedicinesRates } from "./rates";

export const WEEKDAY_NAMES: Readonly<Record<Weekday, string>> = {
  mon: "Monday",
  tue: "Tuesday",
  wed: "Wednesday",
  thu: "Thursday",
  fri: "Friday",
  sat: "Saturday",
  sun: "Sunday",
};

/**
 * The days a regular medicine is due:
 * - `every_day`;
 * - `every_n_days`: every `intervalDays` days (2 is every other day), counted from `anchorOn`, a
 *   day a dose falls due (for a patch changed every 3 days, the day it was first applied);
 * - `weekly`: on the named weekdays, every `intervalWeeks` weeks (2 is fortnightly), counted from
 *   the week containing `anchorOn`;
 * - `monthly`: on `dayOfMonth`; in a shorter month, on its last day (flagged on the MAR).
 *
 * The anchor is a date of its own, never the start of an entry version, so a change or a restart
 * keeps the count (HZ-003, HZ-004): a new version carries it over unless the prescriber's new
 * pattern re-anchors it, which `changeMarEntry` makes explicit and records (rule 6a).
 */
export type SchedulePattern =
  | { readonly kind: "every_day" }
  | { readonly kind: "every_n_days"; readonly intervalDays: number; readonly anchorOn: string }
  | {
      readonly kind: "weekly";
      readonly weekdays: readonly Weekday[];
      readonly intervalWeeks: number;
      readonly anchorOn: string;
    }
  | { readonly kind: "monthly"; readonly dayOfMonth: number };

/** A prescribed time (HH:MM, 24-hour, UK time) and the dose due at it. */
export interface DoseTime {
  readonly time: string;
  readonly dose: Dose;
}

export interface RegularSchedule {
  readonly pattern: SchedulePattern;
  readonly times: readonly DoseTime[];
}

export type ScheduleProblem =
  | "no_times"
  | "bad_time"
  | "duplicate_time"
  | "bad_interval"
  | "no_weekdays"
  | "bad_weekday"
  | "bad_day_of_month"
  | "bad_anchor"
  | DoseIssue["problem"];

export interface ScheduleIssue {
  readonly problem: ScheduleProblem;
  readonly message: string;
  /** The prescribed time the issue is about, for a dose problem or a bad time. */
  readonly time?: string;
}

const TIME_PATTERN = /^([01]\d|2[0-3]):([0-5]\d)$/;

function isWholeAtLeast(value: number, min: number): boolean {
  return Number.isInteger(value) && value >= min;
}

/** Checks a regular schedule and each of its doses against the product's dm+d units. */
export function checkSchedule(
  schedule: RegularSchedule,
  permittedUnits: readonly DoseUnit[],
): readonly ScheduleIssue[] {
  const issues: ScheduleIssue[] = [];
  const { pattern, times } = schedule;
  if (times.length === 0) {
    issues.push({ problem: "no_times", message: "Give at least one time the medicine is due." });
  }
  const seen = new Set<string>();
  for (const { time, dose } of times) {
    if (!TIME_PATTERN.test(time)) {
      issues.push({
        problem: "bad_time",
        time,
        message: `Write times as HH:MM in 24-hour time, not "${time}".`,
      });
      continue;
    }
    if (seen.has(time)) {
      issues.push({
        problem: "duplicate_time",
        time,
        message: `${time} is given twice. Give each time once.`,
      });
    }
    seen.add(time);
    for (const issue of checkDose(dose, permittedUnits)) issues.push({ ...issue, time });
  }
  if (pattern.kind === "every_n_days" && !isWholeAtLeast(pattern.intervalDays, 2)) {
    issues.push({
      problem: "bad_interval",
      message: "Every so many days must be a whole number of 2 or more (use every day for 1).",
    });
  }
  if (pattern.kind === "weekly") {
    if (!isWholeAtLeast(pattern.intervalWeeks, 1)) {
      issues.push({
        problem: "bad_interval",
        message: "The number of weeks must be a whole number of 1 or more.",
      });
    }
    if (pattern.weekdays.length === 0) {
      issues.push({
        problem: "no_weekdays",
        message: "Choose the day or days of the week it is due.",
      });
    }
    if (pattern.weekdays.some((d) => !WEEKDAYS.includes(d))) {
      issues.push({
        problem: "bad_weekday",
        message: "Choose days of the week from Monday to Sunday.",
      });
    }
  }
  if (
    (pattern.kind === "every_n_days" || pattern.kind === "weekly") &&
    !isIsoDate(pattern.anchorOn)
  ) {
    issues.push({
      problem: "bad_anchor",
      message: "Give the date the count starts from: a day the dose fell or falls due.",
    });
  }
  if (
    pattern.kind === "monthly" &&
    !(isWholeAtLeast(pattern.dayOfMonth, 1) && pattern.dayOfMonth <= 31)
  ) {
    issues.push({
      problem: "bad_day_of_month",
      message: "The day of the month must be from 1 to 31.",
    });
  }
  return issues;
}

// Calendar days (UK dates) as day numbers since the epoch, so day arithmetic never meets a clock change.

interface Day {
  readonly year: number;
  readonly month: number;
  readonly day: number;
}

function dayNumber(d: Day): number {
  return Math.floor(Date.UTC(d.year, d.month - 1, d.day) / 86_400_000);
}

function fromDayNumber(n: number): Day {
  const date = new Date(n * 86_400_000);
  return { year: date.getUTCFullYear(), month: date.getUTCMonth() + 1, day: date.getUTCDate() };
}

function isoDate(d: Day): string {
  return `${d.year}-${String(d.month).padStart(2, "0")}-${String(d.day).padStart(2, "0")}`;
}

function parseIsoDate(value: string): Day {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  const d = match
    ? { year: Number(match[1]), month: Number(match[2]), day: Number(match[3]) }
    : null;
  if (!d || isoDate(fromDayNumber(dayNumber(d))) !== value) {
    throw new RangeError(`"${value}" is not a date (YYYY-MM-DD).`);
  }
  return d;
}

function isIsoDate(value: string): boolean {
  try {
    parseIsoDate(value);
    return true;
  } catch {
    return false;
  }
}

/**
 * Whether two counting patterns fall on the same days: the same kind and interval, and anchors a
 * whole number of intervals apart (for weekly patterns, the same weekdays too). A change between
 * patterns that do not keep the count re-anchors it, which must be explicit (rule 6a).
 */
export function keepsCount(before: SchedulePattern, after: SchedulePattern): boolean {
  // A count that did not exist before, or is not kept after, has nothing to carry over.
  if (!isCounting(before) || !isCounting(after)) return true;
  if (before.kind === "every_n_days" && after.kind === "every_n_days") {
    if (before.intervalDays !== after.intervalDays) return false;
    const gap = dayNumber(parseIsoDate(after.anchorOn)) - dayNumber(parseIsoDate(before.anchorOn));
    return mod(gap, after.intervalDays) === 0;
  }
  if (before.kind === "weekly" && after.kind === "weekly") {
    if (before.intervalWeeks !== after.intervalWeeks) return false;
    const monday = (iso: string) => {
      const d = parseIsoDate(iso);
      return dayNumber(d) - weekdayIndex(d);
    };
    return mod((monday(after.anchorOn) - monday(before.anchorOn)) / 7, after.intervalWeeks) === 0;
  }
  return false;
}

/** A pattern whose days are counted from an anchor (every n days, or weekly every 2 or more weeks). */
export function isCounting(pattern: SchedulePattern): boolean {
  return (
    pattern.kind === "every_n_days" || (pattern.kind === "weekly" && pattern.intervalWeeks > 1)
  );
}

function ukDay(instant: Date): Day {
  const w = toUkWallClock(instant);
  return { year: w.year, month: w.month, day: w.day };
}

/** Monday is 0. */
function weekdayIndex(d: Day): number {
  return (new Date(Date.UTC(d.year, d.month - 1, d.day)).getUTCDay() + 6) % 7;
}

function daysInMonth(year: number, month: number): number {
  return new Date(Date.UTC(year, month, 0)).getUTCDate();
}

function mod(a: number, n: number): number {
  return ((a % n) + n) % n;
}

/** Whether the pattern falls on a day, counting from the pattern's own anchor. */
function patternFallsOn(pattern: SchedulePattern, d: Day): boolean {
  if (pattern.kind === "every_day") return true;
  if (pattern.kind === "every_n_days") {
    const anchor = parseIsoDate(pattern.anchorOn);
    return mod(dayNumber(d) - dayNumber(anchor), pattern.intervalDays) === 0;
  }
  if (pattern.kind === "weekly") {
    if (!pattern.weekdays.includes(WEEKDAYS[weekdayIndex(d)] as Weekday)) return false;
    const anchor = parseIsoDate(pattern.anchorOn);
    const anchorMonday = dayNumber(anchor) - weekdayIndex(anchor);
    return mod(Math.floor((dayNumber(d) - anchorMonday) / 7), pattern.intervalWeeks) === 0;
  }
  return d.day === Math.min(pattern.dayOfMonth, daysInMonth(d.year, d.month));
}

/** One dose on the MAR. */
export interface MarDose {
  readonly dueAt: Date;
  /** The UK date of the MAR column the dose sits in (YYYY-MM-DD). */
  readonly date: string;
  /** The prescribed time, as written; `dueAt` differs only on a clock-change night. */
  readonly time: string;
  readonly weekday: Weekday;
  /** The day named on the MAR row: every non-daily pattern names it; every day does not. */
  readonly dayName: string | null;
  readonly dose: Dose;
  /**
   * `time_skipped`: the prescribed time did not happen (clocks forward); due an hour later.
   * `time_repeated`: the prescribed time happened twice (clocks back); due at the first.
   */
  readonly clockChange: "time_skipped" | "time_repeated" | null;
  /** Another prescribed time of the same medicine falling due at the same instant (clocks forward). */
  readonly sameInstantAs: string | null;
  /** A monthly dose moved to the last day of a month shorter than its day. */
  readonly lastDayOfShorterMonth: boolean;
}

/** When the medicine is in force: doses fall due at or after `startsAt` and before `endsAt`. */
export interface ActivePeriod {
  readonly startsAt: Date;
  readonly endsAt: Date | null;
}

/**
 * Every dose of a regular schedule due in the half-open window [from, to), in time order. Counting
 * patterns count from their `anchorOn`, never from `startsAt`, so the period only limits which of
 * the pattern's doses fall in force. Throws a RangeError for a schedule `checkSchedule` refuses.
 */
export function expandSchedule(
  schedule: RegularSchedule,
  period: ActivePeriod,
  window: { readonly from: Date; readonly to: Date },
): readonly MarDose[] {
  const structural = checkSchedule(
    schedule,
    schedule.times.map((t) => t.dose.unit),
  ).filter((i) => i.problem !== "not_a_dose_quantity" && i.problem !== "range_not_ascending");
  if (structural.length > 0) throw new RangeError(structural.map((i) => i.message).join(" "));
  const from = Math.max(window.from.getTime(), period.startsAt.getTime());
  const to = Math.min(window.to.getTime(), period.endsAt?.getTime() ?? Number.POSITIVE_INFINITY);
  if (from >= to) return [];

  const nonDaily = schedule.pattern.kind !== "every_day";
  const doses: MarDose[] = [];
  for (let n = dayNumber(ukDay(new Date(from))) - 1; n <= dayNumber(ukDay(new Date(to))); n++) {
    const d = fromDayNumber(n);
    if (!patternFallsOn(schedule.pattern, d)) continue;
    const weekday = WEEKDAYS[weekdayIndex(d)] as Weekday;
    const lastDayOfShorterMonth =
      schedule.pattern.kind === "monthly" &&
      schedule.pattern.dayOfMonth > daysInMonth(d.year, d.month);
    for (const { time, dose } of schedule.times) {
      const [hour, minute] = time.split(":").map(Number) as [number, number];
      const occurrences = ukWallClockOccurrences(d.year, d.month, d.day, hour, minute).length;
      const dueAt = fromUkWallClock(d.year, d.month, d.day, hour, minute);
      if (dueAt.getTime() < from || dueAt.getTime() >= to) continue;
      doses.push({
        dueAt,
        date: isoDate(d),
        time,
        weekday,
        dayName: nonDaily ? WEEKDAY_NAMES[weekday] : null,
        dose,
        clockChange:
          occurrences === 0 ? "time_skipped" : occurrences === 2 ? "time_repeated" : null,
        sameInstantAs: null,
        lastDayOfShorterMonth,
      });
    }
  }
  doses.sort((a, b) => a.dueAt.getTime() - b.dueAt.getTime() || a.time.localeCompare(b.time));
  return doses.map((dose) => {
    const other = doses.find((o) => o !== dose && o.dueAt.getTime() === dose.dueAt.getTime());
    return other ? { ...dose, sameInstantAs: other.time } : dose;
  });
}

/** A MAR cycle: `days` UK calendar days from `startsOn`, as instants [from, to). */
export interface MarCycle {
  readonly startsOn: string;
  /** The last day of the cycle, inclusive. */
  readonly endsOn: string;
  readonly days: number;
  readonly from: Date;
  readonly to: Date;
}

/** The MAR cycle starting on a date, its length from `medicines.ordering_cycle_days`. */
export function marCycle(
  startsOn: string,
  rates: Pick<MedicinesRates, "orderingCycleDays">,
): MarCycle {
  const days = rates.orderingCycleDays;
  if (!isWholeAtLeast(days, 1))
    throw new RangeError("The cycle length must be a whole number of days.");
  const start = dayNumber(parseIsoDate(startsOn));
  const at = (n: number) => {
    const d = fromDayNumber(n);
    return fromUkWallClock(d.year, d.month, d.day, 0, 0);
  };
  return {
    startsOn,
    endsOn: isoDate(fromDayNumber(start + days - 1)),
    days,
    from: at(start),
    to: at(start + days),
  };
}

/**
 * The cycle containing a date, for a tenant whose cycles run back to back from `anchorStartsOn`
 * (the first day of any one of its cycles, as the pharmacy delivers them).
 */
export function marCycleContaining(
  anchorStartsOn: string,
  on: string,
  rates: Pick<MedicinesRates, "orderingCycleDays">,
): MarCycle {
  const anchor = dayNumber(parseIsoDate(anchorStartsOn));
  const day = dayNumber(parseIsoDate(on));
  const offset = mod(day - anchor, rates.orderingCycleDays);
  return marCycle(isoDate(fromDayNumber(day - offset)), rates);
}

/** The days in a cycle on which the UK clocks change, so the MAR and the round can say so. */
export function clockChangesIn(cycle: MarCycle): readonly {
  readonly date: string;
  readonly change: "forward" | "back";
}[] {
  const out: { date: string; change: "forward" | "back" }[] = [];
  const start = dayNumber(parseIsoDate(cycle.startsOn));
  for (let n = start; n < start + cycle.days; n++) {
    const d = fromDayNumber(n);
    const before = ukOffsetMinutes(fromUkWallClock(d.year, d.month, d.day, 0, 0));
    const next = fromDayNumber(n + 1);
    const after = ukOffsetMinutes(fromUkWallClock(next.year, next.month, next.day, 0, 0));
    if (after > before) out.push({ date: isoDate(d), change: "forward" });
    if (after < before) out.push({ date: isoDate(d), change: "back" });
  }
  return out;
}

function list(items: readonly string[]): string {
  if (items.length <= 1) return items.join("");
  return `${items.slice(0, -1).join(", ")} and ${items[items.length - 1]}`;
}

function ordinalEvery(n: number, unit: "day" | "week"): string {
  return n === 2 ? `every other ${unit}` : `every ${n} ${unit}s`;
}

/**
 * The schedule in words for the MAR and the record, naming the day for every non-daily pattern:
 * "2 tablets every day at 08:00 and 20:00", "1 tablet every Monday at 07:00", or, when the doses
 * differ, "Every day: 08:00 2 tablets; 20:00 1 tablet".
 */
export function describeSchedule(schedule: RegularSchedule): string {
  const times = [...schedule.times].sort((a, b) => a.time.localeCompare(b.time));
  const p = schedule.pattern;
  const weekdayNames = (days: readonly Weekday[]) =>
    list(WEEKDAYS.filter((d) => days.includes(d)).map((d) => WEEKDAY_NAMES[d]));
  const dated = (iso: string) => iso.split("-").reverse().join("/");
  let when: string;
  let from = "";
  if (p.kind === "every_day") when = "every day";
  else if (p.kind === "every_n_days") {
    when = ordinalEvery(p.intervalDays, "day");
    const anchor = parseIsoDate(p.anchorOn);
    from = `, counting from ${WEEKDAY_NAMES[WEEKDAYS[weekdayIndex(anchor)] as Weekday]} ${dated(p.anchorOn)}`;
  } else if (p.kind === "weekly") {
    when =
      p.intervalWeeks === 1
        ? `every ${weekdayNames(p.weekdays)}`
        : `${ordinalEvery(p.intervalWeeks, "week")} on ${weekdayNames(p.weekdays)}`;
    if (p.intervalWeeks > 1) from = `, counting from the week of ${dated(p.anchorOn)}`;
  } else {
    when = `once a month on day ${p.dayOfMonth}`;
    // February in a common year has the fewest days of any month: a later day falls, in some
    // months, on the last day instead (flagged on those doses).
    if (p.dayOfMonth > daysInMonth(2026, 2)) from = " (the last day of a shorter month)";
  }
  const doses = times.map((t) => formatDose(t.dose));
  if (doses.every((d) => d === doses[0])) {
    return `${doses[0]} ${when} at ${list(times.map((t) => t.time))}${from}`;
  }
  const detail = times.map((t, i) => `${t.time} ${doses[i]}`).join("; ");
  return `${when.charAt(0).toUpperCase()}${when.slice(1)}${from}: ${detail}`;
}
