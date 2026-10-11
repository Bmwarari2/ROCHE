/**
 * Times on care entries (care.md section 4 rule 3; hazards HZ-010 and HZ-017; clinical review C4).
 *
 * - `occurred_at` is when the care happened: now, a time on an earlier day within the offline
 *   window, or (for a correction) the original entry's time, which a correction keeps by default.
 *   It is never later than the device clock, so a future event cannot be recorded.
 * - A time typed without a day means the most recent time the clock showed it: at 00:30, "23:45"
 *   is yesterday, not tonight.
 * - Wall-clock times are UK time. On the spring change a time that did not happen (01:00 to 01:59
 *   on the last Sunday in March) is refused; on the autumn change a time that happened twice is
 *   the latest one not in the future.
 * - `device_time` is the device clock when the entry was written. The server measures lateness
 *   from it, so an entry written on time and uploaded hours later is not flagged late.
 * - Display is UK time, dd/mm/yyyy and 24-hour, whatever the device's own time zone.
 */
import { formatUkDate, formatUkTime, toUkWallClock } from "@harbour/domain";
import type { MessageKey } from "../i18n/t";

export type WhenChoice =
  | { readonly kind: "now" }
  /**
   * A time on an earlier day: `daysAgo` counts UK calendar days back from today (0 is today);
   * null means the most recent time the clock showed it (today, or yesterday if that is later).
   */
  | { readonly kind: "earlier"; readonly time: string; readonly daysAgo?: number | null }
  /** A correction keeps the original entry's event time unless the carer changes it. */
  | { readonly kind: "original"; readonly at: string };

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

/** The UK calendar date `daysAgo` days before the UK date at `now`. */
export function ukDateDaysAgo(
  now: Date,
  daysAgo: number,
): { readonly year: number; readonly month: number; readonly day: number } {
  const today = toUkWallClock(now);
  const date = new Date(Date.UTC(today.year, today.month - 1, today.day - daysAgo));
  return { year: date.getUTCFullYear(), month: date.getUTCMonth() + 1, day: date.getUTCDate() };
}

/**
 * Every instant at which a UK wall-clock time occurs on a date: none in the spring gap, two in the
 * autumn overlap, otherwise one. UK time is GMT or GMT plus one hour.
 */
export function ukInstantsAt(
  date: { readonly year: number; readonly month: number; readonly day: number },
  hour: number,
  minute: number,
): Date[] {
  const naive = Date.UTC(date.year, date.month - 1, date.day, hour, minute);
  return [60, 0]
    .map((offsetMinutes) => new Date(naive - offsetMinutes * 60_000))
    .filter((instant) => {
      const wall = toUkWallClock(instant);
      return (
        wall.year === date.year &&
        wall.month === date.month &&
        wall.day === date.day &&
        wall.hour === hour &&
        wall.minute === minute
      );
    });
}

/** How many days back the carer may choose: the offline window less today, and at least one. */
export function maxDaysBack(windowDays: number | null | undefined): number {
  return Math.max(1, (windowDays ?? 1) - 1);
}

/** When the event happened, from the carer's choice, checked against the device clock. */
export function resolveOccurredAt(
  choice: WhenChoice,
  now: Date,
  windowDays?: number | null,
): OccurredAt {
  if (choice.kind === "now") return { ok: true, occurredAt: now };
  if (choice.kind === "original") {
    const at = parseInstant(choice.at);
    if (!at) return { ok: false, error: "mobile.when.invalid" };
    if (at.getTime() > now.getTime()) return { ok: false, error: "mobile.when.future" };
    return { ok: true, occurredAt: at };
  }
  const time = parseClockTime(choice.time);
  if (!time) return { ok: false, error: "mobile.when.invalid" };
  const daysAgo = choice.daysAgo ?? null;
  if (daysAgo !== null && (!Number.isInteger(daysAgo) || daysAgo < 0)) {
    return { ok: false, error: "mobile.when.invalid" };
  }
  if (daysAgo !== null && daysAgo > maxDaysBack(windowDays)) {
    return { ok: false, error: "mobile.when.outsideWindow" };
  }
  const days = daysAgo === null ? [0, 1] : [daysAgo];
  const onDays = days.map((d) => ukInstantsAt(ukDateDaysAgo(now, d), time.hour, time.minute));
  const candidates = onDays.flat().filter((instant) => instant.getTime() <= now.getTime());
  if (candidates.length > 0) {
    // The latest occurrence not in the future: the most recent day, and in the autumn overlap the
    // second of the two.
    const latest = candidates.reduce((a, b) => (b.getTime() > a.getTime() ? b : a));
    return { ok: true, occurredAt: latest };
  }
  // On the chosen day the time either did not happen (spring change) or is still to come.
  if (onDays.every((list) => list.length === 0)) return { ok: false, error: "mobile.when.skipped" };
  return { ok: false, error: "mobile.when.future" };
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

/** "11/10/2026" for the UK date `daysAgo` days back, for the day choices. */
export function ukDateLabel(now: Date, daysAgo: number): string {
  const date = ukDateDaysAgo(now, daysAgo);
  return `${String(date.day).padStart(2, "0")}/${String(date.month).padStart(2, "0")}/${date.year}`;
}
