/**
 * How far ahead of the device clock a typed event time may be (HZ-010; clinical review round 3,
 * H1): the tenant's `sync.clock_drift_flag_minutes` from the rate table, the same tolerance the
 * server uses to flag clock drift. A time beyond it is refused as in the future.
 *
 * The device reads the figure whenever the vault opens online and keeps it in the encrypted
 * database's bookkeeping for offline starts. Until it has been read, the tolerance is none at all:
 * a fail-safe floor, not a tenant figure, so a time later than the device clock is never accepted
 * on a figure the device does not have.
 */
import { type FetchWindowOptions, fetchRate, type MetaStore } from "./offline-window";

export const CLOCK_TOLERANCE_RATE_KEY = "sync.clock_drift_flag_minutes";
export const CLOCK_TOLERANCE_META_ID = "meta:clock-drift-flag-minutes";
const CLOCK_TOLERANCE_META_KEY = "clock_drift_flag_minutes";

/** Minutes of tolerance until the tenant's figure is known. */
export const FAIL_SAFE_TOLERANCE_MINUTES = 0;

/** A usable tolerance: whole minutes from 0 to 60. */
export function isValidToleranceMinutes(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= 0 && value <= 60;
}

export async function readCachedToleranceMinutes(db: MetaStore): Promise<number | null> {
  const row = await db
    .getOptional<{ value: string }>("SELECT value FROM sync_meta WHERE id = ?", [
      CLOCK_TOLERANCE_META_ID,
    ])
    .catch(() => null);
  if (!row?.value) return null;
  const parsed = Number(row.value);
  return isValidToleranceMinutes(parsed) ? parsed : null;
}

/** Reads the tenant's figure when online and caches it; returns the figure to use now. */
export async function resolveClockTolerance(
  db: MetaStore,
  fetchOptions: FetchWindowOptions | null,
): Promise<number> {
  const [rate, cached] = await Promise.all([
    fetchOptions ? fetchRate(fetchOptions, CLOCK_TOLERANCE_RATE_KEY) : Promise.resolve(null),
    readCachedToleranceMinutes(db),
  ]);
  const fetched =
    rate && rate.unit === "minutes" && isValidToleranceMinutes(rate.value) ? rate.value : null;
  if (fetched !== null && fetched !== cached) {
    await db
      .execute("DELETE FROM sync_meta WHERE id = ?", [CLOCK_TOLERANCE_META_ID])
      .then(() =>
        db.execute("INSERT INTO sync_meta (id, key, value) VALUES (?, ?, ?)", [
          CLOCK_TOLERANCE_META_ID,
          CLOCK_TOLERANCE_META_KEY,
          String(fetched),
        ]),
      )
      .catch(() => undefined);
  }
  return fetched ?? cached ?? FAIL_SAFE_TOLERANCE_MINUTES;
}
