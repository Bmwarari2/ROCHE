/**
 * Self-administration assessment and review (Phase 2 slice 38; medicines.md section 15.2;
 * MEDS-006; HZ-120). An assessment records the person's choice, their capacity for the decision,
 * their dexterity and the storage they have, and the level of support a person decided on, for the
 * medicines it lists. Harbour applies the organisation's rules to what was recorded; it never
 * assesses the person itself (NICE SC1 (2014) 1.13: assume a person can look after and take their
 * own medicines unless an individual risk assessment shows otherwise).
 */

import { addDaysToDate } from "../care/assessment";

export const SELF_ADMIN_RATE_KEYS = {
  reviewMaxDays: "medicines.self_admin.review_max_days",
} as const;

export const SELF_ADMIN_CHOICES = ["wants_to", "does_not_want_to"] as const;
export const SELF_ADMIN_CAPACITY = ["has_capacity", "lacks_capacity", "assumed"] as const;
export const SELF_ADMIN_DEXTERITY = ["able", "able_with_aids", "unable"] as const;
export const SELF_ADMIN_STORAGE = ["lockable_storage", "no_lockable_storage"] as const;
export const SELF_ADMIN_LEVELS = [
  "self_administers",
  "self_administers_with_support",
  "staff_administer",
] as const;
export type SelfAdminChoice = (typeof SELF_ADMIN_CHOICES)[number];
export type SelfAdminCapacity = (typeof SELF_ADMIN_CAPACITY)[number];
export type SelfAdminDexterity = (typeof SELF_ADMIN_DEXTERITY)[number];
export type SelfAdminStorage = (typeof SELF_ADMIN_STORAGE)[number];
export type SelfAdminLevel = (typeof SELF_ADMIN_LEVELS)[number];

export const SELF_ADMIN_LEVEL_WORDS: Record<SelfAdminLevel, string> = {
  self_administers: "Looks after and takes these medicines themselves",
  self_administers_with_support: "Takes these medicines themselves, with staff support",
  staff_administer: "Staff give these medicines",
};

export interface SelfAdminAssessmentInput {
  readonly choice: SelfAdminChoice;
  readonly capacity: SelfAdminCapacity;
  /** The capacity assessment, when capacity was assessed rather than assumed. */
  readonly capacityAssessment: {
    readonly personId: string;
    readonly outcome: "has_capacity" | "lacks_capacity";
    readonly superseded: boolean;
  } | null;
  readonly personId: string;
  readonly dexterity: SelfAdminDexterity;
  readonly storage: SelfAdminStorage;
  readonly level: SelfAdminLevel;
  /** The medicines entries (stable medicine ids) it covers. */
  readonly medicineIds: readonly string[];
  readonly assessedOn: string;
  readonly reviewOn: string;
}

export type SelfAdminProblem =
  | "no_medicines"
  | "not_their_choice"
  | "lacks_capacity"
  | "capacity_needs_assessment"
  | "capacity_assessment_mismatch"
  | "unable_to_handle"
  | "no_lockable_storage"
  | "assessed_in_future"
  | "review_not_after_assessment"
  | "review_too_far";

export const SELF_ADMIN_PROBLEM_WORDS: Record<SelfAdminProblem, string> = {
  no_medicines: "Choose the medicines this assessment covers.",
  not_their_choice:
    "A person who does not want to look after their own medicines is not asked to: choose that staff give them.",
  lacks_capacity:
    "A person found to lack capacity for this decision does not look after their own medicines: choose that staff give them.",
  capacity_needs_assessment: "Link the capacity assessment, or record capacity as assumed.",
  capacity_assessment_mismatch:
    "The capacity assessment linked is not this person's current one, or says something else.",
  unable_to_handle:
    "The assessment found the person cannot handle these medicines: choose that staff give them.",
  no_lockable_storage: "Medicines kept by the person need lockable storage in their room.",
  assessed_in_future: "The assessment cannot be dated in the future.",
  review_not_after_assessment: "The review must be after the assessment.",
  review_too_far: "The review is further away than your organisation allows.",
};

/** Every problem with an assessment; empty when it may be stored. */
export function checkSelfAdminAssessment(
  input: SelfAdminAssessmentInput,
  context: { readonly today: string; readonly reviewMaxDays: number },
): SelfAdminProblem[] {
  const problems: SelfAdminProblem[] = [];
  if (input.medicineIds.length === 0) problems.push("no_medicines");
  const selfAdministers = input.level !== "staff_administer";
  if (input.capacity === "assumed") {
    if (input.capacityAssessment) problems.push("capacity_assessment_mismatch");
  } else if (!input.capacityAssessment) problems.push("capacity_needs_assessment");
  else if (
    input.capacityAssessment.personId !== input.personId ||
    input.capacityAssessment.superseded ||
    input.capacityAssessment.outcome !== input.capacity
  )
    problems.push("capacity_assessment_mismatch");
  if (selfAdministers) {
    if (input.choice !== "wants_to") problems.push("not_their_choice");
    if (input.capacity === "lacks_capacity") problems.push("lacks_capacity");
    if (input.dexterity === "unable") problems.push("unable_to_handle");
    if (input.storage !== "lockable_storage") problems.push("no_lockable_storage");
  }
  if (input.assessedOn > context.today) problems.push("assessed_in_future");
  if (input.reviewOn <= input.assessedOn) problems.push("review_not_after_assessment");
  else if (input.reviewOn > addDaysToDate(input.assessedOn, context.reviewMaxDays))
    problems.push("review_too_far");
  return problems;
}

export type SelfAdminStatus = "current" | "review_overdue" | "not_assessed";

/**
 * Where a medicine stands on a UK date: the person's latest assessment that lists it decides.
 * `level` is null when no assessment lists it.
 */
export function selfAdminStatus(
  assessments: readonly {
    readonly assessedOn: string;
    readonly recordedAt: Date;
    readonly reviewOn: string;
    readonly level: SelfAdminLevel;
    readonly medicineIds: readonly string[];
  }[],
  medicineId: string,
  today: string,
): { readonly status: SelfAdminStatus; readonly level: SelfAdminLevel | null } {
  const latest = [...assessments]
    .filter((a) => a.medicineIds.includes(medicineId) && a.assessedOn <= today)
    .sort(
      (a, b) =>
        b.assessedOn.localeCompare(a.assessedOn) || b.recordedAt.getTime() - a.recordedAt.getTime(),
    )[0];
  if (!latest) return { status: "not_assessed", level: null };
  return {
    status: today > latest.reviewOn ? "review_overdue" : "current",
    level: latest.level,
  };
}

/**
 * What a dose recorded as taken by the person themselves carries: nothing under a current
 * assessment that has them self-administering; a flag when its review is overdue; a flag and an
 * escalation when no assessment has them self-administering. The record is never refused: the dose
 * was taken (HZ-004); the escalation brings it to a person (HZ-120, H-1353).
 */
export function selfAdminDoseFlags(state: {
  readonly status: SelfAdminStatus;
  readonly level: SelfAdminLevel | null;
}): {
  readonly flag: "self_admin_not_assessed" | "self_admin_review_overdue";
  readonly escalate: boolean;
} | null {
  if (state.level === null || state.level === "staff_administer")
    return { flag: "self_admin_not_assessed", escalate: true };
  if (state.status === "review_overdue")
    return { flag: "self_admin_review_overdue", escalate: false };
  return null;
}
