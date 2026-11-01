import type {
  LoneWorkerAlarmItem,
  LoneWorkerAlarmReason,
  LoneWorkerBoardItem,
  LoneWorkerOutcome,
  LoneWorkerRouteStep,
  LoneWorkerSessionStatus,
  LoneWorkerWorkKind,
} from "@harbour/contracts";
import { BUILTIN_ROLES } from "@harbour/domain";
import type { Translator } from "@harbour/i18n";
import type { StatusChipStatus } from "@harbour/ui";
import type { FieldProblem } from "./outcome";
import { formatUkTime } from "./uk-time";

/**
 * Lone-worker screens (SCHED-012, Phase 2 slice 61; scheduling.md section 14; HZ-125). The API
 * decides every rule: who may start, check in, see the board, acknowledge and name the route. These
 * helpers only order and word what the API returns, and check a form before it is sent. Duress is
 * never offered or named on the worker's own screens: a duress check-in reads as a check-in, and
 * the web pages offer the worker check-in, help and finish only (H-1140).
 */

export const LONE_WORKER_PERMISSIONS = {
  checkIn: "scheduling.lone_worker.check_in",
  monitor: "scheduling.lone_worker.monitor",
  manage: "scheduling.lone_worker.manage",
} as const;

export interface LoneWorkerAccess {
  readonly checkIn: boolean;
  readonly monitor: boolean;
  readonly manage: boolean;
}

export function loneWorkerAccess(permissions: readonly string[]): LoneWorkerAccess {
  return {
    checkIn: permissions.includes(LONE_WORKER_PERMISSIONS.checkIn),
    monitor: permissions.includes(LONE_WORKER_PERMISSIONS.monitor),
    manage: permissions.includes(LONE_WORKER_PERMISSIONS.manage),
  };
}

/** The navigation shows "Lone working" to anyone who checks in, monitors or names the route. */
export function loneWorkerNavShown(permissions: readonly string[]): boolean {
  const access = loneWorkerAccess(permissions);
  return access.checkIn || access.monitor || access.manage;
}

export const WORK_KINDS: readonly LoneWorkerWorkKind[] = [
  "domiciliary_visit",
  "night_shift",
  "other",
];

export const OUTCOMES: readonly LoneWorkerOutcome[] = [
  "safe_confirmed",
  "help_sent",
  "emergency_services_called",
  "other",
];

// ---------------------------------------------------------------------------------------------
// The monitor board: duress first (scheduling.md section 14.3 rule 9)

/** Duress first, then help, then an overdue check-in, then a session not finished. */
const REASON_RANK: Record<LoneWorkerAlarmReason, number> = {
  duress: 0,
  help: 1,
  overdue: 2,
  not_finished: 3,
};

const STATUS_RANK: Record<LoneWorkerSessionStatus, number> = {
  alarm: 0,
  due: 1,
  ok: 2,
  finished: 3,
};

const time = (iso: string | null) => (iso ? Date.parse(iso) : Number.POSITIVE_INFINITY);

/**
 * Open alarms before closed ones; among open alarms duress first, then help, overdue and not
 * finished; the longest waiting first within each.
 */
export function alarmsInOrder(items: readonly LoneWorkerAlarmItem[]): LoneWorkerAlarmItem[] {
  return [...items].sort((a, b) => {
    const open = Number(b.state === "open") - Number(a.state === "open");
    if (open !== 0) return open;
    const reason = REASON_RANK[a.reason] - REASON_RANK[b.reason];
    if (reason !== 0) return reason;
    return Date.parse(a.raisedAt) - Date.parse(b.raisedAt);
  });
}

/** The most urgent open alarm on each session, by the order above. */
export function worstOpenAlarm(
  alarms: readonly LoneWorkerAlarmItem[],
): Map<string, LoneWorkerAlarmItem> {
  const worst = new Map<string, LoneWorkerAlarmItem>();
  for (const alarm of alarmsInOrder(alarms)) {
    if (alarm.state !== "open") continue;
    if (!worst.has(alarm.sessionId)) worst.set(alarm.sessionId, alarm);
  }
  return worst;
}

/**
 * Sessions with a duress alarm first, then help, overdue and not finished, the longest waiting
 * first within each; then by status (alarm, due, checked in, finished); then the earliest
 * check-in due first.
 */
export function sessionsInOrder(
  items: readonly LoneWorkerBoardItem[],
  alarms: readonly LoneWorkerAlarmItem[],
): LoneWorkerBoardItem[] {
  const worst = worstOpenAlarm(alarms);
  const rank = (item: LoneWorkerBoardItem) => {
    const alarm = worst.get(item.sessionId);
    return alarm ? REASON_RANK[alarm.reason] : Object.keys(REASON_RANK).length;
  };
  const raised = (item: LoneWorkerBoardItem) => time(worst.get(item.sessionId)?.raisedAt ?? null);
  return [...items].sort(
    (a, b) =>
      rank(a) - rank(b) ||
      // Of two sessions with the same kind of alarm, the one waiting longest first.
      raised(a) - raised(b) ||
      STATUS_RANK[a.status] - STATUS_RANK[b.status] ||
      time(a.nextDueAt) - time(b.nextDueAt),
  );
}

export interface ChipView {
  readonly status: StatusChipStatus;
  readonly label: string;
}

/** A session's status as an icon and its words, never colour alone; the words are the API's. */
export function sessionChip(
  item: Pick<LoneWorkerBoardItem, "status" | "statusWords">,
  alarm: LoneWorkerAlarmItem | undefined,
): ChipView {
  if (alarm) return { status: "overdue", label: alarm.reasonWords };
  switch (item.status) {
    case "alarm":
      return { status: "overdue", label: item.statusWords };
    case "due":
      return { status: "due", label: item.statusWords };
    case "ok":
      return { status: "done", label: item.statusWords };
    case "finished":
      return { status: "notApplicable", label: item.statusWords };
  }
}

/** An alarm's reason while open, then its state in words once acknowledged or resolved. */
export function alarmChip(
  alarm: Pick<LoneWorkerAlarmItem, "state" | "reasonWords" | "stateWords">,
): ChipView {
  if (alarm.state === "open") return { status: "overdue", label: alarm.reasonWords };
  return { status: "done", label: alarm.stateWords };
}

/** Whether the alarm asks for urgent contact: duress or help, open. */
export function urgentAlarm(alarm: Pick<LoneWorkerAlarmItem, "state" | "reason">): boolean {
  return alarm.state === "open" && (alarm.reason === "duress" || alarm.reason === "help");
}

/** The worker's name, or words saying it is not held: never an id. */
export function workerName(alarm: Pick<LoneWorkerAlarmItem, "workerName">, t: Translator) {
  return alarm.workerName ?? t("scheduling.loneWorker.board.nameNotHeld");
}

export function locationName(
  locationId: string,
  locations: readonly { readonly id: string; readonly name: string }[],
  t: Translator,
): string {
  return (
    locations.find((l) => l.id === locationId)?.name ??
    t("scheduling.loneWorker.board.locationNotShown")
  );
}

// ---------------------------------------------------------------------------------------------
// Announcing what a re-read brought

/** One thing on an auto-read page, announced the first read it appears. */
export interface Announcement {
  readonly key: string;
  readonly words: string;
  /** Said at once, interrupting (a duress or help alarm). */
  readonly urgent: boolean;
}

/**
 * What is new since the last read; nothing on the first read (what the page shows on arrival is
 * read in order, never announced over it).
 */
export function newAnnouncements(
  seen: ReadonlySet<string> | null,
  current: readonly Announcement[],
): Announcement[] {
  if (seen === null) return [];
  return current.filter((a) => !seen.has(a.key));
}

// ---------------------------------------------------------------------------------------------
// The worker's own session

/**
 * How long a press's id is kept after an answer was lost: long enough to retry at once, short
 * enough that a later check-in is never taken for the earlier one and swallowed (slice 61
 * clinical review, finding 1).
 */
export const RETRY_WINDOW_MS = 2 * 60_000;

/** When the next check-in is due, in words; "now" is the device's clock. */
export function dueWords(nextDueAt: string | null, now: Date, t: Translator): string | null {
  if (!nextDueAt) return null;
  const at = formatUkTime(nextDueAt) ?? "";
  return Date.parse(nextDueAt) <= now.getTime()
    ? t("scheduling.loneWorker.mine.dueNow", { time: at })
    : t("scheduling.loneWorker.mine.dueBy", { time: at });
}

/** The worker's own status as an icon and words. An open alarm here is overdue or unfinished only. */
export function ownChip(
  session: {
    readonly status: LoneWorkerSessionStatus;
    readonly overdueAlarmOpen: boolean;
    readonly plannedEndAt: string;
  },
  now: Date,
  t: Translator,
): ChipView {
  if (session.overdueAlarmOpen || session.status === "alarm") {
    // Past the planned finish the alarm is "not finished": finishing is the answer too.
    const pastEnd = Date.parse(session.plannedEndAt) <= now.getTime();
    return {
      status: "overdue",
      label: t(
        pastEnd
          ? "scheduling.loneWorker.mine.status.pastEnd"
          : "scheduling.loneWorker.mine.status.alarm",
      ),
    };
  }
  switch (session.status) {
    case "due":
      return { status: "due", label: t("scheduling.loneWorker.mine.status.due") };
    case "finished":
      return { status: "notApplicable", label: t("scheduling.loneWorker.mine.status.finished") };
    default:
      return { status: "done", label: t("scheduling.loneWorker.mine.status.ok") };
  }
}

interface FormLike {
  get(name: string): FormDataEntryValue | null;
  getAll(name: string): FormDataEntryValue[];
}

const text = (form: FormLike, name: string) => {
  const value = form.get(name);
  return typeof value === "string" ? value.trim() : "";
};

const wholeNumber = (value: string): number | null =>
  /^\d{1,4}$/.test(value) ? Number.parseInt(value, 10) : null;

export interface StartInput {
  readonly locationId: string;
  readonly workKind: LoneWorkerWorkKind;
  readonly lengthMinutes: number;
  readonly intervalMinutes: number;
}

/**
 * Reads the start form: where, what kind of work, how long and how often to check in. The start
 * is the moment the form is sent; the API checks the length and interval against the rate table
 * and says so in words.
 */
export function readStart(
  form: FormLike,
  t: Translator,
): { ok: true; input: StartInput } | { ok: false; problems: FieldProblem[] } {
  const problems: FieldProblem[] = [];
  const locationId = text(form, "locationId");
  if (!locationId) {
    problems.push({
      field: "locationId",
      message: t("scheduling.loneWorker.start.locationRequired"),
    });
  }
  const workKind = text(form, "workKind") as LoneWorkerWorkKind;
  if (!WORK_KINDS.includes(workKind)) {
    problems.push({ field: "workKind", message: t("scheduling.loneWorker.start.kindRequired") });
  }
  const hours = wholeNumber(text(form, "hours") || "0");
  const minutes = wholeNumber(text(form, "minutes") || "0");
  if (minutes === null || minutes > 59) {
    problems.push({ field: "minutes", message: t("scheduling.loneWorker.start.minutesRange") });
  } else if (hours === null || hours * 60 + minutes < 1) {
    problems.push({ field: "hours", message: t("scheduling.loneWorker.start.lengthRequired") });
  }
  const length = hours !== null && minutes !== null && minutes <= 59 ? hours * 60 + minutes : null;
  const interval = wholeNumber(text(form, "intervalMinutes"));
  if (interval === null || interval < 1 || interval > 1440) {
    problems.push({
      field: "intervalMinutes",
      message: t("scheduling.loneWorker.start.intervalRequired"),
    });
  }
  if (problems.length > 0) return { ok: false, problems };
  return {
    ok: true,
    input: {
      locationId,
      workKind,
      lengthMinutes: length ?? 0,
      intervalMinutes: interval ?? 0,
    },
  };
}

// ---------------------------------------------------------------------------------------------
// Acknowledging an alarm

export function readAcknowledge(
  form: FormLike,
  t: Translator,
):
  | { ok: true; outcome: LoneWorkerOutcome; note: string }
  | { ok: false; problems: FieldProblem[] } {
  const problems: FieldProblem[] = [];
  const outcome = text(form, "outcome") as LoneWorkerOutcome;
  if (!OUTCOMES.includes(outcome)) {
    problems.push({ field: "outcome", message: t("scheduling.loneWorker.ack.outcomeRequired") });
  }
  const note = text(form, "note");
  if (note.length === 0) {
    problems.push({ field: "note", message: t("scheduling.loneWorker.ack.noteRequired") });
  } else if (note.length > 2000) {
    problems.push({ field: "note", message: t("scheduling.loneWorker.ack.noteTooLong") });
  }
  if (problems.length > 0) return { ok: false, problems };
  return { ok: true, outcome, note };
}

// ---------------------------------------------------------------------------------------------
// The on-call route (H-539)

export const ROUTE_CHANNELS = ["push", "email", "sms", "in_app"] as const;
export type RouteChannel = (typeof ROUTE_CHANNELS)[number];
export const MAX_ROUTE_STEPS = 6;

/**
 * The staff roles Harbour ships that can see and acknowledge lone-worker alarms. The API checks
 * the organisation's own roles again and refuses one that cannot.
 */
export function routeRoleOptions(): { readonly key: string; readonly name: string }[] {
  return BUILTIN_ROLES.filter((role) =>
    role.permissions.includes(LONE_WORKER_PERMISSIONS.monitor),
  ).map((role) => ({ key: role.key, name: role.name }));
}

/** A step's target as one form value: "role:registered_manager" or "person:<id>". */
export function targetValue(
  step: Pick<LoneWorkerRouteStep, "targetRoleKey" | "targetTenantUserId">,
) {
  if (step.targetTenantUserId) return `person:${step.targetTenantUserId}`;
  if (step.targetRoleKey) return `role:${step.targetRoleKey}`;
  return "";
}

/**
 * Reads the route form's steps (`step-<n>-minutes`, `step-<n>-target`, `step-<n>-channel`), the
 * first `count` of them, and finds what the API would refuse in the web app's words: at least two
 * steps, the Registered Manager after step 1, each step reaching people away from the app.
 */
export function readRoute(
  form: FormLike,
  count: number,
  t: Translator,
): { ok: true; steps: LoneWorkerRouteStep[] } | { ok: false; problems: FieldProblem[] } {
  const problems: FieldProblem[] = [];
  const steps: LoneWorkerRouteStep[] = [];
  let previous = 0;
  for (let index = 0; index < count; index += 1) {
    const n = index + 1;
    const minutes = wholeNumber(text(form, `step-${n}-minutes`));
    if (minutes === null || minutes < 1 || minutes > 1440) {
      problems.push({
        field: `step-${n}-minutes`,
        message: t("scheduling.loneWorker.route.minutesRequired", { step: n }),
      });
    } else if (minutes <= previous) {
      problems.push({
        field: `step-${n}-minutes`,
        message: t("scheduling.loneWorker.route.minutesOrder", { step: n }),
      });
    }
    if (minutes !== null) previous = Math.max(previous, minutes);
    const target = text(form, `step-${n}-target`);
    const [kind, value] = [
      target.slice(0, target.indexOf(":")),
      target.slice(target.indexOf(":") + 1),
    ];
    if (!value || (kind !== "role" && kind !== "person")) {
      problems.push({
        field: `step-${n}-target`,
        message: t("scheduling.loneWorker.route.targetRequired", { step: n }),
      });
    }
    const channels = form
      .getAll(`step-${n}-channel`)
      .filter((c): c is RouteChannel => ROUTE_CHANNELS.includes(c as RouteChannel));
    if (!channels.some((c) => c !== "in_app")) {
      problems.push({
        field: `step-${n}-channel`,
        message: t("scheduling.loneWorker.route.channelRequired", { step: n }),
      });
    }
    steps.push({
      afterMinutes: minutes ?? 0,
      ...(kind === "role" && value ? { targetRoleKey: value } : {}),
      ...(kind === "person" && value ? { targetTenantUserId: value } : {}),
      channels,
    });
  }
  if (count < 2) {
    problems.push({ field: "step-1-target", message: t("scheduling.loneWorker.route.tooFew") });
  } else {
    const [first, ...later] = steps;
    if (first?.targetRoleKey === "registered_manager") {
      problems.push({
        field: "step-1-target",
        message: t("scheduling.loneWorker.route.managerFirst"),
      });
    }
    if (!later.some((s) => s.targetRoleKey === "registered_manager")) {
      problems.push({
        field: "step-2-target",
        message: t("scheduling.loneWorker.route.noManager"),
      });
    }
  }
  if (problems.length > 0) return { ok: false, problems };
  return { ok: true, steps };
}
