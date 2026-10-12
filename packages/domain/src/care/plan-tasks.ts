import type { Recurrence } from "../platform/tasks";
import {
  actionsDrivingTasks,
  type CarePlanStatus,
  PCSP_DOMAIN_LABELS,
  type PcspDomain,
  planActionGeneratesTasks,
} from "./care-plan";

/**
 * Care plan actions generate the shift's tasks (care.md rule 14; master prompt 10.1 "care plan
 * actions generate scheduled tasks per shift"; register row CARE-013). Each task-generating action
 * of the person's active plan drives one task series in the task engine
 * (`packages/domain/src/platform/tasks.ts`): the engine materialises the rounds, the round view
 * lists them, and an overdue round escalates once. These rules decide which series a plan needs,
 * which a new version carries forward, and the window each round has. Pure functions; no I/O.
 */

/** The task kind of every round a care plan action generates. */
export const PLAN_ACTION_TASK_KIND = "care.plan_action";
/** Series and tasks point at the action that drives them (`source_type`, `source_id`). */
export const PLAN_ACTION_SOURCE_TYPE = "care_plan_action";
/**
 * Who may complete a care plan round: anyone who writes the person's care record there, like any
 * task about a person (the role on the action says who usually does it).
 */
export const PLAN_ACTION_TASK_PERMISSION = "care.note.write";

/** Rate-table keys for the window around each round's time (tenant defaults, H-150). */
export const CARE_PLAN_TASK_RATE_KEYS = {
  windowBeforeMinutes: "care_plan.task_window_before_minutes",
  windowAfterMinutes: "care_plan.task_window_after_minutes",
} as const;

/**
 * A round's title names the need it serves, never the person or the action's own words (task
 * titles are generic and reach notifications); the round view shows the action from the plan.
 */
export function planActionTaskTitle(domain: PcspDomain): string {
  return `Care plan: ${PCSP_DOMAIN_LABELS[domain].toLowerCase()}`;
}

// ------------------------------------------------------------------------------------------------
// The window around each round
// ------------------------------------------------------------------------------------------------

const MINUTES_IN_DAY = 24 * 60;
/** 01:00 UK time, when the clocks change. */
const CLOCK_CHANGE_MINUTE = 60;

function minuteOfDay(time: string): number {
  const [h, m] = time.split(":").map(Number);
  return (h ?? 0) * 60 + (m ?? 0);
}

/** Whether a stretch of wall-clock minutes (from `a`, to `b`) passes 01:00 on some day. */
function spansClockChange(a: number, b: number): boolean {
  return (
    Math.floor((b - CLOCK_CHANGE_MINUTE) / MINUTES_IN_DAY) >
    Math.floor((a - CLOCK_CHANGE_MINUTE) / MINUTES_IN_DAY)
  );
}

/**
 * The shortest time between two rounds of a schedule, in minutes. Clock-time schedules are laid out
 * over one cycle (a day, the weeks of a weekly rule, or the shortest month) and any gap that passes
 * 01:00 counts an hour less, since on the night the clocks go forward it is (HZ-009). Hourly
 * schedules count real hours, so a clock change never moves them.
 */
export function shortestGapMinutes(rule: Recurrence): number {
  if (rule.freq === "every_hours") return rule.hours * 60;
  const interval = rule.interval ?? 1;
  const times = [...new Set(rule.times.map(minuteOfDay))].sort((a, b) => a - b);
  let starts: number[];
  let cycle: number;
  if (rule.freq === "daily") {
    starts = times;
    cycle = interval * MINUTES_IN_DAY;
  } else if (rule.freq === "weekly") {
    const order = ["mon", "tue", "wed", "thu", "fri", "sat", "sun"];
    const days = [...new Set(rule.weekdays.map((d) => order.indexOf(d)))].sort((a, b) => a - b);
    starts = days.flatMap((d) => times.map((t) => d * MINUTES_IN_DAY + t));
    cycle = interval * 7 * MINUTES_IN_DAY;
  } else {
    starts = times;
    // The shortest month: the 31st falls on the 28th in February.
    cycle = interval * 28 * MINUTES_IN_DAY;
  }
  const first = starts[0] ?? 0;
  const points = [...starts, first + cycle];
  let shortest = Number.POSITIVE_INFINITY;
  for (let i = 1; i < points.length; i++) {
    const a = points[i - 1] as number;
    const b = points[i] as number;
    const gap = b - a - (spansClockChange(a, b) ? 60 : 0);
    shortest = Math.min(shortest, gap);
  }
  return Math.max(0, shortest);
}

export interface TaskWindow {
  readonly beforeMinutes: number;
  readonly afterMinutes: number;
}

/**
 * The window each round of an action has: the tenant's defaults, cut where rounds come closer
 * together than the window is long, so no instant is inside two rounds' windows, even on a
 * clock-change night. An entry then answers one round only, and a round is never shown twice as
 * due at once (HZ-004). The time after a round is cut first, then the time before.
 */
export function planActionTaskWindow(rule: Recurrence, defaults: TaskWindow): TaskWindow {
  const gap = shortestGapMinutes(rule);
  if (defaults.beforeMinutes + defaults.afterMinutes < gap) return defaults;
  const afterMinutes = Math.max(0, Math.min(defaults.afterMinutes, Math.floor((gap - 1) / 2)));
  const beforeMinutes = Math.max(0, Math.min(defaults.beforeMinutes, gap - 1 - afterMinutes));
  return { beforeMinutes, afterMinutes };
}

// ------------------------------------------------------------------------------------------------
// Which series a plan needs
// ------------------------------------------------------------------------------------------------

export interface PlanTaskAction {
  readonly id: string;
  /** The action of the earlier version this one was copied from, when the draft was copied. */
  readonly basedOnActionId: string | null;
  readonly domain: PcspDomain;
  readonly generatesTasks: boolean;
  readonly recurrence: Recurrence | null;
  readonly roleKey: string | null;
  readonly evidenceRequired: boolean;
}

/** A series a care plan action created, as it stands now. */
export interface PlanTaskSeries {
  readonly id: string;
  /** The action it belongs to (its source). */
  readonly actionId: string;
  readonly active: boolean;
  /**
   * Stopped by the people lifecycle (paused while away, or ended at an exit with a stop code): it
   * still belongs to its action, and the return or the correction brings it back (people.md).
   */
  readonly lifecycleStopped: boolean;
  readonly title: string;
  readonly recurrence: Recurrence;
  readonly roleKey: string | null;
  readonly evidenceRequired: boolean;
}

export interface PlanTaskSeriesChanges {
  /** Actions already driving a series. */
  readonly keep: readonly { readonly actionId: string; readonly seriesId: string }[];
  /** Unchanged actions of a new version that take over the series of the action they copy. */
  readonly adopt: readonly { readonly actionId: string; readonly seriesId: string }[];
  /** Actions that need a new series. */
  readonly create: readonly string[];
  /** Series no action of the active plan drives any more: they end, with their future rounds. */
  readonly end: readonly string[];
  /** Task-generating actions that never generate tasks, with why. */
  readonly notGenerated: readonly {
    readonly actionId: string;
    readonly reason: "medicines_domain";
  }[];
}

const WEEKDAY_ORDER = ["mon", "tue", "wed", "thu", "fri", "sat", "sun"];

/** A recurrence in one canonical form: sorted times and days, the interval written out. */
function canonical(rule: Recurrence): string {
  if (rule.freq === "every_hours") {
    return JSON.stringify({ freq: rule.freq, hours: rule.hours, anchorTime: rule.anchorTime });
  }
  const times = [...new Set(rule.times)].sort();
  const interval = rule.interval ?? 1;
  if (rule.freq === "daily") return JSON.stringify({ freq: rule.freq, interval, times });
  if (rule.freq === "weekly") {
    const weekdays = [...new Set(rule.weekdays)].sort(
      (a, b) => WEEKDAY_ORDER.indexOf(a) - WEEKDAY_ORDER.indexOf(b),
    );
    return JSON.stringify({ freq: rule.freq, interval, weekdays, times });
  }
  return JSON.stringify({ freq: rule.freq, interval, dayOfMonth: rule.dayOfMonth, times });
}

/**
 * Whether a series already makes the rounds an action asks for: the same need (its title), the
 * same schedule, the same role and the same need for evidence. Only then does a new version carry
 * the series forward; anything else ends it and starts a new one.
 */
export function sameTaskSchedule(series: PlanTaskSeries, action: PlanTaskAction): boolean {
  return (
    action.recurrence !== null &&
    series.title === planActionTaskTitle(action.domain) &&
    canonical(series.recurrence) === canonical(action.recurrence) &&
    series.roleKey === action.roleKey &&
    series.evidenceRequired === action.evidenceRequired
  );
}

/**
 * The series a person's care plan needs (care.md rule 14; HZ-024, HZ-003, HZ-004). Only the active
 * plan's task-generating actions drive tasks, and never one in a domain without plan tasks. An
 * action already driving a series keeps it (so generating again changes nothing). An action copied
 * unchanged from the previous version takes over that action's series, so its rounds are neither
 * cancelled nor made twice; a series the people lifecycle stopped stays with its action and is never
 * replaced by a second one. Every other live series ends: its action was changed, dropped or no
 * longer generates tasks, or no plan is active. Series already ended are ignored.
 */
export function planActionTaskSeries(
  plan: { readonly status: CarePlanStatus; readonly actions: readonly PlanTaskAction[] },
  series: readonly PlanTaskSeries[],
): PlanTaskSeriesChanges {
  const live = series.filter((s) => s.active || s.lifecycleStopped);
  const byAction = new Map<string, PlanTaskSeries>();
  for (const s of live) if (!byAction.has(s.actionId)) byAction.set(s.actionId, s);
  const claimed = new Set<string>();
  const keep: { actionId: string; seriesId: string }[] = [];
  const adopt: { actionId: string; seriesId: string }[] = [];
  const create: string[] = [];
  const notGenerated: { actionId: string; reason: "medicines_domain" }[] = [];

  const driving = actionsDrivingTasks(plan).filter((a) => a.recurrence !== null);
  for (const a of driving) {
    if (!planActionGeneratesTasks(a.domain)) {
      notGenerated.push({ actionId: a.id, reason: "medicines_domain" });
      continue;
    }
    const own = byAction.get(a.id);
    if (own && !claimed.has(own.id)) {
      claimed.add(own.id);
      keep.push({ actionId: a.id, seriesId: own.id });
      continue;
    }
    const earlier = a.basedOnActionId ? byAction.get(a.basedOnActionId) : undefined;
    if (earlier && !claimed.has(earlier.id) && sameTaskSchedule(earlier, a)) {
      claimed.add(earlier.id);
      adopt.push({ actionId: a.id, seriesId: earlier.id });
      continue;
    }
    create.push(a.id);
  }
  const end = live.filter((s) => !claimed.has(s.id)).map((s) => s.id);
  return { keep, adopt, create, end, notGenerated };
}
