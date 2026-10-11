import { hasReason, isCalendarDate } from "./dates";

/**
 * Pre-admission assessment and the decision to admit (master prompt section 9.2; Regulations 9
 * and 12; people.md section 4 rule 4). The assessment covers every section below before anyone
 * decides whether the home can meet the person's needs; the decision records the answer, the
 * reasons, any conditions that must be met before admission, and who decided. A decision is an
 * append-only record: changing it means recording a new decision that supersedes it.
 */

export interface PreAdmissionSectionDefinition {
  readonly key: string;
  readonly title: string;
  readonly required: boolean;
  /** False where "not applicable" would hide a safety fact (for example allergies). */
  readonly allowNotApplicable: boolean;
  readonly hazardIds: readonly string[];
}

export const PRE_ADMISSION_SECTIONS = [
  {
    key: "personal_details_and_contacts",
    title: "Personal details, contacts and legal representatives",
    required: true,
    allowNotApplicable: false,
    hazardIds: ["HZ-001"],
  },
  {
    key: "views_and_wishes",
    title: "The person's views and wishes, and how they took part",
    required: true,
    allowNotApplicable: false,
    hazardIds: [],
  },
  {
    key: "health_and_medical_history",
    title: "Health conditions and medical history",
    required: true,
    allowNotApplicable: false,
    hazardIds: [],
  },
  {
    key: "medicines",
    title: "Current medicines",
    required: true,
    allowNotApplicable: false,
    hazardIds: [],
  },
  {
    key: "allergies",
    title: "Allergies and adverse reactions",
    required: true,
    allowNotApplicable: false,
    hazardIds: ["HZ-007"],
  },
  {
    key: "communication",
    title: "Communication and information needs",
    required: true,
    allowNotApplicable: false,
    hazardIds: [],
  },
  {
    key: "mobility_and_falls",
    title: "Mobility, moving and handling, and falls",
    required: true,
    allowNotApplicable: false,
    hazardIds: [],
  },
  {
    key: "eating_drinking_and_swallowing",
    title: "Eating, drinking and swallowing (IDDSI levels)",
    required: true,
    allowNotApplicable: false,
    hazardIds: ["HZ-016"],
  },
  {
    key: "skin_integrity",
    title: "Skin integrity and pressure areas",
    required: true,
    allowNotApplicable: false,
    hazardIds: [],
  },
  {
    key: "continence_and_personal_care",
    title: "Continence and personal care",
    required: true,
    allowNotApplicable: false,
    hazardIds: [],
  },
  {
    key: "cognition_and_mental_health",
    title: "Memory, cognition and mental health",
    required: true,
    allowNotApplicable: false,
    hazardIds: [],
  },
  {
    key: "capacity_and_legal_status",
    title: "Mental capacity, DoLS status and legal authorities",
    required: true,
    allowNotApplicable: false,
    hazardIds: ["HZ-020"],
  },
  {
    key: "resuscitation_and_advance_care",
    title: "Resuscitation decisions and advance care plans",
    required: true,
    allowNotApplicable: false,
    hazardIds: ["HZ-015"],
  },
  {
    key: "infection_status",
    title: "Infection status",
    required: true,
    allowNotApplicable: false,
    hazardIds: [],
  },
  {
    key: "equipment",
    title: "Equipment needed",
    required: true,
    allowNotApplicable: true,
    hazardIds: [],
  },
  {
    key: "risks",
    title: "Risks to the person and others",
    required: true,
    allowNotApplicable: false,
    hazardIds: [],
  },
  {
    key: "dependency",
    title: "Dependency category",
    required: true,
    allowNotApplicable: false,
    hazardIds: [],
  },
  {
    key: "funding",
    title: "Funding",
    required: true,
    allowNotApplicable: false,
    hazardIds: [],
  },
  {
    key: "social_cultural_and_spiritual",
    title: "Social, cultural and spiritual needs",
    required: false,
    allowNotApplicable: true,
    hazardIds: [],
  },
  {
    key: "hospital_passport",
    title: "Hospital passport",
    required: false,
    allowNotApplicable: true,
    hazardIds: [],
  },
] as const satisfies readonly PreAdmissionSectionDefinition[];

export type PreAdmissionSectionKey = (typeof PRE_ADMISSION_SECTIONS)[number]["key"];

/** Shortest "not applicable" reason, decision reason or "not involved" explanation accepted. */
export const MIN_PRE_ADMISSION_REASON_LENGTH = 3;
/** Reasons for a decision to admit or decline are a sentence, never a word. */
export const MIN_ADMISSION_DECISION_REASON_LENGTH = 20;

export type PreAdmissionSectionState =
  | { readonly status: "in_progress" }
  | { readonly status: "complete"; readonly completedBy: string; readonly completedAt: Date }
  | {
      readonly status: "not_applicable";
      readonly reason: string;
      readonly completedBy: string;
      readonly completedAt: Date;
    };

export const INFORMATION_SOURCES = [
  "person",
  "family_or_representative",
  "hospital",
  "gp",
  "social_worker",
  "previous_provider",
  "other",
] as const;
export type InformationSource = (typeof INFORMATION_SOURCES)[number];

export interface PreAdmissionAssessment {
  readonly sections: Partial<Record<PreAdmissionSectionKey, PreAdmissionSectionState>>;
  /** Who the information came from; at least one. */
  readonly sources: readonly InformationSource[];
  /** How the person took part, or why they could not (Regulation 9). */
  readonly personInvolvement:
    | { readonly involved: true }
    | { readonly involved: false; readonly reason: string };
}

export type PreAdmissionSectionProblem =
  | "not_started"
  | "in_progress"
  | "not_applicable_not_allowed"
  | "not_applicable_reason_required";

export interface PreAdmissionCompleteness {
  readonly complete: boolean;
  /** Required sections not yet complete, in the order of `PRE_ADMISSION_SECTIONS`. */
  readonly outstanding: readonly {
    readonly key: PreAdmissionSectionKey;
    readonly problem: PreAdmissionSectionProblem;
  }[];
  readonly sourcesMissing: boolean;
  readonly involvementMissing: boolean;
  /** The latest completion time, which a decision may not precede. */
  readonly lastCompletedAt: Date | null;
}

function sectionProblem(
  definition: PreAdmissionSectionDefinition,
  state: PreAdmissionSectionState | undefined,
): PreAdmissionSectionProblem | null {
  if (!state) return definition.required ? "not_started" : null;
  if (state.status === "in_progress") return definition.required ? "in_progress" : null;
  if (state.status === "not_applicable") {
    if (!definition.allowNotApplicable) return "not_applicable_not_allowed";
    if (!hasReason(state.reason, MIN_PRE_ADMISSION_REASON_LENGTH)) {
      return "not_applicable_reason_required";
    }
  }
  return null;
}

/** Whether every required section is done, so that a decision can be made. */
export function preAdmissionCompleteness(
  assessment: PreAdmissionAssessment,
): PreAdmissionCompleteness {
  const outstanding: { key: PreAdmissionSectionKey; problem: PreAdmissionSectionProblem }[] = [];
  let lastCompletedAt: Date | null = null;
  for (const definition of PRE_ADMISSION_SECTIONS) {
    const state = assessment.sections[definition.key];
    const problem = sectionProblem(definition, state);
    if (problem) outstanding.push({ key: definition.key, problem });
    if (state && state.status !== "in_progress") {
      if (!lastCompletedAt || state.completedAt.getTime() > lastCompletedAt.getTime()) {
        lastCompletedAt = state.completedAt;
      }
    }
  }
  const sourcesMissing = assessment.sources.length === 0;
  const involvementMissing =
    !assessment.personInvolvement.involved &&
    !hasReason(assessment.personInvolvement.reason, MIN_PRE_ADMISSION_REASON_LENGTH);
  return {
    complete: outstanding.length === 0 && !sourcesMissing && !involvementMissing,
    outstanding,
    sourcesMissing,
    involvementMissing,
    lastCompletedAt,
  };
}

// ------------------------------------------------------------------------------------------------
// Decision to admit
// ------------------------------------------------------------------------------------------------

export type CanMeetNeeds = "yes" | "yes_with_conditions" | "no";

export interface AdmissionDecisionInput {
  readonly canMeetNeeds: CanMeetNeeds;
  /** Why the home can or cannot meet the person's needs. */
  readonly reasons: string;
  /** What must be in place before admission (for example a pressure-relieving mattress). */
  readonly conditions?: readonly string[];
  readonly decidedBy: string;
  readonly decidedAt: Date;
  /** The decider's effective permissions; deciding needs `people.admission.manage`. */
  readonly deciderPermissions: ReadonlySet<string>;
  /** Planned admission date (yyyy-mm-dd), when known. */
  readonly plannedAdmissionOn?: string | null;
  /** End of an agreed trial period (yyyy-mm-dd), for trial placements. */
  readonly trialEndsOn?: string | null;
}

export type AdmissionDecisionProblem =
  | "assessment_incomplete"
  | "reasons_required"
  | "conditions_required"
  | "conditions_blank"
  | "not_authorised"
  | "decided_before_assessment"
  | "invalid_date"
  | "trial_ends_before_admission";

export interface AdmissionDecision {
  readonly canMeetNeeds: CanMeetNeeds;
  /** True for "yes" and "yes with conditions". */
  readonly admit: boolean;
  readonly reasons: string;
  readonly conditions: readonly string[];
  readonly decidedBy: string;
  readonly decidedAt: Date;
  readonly plannedAdmissionOn: string | null;
  readonly trialEndsOn: string | null;
}

export type AdmissionDecisionCheck =
  | { readonly ok: true; readonly decision: AdmissionDecision }
  | {
      readonly ok: false;
      readonly problems: readonly AdmissionDecisionProblem[];
      readonly outstanding: PreAdmissionCompleteness["outstanding"];
    };

/**
 * Checks a "can we meet needs" decision against the assessment. All problems are returned at
 * once so the screen can show them together.
 */
export function checkAdmissionDecision(
  assessment: PreAdmissionAssessment,
  input: AdmissionDecisionInput,
): AdmissionDecisionCheck {
  const completeness = preAdmissionCompleteness(assessment);
  const problems: AdmissionDecisionProblem[] = [];
  if (!completeness.complete) problems.push("assessment_incomplete");
  if (!hasReason(input.reasons, MIN_ADMISSION_DECISION_REASON_LENGTH)) {
    problems.push("reasons_required");
  }
  const conditions = input.conditions ?? [];
  if (input.canMeetNeeds === "yes_with_conditions") {
    if (conditions.length === 0) problems.push("conditions_required");
    else if (conditions.some((c) => c.trim().length === 0)) problems.push("conditions_blank");
  }
  if (!input.deciderPermissions.has("people.admission.manage")) problems.push("not_authorised");
  if (
    completeness.lastCompletedAt &&
    input.decidedAt.getTime() < completeness.lastCompletedAt.getTime()
  ) {
    problems.push("decided_before_assessment");
  }
  const planned = input.plannedAdmissionOn ?? null;
  const trialEnds = input.trialEndsOn ?? null;
  if (
    (planned !== null && !isCalendarDate(planned)) ||
    (trialEnds !== null && !isCalendarDate(trialEnds))
  ) {
    problems.push("invalid_date");
  } else if (planned !== null && trialEnds !== null && trialEnds <= planned) {
    problems.push("trial_ends_before_admission");
  }
  if (problems.length > 0) return { ok: false, problems, outstanding: completeness.outstanding };
  return {
    ok: true,
    decision: {
      canMeetNeeds: input.canMeetNeeds,
      admit: input.canMeetNeeds !== "no",
      reasons: input.reasons.trim(),
      conditions:
        input.canMeetNeeds === "yes_with_conditions" ? conditions.map((c) => c.trim()) : [],
      decidedBy: input.decidedBy,
      decidedAt: input.decidedAt,
      plannedAdmissionOn: planned,
      trialEndsOn: trialEnds,
    },
  };
}
