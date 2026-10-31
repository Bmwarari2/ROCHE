import type { BreakGlassWeeklyReportOut, StaffName } from "@harbour/contracts";
import type { Translator } from "@harbour/i18n";
import type { SafetyChip } from "./incidents";
import { staffName } from "./mca";
import type { Problem } from "./outcome";
import { addDays, isIsoDate, ukToday } from "./uk-time";

/**
 * The weekly break-glass report screens (platform.md PLAT-006; people.md rule 14; hazard HZ-011):
 * pure and unit tested. The API stores one report per location and UK week (Monday to Monday),
 * holding counts and opaque ids only; a review is a later row that supersedes it. These helpers
 * read the stored summary defensively (a field the web does not know never reads as calm), pair
 * each report with its review, and name the staff and people it counts: staff from the names the
 * API returns with the report, people from the reader's own list, the others numbered. The API
 * checks the permission, the reader's locations and separation of duties again.
 */

export const BREAK_GLASS_REPORT_PAGE = "/break-glass/weekly-report";
/** Reading and reviewing the reports: the audit reader's permission (the API's). */
export const BREAK_GLASS_REPORT_PERMISSION = "platform.audit.read";
/** The shortest and longest "actions taken" the API takes (`ReviewBreakGlassReport`). */
export const ACTIONS_MIN = 3;
export const ACTIONS_MAX = 2000;

export function breakGlassReportShown(permissions: readonly string[]): boolean {
  return permissions.includes(BREAK_GLASS_REPORT_PERMISSION);
}

// ------------------------------------------------------------------------------------------------
// Weeks
// ------------------------------------------------------------------------------------------------

/** The `week` from a page's address when it is a real date (yyyy-mm-dd), else null. */
export function weekParam(value: string | string[] | undefined): string | null {
  return typeof value === "string" && isIsoDate(value) ? value : null;
}

export interface ReportWeek {
  /** The Monday the week starts, as yyyy-mm-dd (UK). */
  readonly monday: string;
  /** The Sunday it ends, as yyyy-mm-dd (UK). */
  readonly sunday: string;
  /** The week before, for its address. */
  readonly previous: string;
  /** The week after, when its report can exist yet (it has ended), else null. */
  readonly next: string | null;
}

/**
 * The week the API answered for, in UK dates. The week runs Monday 00:00 to Monday 00:00 UK time,
 * so the start's UK date is the Monday whatever the clocks did. The next week is offered only once
 * it has ended, since the report is built after its week.
 */
export function reportWeek(
  list: { readonly weekStart: string; readonly weekEnd: string },
  now: Date = new Date(),
): ReportWeek {
  const monday = ukToday(new Date(list.weekStart));
  const nextMonday = ukToday(new Date(list.weekEnd));
  const nextEnds = addDays(nextMonday, 7);
  return {
    monday,
    sunday: addDays(nextMonday, -1),
    previous: addDays(monday, -7),
    next: nextEnds <= ukToday(now) ? nextMonday : null,
  };
}

export function listHref(week: string | null): string {
  return week ? `${BREAK_GLASS_REPORT_PAGE}?week=${week}` : BREAK_GLASS_REPORT_PAGE;
}

export function reportHref(reportId: string, week: string): string {
  return `${BREAK_GLASS_REPORT_PAGE}/${reportId}?week=${week}`;
}

// ------------------------------------------------------------------------------------------------
// The stored summary
// ------------------------------------------------------------------------------------------------

export const REASONS = [
  "emergency_care",
  "covering_another_area",
  "safeguarding",
  "incident_or_complaint",
  "request_from_professional",
  "other",
  "not_categorised",
] as const;
export type ReportReason = (typeof REASONS)[number] | "unknown";

export const FLAGS = ["repeated_use", "same_person_repeatedly", "opened_by_many"] as const;
export type ReportFlag = (typeof FLAGS)[number] | "unknown";

export interface UserLine {
  readonly tenantUserId: string;
  readonly events: number;
  readonly people: number;
  readonly unreviewed: number;
  readonly flags: readonly ReportFlag[];
}

export interface PersonLine {
  readonly personId: string;
  readonly events: number;
  readonly users: number;
  readonly flags: readonly ReportFlag[];
}

export interface ReasonLine {
  readonly reason: ReportReason;
  readonly events: number;
}

export interface FlagLine {
  readonly flag: ReportFlag;
  readonly tenantUserId: string | null;
  readonly personId: string | null;
  readonly count: number;
}

export interface SearchUserLine {
  readonly tenantUserId: string;
  readonly searches: number;
  readonly flags: readonly ReportFlag[];
}

export interface ReportSummary {
  readonly totalEvents: number;
  readonly distinctUsers: number;
  readonly distinctPeople: number;
  readonly unreviewed: number;
  readonly byUser: readonly UserLine[];
  readonly byPerson: readonly PersonLine[];
  readonly byReason: readonly ReasonLine[];
  readonly flagged: readonly FlagLine[];
  readonly searches: {
    readonly total: number;
    readonly distinctUsers: number;
    readonly byUser: readonly SearchUserLine[];
    readonly byReason: readonly ReasonLine[];
  };
  /** True when part of the stored summary could not be read: the page then warns. */
  readonly unreadable: boolean;
}

type Raw = Record<string, unknown>;

const isRecord = (value: unknown): value is Raw =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/**
 * Reads the stored summary. Anything malformed is counted as unreadable (and the page warns)
 * rather than dropped quietly or read as nothing to report (HZ-011).
 */
export function readSummary(summary: Record<string, unknown>): ReportSummary {
  let unreadable = false;
  const count = (value: unknown): number => {
    if (typeof value === "number" && Number.isInteger(value) && value >= 0) return value;
    unreadable = true;
    return 0;
  };
  const id = (value: unknown): string | null =>
    typeof value === "string" && value.length > 0 ? value : null;
  const list = <T>(value: unknown, read: (item: Raw) => T | null): T[] => {
    if (!Array.isArray(value)) {
      unreadable = true;
      return [];
    }
    return value.flatMap((item) => {
      const line = isRecord(item) ? read(item) : null;
      if (line === null) unreadable = true;
      return line === null ? [] : [line];
    });
  };
  const flag = (value: unknown): ReportFlag =>
    (FLAGS as readonly unknown[]).includes(value) ? (value as ReportFlag) : "unknown";
  const flags = (value: unknown): ReportFlag[] => {
    if (Array.isArray(value)) return value.map(flag);
    unreadable = true;
    return [];
  };
  const reason = (item: Raw): ReasonLine => ({
    reason: (REASONS as readonly unknown[]).includes(item.reason)
      ? (item.reason as ReportReason)
      : "unknown",
    events: count(item.events),
  });
  const searches = isRecord(summary.searches) ? summary.searches : null;
  if (!searches) unreadable = true;

  const result = {
    totalEvents: count(summary.totalEvents),
    distinctUsers: count(summary.distinctUsers),
    distinctPeople: count(summary.distinctPeople),
    unreviewed: Array.isArray(summary.unreviewedEventIds)
      ? summary.unreviewedEventIds.length
      : count(undefined),
    byUser: list(summary.byUser, (item): UserLine | null => {
      const tenantUserId = id(item.tenantUserId);
      return tenantUserId
        ? {
            tenantUserId,
            events: count(item.events),
            people: count(item.people),
            unreviewed: count(item.unreviewed),
            flags: flags(item.flags),
          }
        : null;
    }),
    byPerson: list(summary.byPerson, (item): PersonLine | null => {
      const personId = id(item.personId);
      return personId
        ? {
            personId,
            events: count(item.events),
            users: count(item.users),
            flags: flags(item.flags),
          }
        : null;
    }),
    byReason: list(summary.byReason, reason),
    flagged: list(
      summary.flagged,
      (item): FlagLine => ({
        flag: flag(item.flag),
        tenantUserId: id(item.tenantUserId),
        personId: id(item.personId),
        count: count(item.count),
      }),
    ),
    searches: {
      total: count(searches?.total ?? 0),
      distinctUsers: count(searches?.distinctUsers ?? 0),
      byUser: searches
        ? list(searches.byUser, (item): SearchUserLine | null => {
            const tenantUserId = id(item.tenantUserId);
            return tenantUserId
              ? { tenantUserId, searches: count(item.searches), flags: flags(item.flags) }
              : null;
          })
        : [],
      byReason: searches ? list(searches.byReason, reason) : [],
    },
  };
  return { ...result, unreadable };
}

/** Whether a report flags anything: a line in "needs attention", or a searcher's repeated use. */
export function flagCount(summary: ReportSummary): number {
  return summary.flagged.length + summary.searches.byUser.filter((u) => u.flags.length > 0).length;
}

// ------------------------------------------------------------------------------------------------
// Reports and their reviews
// ------------------------------------------------------------------------------------------------

type Report = Pick<
  BreakGlassWeeklyReportOut,
  "id" | "locationId" | "supersedesId" | "reviewedAt" | "reviewedBy" | "actionsTaken"
>;

export interface ReportEntry<R extends Report> {
  /** The report as built (the one a review is recorded against). */
  readonly report: R;
  /** The row recording its review, when there is one. */
  readonly review: R | null;
}

/**
 * Each built report with its review, by location in the order given (the API sorts them). A
 * review whose report is not in the list is shown as the report itself, so nothing is hidden.
 */
export function reportEntries<R extends Report>(items: readonly R[]): ReportEntry<R>[] {
  const reviews = new Map<string, R>();
  for (const item of items) {
    if (item.supersedesId && !reviews.has(item.supersedesId)) reviews.set(item.supersedesId, item);
  }
  const ids = new Set(items.map((i) => i.id));
  return items.flatMap((item) => {
    if (!item.supersedesId) return [{ report: item, review: reviews.get(item.id) ?? null }];
    return ids.has(item.supersedesId) ? [] : [{ report: item, review: item }];
  });
}

/** Reviewed, or still to review: an icon and a word, never colour alone. */
export function reviewChip(entry: ReportEntry<Report>, t: Translator): SafetyChip {
  return entry.review
    ? { status: "done", icon: "circle-check", label: t("breakGlassReport.state.reviewed") }
    : { status: "due", icon: "clock", label: t("breakGlassReport.state.toReview") };
}

/** How many lines the report flags, as a warning chip; null when it flags nothing. */
export function flagChip(count: number, t: Translator): SafetyChip | null {
  return count > 0
    ? {
        status: "overdue",
        icon: "triangle-alert",
        label: t("breakGlassReport.state.flagged", { count }),
      }
    : null;
}

export type ReviewOffer =
  | { readonly kind: "reviewed" }
  | { readonly kind: "form" }
  /** The report flags the reader's own use: the API refuses them (separation of duties). */
  | { readonly kind: "own" };

/**
 * Whether the reader is offered the review form. The API takes a review once, from a holder of
 * the permission at the report's location who is not flagged in it.
 */
export function reviewOffer(
  entry: ReportEntry<Report>,
  summary: Pick<ReportSummary, "flagged">,
  tenantUserId: string,
): ReviewOffer {
  if (entry.review) return { kind: "reviewed" };
  return summary.flagged.some((f) => f.tenantUserId === tenantUserId)
    ? { kind: "own" }
    : { kind: "form" };
}

/** Why "actions taken" cannot be sent, or null. */
export function actionsProblem(text: string): "tooShort" | "tooLong" | null {
  const trimmed = text.trim();
  if (trimmed.length < ACTIONS_MIN) return "tooShort";
  if (trimmed.length > ACTIONS_MAX) return "tooLong";
  return null;
}

/**
 * A refused review in the page's words: someone else recorded the review first (the API's version
 * conflict, never "someone changed the record"), or the report flags the reviewer.
 */
export function reviewProblem(problem: Problem, t: Translator): Problem {
  if (problem.code === "version_conflict") {
    return { code: problem.code, message: t("breakGlassReport.review.conflict") };
  }
  if (problem.code === "separation_of_duties") {
    return { code: problem.code, message: t("breakGlassReport.review.own") };
  }
  return problem;
}

// ------------------------------------------------------------------------------------------------
// Names
// ------------------------------------------------------------------------------------------------

export type Namer = (id: string | null) => string;

/** Staff by the names the API returned with the report; one it did not name says so. */
export function staffNamer(staff: readonly (StaffName | null)[], t: Translator): Namer {
  const names = new Map(staff.flatMap((s) => (s ? [[s.id, staffName(s, t)] as const] : [])));
  return (id) => (id ? names.get(id) : undefined) ?? t("breakGlassReport.staffUnknown");
}

/**
 * People by name when they are in the reader's own list, else numbered in the order the report
 * first gives them ("Person 2 (not shown to you)"), so the lines about one person still match.
 */
export function personNamer(
  personIds: readonly string[],
  names: ReadonlyMap<string, string>,
  t: Translator,
): Namer {
  const numbers = new Map<string, number>();
  for (const id of personIds) {
    if (!names.has(id) && !numbers.has(id)) numbers.set(id, numbers.size + 1);
  }
  return (id) => {
    if (!id) return t("breakGlassReport.personUnknown");
    const name = names.get(id);
    if (name) return name;
    const n = numbers.get(id);
    return n ? t("breakGlassReport.personNumbered", { n }) : t("breakGlassReport.personUnknown");
  };
}

/** The people a report names, in the order it gives them (its lines by person, then its flags). */
export function reportPersonIds(summary: Pick<ReportSummary, "byPerson" | "flagged">): string[] {
  return [
    ...summary.byPerson.map((p) => p.personId),
    ...summary.flagged.flatMap((f) => (f.personId ? [f.personId] : [])),
  ];
}

/** One flag in words, with who and whom it is about. */
export function flagSentence(
  line: FlagLine,
  threshold: number,
  staff: Namer,
  person: Namer,
  t: Translator,
): string {
  return t("breakGlassReport.flag.line", {
    flag: line.flag,
    staff: staff(line.tenantUserId),
    person: person(line.personId),
    count: line.count,
    threshold,
  });
}

/** The flags on a line, in words ("Repeated use, Same person more than once"), or "None". */
export function flagsText(flags: readonly ReportFlag[], t: Translator): string {
  return flags.length === 0
    ? t("common.none")
    : flags.map((flag) => t("breakGlassReport.flag.short", { flag })).join(", ");
}
