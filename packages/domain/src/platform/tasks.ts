import { addUkDays, fromUkWallClock, toUkWallClock } from "../shared/time";

/**
 * Task engine rules (section 9.1): tasks have an owner, a due time or window, a recurrence, and
 * evidence. Care plan actions, chart rules, assessment triggers, statutory clocks and managers all
 * create tasks; these rules decide how a task may move between states, when it is overdue and
 * escalates, and when a recurring task falls due. Pure functions; times are UTC instants and
 * recurrences are expressed in UK local time (hazard HZ-009).
 */

export const TASK_STATUSES = ["open", "in_progress", "done", "skipped", "cancelled"] as const;
export type TaskStatus = (typeof TASK_STATUSES)[number];

export const TERMINAL_TASK_STATUSES: readonly TaskStatus[] = ["done", "skipped", "cancelled"];

const ALLOWED: Record<TaskStatus, readonly TaskStatus[]> = {
  open: ["in_progress", "done", "skipped", "cancelled"],
  in_progress: ["open", "done", "skipped", "cancelled"],
  done: [],
  skipped: [],
  cancelled: [],
};

/** Shortest reason accepted when a task is skipped or cancelled (a word or two, never blank). */
export const MIN_TASK_REASON_LENGTH = 3;

export type TaskTransitionProblem =
  | "terminal"
  | "not_allowed"
  | "reason_required"
  | "evidence_required";

export type TaskTransitionCheck =
  | { readonly ok: true }
  | { readonly ok: false; readonly problem: TaskTransitionProblem; readonly message: string };

export interface TaskTransitionRequest {
  readonly to: TaskStatus;
  readonly reason?: string | null;
  /** The note, observation or document that shows the task was done. */
  readonly evidenceId?: string | null;
  /** Task kinds such as repositioning or a fluid round must point at the record they produced. */
  readonly evidenceRequired?: boolean;
}

const MESSAGES: Record<TaskTransitionProblem, string> = {
  terminal: "This task is already finished and cannot change.",
  not_allowed: "A task cannot move to that state from its current state.",
  reason_required: "Say why the task was not done.",
  evidence_required: "Record what was done before completing this task.",
};

function problem(p: TaskTransitionProblem): TaskTransitionCheck {
  return { ok: false, problem: p, message: MESSAGES[p] };
}

export function checkTaskTransition(
  current: TaskStatus,
  request: TaskTransitionRequest,
): TaskTransitionCheck {
  if (TERMINAL_TASK_STATUSES.includes(current)) return problem("terminal");
  if (!ALLOWED[current].includes(request.to)) return problem("not_allowed");
  if (
    (request.to === "skipped" || request.to === "cancelled") &&
    (request.reason?.trim().length ?? 0) < MIN_TASK_REASON_LENGTH
  ) {
    return problem("reason_required");
  }
  if (request.to === "done" && request.evidenceRequired && !request.evidenceId) {
    return problem("evidence_required");
  }
  return { ok: true };
}

export type TaskTimeState = "closed" | "upcoming" | "due" | "overdue" | "escalated";

export interface TaskTiming {
  readonly status: TaskStatus;
  readonly dueAt: Date;
  /** Start of the window in which the task may be done (defaults to the due time). */
  readonly windowStart?: Date | null;
  /** End of the window; the task is overdue after it (defaults to the due time). */
  readonly windowEnd?: Date | null;
}

/**
 * Where a task stands at `now`. A task is overdue once its window has closed and escalates when it
 * has been overdue for `escalateAfterMinutes` (a tenant default from the rate table, resolved by
 * the caller), so a missed task reaches the nurse in charge (hazard HZ-008: one escalation, not a
 * stream of alerts).
 */
export function taskTimeState(
  task: TaskTiming,
  now: Date,
  escalateAfterMinutes: number,
): TaskTimeState {
  if (TERMINAL_TASK_STATUSES.includes(task.status)) return "closed";
  const start = task.windowStart ?? task.dueAt;
  const end = task.windowEnd ?? task.dueAt;
  if (now.getTime() < start.getTime()) return "upcoming";
  if (now.getTime() <= end.getTime()) return "due";
  const overdueMinutes = (now.getTime() - end.getTime()) / 60_000;
  return overdueMinutes >= escalateAfterMinutes ? "escalated" : "overdue";
}

// ------------------------------------------------------------------------------------------------
// Entries that answer a task, and tasks brought back after a return or a correction
// ------------------------------------------------------------------------------------------------

/** What happened to the task an entry named (care.md rule 7; HZ-004, HZ-006). */
export type TaskLinkOutcome = "completed" | "task_cancelled" | "task_already_closed" | "not_linked";

export type TaskLinkProblem = "wrong_person" | "medicines_not_yours" | "medicines_already_closed";

export type TaskLinkCheck =
  | {
      readonly ok: true;
      readonly outcome: TaskLinkOutcome;
      /** True when the nurse in charge must look at it: the round may be repeated or doubled. */
      readonly review: boolean;
    }
  | { readonly ok: false; readonly problem: TaskLinkProblem; readonly message: string };

const TASK_LINK_MESSAGES: Record<TaskLinkProblem, string> = {
  wrong_person: "That task is not for this person.",
  medicines_not_yours:
    "This medicines task is for someone with the right permission. Ask them to record it.",
  medicines_already_closed:
    "This medicines task has already been recorded. Check the record before giving anything again.",
};

const isMedicinesTask = (kind: string) => kind.startsWith("medicines.");

/**
 * What an entry does to the task it names. The entry is kept whatever happened to the task (an
 * entry recorded offline is never lost, HZ-006), except for a medicines task: one the user may not
 * complete, or one already done or skipped, is refused, because recording it could repeat a dose
 * (HZ-004). Otherwise an entry for a task the user may not complete, or one already closed, is kept
 * unlinked and flagged, and the nurse in charge reviews it, since the round may be repeated or
 * counted twice. A task cancelled by the lifecycle keeps the entry as late evidence.
 */
export function checkTaskLink(
  task: { readonly personId: string | null; readonly kind: string; readonly status: TaskStatus },
  entry: { readonly personId: string; readonly mayComplete: boolean },
): TaskLinkCheck {
  const refuse = (problem: TaskLinkProblem): TaskLinkCheck => ({
    ok: false,
    problem,
    message: TASK_LINK_MESSAGES[problem],
  });
  if (task.personId !== entry.personId) return refuse("wrong_person");
  if (!entry.mayComplete) {
    if (isMedicinesTask(task.kind)) return refuse("medicines_not_yours");
    return { ok: true, outcome: "not_linked", review: true };
  }
  if (task.status === "cancelled") return { ok: true, outcome: "task_cancelled", review: false };
  if (task.status === "done" || task.status === "skipped") {
    if (isMedicinesTask(task.kind)) return refuse("medicines_already_closed");
    return { ok: true, outcome: "task_already_closed", review: true };
  }
  return { ok: true, outcome: "completed", review: false };
}

/** A task the people lifecycle stopped (paused while away, or ended at an exit). */
export interface StoppedTask {
  readonly id: string;
  readonly seriesId: string | null;
  readonly dueAt: Date;
  readonly windowEnd: Date | null;
  /** An entry answered it after it was stopped (an offline upload). */
  readonly hasEvidence: boolean;
}

export interface TaskRestorePlan {
  /** Answered by an entry while stopped: restored as done, never due again (HZ-003, HZ-004). */
  readonly done: readonly string[];
  /** Still in their window: open again. */
  readonly reopen: readonly string[];
  /** The latest missed occurrence of each series (or a missed one-off task): open, overdue. */
  readonly reopenOverdue: readonly string[];
  /** Missed earlier occurrences: stay cancelled, coded as missed, and listed for review. */
  readonly missed: readonly string[];
}

/**
 * What a return or a correction does with the tasks the lifecycle stopped (people.md rules 1 and
 * 2; HZ-003, HZ-004). Only tasks whose window had not closed by `since` (when the person came
 * back, or when the exit recorded in error began) count. A task with evidence is done. One still in
 * its window at `now` reopens. Of the rest, the latest occurrence of each series reopens as overdue
 * so the round is caught up once, unless a later occurrence was done; earlier ones stay missed.
 */
export function planTaskRestore(
  tasks: readonly StoppedTask[],
  since: Date,
  now: Date,
): TaskRestorePlan {
  const end = (t: StoppedTask) => (t.windowEnd ?? t.dueAt).getTime();
  const relevant = tasks.filter((t) => end(t) >= since.getTime());
  const done = relevant.filter((t) => t.hasEvidence);
  const rest = relevant.filter((t) => !t.hasEvidence);
  const reopen = rest.filter((t) => end(t) >= now.getTime());
  const late = rest.filter((t) => end(t) < now.getTime());
  const key = (t: StoppedTask) => t.seriesId ?? t.id;
  const latest = new Map<string, StoppedTask>();
  for (const t of late) {
    const current = latest.get(key(t));
    if (!current || t.dueAt.getTime() > current.dueAt.getTime()) latest.set(key(t), t);
  }
  const reopenOverdue = [...latest.values()]
    .filter((t) => !done.some((d) => key(d) === key(t) && d.dueAt.getTime() > t.dueAt.getTime()))
    .map((t) => t.id);
  return {
    done: done.map((t) => t.id),
    reopen: reopen.map((t) => t.id),
    reopenOverdue,
    missed: late.filter((t) => !reopenOverdue.includes(t.id)).map((t) => t.id),
  };
}

// ------------------------------------------------------------------------------------------------
// Recurrence
// ------------------------------------------------------------------------------------------------

export const WEEKDAYS = ["mon", "tue", "wed", "thu", "fri", "sat", "sun"] as const;
export type Weekday = (typeof WEEKDAYS)[number];

/**
 * When a recurring task falls due. Wall-clock rules (daily, weekly, monthly) keep their local
 * time across daylight-saving changes; `every_hours` counts real elapsed hours from an anchor,
 * because intervals such as repositioning are clinical intervals, not clock times.
 */
export type Recurrence =
  | { readonly freq: "daily"; readonly interval?: number; readonly times: readonly string[] }
  | {
      readonly freq: "weekly";
      readonly interval?: number;
      readonly weekdays: readonly Weekday[];
      readonly times: readonly string[];
    }
  | {
      readonly freq: "monthly";
      readonly interval?: number;
      /** 1 to 31; in shorter months the task falls on the last day. */
      readonly dayOfMonth: number;
      readonly times: readonly string[];
    }
  | { readonly freq: "every_hours"; readonly hours: number; readonly anchorTime: string };

export interface RecurrenceSeries {
  readonly rule: Recurrence;
  /** First day of the series (YYYY-MM-DD, UK local). */
  readonly startsOn: string;
  /** Last day of the series, inclusive (YYYY-MM-DD, UK local). */
  readonly endsOn?: string | null;
}

export class RecurrenceError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RecurrenceError";
  }
}

const TIME_PATTERN = /^([01]\d|2[0-3]):([0-5]\d)$/;
const DATE_PATTERN = /^(\d{4})-(\d{2})-(\d{2})$/;
/** Guard against runaway generation from a bad window. */
export const MAX_OCCURRENCES = 1000;

function parseTime(value: string): { hour: number; minute: number } {
  const match = TIME_PATTERN.exec(value);
  if (!match) throw new RecurrenceError(`Times must be HH:MM in 24-hour time, not "${value}".`);
  return { hour: Number(match[1]), minute: Number(match[2]) };
}

interface DayParts {
  readonly year: number;
  readonly month: number;
  readonly day: number;
}

function parseDate(value: string): DayParts {
  const match = DATE_PATTERN.exec(value);
  if (!match) throw new RecurrenceError(`Dates must be YYYY-MM-DD, not "${value}".`);
  const parts = { year: Number(match[1]), month: Number(match[2]), day: Number(match[3]) };
  const check = new Date(Date.UTC(parts.year, parts.month - 1, parts.day));
  if (check.getUTCMonth() !== parts.month - 1 || check.getUTCDate() !== parts.day) {
    throw new RecurrenceError(`"${value}" is not a real date.`);
  }
  return parts;
}

function dayNumber(d: DayParts): number {
  return Math.floor(Date.UTC(d.year, d.month - 1, d.day) / 86_400_000);
}

function fromDayNumber(n: number): DayParts {
  const date = new Date(n * 86_400_000);
  return { year: date.getUTCFullYear(), month: date.getUTCMonth() + 1, day: date.getUTCDate() };
}

function ukDay(instant: Date): DayParts {
  const w = toUkWallClock(instant);
  return { year: w.year, month: w.month, day: w.day };
}

function positiveInteger(value: number | undefined, fallback: number, label: string): number {
  const v = value ?? fallback;
  if (!Number.isInteger(v) || v < 1)
    throw new RecurrenceError(`${label} must be a whole number of 1 or more.`);
  return v;
}

/** Validates a recurrence and throws a RecurrenceError with a plain-English message if it is wrong. */
export function validateRecurrence(series: RecurrenceSeries): void {
  const start = parseDate(series.startsOn);
  if (series.endsOn) {
    const end = parseDate(series.endsOn);
    if (dayNumber(end) < dayNumber(start))
      throw new RecurrenceError("The series ends before it starts.");
  }
  const rule = series.rule;
  if (rule.freq === "every_hours") {
    if (!Number.isInteger(rule.hours) || rule.hours < 1 || rule.hours > 24) {
      throw new RecurrenceError("Hourly intervals must be a whole number of hours from 1 to 24.");
    }
    parseTime(rule.anchorTime);
    return;
  }
  positiveInteger(rule.interval, 1, "The interval");
  if (rule.times.length === 0) throw new RecurrenceError("Give at least one time of day.");
  for (const t of rule.times) parseTime(t);
  if (rule.freq === "weekly") {
    if (rule.weekdays.length === 0)
      throw new RecurrenceError("Choose at least one day of the week.");
    for (const d of rule.weekdays) {
      if (!WEEKDAYS.includes(d)) throw new RecurrenceError(`"${d}" is not a day of the week.`);
    }
  }
  if (rule.freq === "monthly") {
    if (!Number.isInteger(rule.dayOfMonth) || rule.dayOfMonth < 1 || rule.dayOfMonth > 31) {
      throw new RecurrenceError("The day of the month must be from 1 to 31.");
    }
  }
}

function daysInMonth(year: number, month: number): number {
  return new Date(Date.UTC(year, month, 0)).getUTCDate();
}

/** ISO weekday index, Monday 0 to Sunday 6, for a calendar day. */
function weekdayIndex(d: DayParts): number {
  return (new Date(Date.UTC(d.year, d.month - 1, d.day)).getUTCDay() + 6) % 7;
}

function dayMatches(
  rule: Exclude<Recurrence, { freq: "every_hours" }>,
  start: DayParts,
  d: DayParts,
): boolean {
  const interval = rule.interval ?? 1;
  if (rule.freq === "daily") return (dayNumber(d) - dayNumber(start)) % interval === 0;
  if (rule.freq === "weekly") {
    if (!rule.weekdays.includes(WEEKDAYS[weekdayIndex(d)] as Weekday)) return false;
    const startMonday = dayNumber(start) - weekdayIndex(start);
    const weeks = Math.floor((dayNumber(d) - startMonday) / 7);
    return weeks % interval === 0;
  }
  const months = (d.year - start.year) * 12 + (d.month - start.month);
  if (months % interval !== 0) return false;
  return d.day === Math.min(rule.dayOfMonth, daysInMonth(d.year, d.month));
}

/**
 * Due times of a recurring task in the half-open window [from, to), in ascending order. Throws a
 * RecurrenceError for an invalid rule or when the window would produce more than MAX_OCCURRENCES.
 */
export function occurrences(series: RecurrenceSeries, from: Date, to: Date): Date[] {
  validateRecurrence(series);
  const start = parseDate(series.startsOn);
  const end = series.endsOn ? parseDate(series.endsOn) : null;
  const out: Date[] = [];
  const push = (instant: Date) => {
    if (instant.getTime() < from.getTime() || instant.getTime() >= to.getTime()) return;
    const day = dayNumber(ukDay(instant));
    if (day < dayNumber(start) || (end && day > dayNumber(end))) return;
    out.push(instant);
    if (out.length > MAX_OCCURRENCES) {
      throw new RecurrenceError(`More than ${MAX_OCCURRENCES} occurrences; use a shorter window.`);
    }
  };

  const rule = series.rule;
  if (rule.freq === "every_hours") {
    const anchor = parseTime(rule.anchorTime);
    const first = fromUkWallClock(start.year, start.month, start.day, anchor.hour, anchor.minute);
    const step = rule.hours * 3_600_000;
    const skip = Math.max(0, Math.ceil((from.getTime() - first.getTime()) / step));
    for (let t = first.getTime() + skip * step; t < to.getTime(); t += step) push(new Date(t));
    return out;
  }

  const times = [...rule.times]
    .map(parseTime)
    .sort((a, b) => a.hour * 60 + a.minute - (b.hour * 60 + b.minute));
  const firstDay = Math.max(dayNumber(start), dayNumber(ukDay(addUkDays(from, -1))));
  const lastDay = Math.min(end ? dayNumber(end) : Number.POSITIVE_INFINITY, dayNumber(ukDay(to)));
  for (let n = firstDay; n <= lastDay; n++) {
    const d = fromDayNumber(n);
    if (!dayMatches(rule, start, d)) continue;
    for (const t of times) push(fromUkWallClock(d.year, d.month, d.day, t.hour, t.minute));
  }
  return out;
}
