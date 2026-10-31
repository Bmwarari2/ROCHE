import {
  DAYS_PER_WEEK,
  MINUTES_PER_HOUR,
  minutesBetween,
  mondayOnOrBefore,
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
 * The AWR weeks from an agency worker's booked shifts with one hirer: each calendar week (Monday
 * to Sunday, UK) with a shift is `worked`; each week between two worked weeks with none is a break
 * with no recorded reason (Harbour does not yet record why; H-924), so the clock reads it as
 * uncovered. Weeks after the last worked week up to `throughWeek` are breaks too, so a long gap
 * since the last booking shows the clock as it will stand.
 */
export function awrWeeksFromShifts(shiftStarts: readonly Date[], throughDate: string): AwrWeek[] {
  if (shiftStarts.length === 0) return [];
  const worked = new Set(shiftStarts.map((s) => mondayOnOrBefore(ukDateOf(s))));
  const sorted = [...worked].sort();
  const first = sorted[0] as string;
  const last =
    mondayOnOrBefore(throughDate) > (sorted.at(-1) as string)
      ? mondayOnOrBefore(throughDate)
      : (sorted.at(-1) as string);
  const weeks: AwrWeek[] = [];
  for (let w = first; w <= last; w = plusDays(w, DAYS_PER_WEEK)) {
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
