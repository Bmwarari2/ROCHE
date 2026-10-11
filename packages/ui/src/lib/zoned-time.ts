/**
 * The boxes of the date and time inputs: reading what people type into them, and filling them
 * from an instant in a named time zone (Europe/London unless said otherwise). The fill uses Intl
 * with the zone's own rules, never the device's zone, so a laptop set to New York or UTC shows UK
 * times the same way.
 *
 * Which instant a typed time means, and whether it happened twice or not at all when the clocks
 * changed, is a domain rule (`resolveRecordedUkTime` in @harbour/domain, the same on web and
 * mobile). The design system does not decide it: DateTimeInput asks the app through its
 * `repeated` prop whether to ask which of two times was meant.
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

const partsFormatters = new Map<string, Intl.DateTimeFormat>();

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

export type WallClockProblem =
  | DateProblem
  /** The time is missing or partly missing. */
  | "time_incomplete"
  /** The hour is not 0 to 23 or the minute not 0 to 59. */
  | "time_not_real";

export type WallClockCheck =
  | { readonly ok: true; readonly wall: WallClock }
  | {
      readonly ok: false;
      readonly problem: WallClockProblem;
      readonly parts: readonly DateTimePart[];
    };

/**
 * Checks a date and a 24-hour time typed in separate boxes, as a wall-clock time. It does not say
 * which instant that is: the app resolves it with its own rule for clock changes.
 */
export function checkWallClockParts(
  values: Readonly<Partial<Record<DateTimePart, string>>>,
): WallClockCheck {
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
  return { ok: true, wall: { ...date.wall, hour, minute } };
}

/** Which of a repeated time was meant: the first (summer time, before the clocks went back). */
export type Fold = "first" | "second";

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
