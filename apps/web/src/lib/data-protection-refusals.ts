import type { Translator } from "@harbour/i18n";
import { type Problem, problemMessage } from "./outcome";

/**
 * The breach register's and data protection complaints' refusals in plain words (PLAT-022;
 * the codes `apps/api/src/routes/data-protection.ts` returns), each tied to the form field it is
 * about, so the field shows it and the summary links to it. Anything else is said as
 * `problemMessage` says it (a step-up, a stale version, a missing permission).
 */

/** Refusal code to the form field it is about, when there is one. */
const FIELD_OF: Readonly<Record<string, string>> = {
  reasoning_required: "reasoning",
  acknowledgement_required: "acknowledgedSuggestion",
  delay_reason_required: "delayReason",
  report_before_awareness: "reportedAt",
  notice_unfinished: "notice",
  outcome_required: "outcome",
  ico_right_required: "icoRightStated",
  aware_at_fixed: "awareAt",
  aware_at_after_notice: "awareAt",
};

/** The codes said in the catalogue's words (`dataRights.dpRefusal`). */
export const DATA_PROTECTION_REFUSALS = [
  "breach_closed",
  "complaint_closed",
  "time_in_future",
  "date_in_future",
  "date_out_of_range",
  "aware_at_fixed",
  "aware_at_after_notice",
  "already_decided",
  "not_assessed",
  "reasoning_required",
  "decider_required",
  "acknowledgement_required",
  "already_reported",
  "already_told",
  "not_decided_to_report",
  "report_before_awareness",
  "delay_reason_required",
  "notice_unfinished",
  "not_decided_to_tell",
  "not_decided",
  "not_reported",
  "not_told",
  "already_acknowledged",
  "not_acknowledged",
  "outcome_required",
  "ico_right_required",
  "location_not_found",
  "breach_not_found",
  "person_not_found",
  "not_allowed",
] as const;

const KNOWN: ReadonlySet<string> = new Set(DATA_PROTECTION_REFUSALS);

/** A database guard on the two tables (`dp_breach_…`, `dp_complaint_…`): said as not allowed. */
const GUARD = /^(dp_breach|dp_complaint)_[a-z_]+$/;

export function dataProtectionProblem(error: unknown, t: Translator): Problem {
  const raw =
    typeof error === "object" && error !== null ? (error as { code?: unknown }).code : undefined;
  const given = typeof raw === "string" ? raw : "";
  const code = GUARD.test(given) ? "not_allowed" : given;
  if (!KNOWN.has(code)) return problemMessage(error, t);
  const message = t("dataRights.dpRefusal", { code });
  const field = FIELD_OF[code];
  return { code, message, ...(field ? { fields: { [field]: message } } : {}) };
}
