import {
  DEFAULT_CLOCK_DRIFT_TOLERANCE_MINUTES,
  resolveRecordedUkTime,
  ukZoneAbbreviation,
} from "@harbour/domain";
import type { Translator } from "@harbour/i18n";
import {
  checkDateParts,
  checkWallClockParts,
  type DatePart,
  type DateTimeLabels,
  type DateTimePart,
  datePartName,
  type RepeatedTime,
  UK_TIME_ZONE,
  type WallClock,
  wallClockAt,
} from "@harbour/ui";

/**
 * UK local time for forms (CONTENT.md rule 6, hazard HZ-009). People enter and read times as UK
 * wall-clock time whatever the computer's own time zone, in separate day, month, year, hour and
 * minute boxes (so the browser's language never turns 11/10 into 10/11); the API receives ISO 8601
 * instants. Which instant a typed time means is the domain's one rule for web and mobile,
 * `resolveRecordedUkTime` (packages/domain/src/shared/time.ts), tested here over every minute of
 * the clock changes with the device in three time zones.
 *
 * - An entry's time is "now" until someone changes it: the instant is taken when the form is sent,
 *   not when the page was drawn, so a form left open does not record an earlier time.
 * - In the hour the clocks go back (it happens twice), once both have passed, the form asks which
 *   one was meant ("BST, before the clocks went back" or "GMT, after"), with nothing chosen.
 * - A time in the hour the clocks go forward (it never happens) is refused, saying so.
 * - A time later than now (beyond the clock tolerance) is refused, never moved to another day.
 *
 * Patterns are anchored at both ends and have no nested repetition.
 */

const pad = (value: number, length = 2) => String(value).padStart(length, "0");

/** Today's date in the UK as yyyy-mm-dd, for date inputs and the fluid balance day. */
export function ukToday(now: Date = new Date()): string {
  const wall = wallClockAt(now.getTime(), UK_TIME_ZONE);
  return `${pad(wall.year, 4)}-${pad(wall.month)}-${pad(wall.day)}`;
}

const ISO_DATE = /^(\d{4})-(\d{2})-(\d{2})$/;
const ISO_INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d{1,3})?)?(Z|[+-]\d{2}:\d{2})$/;

/** Whether a value is a real calendar date written yyyy-mm-dd. */
export function isIsoDate(value: string): boolean {
  const match = ISO_DATE.exec(value);
  if (!match) return false;
  const [year, month, day] = match.slice(1).map(Number) as [number, number, number];
  const date = new Date(Date.UTC(year, month - 1, day));
  return date.getUTCMonth() === month - 1 && date.getUTCDate() === day;
}

/** Whether a value is an ISO 8601 instant with a zone ("2026-10-11T13:05:00.000Z"). */
export function isIsoInstant(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length <= 32 &&
    ISO_INSTANT.test(value) &&
    !Number.isNaN(Date.parse(value))
  );
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
  timeZone: UK_TIME_ZONE,
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

// ------------------------------------------------------------------------------------------------
// Reading dates and times from forms
// ------------------------------------------------------------------------------------------------

/** FormData, or anything with its `get`. */
export interface FormLike {
  get(name: string): FormDataEntryValue | null;
}

const text = (form: FormLike, name: string) => {
  const value = form.get(name);
  return typeof value === "string" ? value : "";
};

export type FieldPart = DateTimePart | "fold" | "mode";

export const isDatePart = (part: string): part is DatePart =>
  part === "day" || part === "month" || part === "year";

const BOXES: readonly string[] = ["day", "month", "year", "hour", "minute", "fold"];

/** The boxes of a date and time field an error is about, for DateTimeInput's errorParts. */
export function boxesOf(
  parts: readonly string[] | undefined,
): (DateTimePart | "fold")[] | undefined {
  const boxes = parts?.filter((part): part is DateTimePart | "fold" => BOXES.includes(part));
  return boxes && boxes.length > 0 ? boxes : undefined;
}

/** The boxes of a date field an error is about, for DateInput's errorParts. */
export function dateBoxesOf(parts: readonly string[] | undefined): DatePart[] | undefined {
  const boxes = parts?.filter(isDatePart);
  return boxes && boxes.length > 0 ? boxes : undefined;
}

/** A date or time that could not be used: what to say and which boxes it is about. */
export interface TimeProblem {
  readonly ok: false;
  readonly message: string;
  readonly parts: readonly FieldPart[];
}

/** Which of the boxes are empty, as one select key: "day", "day_month", "month_year". */
const partsKey = (parts: readonly string[]) => parts.join("_");

function dateMessage(
  problem: "empty" | "incomplete" | "not_real",
  parts: readonly DatePart[],
  subject: string,
  t: Translator,
): string {
  switch (problem) {
    case "empty":
      return t("care.date.empty", { subject });
    case "incomplete":
      return t("care.date.incomplete", { subject, parts: partsKey(parts) });
    case "not_real":
      return t("care.date.notReal", { subject });
  }
}

/** The day, month and year boxes of a date field as yyyy-mm-dd; null when optional and empty. */
export function readDateField(
  form: FormLike,
  name: string,
  options: { readonly subject: string; readonly optional?: boolean; readonly t: Translator },
): { readonly ok: true; readonly date: string | null } | TimeProblem {
  const check = checkDateParts({
    day: text(form, datePartName(name, "day")),
    month: text(form, datePartName(name, "month")),
    year: text(form, datePartName(name, "year")),
  });
  if (check.ok) return { ok: true, date: check.date };
  if (check.problem === "empty" && options.optional) return { ok: true, date: null };
  return {
    ok: false,
    message: dateMessage(check.problem, check.parts, options.subject, options.t),
    parts: check.parts,
  };
}

/** The five boxes of a date and time field as an instant; null when optional and all empty. */
/**
 * How far ahead of this device's clock a typed time may be and still count as now: the clock-drift
 * tolerance (`sync.clock_drift_flag_minutes`). The API does not serve the rate table to the web
 * yet (an API gap in docs/specs/care.md section 10), so this is the domain's default; the API
 * applies the tenant's own figure again when the entry arrives.
 */
export const FUTURE_TOLERANCE_MINUTES = DEFAULT_CLOCK_DRIFT_TOLERANCE_MINUTES;

/**
 * DateTimeInput's `repeated` rule: whether a typed UK time happened twice and both times have
 * passed, so the person must choose which, with each one's zone ("BST" then "GMT").
 */
export function ukRepeatedTime(wall: WallClock, now: Date = new Date()): RepeatedTime | null {
  try {
    const resolved = resolveRecordedUkTime(wall, {
      now,
      futureToleranceMinutes: FUTURE_TOLERANCE_MINUTES,
    });
    return resolved.kind === "ambiguous"
      ? { first: ukZoneAbbreviation(resolved.earlier), second: ukZoneAbbreviation(resolved.later) }
      : null;
  } catch {
    // Not a real date (31/02): the form says so when it is sent.
    return null;
  }
}

export function readDateTimeField(
  form: FormLike,
  name: string,
  options: {
    readonly subject: string;
    readonly optional?: boolean;
    readonly t: Translator;
    /** This device's clock; a time later than this (beyond the tolerance) is refused. */
    readonly now?: Date;
  },
): { readonly ok: true; readonly instant: string | null } | TimeProblem {
  const values = {
    day: text(form, datePartName(name, "day")),
    month: text(form, datePartName(name, "month")),
    year: text(form, datePartName(name, "year")),
    hour: text(form, datePartName(name, "hour")),
    minute: text(form, datePartName(name, "minute")),
  };
  if (options.optional && Object.values(values).every((value) => value.trim() === "")) {
    return { ok: true, instant: null };
  }
  const fold = text(form, datePartName(name, "fold"));
  const { t, subject } = options;
  const check = checkWallClockParts(values);
  if (check.ok) {
    const { wall } = check;
    const time = `${pad(wall.hour)}:${pad(wall.minute)}`;
    const date = `${pad(wall.day)}/${pad(wall.month)}/${wall.year}`;
    const resolved = resolveRecordedUkTime(wall, {
      now: options.now ?? new Date(),
      futureToleranceMinutes: FUTURE_TOLERANCE_MINUTES,
    });
    switch (resolved.kind) {
      case "exact":
        return { ok: true, instant: resolved.instant.toISOString() };
      case "ambiguous":
        if (fold === "first") return { ok: true, instant: resolved.earlier.toISOString() };
        if (fold === "second") return { ok: true, instant: resolved.later.toISOString() };
        return { ok: false, message: t("care.time.whichTime", { time, date }), parts: ["fold"] };
      case "skipped":
        return {
          ok: false,
          message: t("care.time.clocksWentForward", { time, date }),
          parts: ["hour", "minute"],
        };
      case "future":
        return {
          ok: false,
          message: t("care.time.future", { subject }),
          parts: ["day", "month", "year", "hour", "minute"],
        };
    }
  }
  switch (check.problem) {
    case "empty":
    case "incomplete":
    case "not_real":
      return {
        ok: false,
        message: dateMessage(check.problem, check.parts as DatePart[], subject, t),
        parts: check.parts,
      };
    case "time_incomplete":
      return {
        ok: false,
        message: t("care.time.incomplete", { subject, parts: partsKey(check.parts) }),
        parts: check.parts,
      };
    case "time_not_real":
      return { ok: false, message: t("care.time.notReal", { subject }), parts: check.parts };
  }
}

/**
 * When an entry happened (WhenField). "Now" is the instant the form is sent, from this device's
 * clock; the server action also sends that clock reading to the API, which flags an entry whose
 * device clock differs from the server's (HZ-010). "Earlier" reads the date and time boxes.
 */
export function readWhen(
  form: FormLike,
  name: string,
  t: Translator,
  options: { readonly now?: Date; readonly subject?: string } = {},
): { readonly ok: true; readonly instant: string } | TimeProblem {
  const now = options.now ?? new Date();
  if (text(form, `${name}-mode`) !== "earlier") return { ok: true, instant: now.toISOString() };
  const subject = options.subject ?? t("care.when.subject");
  const read = readDateTimeField(form, name, { subject, t, now });
  if (!read.ok) return read;
  return { ok: true, instant: read.instant ?? now.toISOString() };
}

/** The words of the date and time boxes, and of the question asked in the repeated hour. */
export function dateTimeLabels(t: Translator): DateTimeLabels {
  return {
    day: t("care.date.day"),
    month: t("care.date.month"),
    year: t("care.date.year"),
    hour: t("care.time.hour"),
    minute: t("care.time.minute"),
    foldLegend: ({ time, date }) => t("care.time.foldLegend", { time, date }),
    foldOption: ({ time, zone, which }) => t("care.time.foldOption", { time, zone, which }),
  };
}
