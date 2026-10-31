/**
 * The audit programme and mock inspections (quality.md section 17, rules 8 to 15; QUAL-004; Reg 17).
 * Scored templates mapped to the framework, the score with its method, completion with actions for
 * what fell short, the self-rating on the CQC scale given by a person (never worked out from the
 * score), the next due date, and findings by statement for the evidence library. Pure functions.
 */

import { addDays, addMonths, isIsoDate } from "./quality-dates";
import { type FrameworkVersion, statementIds } from "./quality-framework";
import type { QualityPhase2Rates } from "./quality-rates";

export const AUDIT_KINDS = [
  "medication",
  "care_plans",
  "ipc",
  "environment",
  "dignity",
  "night_visit",
  "mock_inspection",
  "other",
] as const;
export type AuditKind = (typeof AUDIT_KINDS)[number];

export interface AuditQuestion {
  readonly key: string;
  readonly text: string;
  /** A positive whole number: how much the question counts in the score. */
  readonly weight: number;
  readonly statementIds: readonly string[];
  /** A "no" or "partial" needs an action with an owner and a due date. */
  readonly actionRequired: boolean;
}

export interface AuditTemplate {
  readonly key: string;
  readonly title: string;
  readonly kind: AuditKind;
  readonly frameworkVersionId: string;
  readonly questions: readonly AuditQuestion[];
}

export type AuditAnswer = "yes" | "partial" | "no" | "not_applicable";

export interface AuditAction {
  readonly questionKey: string;
  readonly description: string;
  readonly ownerId: string | null;
  /** UK date. */
  readonly dueOn: string | null;
}

export interface AuditRecord {
  readonly templateKey: string;
  /** The version it was scored against, kept for good (rule 4). */
  readonly frameworkVersionId: string;
  /** UK date the audit was carried out. */
  readonly auditedOn: string;
  readonly answers: Readonly<Record<string, AuditAnswer | null>>;
  readonly selfRating: number | null;
  readonly actions: readonly AuditAction[];
}

export type AuditTemplateProblem =
  | "no_questions"
  | "invalid_weight"
  | "unknown_statement"
  | "duplicate_question"
  | "wrong_framework";

/** Rule 8: what is wrong with a template; empty when it can be used. */
export function checkAuditTemplate(
  template: AuditTemplate,
  framework: FrameworkVersion,
): AuditTemplateProblem[] {
  const problems: AuditTemplateProblem[] = [];
  if (template.questions.length === 0) problems.push("no_questions");
  if (template.questions.some((q) => !Number.isInteger(q.weight) || q.weight < 1)) {
    problems.push("invalid_weight");
  }
  if (template.frameworkVersionId !== framework.id) problems.push("wrong_framework");
  const known = statementIds(framework);
  if (template.questions.some((q) => q.statementIds.some((s) => !known.has(s)))) {
    problems.push("unknown_statement");
  }
  if (new Set(template.questions.map((q) => q.key)).size !== template.questions.length) {
    problems.push("duplicate_question");
  }
  return problems;
}

/** How much each answer counts: in full, half, or nothing. */
const CREDIT: Readonly<Record<Exclude<AuditAnswer, "not_applicable">, number>> = {
  yes: 1,
  partial: 0.5,
  no: 0,
};

export interface AuditScore {
  /** 0 to 100, exact; null when nothing is answerable (never 0 or 100). */
  readonly percent: number | null;
  readonly complete: boolean;
  readonly unanswered: readonly string[];
  /** Weighted points achieved and possible, for the method shown beside the score. */
  readonly achieved: number;
  readonly possible: number;
}

/**
 * Rule 9: the weighted share of answerable questions, "yes" in full, "partial" half, "no" nothing;
 * "not applicable" leaves both sides; unanswered questions make the audit incomplete.
 */
export function scoreAudit(
  template: Pick<AuditTemplate, "questions">,
  answers: Readonly<Record<string, AuditAnswer | null>>,
): AuditScore {
  let achieved = 0;
  let possible = 0;
  const unanswered: string[] = [];
  for (const question of template.questions) {
    const answer = answers[question.key] ?? null;
    if (answer === null) {
      unanswered.push(question.key);
      continue;
    }
    if (answer === "not_applicable") continue;
    possible += question.weight;
    achieved += question.weight * CREDIT[answer];
  }
  return {
    percent: possible === 0 ? null : (achieved / possible) * 100,
    complete: unanswered.length === 0,
    unanswered,
    achieved,
    possible,
  };
}

/** Rule 11: the CQC words for each point of the rating scale, keyed by the number. */
export const SELF_RATING_WORDS: Readonly<Record<number, string>> = {
  1: "Inadequate",
  2: "Requires improvement",
  3: "Good",
  4: "Outstanding",
};

/** Rule 11: whether a self-rating is a whole number on the rate table's CQC scale. */
export function isValidSelfRating(
  rating: number | null,
  rates: Pick<QualityPhase2Rates, "ratingScaleMin" | "ratingScaleMax">,
): rating is number {
  return (
    rating !== null &&
    Number.isInteger(rating) &&
    rating >= rates.ratingScaleMin &&
    rating <= rates.ratingScaleMax
  );
}

export type AuditCompletionProblem =
  | "missing_permission"
  | "unanswered"
  | "action_missing"
  | "action_incomplete"
  | "action_due_before_audit"
  | "self_rating_missing";

export const AUDIT_COMPLETION_MESSAGES: Readonly<Record<AuditCompletionProblem, string>> = {
  missing_permission: "Only someone who runs audits can complete one.",
  unanswered: "Answer every question, or mark it not applicable.",
  action_missing: "Add an action for each answer that fell short.",
  action_incomplete: "Give every action a description, an owner and a due date.",
  action_due_before_audit: "An action cannot be due before the audit.",
  self_rating_missing: "Give your self-rating.",
};

/** Rule 10: why an audit cannot be completed yet, in order; empty when it can. */
export function checkAuditCompletion(
  template: AuditTemplate,
  audit: AuditRecord,
  rates: Pick<QualityPhase2Rates, "ratingScaleMin" | "ratingScaleMax">,
  permissions: readonly string[],
): AuditCompletionProblem[] {
  const problems: AuditCompletionProblem[] = [];
  if (!permissions.includes("quality.audit.manage")) problems.push("missing_permission");
  if (!scoreAudit(template, audit.answers).complete) problems.push("unanswered");
  const fellShort = template.questions.filter((q) => {
    const answer = audit.answers[q.key];
    return q.actionRequired && (answer === "no" || answer === "partial");
  });
  if (fellShort.some((q) => !audit.actions.some((a) => a.questionKey === q.key))) {
    problems.push("action_missing");
  }
  if (
    audit.actions.some(
      (a) =>
        a.description.trim().length === 0 ||
        a.ownerId === null ||
        a.dueOn === null ||
        !isIsoDate(a.dueOn),
    )
  ) {
    problems.push("action_incomplete");
  }
  if (
    audit.actions.some((a) => a.dueOn !== null && isIsoDate(a.dueOn) && a.dueOn < audit.auditedOn)
  ) {
    problems.push("action_due_before_audit");
  }
  if (!isValidSelfRating(audit.selfRating, rates)) problems.push("self_rating_missing");
  return problems;
}

/** Rule 12: an action's due date when the auditor chooses none (tenant default, UK days). */
export function defaultActionDueOn(
  auditedOn: string,
  rates: Pick<QualityPhase2Rates, "auditActionDueDays">,
): string {
  return addDays(auditedOn, rates.auditActionDueDays);
}

/**
 * Rule 13: when an audit is next due on its schedule's own frequency (calendar months, clamped to
 * the month's end), and whether it is overdue on a UK date (from the day after).
 */
export function nextAuditDue(
  lastCompletedOn: string,
  frequencyMonths: number,
  on: string,
): { readonly dueOn: string; readonly overdue: boolean } {
  if (!Number.isInteger(frequencyMonths) || frequencyMonths < 1) {
    throw new RangeError("An audit frequency is a whole number of months, at least one");
  }
  const dueOn = addMonths(lastCompletedOn, frequencyMonths);
  return { dueOn, overdue: on > dueOn };
}

/**
 * Rule 14: the answers that fell short ("no" and "partial"), grouped by the statements their
 * questions evidence, for the evidence library and the mock inspection report.
 */
export function auditFindingsByStatement(
  template: Pick<AuditTemplate, "questions">,
  answers: Readonly<Record<string, AuditAnswer | null>>,
): Map<string, string[]> {
  const findings = new Map<string, string[]>();
  for (const question of template.questions) {
    const answer = answers[question.key];
    if (answer !== "no" && answer !== "partial") continue;
    for (const statement of question.statementIds) {
      findings.set(statement, [...(findings.get(statement) ?? []), question.key]);
    }
  }
  return findings;
}

/**
 * Rule 9: the method shown beside a score, in words ("31.5 of 40 weighted points: yes counts in
 * full, partial half, not applicable is left out").
 */
export function auditScoreMethod(score: AuditScore): string {
  const round = (n: number) => Math.round(n * 10) / 10;
  return score.possible === 0
    ? "No question could be scored: every answer was not applicable."
    : `${round(score.achieved)} of ${round(score.possible)} weighted points: yes counts in full, partial counts half, no counts nothing, and not applicable is left out.`;
}
