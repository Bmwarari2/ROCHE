/**
 * How long unsent entries may be held after the session ended (HZ-006, security review S2): the
 * tenant's `mobile.held_entries_max_days` from the rate table. The device reads it whenever the
 * vault opens online and keeps it in the encrypted database's bookkeeping, because the session
 * usually ends offline, when the API cannot be asked.
 *
 * When the time is up the device shows a final warning naming the count during the last day, then
 * deletes the held entries (and records that it did). Until the figure has been read, a hold lasts
 * one day: a fail-safe floor, not a tenant figure, so held entries never linger on a device whose
 * tenant figure is unknown.
 */
import type { FetchWindowOptions, MetaStore } from "./offline-window";
import { fetchRateDays } from "./offline-window";

export const HELD_MAX_DAYS_RATE_KEY = "mobile.held_entries_max_days";

/** `sync_meta` row holding the last figure read from the rate table. */
export const HELD_MAX_META_ID = "meta:held-entries-max-days";
export const HELD_MAX_META_KEY = "held_entries_max_days";

/** Days a hold lasts until the tenant's figure is known. */
export const HELD_FAIL_SAFE_DAYS = 1;

/** The final warning shows during the last day of a hold (a product constant, not a tenant figure). */
export const FINAL_WARNING_MS = 24 * 60 * 60_000;

const DAY_MS = 86_400_000;

function parseDays(value: string | null | undefined): number | null {
  if (!value) return null;
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed >= 1 && parsed <= 31 ? parsed : null;
}

export async function readCachedHeldMaxDays(db: MetaStore): Promise<number | null> {
  const row = await db
    .getOptional<{ value: string }>("SELECT value FROM sync_meta WHERE id = ?", [HELD_MAX_META_ID])
    .catch(() => null);
  return parseDays(row?.value);
}

async function writeCachedHeldMaxDays(db: MetaStore, days: number): Promise<void> {
  await db.execute("DELETE FROM sync_meta WHERE id = ?", [HELD_MAX_META_ID]);
  await db.execute("INSERT INTO sync_meta (id, key, value) VALUES (?, ?, ?)", [
    HELD_MAX_META_ID,
    HELD_MAX_META_KEY,
    String(days),
  ]);
}

/** Reads the tenant's figure when online and caches it; returns the figure to use now. */
export async function resolveHeldMaxDays(
  db: MetaStore,
  fetchOptions: FetchWindowOptions | null,
): Promise<number> {
  const [fetched, cached] = await Promise.all([
    fetchOptions ? fetchRateDays(fetchOptions, HELD_MAX_DAYS_RATE_KEY) : Promise.resolve(null),
    readCachedHeldMaxDays(db),
  ]);
  if (fetched !== null && fetched !== cached) {
    await writeCachedHeldMaxDays(db, fetched).catch(() => undefined);
  }
  return fetched ?? cached ?? HELD_FAIL_SAFE_DAYS;
}

/** When a hold that started at `heldAt` ends. */
export function heldDeadline(heldAt: Date, days: number): Date {
  return new Date(heldAt.getTime() + days * DAY_MS);
}

export type HeldTimeState = "open" | "final" | "expired";

/**
 * Where a hold stands: open, in its final day (the warning names the count and the deadline), or
 * expired (the entries are deleted). A hold with no recorded deadline never expires on its own.
 */
export function heldTimeState(expiresAt: string | null, now: Date): HeldTimeState {
  if (!expiresAt) return "open";
  const deadline = Date.parse(expiresAt);
  if (Number.isNaN(deadline)) return "open";
  if (now.getTime() >= deadline) return "expired";
  return deadline - now.getTime() <= FINAL_WARNING_MS ? "final" : "open";
}
