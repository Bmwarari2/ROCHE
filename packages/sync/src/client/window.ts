/**
 * The offline window (ADR-0011, care.md section 6): which days of point-of-care entries a device
 * keeps. Sync streams cannot read the clock, so the window travels as a list of UTC calendar days
 * in the `offline_days` connection parameter, and the entry streams keep a row only when the first
 * ten characters of its `occurred_at` (UTC, ISO 8601) are in the list. When a day drops out of the
 * list its bucket, and every entry in it, leaves the device.
 *
 * The number of days is the tenant's `mobile.offline_window_days` from the rate table, never a
 * literal here. The parameter narrows data only: tenant and people always come from the signed
 * token, so a device that sends a longer list still sees nobody it is not assigned to.
 */

/** Rate-table key for the number of days a device keeps (tenant default, ADR-0011). */
export const OFFLINE_WINDOW_RATE_KEY = "mobile.offline_window_days";

/** Name of the connection parameter the entry streams read. */
export const OFFLINE_DAYS_PARAMETER = "offline_days";

/**
 * Upper bound on the days a device asks for. Each day is a bucket per person in scope, and the
 * sync service limits buckets per connection, so this guards the service rather than setting a
 * policy: ADR-0011 offers 3, 7 or 14 days.
 */
export const MAX_OFFLINE_WINDOW_DAYS = 31;

/** What the device passes to `connect({ params })`. */
export interface SyncConnectionParameters {
  readonly [OFFLINE_DAYS_PARAMETER]: readonly string[];
}

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

/** The connection parameters for `connect({ params })`. */
export function syncConnectionParameters(now: Date, windowDays: number): SyncConnectionParameters {
  return { [OFFLINE_DAYS_PARAMETER]: offlineWindowDays(now, windowDays) };
}

/**
 * When the window next changes: the next UTC midnight. The device reconnects then with the new
 * list, so the oldest day leaves the device on time even if the app stays open.
 */
export function nextWindowChange(now: Date): Date {
  const today = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
  return new Date(today + DAY_MS);
}
