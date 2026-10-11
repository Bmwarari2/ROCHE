/**
 * Stale-data rule for offline care data (hazard HZ-002: stale offline data shown as current).
 *
 * The threshold is passed in by the app (it will become a tenant setting); this module only
 * decides, consistently everywhere, whether data last synced at a given moment counts as stale.
 */

/** Milliseconds since the last successful sync, or null if the device has never synced. */
export function syncAgeMs(lastSyncedAt: Date | null | undefined, now: Date): number | null {
  if (!lastSyncedAt) return null;
  // A last-sync time in the future means the device clock moved backwards; treat the age as zero
  // rather than negative so callers do not have to handle it.
  return Math.max(0, now.getTime() - lastSyncedAt.getTime());
}

/**
 * True when the data on the device should carry a "may be out of date" warning.
 * Never having synced is always stale: there is nothing current to show.
 */
export function isStale(
  lastSyncedAt: Date | null | undefined,
  now: Date,
  staleAfterMs: number,
): boolean {
  if (!Number.isFinite(staleAfterMs) || staleAfterMs <= 0) {
    throw new RangeError("staleAfterMs must be a positive number of milliseconds");
  }
  const age = syncAgeMs(lastSyncedAt, now);
  if (age === null) return true;
  return age > staleAfterMs;
}
