/**
 * Wall-clock dates and times in a named time zone (Europe/London unless said otherwise), for the
 * date and time inputs. Everything is worked out with Intl from the zone's own rules, never from
 * the device's time zone, so a laptop set to New York or UTC reads UK times the same way.
 *
 * When the clocks go back, one wall-clock hour happens twice (01:00 to 01:59 BST, then again as
 * GMT); when they go forward, an hour never happens (01:00 to 01:59 on the last Sunday in March).
 * `resolveWallClock` says which: an exact instant, two instants to choose between, or none.
 */

export interface WallClock {
  readonly year: number;
  /** 1 to 12. */
  readonly month: number;
  readonly day: number;
  /** 0 to 23. */
  readonly hour: number;
  readonly minute: number;
}

export const UK_TIME_ZONE = "Europe/London";

const MS_PER_MINUTE = 60_000;
const MS_PER_DAY = 24 * 60 * MS_PER_MINUTE;

const partsFormatters = new Map<string, Intl.DateTimeFormat>();
const nameFormatters = new Map<string, Intl.DateTimeFormat>();

function partsFormatter(timeZone: string): Intl.DateTimeFormat {
  let formatter = partsFormatters.get(timeZone);
  if (!formatter) {
    formatter = new Intl.DateTimeFormat("en-GB", {
      timeZone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      hourCycle: "h23",
    });
    partsFormatters.set(timeZone, formatter);
  }
  return formatter;
}

/** The wall clock in a time zone at an instant (milliseconds since the epoch). */
export function wallClockAt(instant: number, timeZone: string = UK_TIME_ZONE): WallClock {
  const parts: Partial<Record<Intl.DateTimeFormatPartTypes, number>> = {};
  for (const part of partsFormatter(timeZone).formatToParts(new Date(instant))) {
    if (part.type !== "literal") parts[part.type] = Number(part.value);
  }
  return {
    year: parts.year ?? 0,
    month: parts.month ?? 0,
    day: parts.day ?? 0,
    // Some engines write midnight as 24 with h23; it is 0 of the same day.
    hour: (parts.hour ?? 0) % 24,
    minute: parts.minute ?? 0,
  };
}

/** The zone's offset from UTC, in minutes, at an instant (60 for BST, 0 for GMT). */
export function zoneOffsetMinutes(instant: number, timeZone: string = UK_TIME_ZONE): number {
  const wall = wallClockAt(instant, timeZone);
  const asUtc = Date.UTC(wall.year, wall.month - 1, wall.day, wall.hour, wall.minute);
  const wholeMinute = Math.floor(instant / MS_PER_MINUTE) * MS_PER_MINUTE;
  return Math.round((asUtc - wholeMinute) / MS_PER_MINUTE);
}

/** The zone's short name at an instant, for example "BST" or "GMT". */
export function zoneName(instant: number, timeZone: string = UK_TIME_ZONE): string {
  let formatter = nameFormatters.get(timeZone);
  if (!formatter) {
    formatter = new Intl.DateTimeFormat("en-GB", { timeZone, timeZoneName: "short" });
    nameFormatters.set(timeZone, formatter);
  }
  return (
    formatter.formatToParts(new Date(instant)).find((part) => part.type === "timeZoneName")
      ?.value ?? timeZone
  );
}

const sameWallClock = (a: WallClock, b: WallClock) =>
  a.year === b.year &&
  a.month === b.month &&
  a.day === b.day &&
  a.hour === b.hour &&
  a.minute === b.minute;

export interface ZonedInstant {
  /** ISO 8601 in UTC, for example "2026-10-25T00:30:00.000Z". */
  readonly instant: string;
  /** The zone's short name then, for example "BST". */
  readonly zoneName: string;
}

export type WallClockResolution =
  | ({ readonly kind: "exact" } & ZonedInstant)
  /** The clocks went back: the time happened twice, first in summer time, then again. */
  | { readonly kind: "repeated"; readonly first: ZonedInstant; readonly second: ZonedInstant }
  /** The clocks went forward: the time never happened. */
  | { readonly kind: "skipped" };

/**
 * The instant or instants a wall-clock time names in a zone. Checks every offset the zone uses on
 * the day before and the day after, and keeps those that read back as the same wall clock.
 */
export function resolveWallClock(
  wall: WallClock,
  timeZone: string = UK_TIME_ZONE,
): WallClockResolution {
  const asUtc = Date.UTC(wall.year, wall.month - 1, wall.day, wall.hour, wall.minute);
  const offsets = new Set([
    zoneOffsetMinutes(asUtc - MS_PER_DAY, timeZone),
    zoneOffsetMinutes(asUtc, timeZone),
    zoneOffsetMinutes(asUtc + MS_PER_DAY, timeZone),
  ]);
  const instants = [...offsets]
    .map((offset) => asUtc - offset * MS_PER_MINUTE)
    .filter((instant) => sameWallClock(wallClockAt(instant, timeZone), wall))
    .sort((a, b) => a - b);
  const zoned = (instant: number): ZonedInstant => ({
    instant: new Date(instant).toISOString(),
    zoneName: zoneName(instant, timeZone),
  });
  const [first, second] = instants;
  if (first === undefined) return { kind: "skipped" };
  if (second === undefined) return { kind: "exact", ...zoned(first) };
  return { kind: "repeated", first: zoned(first), second: zoned(second) };
}

// ------------------------------------------------------------------------------------------------
// Reading the parts people type
// ------------------------------------------------------------------------------------------------

export type DatePart = "day" | "month" | "year";
export type TimePart = "hour" | "minute";
export type DateTimePart = DatePart | TimePart;

export type DateProblem =
  /** Nothing entered. */
  | "empty"
  /** Some parts entered, others not (`parts` names the missing ones). */
  | "incomplete"
  /** A part is not a whole number of the right length, or not a real date (31/02). */
  | "not_real";

export type DateCheck =
  | { readonly ok: true; readonly date: string; readonly wall: Omit<WallClock, "hour" | "minute"> }
  | { readonly ok: false; readonly problem: DateProblem; readonly parts: readonly DatePart[] };

/** Digits only (no signs, spaces or decimal points), at most `max` of them. */
function digits(text: string, max: number): number | null {
  if (text.length === 0 || text.length > max) return null;
  for (const char of text) {
    if (char < "0" || char > "9") return null;
  }
  return Number(text);
}

const pad = (value: number, length = 2) => String(value).padStart(length, "0");

/** Checks a day, month and year typed in separate boxes (the GOV.UK date input pattern). */
export function checkDateParts(values: Readonly<Partial<Record<DatePart, string>>>): DateCheck {
  const text = {
    day: (values.day ?? "").trim(),
    month: (values.month ?? "").trim(),
    year: (values.year ?? "").trim(),
  };
  const order: readonly DatePart[] = ["day", "month", "year"];
  const missing = order.filter((part) => text[part] === "");
  if (missing.length === order.length) return { ok: false, problem: "empty", parts: order };
  if (missing.length > 0) return { ok: false, problem: "incomplete", parts: missing };
  const day = digits(text.day, 2);
  const month = digits(text.month, 2);
  const year = text.year.length === 4 ? digits(text.year, 4) : null;
  const wrong: DatePart[] = [];
  if (day === null || day < 1 || day > 31) wrong.push("day");
  if (month === null || month < 1 || month > 12) wrong.push("month");
  if (year === null || year < 1900) wrong.push("year");
  if (wrong.length > 0 || day === null || month === null || year === null) {
    return { ok: false, problem: "not_real", parts: wrong };
  }
  // 31/04 or 29/02 in a common year: the calendar moves it on, so it is not a real date.
  const check = new Date(Date.UTC(year, month - 1, day));
  if (check.getUTCMonth() !== month - 1) return { ok: false, problem: "not_real", parts: ["day"] };
  return {
    ok: true,
    date: `${pad(year, 4)}-${pad(month)}-${pad(day)}`,
    wall: { year, month, day },
  };
}

export type DateTimeProblem =
  | DateProblem
  /** The time is missing or partly missing. */
  | "time_incomplete"
  /** The hour is not 0 to 23 or the minute not 0 to 59. */
  | "time_not_real"
  /** The clocks went forward over this time, so it never happened. */
  | "clocks_went_forward"
  /** The clocks went back over this time and nobody said which of the two it was. */
  | "which_time";

/** Which of a repeated time was meant: the first (summer time) or the second. */
export type Fold = "first" | "second";

export type DateTimeCheck =
  | { readonly ok: true; readonly instant: string }
  | {
      readonly ok: false;
      readonly problem: DateTimeProblem;
      readonly parts: readonly (DateTimePart | "fold")[];
      /** The two instants, when the problem is which_time. */
      readonly repeated?: { readonly first: ZonedInstant; readonly second: ZonedInstant };
    };

/**
 * Checks a date and a 24-hour time typed in separate boxes, and turns it into one instant. In the
 * hour the clocks go back, `fold` says which of the two times was meant; without it the answer is
 * "which_time". In the hour they go forward the time is refused.
 */
export function checkDateTimeParts(
  values: Readonly<Partial<Record<DateTimePart, string>>>,
  options: { readonly timeZone?: string; readonly fold?: Fold | null } = {},
): DateTimeCheck {
  const date = checkDateParts(values);
  if (!date.ok) return date;
  const hourText = (values.hour ?? "").trim();
  const minuteText = (values.minute ?? "").trim();
  const missing: TimePart[] = [];
  if (hourText === "") missing.push("hour");
  if (minuteText === "") missing.push("minute");
  if (missing.length > 0) return { ok: false, problem: "time_incomplete", parts: missing };
  const hour = digits(hourText, 2);
  const minute = digits(minuteText, 2);
  const wrong: TimePart[] = [];
  if (hour === null || hour > 23) wrong.push("hour");
  if (minute === null || minute > 59) wrong.push("minute");
  if (wrong.length > 0 || hour === null || minute === null) {
    return { ok: false, problem: "time_not_real", parts: wrong };
  }
  const resolved = resolveWallClock({ ...date.wall, hour, minute }, options.timeZone);
  switch (resolved.kind) {
    case "exact":
      return { ok: true, instant: resolved.instant };
    case "skipped":
      return { ok: false, problem: "clocks_went_forward", parts: ["hour", "minute"] };
    case "repeated":
      if (options.fold === "first") return { ok: true, instant: resolved.first.instant };
      if (options.fold === "second") return { ok: true, instant: resolved.second.instant };
      return {
        ok: false,
        problem: "which_time",
        parts: ["fold"],
        repeated: { first: resolved.first, second: resolved.second },
      };
  }
}

/** The parts of an instant as the boxes show them ("05", "03", "2026", "14", "05"). */
export function dateTimePartsAt(
  instant: number,
  timeZone: string = UK_TIME_ZONE,
): Record<DateTimePart, string> {
  const wall = wallClockAt(instant, timeZone);
  return {
    day: pad(wall.day),
    month: pad(wall.month),
    year: pad(wall.year, 4),
    hour: pad(wall.hour),
    minute: pad(wall.minute),
  };
}

/** "yyyy-mm-dd" as the boxes show it, or empty boxes when it is not a date. */
export function datePartsOf(date: string | null | undefined): Record<DatePart, string> {
  const [year = "", month = "", day = ""] = (date ?? "").split("-");
  return year.length === 4 && month.length === 2 && day.length === 2
    ? { day, month, year }
    : { day: "", month: "", year: "" };
}

/** The form field names for each box: `${name}-day`, `${name}-hour`, `${name}-fold` and so on. */
export function datePartName(name: string, part: DateTimePart | "fold"): string {
  return `${name}-${part}`;
}
