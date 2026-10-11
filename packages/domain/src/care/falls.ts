/**
 * The NICE NG249 falls pathway (care.md section 4 rule 5): who is offered a comprehensive falls
 * assessment, and why. NG249 1.1.1: "Do not use falls risk prediction tools to predict a person's
 * risk of falling." So this produces no score, band or risk level of any kind (medical-device
 * boundary, section 4); it records the answers, names the recommendation that applies and raises
 * the follow-up tasks. The assessment itself is a structured form completed by staff.
 *
 * Source: NICE guideline NG249, Falls: assessment and prevention in older people and in people 50
 * and over at higher risk (29 April 2025), recommendations 1.1.1 to 1.1.7, wording as published.
 * https://www.nice.org.uk/guidance/ng249
 *
 * - Residential care settings (care homes, residential and nursing): 1.1.7, offer a comprehensive
 *   falls assessment to everyone, on admission and at review (and after a fall).
 * - Community settings (home care, supported living): 1.1.2 asks about falls in the last year or
 *   when a person presents after a fall; 1.1.3 offers a comprehensive falls assessment when a
 *   person has fallen in the last year and meets any of its criteria; 1.1.4 assesses gait and
 *   balance when they meet none; 1.1.6 covers people who have not fallen in the last year.
 */

import { type CareTrigger, InputCheck, type ToolOutcome } from "./assessment";

export const NG249_VERSION = "nice-ng249-2025";

export type FallsSetting = "residential" | "community";

/** Residential settings: when the assessment is being offered. */
export type ResidentialFallsOccasion = "admission" | "review" | "after_fall";

const OCCASION_WORDS: Readonly<Record<ResidentialFallsOccasion, string>> = {
  admission: "on admission",
  review: "at review",
  after_fall: "after a fall",
};

/** NG249 1.1.3: the criteria for a comprehensive falls assessment after a fall in the last year. */
export interface FallsCriteria {
  readonly livingWithFrailty?: boolean | null;
  readonly injuredAndNeededMedicalTreatment?: boolean | null;
  readonly lostConsciousness?: boolean | null;
  readonly unableToGetUpIndependently?: boolean | null;
  readonly twoOrMoreFallsInLastYear?: boolean | null;
}

export type FallsCriterion = keyof FallsCriteria;

const CRITERIA: Readonly<Record<FallsCriterion, string>> = {
  livingWithFrailty: "are living with frailty",
  injuredAndNeededMedicalTreatment:
    "were injured in a fall and needed medical (including surgical) treatment",
  lostConsciousness: "have experienced a loss of consciousness related to a fall",
  unableToGetUpIndependently: "have been unable to get up independently after a fall",
  twoOrMoreFallsInLastYear: "have had 2 or more falls in the last year",
};

interface FallsAnswers {
  /** Has the person fallen in the last year? */
  readonly fallenInLastYear?: boolean | null;
  /** Is the person presenting after a fall now? */
  readonly presentingAfterFall?: boolean | null;
}

export type FallsPathwayInput =
  | (FallsAnswers & {
      readonly setting: "residential";
      readonly occasion?: ResidentialFallsOccasion | null;
    })
  | (FallsAnswers & {
      readonly setting: "community";
      /** Asked only when the person has fallen in the last year or presents after a fall. */
      readonly criteria?: FallsCriteria | null;
    });

export type FallsPathwayOutcome =
  | "comprehensive_falls_assessment"
  | "gait_and_balance_assessment"
  | "no_falls_assessment";

/** The NG249 recommendation that applies. */
export type Ng249Recommendation = "1.1.3" | "1.1.4" | "1.1.6" | "1.1.7";

export interface FallsPathwayResult {
  readonly toolKey: "ng249_falls";
  readonly toolVersion: string;
  readonly setting: FallsSetting;
  readonly answers: {
    readonly fallenInLastYear: boolean | null;
    readonly presentingAfterFall: boolean | null;
  };
  readonly outcome: FallsPathwayOutcome;
  readonly recommendation: Ng249Recommendation;
  /** Why, in NICE's words, for the record and the screen. */
  readonly reason: string;
  /** Community settings: the 1.1.3 criteria answered yes. */
  readonly criteriaMet: readonly FallsCriterion[];
  readonly triggers: readonly CareTrigger[];
}

function incomplete(check: InputCheck) {
  const missing = check.issues.length;
  return {
    ...check.failure(),
    message: `Falls pathway incomplete: ${missing} ${missing === 1 ? "answer" : "answers"} missing.`,
  };
}

export function ng249FallsPathway(input: FallsPathwayInput): ToolOutcome<FallsPathwayResult> {
  const check = new InputCheck();
  const answers = {
    fallenInLastYear: input.fallenInLastYear ?? null,
    presentingAfterFall: input.presentingAfterFall ?? null,
  };
  const fallReported = answers.fallenInLastYear === true || answers.presentingAfterFall === true;
  const review: CareTrigger = {
    kind: "task",
    task: "falls_review",
    reason: "Fall reported (NICE NG249)",
  };
  const result = (
    outcome: FallsPathwayOutcome,
    recommendation: Ng249Recommendation,
    reason: string,
    criteriaMet: readonly FallsCriterion[],
    triggers: CareTrigger[],
  ): ToolOutcome<FallsPathwayResult> => ({
    ok: true,
    result: {
      toolKey: "ng249_falls",
      toolVersion: NG249_VERSION,
      setting: input.setting,
      answers,
      outcome,
      recommendation,
      reason,
      criteriaMet,
      triggers,
    },
  });

  if (input.setting === "residential") {
    const occasion = check.option("occasion", "Occasion", input.occasion, [
      "admission",
      "review",
      "after_fall",
    ] as const);
    if (occasion === undefined) return incomplete(check);
    const reason = `NICE NG249 1.1.7: offer a comprehensive falls assessment to people in residential care settings (${OCCASION_WORDS[occasion]})`;
    const triggers: CareTrigger[] = [
      { kind: "task", task: "comprehensive_falls_assessment", reason },
    ];
    if (fallReported || occasion === "after_fall") triggers.push(review);
    return result("comprehensive_falls_assessment", "1.1.7", reason, [], triggers);
  }

  if (!fallReported) {
    if (answers.fallenInLastYear === null) {
      check.present("fallenInLastYear", "Fallen in the last year", answers.fallenInLastYear);
      return incomplete(check);
    }
    return result(
      "no_falls_assessment",
      "1.1.6",
      "NICE NG249 1.1.6: no fall in the last year: offer health and wellbeing information, and advice on physical activity",
      [],
      [],
    );
  }

  const criteria = check.present("criteria", "Falls criteria", input.criteria);
  if (criteria === undefined) return incomplete(check);
  const names = Object.keys(CRITERIA) as FallsCriterion[];
  const met = names.filter((name) => criteria[name] === true);
  if (met.length > 0) {
    const reason = `NICE NG249 1.1.3: fallen in the last year and ${met.map((name) => CRITERIA[name]).join("; ")}`;
    return result("comprehensive_falls_assessment", "1.1.3", reason, met, [
      { kind: "task", task: "comprehensive_falls_assessment", reason },
      review,
    ]);
  }
  for (const name of names) {
    check.present(`criteria.${name}`, `Answer to "${CRITERIA[name]}"`, criteria[name]);
  }
  if (check.failed) return incomplete(check);
  const reason =
    "NICE NG249 1.1.4: fallen in the last year without the criteria in 1.1.3: assess gait and balance";
  return result(
    "gait_and_balance_assessment",
    "1.1.4",
    reason,
    [],
    [{ kind: "task", task: "gait_and_balance_assessment", reason }, review],
  );
}
