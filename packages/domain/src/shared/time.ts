/**
 * Time rules (sections 5.4, 10.3, 11.2). Instants are stored in UTC; anything a person reads, and
 * every statutory deadline, is computed in Europe/London so daylight-saving changes never move a
 * deadline or a time-critical dose (hazard HZ-009). Formats are dd/mm/yyyy and 24-hour time.
 */

export const UK_TIME_ZONE = "Europe/London";

const dateFormatter = new Intl.DateTimeFormat("en-GB", {
  timeZone: UK_TIME_ZONE,
  day: "2-digit",
  month: "2-digit",
  year: "numeric",
});

const timeFormatter = new Intl.DateTimeFormat("en-GB", {
  timeZone: UK_TIME_ZONE,
  hour: "2-digit",
  minute: "2-digit",
  hourCycle: "h23",
});

const partsFormatter = new Intl.DateTimeFormat("en-GB", {
  timeZone: UK_TIME_ZONE,
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
  second: "2-digit",
  hourCycle: "h23",
});

export function formatUkDate(instant: Date): string {
  return dateFormatter.format(instant);
}

export function formatUkTime(instant: Date): string {
  return timeFormatter.format(instant);
}

export function formatUkDateTime(instant: Date): string {
  return `${formatUkDate(instant)} ${formatUkTime(instant)}`;
}

/**
 * As `formatUkDateTime`, with "GMT" or "BST" after the time, so a time in the repeated hour when
 * the clocks go back (01:00 to 01:59 in late October) reads one way only (HZ-050: a pack read by
 * someone outside the provider, with no other way to tell the two apart).
 */
export function formatUkDateTimeWithZone(instant: Date): string {
  const w = toUkWallClock(instant);
  const asUtc = Date.UTC(w.year, w.month - 1, w.day, w.hour, w.minute, w.second);
  const wholeSeconds = Math.floor(instant.getTime() / 1000) * 1000;
  return `${formatUkDateTime(instant)} ${asUtc === wholeSeconds ? "GMT" : "BST"}`;
}

interface WallClock {
  readonly year: number;
  readonly month: number;
  readonly day: number;
  readonly hour: number;
  readonly minute: number;
  readonly second: number;
}

export function toUkWallClock(instant: Date): WallClock {
  const parts = Object.fromEntries(
    partsFormatter.formatToParts(instant).map((p) => [p.type, p.value]),
  ) as Record<string, string>;
  return {
    year: Number(parts.year),
    month: Number(parts.month),
    day: Number(parts.day),
    hour: Number(parts.hour),
    minute: Number(parts.minute),
    second: Number(parts.second),
  };
}

/** Offset of UK local time from UTC in minutes at an instant (0 in winter, 60 in summer). */
export function ukOffsetMinutes(instant: Date): number {
  const w = toUkWallClock(instant);
  const asUtc = Date.UTC(w.year, w.month - 1, w.day, w.hour, w.minute, w.second);
  return Math.round((asUtc - Math.floor(instant.getTime() / 1000) * 1000) / 60_000);
}

/**
 * Every instant at which a UK wall-clock time occurs, earliest first: none in the spring-forward
 * gap (01:00-01:59 on the last Sunday in March), two in the autumn overlap (01:00-01:59 on the
 * last Sunday in October, first BST then GMT), and one at any other time.
 */
export function ukWallClockOccurrences(
  year: number,
  month: number,
  day: number,
  hour: number,
  minute: number,
): readonly Date[] {
  const naive = Date.UTC(year, month - 1, day, hour, minute);
  const offsets = new Set([
    ukOffsetMinutes(new Date(naive - 60 * 60_000)),
    ukOffsetMinutes(new Date(naive)),
    ukOffsetMinutes(new Date(naive + 60 * 60_000)),
  ]);
  return [...offsets]
    .map((offset) => new Date(naive - offset * 60_000))
    .filter((d) => {
      const w = toUkWallClock(d);
      return (
        w.year === year &&
        w.month === month &&
        w.day === day &&
        w.hour === hour &&
        w.minute === minute
      );
    })
    .sort((a, b) => a.getTime() - b.getTime());
}

/**
 * The instant at which a UK wall-clock time occurs, for computed times such as deadlines and
 * schedules. During the spring-forward gap the time does not exist and moves forward an hour;
 * during the autumn overlap the first (BST) occurrence is used, so deadlines are never late.
 * Times a person types for an event use `resolveRecordedUkTime` instead, which never guesses.
 * A date or time that does not exist on any calendar (31/11, 24:00) throws a `RangeError`.
 */
export function fromUkWallClock(
  year: number,
  month: number,
  day: number,
  hour: number,
  minute: number,
): Date {
  const first = ukWallClockOccurrences(year, month, day, hour, minute)[0];
  if (first) return first;
  // Non-existent local time (spring forward): the same wall time an hour later. The gap is one
  // hour, so one step is always enough; anything else is not a time on the UK clock at all (31/11,
  // 25:00), and is refused rather than retried for ever.
  const later = ukWallClockOccurrences(year, month, day, hour + 1, minute)[0];
  if (later) return later;
  throw new RangeError("Not a time on the UK clock");
}

export interface UkWallClockTime {
  readonly year: number;
  readonly month: number;
  readonly day: number;
  readonly hour: number;
  readonly minute: number;
}

/**
 * How a typed UK date and time resolves to an instant (HZ-009, HZ-010, HZ-017):
 * - `exact`: one instant, at or before now (plus the clock tolerance).
 * - `ambiguous`: the time happened twice when the clocks went back and both are past; the person
 *   must choose "BST, before the clocks went back" (`earlier`) or "GMT, after" (`later`). There is
 *   no default, because either guess can put events in the wrong order.
 * - `skipped`: the time did not happen because the clocks went forward; refuse it.
 * - `future`: the time has not happened yet; refuse it. Never roll it back to an earlier day.
 */
export type RecordedUkTime =
  | { readonly kind: "exact"; readonly instant: Date }
  | { readonly kind: "ambiguous"; readonly earlier: Date; readonly later: Date }
  | { readonly kind: "skipped" }
  | { readonly kind: "future"; readonly instant: Date };

export interface RecordedUkTimeOptions {
  /** The current instant from the device or server clock. */
  readonly now: Date;
  /** Minutes ahead of `now` still accepted, from the clock-drift tolerance in the rate table. */
  readonly futureToleranceMinutes: number;
}

function isValidWallClock(t: UkWallClockTime): boolean {
  const whole = [t.year, t.month, t.day, t.hour, t.minute].every(Number.isInteger);
  if (!whole || t.month < 1 || t.month > 12 || t.day < 1) return false;
  if (t.hour < 0 || t.hour > 23 || t.minute < 0 || t.minute > 59) return false;
  return t.day <= new Date(Date.UTC(t.year, t.month, 0)).getUTCDate();
}

/**
 * Resolves a date and time a person typed for when something happened. The one rule for every
 * screen that records an event time, web and mobile alike.
 */
export function resolveRecordedUkTime(
  time: UkWallClockTime,
  options: RecordedUkTimeOptions,
): RecordedUkTime {
  if (!isValidWallClock(time)) throw new RangeError("Not a valid date and time.");
  if (!Number.isFinite(options.futureToleranceMinutes) || options.futureToleranceMinutes < 0) {
    throw new RangeError("The future tolerance must be zero or more minutes.");
  }
  const occurrences = ukWallClockOccurrences(
    time.year,
    time.month,
    time.day,
    time.hour,
    time.minute,
  );
  const [first, second] = occurrences;
  if (!first) return { kind: "skipped" };
  const limit = options.now.getTime() + options.futureToleranceMinutes * 60_000;
  if (first.getTime() > limit) return { kind: "future", instant: first };
  if (!second || second.getTime() > limit) return { kind: "exact", instant: first };
  return { kind: "ambiguous", earlier: first, later: second };
}

/** "BST" or "GMT": shown beside a time on a clock-change day so the two 01:30s differ. */
export function ukZoneAbbreviation(instant: Date): "BST" | "GMT" {
  return ukOffsetMinutes(instant) === 0 ? "GMT" : "BST";
}

/** True on the two days a year the UK clocks change. */
export function isUkClockChangeDay(year: number, month: number, day: number): boolean {
  const start = ukOffsetMinutes(new Date(Date.UTC(year, month - 1, day, 0, 0)));
  const end = ukOffsetMinutes(new Date(Date.UTC(year, month - 1, day, 23, 59)));
  return start !== end;
}

/** Adds calendar days in UK local time, keeping the wall-clock time across DST changes. */
export function addUkDays(instant: Date, days: number): Date {
  const w = toUkWallClock(instant);
  const next = new Date(Date.UTC(w.year, w.month - 1, w.day + days));
  return fromUkWallClock(
    next.getUTCFullYear(),
    next.getUTCMonth() + 1,
    next.getUTCDate(),
    w.hour,
    w.minute,
  );
}

/**
 * Adds calendar months in UK local time, keeping the wall-clock time. The 31st plus a month, or
 * 29 February plus a year, falls back to the last day of the shorter month, so a maximum period
 * (for example a standard DoLS authorisation of up to a year) can only end early, never late.
 */
export function addUkMonths(instant: Date, months: number): Date {
  if (!Number.isInteger(months)) throw new RangeError("Months must be a whole number.");
  const w = toUkWallClock(instant);
  const firstOfTarget = new Date(Date.UTC(w.year, w.month - 1 + months, 1));
  const year = firstOfTarget.getUTCFullYear();
  const month = firstOfTarget.getUTCMonth() + 1;
  const lastDay = new Date(Date.UTC(year, month, 0)).getUTCDate();
  return fromUkWallClock(year, month, Math.min(w.day, lastDay), w.hour, w.minute);
}

/** 00:00 UK time at the start of an ISO date (the first moment a dated period is in force). */
export function ukStartOfDay(isoDate: string): Date {
  const [year, month, day] = isoDate.split("-").map(Number) as [number, number, number];
  return fromUkWallClock(year, month, day, 0, 0);
}

/** The first moment after an ISO date ends in UK time (the end of a period "to" that date). */
export function ukEndOfDay(isoDate: string): Date {
  const [year, month, day] = isoDate.split("-").map(Number) as [number, number, number];
  const next = new Date(Date.UTC(year, month - 1, day + 1));
  return fromUkWallClock(next.getUTCFullYear(), next.getUTCMonth() + 1, next.getUTCDate(), 0, 0);
}

/** Clock drift beyond this many minutes is flagged on synced records (section 10.3, HZ-010). */
export const DEFAULT_CLOCK_DRIFT_TOLERANCE_MINUTES = 5;

export function clockDriftMinutes(deviceTime: Date, serverReceivedAt: Date): number {
  return Math.round((deviceTime.getTime() - serverReceivedAt.getTime()) / 60_000);
}

/**
 * True when a device clock disagrees with the server by more than the tolerance. Compare the
 * device's clock at the moment it sent the upload with the server's receipt time, never the time
 * a record was created offline: that difference is time spent in the queue, not drift.
 */
export function hasClockDrift(
  deviceSentAt: Date,
  serverReceivedAt: Date,
  toleranceMinutes = DEFAULT_CLOCK_DRIFT_TOLERANCE_MINUTES,
): boolean {
  return Math.abs(clockDriftMinutes(deviceSentAt, serverReceivedAt)) > toleranceMinutes;
}
