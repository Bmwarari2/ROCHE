import { addPeriod } from "../platform/retention";

/**
 * Calendar-date helpers for the people rules. Dates are ISO strings (yyyy-mm-dd) in the location's
 * calendar; instants are `Date`. Internal to the people module (not exported from the package
 * index), so the names never clash with the care helpers.
 */

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

/** True for a real calendar date written yyyy-mm-dd (not 30 February). */
export function isCalendarDate(value: string | null | undefined): value is string {
  if (typeof value !== "string" || !ISO_DATE.test(value)) return false;
  const date = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(date.getTime()) && date.toISOString().slice(0, 10) === value;
}

/** Whole months later; 31 January plus one month is the last day of February. */
export function plusMonths(isoDate: string, months: number): string {
  return addPeriod(new Date(`${isoDate}T00:00:00Z`), months, "months")
    .toISOString()
    .slice(0, 10);
}

export function plusDays(isoDate: string, days: number): string {
  const date = new Date(`${isoDate}T00:00:00Z`);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

const DAYS_PER_WEEK = 7;

export function plusWeeks(isoDate: string, weeks: number): string {
  return plusDays(isoDate, weeks * DAYS_PER_WEEK);
}

/** The later of two ISO dates (ISO dates sort as strings). */
export function laterDate(a: string, b: string): string {
  return a >= b ? a : b;
}

/** True when a free-text reason has at least `min` characters once trimmed. */
export function hasReason(value: string | null | undefined, min: number): boolean {
  return (value?.trim().length ?? 0) >= min;
}
