/**
 * The NG249 falls question (care.md section 4 rule 5). NICE NG249 recommendation 1.1.1: "Do not use
 * falls risk prediction tools to predict a person's risk of falling." So this produces no score,
 * band or risk level of any kind (medical-device boundary, section 4): a "yes" to either question
 * raises the multifactorial falls assessment and a review task, and the assessment itself is a
 * structured form completed by staff.
 *
 * Source: NICE guideline NG249, Falls: assessment and prevention in older people and in people 50
 * and over at higher risk (29 April 2025), recommendations 1.1.1 and 1.1.2.
 * https://www.nice.org.uk/guidance/ng249
 */

import { type CareTrigger, InputCheck, type ToolOutcome } from "./assessment";

export const NG249_FALLS_QUESTION_VERSION = "nice-ng249-2025";

export interface FallsQuestionInput {
  /** Has the person fallen in the past 12 months? */
  readonly fallenInPast12Months?: boolean | null;
  /** Is the person presenting after a fall now? */
  readonly presentingAfterFall?: boolean | null;
}

export interface FallsQuestionResult {
  readonly toolKey: "ng249_falls_question";
  readonly toolVersion: string;
  readonly answers: {
    readonly fallenInPast12Months: boolean | null;
    readonly presentingAfterFall: boolean | null;
  };
  readonly assessmentIndicated: boolean;
  readonly triggers: readonly CareTrigger[];
}

/** A single "yes" is enough; two answers are needed to conclude "no assessment indicated". */
export function answerFallsQuestion(input: FallsQuestionInput): ToolOutcome<FallsQuestionResult> {
  const fallen = input.fallenInPast12Months ?? null;
  const presenting = input.presentingAfterFall ?? null;
  const assessmentIndicated = fallen === true || presenting === true;
  if (!assessmentIndicated && (fallen === null || presenting === null)) {
    const check = new InputCheck();
    check.present("fallenInPast12Months", "Fallen in the past 12 months", fallen);
    check.present("presentingAfterFall", "Presenting after a fall now", presenting);
    const missing = check.issues.length;
    return {
      ...check.failure(),
      message: `Falls question incomplete: ${missing} ${missing === 1 ? "answer" : "answers"} missing.`,
    };
  }
  const reason = presenting
    ? "Presenting after a fall (NICE NG249)"
    : "Fallen in the past 12 months (NICE NG249)";
  const triggers: CareTrigger[] = assessmentIndicated
    ? [
        { kind: "task", task: "multifactorial_falls_assessment", reason },
        { kind: "task", task: "falls_review", reason },
      ]
    : [];
  return {
    ok: true,
    result: {
      toolKey: "ng249_falls_question",
      toolVersion: NG249_FALLS_QUESTION_VERSION,
      answers: { fallenInPast12Months: fallen, presentingAfterFall: presenting },
      assessmentIndicated,
      triggers,
    },
  };
}
