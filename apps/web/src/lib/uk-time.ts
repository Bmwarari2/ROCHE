/**
 * UK local time for forms (CONTENT.md rule 6, hazard HZ-009). People enter and read times as UK
 * wall-clock time whatever the computer's own time zone; the API receives ISO 8601 instants with
 * the UK offset of that moment (BST or GMT). Pure functions, unit tested across the clock changes.
 * Every pattern is anchored at both ends and has no nested repetition.
 */

const UK = "Europe/London";

const partsFormatter = new Intl.DateTimeFormat("en-GB", {
  timeZone: UK,
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
  second: "2-digit",
  hourCycle: "h23",
});

interface WallClock {
  readonly year: number;
  readonly month: number;
  readonly day: number;
  readonly hour: number;
  readonly minute: number;
  readonly second: number;
}

function ukWallClock(instant: Date): WallClock {
  const parts = Object.fromEntries(
    partsFormatter.formatToParts(instant).map((part) => [part.type, part.value]),
  );
  return {
    year: Number(parts.year),
    month: Number(parts.month),
    day: Number(parts.day),
    hour: Number(parts.hour),
    minute: Number(parts.minute),
    second: Number(parts.second),
  };
}

/** Minutes the UK is ahead of UTC at an instant: 60 in summer (BST), 0 in winter (GMT). */
export function ukOffsetMinutes(instant: Date): number {
  const wall = ukWallClock(instant);
  const asUtc = Date.UTC(wall.year, wall.month - 1, wall.day, wall.hour, wall.minute, wall.second);
  return Math.round((asUtc - Math.floor(instant.getTime() / 1000) * 1000) / 60_000);
}

const pad = (value: number, length = 2) => String(value).padStart(length, "0");

/** Today's date in the UK as yyyy-mm-dd, for date inputs and the fluid balance day. */
export function ukToday(now: Date = new Date()): string {
  const wall = ukWallClock(now);
  return `${pad(wall.year, 4)}-${pad(wall.month)}-${pad(wall.day)}`;
}

/** An instant as the value of a `datetime-local` input in UK time: "2026-10-11T14:05". */
export function ukDateTimeInput(instant: Date | string = new Date()): string {
  const date = typeof instant === "string" ? new Date(instant) : instant;
  if (Number.isNaN(date.getTime())) return "";
  const wall = ukWallClock(date);
  return `${pad(wall.year, 4)}-${pad(wall.month)}-${pad(wall.day)}T${pad(wall.hour)}:${pad(wall.minute)}`;
}

const LOCAL_DATE_TIME = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})$/;
const ISO_DATE = /^(\d{4})-(\d{2})-(\d{2})$/;

/**
 * A UK wall-clock time from a `datetime-local` input ("2026-10-11T14:05") as an ISO instant with
 * its UK offset ("2026-10-11T14:05:00+01:00"), or null when it is not a real date and time. In
 * the hour that happens twice in October the earlier (BST) one is used; a time in the hour that
 * is skipped in March is read as the same wall time an hour later, as clocks show.
 */
export function ukLocalToIso(value: string): string | null {
  const match = LOCAL_DATE_TIME.exec(value);
  if (!match) return null;
  const [year, month, day, hour, minute] = match.slice(1).map(Number) as [
    number,
    number,
    number,
    number,
    number,
  ];
  if (hour > 23 || minute > 59) return null;
  const wall = Date.UTC(year, month - 1, day, hour, minute);
  const check = new Date(wall);
  if (check.getUTCMonth() !== month - 1 || check.getUTCDate() !== day) return null;
  // Try the summer offset first so the repeated October hour reads as BST, then winter.
  for (const offset of [60, 0]) {
    const instant = new Date(wall - offset * 60_000);
    if (ukOffsetMinutes(instant) === offset) return isoWithOffset(instant, offset);
  }
  // A skipped wall time (late March, 01:00 to 01:59): clocks read it an hour later in BST.
  const instant = new Date(wall);
  return isoWithOffset(instant, ukOffsetMinutes(instant));
}

function isoWithOffset(instant: Date, offsetMinutes: number): string {
  const wall = ukWallClock(instant);
  const sign = offsetMinutes < 0 ? "-" : "+";
  const abs = Math.abs(offsetMinutes);
  return `${pad(wall.year, 4)}-${pad(wall.month)}-${pad(wall.day)}T${pad(wall.hour)}:${pad(
    wall.minute,
  )}:00${sign}${pad(Math.floor(abs / 60))}:${pad(abs % 60)}`;
}

/** Whether a value is a real calendar date written yyyy-mm-dd. */
export function isIsoDate(value: string): boolean {
  const match = ISO_DATE.exec(value);
  if (!match) return false;
  const [year, month, day] = match.slice(1).map(Number) as [number, number, number];
  const date = new Date(Date.UTC(year, month - 1, day));
  return date.getUTCMonth() === month - 1 && date.getUTCDate() === day;
}

/** A calendar date moved by whole days ("2026-10-25" plus 1 is "2026-10-26"), never through time zones. */
export function addDays(isoDate: string, days: number): string {
  const match = ISO_DATE.exec(isoDate);
  if (!match) return isoDate;
  const [year, month, day] = match.slice(1).map(Number) as [number, number, number];
  const date = new Date(Date.UTC(year, month - 1, day + days));
  return `${pad(date.getUTCFullYear(), 4)}-${pad(date.getUTCMonth() + 1)}-${pad(date.getUTCDate())}`;
}

const timeFormatter = new Intl.DateTimeFormat("en-GB", {
  timeZone: UK,
  hour: "2-digit",
  minute: "2-digit",
  hourCycle: "h23",
});

/** An instant as "14:05" in UK time. */
export function formatUkTime(iso: string | null | undefined): string | null {
  if (!iso) return null;
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? null : timeFormatter.format(date);
}
