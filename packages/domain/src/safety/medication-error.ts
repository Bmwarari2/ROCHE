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
      reason:
        "Ask the GP, a pharmacist or NHS 111 what to do now, and record who you told and their advice. If the person is unwell, call 999",
    });
  }
  if (maybe(answers.controlledDrug)) {
    tasks.push({
      task: "controlled_drug_report",
      reason:
        "If a controlled drug was or may have been involved, report it to the area's NHS England Controlled Drugs Accountable Officer and record the date and reference",
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
  | "clinician_told_before_incident"
  | "cd_report_incomplete"
  | "cd_report_in_future"
  | "reference_too_long"
  | "omitted_not_reached"
  | "cd_denied_for_scheduled"
  | "cd_report_without_cd";

export const MEDICATION_ERROR_PROBLEM_WORDS: Readonly<Record<MedicationErrorProblem, string>> = {
  kind_unknown: "Choose what went wrong from the list.",
  kinds_repeated: "Choose each kind of error once.",
  text_too_long: "Keep each answer to 2,000 characters or fewer.",
  clinician_incomplete: "Say both who was told and when, or neither.",
  clinician_told_in_future: "The time the clinician was told cannot be in the future.",
  clinician_told_before_incident:
    "The clinician cannot have been told before the incident happened.",
  cd_report_in_future: "The controlled drug report cannot be dated in the future.",
  reference_too_long: "Keep the controlled drug report reference to 120 characters or fewer.",
  omitted_not_reached:
    "An omitted dose reaches the person by its absence: answer yes or not sure to whether it reached them.",
  cd_denied_for_scheduled:
    "The medicine is a controlled drug (it has a controlled drug schedule): answer yes or not sure.",
  cd_report_incomplete:
    "Record both the date of the controlled drug report and the reference you were given.",
  cd_report_without_cd:
    "A controlled drug report is recorded only when a controlled drug was or may have been involved.",
};

const tooLong = (value: string | null, max: number) => value !== null && value.length > max;

/** Checks a medication error record; every problem at once, in a fixed order. */
export function checkMedicationErrorRecord(
  input: MedicationErrorRecordInput,
  context: {
    readonly now: Date;
    readonly clockToleranceMinutes: number;
    /** When the incident happened, so the clinician cannot be told before it. */
    readonly occurredAt: Date | null;
    /** The linked medicine's controlled drug schedule, if any (B5). */
    readonly medicineCdSchedule: string | null;
    /** Today as a UK date, for the controlled drug report's date. */
    readonly today: string;
  },
): MedicationErrorProblem[] {
  const problems: MedicationErrorProblem[] = [];
  if (input.kinds.some((k) => !(MEDICATION_ERROR_KINDS as readonly string[]).includes(k)))
    problems.push("kind_unknown");
  if (new Set(input.kinds).size !== input.kinds.length) problems.push("kinds_repeated");
  if (
    [input.immediateActions, input.adviceGiven, input.rootCause, input.clinicianTold].some((v) =>
      tooLong(v, MEDICATION_ERROR_TEXT_MAX),
    )
  )
    problems.push("text_too_long");
  if (tooLong(input.cdReportReference, MEDICATION_ERROR_REFERENCE_MAX))
    problems.push("reference_too_long");
  if (input.kinds.includes("omitted_dose") && input.reachedPerson === "no")
    problems.push("omitted_not_reached");
  if (context.medicineCdSchedule !== null && input.controlledDrug === "no")
    problems.push("cd_denied_for_scheduled");
  if ((input.clinicianToldAt === null) !== blank(input.clinicianTold))
    problems.push("clinician_incomplete");
  if (
    input.clinicianToldAt !== null &&
    input.clinicianToldAt.getTime() > context.now.getTime() + context.clockToleranceMinutes * 60_000
  )
    problems.push("clinician_told_in_future");
  if (
    input.clinicianToldAt !== null &&
    context.occurredAt !== null &&
    input.clinicianToldAt.getTime() < context.occurredAt.getTime()
  )
    problems.push("clinician_told_before_incident");
  if ((input.cdReportedOn === null) !== blank(input.cdReportReference))
    problems.push("cd_report_incomplete");
  if (input.cdReportedOn !== null && input.cdReportedOn > context.today)
    problems.push("cd_report_in_future");
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
 * The prompts shown with a record (medicines.md section 14.1). Each stays until the evidence that
 * answers it is recorded, then goes, so the open ones are never lost among done ones:
 * - clinical advice (slice 7's triage) until who was told, when, and their advice are recorded;
 * - the controlled drug report (H-594) until its date and reference are recorded;
 * - safeguarding until the incident's own safeguarding question is answered: raised when the error
 *   may be deliberate or repeated (triage), or reached or may have reached the person with harm
 *   moderate, severe or fatal, or not yet graded (H-549);
 * - the CQC reminder always, as the incident's own questions decide notification.
 * An omitted dose counts as reaching the person. Harbour sends nothing.
 */
export function medicationErrorPrompts(
  answers: MedicationErrorAnswers,
  context: {
    readonly cdReported: boolean;
    readonly harmGrade: "none" | "low" | "moderate" | "severe" | "fatal" | null;
    readonly clinicalAdviceRecorded: boolean;
    readonly safeguardingAnswered: boolean;
  },
): { readonly prompt: MedicationErrorPrompt; readonly reason: string }[] {
  const triage = medicationErrorTriage(answers);
  const prompts: { prompt: MedicationErrorPrompt; reason: string }[] = triage.tasks
    .filter((t) => !(t.task === "controlled_drug_report" && context.cdReported))
    .filter((t) => !(t.task === "clinical_advice" && context.clinicalAdviceRecorded))
    .map((t) => ({ prompt: t.task, reason: t.reason }));
  const reached = answers.reachedPerson !== "no" || answers.kinds.includes("omitted_dose");
  const graded = context.harmGrade !== null;
  const significant =
    context.harmGrade === "moderate" ||
    context.harmGrade === "severe" ||
    context.harmGrade === "fatal";
  const omitted = answers.kinds.includes("omitted_dose");
  if (
    ((reached && (significant || !graded)) || omitted) &&
    !prompts.some((p) => p.prompt === "safeguarding_consideration")
  ) {
    prompts.push({
      prompt: "safeguarding_consideration",
      reason: !graded
        ? "The harm is not graded yet: once it is, consider whether a safeguarding concern is needed and answer the incident's safeguarding question"
        : significant
          ? "A medication error that caused significant harm may need a safeguarding concern: answer the incident's safeguarding question"
          : "A dose was omitted: consider whether it suggests neglect and answer the incident's safeguarding question",
    });
  }
  const shown = context.safeguardingAnswered
    ? prompts.filter((p) => p.prompt !== "safeguarding_consideration")
    : prompts;
  shown.push({
    prompt: "cqc_through_classifier",
    reason:
      "Whether CQC must be told depends on what the error caused or shows, for example a death, an injury, abuse or neglect, or police involvement: answer the incident's notification questions, which decide this",
  });
  return shown;
}

/** The UK month (`YYYY-MM`) of an instant: 31/03 at 23:30 UTC is April under BST. */
export function ukMonthOf(instant: Date): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "Europe/London",
    year: "numeric",
    month: "2-digit",
  })
    .format(instant)
    .slice(0, 7);
}

// ---------------------------------------------------------------------------------------------
// The trend (slice 45; medicines.md section 14.3)

export interface MedicationErrorTrendRow {
  readonly month: string;
  /** Reached the person (an omitted dose always counts); "unsure" is in notYetKnown. */
  readonly errors: number;
  /** Did not reach the person. */
  readonly nearMisses: number;
  /** Not yet known whether it reached the person. */
  readonly notYetKnown: number;
  readonly byKind: Readonly<Partial<Record<MedicationErrorKindName, number>>>;
  readonly byStage: Readonly<Partial<Record<MedicationErrorStage, number>>>;
}

/** Every UK month from `from` to `to` (`YYYY-MM`), inclusive. */
export function monthsBetween(from: string, to: string): string[] {
  const out: string[] = [];
  let [y, m] = from.split("-").map(Number) as [number, number];
  const [ty, tm] = to.split("-").map(Number) as [number, number];
  while (y < ty || (y === ty && m <= tm)) {
    out.push(`${y}-${String(m).padStart(2, "0")}`);
    m += 1;
    if (m === 13) {
      m = 1;
      y += 1;
    }
  }
  return out;
}

/**
 * Errors, near misses and those not yet known, by UK month (`YYYY-MM`), kind and stage. Every
 * month in `months` appears, with zeros when nothing happened, so a gap is never read as missing
 * data.
 */
export function medicationErrorTrend(
  records: readonly {
    readonly month: string;
    readonly kinds: readonly MedicationErrorKindName[];
    readonly stage: MedicationErrorStage | null;
    readonly reachedPerson: Tri | null;
  }[],
  months: readonly string[],
): MedicationErrorTrendRow[] {
  const rows = new Map<
    string,
    {
      errors: number;
      nearMisses: number;
      notYetKnown: number;
      byKind: Record<string, number>;
      byStage: Record<string, number>;
    }
  >();
  const blankRow = () => ({
    errors: 0,
    nearMisses: 0,
    notYetKnown: 0,
    byKind: {} as Record<string, number>,
    byStage: {} as Record<string, number>,
  });
  for (const month of months) rows.set(month, blankRow());
  for (const r of records) {
    const row = rows.get(r.month) ?? blankRow();
    if (r.kinds.includes("omitted_dose") || r.reachedPerson === "yes") row.errors += 1;
    else if (r.reachedPerson === "no") row.nearMisses += 1;
    else row.notYetKnown += 1;
    for (const k of r.kinds) row.byKind[k] = (row.byKind[k] ?? 0) + 1;
    if (r.stage) row.byStage[r.stage] = (row.byStage[r.stage] ?? 0) + 1;
    rows.set(r.month, row);
  }
  return [...rows.entries()]
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([month, row]) => ({ month, ...row }));
}
