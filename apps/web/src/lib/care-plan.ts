import type { CarePlanSummary, PcspDomain, SignOffCarePlan } from "@harbour/contracts";
import type { Translator } from "@harbour/i18n";
import { formatDate } from "./format";
import { ukToday } from "./uk-time";

/**
 * Care plan helpers (care.md rules 1 and 2, hazard HZ-024). Only the active version is in use; a
 * draft and a superseded version are always labelled in word and icon, and never shown as the
 * plan in use.
 */

/** The 16 need domains of the personalised care and support plan, in the order they are shown. */
export const PCSP_DOMAINS = [
  "mobility",
  "skin",
  "nutrition_and_hydration",
  "continence",
  "communication",
  "cognition",
  "mood",
  "behaviour",
  "sleep",
  "pain",
  "breathing",
  "medicines",
  "personal_care",
  "social_and_spiritual",
  "sexuality_and_relationships",
  "end_of_life",
] as const satisfies readonly PcspDomain[];

export function isPcspDomain(value: unknown): value is PcspDomain {
  return typeof value === "string" && (PCSP_DOMAINS as readonly string[]).includes(value);
}

/** Roles an action can name; the API accepts any role key, these are the built-in ones. */
export const ACTION_ROLES = [
  "care_worker",
  "team_leader",
  "clinical_lead",
  "deputy_manager",
  "registered_manager",
  "activities",
  "catering",
] as const;

export const SIGN_OFF_AUTHORITIES = [
  "lpa_health_welfare",
  "deputy",
  "imca",
  "advocate",
  "next_of_kin",
  "other",
] as const satisfies readonly NonNullable<SignOffCarePlan["authority"]>[];

export interface PlanVersions {
  readonly active: CarePlanSummary | null;
  readonly draft: CarePlanSummary | null;
  /** Newest first. */
  readonly superseded: readonly CarePlanSummary[];
}

/** Sorts the API's list of versions into the one in use, the open draft and the history. */
export function planVersions(items: readonly CarePlanSummary[]): PlanVersions {
  return {
    active: items.find((plan) => plan.status === "active") ?? null,
    draft: items.find((plan) => plan.status === "draft") ?? null,
    superseded: items.filter((plan) => plan.status === "superseded"),
  };
}

export interface PlanStatusChip {
  readonly status: "done" | "info" | "notApplicable";
  /** Lucide icon: a check for the plan in use, a pencil for a draft, a clock turned back for history. */
  readonly icon: "circle-check" | "pencil-line" | "history";
  readonly label: string;
}

/** HZ-024: the status in word and icon; only the active version reads as in use. */
export function planStatusChip(status: CarePlanSummary["status"], t: Translator): PlanStatusChip {
  switch (status) {
    case "active":
      return { status: "done", icon: "circle-check", label: t("care.plan.status", { status }) };
    case "draft":
      return { status: "info", icon: "pencil-line", label: t("care.plan.status", { status }) };
    default:
      return {
        status: "notApplicable",
        icon: "history",
        label: t("care.plan.status", { status: "superseded" }),
      };
  }
}

/** Who agreed the plan, in words, or that no one has yet. */
export function signOffText(plan: CarePlanSummary, name: string, t: Translator): string {
  const signOff = plan.signOff;
  if (!signOff) return t("care.plan.signOff.none");
  // The UK date it was recorded, not the UTC one (they differ just after midnight in summer).
  const date = formatDate(ukToday(new Date(signOff.signedOffAt))) ?? "";
  switch (signOff.agreedBy) {
    case "person":
      return t("care.plan.signOff.person", { name, date });
    case "representative":
      return t("care.plan.signOff.representative", {
        representative: signOff.representativeName ?? t("common.notRecorded"),
        authority: signOff.authority ?? "other",
        date,
      });
    default:
      return t("care.plan.signOff.unable", {
        reason: signOff.unableReason ?? t("common.notRecorded"),
        date,
      });
  }
}

/** The role named on an action, in words; a role key Harbour does not know is shown as recorded. */
export function roleLabel(roleKey: string | null, t: Translator): string | null {
  return roleKey ? t("care.plan.role", { role: roleKey }) : null;
}
