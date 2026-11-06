import type {
  PulseQuestionResult,
  PulseSurveyItem,
  PulseSurveyState,
  SurveyQuestion,
} from "@harbour/contracts";
import type { Translator } from "@harbour/i18n";
import type { StatusChipStatus } from "@harbour/ui";
import type { FieldProblem } from "./outcome";
import { readDateField } from "./uk-time";

/**
 * Staff wellbeing screens (SCHED-011, Phase 2 slice 61; scheduling.md section 16). The API decides
 * who answers, when results show and who sees what. These helpers word and order what it returns
 * and check forms before they are sent. Nothing here scores or judges anyone. Results are shown
 * only when the API says they are visible, and a scale's counts all or none: if the API hides any
 * one count, the screen hides every count for that question (rule 4).
 */

export const WELLBEING_PERMISSIONS = {
  self: "scheduling.wellbeing.self",
  manage: "scheduling.wellbeing.manage",
} as const;

export interface WellbeingAccess {
  readonly self: boolean;
  readonly manage: boolean;
}

export function wellbeingAccess(permissions: readonly string[]): WellbeingAccess {
  return {
    self: permissions.includes(WELLBEING_PERMISSIONS.self),
    manage: permissions.includes(WELLBEING_PERMISSIONS.manage),
  };
}

export function wellbeingNavShown(permissions: readonly string[]): boolean {
  const access = wellbeingAccess(permissions);
  return access.self || access.manage;
}

export const MOODS = [1, 2, 3, 4, 5] as const;
export const SCALE_POINTS = [1, 2, 3, 4, 5] as const;
export const MAX_QUESTIONS = 20;

/** A survey's state as an icon and words, never colour alone. */
export function surveyStateChip(
  state: PulseSurveyState,
  t: Translator,
): { readonly status: StatusChipStatus; readonly label: string } {
  const label = t("scheduling.wellbeing.survey.state", { state });
  switch (state) {
    case "draft":
      return { status: "neutral", label };
    case "open":
      return { status: "info", label };
    case "closed":
      return { status: "done", label };
  }
}

/** The surveys a member can still answer: open, and not answered yet. */
export function toAnswer(items: readonly PulseSurveyItem[]): PulseSurveyItem[] {
  return items.filter((s) => s.state === "open" && s.answered !== true);
}

interface FormLike {
  get(name: string): FormDataEntryValue | null;
  getAll(name: string): FormDataEntryValue[];
}

const text = (form: FormLike, name: string) => {
  const value = form.get(name);
  return typeof value === "string" ? value.trim() : "";
};

export interface SurveyDraft {
  readonly locationId: string | null;
  readonly title: string;
  readonly questions: SurveyQuestion[];
  readonly opensOn: string;
  readonly closesOn: string;
}

/**
 * Reads the survey form: where (a home, or "organisation"), the title, the dates and the first
 * `count` questions (`q-<n>-kind`, `q-<n>-text`). Question ids are `q1`, `q2` and so on, by
 * position, so they stay distinct.
 */
export function readSurvey(
  form: FormLike,
  count: number,
  t: Translator,
): { ok: true; draft: SurveyDraft } | { ok: false; problems: FieldProblem[] } {
  const problems: FieldProblem[] = [];
  const where = text(form, "locationId");
  if (!where) {
    problems.push({ field: "locationId", message: t("scheduling.wellbeing.form.whereRequired") });
  }
  const title = text(form, "title");
  if (title.length === 0 || title.length > 120) {
    problems.push({ field: "title", message: t("scheduling.wellbeing.form.titleRequired") });
  }
  const opens = readDateField(form, "opensOn", {
    subject: t("scheduling.wellbeing.form.opensSubject"),
    t,
  });
  if (!opens.ok) problems.push({ field: "opensOn", message: opens.message, parts: opens.parts });
  const closes = readDateField(form, "closesOn", {
    subject: t("scheduling.wellbeing.form.closesSubject"),
    t,
  });
  if (!closes.ok) {
    problems.push({ field: "closesOn", message: closes.message, parts: closes.parts });
  } else if (opens.ok && opens.date && closes.date && closes.date < opens.date) {
    problems.push({
      field: "closesOn",
      message: t("scheduling.wellbeing.form.closesBeforeOpens"),
      parts: ["day", "month", "year"],
    });
  }
  const questions: SurveyQuestion[] = [];
  for (let index = 0; index < count; index += 1) {
    const n = index + 1;
    const kind = text(form, `q-${n}-kind`);
    const words = text(form, `q-${n}-text`);
    if (kind !== "scale" && kind !== "free_text") {
      problems.push({
        field: `q-${n}-kind`,
        message: t("scheduling.wellbeing.form.kindRequired", { n }),
      });
    }
    if (words.length === 0 || words.length > 300) {
      problems.push({
        field: `q-${n}-text`,
        message: t("scheduling.wellbeing.form.questionRequired", { n }),
      });
    }
    questions.push({
      id: `q${n}`,
      kind: kind === "free_text" ? "free_text" : "scale",
      text: words,
    });
  }
  if (count < 1) {
    problems.push({ field: "q-1-text", message: t("scheduling.wellbeing.form.noQuestions") });
  }
  if (problems.length > 0) return { ok: false, problems };
  return {
    ok: true,
    draft: {
      locationId: where === "organisation" ? null : where,
      title,
      questions,
      opensOn: opens.ok ? (opens.date ?? "") : "",
      closesOn: closes.ok ? (closes.date ?? "") : "",
    },
  };
}

/**
 * Reads an answer form: a point from 1 to 5 for a scale, words for free text, each optional; at
 * least one question answered (rule 2). Nothing about the person is read or sent.
 */
export function readAnswers(
  form: FormLike,
  questions: readonly SurveyQuestion[],
  t: Translator,
):
  | { ok: true; answers: Record<string, number | string> }
  | { ok: false; problems: FieldProblem[] } {
  const answers: Record<string, number | string> = {};
  const problems: FieldProblem[] = [];
  for (const q of questions) {
    const value = text(form, `answer-${q.id}`);
    if (!value) continue;
    if (q.kind === "scale") {
      const point = /^[1-5]$/.test(value) ? Number(value) : null;
      if (point === null) {
        problems.push({
          field: `answer-${q.id}`,
          message: t("scheduling.wellbeing.answer.pointRequired"),
        });
      } else {
        answers[q.id] = point;
      }
    } else if (value.length > 2000) {
      problems.push({ field: `answer-${q.id}`, message: t("scheduling.wellbeing.answer.tooLong") });
    } else {
      answers[q.id] = value;
    }
  }
  if (problems.length === 0 && Object.keys(answers).length === 0) {
    const first = questions[0];
    problems.push({
      field: first ? `answer-${first.id}` : "answers",
      message: t("scheduling.wellbeing.answer.atLeastOne"),
    });
  }
  if (problems.length > 0) return { ok: false, problems };
  return { ok: true, answers };
}

export type QuestionView =
  | { readonly kind: "hidden" }
  | {
      readonly kind: "scale";
      readonly answered: number | null;
      readonly counts: readonly number[] | null;
    }
  | {
      readonly kind: "free_text";
      readonly answered: number | null;
      readonly texts: readonly string[];
    };

/**
 * What a question's results may show. A question the API hides shows nothing. A scale shows every
 * count or none: one hidden count (null) hides them all, so a hidden count can never be worked out
 * from the others and the number who answered; and a point chosen by more than the answers less
 * the size hides them all too, so a unanimous or near-unanimous answer never shows the few others'.
 */
export function questionView(q: PulseQuestionResult, minGroupSize: number | null): QuestionView {
  if (!q.visible) return { kind: "hidden" };
  const answered = q.answered ?? null;
  if (q.kind === "scale") {
    const counts = q.counts ?? [];
    // Again here: one point holding more than the answers less the size would show what the
    // few others chose, or, when unanimous, what everyone chose.
    const nearlyAll =
      minGroupSize === null ||
      answered === null ||
      counts.some((c) => c !== null && c > answered - minGroupSize);
    const whole =
      !nearlyAll &&
      counts.length === SCALE_POINTS.length &&
      counts.every((c): c is number => c !== null);
    return { kind: "scale", answered, counts: whole ? (counts as number[]) : null };
  }
  return { kind: "free_text", answered, texts: q.texts ?? [] };
}

/** The moves a manager may make on a survey: open a draft, close an open one. */
export function surveyMoves(state: PulseSurveyState): readonly ("open" | "close")[] {
  if (state === "draft") return ["open"];
  if (state === "open") return ["close"];
  return [];
}
