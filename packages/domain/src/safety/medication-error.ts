/**
 * Medication errors and near misses (safety.md Phase 2 rule 7; MEDS-012). The questions a medication
 * incident adds, and the tasks they raise. Harm and the statutory notifications come from the
 * incident classifier's own questions. These questions join the classifier with a later schema slice
 * (the database checks classifier question keys), so lane A never edits the classifier itself.
 */

/**
 * What went wrong, following the NRLS medication incident error categories (slice 45; H-1290).
 * The first eight are slice 7's; the rest complete the NRLS list as it applies to a care setting.
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
  "wrong_frequency",
  "wrong_formulation",
  "wrong_quantity",
  "allergy_or_contraindication",
  "expired_medicine",
  "wrong_storage",
  "monitoring_not_done",
  "record_unclear_or_missing",
] as const;

/** Where the categories come from, said wherever they are shown or exported. */
export const MEDICATION_ERROR_SOURCE =
  "NRLS medication incident error categories (National Reporting and Learning System, NHS England), as adapted by Harbour for care settings";

export const MEDICATION_ERROR_KIND_WORDS: Readonly<Record<MedicationErrorKindName, string>> = {
  omitted_dose: "Dose omitted",
  wrong_dose: "Wrong dose or strength",
  wrong_medicine: "Wrong medicine",
  wrong_person: "Given to the wrong person",
  wrong_time: "Wrong time",
  wrong_route: "Wrong route",
  given_after_stopped: "Given after it was stopped",
  other: "Something else",
  wrong_frequency: "Wrong frequency",
  wrong_formulation: "Wrong form (for example tablet instead of liquid)",
  wrong_quantity: "Wrong quantity supplied or used",
  allergy_or_contraindication: "Given despite a known allergy or contraindication",
  expired_medicine: "Out-of-date medicine",
  wrong_storage: "Stored wrongly (for example out of the fridge)",
  monitoring_not_done: "Monitoring not done (for example a blood test or pulse check)",
  record_unclear_or_missing: "Record unclear or missing",
};

type MedicationErrorKindName = (typeof MEDICATION_ERROR_KINDS)[number];

/** The NRLS stage of the medication process where it went wrong. */
export const MEDICATION_ERROR_STAGES = [
  "prescribing",
  "transcribing",
  "dispensing",
  "administration",
  "monitoring",
  "storage",
  "other",
] as const;
export type MedicationErrorStage = (typeof MEDICATION_ERROR_STAGES)[number];

export const MEDICATION_ERROR_STAGE_WORDS: Readonly<Record<MedicationErrorStage, string>> = {
  prescribing: "Prescribing",
  transcribing: "Writing up the medicines record",
  dispensing: "Dispensing or supply",
  administration: "Giving the medicine",
  monitoring: "Monitoring",
  storage: "Storage",
  other: "Somewhere else",
};

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

// ---------------------------------------------------------------------------------------------
// The medication error record on an incident (slice 45; medicines.md section 14.1)

export const MEDICATION_ERROR_TEXT_MAX = 2000;
export const MEDICATION_ERROR_REFERENCE_MAX = 120;

export interface MedicationErrorRecordInput extends MedicationErrorAnswers {
  readonly stage: MedicationErrorStage | null;
  readonly immediateActions: string | null;
  readonly clinicianToldAt: Date | null;
  readonly clinicianTold: string | null;
  readonly adviceGiven: string | null;
  readonly rootCause: string | null;
  readonly cdReportedOn: string | null;
  readonly cdReportReference: string | null;
}

export type MedicationErrorProblem =
  | "kind_unknown"
  | "kinds_repeated"
  | "text_too_long"
  | "clinician_incomplete"
  | "clinician_told_in_future"
  | "cd_report_incomplete"
  | "cd_report_without_cd";

export const MEDICATION_ERROR_PROBLEM_WORDS: Readonly<Record<MedicationErrorProblem, string>> = {
  kind_unknown: "Choose what went wrong from the list.",
  kinds_repeated: "Choose each kind of error once.",
  text_too_long: "Keep each answer to 2,000 characters or fewer.",
  clinician_incomplete: "Say both who was told and when, or neither.",
  clinician_told_in_future: "The time the clinician was told cannot be in the future.",
  cd_report_incomplete:
    "Record both the date of the controlled drug report and the reference you were given.",
  cd_report_without_cd:
    "A controlled drug report is recorded only when a controlled drug was or may have been involved.",
};

const tooLong = (value: string | null, max: number) => value !== null && value.length > max;

/** Checks a medication error record; every problem at once, in a fixed order. */
export function checkMedicationErrorRecord(
  input: MedicationErrorRecordInput,
  now: Date,
  clockToleranceMinutes: number,
): MedicationErrorProblem[] {
  const problems: MedicationErrorProblem[] = [];
  if (input.kinds.some((k) => !(MEDICATION_ERROR_KINDS as readonly string[]).includes(k)))
    problems.push("kind_unknown");
  if (new Set(input.kinds).size !== input.kinds.length) problems.push("kinds_repeated");
  if (
    [input.immediateActions, input.adviceGiven, input.rootCause, input.clinicianTold].some((v) =>
      tooLong(v, MEDICATION_ERROR_TEXT_MAX),
    ) ||
    tooLong(input.cdReportReference, MEDICATION_ERROR_REFERENCE_MAX)
  )
    problems.push("text_too_long");
  if ((input.clinicianToldAt === null) !== blank(input.clinicianTold))
    problems.push("clinician_incomplete");
  if (
    input.clinicianToldAt !== null &&
    input.clinicianToldAt.getTime() > now.getTime() + clockToleranceMinutes * 60_000
  )
    problems.push("clinician_told_in_future");
  if ((input.cdReportedOn === null) !== blank(input.cdReportReference))
    problems.push("cd_report_incomplete");
  if (input.cdReportedOn !== null && input.controlledDrug === "no")
    problems.push("cd_report_without_cd");
  return problems;
}

function blank(value: string | null): boolean {
  return value === null || value.trim().length === 0;
}

/**
 * A controlled drug is presumed involved when the chosen medicine carries a CD schedule, unless the
 * person recording says otherwise; never presumed absent.
 */
export function presumedControlledDrug(
  answer: Tri | null,
  medicineCdSchedule: string | null,
): Tri | null {
  if (answer !== null) return answer;
  return medicineCdSchedule !== null ? "yes" : null;
}

export type MedicationErrorPrompt = MedicationErrorTask | "cqc_through_classifier";

/**
 * The prompts shown with a record (medicines.md section 14.1): slice 7's triage, with the
 * controlled drug report prompt kept until its date and reference are recorded (H-594), the
 * safeguarding prompt also for significant harm (H-549: moderate, severe or fatal on the incident,
 * or not yet graded), and a reminder that CQC notification is decided by the incident's own
 * classifier. Harbour sends nothing.
 */
export function medicationErrorPrompts(
  answers: MedicationErrorAnswers,
  context: {
    readonly cdReported: boolean;
    readonly harmGrade: "none" | "low" | "moderate" | "severe" | "fatal" | null;
  },
): { readonly prompt: MedicationErrorPrompt; readonly reason: string }[] {
  const triage = medicationErrorTriage(answers);
  const prompts: { prompt: MedicationErrorPrompt; reason: string }[] = triage.tasks
    .filter((t) => !(t.task === "controlled_drug_report" && context.cdReported))
    .map((t) => ({ prompt: t.task, reason: t.reason }));
  const significant =
    context.harmGrade === null ||
    context.harmGrade === "moderate" ||
    context.harmGrade === "severe" ||
    context.harmGrade === "fatal";
  if (
    significant &&
    answers.reachedPerson !== "no" &&
    !prompts.some((p) => p.prompt === "safeguarding_consideration")
  ) {
    prompts.push({
      prompt: "safeguarding_consideration",
      reason:
        "A medication error that caused or risked significant harm may need a safeguarding concern: answer the safeguarding question",
    });
  }
  prompts.push({
    prompt: "cqc_through_classifier",
    reason:
      "A medication error is notified to CQC only for what it caused or shows (a death, a serious injury, abuse or neglect): the incident's own questions decide this",
  });
  return prompts;
}

// ---------------------------------------------------------------------------------------------
// The trend (slice 45; medicines.md section 14.3)

export interface MedicationErrorTrendRow {
  readonly month: string;
  readonly errors: number;
  readonly nearMisses: number;
  readonly byKind: Readonly<Partial<Record<MedicationErrorKindName, number>>>;
  readonly byStage: Readonly<Partial<Record<MedicationErrorStage, number>>>;
}

/** Errors and near misses by UK month (`YYYY-MM`), kind and stage, months in order. */
export function medicationErrorTrend(
  records: readonly {
    readonly month: string;
    readonly kinds: readonly MedicationErrorKindName[];
    readonly stage: MedicationErrorStage | null;
    readonly reachedPerson: Tri | null;
  }[],
): MedicationErrorTrendRow[] {
  const rows = new Map<
    string,
    {
      errors: number;
      nearMisses: number;
      byKind: Record<string, number>;
      byStage: Record<string, number>;
    }
  >();
  for (const r of records) {
    const row = rows.get(r.month) ?? { errors: 0, nearMisses: 0, byKind: {}, byStage: {} };
    if (r.reachedPerson === "no") row.nearMisses += 1;
    else row.errors += 1;
    for (const k of r.kinds) row.byKind[k] = (row.byKind[k] ?? 0) + 1;
    if (r.stage) row.byStage[r.stage] = (row.byStage[r.stage] ?? 0) + 1;
    rows.set(r.month, row);
  }
  return [...rows.entries()]
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([month, row]) => ({ month, ...row }));
}
