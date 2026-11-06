import { MINUTES_PER_HOUR, minutesBetween, plusMinutes, type Span } from "./intervals";
import type { ShiftKind } from "./rota";
import type { OptOutAgreement, TravelKind, WorkPeriod, WorkPeriodKind } from "./working-time-types";

/**
 * Time and attendance (scheduling.md section 16; SCHED-004, SCHED-003; hazards HZ-010, HZ-124):
 * clock events with the device's and the server's time, a draft timesheet from a shift's events,
 * approval never by the worker, corrections that supersede, and the approved entries as the
 * working time check's periods. No figure here is a literal: the drift tolerance comes from the
 * rate table.
 */

export const CLOCK_KINDS = ["in", "out", "break_start", "break_end"] as const;
export type ClockKind = (typeof CLOCK_KINDS)[number];

export const CLOCK_EVIDENCE = ["none", "at_location", "nfc"] as const;
export type ClockEvidence = (typeof CLOCK_EVIDENCE)[number];

export const CLOCK_FLAGS = [
  "late_upload",
  "device_clock_ahead",
  "outside_access_window",
  "no_shift",
  "not_eligible",
  "no_induction",
  "no_booking",
  "not_on_shift",
  "other_location",
  "no_permission",
  "evidence_not_matched",
] as const;
export type ClockFlag = (typeof CLOCK_FLAGS)[number];

/**
 * Rule 1 (HZ-010): a device time more than the tolerance before the server's is a late upload
 * (recorded offline); more than the tolerance after it, the device's clock is ahead. Both are
 * flagged and kept; the device's time stays the time worked.
 */
export function clockFlags(
  deviceTime: Date,
  recordedAt: Date,
  toleranceMinutes: number,
): ClockFlag[] {
  const ahead = minutesBetween(recordedAt, deviceTime);
  if (ahead > toleranceMinutes) return ["device_clock_ahead"];
  if (-ahead > toleranceMinutes) return ["late_upload"];
  return [];
}

export interface ClockEventFact {
  readonly id: string;
  readonly kind: ClockKind;
  readonly at: Date;
}

export type PairingProblem =
  | "no_clock_in"
  | "no_clock_out"
  | "break_not_ended"
  | "break_not_started"
  | "out_of_order";

export const PAIRING_MESSAGES: Readonly<Record<PairingProblem, string>> = {
  no_clock_in: "There is no clock-in for this clock-out.",
  no_clock_out: "There is no clock-out yet.",
  break_not_ended: "A break was started and never ended.",
  break_not_started: "A break was ended that was never started.",
  out_of_order: "The times are out of order: a clock-out before the clock-in.",
};

export interface PairedTime {
  readonly start: Date | null;
  readonly end: Date | null;
  readonly breaks: readonly Span[];
  readonly clockInId: string | null;
  readonly clockOutId: string | null;
  readonly problems: readonly PairingProblem[];
}

/**
 * Rule 4: one stretch of work from its events, in time order: the first clock-in, the last
 * clock-out, and each break start paired with the next break end. Problems are listed; nothing
 * is guessed (a missing clock-out is never filled in).
 */
export function pairClockEvents(events: readonly ClockEventFact[]): PairedTime {
  const sorted = [...events].sort((a, b) => a.at.getTime() - b.at.getTime());
  const problems = new Set<PairingProblem>();
  const clockIn = sorted.find((e) => e.kind === "in") ?? null;
  const clockOut = [...sorted].reverse().find((e) => e.kind === "out") ?? null;
  if (!clockIn) problems.add("no_clock_in");
  if (!clockOut) problems.add("no_clock_out");
  if (clockIn && clockOut && clockOut.at <= clockIn.at) problems.add("out_of_order");
  const breaks: Span[] = [];
  let open: Date | null = null;
  for (const e of sorted) {
    if (e.kind === "break_start") {
      if (open) problems.add("break_not_ended");
      open = e.at;
    } else if (e.kind === "break_end") {
      if (!open) {
        problems.add("break_not_started");
        continue;
      }
      if (e.at > open) breaks.push({ start: open, end: e.at });
      open = null;
    }
  }
  if (open) problems.add("break_not_ended");
  return {
    start: clockIn?.at ?? null,
    end: clockOut?.at ?? null,
    breaks,
    clockInId: clockIn?.id ?? null,
    clockOutId: clockOut?.id ?? null,
    problems: [...problems],
  };
}

export const TIMESHEET_KINDS = [
  "work",
  "sleep_in",
  "on_call_at_workplace",
  "on_call_away",
  "training",
  "travel",
] as const satisfies readonly (ShiftKind | "travel")[];
export type TimesheetKind = (typeof TIMESHEET_KINDS)[number];

export interface TimesheetFact {
  readonly id: string;
  readonly workerId: string;
  readonly kind: TimesheetKind;
  readonly start: Date;
  readonly end: Date;
  readonly breaks: readonly Span[];
  readonly travel: TravelKind | null;
  readonly status: "draft" | "approved";
  readonly supersedesId: string | null;
}

export type ApprovalProblem =
  | "own_entry"
  | "entered_by_approver"
  | "not_draft"
  | "superseded"
  | "times_out_of_order"
  | "ends_in_future";

export const APPROVAL_MESSAGES: Readonly<Record<ApprovalProblem, string>> = {
  own_entry: "Someone else must approve your own timesheet.",
  entered_by_approver:
    "Someone other than whoever entered or last changed this entry must approve it.",
  not_draft: "Only a draft can be approved; correct an approved entry instead.",
  superseded: "This entry has been corrected; approve the correction instead.",
  times_out_of_order: "The entry ends before it starts.",
  ends_in_future: "The entry has not ended yet; approve it once it has.",
};

/** Who entered or last changed an entry, and when approval is asked (rule 5). */
export interface ApprovalContext {
  readonly now: Date;
  /** Whoever entered it by hand or as a correction; null for an entry made from the clock. */
  readonly enteredBy: string | null;
  /** Whoever last changed it after it was made, if anyone. */
  readonly changedBy: string | null;
}

/** Rule 5: whether an approver may approve an entry. */
export function approvalProblem(
  entry: TimesheetFact,
  approverId: string,
  supersededIds: ReadonlySet<string>,
  context: ApprovalContext,
): ApprovalProblem | null {
  if (entry.workerId === approverId) return "own_entry";
  if (context.enteredBy === approverId || context.changedBy === approverId) {
    return "entered_by_approver";
  }
  if (entry.status !== "draft") return "not_draft";
  if (supersededIds.has(entry.id)) return "superseded";
  if (entry.end <= entry.start) return "times_out_of_order";
  if (entry.end > context.now) return "ends_in_future";
  return null;
}

/**
 * Rule 3 (HZ-124): a clock-in the rule on the day blocks is refused while the server can still
 * act, that is before the shift has ended, whatever time the device gives (a device time set back
 * cannot turn a refusal into a flag). Once the shift has ended the time was worked: it is kept,
 * flagged and raised as an urgent task.
 */
export function clockInRefused(blocked: boolean, now: Date, shiftEnd: Date | null): boolean {
  if (!blocked) return false;
  return shiftEnd === null || now < shiftEnd;
}

/**
 * Rule 6: the entries that count, of approved ones: an approved correction replaces the entry it
 * supersedes, which is shown struck through. Drafts count for nothing yet.
 */
export function currentApproved(entries: readonly TimesheetFact[]): {
  readonly current: readonly TimesheetFact[];
  readonly superseded: ReadonlySet<string>;
} {
  const superseded = new Set(
    entries
      .filter((e) => e.status === "approved" && e.supersedesId !== null)
      .map((e) => e.supersedesId as string),
  );
  return {
    current: entries.filter((e) => e.status === "approved" && !superseded.has(e.id)),
    superseded,
  };
}

/** Rule 7: approved, current entries as the working time check's periods, actual breaks included. */
export function timesheetWorkPeriods(entries: readonly TimesheetFact[]): WorkPeriod[] {
  return currentApproved(entries).current.map((e) => ({
    id: e.id,
    kind: e.kind as WorkPeriodKind,
    start: e.start,
    end: e.end,
    ...(e.breaks.length > 0 ? { breaks: e.breaks } : {}),
    ...(e.kind === "travel" && e.travel ? { travel: e.travel } : {}),
  }));
}

/** Paid minutes of an entry: its length less its breaks inside it. */
export function workedMinutes(entry: Pick<TimesheetFact, "start" | "end" | "breaks">): number {
  const length = minutesBetween(entry.start, entry.end);
  const breaks = entry.breaks.reduce((n, b) => {
    const start = b.start > entry.start ? b.start : entry.start;
    const end = b.end < entry.end ? b.end : entry.end;
    return n + Math.max(0, minutesBetween(start, end));
  }, 0);
  return Math.max(0, length - breaks);
}

export interface StoredOptOut {
  readonly signedOn: string;
  readonly endsOn: string | null;
  readonly noticeAmount: number | null;
  readonly noticeUnit: "days" | "months" | null;
  readonly noticeGivenOn: string | null;
}

/** Rule 8: an opt-out on file as the working time check reads it. */
export function optOutAgreement(o: StoredOptOut): OptOutAgreement {
  return {
    signedOn: o.signedOn,
    endsOn: o.endsOn,
    noticePeriod:
      o.noticeAmount !== null && o.noticeUnit !== null
        ? { amount: o.noticeAmount, unit: o.noticeUnit }
        : null,
    noticeGivenOn: o.noticeGivenOn,
  };
}

/** Whether a device time falls in a booked shift's access window (rule 2; ADR-0088). */
export function withinBookedWindow(deviceTime: Date, shift: Span, postShiftHours: number): boolean {
  return (
    deviceTime >= shift.start &&
    deviceTime < plusMinutes(shift.end, postShiftHours * MINUTES_PER_HOUR)
  );
}
