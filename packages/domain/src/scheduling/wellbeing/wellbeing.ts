import {
  type RateNation,
  RateNotFoundError,
  type RateRow,
  resolveRate,
} from "../../platform/rates";
import { ukIsoDate } from "../../shared/working-days";
import { DAYS_PER_WEEK, plusDays } from "../intervals";

/**
 * Staff wellbeing and voice (scheduling.md section 16; SCHED-011). These rules cover pulse
 * surveys and who may see their results, and recognition and check-in checks. They are pure. The
 * minimum group size comes from the rate table (`wellbeing.survey_min_group_size`). The limits
 * here are form sizes, not working time or pay figures, so this folder sits outside the scheduling
 * literal check. Nothing here scores, ranks or judges anyone.
 */

export const QUESTION_KINDS = ["scale", "free_text"] as const;
export type QuestionKind = (typeof QUESTION_KINDS)[number];

/** A scale answer: a whole number from the lowest to the highest point. */
export const SCALE_LOWEST = 1;
export const SCALE_HIGHEST = 5;
export const MAX_QUESTIONS = 20;
export const MAX_QUESTION_TEXT = 300;
export const MAX_FREE_TEXT = 2000;
export const MAX_RECOGNITION = 500;
export const MAX_CHECK_IN_NOTE = 1000;
export const MIN_GROUP_SIZE_RATE_KEY = "wellbeing.survey_min_group_size";

export interface SurveyQuestion {
  readonly id: string;
  readonly kind: QuestionKind;
  readonly text: string;
}

export const SURVEY_STATES = ["draft", "open", "closed"] as const;
export type SurveyState = (typeof SURVEY_STATES)[number];

export type SurveyProblem =
  | "no_questions"
  | "too_many_questions"
  | "duplicate_question"
  | "question_text_required"
  | "question_text_too_long"
  | "closes_before_opens"
  | "wrong_state"
  | "not_draft";

/** Whether a survey's questions and dates are allowed (rule 1). */
export function checkSurveyDefinition(input: {
  readonly questions: readonly SurveyQuestion[];
  readonly opensOn: string;
  readonly closesOn: string;
}): SurveyProblem | null {
  if (input.questions.length === 0) return "no_questions";
  if (input.questions.length > MAX_QUESTIONS) return "too_many_questions";
  const ids = new Set(input.questions.map((q) => q.id));
  if (ids.size !== input.questions.length) return "duplicate_question";
  for (const q of input.questions) {
    if (!q.text.trim()) return "question_text_required";
    if (q.text.length > MAX_QUESTION_TEXT) return "question_text_too_long";
  }
  if (input.closesOn < input.opensOn) return "closes_before_opens";
  return null;
}

const MOVES: Readonly<Record<SurveyState, readonly SurveyState[]>> = {
  draft: ["open"],
  open: ["closed"],
  closed: [],
};

/** Whether a survey may move (rule 1): draft, then open, then closed, never back. */
export function checkSurveyMove(from: SurveyState, to: SurveyState): SurveyProblem | null {
  return MOVES[from].includes(to) ? null : "wrong_state";
}

export type ResponseProblem =
  | "nothing_answered"
  | "unknown_question"
  | "scale_out_of_range"
  | "free_text_empty"
  | "free_text_too_long"
  | "wrong_kind";

export type SurveyAnswers = Readonly<Record<string, number | string>>;

/** Whether a response's answers fit the survey's questions (rule 2). */
export function checkResponse(
  questions: readonly SurveyQuestion[],
  answers: SurveyAnswers,
): ResponseProblem | null {
  const keys = Object.keys(answers);
  if (keys.length === 0) return "nothing_answered";
  for (const key of keys) {
    const question = questions.find((q) => q.id === key);
    if (!question) return "unknown_question";
    const value = answers[key];
    if (question.kind === "scale") {
      if (typeof value !== "number") return "wrong_kind";
      if (!Number.isInteger(value) || value < SCALE_LOWEST || value > SCALE_HIGHEST) {
        return "scale_out_of_range";
      }
    } else {
      if (typeof value !== "string") return "wrong_kind";
      if (!value.trim()) return "free_text_empty";
      if (value.length > MAX_FREE_TEXT) return "free_text_too_long";
    }
  }
  return null;
}

/**
 * The Monday of the UK week an instant falls in (rule 3): a response keeps only this, never its
 * time.
 */
export function ukWeekStart(instant: Date): string {
  const date = ukIsoDate(instant);
  // getUTCDay is 0 for Sunday; the week starts on Monday.
  const weekday = new Date(`${date}T12:00:00Z`).getUTCDay();
  return plusDays(date, weekday === 0 ? 1 - DAYS_PER_WEEK : 1 - weekday);
}

/**
 * The minimum group size in force (rule 4): the larger of the global figure and the
 * organisation's own, so an organisation can raise it and never lower it. Null when no global
 * figure is in force. Then results never show.
 */
export function minGroupSize(
  rows: readonly RateRow[],
  nation: Exclude<RateNation, "uk" | "all">,
  on: string,
  tenantId: string,
): number | null {
  const read = (forTenant: string | null): number | null => {
    try {
      const rate = resolveRate(
        rows.filter((r) => (forTenant === null ? r.tenantId === null : true)),
        MIN_GROUP_SIZE_RATE_KEY,
        nation,
        on,
        forTenant,
      );
      return Number(rate.value);
    } catch (error) {
      if (error instanceof RateNotFoundError) return null;
      throw error;
    }
  };
  const global = read(null);
  if (global === null) return null;
  const own = read(tenantId);
  return Math.max(global, own ?? global);
}

export type ResultsVisibility =
  | { readonly visible: true }
  | { readonly visible: false; readonly reason: "still_open" | "too_few" | "no_size" };

/**
 * Whether a survey's results, or one question's, may show (rule 4). They show only once the
 * survey has closed and only when at least the minimum group size answered. Below the size, no
 * count shows either.
 */
export function resultsVisible(
  state: SurveyState,
  answered: number,
  size: number | null,
): ResultsVisibility {
  if (state !== "closed") return { visible: false, reason: "still_open" };
  if (size === null) return { visible: false, reason: "no_size" };
  if (answered < size) return { visible: false, reason: "too_few" };
  return { visible: true };
}

export type RecognitionProblem = "to_self" | "message_required" | "message_too_long";

/** Whether a recognition note is allowed (rule 5). */
export function checkRecognition(input: {
  readonly fromMemberId: string;
  readonly toMemberId: string;
  readonly message: string;
}): RecognitionProblem | null {
  if (input.fromMemberId === input.toMemberId) return "to_self";
  if (!input.message.trim()) return "message_required";
  if (input.message.length > MAX_RECOGNITION) return "message_too_long";
  return null;
}

export type CheckInProblem = "mood_out_of_range" | "note_too_long";

/** Whether a check-in is allowed (rule 6): the member's own word for how they are, 1 to 5. */
export function checkCheckIn(input: {
  readonly mood: number;
  readonly note: string | null;
}): CheckInProblem | null {
  if (!Number.isInteger(input.mood) || input.mood < SCALE_LOWEST || input.mood > SCALE_HIGHEST) {
    return "mood_out_of_range";
  }
  if (input.note !== null && input.note.length > MAX_CHECK_IN_NOTE) return "note_too_long";
  return null;
}

/**
 * A scale question's counts as they may show (rule 4; security review of slice 44, finding 4): a
 * count of at least one but below the minimum group size is hidden (null), and when exactly one
 * would be hidden, the smallest count at or above the size is hidden too, so a hidden count is
 * never the total less the others. Zeros show. `app.pulse_survey_results` applies the same rule.
 */
export function suppressCounts(counts: readonly number[], size: number): (number | null)[] {
  const small = (c: number) => c > 0 && c < size;
  const hidden = counts.filter(small).length;
  const shown = counts.filter((c) => !small(c) && c >= size);
  const alsoHide = hidden === 1 && shown.length > 0 ? Math.min(...shown) : null;
  return counts.map((c) => (small(c) || c === alsoHide ? null : c));
}
