import type {
  ClassifierAnswerValue,
  ClassifierQuestionKey,
  CreateIncident,
} from "@harbour/contracts";
import { HarmGrade, IncidentSeverity, IncidentType } from "@harbour/contracts";
import {
  ABUSE_TYPES,
  CLASSIFIER_QUESTION_KEYS,
  RIDDOR_EXCLUDED_CAUSES,
  SPECIFIED_INJURIES,
} from "@harbour/domain";
import type { Translator } from "@harbour/i18n";
import type { FieldErrors } from "./outcome";
import { readWhen } from "./uk-time";

/**
 * View logic for the incident forms (safety.md; register rows SAFE-001 and SAFE-002; hazards
 * HZ-013 and HZ-027): reading the "record an incident" form and the classifier's questions, and
 * saying each question in the catalogue's words. Pure and unit tested; the API checks everything
 * again and decides.
 */

export const INCIDENT_TYPES = IncidentType.options;
export const INCIDENT_SEVERITIES = IncidentSeverity.options;
export const HARM_GRADES = HarmGrade.options;
/** The API's limits (`CreateIncident`). */
export const DESCRIPTION_MAX = 4000;
export const NOTES_MAX = 2000;
const NUMBER_MAX = 100_000;

/**
 * The questions a reporter answers at the point of care, without `safety.incident.manage`: the
 * falls questions (head injury, anticoagulants; HZ-027). The API holds the same list
 * (`POINT_OF_CARE_QUESTIONS` in apps/api/src/routes/incidents.ts) and refuses any other.
 */
export const POINT_OF_CARE_QUESTIONS: readonly ClassifierQuestionKey[] = [
  "falls.head_injury",
  "falls.anticoagulant",
];

/** A classifier question as the API (or, for the falls questions, the domain) gives it. */
export interface QuestionItem {
  readonly key: string;
  readonly kind: "yes_no_unsure" | "days" | "hours" | "choice" | "choices";
  readonly text: string;
  readonly help: string | null;
  readonly options: readonly { readonly value: string; readonly label: string }[];
}

/** Words to show, and `lang` "en-GB" when they are the API's English, not the catalogue's. */
export interface Words {
  readonly text: string;
  readonly lang: "en-GB" | null;
}

export interface QuestionWords {
  readonly text: Words;
  readonly help: Words | null;
  readonly options: readonly (Words & { readonly value: string })[];
}

const KNOWN_QUESTIONS: ReadonlySet<string> = new Set(CLASSIFIER_QUESTION_KEYS);
const KNOWN_OPTIONS: ReadonlySet<string> = new Set(
  [...ABUSE_TYPES, ...SPECIFIED_INJURIES, ...RIDDOR_EXCLUDED_CAUSES].map((o) => o.value),
);
const WITH_HELP: ReadonlySet<string> = new Set([
  "harm.body_structure_changed",
  "service.threatens_safe_running",
  "riddor.work_connected",
  "riddor.non_worker_to_hospital",
  "falls.anticoagulant",
]);

/** "harm.pain_days" as an ICU select key ("harm_pain_days"), and as a form field name. */
export function questionField(key: string): string {
  return `q_${key.split(".").join("_")}`;
}
const selectKey = (key: string) => key.split(".").join("_");

/**
 * A question in the catalogue's words (the regulations' own words where it quotes them). A
 * question or option the catalogue does not know is shown in the API's English, marked as such,
 * never left out: an unanswered question keeps a notification undecided (HZ-013).
 */
export function questionWords(question: QuestionItem, t: Translator): QuestionWords {
  const known = KNOWN_QUESTIONS.has(question.key);
  const english = (text: string): Words => ({ text, lang: "en-GB" });
  const ours = (text: string): Words => ({ text, lang: null });
  const key = selectKey(question.key);
  const options =
    question.kind === "choice" || question.kind === "choices"
      ? question.options.map((o) => ({
          value: o.value,
          ...(known && KNOWN_OPTIONS.has(o.value)
            ? ours(t("safety.question.option", { option: o.value }))
            : english(o.label)),
        }))
      : [];
  if (!known) {
    return {
      text: english(question.text),
      help: question.help ? english(question.help) : null,
      options,
    };
  }
  return {
    text: ours(t("safety.question.text", { key })),
    help: WITH_HELP.has(question.key) ? ours(t("safety.question.help", { key })) : null,
    options,
  };
}

/** Who may answer which of an incident's open questions, as the API allows (ADR-0071). */
export function questionsYouMayAnswer<Q extends Pick<QuestionItem, "key">>(
  open: readonly Q[],
  context: {
    /** Holds `safety.incident.report` (the API's route needs it). */
    readonly canReport: boolean;
    /** Holds `safety.incident.manage`: every question. */
    readonly manages: boolean;
    /** Raised the incident: the point-of-care questions. */
    readonly raisedByYou: boolean;
    readonly closed: boolean;
    readonly restricted: boolean;
  },
): Q[] {
  if (!context.canReport || context.closed || context.restricted) return [];
  if (context.manages) return [...open];
  if (!context.raisedByYou) return [];
  return open.filter((q) => (POINT_OF_CARE_QUESTIONS as readonly string[]).includes(q.key));
}

/** FormData, or anything with its `get` and `getAll`. */
export interface FormValues {
  get(name: string): FormDataEntryValue | null;
  getAll(name: string): FormDataEntryValue[];
}

const text = (form: FormValues, name: string) => {
  const value = form.get(name);
  return typeof value === "string" ? value.trim() : "";
};

function wholeNumber(value: string): number | null {
  if (value.length === 0 || value.length > 6) return null;
  for (const char of value) if (char < "0" || char > "9") return null;
  const number = Number(value);
  return number <= NUMBER_MAX ? number : null;
}

export type AnswerRead =
  | { readonly answer: { key: ClassifierQuestionKey; value: ClassifierAnswerValue } }
  | { readonly error: "number" | "both" | "noneWithOthers" | "choice" | "unsureWithOthers" }
  | { readonly blank: true };

/**
 * One question's answer from the form: yes, no or not sure; a whole number of days or hours, or
 * not sure; one option, or not sure; several options ("none of these" on its own), or not sure.
 * A question left blank is not answered and stays open.
 */
export function readAnswer(form: FormValues, question: QuestionItem): AnswerRead {
  const name = questionField(question.key);
  const key = question.key as ClassifierQuestionKey;
  const values = new Set(question.options.map((o) => o.value));
  switch (question.kind) {
    case "yes_no_unsure": {
      const value = text(form, name);
      if (!value) return { blank: true };
      return value === "yes" || value === "no" || value === "unsure"
        ? { answer: { key, value } }
        : { error: "choice" };
    }
    case "days":
    case "hours": {
      const value = text(form, name);
      const unsure = text(form, `${name}-unsure`) === "unsure";
      if (unsure && value) return { error: "both" };
      if (unsure) return { answer: { key, value: "unsure" } };
      if (!value) return { blank: true };
      const number = wholeNumber(value);
      return number === null ? { error: "number" } : { answer: { key, value: number } };
    }
    case "choice": {
      const value = text(form, name);
      if (!value) return { blank: true };
      return value === "unsure" || values.has(value)
        ? { answer: { key, value } }
        : { error: "choice" };
    }
    case "choices": {
      const chosen = [
        ...new Set(form.getAll(name).filter((v): v is string => typeof v === "string")),
      ];
      if (chosen.length === 0) return { blank: true };
      if (chosen.includes("unsure")) {
        return chosen.length === 1
          ? { answer: { key, value: "unsure" } }
          : { error: "unsureWithOthers" };
      }
      if (!chosen.every((v) => values.has(v))) return { error: "choice" };
      if (chosen.includes("none") && chosen.length > 1) return { error: "noneWithOthers" };
      return { answer: { key, value: chosen } };
    }
  }
}

export type AnswersRead =
  | {
      readonly ok: true;
      readonly answers: { key: ClassifierQuestionKey; value: ClassifierAnswerValue }[];
    }
  | { readonly ok: false; readonly errors: FieldErrors };

/**
 * The answers to send, or the errors at each question. With `required`, every question must be
 * answered (not sure is an answer); otherwise at least one.
 */
export function readAnswers(
  form: FormValues,
  questions: readonly QuestionItem[],
  t: Translator,
  required = false,
): AnswersRead {
  const errors: Record<string, string> = {};
  const answers: { key: ClassifierQuestionKey; value: ClassifierAnswerValue }[] = [];
  for (const question of questions) {
    const read = readAnswer(form, question);
    const field = questionField(question.key);
    if ("answer" in read) answers.push(read.answer);
    else if ("error" in read) {
      errors[field] = t("safety.questions.error", { error: read.error, kind: question.kind });
    } else if (required) errors[field] = t("safety.questions.error", { error: "required" });
  }
  if (Object.keys(errors).length > 0) return { ok: false, errors };
  const first = questions[0];
  if (answers.length === 0 && first) {
    return {
      ok: false,
      errors: { [questionField(first.key)]: t("safety.questions.error", { error: "noAnswers" }) },
    };
  }
  return { ok: true, answers };
}

/** The new incident to send, without its client id and the device's clock (the action adds them). */
export type IncidentDraft = Omit<CreateIncident, "id" | "deviceTime">;

export type IncidentRead =
  | { readonly ok: true; readonly draft: IncidentDraft }
  | {
      readonly ok: false;
      readonly errors: FieldErrors;
      readonly parts?: Readonly<Record<string, readonly string[]>>;
    };

const yesNo = (form: FormValues, name: string): boolean | null => {
  const value = text(form, name);
  return value === "yes" ? true : value === "no" ? false : null;
};

/**
 * Reads the "record an incident" form. Whether emergency services were called and whether the
 * GP was contacted are asked every time and never assumed "no" (#42 review); so is whether the
 * person died, when the incident is about someone. A fall asks the point-of-care questions
 * (HZ-027), each answered, "not sure yet" included. Errors come in the form's order.
 */
export function readIncidentForm(
  form: FormValues,
  context: {
    /** The person the incident is about, from their record; null for none. */
    readonly personId: string | null;
    /** Their home, or the locations the form offers. */
    readonly locationIds: readonly string[];
    readonly fallQuestions: readonly QuestionItem[];
    readonly now: Date;
  },
  t: Translator,
): IncidentRead {
  const errors: Record<string, string> = {};
  const parts: Record<string, readonly string[]> = {};
  const error = (field: string) => {
    errors[field] = t("safety.record.error", { field });
  };
  const locationId =
    context.locationIds.length === 1 ? (context.locationIds[0] ?? "") : text(form, "location");
  if (!context.locationIds.includes(locationId)) error("location");
  const type = text(form, "type") as IncidentType;
  if (!INCIDENT_TYPES.includes(type)) error("type");
  const when = readWhen(form, "occurredAt", t, { now: context.now });
  if (!when.ok) {
    errors.occurredAt = when.message;
    parts.occurredAt = when.parts;
  }
  const description = text(form, "description");
  if (description.length < 3 || description.length > DESCRIPTION_MAX) error("description");
  const immediateActions = text(form, "immediateActions");
  if (immediateActions.length > DESCRIPTION_MAX) error("immediateActions");
  const severity = text(form, "severity");
  const harmGrade = text(form, "harmGrade");
  const emergencyServicesCalled = yesNo(form, "emergencyServicesCalled");
  if (emergencyServicesCalled === null) error("emergencyServicesCalled");
  const gpContacted = yesNo(form, "gpContacted");
  if (gpContacted === null) error("gpContacted");
  const contactNotes = text(form, "contactNotes");
  if (contactNotes.length > NOTES_MAX) error("contactNotes");
  const died = context.personId ? yesNo(form, "died") : false;
  if (died === null) error("died");
  const injuryDetails = text(form, "injuryDetails");
  if (injuryDetails.length > NOTES_MAX) error("injuryDetails");
  const answers =
    type === "fall" && context.fallQuestions.length > 0
      ? readAnswers(form, context.fallQuestions, t, true)
      : ({ ok: true, answers: [] } satisfies AnswersRead);
  if (!answers.ok) Object.assign(errors, answers.errors);
  if (Object.keys(errors).length > 0 || !when.ok) {
    return { ok: false, errors, ...(Object.keys(parts).length > 0 ? { parts } : {}) };
  }
  return {
    ok: true,
    draft: {
      locationId,
      type,
      occurredAt: when.instant,
      description,
      ...(immediateActions ? { immediateActions } : {}),
      ...((INCIDENT_SEVERITIES as readonly string[]).includes(severity)
        ? { severity: severity as IncidentDraft["severity"] & string }
        : {}),
      ...((HARM_GRADES as readonly string[]).includes(harmGrade)
        ? { harmGrade: harmGrade as IncidentDraft["harmGrade"] & string }
        : {}),
      emergencyServicesCalled: emergencyServicesCalled === true,
      gpContacted: gpContacted === true,
      ...(contactNotes ? { contactNotes } : {}),
      people: context.personId
        ? [
            {
              kind: "service_user",
              role: "affected",
              personId: context.personId,
              died: died === true,
              bodyMapMarkIds: [],
              ...(injuryDetails ? { injuryDetails } : {}),
            },
          ]
        : [],
      answers: answers.ok ? answers.answers : [],
    },
  };
}
