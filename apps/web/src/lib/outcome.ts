import type { Translator } from "@harbour/i18n";

/**
 * What a care record server action returns to its form: the saved record, or a message that says
 * what to do next (CONTENT.md: never blame, never show codes). When the API refuses an entry with
 * a reason (for example a body-map side that disagrees with the drawing, HZ-019, or a food texture
 * without an override reason, HZ-016) its own words are shown, because they name the rule.
 */
export type ActionResult<T = null> =
  | { readonly ok: true; readonly data: T }
  | { readonly ok: false; readonly code: string; readonly message: string };

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

/** The message a form shows for a refused or failed request. */
export function problemMessage(error: unknown, t: Translator): { code: string; message: string } {
  const problem = asProblem(error);
  const code = typeof problem.code === "string" ? problem.code : "unavailable";
  const detail = typeof problem.detail === "string" ? problem.detail.trim() : "";
  switch (code) {
    case "invalid":
      return {
        code,
        message: detail && !isTechnicalDetail(detail) ? detail : t("care.errors.invalid"),
      };
    case "feature_disabled":
      return { code, message: detail || t("care.errors.featureDisabled") };
    case "version_conflict":
      return { code, message: t("care.errors.conflict") };
    case "missing_permission":
    case "mfa_enrolment_required":
      return { code, message: t("errors.forbidden") };
    case "step_up_required":
      return { code, message: t("errors.stepUpRequired") };
    case "not_found":
      return { code, message: t("errors.notFound") };
    default:
      return { code: "unavailable", message: t("care.errors.unavailable") };
  }
}

/** A refusal the form found before sending anything. */
export function refused(message: string, code = "invalid"): ActionResult<never> {
  return { ok: false, code, message };
}
