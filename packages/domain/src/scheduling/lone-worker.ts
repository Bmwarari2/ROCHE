import { type EscalationStep, validateChain } from "../platform/notifications";
import { MINUTES_PER_HOUR, MS_PER_MINUTE } from "./intervals";

/**
 * Lone-worker safety (SCHED-012, Phase 2 slice 46; scheduling.md section 15; HZ-125).
 *
 * A member of staff working alone (a domiciliary visit, a night shift) starts a session with a
 * check-in interval. Each check-in is an append-only event with a client UUID. When a check-in is
 * due and none arrives, the worker is reminded; when the grace period after that passes, an alarm
 * is raised to the organisation's named on-call route (H-539) and keeps escalating, and keeps being
 * re-sent, until a person acknowledges it. A duress check-in looks like an ordinary one to anyone
 * watching the worker's screen and raises an urgent alarm; a help request raises one openly.
 *
 * The offline rule (scheduling.md section 15.4): the server decides from the device time of the
 * check-ins it has received, never from when they arrived. A check-in made on time on a device that
 * was offline therefore never counts as missed once it arrives; one that arrives after the alarm was
 * raised resolves that alarm as a late check-in from an offline device, flagged, and everyone who
 * was alerted is told the worker was safe at that time. The server cannot tell a device that is
 * offline from a worker who is hurt, so silence past the grace period always raises the alarm:
 * the grace period (a rate) is what absorbs ordinary sync delays, and nothing suppresses an alarm
 * because the device might be offline.
 *
 * Figures (grace, interval bounds, re-alert period, offline flag, clock drift) are rate-table
 * rows; this module takes them as arguments and holds no figure of its own.
 */

export const LONE_WORKER_EVENT_KINDS = ["check_in", "duress", "help", "finish"] as const;
export type LoneWorkerEventKind = (typeof LONE_WORKER_EVENT_KINDS)[number];

export const LONE_WORKER_ALARM_REASONS = ["overdue", "not_finished", "duress", "help"] as const;
export type LoneWorkerAlarmReason = (typeof LONE_WORKER_ALARM_REASONS)[number];

export const LONE_WORKER_ALARM_STATES = [
  "open",
  "acknowledged",
  "resolved_by_check_in",
  "resolved_late_check_in",
  "resolved_by_finish",
] as const;
export type LoneWorkerAlarmState = (typeof LONE_WORKER_ALARM_STATES)[number];

export const LONE_WORKER_OUTCOMES = [
  "safe_confirmed",
  "help_sent",
  "emergency_services_called",
  "other",
] as const;
export type LoneWorkerOutcome = (typeof LONE_WORKER_OUTCOMES)[number];

/** The chain key of the organisation's on-call route for lone-worker alarms (H-539). */
export const LONE_WORKER_ROUTE_KEY = "scheduling.lone_worker.alarm";

/** Rate-table keys (docs/specs/rates.md). */
export const LONE_WORKER_RATE_KEYS = {
  graceMinutes: "lone_worker.grace_minutes",
  intervalMinMinutes: "lone_worker.check_in_min_minutes",
  intervalMaxMinutes: "lone_worker.check_in_max_minutes",
  realertMinutes: "lone_worker.realert_minutes",
  offlineFlagMinutes: "lone_worker.offline_flag_minutes",
  locationDays: "lone_worker.location_days",
  sessionMaxHours: "lone_worker.session_max_hours",
} as const;

const MINUTE = MS_PER_MINUTE;

export interface LoneWorkerTimings {
  /** Minutes after a check-in is due before the alarm is raised (covers ordinary sync delay). */
  readonly graceMinutes: number;
  /** A check-in received this many minutes or more after it was made is flagged as late. */
  readonly offlineFlagMinutes: number;
  /** A device clock may run this far ahead of the server before an event is refused. */
  readonly clockDriftMinutes: number;
}

export interface LoneWorkerSessionTimes {
  readonly startedAt: Date;
  readonly plannedEndAt: Date;
  readonly intervalMinutes: number;
  readonly finishedAt: Date | null;
}

// ---------------------------------------------------------------------------------------------
// Starting a session

export type SessionProblem =
  | "interval_too_short"
  | "interval_too_long"
  | "interval_not_whole"
  | "end_not_after_start"
  | "too_long"
  | "start_in_future";

export const SESSION_PROBLEM_MESSAGES: Record<SessionProblem, string> = {
  interval_too_short: "Check-ins cannot be closer together than the organisation's minimum.",
  interval_too_long: "Check-ins cannot be further apart than the organisation's maximum.",
  interval_not_whole: "The check-in interval must be a whole number of minutes.",
  end_not_after_start: "The planned end must be after the start.",
  too_long: "A session cannot be longer than the organisation's maximum. Start a new one later.",
  start_in_future: "A session cannot start in the future.",
};

export function checkSession(
  input: {
    readonly startedAt: Date;
    readonly plannedEndAt: Date;
    readonly intervalMinutes: number;
  },
  bounds: {
    readonly intervalMinMinutes: number;
    readonly intervalMaxMinutes: number;
    readonly sessionMaxHours: number;
    readonly clockDriftMinutes: number;
  },
  now: Date,
): SessionProblem[] {
  const problems: SessionProblem[] = [];
  if (!Number.isInteger(input.intervalMinutes)) problems.push("interval_not_whole");
  if (input.intervalMinutes < bounds.intervalMinMinutes) problems.push("interval_too_short");
  if (input.intervalMinutes > bounds.intervalMaxMinutes) problems.push("interval_too_long");
  if (input.plannedEndAt.getTime() <= input.startedAt.getTime())
    problems.push("end_not_after_start");
  else if (
    input.plannedEndAt.getTime() - input.startedAt.getTime() >
    bounds.sessionMaxHours * MINUTES_PER_HOUR * MINUTE
  )
    problems.push("too_long");
  if (input.startedAt.getTime() > now.getTime() + bounds.clockDriftMinutes * MINUTE)
    problems.push("start_in_future");
  return problems;
}

// ---------------------------------------------------------------------------------------------
// Accepting an event (possibly made offline and sent late)

export type EventRefusal = "in_future" | "before_start" | "after_finish";

export const EVENT_REFUSAL_MESSAGES: Record<EventRefusal, string> = {
  in_future: "The check-in time is in the future. Check the device's clock.",
  before_start: "The check-in is from before the session started.",
  after_finish: "The session has finished. Start a new session to check in again.",
};

export type EventAcceptance =
  | {
      readonly accepted: true;
      /** The time the check-in counts from: the device time, never later than its receipt. */
      readonly effectiveAt: Date;
      /** Received at least `offlineFlagMinutes` after it was made (an offline device). */
      readonly late: boolean;
    }
  | { readonly accepted: false; readonly refusal: EventRefusal };

/**
 * Whether an event counts, and from when. A device clock a little ahead of the server (within the
 * drift tolerance) is clamped to the receipt time. A help or duress event is always accepted, even
 * after the session finished or with a wrong clock: refusing a cry for help is never safe (HZ-125).
 */
export function acceptEvent(
  event: { readonly kind: LoneWorkerEventKind; readonly deviceAt: Date; readonly receivedAt: Date },
  session: Pick<LoneWorkerSessionTimes, "startedAt" | "finishedAt">,
  timings: LoneWorkerTimings,
): EventAcceptance {
  const drift = timings.clockDriftMinutes * MINUTE;
  const device = event.deviceAt.getTime();
  const received = event.receivedAt.getTime();
  const alarming = event.kind === "help" || event.kind === "duress";
  const effective = new Date(Math.min(device, received));
  const late = received - device >= timings.offlineFlagMinutes * MINUTE;
  if (alarming) {
    // Counted from receipt when the clock cannot be trusted, so the alarm is never dated away.
    const trusted = device <= received + drift && device >= session.startedAt.getTime() - drift;
    return { accepted: true, effectiveAt: trusted ? effective : event.receivedAt, late };
  }
  if (device > received + drift) return { accepted: false, refusal: "in_future" };
  if (device < session.startedAt.getTime() - drift)
    return { accepted: false, refusal: "before_start" };
  // Made after the finish (by its clamped time): an offline check-in made before it still counts.
  if (session.finishedAt && effective.getTime() > session.finishedAt.getTime())
    return { accepted: false, refusal: "after_finish" };
  return { accepted: true, effectiveAt: effective, late };
}

// ---------------------------------------------------------------------------------------------
// When the next check-in is due, and what the sweep does about it

/**
 * The next check-in is due one interval after the latest check-in (by its effective time, so
 * events arriving out of order never move it backwards), or after the start; never later than the
 * planned end, when the worker must finish the session or check in to say they are staying on.
 */
export function nextCheckInDue(
  session: Pick<LoneWorkerSessionTimes, "startedAt" | "plannedEndAt" | "intervalMinutes">,
  checkInEffectiveTimes: readonly Date[],
): { readonly dueAt: Date; readonly reason: "overdue" | "not_finished" } {
  const latest = checkInEffectiveTimes.reduce(
    (max, t) => Math.max(max, t.getTime()),
    session.startedAt.getTime(),
  );
  const byInterval = latest + session.intervalMinutes * MINUTE;
  const end = session.plannedEndAt.getTime();
  // A check-in after the planned end (staying on) restarts the interval from that check-in.
  if (latest >= end) return { dueAt: new Date(byInterval), reason: "not_finished" };
  return byInterval >= end
    ? { dueAt: new Date(end), reason: "not_finished" }
    : { dueAt: new Date(byInterval), reason: "overdue" };
}

export type SessionStatus =
  | { readonly kind: "finished" }
  | { readonly kind: "ok"; readonly dueAt: Date }
  | { readonly kind: "due"; readonly dueAt: Date; readonly alarmAt: Date }
  | {
      readonly kind: "alarm";
      readonly dueAt: Date;
      readonly alarmAt: Date;
      readonly reason: "overdue" | "not_finished";
    };

/**
 * What the sweep should do for a session at `now`: nothing (`ok`), remind the worker (`due`), or
 * raise the alarm (`alarm`, from `dueAt + grace`). The rule is the same whether the device is online
 * or offline: only check-ins the server has received count, by the time they were made.
 */
export function sessionStatus(
  session: LoneWorkerSessionTimes,
  checkInEffectiveTimes: readonly Date[],
  timings: Pick<LoneWorkerTimings, "graceMinutes">,
  now: Date,
): SessionStatus {
  if (session.finishedAt) return { kind: "finished" };
  const { dueAt, reason } = nextCheckInDue(session, checkInEffectiveTimes);
  const alarmAt = new Date(dueAt.getTime() + timings.graceMinutes * MINUTE);
  if (now.getTime() < dueAt.getTime()) return { kind: "ok", dueAt };
  if (now.getTime() < alarmAt.getTime()) return { kind: "due", dueAt, alarmAt };
  return { kind: "alarm", dueAt, alarmAt, reason };
}

// ---------------------------------------------------------------------------------------------
// Resolving an alarm

export type CheckInResolution =
  | { readonly kind: "stays_open"; readonly why: "raised_by_worker" | "still_overdue" }
  | {
      readonly kind: "resolved";
      readonly state: "resolved_by_check_in" | "resolved_late_check_in" | "resolved_by_finish";
    };

/**
 * What a newly accepted check-in (or the finish) does to an open alarm. Only an overdue or
 * not-finished alarm is resolved by one; a duress or help alarm needs a person to acknowledge it,
 * because the worker may be made to check in. Only ordinary check-ins and the finish count here:
 * a help or duress press never tells anyone the worker "checked in" (clinical review M1), so the
 * caller works out `statusAfter` from check-ins alone. A check-in made before the alarm was raised
 * (stuck on an offline device) resolves it as a late check-in, flagged; but only if the worker is
 * not overdue again by now, since safe then is not safe now (no false sense of safety; HZ-125).
 * A finish resolves it in its own words, so nobody reads it as a check-in (clinical review M8).
 */
export function resolveOnCheckIn(
  alarm: { readonly reason: LoneWorkerAlarmReason; readonly raisedAt: Date },
  checkInEffectiveAt: Date,
  statusAfter: SessionStatus,
  byFinish = false,
): CheckInResolution {
  if (alarm.reason === "duress" || alarm.reason === "help")
    return { kind: "stays_open", why: "raised_by_worker" };
  if (statusAfter.kind === "alarm") return { kind: "stays_open", why: "still_overdue" };
  if (byFinish) return { kind: "resolved", state: "resolved_by_finish" };
  return {
    kind: "resolved",
    state:
      checkInEffectiveAt.getTime() < alarm.raisedAt.getTime()
        ? "resolved_late_check_in"
        : "resolved_by_check_in",
  };
}

export type AcknowledgeProblem = "own_alarm" | "not_open" | "note_required" | "finish_or_safe";

export const ACKNOWLEDGE_PROBLEM_MESSAGES: Record<AcknowledgeProblem, string> = {
  own_alarm: "Someone other than the lone worker must acknowledge this alarm.",
  not_open: "This alarm is no longer open.",
  note_required: "Say what was done.",
  finish_or_safe: "Only an alarm confirmed safe can be closed without saying what was done.",
};

/**
 * Who may acknowledge an alarm, and with what. The worker never acknowledges their own alarm (a
 * duress check-in would otherwise be cancelled under pressure); a note is always required. Any
 * outcome other than safe confirmed suggests an incident report (`incidentSuggested`).
 */
export function checkAcknowledge(
  alarm: { readonly state: LoneWorkerAlarmState; readonly workerId: string },
  input: { readonly by: string; readonly outcome: LoneWorkerOutcome; readonly note: string },
): { readonly problems: AcknowledgeProblem[]; readonly incidentSuggested: boolean } {
  const problems: AcknowledgeProblem[] = [];
  if (alarm.state !== "open") problems.push("not_open");
  if (input.by === alarm.workerId) problems.push("own_alarm");
  if (input.note.trim().length === 0) problems.push("note_required");
  return { problems, incidentSuggested: input.outcome !== "safe_confirmed" };
}

/** Whether an open alarm is sent again now: never silent, even after the chain has run out. */
export function realertDue(
  alarm: { readonly state: LoneWorkerAlarmState; readonly lastAlertedAt: Date },
  realertMinutes: number,
  now: Date,
): boolean {
  return (
    alarm.state === "open" &&
    now.getTime() >= alarm.lastAlertedAt.getTime() + realertMinutes * MINUTE
  );
}

// ---------------------------------------------------------------------------------------------
// The on-call route (H-539)

export type RouteProblem =
  | "chain"
  | "too_few_steps"
  | "no_registered_manager"
  | "manager_first"
  | "in_app_only";

export const ROUTE_PROBLEM_MESSAGES: Record<RouteProblem, string> = {
  chain: "The steps are not in a valid order or have no target or channel.",
  too_few_steps: "Name the on-call person or role first, then the Registered Manager.",
  no_registered_manager: "A later step must go to the Registered Manager.",
  manager_first: "The first step is the on-call person or role, before the Registered Manager.",
  in_app_only: "Every step must reach people away from the app, by push, email or text message.",
};

/**
 * Checks a route. The order is the lead's and H-539's: the worker is reminded first (not a step:
 * Harbour always does it), then step 1, the on-call person or role, is told the moment the alarm
 * is raised; later steps follow by their minutes, and one of them is the Registered Manager. Every
 * step must reach people outside the app. The feature stays off until a valid route is saved.
 */
export function checkRoute(steps: readonly EscalationStep[]): {
  readonly problems: RouteProblem[];
  readonly chainProblems: string[];
} {
  const problems: RouteProblem[] = [];
  const chainProblems = validateChain(steps);
  if (chainProblems.length > 0) problems.push("chain");
  if (steps.length < 2) problems.push("too_few_steps");
  const [first, ...later] = steps;
  if (first && first.targetRoleKey === "registered_manager" && !first.targetTenantUserId)
    problems.push("manager_first");
  if (steps.length >= 2 && !later.some((s) => s.targetRoleKey === "registered_manager"))
    problems.push("no_registered_manager");
  if (steps.some((s) => !s.channels.some((c) => c !== "in_app"))) problems.push("in_app_only");
  return { problems, chainProblems };
}

/** The words a monitor reads for an alarm's state, with its reason (never by colour alone). */
export const ALARM_STATE_WORDS: Record<LoneWorkerAlarmState, string> = {
  open: "Open",
  acknowledged: "Acknowledged",
  resolved_by_check_in: "Checked in after the alarm",
  resolved_late_check_in: "Late check-in from an offline device",
  resolved_by_finish: "Session finished after the alarm",
};

export const ALARM_REASON_WORDS: Record<LoneWorkerAlarmReason, string> = {
  overdue: "Check-in overdue",
  not_finished: "Session not finished",
  duress: "Duress",
  help: "Help requested",
};

/**
 * What the worker's own screen shows for an event: a duress check-in reads exactly as an ordinary
 * one, so a person standing over them cannot tell (scheduling.md section 15.3).
 */
export function kindShownToWorker(kind: LoneWorkerEventKind): LoneWorkerEventKind {
  return kind === "duress" ? "check_in" : kind;
}
