/**
 * Time formatting for the native app in British English: dd/mm/yyyy dates and 24-hour times,
 * rendered in the device's local time zone (hazard HZ-008: time-critical information must not
 * shift between UTC and UK time).
 *
 * Pure functions with no React Native imports, so they run under Vitest in Node.
 */

export const MINUTE_MS = 60_000;
export const HOUR_MS = 60 * MINUTE_MS;
export const DAY_MS = 24 * HOUR_MS;

/** Small clock-skew allowance: a timestamp up to a minute in the future still reads "just now". */
const FUTURE_TOLERANCE_MS = MINUTE_MS;

function pad2(value: number): string {
  return value.toString().padStart(2, "0");
}

/** 24-hour local time, for example "07:05". */
export function formatTime(date: Date): string {
  return `${pad2(date.getHours())}:${pad2(date.getMinutes())}`;
}

/** Local calendar date as dd/mm/yyyy, for example "09/10/2026". */
export function formatDate(date: Date): string {
  return `${pad2(date.getDate())}/${pad2(date.getMonth() + 1)}/${date.getFullYear()}`;
}

/**
 * Formats an ISO calendar date (yyyy-mm-dd, such as a date of birth) as dd/mm/yyyy without going
 * through `Date`, so the value can never move by a day because of the device time zone.
 * Returns null when the input is not a valid calendar date.
 */
export function formatIsoCalendarDate(isoDate: string | null | undefined): string | null {
  if (!isoDate) return null;
  const match = /^(\d{4})-(\d{2})-(\d{2})/.exec(isoDate.trim());
  if (!match) return null;
  const [, year, month, day] = match;
  const y = Number(year);
  const m = Number(month);
  const d = Number(day);
  if (m < 1 || m > 12 || d < 1) return null;
  const daysInMonth = new Date(Date.UTC(y, m, 0)).getUTCDate();
  if (d > daysInMonth) return null;
  return `${day}/${month}/${year}`;
}

function plural(count: number, singular: string, pluralForm: string): string {
  return `${count} ${count === 1 ? singular : pluralForm}`;
}

/**
 * Relative description of a past moment: "just now", "4 minutes ago", "3 hours ago", or an
 * absolute "on 09/10/2026 at 14:05" once it is a day or more old. A moment more than a minute in
 * the future (device clock wrong) is shown as an absolute time rather than a misleading "ago".
 */
export function formatRelativeTime(then: Date, now: Date): string {
  const diff = now.getTime() - then.getTime();
  if (diff < -FUTURE_TOLERANCE_MS) {
    return `on ${formatDate(then)} at ${formatTime(then)}`;
  }
  if (diff < MINUTE_MS) return "just now";
  if (diff < HOUR_MS) return plural(Math.floor(diff / MINUTE_MS), "minute ago", "minutes ago");
  if (diff < DAY_MS) return plural(Math.floor(diff / HOUR_MS), "hour ago", "hours ago");
  return `on ${formatDate(then)} at ${formatTime(then)}`;
}

/** "Last synced 4 minutes ago", or "Not synced yet" when there has never been a successful sync. */
export function formatLastSynced(lastSyncedAt: Date | null | undefined, now: Date): string {
  if (!lastSyncedAt) return "Not synced yet";
  return `Last synced ${formatRelativeTime(lastSyncedAt, now)}`;
}
