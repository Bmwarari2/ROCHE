import type { CreateReviewRecord, LocationReviews, ReviewSchedule } from "@harbour/contracts";
import type { Translator } from "@harbour/i18n";

/**
 * Helpers for the reviews screens (people.md rule 8 and section 6a; PEOP-008; HZ-008). The dates
 * and states are the API's (`scheduleReviews` with the rate-table figures); nothing is worked out
 * here, only put in order and put into words.
 */

export type ReviewDue = ReviewSchedule["items"][number];
export type ReviewState = ReviewDue["state"];
export type ReviewRecordKind = CreateReviewRecord["kind"];
export type FamilyInvolvementKind = NonNullable<CreateReviewRecord["familyInvolvementKind"]>;
export type TrackerItem = LocationReviews["items"][number];

/** The kinds of review a person can record, in the order the form offers them. */
export const REVIEW_RECORD_KINDS = [
  "care_plan",
  "la_review",
  "family_involvement",
  "trial_review",
] as const satisfies readonly ReviewRecordKind[];

export const FAMILY_INVOLVEMENT_KINDS = [
  "attended_review",
  "contributed",
  "invited_declined",
  "person_declines_involvement",
  "no_family_or_representative",
] as const satisfies readonly FamilyInvolvementKind[];

export const CARE_PLAN_CHANGE_KINDS = [
  "return_from_hospital",
  "fall",
  "change_in_needs",
  "new_diagnosis",
  "safeguarding",
  "end_of_life",
  "other",
] as const;
export type CarePlanChangeKind = (typeof CARE_PLAN_CHANGE_KINDS)[number];

/** The most people a review record names (the API's limit). */
export const MAX_PARTICIPANTS = 30;
/** The longest role the API takes for one participant. */
export const MAX_PARTICIPANT_LENGTH = 120;

export type ReviewChipIcon = "overdue" | "due" | "upcoming" | "paused";

/** A review's state as a chip: an icon and a word, never colour alone (CONTENT.md). */
export interface ReviewChip {
  readonly status: "overdue" | "due" | "neutral" | "notApplicable";
  readonly icon: ReviewChipIcon;
  readonly label: string;
}

export function reviewChip(state: ReviewState, t: Translator): ReviewChip {
  const label = t("people.reviews.state", { state });
  switch (state) {
    case "overdue":
      return { status: "overdue", icon: "overdue", label };
    case "due":
      return { status: "due", icon: "due", label };
    case "paused":
      return { status: "notApplicable", icon: "paused", label };
    default:
      return { status: "neutral", icon: "upcoming", label };
  }
}

const STATE_ORDER: Record<ReviewState, number> = { overdue: 0, due: 1, upcoming: 2, paused: 3 };

/** Overdue first, then due, upcoming and paused; soonest first within each. */
export function orderReviews<T extends Pick<ReviewDue, "state" | "dueOn">>(
  items: readonly T[],
): T[] {
  return [...items].sort(
    (a, b) =>
      STATE_ORDER[a.state] - STATE_ORDER[b.state] ||
      (a.dueOn < b.dueOn ? -1 : a.dueOn > b.dueOn ? 1 : 0),
  );
}

/**
 * Who took part, one role per line ("Key worker", "Social worker"), as the API's participants.
 * Blank lines are dropped; a problem when there are too many or a line is too long, so the form can
 * say so rather than cut anything off.
 */
export function participantsFromLines(
  text: string,
): { readonly role: string }[] | { readonly problem: "too_many" | "too_long" } {
  const lines = text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
  if (lines.length > MAX_PARTICIPANTS) return { problem: "too_many" };
  if (lines.some((line) => line.length > MAX_PARTICIPANT_LENGTH)) return { problem: "too_long" };
  return lines.map((role) => ({ role }));
}

/** A tracker row with the person's name, or null when the person is not in the viewer's list. */
export interface TrackerRow extends TrackerItem {
  readonly name: string;
  readonly locationName: string | null;
}

/**
 * The manager's tracker: the API's due and overdue reviews joined to the names in the viewer's
 * own people list. A review for someone the list does not name (outside the viewer's scope) is
 * left out rather than shown without a name. Overdue first, then soonest.
 */
export function trackerRows(
  items: readonly (TrackerItem & { readonly locationId?: string })[],
  names: ReadonlyMap<string, string>,
  locationNames: ReadonlyMap<string, string>,
): TrackerRow[] {
  const rows: TrackerRow[] = [];
  for (const item of items) {
    const name = names.get(item.personId);
    if (!name) continue;
    rows.push({
      ...item,
      name,
      locationName: item.locationId ? (locationNames.get(item.locationId) ?? null) : null,
    });
  }
  return orderReviews(rows);
}
