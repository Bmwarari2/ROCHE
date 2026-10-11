/**
 * The rate-table figures the family notification rules read (comms.md section 4 rule 15;
 * docs/specs/rates.md). Quiet hours for family notifications are a tenant setting: the rate table
 * holds Harbour's default and a tenant row overrides it. Nothing here is a literal; callers resolve
 * the figures with `resolveCommsRates` (tenant override, then nation, then `uk`, then `all`).
 */

import type { QuietHours } from "../platform/notifications";
import { type RateNation, type RateRow, resolveRate } from "../platform/rates";

export const COMMS_RATE_KEYS = {
  familyQuietStartMinute: "comms.family_notifications.quiet_start_minute",
  familyQuietEndMinute: "comms.family_notifications.quiet_end_minute",
} as const;

export type CommsRateName = keyof typeof COMMS_RATE_KEYS;
export type CommsRates = { readonly [K in CommsRateName]: number };

/** Resolves every comms figure for a tenant location on a date; fails loudly if one is missing. */
export function resolveCommsRates(
  rows: readonly RateRow[],
  nation: Exclude<RateNation, "uk" | "all">,
  on: string,
  tenantId: string | null,
): CommsRates {
  const entries = (Object.keys(COMMS_RATE_KEYS) as CommsRateName[]).map(
    (name) => [name, resolveRate(rows, COMMS_RATE_KEYS[name], nation, on, tenantId).value] as const,
  );
  return Object.fromEntries(entries) as CommsRates;
}

const MINUTES_PER_DAY = 24 * 60;

/** "HH:MM" for a minute of the day (0 to 1439, UK local time); throws on anything else. */
export function minuteOfDayToHhMm(minute: number): string {
  if (!Number.isInteger(minute) || minute < 0 || minute >= MINUTES_PER_DAY) {
    throw new RangeError(`Not a minute of the day: ${minute}`);
  }
  const hours = Math.floor(minute / 60);
  const minutes = minute % 60;
  return `${String(hours).padStart(2, "0")}:${String(minutes).padStart(2, "0")}`;
}

/** The tenant's quiet hours for family notifications, in the notification centre's form. */
export function familyQuietHours(rates: CommsRates): QuietHours {
  return {
    start: minuteOfDayToHhMm(rates.familyQuietStartMinute),
    end: minuteOfDayToHhMm(rates.familyQuietEndMinute),
  };
}
