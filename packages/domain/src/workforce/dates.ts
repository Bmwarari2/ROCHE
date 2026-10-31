/**
 * Calendar arithmetic on UK dates (`yyyy-mm-dd`) for the workforce rules. Every rule works on the
 * UK calendar date of an instant (`ukIsoDate`), so a check due "on" a day is due on that UK day
 * whatever the clock change; adding months clamps to the month's last day (31 January plus one
 * month is 28 or 29 February).
 */

const ISO_DATE = /^(\d{4})-(\d{2})-(\d{2})$/;

export function isIsoDate(value: string): boolean {
  const match = ISO_DATE.exec(value);
  if (!match) return false;
  const [, y, m, d] = match.map(Number) as [number, number, number, number];
  const date = new Date(Date.UTC(y, m - 1, d));
  return date.getUTCFullYear() === y && date.getUTCMonth() === m - 1 && date.getUTCDate() === d;
}

function parts(isoDate: string): [number, number, number] {
  if (!isIsoDate(isoDate)) throw new RangeError(`Not a calendar date: ${isoDate}`);
  return isoDate.split("-").map(Number) as [number, number, number];
}

function format(date: Date): string {
  return date.toISOString().slice(0, 10);
}

export function addDays(isoDate: string, days: number): string {
  const [y, m, d] = parts(isoDate);
  return format(new Date(Date.UTC(y, m - 1, d + days)));
}

export function addMonths(isoDate: string, months: number): string {
  const [y, m, d] = parts(isoDate);
  const first = new Date(Date.UTC(y, m - 1 + months, 1));
  const lastDay = new Date(
    Date.UTC(first.getUTCFullYear(), first.getUTCMonth() + 1, 0),
  ).getUTCDate();
  return format(
    new Date(Date.UTC(first.getUTCFullYear(), first.getUTCMonth(), Math.min(d, lastDay))),
  );
}

export function addYears(isoDate: string, years: number): string {
  return addMonths(isoDate, years * 12);
}

/** Whole days from `from` to `to` (negative when `to` is earlier). */
export function daysBetween(from: string, to: string): number {
  const [fy, fm, fd] = parts(from);
  const [ty, tm, td] = parts(to);
  return Math.round((Date.UTC(ty, tm - 1, td) - Date.UTC(fy, fm - 1, fd)) / 86_400_000);
}

/** A year and month as `yyyy-mm`. */
export type YearMonth = string;

const YEAR_MONTH = /^(\d{4})-(0[1-9]|1[0-2])$/;

export function isYearMonth(value: string): boolean {
  return YEAR_MONTH.test(value);
}

/** Months since year 0, for counting. */
export function monthIndex(value: YearMonth): number {
  if (!isYearMonth(value)) throw new RangeError(`Not a year and month: ${value}`);
  const [y, m] = value.split("-").map(Number) as [number, number];
  return y * 12 + (m - 1);
}

export function fromMonthIndex(index: number): YearMonth {
  const y = Math.floor(index / 12);
  const m = (index % 12) + 1;
  return `${String(y).padStart(4, "0")}-${String(m).padStart(2, "0")}`;
}
