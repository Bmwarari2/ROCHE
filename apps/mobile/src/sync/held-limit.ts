/**
 * How long unsent entries are held after the session ended before a manager must resolve them
 * (HZ-006, HZ-040; security review M3, clinical review H2): the tenant's
 * `mobile.held_entries_max_days` from the rate table. The device reads it whenever the vault opens
 * online and keeps it in the encrypted database's bookkeeping, because the session usually ends
 * offline, when the API cannot be asked.
 *
 * Nothing is ever deleted when the time is up. Held entries stay encrypted until their owner signs
 * in and sends them, or the owner or a manager signs in on the device and deletes them with a
 * reason (`held-work.ts`). The time limit escalates instead: the last day shows a final warning,
 * and once the time is up the sign-in screen says a manager must resolve them. A local notification
 * fires when the last day starts and when the time is up, without names or counts.
 *
 * The device clock is never trusted to move a hold on: a clock earlier than when the hold started,
 * or than the last time the server was reached, is reported as such and changes nothing. A clock
 * that jumped forward can only bring the escalation sooner, never a deletion. Until the tenant's
 * figure has been read, a hold escalates after one day: a fail-safe floor, not a tenant figure.
 */
import type { FetchWindowOptions, MetaStore } from "./offline-window";
import { fetchRateDays } from "./offline-window";

export const HELD_MAX_DAYS_RATE_KEY = "mobile.held_entries_max_days";

/** `sync_meta` row holding the last figure read from the rate table. */
export const HELD_MAX_META_ID = "meta:held-entries-max-days";
export const HELD_MAX_META_KEY = "held_entries_max_days";

/** Days a hold lasts before it escalates, until the tenant's figure is known. */
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

/** When a hold that started at `heldAt` escalates to a manager. */
export function heldDeadline(heldAt: Date, days: number): Date {
  return new Date(heldAt.getTime() + days * DAY_MS);
}

function instant(value: string | null | undefined): number | null {
  if (!value) return null;
  const parsed = Date.parse(value);
  return Number.isNaN(parsed) ? null : parsed;
}

/** The times a hold's state depends on (from the held marker). */
export interface HeldTimes {
  readonly heldAt: string;
  readonly expiresAt: string | null;
  /** The last time the device heard from the server before the hold, when known. */
  readonly lastServerTime: string | null;
}

/**
 * open: waiting for the owner. final: the last day, with a warning naming the count and the time.
 * escalated: the time is up and a manager must resolve the entries (nothing is deleted).
 * clockBehind: the device clock reads earlier than the hold's start or the last server time, so it
 * cannot be trusted and nothing changes. A hold without a usable deadline is escalated, never
 * open-ended.
 */
export type HeldTimeState = "open" | "final" | "escalated" | "clockBehind";

export function heldTimeState(held: HeldTimes, now: Date): HeldTimeState {
  const floor = Math.max(instant(held.heldAt) ?? 0, instant(held.lastServerTime) ?? 0);
  if (now.getTime() < floor) return "clockBehind";
  const deadline = instant(held.expiresAt);
  if (deadline === null || now.getTime() >= deadline) return "escalated";
  return deadline - now.getTime() <= FINAL_WARNING_MS ? "final" : "open";
}

/** Fixed notification identifiers, so a new plan replaces the old and a cancel needs no lookup. */
export const HELD_NOTIFICATION_IDS = {
  final: "harbour.held-entries.final-day",
  escalated: "harbour.held-entries.escalated",
} as const;

export interface PlannedNotification {
  readonly identifier: string;
  readonly kind: "final" | "escalated";
  readonly at: Date;
}

/**
 * The local notifications for a hold: when its last day starts and when it escalates, only those
 * still ahead. The times are absolute, so a wrong clock moves nothing but when they show.
 */
export function planHeldNotifications(held: HeldTimes, now: Date): PlannedNotification[] {
  const deadline = instant(held.expiresAt);
  if (deadline === null) return [];
  const plan: PlannedNotification[] = [
    {
      identifier: HELD_NOTIFICATION_IDS.final,
      kind: "final",
      at: new Date(deadline - FINAL_WARNING_MS),
    },
    { identifier: HELD_NOTIFICATION_IDS.escalated, kind: "escalated", at: new Date(deadline) },
  ];
  return plan.filter((p) => p.at.getTime() > now.getTime());
}
