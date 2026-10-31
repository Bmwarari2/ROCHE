import type { RaiseSpeakUp, SpeakUpCategory, SpeakUpState } from "@harbour/contracts";
import type { Translator } from "@harbour/i18n";
import type { SafetyChip } from "./incidents";
import type { FormLike } from "./uk-time";

/**
 * The speak-up screens (Phase 2 slice 62; SAFE-012; ADR-0089): pure and unit tested. Anyone in the
 * organisation may raise a named or confidential concern; anyone at all may raise an anonymous one
 * on the public page, which keeps nothing about them (no cookies, nothing stored in the browser).
 * The Freedom to Speak Up lead and the members they name on a case see the case. The API and the
 * database decide who sees what; these helpers only name things and read forms.
 */

export const SPEAK_UP_LEAD = "safety.speak_up.manage";
export const SPEAK_UP_CATEGORIES = [
  "care_quality_or_safety",
  "staff_safety",
  "conduct",
  "bullying_or_harassment",
  "fraud_or_finance",
  "other",
] as const satisfies readonly SpeakUpCategory[];
export const SPEAK_UP_SUMMARY_MAX = 10_000;
export const SPEAK_UP_MESSAGE_MAX = 10_000;
/** A 256-bit reply token as base64url. */
const REPLY_TOKEN = /^[A-Za-z0-9_-]{43}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function isReplyToken(value: string): boolean {
  return REPLY_TOKEN.test(value);
}

export function isOrganisationId(value: string): boolean {
  return UUID.test(value);
}

/** The public page's address for an organisation: what staff share with anyone who might speak up. */
export function anonymousPagePath(tenantId: string): string {
  return `/speak-up-anonymously/${tenantId}`;
}

/** Every member of staff may speak up; a family member's portal session may not. */
export function speakUpShown(permissions: readonly string[], familyMember: boolean): boolean {
  return !familyMember || permissions.includes(SPEAK_UP_LEAD);
}

export function isSpeakUpLead(permissions: readonly string[]): boolean {
  return permissions.includes(SPEAK_UP_LEAD);
}

/** The state as an icon and a word; one the web does not know is a warning, never a fact. */
export function speakUpStateChip(state: string, t: Translator): SafetyChip {
  switch (state) {
    case "received":
      return { status: "due", icon: "clock", label: t("speakUp.state", { state }) };
    case "acknowledged":
    case "under_review":
      return { status: "info", icon: "search", label: t("speakUp.state", { state }) };
    case "outcome_shared":
      return { status: "info", icon: "send", label: t("speakUp.state", { state }) };
    case "closed":
      return { status: "neutral", icon: "circle-check", label: t("speakUp.state", { state }) };
    default:
      return {
        status: "overdue",
        icon: "triangle-alert",
        label: t("speakUp.state", { state: "unknown" }),
      };
  }
}

type Read<T> =
  | { readonly ok: true; readonly body: T }
  | { readonly ok: false; readonly errors: Readonly<Record<string, string>> };

const text = (form: FormLike, name: string) => {
  const value = form.get(name);
  return typeof value === "string" ? value.trim() : "";
};
const category = (form: FormLike): SpeakUpCategory | null => {
  const value = text(form, "category");
  return (SPEAK_UP_CATEGORIES as readonly string[]).includes(value)
    ? (value as SpeakUpCategory)
    : null;
};

function summaryErrors(form: FormLike, t: Translator): Record<string, string> {
  const errors: Record<string, string> = {};
  if (!category(form)) errors.category = t("speakUp.form.categoryError");
  const summary = text(form, "summary");
  if (summary.length < 3 || summary.length > SPEAK_UP_SUMMARY_MAX) {
    errors.summary = t("speakUp.form.summaryError", { max: SPEAK_UP_SUMMARY_MAX });
  }
  return errors;
}

/** A member raising a concern with their name known: to the case, or to the lead only. */
export function readRaiseSpeakUp(
  form: FormLike,
  t: Translator,
  options: { readonly id: string },
): Read<RaiseSpeakUp> {
  const errors = summaryErrors(form, t);
  const identity = text(form, "identity");
  if (identity !== "named" && identity !== "confidential") {
    errors.identity = t("speakUp.form.identityError");
  }
  const chosen = category(form);
  if (Object.keys(errors).length > 0 || !chosen) return { ok: false, errors };
  return {
    ok: true,
    body: {
      id: options.id,
      identity: identity as "named" | "confidential",
      category: chosen,
      summary: text(form, "summary"),
    },
  };
}

/** The public page: no name at all, and whether they want a reply token to read replies. */
export function readAnonymousSpeakUp(
  form: FormLike,
  t: Translator,
): Read<{ category: SpeakUpCategory; summary: string; wantsReplies: boolean }> {
  const errors = summaryErrors(form, t);
  const chosen = category(form);
  if (Object.keys(errors).length > 0 || !chosen) return { ok: false, errors };
  return {
    ok: true,
    body: {
      category: chosen,
      summary: text(form, "summary"),
      wantsReplies: text(form, "wantsReplies") === "yes",
    },
  };
}

export function readReplyToken(form: FormLike, t: Translator): Read<{ replyToken: string }> {
  const replyToken = text(form, "replyToken");
  return isReplyToken(replyToken)
    ? { ok: true, body: { replyToken } }
    : { ok: false, errors: { replyToken: t("speakUp.anonymous.tokenError") } };
}

export function readMessage(form: FormLike, t: Translator): Read<{ body: string }> {
  const body = text(form, "body");
  return body.length >= 1 && body.length <= SPEAK_UP_MESSAGE_MAX
    ? { ok: true, body: { body } }
    : { ok: false, errors: { body: t("speakUp.message.error", { max: SPEAK_UP_MESSAGE_MAX }) } };
}

/** The lead's step: sharing the outcome needs it in words, closing needs a reason. */
export function readSpeakUpStep(
  form: FormLike,
  t: Translator,
  options: { readonly to: SpeakUpState; readonly version: number },
): Read<{ to: SpeakUpState; version: number; outcome?: string; reason?: string }> {
  const { to, version } = options;
  if (to === "outcome_shared") {
    const outcome = text(form, "outcome");
    return outcome.length >= 3
      ? { ok: true, body: { to, version, outcome } }
      : { ok: false, errors: { outcome: t("speakUp.step.outcomeError") } };
  }
  if (to === "closed") {
    const reason = text(form, "reason");
    return reason.length >= 3
      ? { ok: true, body: { to, version, reason } }
      : { ok: false, errors: { reason: t("speakUp.step.reasonError") } };
  }
  return { ok: true, body: { to, version } };
}

/** The next page of the lead's list, as a link (the cursor is opaque, from the API). */
export function nextPageHref(cursor: string | null): string | null {
  return cursor ? `/speak-up/cases?cursor=${encodeURIComponent(cursor)}` : null;
}
