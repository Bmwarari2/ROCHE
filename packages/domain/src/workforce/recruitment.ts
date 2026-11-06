import { addPeriod } from "../platform/retention";
import { type RoleRegistration, requiredItems, type Schedule3ItemKind } from "./schedule3";

/**
 * Applicant tracking (workforce.md section 2c and rules 11 to 13; WORK-001; plan slice 23). Job
 * templates by Care Workforce Pathway role, vacancies, applications through shortlisting and
 * values-based interviews to a conditional offer, the talent pool, equality monitoring reported
 * only as suppressed counts, and how long an applicant's data is kept. Every decision is a
 * person's: the rules here say what may be recorded next, never who should get the job (section
 * 5.1: no solely automated significant decision).
 */

/**
 * Care Workforce Pathway role categories (Skills for Care, adult social care). The organisation
 * names its own job titles; the category is what the template is for. Confirmed against the
 * Pathway in force by H-730.
 */
export const PATHWAY_CATEGORIES = [
  "new_to_care",
  "care_worker",
  "senior_care_worker",
  "lead_practitioner",
  "deputy_manager",
  "registered_manager",
  "registered_nurse",
] as const;
export type PathwayCategory = (typeof PATHWAY_CATEGORIES)[number];

/**
 * The values a values-based interview question explores (the 6Cs, as Skills for Care's
 * values-based recruitment uses them; H-730).
 */
export const RECRUITMENT_VALUES = [
  "care",
  "compassion",
  "competence",
  "communication",
  "courage",
  "commitment",
] as const;
export type RecruitmentValue = (typeof RECRUITMENT_VALUES)[number];

export const APPLICATION_STAGES = [
  "applied",
  "shortlisted",
  "interviewed",
  "offered",
  "accepted",
  "rejected",
  "withdrawn",
  "declined",
] as const;
export type ApplicationStage = (typeof APPLICATION_STAGES)[number];

/** Stages from which nothing moves on: a new application is made instead. */
export const CLOSED_STAGES: readonly ApplicationStage[] = [
  "accepted",
  "rejected",
  "withdrawn",
  "declined",
];

/** Why an application closed without an offer being accepted. */
export const CLOSING_REASONS = [
  "criteria_not_met",
  "not_selected_after_interview",
  "position_filled",
  "vacancy_withdrawn",
  "applicant_withdrew",
  "offer_declined",
  "offer_withdrawn",
  "pre_employment_checks_failed",
] as const;
export type ClosingReason = (typeof CLOSING_REASONS)[number];

export const VACANCY_STATUSES = ["draft", "open", "closed", "filled", "withdrawn"] as const;
export type VacancyStatus = (typeof VACANCY_STATUSES)[number];

export const INTERVIEW_SCORE_MIN = 1;
export const INTERVIEW_SCORE_MAX = 4;
export const INTERVIEW_PANEL_MAX = 5;

export interface ValuesQuestion {
  readonly key: string;
  readonly value: RecruitmentValue;
  readonly question: string;
}

export interface JobTemplateFacts {
  readonly essentialCriteria: readonly string[];
  readonly valuesQuestions: readonly ValuesQuestion[];
  readonly registration: RoleRegistration;
}

/** Each essential criterion (by its position in the template) met or not. */
export type ShortlistAssessment = readonly boolean[];

export type ApplicationMove =
  | { readonly to: "shortlisted"; readonly assessment: ShortlistAssessment }
  | {
      readonly to: "rejected";
      readonly reason: ClosingReason;
      /** The criteria assessment, when rejected at shortlisting. */
      readonly assessment?: ShortlistAssessment;
    }
  | {
      readonly to: "interviewed";
      readonly panel: readonly string[];
      readonly scores: Readonly<Record<string, number>>;
      readonly recommendation: "proceed" | "do_not_proceed";
    }
  | { readonly to: "offered"; readonly lastRecommendation: "proceed" | "do_not_proceed" | null }
  | { readonly to: "accepted"; readonly staffMemberId: string | null }
  | { readonly to: "declined" }
  | { readonly to: "withdrawn"; readonly reason: ClosingReason };

export type ApplicationMoveProblem =
  | "closed"
  | "not_allowed_from_stage"
  | "criteria_not_all_assessed"
  | "criteria_not_met"
  | "reason_required"
  | "panel_size"
  | "panel_repeated"
  | "scores_incomplete"
  | "score_out_of_range"
  | "not_recommended"
  | "staff_member_required"
  | "vacancy_not_open";

const FROM: Record<ApplicationMove["to"], readonly ApplicationStage[]> = {
  shortlisted: ["applied"],
  rejected: ["applied", "shortlisted", "interviewed"],
  // A second interview (a later panel) is a new row while still interviewed.
  interviewed: ["shortlisted", "interviewed"],
  offered: ["interviewed"],
  accepted: ["offered"],
  declined: ["offered"],
  withdrawn: ["applied", "shortlisted", "interviewed", "offered"],
};

export const APPLICATION_MOVE_MESSAGES: Record<ApplicationMoveProblem, string> = {
  closed: "This application is closed. Record a new application instead.",
  not_allowed_from_stage: "That step does not follow from where the application is.",
  criteria_not_all_assessed: "Record whether each essential criterion is met.",
  criteria_not_met:
    "An applicant who does not meet every essential criterion is not shortlisted. Reject with a reason instead.",
  reason_required: "Choose why the application is closing.",
  panel_size: `An interview panel has 1 to ${INTERVIEW_PANEL_MAX} members of staff.`,
  panel_repeated: "Name each panel member once.",
  scores_incomplete: "Score every values question.",
  score_out_of_range: `Each score is from ${INTERVIEW_SCORE_MIN} to ${INTERVIEW_SCORE_MAX}.`,
  not_recommended: "An offer follows an interview whose panel recommended proceeding.",
  staff_member_required:
    "Choose the member of staff the applicant now is (invite them first), so their staff file can start.",
  vacancy_not_open: "Applications are taken only while the vacancy is open.",
};

export type ApplicationMoveCheck =
  | { readonly ok: true; readonly to: ApplicationStage; readonly closes: boolean }
  | { readonly ok: false; readonly problem: ApplicationMoveProblem; readonly message: string };

const refuse = (problem: ApplicationMoveProblem): ApplicationMoveCheck => ({
  ok: false,
  problem,
  message: APPLICATION_MOVE_MESSAGES[problem],
});

/** Whether the move may be recorded from the application's current stage (rule 11). */
export function checkApplicationMove(
  stage: ApplicationStage,
  template: JobTemplateFacts,
  move: ApplicationMove,
): ApplicationMoveCheck {
  if (CLOSED_STAGES.includes(stage)) return refuse("closed");
  if (!FROM[move.to].includes(stage)) return refuse("not_allowed_from_stage");
  switch (move.to) {
    case "shortlisted":
      if (move.assessment.length !== template.essentialCriteria.length) {
        return refuse("criteria_not_all_assessed");
      }
      if (move.assessment.some((met) => !met)) return refuse("criteria_not_met");
      break;
    case "rejected":
      if (!move.reason) return refuse("reason_required");
      if (move.assessment && move.assessment.length !== template.essentialCriteria.length) {
        return refuse("criteria_not_all_assessed");
      }
      break;
    case "interviewed": {
      if (move.panel.length < 1 || move.panel.length > INTERVIEW_PANEL_MAX) {
        return refuse("panel_size");
      }
      if (new Set(move.panel).size !== move.panel.length) return refuse("panel_repeated");
      const keys = template.valuesQuestions.map((q) => q.key);
      const scored = Object.keys(move.scores);
      if (keys.some((k) => !(k in move.scores)) || scored.some((k) => !keys.includes(k))) {
        return refuse("scores_incomplete");
      }
      if (
        Object.values(move.scores).some(
          (v) => !Number.isInteger(v) || v < INTERVIEW_SCORE_MIN || v > INTERVIEW_SCORE_MAX,
        )
      ) {
        return refuse("score_out_of_range");
      }
      break;
    }
    case "offered":
      if (move.lastRecommendation !== "proceed") return refuse("not_recommended");
      break;
    case "accepted":
      if (!move.staffMemberId) return refuse("staff_member_required");
      break;
    case "withdrawn":
      if (!move.reason) return refuse("reason_required");
      break;
    case "declined":
      break;
  }
  return { ok: true, to: move.to, closes: CLOSED_STAGES.includes(move.to) };
}

/** Applications are taken only while the vacancy is open (rule 11). */
export function checkNewApplication(status: VacancyStatus): ApplicationMoveCheck {
  return status === "open"
    ? { ok: true, to: "applied", closes: false }
    : refuse("vacancy_not_open");
}

/**
 * The panel's total and the most it could be, shown with the scores: a summary for the people
 * deciding, never a decision (section 5.1).
 */
export function interviewTotal(
  scores: Readonly<Record<string, number>>,
  questions: readonly ValuesQuestion[],
): { readonly total: number; readonly outOf: number } {
  return {
    total: questions.reduce((sum, q) => sum + (scores[q.key] ?? 0), 0),
    outOf: questions.length * INTERVIEW_SCORE_MAX,
  };
}

/**
 * What a conditional offer depends on: the Schedule 3 items the role needs. The staff profile the
 * acceptance creates lists them as outstanding until each is seen (section 2a).
 */
export function offerConditions(role: {
  readonly registration: RoleRegistration;
  readonly previousCareWork: boolean;
}): readonly Schedule3ItemKind[] {
  return requiredItems(role);
}

// ------------------------------------------------------------------------------------------------
// Equality monitoring (rule 12)
// ------------------------------------------------------------------------------------------------

export const EQUALITY_QUESTIONS = {
  age_band: ["16_24", "25_34", "35_44", "45_54", "55_64", "65_plus"],
  sex: ["female", "male"],
  gender_same_as_registered_at_birth: ["yes", "no"],
  ethnic_group: ["asian", "black", "mixed", "white", "other"],
  disability: ["yes", "no"],
  religion: ["none", "christian", "buddhist", "hindu", "jewish", "muslim", "sikh", "other"],
  sexual_orientation: ["heterosexual", "gay_or_lesbian", "bisexual", "other"],
} as const satisfies Record<string, readonly string[]>;
export type EqualityQuestion = keyof typeof EQUALITY_QUESTIONS;
export const PREFER_NOT_TO_SAY = "prefer_not_to_say";

/** Below this many, a count is shown only as "fewer than" it (H-731 confirms the figure). */
export const EQUALITY_MONITORING_MIN_COUNT = 5;

/** Whether one form's answers are all known questions with offered answers (or left out). */
export function validEqualityAnswers(answers: Readonly<Record<string, string>>): boolean {
  return Object.entries(answers).every(([question, answer]) => {
    const offered = (EQUALITY_QUESTIONS as Record<string, readonly string[]>)[question];
    return offered !== undefined && (answer === PREFER_NOT_TO_SAY || offered.includes(answer));
  });
}

export type SuppressedCount = number | "fewer_than_min";

export interface EqualityQuestionSummary {
  readonly question: EqualityQuestion;
  /** Null when no answer reached the minimum, or there were too few forms: nothing is shown. */
  readonly counts: Readonly<Record<string, SuppressedCount>> | null;
}

/**
 * Counts per answer for each question, with small numbers suppressed (rule 12; DPIA risk R29). A
 * count of 1 up to the minimum arrives as null (the database suppresses it before anyone sees it)
 * or as a number under the minimum, and reads as "fewer than". When a question has exactly one
 * such cell, its smallest shown non-zero cell is suppressed too, so the small one cannot be worked
 * out by subtracting the others from the number of forms (complementary suppression). A question
 * with no cell at or above the minimum, or a vacancy with fewer forms than that, shows nothing.
 */
export function equalityMonitoringSummary(
  counts: readonly {
    readonly question: string;
    readonly answer: string;
    readonly n: number | null;
  }[],
  min: number = EQUALITY_MONITORING_MIN_COUNT,
): { readonly forms: SuppressedCount; readonly questions: readonly EqualityQuestionSummary[] } {
  const small = (n: number | null) => n === null || (n > 0 && n < min);
  const formsRow = counts.find((c) => c.question === "__forms");
  const forms: SuppressedCount =
    formsRow === undefined ? 0 : small(formsRow.n) ? "fewer_than_min" : (formsRow.n ?? 0);
  const questions = (Object.keys(EQUALITY_QUESTIONS) as EqualityQuestion[]).map((question) => {
    if (forms === "fewer_than_min") return { question, counts: null };
    const rows = counts.filter((c) => c.question === question);
    const answers = [...EQUALITY_QUESTIONS[question], PREFER_NOT_TO_SAY];
    const values = answers.map((answer) => {
      const row = rows.find((r) => r.answer === answer);
      return { answer, n: row === undefined ? 0 : row.n };
    });
    if (!values.some((v) => v.n !== null && v.n >= min)) return { question, counts: null };
    const hidden = new Set(values.filter((v) => small(v.n)).map((v) => v.answer));
    if (hidden.size === 1) {
      const next = values
        .filter((v) => !hidden.has(v.answer) && v.n !== null && v.n > 0)
        .sort((a, b) => (a.n ?? 0) - (b.n ?? 0))[0];
      if (next) hidden.add(next.answer);
    }
    const out: Record<string, SuppressedCount> = {};
    for (const v of values) out[v.answer] = hidden.has(v.answer) ? "fewer_than_min" : (v.n ?? 0);
    return { question, counts: out };
  });
  return { forms, questions };
}

// ------------------------------------------------------------------------------------------------
// Keeping applicants' data (rule 13)
// ------------------------------------------------------------------------------------------------

export interface RetentionPeriod {
  readonly period: number;
  readonly unit: "years" | "months";
}

/**
 * The UK date until which an applicant is kept: null while any application is open or once they
 * were hired (their details then follow the staff file); otherwise the latest closing date plus
 * the `applicant.unsuccessful` period, or the end of the talent pool period, whichever is later.
 */
export function applicantRetainUntil(input: {
  readonly applications: readonly {
    readonly stage: ApplicationStage;
    readonly closedOn: string | null;
  }[];
  readonly talentPoolUntil: string | null;
  readonly unsuccessful: RetentionPeriod;
}): string | null {
  const { applications } = input;
  if (applications.some((a) => !CLOSED_STAGES.includes(a.stage))) return null;
  if (applications.some((a) => a.stage === "accepted")) return null;
  const closed = applications.map((a) => a.closedOn).filter((d): d is string => d !== null);
  if (closed.length === 0) return input.talentPoolUntil;
  const last = closed.sort().at(-1) ?? closed[0];
  const until = addPeriod(
    new Date(`${last}T12:00:00Z`),
    input.unsuccessful.period,
    input.unsuccessful.unit,
  )
    .toISOString()
    .slice(0, 10);
  return input.talentPoolUntil && input.talentPoolUntil > until ? input.talentPoolUntil : until;
}
