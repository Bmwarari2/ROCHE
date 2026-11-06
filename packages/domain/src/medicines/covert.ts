/**
 * Covert administration of medicines (Phase 2 slice 38; medicines.md section 15.1; MEDS-004;
 * HZ-026). A covert record is per medicine and stands on a capacity assessment that found the
 * person lacks capacity for the decision about covert medicines, and a best-interests decision
 * after it, made with the prescriber and a pharmacist (NICE SC1 (2014) 1.15.3). Harbour stores and
 * applies the tenant's record; it never recommends covert administration or a method.
 */

import { addDaysToDate } from "../care/assessment";

/** Figures read from the rate table (rates.md), never literals. */
export const COVERT_RATE_KEYS = {
  reviewMaxDays: "medicines.covert.review_max_days",
} as const;

export const COVERT_ATTENDEE_ROLES = [
  "prescriber",
  "pharmacist",
  "registered_manager",
  "nurse",
  "care_staff",
  "family_or_friend",
  "representative",
  "advocate",
  "other",
] as const;
export type CovertAttendeeRole = (typeof COVERT_ATTENDEE_ROLES)[number];

export const COVERT_ATTENDEE_ROLE_WORDS: Record<CovertAttendeeRole, string> = {
  prescriber: "Prescriber",
  pharmacist: "Pharmacist",
  registered_manager: "Registered Manager",
  nurse: "Nurse",
  care_staff: "Care staff",
  family_or_friend: "Family member or friend",
  representative: "Representative (attorney or deputy)",
  advocate: "Advocate (IMCA or other)",
  other: "Other",
};

export interface CovertAttendee {
  readonly role: CovertAttendeeRole;
  readonly name: string;
}

export interface CovertRecordInput {
  readonly personId: string;
  /** The capacity assessment the record stands on, as stored. */
  readonly capacity: {
    readonly personId: string;
    readonly outcome: "has_capacity" | "lacks_capacity";
    readonly decisionKind: string | null;
    /** True when a later assessment corrects it. */
    readonly superseded: boolean;
  } | null;
  /** The best-interests decision, as stored. */
  readonly bestInterests: {
    readonly personId: string;
    readonly capacityAssessmentId: string;
    readonly decidedOn: string;
    readonly superseded: boolean;
  } | null;
  readonly capacityAssessmentId: string;
  readonly attendees: readonly CovertAttendee[];
  /** How it is given, in the pharmacist's and prescriber's words (for example "in yoghurt"). */
  readonly method: string;
  /** The pharmacist's advice on giving it this way (crushing, food, timing). */
  readonly pharmacistAdvice: string | null;
  readonly startsOn: string;
  readonly reviewOn: string;
}

export type CovertRecordProblem =
  | "no_capacity_assessment"
  | "capacity_other_person"
  | "capacity_superseded"
  | "capacity_not_lacking"
  | "capacity_other_decision"
  | "no_best_interests_decision"
  | "best_interests_other_assessment"
  | "best_interests_superseded"
  | "prescriber_not_involved"
  | "pharmacist_not_involved"
  | "method_missing"
  | "pharmacist_advice_missing"
  | "starts_before_decision"
  | "review_not_after_start"
  | "review_too_far"
  | "review_in_past";

export const COVERT_RECORD_PROBLEM_WORDS: Record<CovertRecordProblem, string> = {
  no_capacity_assessment: "Link the capacity assessment for this decision.",
  capacity_other_person: "The capacity assessment is about someone else.",
  capacity_superseded: "The capacity assessment has been corrected: link the current one.",
  capacity_not_lacking:
    "Medicines must not be given covertly to a person who has capacity to make decisions about their treatment and care.",
  capacity_other_decision:
    "The capacity assessment must be about giving medicines covertly, not another decision.",
  no_best_interests_decision: "Link the best-interests decision for giving medicines covertly.",
  best_interests_other_assessment:
    "The best-interests decision must follow the capacity assessment linked here.",
  best_interests_superseded:
    "The best-interests decision has been corrected: link the current one.",
  prescriber_not_involved: "The prescriber must be part of the best-interests decision.",
  pharmacist_not_involved:
    "A pharmacist must be part of the decision, to advise how the medicine can be given.",
  method_missing: "Say how the medicine is given covertly.",
  pharmacist_advice_missing: "Record the pharmacist's advice on giving the medicine this way.",
  starts_before_decision: "It cannot start before the best-interests decision was made.",
  review_not_after_start: "The review must be after the start.",
  review_too_far: "The review is further away than your organisation allows.",
  review_in_past: "The review date has passed: choose a date from today.",
};

/** Every problem with a covert record; empty when it may be stored. */
export function checkCovertRecord(
  input: CovertRecordInput,
  context: { readonly today: string; readonly reviewMaxDays: number },
): CovertRecordProblem[] {
  const problems: CovertRecordProblem[] = [];
  const cap = input.capacity;
  if (!cap) problems.push("no_capacity_assessment");
  else {
    if (cap.personId !== input.personId) problems.push("capacity_other_person");
    if (cap.superseded) problems.push("capacity_superseded");
    if (cap.outcome !== "lacks_capacity") problems.push("capacity_not_lacking");
    if (cap.decisionKind !== "covert_medicines") problems.push("capacity_other_decision");
  }
  const bi = input.bestInterests;
  if (!bi) problems.push("no_best_interests_decision");
  else {
    if (bi.personId !== input.personId || bi.capacityAssessmentId !== input.capacityAssessmentId)
      problems.push("best_interests_other_assessment");
    if (bi.superseded) problems.push("best_interests_superseded");
    if (input.startsOn < bi.decidedOn) problems.push("starts_before_decision");
  }
  const roles = new Set(input.attendees.filter((a) => a.name.trim() !== "").map((a) => a.role));
  if (!roles.has("prescriber")) problems.push("prescriber_not_involved");
  if (!roles.has("pharmacist")) problems.push("pharmacist_not_involved");
  if (input.method.trim() === "") problems.push("method_missing");
  if (!input.pharmacistAdvice || input.pharmacistAdvice.trim() === "")
    problems.push("pharmacist_advice_missing");
  if (input.reviewOn <= input.startsOn) problems.push("review_not_after_start");
  else if (input.reviewOn > addDaysToDate(input.startsOn, context.reviewMaxDays))
    problems.push("review_too_far");
  if (input.reviewOn < context.today) problems.push("review_in_past");
  return problems;
}

export type CovertStatus = "not_started" | "current" | "review_overdue" | "basis_changed" | "ended";

export const COVERT_STATUS_WORDS: Record<CovertStatus, string> = {
  not_started: "Covert record not started yet",
  current: "Covert administration agreed",
  review_overdue: "Covert record review overdue",
  basis_changed:
    "The capacity assessment or best-interests decision behind this record has changed: review it now",
  ended: "Covert record ended",
};

/**
 * The status of one covert record on a UK date. `basisChanged` is true when its capacity
 * assessment or best-interests decision has since been corrected, or a later assessment of covert
 * medicines finds capacity: the record no longer covers a dose (NICE SC1 1.15.1; HZ-026).
 */
export function covertStatus(
  record: {
    readonly startsOn: string;
    readonly reviewOn: string;
    readonly endedOn: string | null;
    readonly basisChanged?: boolean;
  },
  today: string,
): CovertStatus {
  if (record.endedOn !== null && record.endedOn <= today) return "ended";
  if (record.basisChanged) return "basis_changed";
  if (today < record.startsOn) return "not_started";
  if (today > record.reviewOn) return "review_overdue";
  return "current";
}

/**
 * What a dose marked covert carries: nothing when a current record covers the medicine; a flag and
 * an urgent escalation when none does; a flag and an escalation when its review is overdue. The
 * dose is never refused: it has happened, and the record must say so (HZ-004); the escalation
 * brings the decision back to a person (HZ-026, H-1351).
 */
export function covertDoseFlags(statuses: readonly CovertStatus[]): {
  readonly flag: "covert_without_record" | "covert_review_overdue";
  readonly urgent: boolean;
} | null {
  if (statuses.includes("current")) return null;
  if (statuses.includes("review_overdue")) return { flag: "covert_review_overdue", urgent: false };
  return { flag: "covert_without_record", urgent: true };
}
