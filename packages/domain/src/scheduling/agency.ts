import {
  DAYS_PER_WEEK,
  daysFrom,
  MINUTES_PER_HOUR,
  minutesBetween,
  plusDays,
  plusMinutes,
  ukDateOf,
} from "./intervals";
import type { AwrWeek } from "./pay/awr";

/**
 * Bank and agency workers (scheduling.md section 15; SCHED-009; ADR-0088): what a booking costs,
 * the calendar weeks the Agency Workers Regulations clock reads from bookings, and the access window
 * a booked shift opens. No figure here is a literal: the post-shift hours and the AWR figures come
 * from the rate table, the charge rate from the agency's terms.
 */

/**
 * What a booking costs in pence: the paid minutes (the shift less its planned break) at the
 * agency's charge per hour, rounded to the nearest penny (half up). Sleep-ins and on-call are
 * charged as the agency's terms say, so the caller gives the rate that applies.
 */
export function bookingCostPence(
  start: Date,
  end: Date,
  breakMinutes: number,
  pencePerHour: number,
): number {
  const paid = Math.max(0, minutesBetween(start, end) - breakMinutes);
  return Math.round((paid * pencePerHour) / MINUTES_PER_HOUR);
}

/**
 * The AWR weeks from an agency worker's shifts with one hirer that have started by `throughDate`
 * (never a future booking): AWR regulation 7(4) counts weeks of seven days from the first day of
 * the first assignment, so week 0 starts on the UK date of the first shift. A week with a shift is
 * `worked`; each week between two worked weeks with none is a break with no recorded reason
 * (Harbour does not yet record why; H-924), so the clock reads it as uncovered. Weeks after the
 * last worked week up to `throughDate` are breaks too, so a long gap shows the clock as it stands.
 */
export function awrWeeksFromShifts(shiftStarts: readonly Date[], throughDate: string): AwrWeek[] {
  const days = shiftStarts.map((s) => ukDateOf(s)).filter((d) => d <= throughDate);
  if (days.length === 0) return [];
  const anchor = [...days].sort()[0] as string;
  const weekOf = (date: string) =>
    plusDays(anchor, Math.floor(daysFrom(anchor, date) / DAYS_PER_WEEK) * DAYS_PER_WEEK);
  const worked = new Set(days.map(weekOf));
  const last = weekOf(throughDate);
  const weeks: AwrWeek[] = [];
  for (let w = anchor; w <= last; w = plusDays(w, DAYS_PER_WEEK)) {
    weeks.push(
      worked.has(w) ? { week: w, kind: "worked" } : { week: w, kind: "break", reason: "none" },
    );
  }
  return weeks;
}

export interface BookedWindow {
  readonly start: Date;
  readonly end: Date;
}

/**
 * The access window a bank or agency worker has at `now` (ADR-0088): from the start of a booked
 * shift to its end plus the rate table's post-shift hours. No booked shift open now, no access.
 * Of several (back-to-back shifts), the one that lasts longest.
 */
export function agencyAccessWindow(
  bookings: readonly BookedWindow[],
  now: Date,
  postShiftHours: number,
): BookedWindow | null {
  let best: BookedWindow | null = null;
  for (const b of bookings) {
    const until = plusMinutes(b.end, postShiftHours * MINUTES_PER_HOUR);
    if (b.start <= now && now < until && (best === null || until > best.end)) {
      best = { start: b.start, end: until };
    }
  }
  return best;
}
