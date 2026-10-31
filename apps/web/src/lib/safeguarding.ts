import type {
  RaiseSafeguardingConcern,
  SafeguardingDetail,
  SafeguardingState,
  UpdateSafeguardingConcern,
} from "@harbour/contracts";
import type { Translator } from "@harbour/i18n";
import type { SafetyChip } from "./incidents";
import { type FormLike, readDateTimeField, type TimeProblem } from "./uk-time";

/**
 * The safeguarding log screens (Phase 2 slice 62; SAFE-006; Care Act 2014 s.42): pure and unit
 * tested. The API (`/v1/safeguarding/concerns`) runs every rule and says what each step still needs
 * (`nextSteps`); these helpers name states and clocks in words and read the forms. Carers see only
 * the protective measures for a person (`/v1/people/{id}/safeguarding/measures`, HZ-126), never the
 * concern.
 */

export const SAFEGUARDING_PERMISSION = "safety.safeguarding.manage";

export function safeguardingShown(permissions: readonly string[]): boolean {
  return permissions.includes(SAFEGUARDING_PERMISSION);
}

export const ABUSE_TYPES = [
  "physical",
  "domestic",
  "sexual",
  "psychological",
  "financial_or_material",
  "modern_slavery",
  "discriminatory",
  "organisational",
  "neglect",
  "self_neglect",
] as const;
export const REFERRAL_METHODS = ["phone", "online_form", "email", "in_person"] as const;
export const ENQUIRY_KINDS = ["s42_local_authority", "s42_caused_to_provider"] as const;
export const FINDINGS = [
  "substantiated",
  "partly_substantiated",
  "not_substantiated",
  "inconclusive",
  "no_s42_enquiry",
] as const;
export const STAFF_HARM = [
  "removed",
  "would_have_removed",
  "not_removed",
  "no_staff_involved",
] as const;
export const ACHIEVED = ["fully", "partly", "not"] as const;
export const DESCRIPTION_MAX = 4_000;
export const MEASURES_MAX = 2_000;

/** The state as an icon and a word; one the web does not know is a warning, never a fact. */
export function safeguardingStateChip(state: string, t: Translator): SafetyChip {
  switch (state) {
    case "concern":
      return { status: "due", icon: "clock", label: t("safeguarding.state", { state }) };
    case "referred":
    case "enquiry":
    case "outcome":
      return { status: "info", icon: "search", label: t("safeguarding.state", { state }) };
    case "no_referral":
    case "closed":
      return { status: "neutral", icon: "circle-check", label: t("safeguarding.state", { state }) };
    default:
      return {
        status: "overdue",
        icon: "triangle-alert",
        label: t("safeguarding.state", { state: "unknown" }),
      };
  }
}

/** The referral clock as an icon and the API's own words (the due time is in them). */
export function safeguardingClockChip(
  clock: Pick<SafeguardingDetail["clock"], "status" | "wording">,
  t: Translator,
): SafetyChip {
  switch (clock.status) {
    case "overdue":
      return { status: "overdue", icon: "circle-alert", label: clock.wording };
    case "due":
      return { status: "due", icon: "clock", label: clock.wording };
    case "referred":
      return { status: "neutral", icon: "send", label: clock.wording };
    case "not_referred":
      return { status: "neutral", icon: "circle-minus", label: clock.wording };
    default:
      return {
        status: "overdue",
        icon: "triangle-alert",
        label: t("safeguarding.state", { state: "unknown" }),
      };
  }
}

type FormWithAll = FormLike & { getAll?: (name: string) => unknown[] };

type Read<T> =
  | { readonly ok: true; readonly body: T }
  | {
      readonly ok: false;
      readonly errors: Readonly<Record<string, string>>;
      readonly parts?: Readonly<Record<string, readonly string[]>>;
    };

const text = (form: FormLike, name: string) => {
  const value = form.get(name);
  return typeof value === "string" ? value.trim() : "";
};
const oneOf = <T extends string>(list: readonly T[], value: string): T | null =>
  (list as readonly string[]).includes(value) ? (value as T) : null;
const all = <T extends string>(form: FormWithAll, name: string, list: readonly T[]): T[] => [
  ...new Set(
    (form.getAll?.(name) ?? []).filter(
      (v): v is T => typeof v === "string" && (list as readonly string[]).includes(v),
    ),
  ),
];

function failed<T>(
  errors: Record<string, string>,
  parts: Record<string, readonly string[]> = {},
): Read<T> {
  return { ok: false, errors, ...(Object.keys(parts).length > 0 ? { parts } : {}) };
}

/** Raising a concern about a person: what kind of abuse, what happened, what keeps them safe now. */
export function readRaiseConcern(
  form: FormWithAll,
  t: Translator,
  options: { readonly id: string; readonly personId: string },
): Read<RaiseSafeguardingConcern> {
  const errors: Record<string, string> = {};
  const abuseTypes = all(form, "abuseTypes", ABUSE_TYPES);
  if (abuseTypes.length === 0) errors.abuseTypes = t("safeguarding.form.abuseTypesError");
  const description = text(form, "description");
  if (description.length < 3 || description.length > DESCRIPTION_MAX) {
    errors.description = t("safeguarding.form.descriptionError", { max: DESCRIPTION_MAX });
  }
  const measures = text(form, "protectiveMeasures");
  if (measures && (measures.length < 3 || measures.length > MEASURES_MAX)) {
    errors.protectiveMeasures = t("safeguarding.form.measuresError", { max: MEASURES_MAX });
  }
  if (Object.keys(errors).length > 0) return failed(errors);
  return {
    ok: true,
    body: {
      id: options.id,
      personId: options.personId,
      abuseTypes,
      description,
      ...(measures ? { protectiveMeasures: measures } : {}),
    },
  };
}

/**
 * The record's update form: each section is sent only when something in it was filled in, so an
 * untouched section never clears what is recorded.
 */
export function readSafeguardingUpdate(
  form: FormLike,
  t: Translator,
  options: { readonly version: number; readonly now?: Date },
): Read<UpdateSafeguardingConcern> {
  const errors: Record<string, string> = {};
  const parts: Record<string, readonly string[]> = {};
  const body: { -readonly [K in keyof UpdateSafeguardingConcern]: UpdateSafeguardingConcern[K] } = {
    version: options.version,
  };
  const when = (name: string, subject: string) => {
    const read = readDateTimeField(form, name, {
      subject,
      t,
      ...(options.now ? { now: options.now } : {}),
    });
    if (read.ok) return read.instant;
    errors[name] = (read as TimeProblem).message;
    parts[name] = (read as TimeProblem).parts;
    return null;
  };

  const localAuthority = text(form, "localAuthority");
  const method = text(form, "referralMethod");
  if (localAuthority || method) {
    const chosen = oneOf(REFERRAL_METHODS, method);
    if (localAuthority.length < 2) errors.localAuthority = t("safeguarding.update.authorityError");
    if (!chosen) errors.referralMethod = t("safeguarding.update.methodError");
    const referredAt = when("referredAt", t("safeguarding.update.referredSubject"));
    if (chosen && referredAt && localAuthority.length >= 2) {
      const reference = text(form, "referralReference");
      body.referral = { localAuthority, method: chosen, referredAt, reference: reference || null };
    }
  }
  const enquiryKind = text(form, "enquiryKind");
  if (enquiryKind) {
    const kind = oneOf(ENQUIRY_KINDS, enquiryKind);
    const openedAt = when("enquiryOpenedAt", t("safeguarding.update.enquirySubject"));
    if (!kind) errors.enquiryKind = t("safeguarding.update.enquiryError");
    if (kind && openedAt) body.enquiry = { kind, openedAt };
  }
  const finding = oneOf(FINDINGS, text(form, "finding"));
  if (finding) body.finding = finding;
  const staffHarm = oneOf(STAFF_HARM, text(form, "staffHarm"));
  if (staffHarm) body.staffHarm = staffHarm;
  const asked = text(form, "outcomesAsked");
  if (asked === "yes" || asked === "no") {
    const desired = text(form, "desiredOutcomes");
    const notAskedReason = text(form, "notAskedReason");
    if (asked === "no" && notAskedReason.length < 3) {
      errors.notAskedReason = t("safeguarding.update.notAskedError");
    }
    body.personalOutcomes = {
      asked: asked === "yes",
      notAskedReason: asked === "no" ? notAskedReason || null : null,
      desiredOutcomes: asked === "yes" ? desired || null : null,
      achieved: oneOf(ACHIEVED, text(form, "achieved")),
    };
  }
  const dbs = text(form, "dbsDecision");
  if (dbs === "referred" || dbs === "not_required") {
    const reason = text(form, "dbsReason");
    if (dbs === "not_required" && reason.length < 3) {
      errors.dbsReason = t("safeguarding.update.dbsReasonError");
    }
    body.dbsReferral = { decision: dbs, reason: reason || null, at: new Date().toISOString() };
  }
  const measures = form.get("protectiveMeasures");
  if (typeof measures === "string" && text(form, "measuresChanged") === "yes") {
    const value = measures.trim();
    if (value.length > MEASURES_MAX) {
      errors.protectiveMeasures = t("safeguarding.form.measuresError", { max: MEASURES_MAX });
    }
    body.protectiveMeasures = value || null;
  }
  if (Object.keys(errors).length > 0) return failed(errors, parts);
  if (Object.keys(body).length === 1) {
    return failed({ form: t("safeguarding.update.nothing") });
  }
  return { ok: true, body };
}

/** A step: a reason where the step needs one (no referral, closing). */
export function readSafeguardingStep(
  form: FormLike,
  t: Translator,
  options: { readonly to: SafeguardingState; readonly version: number },
): Read<{ to: SafeguardingState; version: number; reason?: string }> {
  const reason = text(form, "reason");
  if ((options.to === "no_referral" || options.to === "closed") && reason.length < 3) {
    return failed({ reason: t("safeguarding.step.reasonError") });
  }
  return {
    ok: true,
    body: { to: options.to, version: options.version, ...(reason ? { reason } : {}) },
  };
}
