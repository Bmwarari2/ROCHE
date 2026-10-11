import type {
  CreateRiskAssessment,
  RiskAssessmentItem,
  RiskTemplateList,
} from "@harbour/contracts";
import type { FormLike } from "./assessment-answers";
import { readNumber, readWholeNumber, readYesNo } from "./assessments";

/**
 * Positive risk assessments (care.md slice 4b; register row CARE-002; ADR-0032). Likelihood and
 * severity are the assessor's judgements; the API works out the rating with the NPSA matrix and
 * checks bed rail measurements against the MHRA figures. Falls are never rated (NICE NG249 1.1.1).
 */

export type RiskTemplate = RiskTemplateList["items"][number];
export type RiskFields = Omit<CreateRiskAssessment, "templateKey">;

const text = (form: FormLike, name: string) => {
  const entry = form.get(name);
  return typeof entry === "string" ? entry.trim() : "";
};

function scale(form: FormLike, name: string): number | null {
  const score = readWholeNumber(form.get(name));
  return score !== null && score >= 1 && score <= 5 ? score : null;
}

/** The form field name of a template question's answer. */
export const answerField = (key: string) => `answer.${key}`;

/** Splits "other controls" typed one per line, without blank lines. */
export function controlLines(value: string): string[] {
  return value
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
}

/**
 * Reads a risk assessment from its form. Unanswered questions are left out; the API says what is
 * still needed in words (for example a positive risk statement while a high risk remains).
 */
export function readRiskFields(form: FormLike, template: RiskTemplate): RiskFields {
  const answers: Record<string, boolean | number | string | null> = {};
  for (const question of template.questions) {
    const field = answerField(question.key);
    if (question.kind === "yes_no") {
      const answer = readYesNo(form.get(field));
      if (answer !== null) answers[question.key] = answer;
    } else if (question.kind === "measurement_mm") {
      const mm = readNumber(form.get(field));
      if (mm !== null) answers[question.key] = mm;
    } else {
      const words = text(form, field);
      if (words) answers[question.key] = words;
    }
  }
  const suggested = form
    .getAll("controls")
    .filter((entry): entry is string => typeof entry === "string" && entry.trim().length > 0);
  const reviewDueOn = text(form, "reviewDueOn");
  const positive = text(form, "positiveRiskStatement");
  const views = text(form, "personViews");
  const rated = template.rated;
  return {
    hazard: text(form, "hazard"),
    whoAtRisk: text(form, "whoAtRisk"),
    answers,
    likelihood: rated ? scale(form, "likelihood") : null,
    severity: rated ? scale(form, "severity") : null,
    residualLikelihood: rated ? scale(form, "residualLikelihood") : null,
    residualSeverity: rated ? scale(form, "residualSeverity") : null,
    controls: [...suggested, ...controlLines(text(form, "otherControls"))],
    positiveRiskStatement: positive || null,
    personViews: views || null,
    assessedOn: text(form, "assessedOn"),
    ...(reviewDueOn ? { reviewDueOn } : {}),
  };
}

export type RiskChip = "overdue" | "due" | "neutral";

/** How strongly a band is shown; the words come with it. */
export function riskChip(band: RiskAssessmentItem["riskBand"]): RiskChip {
  if (band === "extreme" || band === "high") return "overdue";
  if (band === "moderate") return "due";
  return "neutral";
}

/** The review date has passed (UK dates compared as text, yyyy-mm-dd). */
export function reviewOverdue(
  item: Pick<RiskAssessmentItem, "reviewDueOn" | "status">,
  today: string,
): boolean {
  return item.status === "active" && item.reviewDueOn < today;
}

/** Controls from the template that the assessment already has, and the others typed by hand. */
export function splitControls(
  controls: readonly string[],
  template: RiskTemplate,
): { readonly suggested: string[]; readonly other: string[] } {
  const known = new Set(template.suggestedControls);
  return {
    suggested: controls.filter((control) => known.has(control)),
    other: controls.filter((control) => !known.has(control)),
  };
}
