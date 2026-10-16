import type { Translator } from "@harbour/i18n";
import { knownRefusals } from "./refusals";

/**
 * What a care record server action returns to its form: the saved record, or a message that says
 * what to do next (CONTENT.md: never blame, never show codes). A refusal can name the fields it is
 * about, so each field shows its own error (aria-invalid and aria-describedby) and the summary at
 * the end of the form links to it (WCAG 3.3.1 and 1.3.1).
 */

/** Field key to the error shown at that field. Keys are the form's field names. */
export type FieldErrors = Readonly<Record<string, string>>;

export type ActionResult<T = null> =
  | { readonly ok: true; readonly data: T }
  | {
      readonly ok: false;
      readonly code: string;
      readonly message: string;
      readonly fields?: FieldErrors;
      /** For a date or time field, the boxes the error is about ("day", "hour", "fold"). */
      readonly parts?: Readonly<Record<string, readonly string[]>>;
    };

interface ProblemLike {
  readonly code?: unknown;
  readonly detail?: unknown;
}

function asProblem(error: unknown): ProblemLike {
  return typeof error === "object" && error !== null ? (error as ProblemLike) : {};
}

/**
 * Request validation messages from the API name fields by their path ("values.ml: Too small").
 * They are for developers; the forms check the same limits first, so people rarely see one.
 */
function isTechnicalDetail(detail: string): boolean {
  const colon = detail.indexOf(": ");
  if (colon <= 0) return false;
  const path = detail.slice(0, colon);
  for (const char of path) {
    const code = char.charCodeAt(0);
    const isLetter = (code >= 65 && code <= 90) || (code >= 97 && code <= 122);
    const isDigit = code >= 48 && code <= 57;
    if (!isLetter && !isDigit && char !== "." && char !== "_") return false;
  }
  return path.includes(".") || path === "body";
}

export interface Problem {
  readonly code: string;
  readonly message: string;
  readonly fields?: FieldErrors;
}

/**
 * The message a form shows for a refused or failed request. A refusal the web app knows (a body
 * map side that disagrees with the drawing, HZ-019; a texture without its reason, HZ-016) is said
 * in the catalogue's words and tied to its fields; only a refusal it does not know shows the API's
 * own words.
 */
export function problemMessage(error: unknown, t: Translator): Problem {
  const problem = asProblem(error);
  const code = typeof problem.code === "string" ? problem.code : "unavailable";
  const detail = typeof problem.detail === "string" ? problem.detail.trim() : "";
  switch (code) {
    case "invalid": {
      const [first, ...others] = knownRefusals(detail);
      if (first) {
        const fields: Record<string, string> = {};
        for (const refusal of [first, ...others]) {
          const words = t(`care.refusal.${refusal.key}`);
          for (const field of refusal.fields) fields[field] ??= words;
        }
        return {
          code,
          message: t(`care.refusal.${first.key}`),
          ...(Object.keys(fields).length > 0 ? { fields } : {}),
        };
      }
      return {
        code,
        message: detail && !isTechnicalDetail(detail) ? detail : t("care.errors.invalid"),
      };
    }
    case "feature_disabled":
      return { code, message: detail || t("care.errors.featureDisabled") };
    case "version_conflict":
      return { code, message: t("care.errors.conflict") };
    // A save sent again with its id kept, after the first reached Harbour, but with other details
    // (HZ-029, HZ-015; #26 review round 3): what was saved stands, so the person reloads, checks
    // it and enters the change again, never told someone else changed the record.
    case "already_saved_differently":
      return { code, message: t("care.errors.alreadySavedDifferently") };
    case "missing_permission":
    case "mfa_enrolment_required":
      return { code, message: t("errors.forbidden") };
    case "step_up_required":
      return { code, message: t("errors.stepUpRequired") };
    case "mfa_verification_required":
      return { code, message: t("errors.mfaVerifyRequired") };
    case "not_found":
      return { code, message: t("errors.notFound") };
    default:
      return { code: "unavailable", message: t("care.errors.unavailable") };
  }
}

/**
 * A refusal the form found before sending anything. With `fields`, each named field shows the
 * message (or its own, when `fields` maps keys to messages).
 */
export function refused(
  message: string,
  code = "invalid",
  fields?: readonly string[] | FieldErrors,
): ActionResult<never> {
  if (!fields) return { ok: false, code, message };
  const errors: Record<string, string> = {};
  if (Array.isArray(fields)) {
    for (const key of fields as readonly string[]) errors[key] = message;
  } else {
    Object.assign(errors, fields);
  }
  return { ok: false, code, message, fields: errors };
}

/** A refusal about one or more fields, each with its own message, in the order given. */
export function fieldErrors(errors: FieldErrors): ActionResult<never> {
  const first = Object.values(errors)[0] ?? "";
  return { ok: false, code: "invalid", message: first, fields: errors };
}

/** A date or time the form could not read, at its field and the boxes it is about. */
export function partsRefusal(
  field: string,
  problem: { readonly message: string; readonly parts: readonly string[] },
): ActionResult<never> {
  return {
    ok: false,
    code: "invalid",
    message: problem.message,
    fields: { [field]: problem.message },
    parts: { [field]: problem.parts },
  };
}

/** The boxes of a date or time field the last result named, if any. */
export function partsFor(
  result: ActionResult<unknown> | null,
  field: string,
): readonly string[] | undefined {
  return result && !result.ok ? result.parts?.[field] : undefined;
}

/** The error to show at a field, if the last result named it. */
export function errorFor(result: ActionResult<unknown> | null, field: string): string | undefined {
  return result && !result.ok ? result.fields?.[field] : undefined;
}

/** True when the outcome of a request is not known (the network or the API failed), so a retry
 * must reuse the entry's id to stay one entry. */
export function outcomeUnknown(result: ActionResult<unknown>): boolean {
  return !result.ok && result.code === "unavailable";
}
