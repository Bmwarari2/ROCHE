import { hasReason, isCalendarDate } from "./dates";
import type { BedMovePlan } from "./occupancy";
import type { AdmissionDecision } from "./pre-admission";

/**
 * Admission (master prompt section 9.2; people.md section 4 rules 5 and 6): a positive decision
 * with its conditions met, a placement, and for residential and nursing placements a free bed.
 * Then the welcome checklist, which a tenant may extend but never strip of its safety-critical
 * items (configurable, never forked).
 */

export const PLACEMENT_TYPES = ["permanent", "respite", "trial", "package"] as const;
export type PlacementType = (typeof PLACEMENT_TYPES)[number];

export interface AdmissionReadinessInput {
  readonly decision: AdmissionDecision | null;
  /** One entry per decision condition: true once it has been confirmed as met. */
  readonly conditionsMet: readonly boolean[];
  readonly placement: {
    readonly type: PlacementType;
    /** yyyy-mm-dd */
    readonly startDate: string;
    /** yyyy-mm-dd; required for a trial placement. */
    readonly trialEndsOn?: string | null;
  };
  /** The result of `planBedMove` for the admission; null for a domiciliary or supported-living package. */
  readonly bed: BedMovePlan | null;
}

export type AdmissionReadinessProblem =
  | "no_decision"
  | "decision_declined"
  | "conditions_not_met"
  | "invalid_start_date"
  | "trial_end_required"
  | "trial_ends_before_start"
  | "bed_required"
  | "bed_not_available";

export type AdmissionReadiness =
  | { readonly ready: true }
  | { readonly ready: false; readonly problems: readonly AdmissionReadinessProblem[] };

/** Whether an admission can be recorded (feeds `admissionReady` in the lifecycle check). */
export function checkAdmissionReadiness(input: AdmissionReadinessInput): AdmissionReadiness {
  const problems: AdmissionReadinessProblem[] = [];
  const { decision, placement } = input;
  if (!decision) problems.push("no_decision");
  else if (!decision.admit) problems.push("decision_declined");
  else if (
    input.conditionsMet.length < decision.conditions.length ||
    input.conditionsMet.slice(0, decision.conditions.length).some((met) => !met)
  ) {
    problems.push("conditions_not_met");
  }
  if (!isCalendarDate(placement.startDate)) problems.push("invalid_start_date");
  if (placement.type === "trial") {
    const ends = placement.trialEndsOn ?? decision?.trialEndsOn ?? null;
    if (!ends || !isCalendarDate(ends)) problems.push("trial_end_required");
    else if (isCalendarDate(placement.startDate) && ends <= placement.startDate) {
      problems.push("trial_ends_before_start");
    }
  }
  if (placement.type !== "package") {
    if (!input.bed) problems.push("bed_required");
    else if (!input.bed.ok) problems.push("bed_not_available");
  }
  return problems.length === 0 ? { ready: true } : { ready: false, problems };
}

// ------------------------------------------------------------------------------------------------
// Welcome checklist
// ------------------------------------------------------------------------------------------------

export interface WelcomeChecklistItemDefinition {
  readonly key: string;
  readonly title: string;
  readonly required: boolean;
  /** Safety-critical items cannot be removed by a tenant and are listed first when outstanding. */
  readonly safetyCritical: boolean;
  readonly allowNotApplicable: boolean;
  readonly hazardIds: readonly string[];
}

/** Harbour's default welcome checklist; tenants add their own items. */
export const DEFAULT_WELCOME_CHECKLIST: readonly WelcomeChecklistItemDefinition[] = [
  {
    key: "photo_taken",
    title: "Photo taken for identification",
    required: true,
    safetyCritical: true,
    allowNotApplicable: true,
    hazardIds: ["HZ-001"],
  },
  {
    key: "allergies_confirmed",
    title: "Allergies confirmed and recorded",
    required: true,
    safetyCritical: true,
    allowNotApplicable: false,
    hazardIds: ["HZ-007"],
  },
  {
    key: "medicines_received_and_checked",
    title: "Medicines received and checked against the list",
    required: true,
    safetyCritical: true,
    allowNotApplicable: false,
    hazardIds: ["HZ-005"],
  },
  {
    key: "diet_and_textures_shared_with_kitchen",
    title: "Diet, allergens and IDDSI levels shared with the kitchen",
    required: true,
    safetyCritical: true,
    allowNotApplicable: false,
    hazardIds: ["HZ-016"],
  },
  {
    key: "evacuation_plan_completed",
    title: "Personal emergency evacuation plan completed",
    required: true,
    safetyCritical: true,
    allowNotApplicable: false,
    hazardIds: [],
  },
  {
    key: "call_bell_explained",
    title: "Call bell explained and within reach",
    required: true,
    safetyCritical: false,
    allowNotApplicable: true,
    hazardIds: [],
  },
  {
    key: "room_and_home_shown",
    title: "Room and home shown",
    required: true,
    safetyCritical: false,
    allowNotApplicable: true,
    hazardIds: [],
  },
  {
    key: "key_worker_introduced",
    title: "Key worker introduced",
    required: true,
    safetyCritical: false,
    allowNotApplicable: false,
    hazardIds: [],
  },
  {
    key: "contacts_confirmed",
    title: "Contacts and legal representatives confirmed",
    required: true,
    safetyCritical: false,
    allowNotApplicable: false,
    hazardIds: [],
  },
  {
    key: "property_inventory_started",
    title: "Personal property inventory started",
    required: true,
    safetyCritical: false,
    allowNotApplicable: true,
    hazardIds: [],
  },
  {
    key: "privacy_information_given",
    title: "Privacy information given to the person or their representative",
    required: true,
    safetyCritical: false,
    allowNotApplicable: false,
    hazardIds: [],
  },
  {
    key: "gp_registration_arranged",
    title: "GP registration confirmed or arranged",
    required: true,
    safetyCritical: false,
    allowNotApplicable: false,
    hazardIds: [],
  },
  {
    key: "keys_issued",
    title: "Room or locker keys issued",
    required: false,
    safetyCritical: false,
    allowNotApplicable: true,
    hazardIds: [],
  },
  {
    key: "about_me_started",
    title: "About Me started with the person",
    required: false,
    safetyCritical: false,
    allowNotApplicable: true,
    hazardIds: [],
  },
];

export type ChecklistItemState =
  | { readonly status: "pending" }
  | { readonly status: "done"; readonly by: string; readonly at: Date }
  | {
      readonly status: "not_applicable";
      readonly reason: string;
      readonly by: string;
      readonly at: Date;
    };

export const MIN_CHECKLIST_REASON_LENGTH = 3;

export type WelcomeChecklistDefinitionProblem =
  | { readonly kind: "duplicate_key"; readonly key: string }
  | { readonly kind: "safety_item_missing"; readonly key: string }
  | { readonly kind: "safety_item_weakened"; readonly key: string };

/**
 * Checks a tenant's checklist: every default safety-critical item must still be there, still
 * required and no more lenient about "not applicable" than the default.
 */
export function checkWelcomeChecklistDefinition(
  items: readonly WelcomeChecklistItemDefinition[],
): WelcomeChecklistDefinitionProblem[] {
  const problems: WelcomeChecklistDefinitionProblem[] = [];
  const seen = new Set<string>();
  for (const item of items) {
    if (seen.has(item.key)) problems.push({ kind: "duplicate_key", key: item.key });
    seen.add(item.key);
  }
  for (const safety of DEFAULT_WELCOME_CHECKLIST.filter((i) => i.safetyCritical)) {
    const item = items.find((i) => i.key === safety.key);
    if (!item) problems.push({ kind: "safety_item_missing", key: safety.key });
    else if (
      !item.required ||
      !item.safetyCritical ||
      (item.allowNotApplicable && !safety.allowNotApplicable)
    ) {
      problems.push({ kind: "safety_item_weakened", key: safety.key });
    }
  }
  return problems;
}

export interface ChecklistStatus {
  readonly complete: boolean;
  /** Required items not yet done, safety-critical ones first. */
  readonly outstanding: readonly string[];
  readonly safetyCriticalOutstanding: readonly string[];
  /** Items whose recorded state is not acceptable (for example "not applicable" where it is not allowed). */
  readonly invalid: readonly string[];
}

function itemSatisfied(
  definition: WelcomeChecklistItemDefinition,
  state: ChecklistItemState | undefined,
): "done" | "pending" | "invalid" {
  if (!state || state.status === "pending") return "pending";
  if (state.status === "done") return "done";
  if (!definition.allowNotApplicable || !hasReason(state.reason, MIN_CHECKLIST_REASON_LENGTH)) {
    return "invalid";
  }
  return "done";
}

/** How far the welcome checklist has got. */
export function welcomeChecklistStatus(
  definition: readonly WelcomeChecklistItemDefinition[],
  states: Readonly<Record<string, ChecklistItemState>>,
): ChecklistStatus {
  const outstanding: string[] = [];
  const safetyCriticalOutstanding: string[] = [];
  const invalid: string[] = [];
  const ordered = [
    ...definition.filter((d) => d.safetyCritical),
    ...definition.filter((d) => !d.safetyCritical),
  ];
  for (const item of ordered) {
    const result = itemSatisfied(item, states[item.key]);
    if (result === "invalid") invalid.push(item.key);
    if (result !== "done" && item.required) {
      outstanding.push(item.key);
      if (item.safetyCritical) safetyCriticalOutstanding.push(item.key);
    }
  }
  return {
    complete: outstanding.length === 0,
    outstanding,
    safetyCriticalOutstanding,
    invalid,
  };
}
