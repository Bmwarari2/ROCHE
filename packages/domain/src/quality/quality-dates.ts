/**
 * UK calendar-date arithmetic for the Phase 2 quality rules: dates are ISO yyyy-mm-dd UK dates,
 * worked on as calendar days, so no clock change moves a due date. Pure and unit tested.
 */

const ISO = /^(\d{4})-(\d{2})-(\d{2})$/;

/** Whether a string is a real ISO calendar date. */
export function isIsoDate(value: string): boolean {
  const m = ISO.exec(value);
  if (!m) return false;
  const d = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])));
  return d.toISOString().slice(0, 10) === value;
}

function parts(value: string): [number, number, number] {
  if (!isIsoDate(value)) throw new RangeError(`Not a date: ${value}`);
  const [y, m, d] = value.split("-").map(Number) as [number, number, number];
  return [y, m, d];
}

const iso = (date: Date) => date.toISOString().slice(0, 10);

/** `days` calendar days after a date (negative for before). */
export function addDays(value: string, days: number): string {
  const [y, m, d] = parts(value);
  return iso(new Date(Date.UTC(y, m - 1, d + days)));
}

/** `months` calendar months after a date, clamped to the month's last day (31/01 + 1 = 28/02). */
export function addMonths(value: string, months: number): string {
  const [y, m, d] = parts(value);
  const first = new Date(Date.UTC(y, m - 1 + months, 1));
  const last = new Date(Date.UTC(first.getUTCFullYear(), first.getUTCMonth() + 1, 0)).getUTCDate();
  return iso(new Date(Date.UTC(first.getUTCFullYear(), first.getUTCMonth(), Math.min(d, last))));
}

/** Whole calendar days from `from` to `to` (negative when `to` is earlier). */
export function daysBetween(from: string, to: string): number {
  const [y1, m1, d1] = parts(from);
  const [y2, m2, d2] = parts(to);
  return Math.round((Date.UTC(y2, m2 - 1, d2) - Date.UTC(y1, m1 - 1, d1)) / 86_400_000);
}
