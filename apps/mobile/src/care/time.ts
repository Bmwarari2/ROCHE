/**
 * Times on care entries (care.md section 4 rule 3; hazards HZ-009, HZ-010 and HZ-017; clinical
 * reviews C4 and round 3 H1).
 *
 * - `occurred_at` is when the care happened: now, a time typed for a day the carer chooses within
 *   the offline window (today unless they choose another), or, for a correction, the original
 *   entry's instant, kept exactly as it was.
 * - A typed time goes through the one shared rule, `resolveRecordedUkTime` in `@harbour/domain`, as
 *   on the web. A time later than the device clock by more than the tenant's clock-drift tolerance
 *   (`sync.clock_drift_flag_minutes`) is refused; it is never rolled back to yesterday. Earlier
 *   days come only from the explicit day choice.
 * - Wall-clock times are UK time. On the spring change a time that did not happen (01:00 to 01:59
 *   on the last Sunday in March) is refused. On the autumn change, a time in the repeated hour
 *   whose two occurrences have both passed needs the carer to choose "BST, before the clocks went
 *   back" or "GMT, after"; there is no default, because either guess can put events in the wrong
 *   order. On a clock-change day, times show BST or GMT beside them.
 * - `device_time` is the device clock when the entry was written. The server measures lateness
 *   from it, so an entry written on time and uploaded hours later is not flagged late.
 * - Display is UK time, dd/mm/yyyy and 24-hour, whatever the device's own time zone.
 */
import {
  formatUkDate,
  formatUkTime,
  isUkClockChangeDay,
  resolveRecordedUkTime,
  toUkWallClock,
  ukZoneAbbreviation,
} from "@harbour/domain";
import type { MessageKey } from "../i18n/t";

/** Which side of the autumn change a time in the repeated hour was. */
export type UkZone = "BST" | "GMT";

export type WhenChoice =
  | { readonly kind: "now" }
  /**
   * A time on a day the carer chose: `daysAgo` counts UK calendar days back from today (0, the
   * default, is today). `zone` answers which of the two the time was when it happened twice.
   */
  | {
      readonly kind: "earlier";
      readonly time: string;
      readonly daysAgo?: number;
      readonly zone?: UkZone | null;
    }
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

/** How many days back the carer may choose: the offline window less today, and at least one. */
export function maxDaysBack(windowDays: number | null | undefined): number {
  return Math.max(1, (windowDays ?? 1) - 1);
}

type Earlier = Extract<WhenChoice, { kind: "earlier" }>;

/** Reads a typed time through the shared rule; a string is the error to show. */
function readTyped(
  choice: Earlier,
  now: Date,
  windowDays: number | null | undefined,
  toleranceMinutes: number,
): ReturnType<typeof resolveRecordedUkTime> | MessageKey {
  const time = parseClockTime(choice.time);
  if (!time) return "mobile.when.invalid";
  const daysAgo = choice.daysAgo ?? 0;
  if (!Number.isInteger(daysAgo) || daysAgo < 0) return "mobile.when.invalid";
  if (daysAgo > maxDaysBack(windowDays)) return "mobile.when.outsideWindow";
  const date = ukDateDaysAgo(now, daysAgo);
  return resolveRecordedUkTime(
    { ...date, hour: time.hour, minute: time.minute },
    { now, futureToleranceMinutes: Math.max(0, toleranceMinutes) },
  );
}

/**
 * When the event happened, from the carer's choice, checked against the device clock with the
 * tenant's tolerance (`toleranceMinutes`, none until the figure is known).
 */
export function resolveOccurredAt(
  choice: WhenChoice,
  now: Date,
  windowDays?: number | null,
  toleranceMinutes = 0,
): OccurredAt {
  if (choice.kind === "now") return { ok: true, occurredAt: now };
  if (choice.kind === "original") {
    const at = parseInstant(choice.at);
    if (!at) return { ok: false, error: "mobile.when.invalid" };
    if (at.getTime() > now.getTime() + Math.max(0, toleranceMinutes) * 60_000) {
      return { ok: false, error: "mobile.when.future" };
    }
    // The original instant, exactly: never turned back into a wall-clock time and re-read.
    return { ok: true, occurredAt: at };
  }
  const read = readTyped(choice, now, windowDays, toleranceMinutes);
  if (typeof read === "string") return { ok: false, error: read };
  switch (read.kind) {
    case "exact":
      return { ok: true, occurredAt: read.instant };
    case "skipped":
      return { ok: false, error: "mobile.when.skipped" };
    case "future":
      return { ok: false, error: "mobile.when.future" };
    case "ambiguous":
      if (choice.zone === "BST") return { ok: true, occurredAt: read.earlier };
      if (choice.zone === "GMT") return { ok: true, occurredAt: read.later };
      return { ok: false, error: "mobile.when.zoneRequired" };
  }
}

/**
 * The two readings of a time typed in the repeated autumn hour when both have passed, so the form
 * can ask which it was; null for any other time.
 */
export function ambiguousTime(
  choice: WhenChoice,
  now: Date,
  windowDays?: number | null,
  toleranceMinutes = 0,
): { readonly earlier: Date; readonly later: Date } | null {
  if (choice.kind !== "earlier") return null;
  const read = readTyped(choice, now, windowDays, toleranceMinutes);
  return typeof read !== "string" && read.kind === "ambiguous"
    ? { earlier: read.earlier, later: read.later }
    : null;
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

/**
 * "11/10/2026" and "14:30" in UK time. On the two days a year the clocks change, the time carries
 * BST or GMT ("01:30 BST"), so the two 01:30s of an autumn change day never look the same.
 */
export function ukDateTimeParts(instant: Date): { readonly date: string; readonly time: string } {
  const wall = toUkWallClock(instant);
  const time = formatUkTime(instant);
  return {
    date: formatUkDate(instant),
    time: isUkClockChangeDay(wall.year, wall.month, wall.day)
      ? `${time} ${ukZoneAbbreviation(instant)}`
      : time,
  };
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
