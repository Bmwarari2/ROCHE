/**
 * The offline window's days, exactly as the last sync token gave them (`offline_days`: UTC
 * calendar days, tomorrow, today and the days before; the streams read only these). The round and
 * the handover say what the phone holds from these, never from a day count and the clock, so in
 * British Summer Time a sync late in the evening never claims a day the phone does not hold
 * (#123 clinical review, M4; HZ-028, HZ-009).
 */
import { decodeTokenClaims } from "./write-scope";

/** `sync_meta` row holding the days of the last token. */
export const OFFLINE_DAYS_META_ID = "meta:offline-days";
export const OFFLINE_DAYS_META_KEY = "offline_days";

const DAY = /^\d{4}-\d{2}-\d{2}$/;
const DAY_MS = 86_400_000;

/** The readable days, sorted; null when the value is not a list of days. */
export function parseOfflineDays(value: unknown): string[] | null {
  if (!Array.isArray(value)) return null;
  const days = value.filter(
    (d): d is string =>
      typeof d === "string" && DAY.test(d) && !Number.isNaN(Date.parse(`${d}T00:00:00Z`)),
  );
  return days.length > 0 ? [...new Set(days)].sort() : null;
}

/** The days a sync token carries; null when it carries none. */
export function offlineDaysFromToken(token: string): string[] | null {
  const claims = decodeTokenClaims(token);
  return claims ? parseOfflineDays(claims.offline_days) : null;
}

/** The days kept on the phone (`sync_meta` value), or null. */
export function parseCachedOfflineDays(value: string | null | undefined): string[] | null {
  if (!value) return null;
  try {
    return parseOfflineDays(JSON.parse(value));
  } catch {
    return null;
  }
}

/** The instants the days cover: from the first day's UTC midnight to the end of the last. */
export function offlineWindowBounds(days: readonly string[]): { start: Date; end: Date } | null {
  const first = days[0];
  const last = days.at(-1);
  if (!first || !last) return null;
  return {
    start: new Date(`${first}T00:00:00Z`),
    // Exclusive: the next UTC midnight.
    end: new Date(Date.parse(`${last}T00:00:00Z`) + DAY_MS),
  };
}

/** Reads and writes `sync_meta`. */
export interface OfflineDaysMetaStore {
  execute(sql: string, params?: unknown[]): Promise<unknown>;
}

/** Keeps the days a new token carries in place of the last. */
export async function writeCachedOfflineDays(
  db: OfflineDaysMetaStore,
  days: readonly string[],
): Promise<void> {
  await db.execute("DELETE FROM sync_meta WHERE id = ?", [OFFLINE_DAYS_META_ID]);
  await db.execute("INSERT INTO sync_meta (id, key, value) VALUES (?, ?, ?)", [
    OFFLINE_DAYS_META_ID,
    OFFLINE_DAYS_META_KEY,
    JSON.stringify(days),
  ]);
}
