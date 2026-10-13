import { RateNotFoundError, type RateRow, resolveRate } from "./rates";

/**
 * Idle timeouts for browser sessions (section 5.3; ASVS 5.0 V7.3): a web session left unused for
 * longer than its member's timeout is signed out at its next request. Off unless the environment
 * turns it on (`SESSION_IDLE_TIMEOUT`), which must wait for HZ-111's controls (H-353). The timeout
 * comes from the rate table, never a literal: `session.idle_timeout_minutes.<role key>` for each
 * role the member holds now (the organisation's override first, then the global row), else
 * `session.idle_timeout_minutes`; a member holding several roles gets the strictest, kept between
 * `session.idle_timeout_floor_minutes` and `session.idle_timeout_ceiling_minutes`. Mobile
 * sessions are left to the device's own auto-lock (ADR-0011, HZ-110).
 */
export const IDLE_TIMEOUT_RATE_KEY = "session.idle_timeout_minutes";
export const IDLE_TIMEOUT_FLOOR_KEY = "session.idle_timeout_floor_minutes";
export const IDLE_TIMEOUT_CEILING_KEY = "session.idle_timeout_ceiling_minutes";
/** Every idle timeout rate key starts with this. */
export const IDLE_TIMEOUT_KEY_PREFIX = "session.idle_timeout";

/**
 * Activity is written at most once a minute per session (one update, not one per request): close
 * enough for a timeout counted in minutes.
 */
export const ACTIVITY_WRITE_INTERVAL_MS = 60_000;

const MINUTE_MS = 60_000;

/** A positive number of minutes for the key, or null when it is missing or not a valid figure. */
function minutesOf(rows: readonly RateRow[], key: string, on: string, tenantId: string) {
  try {
    const { value } = resolveRate(rows, key, "england", on, tenantId);
    return Number.isFinite(value) && value > 0 ? value : null;
  } catch (error) {
    if (error instanceof RateNotFoundError) return null;
    throw error;
  }
}

/**
 * The idle timeout in minutes for a member holding `roleKeys` now, or null when no valid figure
 * applies (the timeout is then not enforced, never a refused request). A role whose own figure is
 * missing, zero or not a number takes the default (#40 review).
 */
export function idleTimeoutMinutes(
  rows: readonly RateRow[],
  roleKeys: readonly string[],
  tenantId: string,
  on: string,
): number | null {
  const fallback = minutesOf(rows, IDLE_TIMEOUT_RATE_KEY, on, tenantId);
  const perRole = roleKeys.map(
    (role) => minutesOf(rows, `${IDLE_TIMEOUT_RATE_KEY}.${role}`, on, tenantId) ?? fallback,
  );
  const figures = (perRole.length > 0 ? perRole : [fallback]).filter(
    (m): m is number => m !== null,
  );
  if (figures.length === 0) return null;
  const floor = minutesOf(rows, IDLE_TIMEOUT_FLOOR_KEY, on, tenantId) ?? 0;
  const ceiling =
    minutesOf(rows, IDLE_TIMEOUT_CEILING_KEY, on, tenantId) ?? Number.POSITIVE_INFINITY;
  return Math.min(Math.max(Math.min(...figures), floor), ceiling);
}

/** Whether a session last used at `lastActiveAt` has been idle for longer than its timeout. */
export function idleExpired(lastActiveAt: Date, now: Date, timeoutMinutes: number): boolean {
  return now.getTime() - lastActiveAt.getTime() > timeoutMinutes * MINUTE_MS;
}

/** Whether this request should record the session's activity (`ACTIVITY_WRITE_INTERVAL_MS`). */
export function activityDue(lastActiveAt: Date, now: Date): boolean {
  return now.getTime() - lastActiveAt.getTime() >= ACTIVITY_WRITE_INTERVAL_MS;
}
