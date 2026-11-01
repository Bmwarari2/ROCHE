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

export type ReviewStatus = "overdue" | "due_soon" | "scheduled" | "not_scheduled";

export const REVIEW_STATUS_WORDS: Readonly<Record<ReviewStatus, string>> = {
  overdue: "Review overdue",
  due_soon: "Review due soon",
  scheduled: "Review scheduled",
  not_scheduled: "No review scheduled",
};

export interface ReviewTrackerRow {
  readonly lastDoneOn: string | null;
  readonly nextDueOn: string | null;
  /** Where the next date comes from: a scheduled review, or the interval after the last one. */
  readonly nextFrom: "scheduled" | "interval" | null;
  readonly status: ReviewStatus;
}

/**
 * One person's line on the tracker. The next review is the earliest scheduled one not yet done;
 * failing that, the last done plus the interval; failing both, not scheduled. Overdue once its day
 * has passed; due soon within the window (both UK dates, `today` given).
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
  const scheduled = reviews
    .filter((r) => r.doneOn === null)
    .map((r) => r.dueOn)
    .sort();
  const nextFrom = scheduled.length > 0 ? "scheduled" : lastDoneOn ? "interval" : null;
  const nextDueOn =
    scheduled[0] ?? (lastDoneOn ? addMonthsToDate(lastDoneOn, figures.intervalMonths) : null);
  let status: ReviewStatus;
  if (nextDueOn === null) status = "not_scheduled";
  else if (nextDueOn < today) status = "overdue";
  else if (nextDueOn <= addDaysToDate(today, figures.dueSoonDays)) status = "due_soon";
  else status = "scheduled";
  return { lastDoneOn, nextDueOn, nextFrom, status };
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
    readonly prn: boolean;
    readonly psychotropic: boolean;
    readonly given: number;
  }[];
}

/** The words the report always carries: a count of records, never a judgement. */
export const USAGE_REPORT_NOTE =
  "A count of administration records for a clinician to review. It does not judge the person, the care or the prescribing.";

/**
 * Doses given per person, from administration records: of when-required entries, of entries tagged
 * psychotropic, and of both. Only records of a dose taken count (the caller passes
 * `taken: true` for those outcomes); corrected records are left out by the caller, which passes
 * the latest record per dose only.
 */
export function usageCounts(
  records: readonly {
    readonly personId: string;
    readonly medicineId: string;
    readonly taken: boolean;
  }[],
  medicines: ReadonlyMap<
    string,
    { readonly name: string; readonly prn: boolean; readonly psychotropic: boolean }
  >,
): UsageCounts[] {
  const people = new Map<string, Map<string, number>>();
  for (const r of records) {
    if (!r.taken) continue;
    const med = medicines.get(r.medicineId);
    if (!med || (!med.prn && !med.psychotropic)) continue;
    const byMed = people.get(r.personId) ?? new Map<string, number>();
    byMed.set(r.medicineId, (byMed.get(r.medicineId) ?? 0) + 1);
    people.set(r.personId, byMed);
  }
  return [...people.entries()]
    .map(([personId, byMed]) => {
      const byMedicine = [...byMed.entries()]
        .map(([medicineId, given]) => {
          const med = medicines.get(medicineId);
          return {
            medicineId,
            name: med?.name ?? "",
            prn: med?.prn ?? false,
            psychotropic: med?.psychotropic ?? false,
            given,
          };
        })
        .sort((a, b) => a.name.localeCompare(b.name, "en-GB"));
      const sum = (pick: (m: (typeof byMedicine)[number]) => boolean) =>
        byMedicine.filter(pick).reduce((n, m) => n + m.given, 0);
      return {
        personId,
        prnGiven: sum((m) => m.prn),
        psychotropicGiven: sum((m) => m.psychotropic),
        psychotropicPrnGiven: sum((m) => m.prn && m.psychotropic),
        byMedicine,
      };
    })
    .sort((a, b) => (a.personId < b.personId ? -1 : a.personId > b.personId ? 1 : 0));
}
