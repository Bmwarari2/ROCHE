import { RateNotFoundError, type RateRow, resolveRate } from "./rates";

/**
 * Idle timeouts for browser sessions (section 5.3; ASVS 5.0 V7.3): a web session left unused for
 * longer than its member's timeout is signed out at its next request. The timeout comes from the
 * rate table, never a literal: `session.idle_timeout_minutes.<role key>` for each role the member
 * holds now (the organisation's override first, then the global row), else
 * `session.idle_timeout_minutes` (override first); a member holding several roles gets the
 * strictest. Mobile sessions are left to the device's own auto-lock (ADR-0011), so a carer working
 * offline is never signed out by the server while entries wait to upload (HZ-110).
 */
export const IDLE_TIMEOUT_RATE_KEY = "session.idle_timeout_minutes";

/**
 * Activity is written at most once a minute per session (one update, not one per request): close
 * enough for a timeout counted in minutes.
 */
export const ACTIVITY_WRITE_INTERVAL_MS = 60_000;

const MINUTE_MS = 60_000;

function positiveMinutes(rows: readonly RateRow[], key: string, on: string, tenantId: string) {
  const { value } = resolveRate(rows, key, "england", on, tenantId);
  if (!Number.isFinite(value) || value <= 0) {
    throw new RangeError(`${key} must be a positive number of minutes`);
  }
  return value;
}

/**
 * The idle timeout in minutes for a member holding `roleKeys` now. Fails loudly, like every rate
 * lookup, when the default row is missing or a figure is not a positive number.
 */
export function idleTimeoutMinutes(
  rows: readonly RateRow[],
  roleKeys: readonly string[],
  tenantId: string,
  on: string,
): number {
  const fallback = () => positiveMinutes(rows, IDLE_TIMEOUT_RATE_KEY, on, tenantId);
  const perRole = roleKeys.map((role) => {
    try {
      return positiveMinutes(rows, `${IDLE_TIMEOUT_RATE_KEY}.${role}`, on, tenantId);
    } catch (error) {
      if (error instanceof RateNotFoundError) return fallback();
      throw error;
    }
  });
  return perRole.length > 0 ? Math.min(...perRole) : fallback();
}

/** Whether a session last used at `lastActiveAt` has been idle for longer than its timeout. */
export function idleExpired(lastActiveAt: Date, now: Date, timeoutMinutes: number): boolean {
  return now.getTime() - lastActiveAt.getTime() > timeoutMinutes * MINUTE_MS;
}

/** Whether this request should record the session's activity (`ACTIVITY_WRITE_INTERVAL_MS`). */
export function activityDue(lastActiveAt: Date, now: Date): boolean {
  return now.getTime() - lastActiveAt.getTime() >= ACTIVITY_WRITE_INTERVAL_MS;
}
