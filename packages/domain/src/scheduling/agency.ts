import {
  DAYS_PER_WEEK,
  daysFrom,
  MINUTES_PER_HOUR,
  minutesBetween,
  plusDays,
  plusMinutes,
  ukDateOf,
} from "./intervals";
import type { AwrBreakReason, AwrWeek } from "./pay/awr";

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

/** A recorded reason for days without a booking (H-924), inclusive UK dates. */
export interface AwrBreakRecord {
  readonly from: string;
  readonly to: string;
  readonly reason: Exclude<AwrBreakReason, "none">;
}

/** The order a week's reason is chosen in when records of several kinds cover it equally. */
const REASON_ORDER: readonly Exclude<AwrBreakReason, "none">[] = [
  "protected_leave",
  "sickness",
  "jury_service",
  "annual_leave",
  "shutdown",
  "industrial_action",
];

/**
 * The AWR weeks from an agency worker's shifts with one hirer that have started by `throughDate`
 * (never a future booking): AWR regulation 7(4) counts weeks of seven days from the first day of
 * the first assignment, so week 0 starts on the UK date of the first shift. A week with a shift is
 * `worked`. A week without one is a break; its reason comes from the recorded reasons when they
 * cover every day of it (the reason covering most days, ties in a fixed order), otherwise it has
 * none and is uncovered. Pregnancy, childbirth and maternity breaks count as worked (reg 7(6), the
 * H-924 recommended answer). A role change marks the first worked week on or after the day the
 * worker was told in writing as a new role (reg 7(3)), which restarts the clock. Weeks after the
 * last worked week up to `throughDate` are breaks too, so a long gap shows the clock as it stands.
 */
export function awrWeeksFromShifts(
  shiftStarts: readonly Date[],
  throughDate: string,
  breaks: readonly AwrBreakRecord[] = [],
  roleChangesNotifiedOn: readonly string[] = [],
): AwrWeek[] {
  const days = shiftStarts.map((s) => ukDateOf(s)).filter((d) => d <= throughDate);
  if (days.length === 0) return [];
  const anchor = [...days].sort()[0] as string;
  const weekOf = (date: string) =>
    plusDays(anchor, Math.floor(daysFrom(anchor, date) / DAYS_PER_WEEK) * DAYS_PER_WEEK);
  const worked = new Set(days.map(weekOf));
  const changes = [...roleChangesNotifiedOn].filter((d) => d <= throughDate).sort();
  const last = weekOf(throughDate);
  const weeks: AwrWeek[] = [];
  const marked = new Set<string>();
  for (let w = anchor; w <= last; w = plusDays(w, DAYS_PER_WEEK)) {
    if (worked.has(w)) {
      const weekEnd = plusDays(w, DAYS_PER_WEEK - 1);
      const change = changes.find((d) => !marked.has(d) && d <= weekEnd);
      if (change && w > anchor) {
        marked.add(change);
        weeks.push({ week: w, kind: "worked", newRole: true });
      } else {
        if (change) marked.add(change);
        weeks.push({ week: w, kind: "worked" });
      }
      continue;
    }
    const reason = weekReason(w, breaks);
    weeks.push(
      reason === "protected_leave"
        ? { week: w, kind: "break", reason, deemedWorking: true }
        : { week: w, kind: "break", reason },
    );
  }
  return weeks;
}

function weekReason(week: string, breaks: readonly AwrBreakRecord[]): AwrBreakReason {
  const counts = new Map<Exclude<AwrBreakReason, "none">, number>();
  for (let i = 0; i < DAYS_PER_WEEK; i++) {
    const day = plusDays(week, i);
    const record = breaks.find((b) => b.from <= day && day <= b.to);
    if (!record) return "none";
    counts.set(record.reason, (counts.get(record.reason) ?? 0) + 1);
  }
  let best: Exclude<AwrBreakReason, "none"> = "annual_leave";
  let most = -1;
  for (const r of REASON_ORDER) {
    const n = counts.get(r) ?? 0;
    if (n > most) {
      best = r;
      most = n;
    }
  }
  return best;
}

/**
 * An entry a bank or agency worker recorded offline, uploaded now (H-921 recommended answer):
 * accepted when its device time falls in a confirmed booking's window (the shift's start to its
 * end plus the post-shift hours); after that window has closed, still accepted, flagged late, for
 * the upload grace period, and refused after it. An entry timed outside every booking is refused.
 * The grace period never opens anything to read.
 */
export type AgencyUploadDecision =
  | { readonly accept: true; readonly late: boolean }
  | { readonly accept: false; readonly reason: "outside_booking" | "upload_grace_ended" };

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

export function agencyUploadDecision(
  bookings: readonly BookedWindow[],
  recordedAt: Date,
  now: Date,
  postShiftHours: number,
  graceHours: number,
): AgencyUploadDecision {
  const windows = bookings
    .map((b) => ({ start: b.start, end: plusMinutes(b.end, postShiftHours * MINUTES_PER_HOUR) }))
    .filter((w) => recordedAt >= w.start && recordedAt < w.end)
    .sort((a, b) => b.end.getTime() - a.end.getTime());
  const window = windows[0];
  if (!window) return { accept: false, reason: "outside_booking" };
  if (now < window.end) return { accept: true, late: false };
  if (now < plusMinutes(window.end, graceHours * MINUTES_PER_HOUR)) {
    return { accept: true, late: true };
  }
  return { accept: false, reason: "upload_grace_ended" };
}
