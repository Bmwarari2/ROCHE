/**
 * Mental capacity assessment (care.md section 4 rule 9; CARE-021; master prompt 10.4). The two-stage
 * test from the Mental Capacity Act 2005 (legislation.gov.uk, read 11 October 2026):
 *
 * - s.1(2) "A person must be assumed to have capacity unless it is established that he lacks
 *   capacity." s.1(3) "A person is not to be treated as unable to make a decision unless all
 *   practicable steps to help him to do so have been taken without success." s.1(4) an unwise
 *   decision is not enough.
 * - Stage 1, s.2(1): "an impairment of, or a disturbance in the functioning of, the mind or brain".
 * - Stage 2, s.3(1): unable "(a) to understand the information relevant to the decision, (b) to
 *   retain that information, (c) to use or weigh that information as part of the process of making
 *   the decision, or (d) to communicate his decision (whether by talking, using sign language or
 *   any other means)".
 * - s.2(1) "because of": the inability must be caused by the impairment or disturbance.
 *
 * An assessment is about one decision at one time. Harbour records it and checks that the outcome
 * follows from the answers; the assessor makes the judgement.
 */

import { type Citation, cite, SOURCES } from "../../shared/citation";
import { type InputIssue, isIsoDate } from "../assessment";
import { CONSENT_DECISION_KINDS, type ConsentDecisionKind } from "./consent";

export const FUNCTIONAL_ELEMENTS = ["understand", "retain", "useOrWeigh", "communicate"] as const;
export type FunctionalElement = (typeof FUNCTIONAL_ELEMENTS)[number];

/** The words of s.3(1), for the screen. */
export const FUNCTIONAL_ELEMENT_WORDING: Readonly<Record<FunctionalElement, string>> = {
  understand: "understand the information relevant to the decision",
  retain: "retain that information",
  useOrWeigh: "use or weigh that information as part of the process of making the decision",
  communicate:
    "communicate his decision (whether by talking, using sign language or any other means)",
};

export const STAGE_1_WORDING =
  "an impairment of, or a disturbance in the functioning of, the mind or brain";

export const CAPACITY_SOURCES: readonly Citation[] = [
  cite("Mental Capacity Act 2005", "s.1", SOURCES.mcaS1),
  cite("Mental Capacity Act 2005", "s.2", SOURCES.mcaS2),
  cite("Mental Capacity Act 2005", "s.3", SOURCES.mcaS3),
];

/** Kinds of support given to help the person decide (s.1(3), s.3(2)). */
export const PRACTICABLE_STEPS = [
  "simple_language",
  "visual_aids",
  "best_time_or_place",
  "interpreter_or_communication_aid",
  "trusted_person_present",
  "information_repeated",
  "other",
] as const;
export type PracticableStep = (typeof PRACTICABLE_STEPS)[number];

export interface PracticableStepRecord {
  readonly step: PracticableStep;
  readonly detail: string;
}

export interface FunctionalAnswer {
  /** True when the person is able to do this; false when unable. */
  readonly able: boolean | null;
  readonly evidence?: string | null;
}

export type CapacityOutcome = "has_capacity" | "lacks_capacity";

export interface CapacityAssessmentInput {
  /** The decision in words, for example "whether to have bed rails on their bed at night". */
  readonly decision: string;
  /** Set when the decision is one of the consent decisions, so consent rules can find it. */
  readonly decisionKind?: ConsentDecisionKind | null;
  readonly assessedAt: Date | null;
  readonly assessorId: string | null;
  readonly practicableSteps: readonly PracticableStepRecord[];
  readonly stage1: { readonly impairment: boolean | null; readonly description?: string | null };
  readonly stage2: Partial<Record<FunctionalElement, FunctionalAnswer>>;
  /** s.2(1): the inability is because of the impairment or disturbance. */
  readonly inabilityBecauseOfImpairment?: boolean | null;
  readonly outcome: CapacityOutcome | null;
  /** ISO date for review. */
  readonly reviewOn?: string | null;
}

export type CapacityCheck =
  | {
      readonly ok: true;
      readonly outcome: CapacityOutcome;
      readonly unableTo: readonly FunctionalElement[];
      /** Why, in the Act's words, for the record. */
      readonly reason: string;
    }
  | { readonly ok: false; readonly issues: readonly InputIssue[]; readonly message: string };

/** Phrases that describe a general state rather than one decision (rule 9: decision-specific). */
const GENERIC_DECISIONS = [
  "all decisions",
  "any decision",
  "everything",
  "general",
  "generally",
  "overall capacity",
  "capacity",
  "care and treatment",
  "all care",
];

const isBlank = (text: string | null | undefined) => !text || text.trim().length === 0;

function isGenericDecision(decision: string): boolean {
  const words = decision
    .trim()
    .toLowerCase()
    .replace(/[.!]+$/, "");
  return GENERIC_DECISIONS.includes(words);
}

/**
 * Checks a capacity assessment before it is saved. `now` guards against an assessment dated in the
 * future (time-specific). Missing answers and outcomes that do not follow from them are refused.
 */
export function checkCapacityAssessment(input: CapacityAssessmentInput, now: Date): CapacityCheck {
  const issues: InputIssue[] = [];
  const add = (item: string, problem: InputIssue["problem"], message: string) =>
    issues.push({ item, problem, message });

  if (isBlank(input.decision)) add("decision", "missing", "Say which decision was assessed.");
  else if (isGenericDecision(input.decision)) {
    add(
      "decision",
      "not_allowed",
      "Capacity is assessed for one decision at a time. Name the specific decision.",
    );
  }
  if (input.decisionKind != null && !CONSENT_DECISION_KINDS.includes(input.decisionKind)) {
    add("decisionKind", "not_allowed", "Choose a decision from the list.");
  }
  if (!input.assessedAt) add("assessedAt", "missing", "Say when the assessment took place.");
  else if (input.assessedAt.getTime() > now.getTime()) {
    add("assessedAt", "out_of_range", "An assessment cannot be dated in the future.");
  }
  if (isBlank(input.assessorId))
    add("assessorId", "missing", "Say who carried out the assessment.");
  if (input.reviewOn != null && !isIsoDate(input.reviewOn)) {
    add("reviewOn", "not_allowed", "The review date must be a real date.");
  }
  input.practicableSteps.forEach((s, i) => {
    if (!PRACTICABLE_STEPS.includes(s.step))
      add(`practicableSteps.${i}`, "not_allowed", "Choose a step from the list.");
    if (isBlank(s.detail))
      add(`practicableSteps.${i}`, "missing", "Describe what was done to help the person decide.");
  });

  const impairment = input.stage1.impairment;
  if (impairment === null) {
    add("stage1.impairment", "missing", `Answer stage 1: is there ${STAGE_1_WORDING}?`);
  } else if (impairment && isBlank(input.stage1.description)) {
    add("stage1.description", "missing", "Describe the impairment or disturbance.");
  }

  const unableTo: FunctionalElement[] = [];
  if (impairment === true) {
    for (const element of FUNCTIONAL_ELEMENTS) {
      const answer = input.stage2[element];
      if (answer?.able === null || answer?.able === undefined) {
        add(
          `stage2.${element}`,
          "missing",
          `Answer stage 2: can the person ${FUNCTIONAL_ELEMENT_WORDING[element]}?`,
        );
      } else if (!answer.able) {
        unableTo.push(element);
        if (isBlank(answer.evidence)) {
          add(`stage2.${element}.evidence`, "missing", "Record the evidence for this answer.");
        }
      }
    }
    if (unableTo.length > 0 && input.inabilityBecauseOfImpairment == null) {
      add(
        "inabilityBecauseOfImpairment",
        "missing",
        "Say whether the person is unable to decide because of the impairment or disturbance.",
      );
    }
  }

  // Assume capacity: lacking it is established only by stage 1 met, a stage 2 element not met,
  // and the inability caused by the impairment (s.1(2), s.2(1), s.3(1)).
  const lacks =
    impairment === true && unableTo.length > 0 && input.inabilityBecauseOfImpairment === true;
  const derived: CapacityOutcome = lacks ? "lacks_capacity" : "has_capacity";
  if (input.outcome === null) add("outcome", "missing", "Record the outcome of the assessment.");
  else if (issues.length === 0 && input.outcome !== derived) {
    add(
      "outcome",
      "not_allowed",
      derived === "has_capacity"
        ? "The answers do not establish that the person lacks capacity: capacity must be assumed unless stage 1 is met and the person is unable to make the decision because of it."
        : "The answers show the person is unable to make this decision because of an impairment or disturbance. Check the answers or record that they lack capacity.",
    );
  }
  if (derived === "lacks_capacity" && input.practicableSteps.length === 0) {
    add(
      "practicableSteps",
      "missing",
      "Record the practicable steps taken to help the person decide before finding that they lack capacity.",
    );
  }

  if (issues.length > 0) {
    const missing = issues.filter((i) => i.problem === "missing").length;
    return {
      ok: false,
      issues,
      message:
        missing > 0
          ? `Assessment incomplete: ${missing} ${missing === 1 ? "answer" : "answers"} missing.`
          : "Assessment not saved: check the answers.",
    };
  }
  const reason = lacks
    ? `Lacks capacity for this decision: ${STAGE_1_WORDING}, and unable to ${unableTo.map((e) => FUNCTIONAL_ELEMENT_WORDING[e]).join("; ")} because of it (Mental Capacity Act 2005 s.2(1) and s.3(1))`
    : impairment === false
      ? "Has capacity for this decision: stage 1 is not met (Mental Capacity Act 2005 s.1(2) and s.2(1))"
      : unableTo.length === 0
        ? "Has capacity for this decision: able to understand, retain, use or weigh the information and communicate the decision (Mental Capacity Act 2005 s.1(2) and s.3(1))"
        : "Has capacity for this decision: the inability is not because of the impairment or disturbance (Mental Capacity Act 2005 s.1(2) and s.2(1))";
  return { ok: true, outcome: derived, unableTo, reason };
}

/** A saved assessment, as the consent and best-interests rules read it. */
export interface CapacityAssessmentView {
  readonly id: string;
  readonly decisionKind: ConsentDecisionKind | null;
  readonly assessedAt: Date;
  readonly outcome: CapacityOutcome;
  readonly reviewOn: string | null;
}

export type CapacityFinding =
  | { readonly status: "assumed" }
  | {
      readonly status: CapacityOutcome;
      readonly assessment: CapacityAssessmentView;
      /** The review date has passed: the finding is about an earlier time (time-specific). */
      readonly reviewOverdue: boolean;
    };

/**
 * The person's capacity for one decision at a time: the latest assessment of that decision made by
 * then, or assumed capacity when there is none (s.1(2)). An assessment of a different decision
 * never counts (decision-specific).
 */
export function capacityFinding(
  assessments: readonly CapacityAssessmentView[],
  decisionKind: ConsentDecisionKind,
  at: Date,
  todayIso: string,
): CapacityFinding {
  const latest = assessments
    .filter((a) => a.decisionKind === decisionKind && a.assessedAt.getTime() <= at.getTime())
    .sort((a, b) => b.assessedAt.getTime() - a.assessedAt.getTime())[0];
  if (!latest) return { status: "assumed" };
  return {
    status: latest.outcome,
    assessment: latest,
    reviewOverdue: latest.reviewOn !== null && latest.reviewOn < todayIso,
  };
}
