import type { CreateCareNote, PersonCareProfile, ResuscitationStatus } from "@harbour/contracts";
import type { Translator } from "@harbour/i18n";
import { formatDate } from "./format";

/**
 * Helpers for the person record screens (docs/specs/care.md, Phase 1 slice 9). Pure and unit
 * tested; the web app only shows what the API returns and never scores or bands anything itself.
 */

// ------------------------------------------------------------------------------------------------
// Tabs and permissions
// ------------------------------------------------------------------------------------------------

export type RecordTab =
  | "overview"
  | "care-plan"
  | "assessments"
  | "risk-assessments"
  | "notes"
  | "charts"
  | "body-map"
  | "advance-care"
  | "capacity"
  | "activities"
  | "reviews"
  | "hospital"
  | "letters"
  | "family-updates"
  | "history";

interface TabDefinition {
  readonly tab: RecordTab;
  /** The permission needed to read what the tab shows. */
  readonly needs:
    | "care.plan.read"
    | "care.note.read"
    | "people.person.read"
    | "people.movement.record"
    | "comms.letter.manage"
    | "comms.feed.publish";
}

/** In the order the tabs appear: plan and assessments first, then the daily record. */
export const RECORD_TABS: readonly TabDefinition[] = [
  { tab: "overview", needs: "people.person.read" },
  { tab: "care-plan", needs: "care.plan.read" },
  { tab: "assessments", needs: "care.plan.read" },
  { tab: "risk-assessments", needs: "care.plan.read" },
  { tab: "notes", needs: "care.note.read" },
  { tab: "charts", needs: "care.note.read" },
  { tab: "body-map", needs: "care.note.read" },
  { tab: "advance-care", needs: "care.plan.read" },
  { tab: "capacity", needs: "care.plan.read" },
  { tab: "activities", needs: "care.note.read" },
  { tab: "reviews", needs: "care.plan.read" },
  { tab: "hospital", needs: "people.movement.record" },
  { tab: "letters", needs: "comms.letter.manage" },
  { tab: "family-updates", needs: "comms.feed.publish" },
  { tab: "history", needs: "people.person.read" },
];

export function can(permissions: readonly string[], permission: string): boolean {
  return permissions.includes(permission);
}

/** What the API says the viewer may record about one person (`PersonSummary.access`). */
export interface PersonAccess {
  readonly reaching: readonly string[];
  readonly recordCare: boolean;
  readonly editCarePlan: boolean;
  readonly readOnlyReason: "break_glass" | "scope" | null;
}

/** The line that says why a form is not offered on a record open for reading only. */
export type ReadOnlyNoticeKey = "care.readOnly.breakGlass" | "care.readOnly.scope";

/**
 * Whether the viewer may use one write permission on this person's record, and the line that
 * says why not when the record is open to them for reading only (ADR-0071 review rounds 2 and 3,
 * C2-M2 and C3-M1): they must hold the permission, and the API must list it among the
 * permissions reaching the person without break-glass (`access.reaching`). Every write form on
 * the record asks this. A record opened by break-glass is for reading only. Someone who never
 * holds the permission sees no form and no line, as before; an API that does not say leaves the
 * form as before (the API refuses anything it would not take).
 */
export function writeAccess(
  person: { readonly access?: PersonAccess | undefined },
  permissions: readonly string[],
  permission: string,
): { readonly canWrite: boolean; readonly readOnlyNotice: ReadOnlyNoticeKey | null } {
  if (!can(permissions, permission)) return { canWrite: false, readOnlyNotice: null };
  if (person.access === undefined || person.access.reaching.includes(permission)) {
    return { canWrite: true, readOnlyNotice: null };
  }
  return {
    canWrite: false,
    readOnlyNotice:
      person.access.readOnlyReason === "break_glass"
        ? "care.readOnly.breakGlass"
        : "care.readOnly.scope",
  };
}

/**
 * Whether the viewer may change this person's care plan settings (chart settings, the care
 * profile): `writeAccess` for care.plan.write (review round 2).
 */
export function mayEditCarePlan(
  person: { readonly access?: PersonAccess | undefined },
  permissions: readonly string[],
): boolean {
  return writeAccess(person, permissions, "care.plan.write").canWrite;
}

/**
 * Whether the viewer may record care (notes, charts, body map marks, activities and visits)
 * about this person: `writeAccess` for care.note.write (review round 2, C2-M2).
 */
export function recordCareAccess(
  person: { readonly access?: PersonAccess | undefined },
  permissions: readonly string[],
): { readonly canRecord: boolean; readonly readOnlyNotice: ReadOnlyNoticeKey | null } {
  const { canWrite, readOnlyNotice } = writeAccess(person, permissions, "care.note.write");
  return { canRecord: canWrite, readOnlyNotice };
}

/**
 * The line above the charts tab's forms (ADR-0071 review rounds 4 and 5): none when the viewer
 * may record entries. When the chart settings stay open to them, a line about entries only, never
 * one saying the record cannot be changed above a form they can use; otherwise why nothing can be
 * recorded here, including why the chart settings are hidden from a holder of care.plan.write.
 */
export function chartsNotice(
  person: { readonly access?: PersonAccess | undefined },
  permissions: readonly string[],
): ReadOnlyNoticeKey | "care.readOnly.chartEntries" | null {
  const entries = writeAccess(person, permissions, "care.note.write");
  if (entries.canWrite) return null;
  const settings = writeAccess(person, permissions, "care.plan.write");
  if (settings.canWrite) return entries.readOnlyNotice ? "care.readOnly.chartEntries" : null;
  return entries.readOnlyNotice ?? settings.readOnlyNotice;
}

/** The address of a tab: the overview is the person's own page. */
export function tabHref(personId: string, tab: RecordTab): string {
  return tab === "overview" ? `/people/${personId}` : `/people/${personId}/${tab}`;
}

/** The tabs this person may read, with their addresses. */
export function visibleTabs(
  personId: string,
  permissions: readonly string[],
): { readonly tab: RecordTab; readonly href: string }[] {
  return RECORD_TABS.filter((definition) => can(permissions, definition.needs)).map(({ tab }) => ({
    tab,
    href: tabHref(personId, tab),
  }));
}

// ------------------------------------------------------------------------------------------------
// Append-only entries and corrections
// ------------------------------------------------------------------------------------------------

/** An append-only record a correction can supersede (notes, entries, capacity assessments). */
export interface EntryLike {
  readonly id: string;
  readonly supersedesId: string | null;
  readonly superseded: boolean;
}

export interface EntryChain<E extends EntryLike> {
  /** The entry in force: the latest correction, or the original when it was never corrected. */
  readonly current: E;
  /** Earlier versions, oldest first. Each was struck through by the next. */
  readonly earlier: readonly E[];
  /** The chain's first entry corrects one from before the dates shown. */
  readonly correctsHidden: boolean;
  /** No later entry in the list replaces the current one, yet the API says it is superseded. */
  readonly supersededOutsideList: boolean;
}

/**
 * Groups append-only entries into correction chains (care.md rule 4: corrections supersede; both
 * stay readable). Every entry appears in exactly one chain. Chains keep the order of their current
 * entries in the list (the API returns newest first).
 */
export function entryChains<E extends EntryLike>(items: readonly E[]): EntryChain<E>[] {
  const byId = new Map(items.map((item) => [item.id, item]));
  const replacedBy = new Map<string, E>();
  for (const item of items) {
    if (item.supersedesId && byId.has(item.supersedesId)) replacedBy.set(item.supersedesId, item);
  }
  const placed = new Set<string>();
  const chains: EntryChain<E>[] = [];
  for (const item of items) {
    if (replacedBy.has(item.id) || placed.has(item.id)) continue;
    const earlier: E[] = [];
    let cursor: E | undefined = item;
    placed.add(item.id);
    while (cursor?.supersedesId) {
      const previous = byId.get(cursor.supersedesId);
      if (!previous || placed.has(previous.id)) break;
      earlier.unshift(previous);
      placed.add(previous.id);
      cursor = previous;
    }
    const first = earlier[0] ?? item;
    chains.push({
      current: item,
      earlier,
      correctsHidden: first.supersedesId !== null && !byId.has(first.supersedesId),
      supersededOutsideList: item.superseded,
    });
  }
  // Data that loops (A corrects B and B corrects A) has no head; show each entry rather than
  // hiding any part of the record.
  for (const item of items) {
    if (placed.has(item.id)) continue;
    placed.add(item.id);
    chains.push({
      current: item,
      earlier: [],
      correctsHidden: false,
      supersededOutsideList: item.superseded,
    });
  }
  return chains;
}

export const NOTE_CATEGORIES = [
  "personal_care",
  "nutrition",
  "mood",
  "activity",
  "visit",
  "health",
  "night",
  "other",
] as const satisfies readonly CreateCareNote["category"][];

/** The API's limit on a note's length. */
export const NOTE_MAX_LENGTH = 4000;

export type EntryAuthor = "you" | "colleague" | "unknown";

/**
 * Who wrote an entry, from the tenant user id the API returns. The API does not return staff
 * names yet (an API gap noted in docs/specs/care.md), so the screen says "you" or "a colleague".
 */
export function entryAuthor(recordedBy: string | null, tenantUserId: string): EntryAuthor {
  if (recordedBy === null) return "unknown";
  return recordedBy === tenantUserId ? "you" : "colleague";
}

// ------------------------------------------------------------------------------------------------
// Resuscitation status in the point-of-care header (HZ-015)
// ------------------------------------------------------------------------------------------------

export type HeaderTone = "danger" | "warning" | "info" | "neutral";

export interface ResuscitationSummary {
  readonly tone: HeaderTone;
  /** Lucide icon beside the word. */
  readonly icon: "heart-off" | "heart-pulse" | "circle-help" | "triangle-alert";
  readonly label: string;
  /** Where the decision comes from, or what to do when there is none. */
  readonly detail: string;
  /** The review date has passed; the decision still stands and is still shown. */
  readonly reviewOverdue: boolean;
  readonly reviewText: string | null;
}

/**
 * The resuscitation status as the header shows it: a word and an icon, never blank. "Not
 * recorded" is a warning, never a calm or empty state; records in force that disagree are the
 * strongest warning and say to check the documents. A status that could not be read (null), or
 * one this version of the web app does not know, is a warning too: it is never shown as
 * "Attempt CPR".
 */
export function resuscitationSummary(
  status: ResuscitationStatus | null,
  t: Translator,
): ResuscitationSummary {
  const unreadable: ResuscitationSummary = {
    tone: "danger",
    icon: "triangle-alert",
    label: t("care.resus.unreadable"),
    detail: t("care.resus.unreadableDetail"),
    reviewOverdue: false,
    reviewText: null,
  };
  if (status === null) return unreadable;
  const review = status.reviewDueOn ? formatDate(status.reviewDueOn) : null;
  const reviewText = review
    ? status.reviewOverdue
      ? t("care.resus.reviewOverdue", { date: review })
      : t("care.resus.reviewDue", { date: review })
    : null;
  if (status.conflicting) {
    return {
      tone: "danger",
      icon: "triangle-alert",
      label: t("care.resus.conflicting"),
      detail: t("care.resus.conflictingDetail"),
      reviewOverdue: status.reviewOverdue,
      reviewText,
    };
  }
  if (status.status === "not_recorded") {
    return {
      tone: "warning",
      icon: "circle-help",
      label: t("care.resus.notRecorded"),
      detail: t("care.resus.notRecordedDetail"),
      reviewOverdue: false,
      reviewText: null,
    };
  }
  const completed = formatDate(status.completedOn) ?? t("common.notRecorded");
  const kind = status.kind ?? "other";
  const detail = status.clinicianName
    ? t("care.resus.sourceWithClinician", {
        kind,
        date: completed,
        clinician: status.clinicianRole
          ? t("care.resus.clinician", {
              name: status.clinicianName,
              role: status.clinicianRole,
            })
          : status.clinicianName,
      })
    : t("care.resus.source", { kind, date: completed });
  switch (status.status) {
    case "do_not_attempt_cpr":
      return {
        tone: "info",
        icon: "heart-off",
        label: t("care.resus.doNotAttempt"),
        detail,
        reviewOverdue: status.reviewOverdue,
        reviewText,
      };
    case "attempt_cpr":
      return {
        tone: "neutral",
        icon: "heart-pulse",
        label: t("care.resus.attempt"),
        detail,
        reviewOverdue: status.reviewOverdue,
        reviewText,
      };
    default:
      return unreadable;
  }
}

/**
 * How often an open record reads the point-of-care header again (hazards HZ-002 and HZ-015), so a
 * change a colleague makes (a withdrawn DNACPR, a new allergy) shows within this time even when
 * nobody moves between tabs. Moving between tabs, coming back to the window and "Check again"
 * read it at once. Every read is an audited view of the record, so it is not more often than this.
 * A product setting, not a statutory figure, so it is not in the rate table.
 */
export const HEADER_REFRESH_INTERVAL_MS = 2 * 60_000;

/** Coming back to the window reads the header again when it is older than this. */
export const HEADER_FOCUS_REFRESH_AFTER_MS = 30_000;

// ------------------------------------------------------------------------------------------------
// IDDSI levels (HZ-016): always number, name and colour in words
// ------------------------------------------------------------------------------------------------

export const IDDSI_FOOD_LEVELS = [
  "3",
  "4",
  "5",
  "6",
  "7EC",
  "7",
] as const satisfies readonly Exclude<PersonCareProfile["iddsiFoodLevel"], null>[];
export const IDDSI_DRINK_LEVELS = ["0", "1", "2", "3", "4"] as const satisfies readonly Exclude<
  PersonCareProfile["iddsiDrinkLevel"],
  null
>[];

export type IddsiKind = "food" | "drink";

/** "Level 5 Minced and moist (orange)", or "No level prescribed". */
export function iddsiLabel(
  kind: IddsiKind,
  level: string | null | undefined,
  t: Translator,
): string {
  if (!level) return t("care.iddsi.notPrescribed");
  return kind === "food"
    ? t("care.iddsi.foodLevel", { level })
    : t("care.iddsi.drinkLevel", { level });
}

// ------------------------------------------------------------------------------------------------
// Reading windows for lists of entries
// ------------------------------------------------------------------------------------------------

/** How far back a list reads: the API's default of 3 days, then a week, a fortnight or 30 days. */
export const READING_WINDOWS = [3, 7, 14, 30] as const;
export type ReadingWindow = (typeof READING_WINDOWS)[number];

/** The window asked for in the address (`?days=14`), or the default. */
export function readingWindow(value: string | string[] | undefined): ReadingWindow {
  const days = Number(Array.isArray(value) ? value[0] : value);
  return (READING_WINDOWS as readonly number[]).includes(days) ? (days as ReadingWindow) : 3;
}

/** The next longer window, or null at the longest. */
export function longerWindow(days: ReadingWindow): ReadingWindow | null {
  const index = READING_WINDOWS.indexOf(days);
  return READING_WINDOWS[index + 1] ?? null;
}

/** The start of a window as an ISO instant. */
export function windowStart(days: ReadingWindow, now: Date = new Date()): string {
  return new Date(now.getTime() - days * 86_400_000).toISOString();
}
