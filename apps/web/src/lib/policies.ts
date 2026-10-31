import type { PolicyItem } from "@harbour/contracts";
import type { Translator } from "@harbour/i18n";
import type { QualityChip } from "./evidence-packs";
import type { FormValues } from "./incident-forms";
import type { FieldErrors } from "./outcome";
import { readDateField } from "./uk-time";

/**
 * The policy library and read-and-sign screens (quality.md section 22; QUAL-008; HZ-128). Pure
 * helpers: statuses as an icon and a word, and reading the forms into the API's bodies. Every
 * member reads the library and signs the version in force; `quality.policy.manage` drafts,
 * publishes, retires and sees who has signed. The API checks every rule again.
 */

export const POLICY_MANAGE = "quality.policy.manage";
export const policiesManaged = (permissions: readonly string[]) =>
  permissions.includes(POLICY_MANAGE);

type VersionState = PolicyItem["versions"][number]["state"];
type ReviewStatus = NonNullable<PolicyItem["versions"][number]["reviewStatus"]>;

/** The staff roles a policy can ask to read and sign (built-in keys; tenants' own roles extend them). */
export const POLICY_ROLES = [
  "owner",
  "group_executive",
  "registered_manager",
  "deputy_manager",
  "clinical_lead",
  "team_leader",
  "care_worker",
  "care_coordinator",
  "activities",
  "catering",
  "housekeeping",
  "maintenance",
  "administrator",
  "finance",
  "hr",
  "quality_lead",
  "agency_worker",
] as const;

export function versionStateChip(state: VersionState, t: Translator): QualityChip {
  const look: Record<VersionState, Pick<QualityChip, "status" | "icon">> = {
    draft: { status: "info", icon: "file-pen" },
    published: { status: "done", icon: "circle-check" },
    superseded: { status: "neutral", icon: "circle-minus" },
    retired: { status: "neutral", icon: "circle-minus" },
  };
  return { ...look[state], label: t("quality.policies.state", { state }) };
}

export function reviewChip(status: ReviewStatus, t: Translator): QualityChip {
  const look: Record<ReviewStatus, Pick<QualityChip, "status" | "icon">> = {
    current: { status: "done", icon: "circle-check" },
    due_soon: { status: "due", icon: "clock" },
    overdue: { status: "overdue", icon: "circle-alert" },
    no_review_date: { status: "neutral", icon: "circle-minus" },
  };
  return { ...look[status], label: t("quality.policies.review", { status }) };
}

/** Whether the reader still has to read and sign the version in force; null when not asked. */
export function signChip(
  policy: { readonly mustSign: boolean; readonly signed: boolean },
  t: Translator,
): QualityChip | null {
  if (policy.signed)
    return { status: "done", icon: "circle-check", label: t("quality.policies.signed") };
  if (policy.mustSign)
    return { status: "due", icon: "pen-line", label: t("quality.policies.toSign") };
  return null;
}

/** The version in force for a superseded one (HZ-128): never left to be read as current. */
export function inForceFor(
  policy: Pick<PolicyItem, "versions">,
  version: PolicyItem["versions"][number],
): PolicyItem["versions"][number] | null {
  if (version.state !== "superseded" || !version.supersededBy) return null;
  return policy.versions.find((v) => v.id === version.supersededBy) ?? null;
}

export const SUMMARY_MAX = 2000;
export const BODY_MAX = 100_000;
export const TITLE_MAX = 160;

export interface DraftBody {
  readonly change: "minor" | "major";
  readonly changeSummary: string;
  readonly body: string | null;
  readonly documentId: string | null;
  readonly roles: string[];
  readonly reviewDueOn: string | null;
}

/**
 * A draft's fields: the kind of change, its summary, the text or an organisation document, the
 * roles who must read and sign, and the review date (dd/mm/yyyy, optional while drafting).
 */
export function readDraft(
  form: FormValues,
  documents: readonly string[],
  t: Translator,
  options: { readonly askChange: boolean } = { askChange: true },
):
  | { readonly ok: true; readonly draft: DraftBody }
  | {
      readonly ok: false;
      readonly errors: FieldErrors;
      readonly parts: Readonly<Record<string, readonly string[]>>;
    } {
  const errors: Record<string, string> = {};
  const parts: Record<string, readonly string[]> = {};
  const change = String(form.get("change") ?? (options.askChange ? "" : "major"));
  if (change !== "minor" && change !== "major")
    errors.change = t("quality.policies.form.changeMissing");
  const changeSummary = String(form.get("changeSummary") ?? "").trim();
  if (changeSummary.length < 2) errors.changeSummary = t("quality.policies.form.summaryMissing");
  else if (changeSummary.length > SUMMARY_MAX) {
    errors.changeSummary = t("quality.policies.form.tooLong", { max: SUMMARY_MAX });
  }
  const bodyText = String(form.get("body") ?? "").trim();
  if (bodyText.length > BODY_MAX)
    errors.body = t("quality.policies.form.tooLong", { max: BODY_MAX });
  const documentId = String(form.get("documentId") ?? "");
  if (documentId && !documents.includes(documentId))
    errors.documentId = t("quality.policies.form.documentMissing");
  if (!bodyText && !documentId) errors.body = t("quality.policies.form.contentMissing");
  const roles = form
    .getAll("roles")
    .map(String)
    .filter((r) => (POLICY_ROLES as readonly string[]).includes(r));
  const due = readDateField(form, "reviewDueOn", {
    subject: t("quality.policies.form.reviewSubject"),
    optional: true,
    t,
  });
  if (!due.ok) {
    errors.reviewDueOn = due.message;
    parts.reviewDueOn = due.parts;
  }
  if (Object.keys(errors).length > 0 || !due.ok) return { ok: false, errors, parts };
  return {
    ok: true,
    draft: {
      change: change as "minor" | "major",
      changeSummary,
      body: bodyText || null,
      documentId: documentId || null,
      roles,
      reviewDueOn: due.date,
    },
  };
}

/** A new policy's own fields: its short name and title, and whether a second person publishes. */
export function readNewPolicy(
  form: FormValues,
  t: Translator,
):
  | {
      readonly ok: true;
      readonly policyKey: string;
      readonly title: string;
      readonly requireSecondReviewer: boolean;
    }
  | { readonly ok: false; readonly errors: FieldErrors } {
  const errors: Record<string, string> = {};
  const policyKey = String(form.get("policyKey") ?? "").trim();
  const title = String(form.get("title") ?? "").trim();
  if (!/^[a-z][a-z0-9_]{1,63}$/.test(policyKey))
    errors.policyKey = t("quality.policies.form.keyInvalid");
  if (title.length < 2) errors.title = t("quality.policies.form.titleMissing");
  else if (title.length > TITLE_MAX)
    errors.title = t("quality.policies.form.tooLong", { max: TITLE_MAX });
  if (Object.keys(errors).length > 0) return { ok: false, errors };
  return {
    ok: true,
    policyKey,
    title,
    requireSecondReviewer: form.get("secondReviewer") === "yes",
  };
}
