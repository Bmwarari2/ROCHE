/**
 * Times on care entries (care.md section 4 rule 3; hazards HZ-010 and HZ-017).
 *
 * - `occurred_at` is when the care happened: now, or a time earlier today chosen by the carer.
 *   It is never later than the device clock, so a future event cannot be recorded.
 * - `device_time` is the device clock when the entry was written. The server measures lateness
 *   from it, so an entry written on time and uploaded hours later is not flagged late.
 * - Display is UK time, dd/mm/yyyy and 24-hour, whatever the device's own time zone.
 */
import { formatUkDate, formatUkTime, fromUkWallClock, toUkWallClock } from "@harbour/domain";
import type { MessageKey } from "../i18n/t";

export type WhenChoice =
  | { readonly kind: "now" }
  | { readonly kind: "earlier"; readonly time: string };

export type OccurredAt =
  | { readonly ok: true; readonly occurredAt: Date }
  | { readonly ok: false; readonly error: MessageKey };

// Anchored at both ends with a fixed number of digits: no backtracking on what the user types.
const TIME = /^(\d{1,2}):(\d{2})$/;

/** Reads "14:30" (24-hour) as hours and minutes, or null. */
export function parseClockTime(value: string): { hour: number; minute: number } | null {
  const match = TIME.exec(value.trim());
  if (!match) return null;
  const hour = Number(match[1]);
  const minute = Number(match[2]);
  if (hour > 23 || minute > 59) return null;
  return { hour, minute };
}

/** When the event happened, from the carer's choice, checked against the device clock. */
export function resolveOccurredAt(choice: WhenChoice, now: Date): OccurredAt {
  if (choice.kind === "now") return { ok: true, occurredAt: now };
  const time = parseClockTime(choice.time);
  if (!time) return { ok: false, error: "mobile.when.invalid" };
  const today = toUkWallClock(now);
  const occurredAt = fromUkWallClock(today.year, today.month, today.day, time.hour, time.minute);
  if (occurredAt.getTime() > now.getTime()) return { ok: false, error: "mobile.when.future" };
  return { ok: true, occurredAt };
}

// Synced timestamps arrive as "2026-10-11T09:00:00.000000Z" (microseconds); entries written on the
// device as "2026-10-11T09:00:00.000Z". Anchored, with no overlapping repeats.
const INSTANT =
  /^(\d{4}-\d{2}-\d{2})[T ](\d{2}:\d{2}(?::\d{2})?)(?:\.(\d{1,9}))?(Z|[+-]\d{2}:\d{2})?$/;

/** Parses a stored timestamp, trimming sub-millisecond digits; UTC when no zone is given. */
export function parseInstant(value: string | null | undefined): Date | null {
  if (!value) return null;
  const match = INSTANT.exec(value);
  if (!match) return null;
  const [, date, clock, fraction, zone] = match;
  const millis = fraction ? `.${fraction.slice(0, 3).padEnd(3, "0")}` : "";
  const parsed = new Date(`${date}T${clock}${millis}${zone ?? "Z"}`);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

/** "11/10/2026" and "14:30" in UK time. */
export function ukDateTimeParts(instant: Date): { readonly date: string; readonly time: string } {
  return { date: formatUkDate(instant), time: formatUkTime(instant) };
}

/** "11/10/2026" from an ISO calendar date (no time zone shift for a date-only value). */
export function formatIsoDate(value: string | null | undefined): string | null {
  if (!value) return null;
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value.slice(0, 10));
  return match ? `${match[3]}/${match[2]}/${match[1]}` : null;
}
