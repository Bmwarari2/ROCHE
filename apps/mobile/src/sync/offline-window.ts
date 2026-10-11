/**
 * The device's offline window (ADR-0011, care.md section 6): how many days of notes, charts,
 * body-map marks, activities and visits stay on the device. The figure is the tenant's
 * `mobile.offline_window_days` from the rate table. The API puts the window in the signed sync
 * token, and the streams read it only from there, so nothing the device sends can widen it
 * (security review S1). The device reads the same figure through `GET /v1/rates/{key}` whenever
 * the vault opens online, and keeps it in the encrypted database for offline starts, only to say
 * how many days it keeps (HZ-028). Refused entries are not tied to the window: the server keeps no
 * copy of them, so they stay until someone deals with them (clinical review M1).
 *
 * If the figure has never been read (a first start without signal straight after sign-in, or the
 * rate missing), the device reports today only. That is a fail-safe floor, not a tenant figure,
 * and the next online start corrects it.
 */

import { isValidWindowDays, OFFLINE_WINDOW_RATE_KEY } from "@harbour/sync/client";
import type { AbstractPowerSyncDatabase } from "@powersync/common";
import type { FetchLike } from "../auth/http";
import { TENANT_HEADER } from "./connector";

/** Days kept until the tenant's figure is known (today only). */
export const FAIL_SAFE_WINDOW_DAYS = 1;

/** `sync_meta` row holding the last figure read from the rate table. */
export const WINDOW_META_ID = "meta:offline-window-days";
export const WINDOW_META_KEY = "offline_window_days";

export interface FetchWindowOptions {
  readonly apiUrl: string;
  readonly fetch: FetchLike;
  readonly token: string;
  readonly tenantId: string;
}

/** The tenant's figure from the rate table, or null when it cannot be read or is not usable. */
export function fetchOfflineWindowDays(options: FetchWindowOptions): Promise<number | null> {
  return fetchRateDays(options, OFFLINE_WINDOW_RATE_KEY);
}

/** A whole number of days (1 to 31) from the rate table, or null when it cannot be read. */
export async function fetchRateDays(
  options: FetchWindowOptions,
  key: string,
): Promise<number | null> {
  try {
    const response = await options.fetch(`${options.apiUrl}/v1/rates/${encodeURIComponent(key)}`, {
      method: "GET",
      headers: {
        Accept: "application/json",
        Authorization: `Bearer ${options.token}`,
        [TENANT_HEADER]: options.tenantId,
      },
      credentials: "omit",
    });
    if (!response.ok) return null;
    const body: unknown = await response.json();
    const value =
      typeof body === "object" && body !== null ? (body as { value?: unknown }).value : null;
    return isValidWindowDays(value) ? value : null;
  } catch {
    return null;
  }
}

/** Parses the cached figure; anything unusable reads as not cached. */
export function parseCachedWindowDays(value: string | null | undefined): number | null {
  if (!value) return null;
  const parsed = Number(value);
  return isValidWindowDays(parsed) ? parsed : null;
}

/** The figure to use: the one just read, else the cached one, else the fail-safe floor. */
export function chooseWindowDays(fetched: number | null, cached: number | null): number {
  return fetched ?? cached ?? FAIL_SAFE_WINDOW_DAYS;
}

export type MetaStore = Pick<AbstractPowerSyncDatabase, "getOptional" | "execute">;

export async function readCachedWindowDays(db: MetaStore): Promise<number | null> {
  const row = await db
    .getOptional<{ value: string }>("SELECT value FROM sync_meta WHERE id = ?", [WINDOW_META_ID])
    .catch(() => null);
  return parseCachedWindowDays(row?.value);
}

export async function writeCachedWindowDays(db: MetaStore, days: number): Promise<void> {
  await db.execute("DELETE FROM sync_meta WHERE id = ?", [WINDOW_META_ID]);
  await db.execute("INSERT INTO sync_meta (id, key, value) VALUES (?, ?, ?)", [
    WINDOW_META_ID,
    WINDOW_META_KEY,
    String(days),
  ]);
}

/**
 * Reads the tenant's figure (online) or the cached one (offline), caches a new figure, and returns
 * the number of days. Display and ageing only: the window that syncs is the one in the token.
 */
export async function resolveOfflineWindow(
  db: MetaStore,
  fetchOptions: FetchWindowOptions | null,
): Promise<{ readonly days: number }> {
  const [fetched, cached] = await Promise.all([
    fetchOptions ? fetchOfflineWindowDays(fetchOptions) : Promise.resolve(null),
    readCachedWindowDays(db),
  ]);
  if (fetched !== null && fetched !== cached) {
    await writeCachedWindowDays(db, fetched).catch(() => undefined);
  }
  return { days: chooseWindowDays(fetched, cached) };
}
