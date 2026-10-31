/**
 * Outbreak management and IPC audits (safety.md section 11; SAFE-013; HZ-013). Once a location has
 * an outbreak, staff declare it, keep its case line list, complete the UKHSA report fields from
 * the line list and the location's own details, and close it. IPC audits are read against the
 * Code of Practice criteria. Pure functions: nothing here diagnoses, predicts or rates a person;
 * the line list records what staff observed and what tests said, and the report counts it.
 *
 * Sources: UKHSA, "Report an outbreak of acute respiratory infection in an adult social care
 * setting" (the details the health protection team asks for: the setting's address and CQC
 * location ID, how many residents and staff are unwell, when symptoms started, tests and their
 * results, vaccination); DHSC, "The Health and Social Care Act 2008: code of practice on the
 * prevention and control of infections and related guidance" (the 10 criteria; H-765 to check
 * the wording against the current edition).
 */

import { type AuditAnswer, type AuditQuestion, scoreAudit } from "../quality/quality-audits";
import { type Citation, cite, SOURCES } from "../shared/citation";

export const OUTBREAK_SYNDROMES = [
  "acute_respiratory",
  "flu",
  "covid_19",
  "diarrhoea_vomiting",
  "other",
] as const;
export type OutbreakSyndrome = (typeof OUTBREAK_SYNDROMES)[number];

export const OUTBREAK_STATES = ["declared", "closed"] as const;
export type OutbreakState = (typeof OUTBREAK_STATES)[number];

export const OUTBREAK_CASE_TYPES = ["resident", "staff"] as const;
export type OutbreakCaseType = (typeof OUTBREAK_CASE_TYPES)[number];

export const OUTBREAK_SYMPTOMS = [
  "fever",
  "cough",
  "sore_throat",
  "shortness_of_breath",
  "loss_of_taste_or_smell",
  "diarrhoea",
  "vomiting",
  "new_confusion",
  "other",
] as const;
export type OutbreakSymptom = (typeof OUTBREAK_SYMPTOMS)[number];

export const OUTBREAK_TEST_TYPES = ["lateral_flow", "pcr", "stool_sample", "other"] as const;
export type OutbreakTestType = (typeof OUTBREAK_TEST_TYPES)[number];

export const OUTBREAK_TEST_RESULTS = ["not_tested", "pending", "positive", "negative"] as const;
export type OutbreakTestResult = (typeof OUTBREAK_TEST_RESULTS)[number];

export const VACCINATION_ANSWERS = ["yes", "no", "unknown"] as const;
export type VaccinationAnswer = (typeof VACCINATION_ANSWERS)[number];

export const OUTBREAK_CASE_OUTCOMES = ["unwell", "recovered", "hospitalised", "died"] as const;
export type OutbreakCaseOutcome = (typeof OUTBREAK_CASE_OUTCOMES)[number];

export const UKHSA_OUTBREAK_SOURCE: Citation = cite(
  "UKHSA",
  "Report an outbreak of acute respiratory infection in an adult social care setting",
  SOURCES.ukhsaAri,
);

export const IPC_CODE_SOURCE: Citation = cite(
  "Department of Health and Social Care",
  "The Health and Social Care Act 2008: code of practice on the prevention and control of infections and related guidance, criteria 1 to 10",
  "https://www.gov.uk/government/publications/the-health-and-social-care-act-2008-code-of-practice-on-the-prevention-and-control-of-infections-and-related-guidance",
);

export interface IpcCriterion {
  /** `criterion_1` to `criterion_10`. */
  readonly id: string;
  readonly number: number;
  /** A short summary of the criterion, in Harbour's words (H-765). */
  readonly title: string;
}

/** The Code of Practice's 10 criteria, summarised; the database seeds the same list. */
export const IPC_CODE_CRITERIA: readonly IpcCriterion[] = [
  "Systems to manage and monitor infection prevention and control, using risk assessments",
  "A clean environment that helps prevent and control infections",
  "Appropriate antimicrobial use and stewardship",
  "Accurate information on infections given in good time to others providing care",
  "People with or at risk of an infection are identified promptly and cared for to reduce spread",
  "All care workers know and carry out their part in preventing and controlling infection",
  "Adequate isolation precautions and facilities",
  "Adequate access to laboratory and diagnostic support",
  "Policies that help prevent and control infections, and are followed",
  "Staff health and wellbeing, and the organisation's duty to manage infection prevention",
].map((title, i) => ({ id: `criterion_${i + 1}`, number: i + 1, title }));

// ---------------------------------------------------------------------------------------------
// The line list

export interface OutbreakCase {
  readonly id: string;
  readonly caseType: OutbreakCaseType;
  /** The person receiving care, for a resident case. */
  readonly personId: string | null;
  /** The member of staff, for a staff case. */
  readonly tenantUserId: string | null;
  /** UK date symptoms started (or were first noticed). */
  readonly onsetOn: string;
  readonly symptoms: readonly OutbreakSymptom[];
  readonly testType: OutbreakTestType | null;
  readonly testedOn: string | null;
  readonly testResult: OutbreakTestResult;
  readonly fluVaccinated: VaccinationAnswer;
  readonly covidVaccinated: VaccinationAnswer;
  readonly outcome: OutbreakCaseOutcome;
  /** UK date of the outcome, for anything but `unwell`. */
  readonly outcomeOn: string | null;
  /** The case this row corrects or updates, if any. */
  readonly supersedesId: string | null;
  readonly createdAt: string;
}

export type OutbreakCaseProblem =
  | "outbreak_closed"
  | "subject_mismatch"
  | "onset_in_future"
  | "test_incomplete"
  | "tested_before_onset"
  | "tested_in_future"
  | "outcome_date_missing"
  | "outcome_date_before_onset"
  | "outcome_date_in_future"
  | "no_symptoms";

export const OUTBREAK_CASE_MESSAGES: Readonly<Record<OutbreakCaseProblem, string>> = {
  outbreak_closed: "This outbreak is closed. Declare a new one if cases continue.",
  subject_mismatch: "Name the person for a resident case, or the member of staff for a staff case.",
  onset_in_future: "Symptoms cannot start in the future.",
  test_incomplete: "Give the test, the date it was taken and its result, or say it was not tested.",
  tested_before_onset: "A test for this illness cannot be taken before symptoms started.",
  tested_in_future: "A test cannot be dated in the future.",
  outcome_date_missing: "Give the date of the outcome.",
  outcome_date_before_onset: "An outcome cannot be dated before symptoms started.",
  outcome_date_in_future: "An outcome cannot be dated in the future.",
  no_symptoms: "Choose at least one symptom.",
};

/**
 * Why a case cannot go on the line list; empty when it can (`today` is the UK date).
 */
export function checkOutbreakCase(
  value: Omit<OutbreakCase, "id" | "createdAt" | "supersedesId">,
  outbreak: { readonly state: OutbreakState },
  today: string,
): OutbreakCaseProblem[] {
  const problems: OutbreakCaseProblem[] = [];
  if (outbreak.state === "closed") problems.push("outbreak_closed");
  const subjectOk =
    value.caseType === "resident"
      ? value.personId !== null && value.tenantUserId === null
      : value.tenantUserId !== null && value.personId === null;
  if (!subjectOk) problems.push("subject_mismatch");
  if (value.symptoms.length === 0) problems.push("no_symptoms");
  if (value.onsetOn > today) problems.push("onset_in_future");
  const tested = value.testResult !== "not_tested";
  if (tested !== (value.testType !== null && value.testedOn !== null)) {
    problems.push("test_incomplete");
  }
  if (value.testedOn !== null) {
    if (value.testedOn < value.onsetOn) problems.push("tested_before_onset");
    if (value.testedOn > today) problems.push("tested_in_future");
  }
  if (value.outcome !== "unwell") {
    if (value.outcomeOn === null) problems.push("outcome_date_missing");
    else {
      if (value.outcomeOn < value.onsetOn) problems.push("outcome_date_before_onset");
      if (value.outcomeOn > today) problems.push("outcome_date_in_future");
    }
  }
  return problems;
}

/** Each subject's latest entry: rows superseded by a later row drop out of the line list. */
export function currentCases<T extends Pick<OutbreakCase, "id" | "supersedesId">>(
  rows: readonly T[],
): T[] {
  const superseded = new Set(rows.map((r) => r.supersedesId).filter((id) => id !== null));
  return rows.filter((r) => !superseded.has(r.id));
}

// ---------------------------------------------------------------------------------------------
// The UKHSA report fields

export interface UkhsaReportFields {
  readonly settingName: string;
  readonly postcode: string | null;
  readonly cqcLocationId: string | null;
  readonly syndrome: OutbreakSyndrome;
  readonly organism: string | null;
  readonly declaredOn: string;
  readonly residentCases: number;
  readonly staffCases: number;
  readonly firstOnsetOn: string | null;
  readonly latestOnsetOn: string | null;
  readonly tested: number;
  readonly positive: number;
  readonly pending: number;
  readonly hospitalised: number;
  readonly died: number;
  /** Of the cases, how many had the vaccine, had not, or nobody knows. */
  readonly fluVaccination: Readonly<Record<VaccinationAnswer, number>>;
  readonly covidVaccination: Readonly<Record<VaccinationAnswer, number>>;
  /** What the report still needs, in words; empty when every field has a value. */
  readonly missing: readonly string[];
  readonly source: Citation;
}

const tally = (cases: readonly OutbreakCase[], pick: (c: OutbreakCase) => VaccinationAnswer) =>
  ({
    yes: cases.filter((c) => pick(c) === "yes").length,
    no: cases.filter((c) => pick(c) === "no").length,
    unknown: cases.filter((c) => pick(c) === "unknown").length,
  }) as const;

/**
 * The report fields from the location and the current line list. Counts are of what is recorded;
 * a field with no value is listed as missing, never filled in or guessed.
 */
export function ukhsaReportFields(
  outbreak: {
    readonly syndrome: OutbreakSyndrome;
    readonly organism: string | null;
    readonly declaredOn: string;
  },
  location: {
    readonly name: string;
    readonly postcode: string | null;
    readonly cqcLocationId: string | null;
  },
  lineList: readonly OutbreakCase[],
): UkhsaReportFields {
  const cases = currentCases(lineList);
  const onsets = cases.map((c) => c.onsetOn).sort();
  const missing: string[] = [];
  if (!location.postcode) missing.push("The location's postcode");
  if (!location.cqcLocationId) missing.push("The location's CQC location ID");
  if (cases.length === 0) missing.push("At least one case on the line list");
  if (cases.some((c) => c.fluVaccinated === "unknown" || c.covidVaccinated === "unknown")) {
    missing.push("Vaccination status for every case");
  }
  if (cases.some((c) => c.testResult === "pending")) missing.push("Results of pending tests");
  return {
    settingName: location.name,
    postcode: location.postcode,
    cqcLocationId: location.cqcLocationId,
    syndrome: outbreak.syndrome,
    organism: outbreak.organism,
    declaredOn: outbreak.declaredOn,
    residentCases: cases.filter((c) => c.caseType === "resident").length,
    staffCases: cases.filter((c) => c.caseType === "staff").length,
    firstOnsetOn: onsets[0] ?? null,
    latestOnsetOn: onsets.at(-1) ?? null,
    tested: cases.filter((c) => c.testResult !== "not_tested").length,
    positive: cases.filter((c) => c.testResult === "positive").length,
    pending: cases.filter((c) => c.testResult === "pending").length,
    hospitalised: cases.filter((c) => c.outcome === "hospitalised").length,
    died: cases.filter((c) => c.outcome === "died").length,
    fluVaccination: tally(cases, (c) => c.fluVaccinated),
    covidVaccination: tally(cases, (c) => c.covidVaccinated),
    missing,
    source: UKHSA_OUTBREAK_SOURCE,
  };
}

// ---------------------------------------------------------------------------------------------
// Closure

export type OutbreakClosureProblem =
  | "already_closed"
  | "report_undecided"
  | "closed_before_last_onset"
  | "closed_in_future";

export const OUTBREAK_CLOSURE_MESSAGES: Readonly<Record<OutbreakClosureProblem, string>> = {
  already_closed: "This outbreak is already closed.",
  report_undecided:
    "Submit the outbreak report to the health protection team, or record why it is not needed, before closing the outbreak.",
  closed_before_last_onset: "An outbreak cannot close before its last case's symptoms started.",
  closed_in_future: "An outbreak cannot be closed in the future.",
};

/**
 * Hazard HZ-013: an outbreak closes only once its UKHSA report is decided (submitted, or recorded
 * as not needed), so closing never hides a report still due. The decision to close is a person's,
 * agreed with the health protection team; Harbour sets no quiet period of its own.
 */
export function checkOutbreakClosure(
  outbreak: { readonly state: OutbreakState },
  report: { readonly status: "draft" | "ready" | "submitted" | "not_required" } | null,
  latestOnsetOn: string | null,
  closedOn: string,
  today: string,
): OutbreakClosureProblem[] {
  const problems: OutbreakClosureProblem[] = [];
  if (outbreak.state === "closed") problems.push("already_closed");
  if (report !== null && (report.status === "draft" || report.status === "ready")) {
    problems.push("report_undecided");
  }
  if (latestOnsetOn !== null && closedOn < latestOnsetOn) {
    problems.push("closed_before_last_onset");
  }
  if (closedOn > today) problems.push("closed_in_future");
  return problems;
}

/** Cases still unwell when an outbreak closes: said beside the closure, never a blocker. */
export function casesStillUnwell(lineList: readonly OutbreakCase[]): number {
  return currentCases(lineList).filter((c) => c.outcome === "unwell").length;
}

// ---------------------------------------------------------------------------------------------
// IPC audits against the Code of Practice criteria

/** An audit question, as IPC templates carry it: mapped to Code of Practice criteria too. */
export type IpcAuditQuestion = AuditQuestion & { readonly ipcCriteria?: readonly string[] };

export type IpcTemplateProblem = "unknown_criterion" | "question_unmapped";

export const IPC_TEMPLATE_MESSAGES: Readonly<Record<IpcTemplateProblem, string>> = {
  unknown_criterion: "Map IPC questions only to the Code of Practice criteria 1 to 10.",
  question_unmapped: "Map every IPC question to at least one Code of Practice criterion.",
};

/** An IPC template's questions each name at least one criterion, and only real ones. */
export function checkIpcTemplate(questions: readonly IpcAuditQuestion[]): IpcTemplateProblem[] {
  const known = new Set(IPC_CODE_CRITERIA.map((c) => c.id));
  const problems: IpcTemplateProblem[] = [];
  if (questions.some((q) => (q.ipcCriteria ?? []).some((id) => !known.has(id)))) {
    problems.push("unknown_criterion");
  }
  if (questions.some((q) => (q.ipcCriteria ?? []).length === 0)) {
    problems.push("question_unmapped");
  }
  return problems;
}

export interface IpcCriterionResult {
  readonly criterion: IpcCriterion;
  readonly questionKeys: readonly string[];
  /** The weighted score of the criterion's questions; null when none is mapped or answerable. */
  readonly percent: number | null;
  readonly achieved: number;
  readonly possible: number;
  /** Mapped questions answered "no" or "partial". */
  readonly fellShort: readonly string[];
}

/**
 * An IPC audit read criterion by criterion, with the audit's own scoring method (`scoreAudit`) over
 * each criterion's questions. A criterion no question covers says so (percent null, no keys), so a
 * gap in the template is visible rather than shown as met.
 */
export function ipcCriteriaResults(
  questions: readonly IpcAuditQuestion[],
  answers: Readonly<Record<string, AuditAnswer | null>>,
): IpcCriterionResult[] {
  return IPC_CODE_CRITERIA.map((criterion) => {
    const mapped = questions.filter((q) => (q.ipcCriteria ?? []).includes(criterion.id));
    const score = scoreAudit({ questions: mapped }, answers);
    return {
      criterion,
      questionKeys: mapped.map((q) => q.key),
      percent: mapped.length === 0 ? null : score.percent,
      achieved: score.achieved,
      possible: score.possible,
      fellShort: mapped
        .filter((q) => answers[q.key] === "no" || answers[q.key] === "partial")
        .map((q) => q.key),
    };
  });
}
