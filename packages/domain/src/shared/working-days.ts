import { fromUkWallClock, toUkWallClock } from "./time";

/**
 * Working-day clocks (docs/specs/calendar.md): Monday to Friday in UK local time, leaving out the
 * bank holidays of the location's nation. "Within N working days of" an event runs to the end of
 * the Nth working day after the day it happened; the event's own day never counts, whatever the
 * time. Bank holidays come from the `bank_holiday` table, never from code. Beyond the last year the
 * table covers no holiday is skipped, so a deadline can only fall early, never late.
 */

/** ISO dates (yyyy-mm-dd) of the bank holidays that apply to the location's nation. */
export type BankHolidays = ReadonlySet<string>;

function toIso(date: Date): string {
  return date.toISOString().slice(0, 10);
}

function nextIsoDate(isoDate: string): string {
  const d = new Date(`${isoDate}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + 1);
  return toIso(d);
}

/** The calendar date of an instant in UK local time. */
export function ukIsoDate(instant: Date): string {
  const w = toUkWallClock(instant);
  return toIso(new Date(Date.UTC(w.year, w.month - 1, w.day)));
}

export function isWorkingDay(isoDate: string, holidays: BankHolidays): boolean {
  const weekday = new Date(`${isoDate}T00:00:00Z`).getUTCDay();
  return weekday !== 0 && weekday !== 6 && !holidays.has(isoDate);
}

/** The Nth working day after a date (the date itself for 0). */
export function addWorkingDays(isoDate: string, days: number, holidays: BankHolidays): string {
  if (!Number.isInteger(days) || days < 0) {
    throw new RangeError("Working days must be a whole number of zero or more.");
  }
  let cursor = isoDate;
  let counted = 0;
  while (counted < days) {
    cursor = nextIsoDate(cursor);
    if (isWorkingDay(cursor, holidays)) counted++;
  }
  return cursor;
}

/** When a "within N working days" clock started at `from` runs out: midnight UK time after the due day. */
export function workingDaysDeadline(from: Date, days: number, holidays: BankHolidays): Date {
  const [year, month, day] = nextIsoDate(addWorkingDays(ukIsoDate(from), days, holidays))
    .split("-")
    .map(Number) as [number, number, number];
  return fromUkWallClock(year, month, day, 0, 0);
}
