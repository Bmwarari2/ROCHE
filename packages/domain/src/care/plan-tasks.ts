import { occurrences, type Recurrence, type RecurrenceSeries } from "../platform/tasks";
import {
  actionsDrivingTasks,
  type CarePlanStatus,
  MIN_ROUND_GAP_MINUTES,
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
 * which a new version carries forward, and the window each round has (from the real instants of
 * its neighbours). Pure functions; no I/O.
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

export interface TaskWindow {
  readonly beforeMinutes: number;
  readonly afterMinutes: number;
}

/** One round: when it is due and the window in which doing it counts as on time. */
export interface RoundTime {
  readonly dueAt: Date;
  readonly windowStart: Date;
  readonly windowEnd: Date;
}

const MINUTE = 60_000;

/**
 * How the real time between two consecutive rounds is shared between them: the earlier round's
 * time after and the later round's time before together stay a minute short of the gap, so no
 * instant is inside both windows; each side is capped by the tenant's figure.
 */
function shareGap(gapMinutes: number, caps: TaskWindow) {
  const after = Math.min(caps.afterMinutes, Math.floor((gapMinutes - 1) / 2));
  const before = Math.min(caps.beforeMinutes, gapMinutes - 1 - after);
  return { after, before };
}

/**
 * The rounds of a care plan action in [from, to), each with its window (care.md rule 14; HZ-004,
 * HZ-008, HZ-009). Windows come from the real instants of consecutive rounds, never from the clock
 * face, so a clock change cannot make two windows meet: each round may be done from
 * `caps.beforeMinutes` before its time until `caps.afterMinutes` after, cut where its neighbours
 * are closer, never to nothing. Rounds closer than `MIN_ROUND_GAP_MINUTES` are merged into the
 * first of them. Neighbours just outside [from, to) are read too, so the windows do not depend on
 * when the rounds were made.
 */
export function roundTimes(
  series: RecurrenceSeries,
  from: Date,
  to: Date,
  caps: TaskWindow,
): RoundTime[] {
  // A neighbour further away than twice the larger figure never cuts a window.
  const pad =
    (2 * Math.max(caps.beforeMinutes, caps.afterMinutes) + MIN_ROUND_GAP_MINUTES + 1) * MINUTE;
  const raw = occurrences(series, new Date(from.getTime() - pad), new Date(to.getTime() + pad)).map(
    (d) => d.getTime(),
  );
  raw.sort((a, b) => a - b);
  const instants: number[] = [];
  for (const t of raw) {
    const last = instants.at(-1);
    if (last !== undefined && t - last < MIN_ROUND_GAP_MINUTES * MINUTE) continue;
    instants.push(t);
  }
  const rounds: RoundTime[] = [];
  instants.forEach((t, i) => {
    if (t < from.getTime() || t >= to.getTime()) return;
    const prev = instants[i - 1];
    const next = instants[i + 1];
    const before =
      prev === undefined ? caps.beforeMinutes : shareGap((t - prev) / MINUTE, caps).before;
    const after =
      next === undefined ? caps.afterMinutes : shareGap((next - t) / MINUTE, caps).after;
    rounds.push({
      dueAt: new Date(t),
      windowStart: new Date(t - before * MINUTE),
      windowEnd: new Date(t + after * MINUTE),
    });
  });
  return rounds;
}

// ------------------------------------------------------------------------------------------------
// What a round and a plan action say about themselves
// ------------------------------------------------------------------------------------------------

/**
 * Shown on a round whose action is no longer in the active plan: an overdue round of a schedule
 * the plan has since changed or dropped stays open to be done, so it must not read as current
 * (HZ-024).
 */
export const EARLIER_PLAN_NOTICE = "From an earlier plan: check the current plan";

/**
 * Shown on a medicines action, in the plan and on the round, until the eMAR makes the dose rounds
 * (HZ-003, H-151).
 */
export const NOT_A_ROUND_NOTICE = "Not a round: see the medicines record";

/** The notice a care plan round carries: none while its action is in the active plan. */
export function planRoundNotice(input: {
  readonly planStatus: CarePlanStatus;
  readonly seriesLive: boolean;
}): string | null {
  return input.planStatus === "active" && input.seriesLive ? null : EARLIER_PLAN_NOTICE;
}

/** The notice a plan action carries: medicines actions are never rounds. */
export function planActionNotice(domain: PcspDomain): string | null {
  return planActionGeneratesTasks(domain) ? null : NOT_A_ROUND_NOTICE;
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
