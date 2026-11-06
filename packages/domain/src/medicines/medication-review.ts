/**
 * Medication reviews and the PRN and psychotropic use report (slice 45; medicines.md sections 14.2
 * and 14.3; MEDS-013, MEDS-003). A review is scheduled, then recorded as done by a named clinician
 * in their own words; Harbour never suggests a change. The report counts records for a clinician to
 * look at, never judging the person or the prescribing (medical-device boundary). The interval and
 * the "due soon" window are rate-table figures passed in, never literals here.
 */

import { addDaysToDate, addMonthsToDate } from "../care/assessment";

export const REVIEWER_ROLES = ["gp", "pharmacist", "prescriber", "consultant", "other"] as const;
export type ReviewerRole = (typeof REVIEWER_ROLES)[number];

export const REVIEWER_ROLE_WORDS: Readonly<Record<ReviewerRole, string>> = {
  gp: "GP",
  pharmacist: "Pharmacist",
  prescriber: "Nurse or other prescriber",
  consultant: "Consultant",
  other: "Other clinician",
};

export const REVIEW_TEXT_MAX = 4000;
export const REVIEW_NAME_MAX = 200;

const ISO_DATE = /^(\d{4})-(\d{2})-(\d{2})$/;

export type ReviewStatus = "overdue" | "due_soon" | "scheduled" | "not_booked" | "not_scheduled";

export const REVIEW_STATUS_WORDS: Readonly<Record<ReviewStatus, string>> = {
  overdue: "Review overdue",
  due_soon: "Review due soon",
  scheduled: "Review booked",
  not_booked: "Review due by the interval, not yet booked",
  not_scheduled: "No review booked or done",
};

export interface ReviewTrackerRow {
  readonly lastDoneOn: string | null;
  /** The earliest booked review not yet done. */
  readonly bookedOn: string | null;
  /** The last done plus the interval. */
  readonly intervalDueOn: string | null;
  /** The earlier of the two: when the next review is due. */
  readonly nextDueOn: string | null;
  /** Which of the two sets the next date (the interval when they are equal). */
  readonly nextFrom: "scheduled" | "interval" | null;
  /** True when a review is booked later than the interval allows. */
  readonly bookedAfterInterval: boolean;
  readonly status: ReviewStatus;
}

/**
 * One person's line on the tracker. The next review is due on the earlier of the earliest booked
 * review and the last done plus the interval, so a review booked late never hides an interval that
 * has run out (slice 45 clinical review B1). Overdue once its day has passed; due soon within the
 * window; otherwise booked, or due by the interval with nothing booked (B2), or neither.
 */
export function reviewStatus(
  reviews: readonly { readonly dueOn: string; readonly doneOn: string | null }[],
  figures: { readonly intervalMonths: number; readonly dueSoonDays: number },
  today: string,
): ReviewTrackerRow {
  const done = reviews
    .map((r) => r.doneOn)
    .filter((d): d is string => d !== null)
    .sort();
  const lastDoneOn = done.at(-1) ?? null;
  const bookedOn =
    reviews
      .filter((r) => r.doneOn === null)
      .map((r) => r.dueOn)
      .sort()[0] ?? null;
  const intervalDueOn = lastDoneOn ? addMonthsToDate(lastDoneOn, figures.intervalMonths) : null;
  const nextFrom =
    intervalDueOn !== null && (bookedOn === null || intervalDueOn <= bookedOn)
      ? "interval"
      : bookedOn !== null
        ? "scheduled"
        : null;
  const nextDueOn = nextFrom === "interval" ? intervalDueOn : bookedOn;
  let status: ReviewStatus;
  if (nextDueOn === null) status = "not_scheduled";
  else if (nextDueOn < today) status = "overdue";
  else if (nextDueOn <= addDaysToDate(today, figures.dueSoonDays)) status = "due_soon";
  else status = bookedOn !== null ? "scheduled" : "not_booked";
  return {
    lastDoneOn,
    bookedOn,
    intervalDueOn,
    nextDueOn,
    nextFrom,
    bookedAfterInterval: bookedOn !== null && intervalDueOn !== null && bookedOn > intervalDueOn,
    status,
  };
}

export type ReviewProblem =
  | "due_not_a_date"
  | "done_not_a_date"
  | "done_in_future"
  | "clinician_required"
  | "role_unknown"
  | "outcome_required"
  | "text_too_long";

export const REVIEW_PROBLEM_WORDS: Readonly<Record<ReviewProblem, string>> = {
  due_not_a_date: "Enter the date the review is due.",
  done_not_a_date: "Enter the date the review was done.",
  done_in_future: "The review cannot be recorded as done on a date still to come.",
  clinician_required: "Name the clinician who did the review.",
  role_unknown: "Choose the clinician's role.",
  outcome_required: "Write the outcome in the clinician's words.",
  text_too_long: "Keep the name to 200 characters and the outcome to 4,000.",
};

/** Checks recording a review as done: a date not in the future, a named clinician, an outcome. */
export function checkReviewDone(
  input: {
    readonly doneOn: string;
    readonly clinicianName: string;
    readonly clinicianRole: string;
    readonly outcome: string;
  },
  today: string,
): ReviewProblem[] {
  const problems: ReviewProblem[] = [];
  if (!ISO_DATE.test(input.doneOn)) problems.push("done_not_a_date");
  else if (input.doneOn > today) problems.push("done_in_future");
  if (input.clinicianName.trim().length === 0) problems.push("clinician_required");
  if (!(REVIEWER_ROLES as readonly string[]).includes(input.clinicianRole))
    problems.push("role_unknown");
  if (input.outcome.trim().length === 0) problems.push("outcome_required");
  if (input.clinicianName.length > REVIEW_NAME_MAX || input.outcome.length > REVIEW_TEXT_MAX)
    problems.push("text_too_long");
  return problems;
}

// ---------------------------------------------------------------------------------------------
// PRN and psychotropic use (information only)

export interface UsageCounts {
  readonly personId: string;
  readonly prnGiven: number;
  readonly psychotropicGiven: number;
  /** When-required doses of psychotropic entries: counted in both of the above too. */
  readonly psychotropicPrnGiven: number;
  readonly byMedicine: readonly {
    readonly medicineId: string;
    readonly name: string;
    readonly prnGiven: number;
    readonly psychotropicGiven: number;
  }[];
}

/** The words the report always carries: a count of records, never a judgement. */
export const USAGE_REPORT_NOTE =
  "A count of administration records for a clinician to review. It does not judge the person, the care or the prescribing.";

/**
 * Doses taken per person, from administration records: of when-required entries, of entries tagged
 * psychotropic, and of both. Each record is classed by the entry version it was given under, so a
 * change of directions or tags during the period counts each dose as it was (slice 45 clinical
 * review B16). The caller passes the latest record per dose only (a corrected record is left out,
 * wherever its correction falls) and `taken` for the outcomes in which the person took the dose.
 */
export function usageCounts(
  records: readonly {
    readonly personId: string;
    readonly medicineId: string;
    readonly name: string;
    readonly prn: boolean;
    readonly psychotropic: boolean;
    readonly taken: boolean;
  }[],
): UsageCounts[] {
  const people = new Map<
    string,
    Map<string, { name: string; prnGiven: number; psychotropicGiven: number; both: number }>
  >();
  for (const r of records) {
    if (!r.taken || (!r.prn && !r.psychotropic)) continue;
    const byMed = people.get(r.personId) ?? new Map();
    const row = byMed.get(r.medicineId) ?? {
      name: r.name,
      prnGiven: 0,
      psychotropicGiven: 0,
      both: 0,
    };
    if (r.prn) row.prnGiven += 1;
    if (r.psychotropic) row.psychotropicGiven += 1;
    if (r.prn && r.psychotropic) row.both += 1;
    byMed.set(r.medicineId, row);
    people.set(r.personId, byMed);
  }
  return [...people.entries()]
    .map(([personId, byMed]) => {
      const rows = [...byMed.entries()];
      const sum = (
        pick: (m: { prnGiven: number; psychotropicGiven: number; both: number }) => number,
      ) => rows.reduce((n, [, m]) => n + pick(m), 0);
      return {
        personId,
        prnGiven: sum((m) => m.prnGiven),
        psychotropicGiven: sum((m) => m.psychotropicGiven),
        psychotropicPrnGiven: sum((m) => m.both),
        byMedicine: rows
          .map(([medicineId, m]) => ({
            medicineId,
            name: m.name,
            prnGiven: m.prnGiven,
            psychotropicGiven: m.psychotropicGiven,
          }))
          .sort((a, b) => a.name.localeCompare(b.name, "en-GB")),
      };
    })
    .sort((a, b) => (a.personId < b.personId ? -1 : a.personId > b.personId ? 1 : 0));
}

// ---------------------------------------------------------------------------------------------
// Competence overrides and late recording (HZ-119; slice 45 clinical review B17)

export interface OverrideCounts {
  readonly memberId: string;
  /** Doses this member gave under a competence override. */
  readonly competenceOverride: number;
  /** Doses this member gave with no current medicines competence, recorded after the event. */
  readonly competenceNotCurrent: number;
  /** Doses this member recorded after they were given. */
  readonly givenBeforeRecorded: number;
}

/**
 * Per member: a competence override or lapsed competence counts against the member who gave the
 * dose, a dose recorded after it was given against the member who recorded it. The caller passes
 * the latest record per dose only, so a corrected record is never counted twice.
 */
export function overrideCounts(
  records: readonly {
    readonly administeredBy: string;
    readonly recordedBy: string;
    readonly flags: readonly string[];
  }[],
): OverrideCounts[] {
  const rows = new Map<
    string,
    { competenceOverride: number; competenceNotCurrent: number; givenBeforeRecorded: number }
  >();
  const row = (id: string) => {
    const found = rows.get(id) ?? {
      competenceOverride: 0,
      competenceNotCurrent: 0,
      givenBeforeRecorded: 0,
    };
    rows.set(id, found);
    return found;
  };
  for (const r of records) {
    if (r.flags.includes("competence_override")) row(r.administeredBy).competenceOverride += 1;
    if (r.flags.includes("competence_not_current")) row(r.administeredBy).competenceNotCurrent += 1;
    if (r.flags.includes("given_before_recorded")) row(r.recordedBy).givenBeforeRecorded += 1;
  }
  return [...rows.entries()]
    .map(([memberId, n]) => ({ memberId, ...n }))
    .sort((a, b) => (a.memberId < b.memberId ? -1 : a.memberId > b.memberId ? 1 : 0));
}
