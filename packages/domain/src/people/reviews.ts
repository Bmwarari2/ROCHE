import {
  addWorkingDays,
  type BankHolidays,
  ukIsoDate,
  workingDaysDeadline,
} from "../shared/working-days";
import type { PlacementType } from "./admission";
import { isCalendarDate, laterDate, plusMonths, plusWeeks } from "./dates";
import type { PersonStatus } from "./lifecycle";
import { PEOPLE_RATE_KEYS, type PeopleRates } from "./rates";

/**
 * Review scheduler (master prompt section 9.2; people.md section 4 rule 8). Works out when each
 * review of a person falls due: the first care plan (working days after admission), the regular
 * care plan review and the review on change, the local authority review for council-funded
 * placements, the family involvement record and the end of a trial period. Every figure comes from
 * the rate table. Several unreviewed changes raise one review, not one each (HZ-008), and a
 * regular review done after a change covers it. Dates are calendar dates in the location's time
 * zone; nothing is scheduled for people who are not receiving care.
 */

export const REVIEW_KINDS = [
  "first_care_plan",
  "care_plan_review",
  "care_plan_review_on_change",
  "la_review",
  "family_involvement",
  "trial_review",
] as const;
export type ReviewKind = (typeof REVIEW_KINDS)[number];

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

export interface CarePlanChange {
  readonly id: string;
  readonly kind: CarePlanChangeKind;
  /** yyyy-mm-dd */
  readonly occurredOn: string;
  /** yyyy-mm-dd of the review that dealt with it, or null. */
  readonly reviewedOn: string | null;
}

export const FAMILY_INVOLVEMENT_KINDS = [
  "attended_review",
  "contributed",
  "invited_declined",
  "person_declines_involvement",
  "no_family_or_representative",
] as const;
export type FamilyInvolvementKind = (typeof FAMILY_INVOLVEMENT_KINDS)[number];

export interface FamilyInvolvementRecord {
  readonly kind: FamilyInvolvementKind;
  /** yyyy-mm-dd */
  readonly recordedOn: string;
}

export interface ReviewScheduleInput {
  readonly status: PersonStatus;
  /** When the current placement began (the admission instant). */
  readonly admittedAt: Date;
  readonly placement: {
    readonly type: PlacementType;
    /** yyyy-mm-dd */
    readonly startDate: string;
    readonly trialEndsOn?: string | null;
    readonly trialReviewedOn?: string | null;
    /** True when a local authority funds or part-funds the placement. */
    readonly localAuthorityFunded: boolean;
  };
  readonly carePlan: {
    /** When the first care plan was published, or null if there is none yet. */
    readonly firstPublishedAt: Date | null;
    /** yyyy-mm-dd of the last completed review, or null. */
    readonly lastReviewedOn: string | null;
  };
  /** Dates (yyyy-mm-dd) of completed local authority reviews. */
  readonly laReviewsCompleted: readonly string[];
  readonly changes: readonly CarePlanChange[];
  readonly familyInvolvement: readonly FamilyInvolvementRecord[];
  /** The location's calendar date. */
  readonly today: string;
  /** Bank holidays of the location's nation (calendar.md). */
  readonly holidays: BankHolidays;
  readonly rates: Pick<
    PeopleRates,
    | "carePlanInitialWorkingDays"
    | "carePlanReviewIntervalMonths"
    | "laReviewFirstMinWeeks"
    | "laReviewFirstMaxWeeks"
    | "laReviewIntervalMonths"
    | "familyInvolvementIntervalMonths"
  >;
}

export type ReviewState = "upcoming" | "due" | "overdue" | "paused";

export interface ReviewDue {
  readonly kind: ReviewKind;
  /** Last day on which the review is on time (yyyy-mm-dd). */
  readonly dueOn: string;
  /** First day of a review window (the first local authority review), else null. */
  readonly windowOpensOn: string | null;
  /** The exact deadline when it is an instant (the first care plan: midnight after the last working day). */
  readonly dueAt: Date | null;
  readonly state: ReviewState;
  /** The unreviewed changes a review on change covers. */
  readonly changeIds: readonly string[];
  /** Rate-table keys the date was computed from, shown with the date. */
  readonly basis: readonly string[];
}

export type FamilyInvolvementSchedule =
  | "scheduled"
  | "person_declines_involvement"
  | "no_family_or_representative"
  | "not_receiving_care";

export interface ReviewSchedule {
  readonly items: readonly ReviewDue[];
  readonly familyInvolvement: FamilyInvolvementSchedule;
}

const SCHEDULED_STATUSES: readonly PersonStatus[] = ["active", "on_leave", "in_hospital"];

function stateOf(
  dueOn: string,
  windowOpensOn: string | null,
  today: string,
  paused: boolean,
): ReviewState {
  if (paused) return "paused";
  if (today > dueOn) return "overdue";
  if (today >= (windowOpensOn ?? dueOn)) return "due";
  return "upcoming";
}

function latest(dates: readonly string[]): string | null {
  return dates
    .filter(isCalendarDate)
    .reduce<string | null>((a, b) => (a === null ? b : laterDate(a, b)), null);
}

/** When each review of a person falls due. */
export function scheduleReviews(input: ReviewScheduleInput): ReviewSchedule {
  if (!SCHEDULED_STATUSES.includes(input.status)) {
    return { items: [], familyInvolvement: "not_receiving_care" };
  }
  const { rates, today, placement, carePlan } = input;
  // Care plan reviews wait while the person is in hospital; their return raises a review on change.
  const carePlanPaused = input.status === "in_hospital";
  const items: ReviewDue[] = [];
  const push = (
    item: Omit<ReviewDue, "state" | "changeIds"> & { changeIds?: readonly string[] },
    paused = false,
  ) =>
    items.push({
      ...item,
      changeIds: item.changeIds ?? [],
      state: stateOf(item.dueOn, item.windowOpensOn, today, paused),
    });

  // First care plan, then the regular review.
  if (!carePlan.firstPublishedAt) {
    const days = rates.carePlanInitialWorkingDays;
    push(
      {
        kind: "first_care_plan",
        dueOn: addWorkingDays(ukIsoDate(input.admittedAt), days, input.holidays),
        windowOpensOn: null,
        dueAt: workingDaysDeadline(input.admittedAt, days, input.holidays),
        basis: [PEOPLE_RATE_KEYS.carePlanInitialWorkingDays],
      },
      carePlanPaused,
    );
  }
  if (carePlan.firstPublishedAt) {
    const published = ukIsoDate(carePlan.firstPublishedAt);
    const lastReviewed = latest([published, carePlan.lastReviewedOn ?? published]) ?? published;
    push(
      {
        kind: "care_plan_review",
        dueOn: plusMonths(lastReviewed, rates.carePlanReviewIntervalMonths),
        windowOpensOn: null,
        dueAt: null,
        basis: [PEOPLE_RATE_KEYS.carePlanReviewIntervalMonths],
      },
      carePlanPaused,
    );
  }

  // One review on change covers every change not yet reviewed (HZ-008).
  const unreviewed = input.changes
    .filter((c) => c.reviewedOn === null && isCalendarDate(c.occurredOn))
    // A regular review on a later day covers the change; one on the same day must name it.
    .filter((c) => !carePlan.lastReviewedOn || carePlan.lastReviewedOn <= c.occurredOn)
    .sort((a, b) => (a.occurredOn < b.occurredOn ? -1 : a.occurredOn > b.occurredOn ? 1 : 0));
  const firstChange = unreviewed[0];
  if (firstChange) {
    push(
      {
        kind: "care_plan_review_on_change",
        dueOn: firstChange.occurredOn,
        windowOpensOn: null,
        dueAt: null,
        changeIds: unreviewed.map((c) => c.id),
        basis: [],
      },
      carePlanPaused,
    );
  }

  // Local authority review: 6 to 8 weeks after the start, then yearly (figures from the rate table).
  if (
    placement.localAuthorityFunded &&
    (placement.type === "permanent" || placement.type === "trial")
  ) {
    const lastLa = latest(input.laReviewsCompleted);
    if (lastLa) {
      push({
        kind: "la_review",
        dueOn: plusMonths(lastLa, rates.laReviewIntervalMonths),
        windowOpensOn: null,
        dueAt: null,
        basis: [PEOPLE_RATE_KEYS.laReviewIntervalMonths],
      });
    } else {
      push({
        kind: "la_review",
        dueOn: plusWeeks(placement.startDate, rates.laReviewFirstMaxWeeks),
        windowOpensOn: plusWeeks(placement.startDate, rates.laReviewFirstMinWeeks),
        dueAt: null,
        basis: [PEOPLE_RATE_KEYS.laReviewFirstMinWeeks, PEOPLE_RATE_KEYS.laReviewFirstMaxWeeks],
      });
    }
  }

  // Family involvement, unless the person does not want it or has nobody.
  const records = input.familyInvolvement.filter((r) => isCalendarDate(r.recordedOn));
  const lastRecord = records.reduce<FamilyInvolvementRecord | null>(
    (a, b) => (a === null || b.recordedOn >= a.recordedOn ? b : a),
    null,
  );
  let familyInvolvement: FamilyInvolvementSchedule = "scheduled";
  if (
    lastRecord?.kind === "person_declines_involvement" ||
    lastRecord?.kind === "no_family_or_representative"
  ) {
    familyInvolvement = lastRecord.kind;
  } else {
    push({
      kind: "family_involvement",
      dueOn: plusMonths(
        lastRecord?.recordedOn ?? placement.startDate,
        rates.familyInvolvementIntervalMonths,
      ),
      windowOpensOn: null,
      dueAt: null,
      basis: [PEOPLE_RATE_KEYS.familyInvolvementIntervalMonths],
    });
  }

  // End of a trial period: the decision to stay must be made before it ends.
  if (
    placement.type === "trial" &&
    placement.trialEndsOn &&
    isCalendarDate(placement.trialEndsOn) &&
    !placement.trialReviewedOn
  ) {
    push({
      kind: "trial_review",
      dueOn: placement.trialEndsOn,
      windowOpensOn: null,
      dueAt: null,
      basis: [],
    });
  }

  items.sort((a, b) =>
    a.dueOn === b.dueOn
      ? REVIEW_KINDS.indexOf(a.kind) - REVIEW_KINDS.indexOf(b.kind)
      : a.dueOn < b.dueOn
        ? -1
        : 1,
  );
  return { items, familyInvolvement };
}
