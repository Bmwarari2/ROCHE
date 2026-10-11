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
 * The instant at which a UK wall-clock time occurs. During the spring-forward gap (01:00-02:00 on
 * the last Sunday in March) the time does not exist and moves forward an hour; during the autumn
 * overlap the first (BST) occurrence is used, so deadlines are never late.
 */
export function fromUkWallClock(
  year: number,
  month: number,
  day: number,
  hour: number,
  minute: number,
): Date {
  const naive = Date.UTC(year, month - 1, day, hour, minute);
  const offsets = new Set([
    ukOffsetMinutes(new Date(naive - 60 * 60_000)),
    ukOffsetMinutes(new Date(naive)),
    ukOffsetMinutes(new Date(naive + 60 * 60_000)),
  ]);
  const candidates = [...offsets]
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
  if (candidates[0]) return candidates[0];
  // Non-existent local time (spring forward): the same wall time an hour later.
  return fromUkWallClock(year, month, day, hour + 1, minute);
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
