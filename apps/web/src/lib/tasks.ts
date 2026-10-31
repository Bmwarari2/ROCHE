import type { CreateTask, CreateTaskSeries, TaskItem } from "@harbour/contracts";
import type { Translator } from "@harbour/i18n";
import type { SafetyChip } from "./incidents";
import { type FormLike, readDateTimeField, type TimeProblem } from "./uk-time";

/**
 * The task lists (PLAT-011; platform.md, task and workflow engine): "My tasks" and "Team tasks",
 * what each task's state is called (an icon and a word, never colour alone), which tasks are
 * reviews raised by the engine (HZ-003, HZ-004, HZ-006), and reading the new task form. Pure and
 * unit tested; the API decides who may see and move each task.
 */

export const TASKS_PAGE = "/tasks";
export const TASK_MANAGE = "platform.task.manage";
/** The shortest reason the API takes for a task not done or cancelled (MIN_TASK_REASON_LENGTH). */
export const TASK_REASON_MIN = 3;
export const TASK_REASON_MAX = 500;
export const TASK_TITLE_MIN = 3;
export const TASK_TITLE_MAX = 120;

const DAY_MS = 86_400_000;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export type TaskView = "mine" | "team";
export type TaskStatusFilter = "open" | "closed";
export type TaskRange = "day" | "week";

export interface TasksQuery {
  readonly view: TaskView;
  readonly status: TaskStatusFilter;
  readonly range: TaskRange;
  /** Only the review tasks the engine raised. */
  readonly reviews: boolean;
}

type Query = Readonly<Record<string, string | string[] | undefined>>;

const one = (value: string | string[] | undefined) => (Array.isArray(value) ? value[0] : value);

/** The list the address asks for; anything it does not know falls back to "my open tasks". */
export function tasksQuery(query: Query): TasksQuery {
  return {
    view: one(query.view) === "team" ? "team" : "mine",
    status: one(query.status) === "closed" ? "closed" : "open",
    range: one(query.range) === "week" ? "week" : "day",
    reviews: one(query.reviews) === "yes",
  };
}

/** The address of a list, keeping what is not changed; defaults are left out. */
export function tasksHref(current: TasksQuery, change: Partial<TasksQuery> = {}): string {
  const next = { ...current, ...change };
  const params = new URLSearchParams();
  if (next.view === "team") params.set("view", "team");
  if (next.status === "closed") params.set("status", "closed");
  if (next.range === "week") params.set("range", "week");
  if (next.reviews) params.set("reviews", "yes");
  const qs = params.toString();
  return qs ? `${TASKS_PAGE}?${qs}` : TASKS_PAGE;
}

/** Due from yesterday to tomorrow, or over the last and next 7 days (the API takes 31 at most). */
export function taskWindow(range: TaskRange, now: Date): { from: string; to: string } {
  const days = range === "week" ? 7 : 1;
  return {
    from: new Date(now.getTime() - days * DAY_MS).toISOString(),
    to: new Date(now.getTime() + days * DAY_MS).toISOString(),
  };
}

/**
 * A review the engine raised for a person to look at: an entry that did not complete its round, a
 * late entry, a stale write, a missed review. Its kind ends in `_review` (care.entry_review,
 * people.late_entry_review) or names a review (`people.review.due`).
 */
export function isReviewTask(task: Pick<TaskItem, "kind">): boolean {
  return /(^|[._])review([._]|$)/.test(task.kind);
}

export function onlyReviews<T extends Pick<TaskItem, "kind">>(items: readonly T[]): T[] {
  return items.filter(isReviewTask);
}

export type TaskStateWord =
  | "upcoming"
  | "due"
  | "overdue"
  | "escalated"
  | "inProgress"
  | "done"
  | "skipped"
  | "cancelled";

/** Where a task stands, in one word: its status once finished, otherwise its time state. */
export function taskStateOf(task: Pick<TaskItem, "status" | "timeState">): TaskStateWord | null {
  switch (task.status) {
    case "done":
      return "done";
    case "skipped":
      return "skipped";
    case "cancelled":
      return "cancelled";
    default:
      break;
  }
  switch (task.timeState) {
    case "overdue":
      return "overdue";
    case "escalated":
      return "escalated";
    case "due":
      return task.status === "in_progress" ? "inProgress" : "due";
    case "upcoming":
      return task.status === "in_progress" ? "inProgress" : "upcoming";
    default:
      return null;
  }
}

const CHIPS: Record<TaskStateWord, Omit<SafetyChip, "label">> = {
  upcoming: { status: "neutral", icon: "clock" },
  due: { status: "due", icon: "clock" },
  inProgress: { status: "info", icon: "file-pen" },
  overdue: { status: "overdue", icon: "circle-alert" },
  escalated: { status: "overdue", icon: "triangle-alert" },
  done: { status: "done", icon: "circle-check" },
  skipped: { status: "notApplicable", icon: "circle-minus" },
  cancelled: { status: "notApplicable", icon: "circle-minus" },
};

/** The task's state as an icon and a word; a state the web does not know warns, never calm. */
export function taskChip(task: Pick<TaskItem, "status" | "timeState">, t: Translator): SafetyChip {
  const state = taskStateOf(task);
  if (!state)
    return {
      status: "overdue",
      icon: "circle-alert",
      label: t("tasks.state", { state: "unknown" }),
    };
  return { ...CHIPS[state], label: t("tasks.state", { state }) };
}

/** An open task can still be started, done, not done or cancelled. */
export function isOpen(task: Pick<TaskItem, "status">): boolean {
  return task.status === "open" || task.status === "in_progress";
}

/** Busiest first: escalated and overdue, then due, then by due time. */
export function sortTasks<T extends Pick<TaskItem, "status" | "timeState" | "dueAt">>(
  items: readonly T[],
): T[] {
  const rank = (task: T) => {
    const state = taskStateOf(task);
    if (state === "escalated") return 0;
    if (state === "overdue") return 1;
    if (state === "due" || state === "inProgress") return 2;
    if (state === "upcoming") return 3;
    return 4;
  };
  return [...items].sort((a, b) => rank(a) - rank(b) || Date.parse(a.dueAt) - Date.parse(b.dueAt));
}

const text = (form: FormLike, name: string) => {
  const value = form.get(name);
  return typeof value === "string" ? value.trim() : "";
};

/** A due time may be far ahead: a task is planned, unlike a care entry. */
const PLANNING_HORIZON_MINUTES = 2 * 366 * 24 * 60;

const WEEKDAYS = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"] as const;

export type Repeat = "none" | "daily" | "weekly";

export type NewTaskRead =
  | { readonly ok: true; readonly kind: "once"; readonly body: CreateTask }
  | { readonly ok: true; readonly kind: "series"; readonly body: CreateTaskSeries }
  | {
      readonly ok: false;
      readonly errors: Readonly<Record<string, string>>;
      readonly parts?: Readonly<Record<string, readonly string[]>>;
    };

/** The UK wall-clock date (yyyy-mm-dd) and time (HH:MM) of an instant. */
function ukWall(instant: string): { date: string; time: string; weekday: number } {
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone: "Europe/London",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
    weekday: "short",
  }).formatToParts(new Date(instant));
  const get = (type: string) => parts.find((p) => p.type === type)?.value ?? "";
  const date = `${get("year")}-${get("month")}-${get("day")}`;
  const weekday = new Date(`${date}T12:00:00Z`).getUTCDay();
  return { date, time: `${get("hour")}:${get("minute")}`, weekday };
}

/**
 * The new task form: a title, the due date and time (UK, 24-hour), urgent or routine, whether it
 * is the manager's own, and whether it repeats (every day or every week on that day, from the
 * due date, as a task series). Errors are said at their fields.
 */
export function readNewTask(
  form: FormLike,
  t: Translator,
  options: { readonly now?: Date; readonly selfId: string },
): NewTaskRead {
  const now = options.now ?? new Date();
  const errors: Record<string, string> = {};
  const parts: Record<string, readonly string[]> = {};
  const title = text(form, "title");
  if (title.length < TASK_TITLE_MIN || title.length > TASK_TITLE_MAX) {
    errors.title = t("tasks.new.titleError", { min: TASK_TITLE_MIN, max: TASK_TITLE_MAX });
  }
  const due = readDateTimeField(form, "dueAt", {
    subject: t("tasks.new.dueSubject"),
    t,
    now,
    futureToleranceMinutes: PLANNING_HORIZON_MINUTES,
  });
  let dueAt: string | null = null;
  if (!due.ok) {
    const problem = due as TimeProblem;
    errors.dueAt = problem.message;
    parts.dueAt = problem.parts;
  } else {
    dueAt = due.instant;
  }
  const repeatValue = text(form, "repeat");
  const repeat: Repeat = repeatValue === "daily" || repeatValue === "weekly" ? repeatValue : "none";
  if (Object.keys(errors).length > 0 || !dueAt) {
    return { ok: false, errors, ...(Object.keys(parts).length > 0 ? { parts } : {}) };
  }
  const priority = text(form, "urgent") === "yes" ? "urgent" : "routine";
  const mine = text(form, "assignToMe") === "yes";
  const locationId = text(form, "locationId");
  const assignee = {
    ...(mine ? { assigneeTenantUserId: options.selfId } : {}),
    ...(UUID.test(locationId) ? { locationId } : {}),
  };
  if (repeat === "none") {
    if (Date.parse(dueAt) < now.getTime() - 60_000) {
      return {
        ok: false,
        errors: { dueAt: t("tasks.new.dueInPast") },
        parts: { dueAt: ["day", "month", "year", "hour", "minute"] },
      };
    }
    return { ok: true, kind: "once", body: { title, dueAt, priority, ...assignee } };
  }
  const wall = ukWall(dueAt);
  const times = [wall.time];
  const recurrence =
    repeat === "daily"
      ? { freq: "daily" as const, times }
      : { freq: "weekly" as const, weekdays: [WEEKDAYS[wall.weekday] ?? "mon"], times };
  return {
    ok: true,
    kind: "series",
    body: {
      title,
      recurrence,
      startsOn: wall.date,
      windowBeforeMinutes: 0,
      windowAfterMinutes: 0,
      priority,
      evidenceRequired: false,
      ...assignee,
    },
  };
}

/** A reason for a task not done or cancelled: 3 to 500 characters, said at the field. */
export function readTaskReason(
  form: FormLike,
  t: Translator,
  purpose: "skip" | "cancel",
): { ok: true; reason: string } | { ok: false; errors: Record<string, string> } {
  const reason = text(form, "reason");
  if (reason.length < TASK_REASON_MIN || reason.length > TASK_REASON_MAX) {
    return { ok: false, errors: { reason: t("tasks.reason.error", { purpose }) } };
  }
  return { ok: true, reason };
}
