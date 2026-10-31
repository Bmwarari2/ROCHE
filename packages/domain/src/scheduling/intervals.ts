/**
 * Time helpers for the working time rules. Internal to the scheduling module (not exported from
 * the package index). Hours worked are measured in elapsed time, so a night shift from 20:00 to
 * 08:00 is 13 hours on the night the clocks go back and 11 on the night they go forward; days,
 * weeks, night time and the restricted period are UK local time (Europe/London), so each starts
 * at the wall-clock time the regulations name whatever the offset.
 */

import { fromUkWallClock, ukEndOfDay, ukStartOfDay } from "../shared/time";
import { ukIsoDate } from "../shared/working-days";

export interface Span {
  readonly start: Date;
  readonly end: Date;
}

// why: calendar units, not statutory figures (the figures come from the rate table).
const MS_PER_MINUTE = 60 * 1000;
export const MINUTES_PER_HOUR = 60;
export const HOURS_PER_DAY = 24;
export const DAYS_PER_WEEK = 7;
export const MINUTES_PER_DAY = MINUTES_PER_HOUR * HOURS_PER_DAY;
export const MONTHS_PER_YEAR = 12;

export function minutesBetween(start: Date, end: Date): number {
  return (end.getTime() - start.getTime()) / MS_PER_MINUTE;
}

export function plusMinutes(instant: Date, minutes: number): Date {
  return new Date(instant.getTime() + minutes * MS_PER_MINUTE);
}

export function spanMinutes(span: Span): number {
  return minutesBetween(span.start, span.end);
}

/** The part of a span inside a window, or null when they do not overlap. */
export function clip(span: Span, window: Span): Span | null {
  const start = span.start > window.start ? span.start : window.start;
  const end = span.end < window.end ? span.end : window.end;
  return start < end ? { start, end } : null;
}

export function overlapMinutes(spans: readonly Span[], window: Span): number {
  let total = 0;
  for (const span of spans) {
    const part = clip(span, window);
    if (part) total += spanMinutes(part);
  }
  return total;
}

/** Sorts spans and joins those that overlap or touch. */
export function mergeSpans(spans: readonly Span[]): Span[] {
  const sorted = [...spans].sort((a, b) => a.start.getTime() - b.start.getTime());
  const merged: Span[] = [];
  for (const span of sorted) {
    const last = merged[merged.length - 1];
    if (last && span.start <= last.end) {
      if (span.end > last.end) merged[merged.length - 1] = { start: last.start, end: span.end };
    } else {
      merged.push(span);
    }
  }
  return merged;
}

/** A span with the given (merged) holes taken out. */
export function subtractSpans(span: Span, holes: readonly Span[]): Span[] {
  const parts: Span[] = [];
  let cursor = span.start;
  for (const hole of mergeSpans(holes)) {
    const part = clip(hole, span);
    if (!part) continue;
    if (part.start > cursor) parts.push({ start: cursor, end: part.start });
    if (part.end > cursor) cursor = part.end;
  }
  if (cursor < span.end) parts.push({ start: cursor, end: span.end });
  return parts;
}

/** The longest stretch of a window not covered by the (merged) busy spans, in minutes. */
export function longestFreeMinutes(busy: readonly Span[], window: Span): number {
  return subtractSpans(window, busy).reduce((max, s) => Math.max(max, spanMinutes(s)), 0);
}

export function ukDateOf(instant: Date): string {
  return ukIsoDate(instant);
}

/** The yyyy-mm-dd part of a UTC midnight instant. */
export function isoDateOf(utcMidnight: Date): string {
  return utcMidnight.toISOString().split("T")[0] as string;
}

export function plusDays(isoDate: string, days: number): string {
  const date = new Date(`${isoDate}T00:00:00Z`);
  date.setUTCDate(date.getUTCDate() + days);
  return isoDateOf(date);
}

/** Whole calendar days from one ISO date to another (negative when `to` is earlier). */
export function daysFrom(from: string, to: string): number {
  return Math.round(
    (Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) /
      (MINUTES_PER_DAY * MS_PER_MINUTE),
  );
}

/** Every ISO date from `from` to `to`, both included. */
export function datesFrom(from: string, to: string): string[] {
  const dates: string[] = [];
  for (let d = from; d <= to; d = plusDays(d, 1)) dates.push(d);
  return dates;
}

/** The UK day an ISO date names, from 00:00 to the next 00:00 (23 or 25 hours on clock changes). */
export function ukDay(isoDate: string): Span {
  return { start: ukStartOfDay(isoDate), end: ukEndOfDay(isoDate) };
}

/** UK days from the start of `from` to the end of `to`. */
export function ukDays(from: string, to: string): Span {
  return { start: ukStartOfDay(from), end: ukEndOfDay(to) };
}

/** The Monday on or before an ISO date (a week starts at midnight between Sunday and Monday). */
export function mondayOnOrBefore(isoDate: string): string {
  const weekday = new Date(`${isoDate}T00:00:00Z`).getUTCDay();
  return plusDays(isoDate, -((weekday + DAYS_PER_WEEK - 1) % DAYS_PER_WEEK));
}

function atMinuteOfDay(isoDate: string, minuteOfDay: number): Date {
  const [year, month, day] = isoDate.split("-").map(Number) as [number, number, number];
  return fromUkWallClock(
    year,
    month,
    day,
    Math.floor(minuteOfDay / MINUTES_PER_HOUR),
    minuteOfDay % MINUTES_PER_HOUR,
  );
}

/**
 * Each occurrence of a daily wall-clock window (night time, the restricted period) that could
 * overlap a range: from `startMinute` on a day to `endMinute` the same day, or the next day when
 * the window crosses midnight. Real lengths change on clock-change nights.
 */
export function dailyWindows(range: Span, startMinute: number, endMinute: number): Span[] {
  const windows: Span[] = [];
  const crossesMidnight = endMinute <= startMinute;
  const last = ukDateOf(range.end);
  for (let d = plusDays(ukDateOf(range.start), -1); d <= last; d = plusDays(d, 1)) {
    const start = atMinuteOfDay(d, startMinute);
    const end = atMinuteOfDay(crossesMidnight ? plusDays(d, 1) : d, endMinute);
    if (clip({ start, end }, range)) windows.push({ start, end });
  }
  return windows;
}

/**
 * The instant a person born on `dateOfBirth` reaches an age: 00:00 UK time on that birthday. A
 * person born on 29 February reaches it on 1 March in a year that is not a leap year, the later
 * of the two readings, so young worker protection never ends early.
 */
export function birthdayInstant(dateOfBirth: string, years: number): Date {
  const [year, month, day] = dateOfBirth.split("-").map(Number) as [number, number, number];
  const target = new Date(Date.UTC(year + years, month - 1, day));
  return ukStartOfDay(isoDateOf(target));
}
