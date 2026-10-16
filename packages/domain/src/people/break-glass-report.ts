import { addUkDays, fromUkWallClock, toUkWallClock } from "../shared/time";

/**
 * Weekly break-glass report (master prompt section 4; platform.md PLAT-006; people.md section 4
 * rule 14; hazard HZ-011). A pure aggregation of the week's break-glass events for the Registered
 * Manager and the data protection lead: totals, by user, by person and by reason, with repeated use
 * flagged and unreviewed openings listed. The week runs Monday 00:00 to Monday 00:00 UK time, so a
 * clock change never moves an event into the wrong week. The repeat threshold comes from the rate
 * table (`break_glass.weekly_repeat_threshold`). The report holds ids and counts; the screen looks
 * up names, and the justification text is shown only to holders of `platform.audit.read`.
 */

export const BREAK_GLASS_REASON_CODES = [
  "emergency_care",
  "covering_another_area",
  "safeguarding",
  "incident_or_complaint",
  "request_from_professional",
  "other",
] as const;
export type BreakGlassReasonCode = (typeof BREAK_GLASS_REASON_CODES)[number];

export interface BreakGlassEventView {
  readonly id: string;
  readonly tenantUserId: string;
  readonly personId: string;
  readonly reasonCode: BreakGlassReasonCode | null;
  readonly openedAt: Date;
  readonly reviewedAt: Date | null;
}

/**
 * A break-glass search (platform-completions.md rule 9): it names no one person, so it is reported
 * by the searcher and by reason, in the report of each home whose people it showed (the service
 * also puts a search that showed no one in every home's report, so none goes unreported).
 */
export interface BreakGlassSearchView {
  readonly id: string;
  readonly tenantUserId: string;
  readonly reasonCode: BreakGlassReasonCode | null;
  readonly openedAt: Date;
}

export interface BreakGlassSearchUserLine {
  readonly tenantUserId: string;
  readonly searches: number;
  /** `repeated_use` when the user searched at least the threshold number of times. */
  readonly flags: readonly BreakGlassFlag[];
  readonly eventIds: readonly string[];
}

export interface BreakGlassSearchSection {
  readonly total: number;
  readonly distinctUsers: number;
  readonly byUser: readonly BreakGlassSearchUserLine[];
  readonly byReason: readonly BreakGlassReasonLine[];
}

export interface BreakGlassWeek {
  readonly start: Date;
  readonly end: Date;
}

/** The UK week (Monday 00:00 to the next Monday 00:00) containing an instant. */
export function breakGlassReportWeek(at: Date): BreakGlassWeek {
  const w = toUkWallClock(at);
  const weekday = new Date(Date.UTC(w.year, w.month - 1, w.day)).getUTCDay();
  const daysSinceMonday = (weekday + 6) % 7;
  const midnight = fromUkWallClock(w.year, w.month, w.day, 0, 0);
  const start = addUkDays(midnight, -daysSinceMonday);
  return { start, end: addUkDays(start, 7) };
}

/** The last complete week before `now`, which the Monday report covers. */
export function previousBreakGlassReportWeek(now: Date): BreakGlassWeek {
  const current = breakGlassReportWeek(now);
  return { start: addUkDays(current.start, -7), end: current.start };
}

export type BreakGlassFlag =
  /** One user opened records outside their scope at least the threshold number of times. */
  | "repeated_use"
  /** One user opened the same person's record more than once: their scope may need changing. */
  | "same_person_repeatedly"
  /** At least the threshold number of different users opened one person's record. */
  | "opened_by_many";

export interface BreakGlassUserLine {
  readonly tenantUserId: string;
  readonly events: number;
  readonly people: number;
  readonly unreviewed: number;
  readonly flags: readonly BreakGlassFlag[];
  readonly eventIds: readonly string[];
}

export interface BreakGlassPersonLine {
  readonly personId: string;
  readonly events: number;
  readonly users: number;
  readonly flags: readonly BreakGlassFlag[];
  readonly eventIds: readonly string[];
}

export interface BreakGlassReasonLine {
  readonly reason: BreakGlassReasonCode | "not_categorised";
  readonly events: number;
}

export interface BreakGlassFlagLine {
  readonly flag: BreakGlassFlag;
  readonly tenantUserId: string | null;
  readonly personId: string | null;
  readonly count: number;
  readonly eventIds: readonly string[];
}

export interface BreakGlassWeeklyReport {
  readonly week: BreakGlassWeek;
  readonly totalEvents: number;
  readonly distinctUsers: number;
  readonly distinctPeople: number;
  readonly unreviewedEventIds: readonly string[];
  readonly byUser: readonly BreakGlassUserLine[];
  readonly byPerson: readonly BreakGlassPersonLine[];
  readonly byReason: readonly BreakGlassReasonLine[];
  readonly flagged: readonly BreakGlassFlagLine[];
  /** Break-glass searches in the week (master prompt section 4: break-glass is reported weekly). */
  readonly searches: BreakGlassSearchSection;
}

function group<T>(items: readonly T[], key: (item: T) => string): Map<string, T[]> {
  const map = new Map<string, T[]>();
  for (const item of items) {
    const k = key(item);
    const list = map.get(k);
    if (list) list.push(item);
    else map.set(k, [item]);
  }
  return map;
}

const byCountThenId =
  <T extends { readonly events: number }>(id: (line: T) => string) =>
  (a: T, b: T) =>
    b.events - a.events || id(a).localeCompare(id(b));

/**
 * Aggregates one week's break-glass events. `repeatThreshold` is the rate-table figure
 * `break_glass.weekly_repeat_threshold`; events outside the week are ignored.
 */
export function breakGlassWeeklyReport(
  events: readonly BreakGlassEventView[],
  week: BreakGlassWeek,
  repeatThreshold: number,
  searches: readonly BreakGlassSearchView[] = [],
): BreakGlassWeeklyReport {
  if (!Number.isInteger(repeatThreshold) || repeatThreshold < 2) {
    throw new RangeError("The repeat threshold must be a whole number of 2 or more.");
  }
  const inWeek = events
    .filter(
      (e) =>
        e.openedAt.getTime() >= week.start.getTime() && e.openedAt.getTime() < week.end.getTime(),
    )
    .sort((a, b) => a.openedAt.getTime() - b.openedAt.getTime() || a.id.localeCompare(b.id));
  const flagged: BreakGlassFlagLine[] = [];
  const ids = (list: readonly BreakGlassEventView[]) => list.map((e) => e.id);

  const byUser: BreakGlassUserLine[] = [...group(inWeek, (e) => e.tenantUserId)].map(
    ([tenantUserId, list]) => {
      const flags: BreakGlassFlag[] = [];
      if (list.length >= repeatThreshold) {
        flags.push("repeated_use");
        flagged.push({
          flag: "repeated_use",
          tenantUserId,
          personId: null,
          count: list.length,
          eventIds: ids(list),
        });
      }
      for (const [personId, pair] of group(list, (e) => e.personId)) {
        if (pair.length > 1) {
          if (!flags.includes("same_person_repeatedly")) flags.push("same_person_repeatedly");
          flagged.push({
            flag: "same_person_repeatedly",
            tenantUserId,
            personId,
            count: pair.length,
            eventIds: ids(pair),
          });
        }
      }
      return {
        tenantUserId,
        events: list.length,
        people: new Set(list.map((e) => e.personId)).size,
        unreviewed: list.filter((e) => e.reviewedAt === null).length,
        flags,
        eventIds: ids(list),
      };
    },
  );

  const byPerson: BreakGlassPersonLine[] = [...group(inWeek, (e) => e.personId)].map(
    ([personId, list]) => {
      const users = new Set(list.map((e) => e.tenantUserId)).size;
      const flags: BreakGlassFlag[] = [];
      if (users >= repeatThreshold) {
        flags.push("opened_by_many");
        flagged.push({
          flag: "opened_by_many",
          tenantUserId: null,
          personId,
          count: users,
          eventIds: ids(list),
        });
      }
      return { personId, events: list.length, users, flags, eventIds: ids(list) };
    },
  );

  const byReason: BreakGlassReasonLine[] = [
    ...group(inWeek, (e) => e.reasonCode ?? "not_categorised"),
  ]
    .map(([reason, list]) => ({
      reason: reason as BreakGlassReasonLine["reason"],
      events: list.length,
    }))
    .sort(byCountThenId((l) => l.reason));

  const flagOrder: readonly BreakGlassFlag[] = [
    "repeated_use",
    "same_person_repeatedly",
    "opened_by_many",
  ];
  flagged.sort(
    (a, b) =>
      flagOrder.indexOf(a.flag) - flagOrder.indexOf(b.flag) ||
      b.count - a.count ||
      `${a.tenantUserId ?? ""}${a.personId ?? ""}`.localeCompare(
        `${b.tenantUserId ?? ""}${b.personId ?? ""}`,
      ),
  );

  return {
    week,
    totalEvents: inWeek.length,
    distinctUsers: byUser.length,
    distinctPeople: byPerson.length,
    unreviewedEventIds: inWeek.filter((e) => e.reviewedAt === null).map((e) => e.id),
    byUser: byUser.sort(byCountThenId((l) => l.tenantUserId)),
    byPerson: byPerson.sort(byCountThenId((l) => l.personId)),
    byReason,
    flagged,
    searches: searchSection(searches, week, repeatThreshold),
  };
}

function searchSection(
  searches: readonly BreakGlassSearchView[],
  week: BreakGlassWeek,
  repeatThreshold: number,
): BreakGlassSearchSection {
  const inWeek = searches
    .filter(
      (e) =>
        e.openedAt.getTime() >= week.start.getTime() && e.openedAt.getTime() < week.end.getTime(),
    )
    .sort((a, b) => a.openedAt.getTime() - b.openedAt.getTime() || a.id.localeCompare(b.id));
  const byUser: BreakGlassSearchUserLine[] = [...group(inWeek, (e) => e.tenantUserId)]
    .map(([tenantUserId, list]) => ({
      tenantUserId,
      searches: list.length,
      flags: list.length >= repeatThreshold ? (["repeated_use"] as const) : [],
      eventIds: list.map((e) => e.id),
    }))
    .sort((a, b) => b.searches - a.searches || a.tenantUserId.localeCompare(b.tenantUserId));
  const byReason: BreakGlassReasonLine[] = [
    ...group(inWeek, (e) => e.reasonCode ?? "not_categorised"),
  ]
    .map(([reason, list]) => ({
      reason: reason as BreakGlassReasonLine["reason"],
      events: list.length,
    }))
    .sort(byCountThenId((l) => l.reason));
  return { total: inWeek.length, distinctUsers: byUser.length, byUser, byReason };
}
