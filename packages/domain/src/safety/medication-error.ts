/**
 * Medication errors and near misses (safety.md Phase 2 rule 7; MEDS-012). The questions a medication
 * incident adds, and the tasks they raise. Harm and the statutory notifications come from the
 * incident classifier's own questions. These questions join the classifier with a later schema slice
 * (the database checks classifier question keys), so lane A never edits the classifier itself.
 */

export const MEDICATION_ERROR_KINDS = [
  "omitted_dose",
  "wrong_dose",
  "wrong_medicine",
  "wrong_person",
  "wrong_time",
  "wrong_route",
  "given_after_stopped",
  "other",
] as const;

export type MedicationErrorKind = (typeof MEDICATION_ERROR_KINDS)[number];

type Tri = "yes" | "no" | "unsure";

export interface MedicationErrorAnswers {
  readonly kinds: readonly MedicationErrorKind[];
  readonly reachedPerson: Tri | null;
  readonly controlledDrug: Tri | null;
  readonly deliberateOrRepeated: Tri | null;
}

export type MedicationErrorTask =
  | "clinical_advice"
  | "controlled_drug_report"
  | "safeguarding_consideration";

export interface MedicationErrorTriage {
  readonly nearMiss: boolean | null;
  readonly tasks: readonly { readonly task: MedicationErrorTask; readonly reason: string }[];
  readonly openQuestions: readonly (
    | "kinds"
    | "reachedPerson"
    | "controlledDrug"
    | "deliberateOrRepeated"
  )[];
}

/** "Not sure yet" counts as yes for tasks, so nothing waits on an unanswered question. */
const maybe = (answer: Tri | null) => answer !== "no";

export function medicationErrorTriage(answers: MedicationErrorAnswers): MedicationErrorTriage {
  const open: MedicationErrorTriage["openQuestions"][number][] = [];
  if (answers.kinds.length === 0) open.push("kinds");
  if (answers.reachedPerson === null) open.push("reachedPerson");
  if (answers.controlledDrug === null) open.push("controlledDrug");
  if (answers.deliberateOrRepeated === null) open.push("deliberateOrRepeated");
  const tasks: { task: MedicationErrorTask; reason: string }[] = [];
  // An omitted dose reaches the person by its absence: advice is needed then too.
  if (maybe(answers.reachedPerson) || answers.kinds.includes("omitted_dose")) {
    tasks.push({
      task: "clinical_advice",
      reason: "Ask the GP, a pharmacist or NHS 111 what to do now, and record the advice",
    });
  }
  if (maybe(answers.controlledDrug)) {
    tasks.push({
      task: "controlled_drug_report",
      reason:
        "Report the controlled drug incident to the area's NHS England Controlled Drugs Accountable Officer",
    });
  }
  if (maybe(answers.deliberateOrRepeated)) {
    tasks.push({
      task: "safeguarding_consideration",
      reason:
        "Deliberate or repeated medication errors can be abuse or neglect: answer the safeguarding question",
    });
  }
  return {
    nearMiss:
      answers.reachedPerson === null || answers.reachedPerson === "unsure"
        ? null
        : answers.reachedPerson === "no",
    tasks,
    openQuestions: open,
  };
}
