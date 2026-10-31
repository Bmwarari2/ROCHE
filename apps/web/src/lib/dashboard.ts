import type {
  BreakGlassWeeklyReportOut,
  HandoverSummary,
  IncidentSummary,
  LocationReviews,
  NotificationItem,
  OutageItem,
  RoundView,
  StatutoryNotificationSummary,
} from "@harbour/contracts";
import type { Translator } from "@harbour/i18n";
import {
  BREAK_GLASS_REPORT_PAGE,
  breakGlassReportShown,
  reportEntries,
} from "./break-glass-report";
import { downtimeNavShown } from "./downtime";
import { currentHandover, handoverShown } from "./handover";
import { INCIDENT_LIST_LIMIT, type SafetyChip } from "./incidents";
import { DOLS_REMINDER_KIND, roundShown } from "./round";
import { NOTIFICATION_LIST_LIMIT } from "./statutory-notifications";

/**
 * The role dashboards on the home page (docs/specs/insights.md; register row INSI-001). Pure and
 * unit tested. A tile appears only when the reader may open the list it links to (the same
 * helpers as the navigation), and says how many things wait there from the API's own states: no
 * scoring, ranking or prediction. A source that could not be read is a warning, never a zero.
 */

export type TileId =
  | "alerts"
  | "tasks"
  | "dols"
  | "handover"
  | "reviews"
  | "incidents"
  | "notifications"
  | "outages"
  | "breakGlass";

/** The fixed order of the tiles: today's work first, then safety and oversight. */
export const TILE_ORDER: readonly TileId[] = [
  "alerts",
  "tasks",
  "handover",
  "dols",
  "reviews",
  "incidents",
  "notifications",
  "outages",
  "breakGlass",
];

/** The tiles read per location. Past this many locations, the reader chooses one instead. */
export const PER_LOCATION_TILES: ReadonlySet<TileId> = new Set([
  "tasks",
  "dols",
  "handover",
  "reviews",
  "outages",
]);

/** The most locations read at once when the shell shows every location (the call budget). */
export const DASHBOARD_LOCATION_LIMIT = 3;

/** How often the dashboard is read again while it is open (insights.md rule 8). */
export const DASHBOARD_REFRESH_MS = 5 * 60_000;

/** The API's limit on one read of the reader's notifications (`GET /v1/notifications`). */
export const ALERT_LIST_LIMIT = 100;

const has = (permissions: readonly string[], permission: string) =>
  permissions.includes(permission);

/** Who may open each tile's list: the permission its page checks. */
const SHOWN: Record<TileId, (permissions: readonly string[]) => boolean> = {
  alerts: () => true,
  tasks: roundShown,
  dols: (p) => roundShown(p) && has(p, "care.dols.manage"),
  handover: handoverShown,
  reviews: (p) => has(p, "care.plan.read"),
  incidents: (p) => has(p, "safety.incident.read"),
  notifications: (p) => has(p, "safety.incident.manage"),
  outages: (p) => downtimeNavShown(p) && has(p, "people.person.read"),
  breakGlass: breakGlassReportShown,
};

/** The tiles the reader may see, in the fixed order. */
export function visibleTiles(permissions: readonly string[]): TileId[] {
  return TILE_ORDER.filter((id) => SHOWN[id](permissions));
}

/**
 * The locations the per-location tiles read: the chosen one, else every location the reader works
 * at up to the limit. Past the limit none are read and the tiles ask for a location.
 */
export function dashboardLocations(
  locations: readonly { readonly id: string }[],
  chosen: string | null,
): { readonly ids: string[]; readonly tooMany: boolean } {
  if (chosen) return { ids: [chosen], tooMany: false };
  if (locations.length > DASHBOARD_LOCATION_LIMIT) return { ids: [], tooMany: true };
  return { ids: locations.map((l) => l.id), tooMany: false };
}

// ------------------------------------------------------------------------------------------------
// Loads
// ------------------------------------------------------------------------------------------------

/** One API read: its data, a refusal for a missing permission, or any other failure. */
export type Load<T> =
  | { readonly kind: "ok"; readonly data: T }
  | { readonly kind: "forbidden" }
  | { readonly kind: "failed" };

export const ok = <T>(data: T): Load<T> => ({ kind: "ok", data });
export const FAILED: Load<never> = { kind: "failed" };
export const FORBIDDEN: Load<never> = { kind: "forbidden" };

interface Combined<T> {
  readonly data: T[];
  /** Some reads failed while others loaded. */
  readonly partial: boolean;
  /** Nothing loaded: hidden when every read was refused, else a failure. */
  readonly outcome: "ok" | "hidden" | "failed";
}

function combine<T>(loads: readonly Load<T>[]): Combined<T> {
  const data = loads.flatMap((l) => (l.kind === "ok" ? [l.data] : []));
  const failed = loads.some((l) => l.kind === "failed");
  if (loads.length > 0 && loads.every((l) => l.kind === "forbidden")) {
    return { data, partial: false, outcome: "hidden" };
  }
  if (data.length === 0) return { data, partial: false, outcome: "failed" };
  return { data, partial: failed, outcome: "ok" };
}

// ------------------------------------------------------------------------------------------------
// Summaries
// ------------------------------------------------------------------------------------------------

export type TileState = "clear" | "todo" | "overdue" | "urgent" | "notKnown" | "failed" | "choose";

export interface TileSummary {
  readonly id: TileId;
  readonly state: TileState;
  /** How many things wait; null when it could not be read or a location must be chosen. */
  readonly count: number | null;
  /** The part said apart: overdue, urgent, under way or under review, by tile. */
  readonly apart: number;
  /** Some of it could not be read, or a list reached the API's limit: the count is "at least". */
  readonly partial: boolean;
  readonly href: string;
  /** Handover only, for one location: whether the shift running now has a handover. */
  readonly current?: "compiled" | "notCompiled";
}

/** A summary from its counts: overdue or urgent first, then to do, else nothing waiting. */
function summary(
  id: TileId,
  href: string,
  counts: { count: number; apart: number; partial: boolean; late: "overdue" | "urgent" | null },
): TileSummary {
  // Nothing found in a partial read is never "nothing waiting": it may be in the part not read.
  const state: TileState =
    counts.late !== null
      ? counts.late
      : counts.count > 0
        ? "todo"
        : counts.partial
          ? "notKnown"
          : "clear";
  return { id, state, count: counts.count, apart: counts.apart, partial: counts.partial, href };
}

const failedTile = (id: TileId, href: string): TileSummary => ({
  id,
  state: "failed",
  count: null,
  apart: 0,
  partial: false,
  href,
});

/** A per-location tile when there are too many locations to read: choose one. */
export function chooseTile(id: TileId, href: string): TileSummary {
  return { id, state: "choose", count: null, apart: 0, partial: false, href };
}

/** The list page for a per-location tile: the location's own page, or the page that lists them. */
export function locationHref(base: "/round" | "/handover" | "/downtime", ids: readonly string[]) {
  return ids.length === 1 ? `${base}/${ids[0]}` : base;
}

/** Warning and urgent alerts not yet acknowledged; urgent ones said apart (HZ-008). */
export function alertsTile(load: Load<{ items: readonly NotificationItem[] }>): TileSummary | null {
  const href = "/notifications";
  const all = combine([load]);
  if (all.outcome === "hidden") return null;
  if (all.outcome === "failed") return failedTile("alerts", href);
  const items = all.data[0]?.items ?? [];
  const waiting = items.filter((n) => n.acknowledgedAt === null && n.severity !== "info");
  const urgent = waiting.filter((n) => n.severity !== "warning").length;
  return summary("alerts", href, {
    count: waiting.length,
    apart: urgent,
    partial: items.length >= ALERT_LIST_LIMIT,
    late: urgent > 0 ? "urgent" : null,
  });
}

type RoundTasks = Pick<RoundView, "areas" | "complete">;

/** Every other time state, overdue, escalated or one the web does not know, counts as late. */
const NOT_LATE_TASK: ReadonlySet<string> = new Set(["due", "upcoming"]);

/**
 * Tasks on the round due now or overdue, from each location's round view (the shift running now).
 * A time state the web does not know counts as overdue, so it warns.
 */
function roundTile(
  id: "tasks" | "dols",
  loads: readonly Load<RoundTasks>[],
  href: string,
  keep: (kind: string) => boolean,
): TileSummary | null {
  const all = combine(loads);
  if (all.outcome === "hidden") return null;
  if (all.outcome === "failed") return failedTile(id, href);
  let count = 0;
  let late = 0;
  for (const view of all.data) {
    for (const area of view.areas) {
      for (const stop of area.stops) {
        for (const task of stop.tasks) {
          if (!keep(task.kind) || task.timeState === "closed") continue;
          // The round's tasks still to come are not waiting yet; an open reminder is.
          if (task.timeState === "upcoming" && id === "tasks") continue;
          count += 1;
          if (!NOT_LATE_TASK.has(task.timeState)) late += 1;
        }
      }
    }
  }
  return summary(id, href, {
    count,
    apart: late,
    partial: all.partial || all.data.some((v) => !v.complete),
    late: late > 0 ? "overdue" : null,
  });
}

export function tasksTile(loads: readonly Load<RoundTasks>[], href: string) {
  return roundTile("tasks", loads, href, () => true);
}

/** DoLS expiry reminders still open (care.md rule 11; HZ-020), from the same round views. */
export function dolsTile(loads: readonly Load<RoundTasks>[], href: string) {
  return roundTile("dols", loads, href, (kind) => kind === DOLS_REMINDER_KIND);
}

/**
 * Handovers of the last week that the incoming shift has not acknowledged (the API's
 * `unacknowledged`, HZ-018), and for one location whether the shift running now has one.
 */
export function handoverTile(
  loads: readonly Load<{ items: readonly Pick<HandoverSummary, "shift" | "unacknowledged">[] }>[],
  href: string,
  now: Date = new Date(),
): TileSummary | null {
  const all = combine(loads);
  if (all.outcome === "hidden") return null;
  if (all.outcome === "failed") return failedTile("handover", href);
  const lists = all.data.map((d) => d.items);
  const unacknowledged = lists.flat().filter((h) => h.unacknowledged === true).length;
  const tile = summary("handover", href, {
    count: unacknowledged,
    apart: unacknowledged,
    partial: all.partial,
    late: unacknowledged > 0 ? "overdue" : null,
  });
  if (loads.length !== 1 || lists.length !== 1) return tile;
  return { ...tile, current: currentHandover(lists[0] ?? [], now) ? "compiled" : "notCompiled" };
}

/** Reviews due and overdue (people.md); a state the web does not know counts as overdue. */
export function reviewsTile(
  loads: readonly Load<Pick<LocationReviews, "items">>[],
): TileSummary | null {
  const href = "/people/reviews";
  const all = combine(loads);
  if (all.outcome === "hidden") return null;
  if (all.outcome === "failed") return failedTile("reviews", href);
  const items = all.data.flatMap((d) => d.items).filter((i) => i.state !== "upcoming");
  const late = items.filter((i) => i.state !== "due" && i.state !== "paused").length;
  return summary("reviews", href, {
    count: items.length,
    apart: late,
    partial: all.partial,
    late: late > 0 ? "overdue" : null,
  });
}

/** Incidents open or under review; under review said apart. */
export function incidentsTile(
  load: Load<{ items: readonly Pick<IncidentSummary, "status">[] }>,
): TileSummary | null {
  const href = "/incidents";
  const all = combine([load]);
  if (all.outcome === "hidden") return null;
  if (all.outcome === "failed") return failedTile("incidents", href);
  const items = all.data[0]?.items ?? [];
  const open = items.filter((i) => i.status !== "closed");
  return summary("incidents", href, {
    count: open.length,
    apart: open.filter((i) => i.status === "under_review").length,
    // Past the limit an older open incident may be cut off.
    partial: items.length >= INCIDENT_LIST_LIMIT,
    late: null,
  });
}

/**
 * Statutory notifications still to submit (draft and ready), with the overdue clocks said apart
 * (HZ-013). A clock the web does not know counts as overdue.
 */
export function notificationsTile(
  loads: readonly Load<{ items: readonly Pick<StatutoryNotificationSummary, "clock">[] }>[],
): TileSummary | null {
  const href = "/notifications/statutory";
  const all = combine(loads);
  if (all.outcome === "hidden") return null;
  // A notification missed is the hazard: any read failing is a failure, never a lower count.
  if (all.outcome === "failed" || all.partial) return failedTile("notifications", href);
  const todo = all.data.flatMap((d) => d.items).filter((n) => n.clock !== "done");
  const late = todo.filter((n) => n.clock !== "due").length;
  return summary("notifications", href, {
    count: todo.length,
    apart: late,
    partial: all.data.some((d) => d.items.length >= NOTIFICATION_LIST_LIMIT),
    late: late > 0 ? "overdue" : null,
  });
}

/** Outages under way (urgent) and closed ones still to reconcile (operations.md rules 9 to 15). */
export function outagesTile(
  loads: readonly Load<{ items: readonly Pick<OutageItem, "state">[] }>[],
  href: string,
): TileSummary | null {
  const all = combine(loads);
  if (all.outcome === "hidden") return null;
  if (all.outcome === "failed") return failedTile("outages", href);
  const items = all.data.flatMap((d) => d.items);
  const known = new Set(["declared", "closed", "reconciled", "cancelled"]);
  // A state the web does not know is said as under way, so it warns.
  const underWay = items.filter((o) => o.state === "declared" || !known.has(o.state)).length;
  const toReconcile = items.filter((o) => o.state === "closed").length;
  return summary("outages", href, {
    count: underWay + toReconcile,
    apart: underWay,
    partial: all.partial,
    late: underWay > 0 ? "urgent" : null,
  });
}

type Report = Pick<
  BreakGlassWeeklyReportOut,
  "id" | "locationId" | "supersedesId" | "reviewedAt" | "reviewedBy" | "actionsTaken"
>;

/** The last full week's break-glass reports not yet reviewed, at the chosen location if any. */
export function breakGlassTile(
  load: Load<{ items: readonly Report[] }>,
  locationId: string | null,
): TileSummary | null {
  const href = BREAK_GLASS_REPORT_PAGE;
  const all = combine([load]);
  if (all.outcome === "hidden") return null;
  if (all.outcome === "failed") return failedTile("breakGlass", href);
  const entries = reportEntries(all.data[0]?.items ?? []).filter(
    (e) => !locationId || e.report.locationId === locationId,
  );
  const toReview = entries.filter((e) => e.review === null).length;
  return summary("breakGlass", href, {
    count: toReview,
    apart: 0,
    partial: false,
    late: null,
  });
}

// ------------------------------------------------------------------------------------------------
// Words
// ------------------------------------------------------------------------------------------------

const STATE_CHIPS: Record<TileState, Omit<SafetyChip, "label">> = {
  clear: { status: "done", icon: "circle-check" },
  todo: { status: "due", icon: "clock" },
  overdue: { status: "overdue", icon: "circle-alert" },
  urgent: { status: "overdue", icon: "triangle-alert" },
  notKnown: { status: "due", icon: "triangle-alert" },
  failed: { status: "due", icon: "triangle-alert" },
  choose: { status: "neutral", icon: "search" },
};

/** The tile's state as an icon and a word; a state the web does not know warns. */
export function tileChips(tile: Pick<TileSummary, "state" | "partial">, t: Translator) {
  const known = STATE_CHIPS[tile.state];
  const chips: SafetyChip[] = [
    {
      ...(known ?? { status: "overdue", icon: "triangle-alert" }),
      label: t("dashboard.state", { state: known ? tile.state : "unknown" }),
    },
  ];
  if (tile.partial) {
    chips.push({ status: "due", icon: "triangle-alert", label: t("dashboard.partial") });
  }
  return chips;
}

/** The count in words ("2 tasks due or overdue"), or what to do instead when there is none. */
export function countLine(tile: TileSummary, t: Translator): string {
  if (tile.state === "failed") return t("dashboard.failed");
  if (tile.state === "choose") return t("dashboard.choose");
  return t(`dashboard.tile.${tile.id}.count`, {
    count: tile.count ?? 0,
    partial: tile.partial ? "yes" : "no",
  });
}

/** The part said apart ("1 of them overdue"), when there is one. */
export function apartLine(tile: TileSummary, t: Translator): string | null {
  const { id } = tile;
  // A handover not acknowledged is the count itself; a break-glass report has no part apart.
  if (tile.count === null || tile.apart === 0 || id === "breakGlass" || id === "handover") {
    return null;
  }
  return t(`dashboard.tile.${id}.apart`, { count: tile.apart });
}
