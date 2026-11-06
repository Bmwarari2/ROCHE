/**
 * The offline window (ADR-0011, care.md section 6): which days of point-of-care entries a device
 * keeps. Sync streams cannot read the clock, so the window travels as a list of UTC calendar days
 * in the `offline_days` claim of the signed sync token, and the entry streams keep a row only when
 * the first ten characters of its `occurred_at` (UTC, ISO 8601) are in the list. When a day drops
 * out of the list its bucket, and every entry in it, leaves the device.
 *
 * The API mints the claim at `POST /v1/sync/token` from the tenant's `mobile.offline_window_days`
 * in the rate table (never a literal here), so the device cannot widen it: the streams read no
 * connection parameters (security review S1). The token lasts 15 minutes, so a new day enters and
 * the oldest leaves at the first token after UTC midnight.
 */

/** Rate-table key for the number of days a device keeps (tenant default, ADR-0011). */
export const OFFLINE_WINDOW_RATE_KEY = "mobile.offline_window_days";

/** Name of the sync token claim the entry streams read (`auth.parameter('offline_days')`). */
export const OFFLINE_DAYS_CLAIM = "offline_days";

/**
 * Upper bound on the days a device asks for. Each day is a bucket per person in scope, and the
 * sync service limits buckets per connection, so this guards the service rather than setting a
 * policy: ADR-0011 offers 3, 7 or 14 days.
 */
export const MAX_OFFLINE_WINDOW_DAYS = 31;

const DAY_MS = 86_400_000;

function utcDay(instant: number): string {
  return new Date(instant).toISOString().slice(0, 10);
}

/** True for a whole number of days the device may ask for. */
export function isValidWindowDays(days: unknown): days is number {
  return (
    typeof days === "number" &&
    Number.isInteger(days) &&
    days >= 1 &&
    days <= MAX_OFFLINE_WINDOW_DAYS
  );
}

/**
 * The UTC days of the window at `now`, newest first: tomorrow (so an entry timed a few minutes
 * ahead within the clock-drift tolerance still syncs just before midnight), today, and the days
 * before it, `windowDays` days in all counting today. Nothing older than `windowDays` calendar days
 * stays on the device.
 */
export function offlineWindowDays(now: Date, windowDays: number): string[] {
  if (Number.isNaN(now.getTime())) throw new RangeError("The current time is not a valid date");
  if (!isValidWindowDays(windowDays)) {
    throw new RangeError(
      `The offline window must be a whole number of days from 1 to ${MAX_OFFLINE_WINDOW_DAYS}`,
    );
  }
  const today = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
  const days = [utcDay(today + DAY_MS)];
  for (let back = 0; back < windowDays; back += 1) days.push(utcDay(today - back * DAY_MS));
  return days;
}

/**
 * When the window next changes: the next UTC midnight. The device reconnects then, which fetches a
 * new token with the new list, so the oldest day leaves the device on time even if the app stays
 * open.
 */
export function nextWindowChange(now: Date): Date {
  const today = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
  return new Date(today + DAY_MS);
}

/**
 * The shift days (scheduling.md section 18): which days of a member's own shifts and clock events
 * their phone keeps, in the `shift_days` claim the API mints with the token, never from the device.
 * A shift or clock event stays while the first ten characters of its start (UTC) are in the list.
 */
export const SHIFT_DAYS_CLAIM = "shift_days";

/**
 * Days behind today: a night shift that started yesterday, and its clock events, stay on the phone
 * until it has ended and a day more. A product bound, not a statutory figure.
 */
export const SHIFT_DAYS_BEHIND = 2;

/**
 * Days ahead of today: a week of the member's own published shifts, and a day more because a UK
 * day can start in the previous UTC day. A product bound on the buckets each device holds, not a
 * statutory figure.
 */
export const SHIFT_DAYS_AHEAD = 8;

/** The UTC days of a member's shifts at `now`, oldest first. */
export function shiftWindowDays(now: Date): string[] {
  if (Number.isNaN(now.getTime())) throw new RangeError("The current time is not a valid date");
  const today = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
  const days: string[] = [];
  for (let d = -SHIFT_DAYS_BEHIND; d <= SHIFT_DAYS_AHEAD; d += 1)
    days.push(utcDay(today + d * DAY_MS));
  return days;
}
