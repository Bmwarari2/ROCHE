import type { Translator } from "@harbour/i18n";
import { formatDateTime } from "./format";
import type { SafetyChip } from "./incidents";
import { type FormLike, readDateField, readDateTimeField, type TimeProblem } from "./uk-time";

/**
 * The disclosure request screens (Phase 2 slice 63; SAFE-016; safety.md section 12): pure and
 * unit tested. The API (`/v1/disclosures`) checks every rule again: the legal basis per type, the
 * approver who is not the person who prepared it, the step-up to release. These helpers name
 * states and types in words and read the forms.
 */

export const DISCLOSURE_MANAGE = "safety.incident.manage";
export const DISCLOSURE_APPROVE = "safety.disclosure.approve";

export const DISCLOSURE_TYPES = [
  "coroner",
  "safeguarding_adults_review",
  "domestic_homicide_review",
  "police",
  "solicitor",
  "access_to_health_records",
] as const;
export type DisclosureTypeName = (typeof DISCLOSURE_TYPES)[number];
export const ITEM_DECISIONS = ["disclose", "redact", "withhold"] as const;
export type ItemDecision = (typeof ITEM_DECISIONS)[number];
export const DISCLOSURE_TEXT_MAX = 2_000;

/** Shown to holders of either permission (the API's own check on the log). */
export function disclosuresShown(permissions: readonly string[]): boolean {
  return permissions.includes(DISCLOSURE_MANAGE) || permissions.includes(DISCLOSURE_APPROVE);
}

export function canManageDisclosures(permissions: readonly string[]): boolean {
  return permissions.includes(DISCLOSURE_MANAGE);
}

export function canApproveDisclosures(permissions: readonly string[]): boolean {
  return permissions.includes(DISCLOSURE_APPROVE);
}

/** The state as an icon and a word; one the web does not know is a warning, never a fact. */
export function disclosureStateChip(state: string, t: Translator): SafetyChip {
  switch (state) {
    case "requested":
      return { status: "due", icon: "clock", label: t("disclosures.state", { state }) };
    case "prepared":
      return { status: "info", icon: "file-pen", label: t("disclosures.state", { state }) };
    case "approved":
      return { status: "info", icon: "circle-check", label: t("disclosures.state", { state }) };
    case "released":
      return { status: "neutral", icon: "send", label: t("disclosures.state", { state }) };
    case "refused":
    case "withdrawn":
      return { status: "neutral", icon: "circle-minus", label: t("disclosures.state", { state }) };
    default:
      return {
        status: "overdue",
        icon: "triangle-alert",
        label: t("disclosures.state", { state: "unknown" }),
      };
  }
}

/** The answer's due time in words: overdue while still open past it, or due by it. */
export function disclosureDueChip(
  request: { readonly dueAt: string | null; readonly state: string },
  t: Translator,
  now: Date = new Date(),
): SafetyChip | null {
  if (!request.dueAt) return null;
  const when = formatDateTime(request.dueAt) ?? "";
  const open =
    request.state === "requested" || request.state === "prepared" || request.state === "approved";
  if (!open) return null;
  return Date.parse(request.dueAt) < now.getTime()
    ? {
        status: "overdue",
        icon: "circle-alert",
        label: t("disclosures.due", { state: "overdue", when }),
      }
    : { status: "due", icon: "clock", label: t("disclosures.due", { state: "due", when }) };
}

/** A collected record's decision as an icon and a word. */
export function itemDecisionChip(decision: string, t: Translator): SafetyChip {
  switch (decision) {
    case "pending":
      return { status: "due", icon: "clock", label: t("disclosures.item.decision", { decision }) };
    case "disclose":
      return {
        status: "neutral",
        icon: "circle-check",
        label: t("disclosures.item.decision", { decision }),
      };
    case "redact":
      return {
        status: "info",
        icon: "file-pen",
        label: t("disclosures.item.decision", { decision }),
      };
    case "withhold":
      return {
        status: "neutral",
        icon: "circle-minus",
        label: t("disclosures.item.decision", { decision }),
      };
    default:
      return {
        status: "overdue",
        icon: "triangle-alert",
        label: t("disclosures.item.decision", { decision: "unknown" }),
      };
  }
}

/** The Regulation 28 response as an icon and words. */
export function preventionChip(
  prevention: { readonly state: string; readonly responseDueOn: string },
  t: Translator,
  formatDate: (iso: string) => string | null,
): SafetyChip {
  const date = formatDate(prevention.responseDueOn) ?? "";
  switch (prevention.state) {
    case "responded":
      return {
        status: "neutral",
        icon: "circle-check",
        label: t("disclosures.prevention.state", { state: "responded", date }),
      };
    case "overdue":
      return {
        status: "overdue",
        icon: "circle-alert",
        label: t("disclosures.prevention.state", { state: "overdue", date }),
      };
    case "due":
      return {
        status: "due",
        icon: "clock",
        label: t("disclosures.prevention.state", { state: "due", date }),
      };
    default:
      return {
        status: "overdue",
        icon: "triangle-alert",
        label: t("disclosures.state", { state: "unknown" }),
      };
  }
}

type Read<T> =
  | { readonly ok: true; readonly body: T }
  | {
      readonly ok: false;
      readonly errors: Readonly<Record<string, string>>;
      readonly parts?: Readonly<Record<string, readonly string[]>>;
    };

type FormWithAll = FormLike & { getAll?: (name: string) => unknown[] };

const text = (form: FormLike, name: string) => {
  const value = form.get(name);
  return typeof value === "string" ? value.trim() : "";
};
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function failed<T>(
  errors: Record<string, string>,
  parts: Record<string, readonly string[]> = {},
): Read<T> {
  return { ok: false, errors, ...(Object.keys(parts).length > 0 ? { parts } : {}) };
}

export interface LogRequestBody {
  readonly personId: string;
  readonly type: DisclosureTypeName;
  readonly requester: {
    readonly name: string;
    readonly organisation: string;
    readonly reference?: string | null;
  };
  readonly statedPurpose?: string | null;
  readonly receivedAt: string;
}

/** Logging a request as it arrived: about whom, what kind, who asked and when. */
export function readLogRequest(
  form: FormLike,
  t: Translator,
  options: { readonly now?: Date } = {},
): Read<LogRequestBody> {
  const errors: Record<string, string> = {};
  const parts: Record<string, readonly string[]> = {};
  const personId = text(form, "personId");
  if (!UUID.test(personId)) errors.personId = t("disclosures.form.personError");
  const typeValue = text(form, "type");
  const type = (DISCLOSURE_TYPES as readonly string[]).includes(typeValue)
    ? (typeValue as DisclosureTypeName)
    : null;
  if (!type) errors.type = t("disclosures.form.typeError");
  const name = text(form, "requesterName");
  if (name.length < 1 || name.length > 200) errors.requesterName = t("disclosures.form.nameError");
  const organisation = text(form, "requesterOrganisation");
  if (organisation.length < 1 || organisation.length > 200) {
    errors.requesterOrganisation = t("disclosures.form.organisationError");
  }
  const reference = text(form, "requesterReference");
  if (reference.length > 100) errors.requesterReference = t("disclosures.form.referenceError");
  const statedPurpose = text(form, "statedPurpose");
  if (statedPurpose && (statedPurpose.length < 3 || statedPurpose.length > DISCLOSURE_TEXT_MAX)) {
    errors.statedPurpose = t("disclosures.form.purposeError", { max: DISCLOSURE_TEXT_MAX });
  }
  const received = readDateTimeField(form, "receivedAt", {
    subject: t("disclosures.form.receivedSubject"),
    t,
    ...(options.now ? { now: options.now } : {}),
    futureToleranceMinutes: 0,
  });
  if (!received.ok) {
    errors.receivedAt = (received as TimeProblem).message;
    parts.receivedAt = (received as TimeProblem).parts;
  }
  if (Object.keys(errors).length > 0 || !type || !received.ok || !received.instant) {
    return failed(errors, parts);
  }
  return {
    ok: true,
    body: {
      personId,
      type,
      requester: { name, organisation, ...(reference ? { reference } : {}) },
      ...(statedPurpose ? { statedPurpose } : {}),
      receivedAt: received.instant,
    },
  };
}

export interface ItemDecisionBody {
  readonly decision: ItemDecision;
  readonly redactedFields: string[];
  readonly reason: string | null;
  readonly contentSha256: string;
  readonly expectedVersion: number;
}

/**
 * A decision on one collected record. Redacting needs at least one field; withholding needs a
 * reason. The record's hash and version come from the page, so a record changed since it was
 * opened is refused by the API rather than decided blind.
 */
export function readItemDecision(
  form: FormWithAll,
  t: Translator,
  options: { readonly contentSha256: string; readonly expectedVersion: number },
): Read<ItemDecisionBody> {
  const errors: Record<string, string> = {};
  const value = text(form, "decision");
  const decision = (ITEM_DECISIONS as readonly string[]).includes(value)
    ? (value as ItemDecision)
    : null;
  if (!decision) errors.decision = t("disclosures.item.decisionError");
  const redactedFields = [
    ...new Set(
      (form.getAll?.("redactedFields") ?? []).filter(
        (v): v is string => typeof v === "string" && v.length > 0 && v.length <= 100,
      ),
    ),
  ];
  if (decision === "redact" && redactedFields.length === 0) {
    errors.redactedFields = t("disclosures.item.redactError");
  }
  const reason = text(form, "reason");
  if (decision === "withhold" && reason.length < 3) {
    errors.reason = t("disclosures.item.reasonError");
  }
  if (reason.length > DISCLOSURE_TEXT_MAX) {
    errors.reason = t("disclosures.form.purposeError", { max: DISCLOSURE_TEXT_MAX });
  }
  if (Object.keys(errors).length > 0 || !decision) return failed(errors);
  return {
    ok: true,
    body: {
      decision,
      redactedFields: decision === "redact" ? redactedFields : [],
      reason: reason || null,
      contentSha256: options.contentSha256,
      expectedVersion: options.expectedVersion,
    },
  };
}

/** The approver's decision: refusing needs a reason in words. */
export function readDecide(
  form: FormLike,
  t: Translator,
  options: { readonly expectedVersion: number },
): Read<{ decision: "approve" | "refuse"; reason?: string; expectedVersion: number }> {
  const decision = text(form, "decision");
  const reason = text(form, "reason");
  if (decision !== "approve" && decision !== "refuse") {
    return failed({ decision: t("disclosures.decide.decisionError") });
  }
  if (decision === "refuse" && reason.length < 3) {
    return failed({ reason: t("disclosures.decide.reasonError") });
  }
  return {
    ok: true,
    body: {
      decision,
      expectedVersion: options.expectedVersion,
      ...(reason ? { reason } : {}),
    },
  };
}

export function readWithdraw(
  form: FormLike,
  t: Translator,
  options: { readonly expectedVersion: number },
): Read<{ reason: string; expectedVersion: number }> {
  const reason = text(form, "reason");
  return reason.length >= 3 && reason.length <= DISCLOSURE_TEXT_MAX
    ? { ok: true, body: { reason, expectedVersion: options.expectedVersion } }
    : failed({ reason: t("disclosures.withdraw.reasonError") });
}

/** The coroner's Regulation 28 report: when it came, and when the response went (if it has). */
export function readPreventionReport(
  form: FormLike,
  t: Translator,
  options: { readonly expectedVersion: number },
): Read<{ reportOn: string; respondedOn?: string | null; expectedVersion: number }> {
  const errors: Record<string, string> = {};
  const parts: Record<string, readonly string[]> = {};
  const report = readDateField(form, "reportOn", {
    subject: t("disclosures.prevention.reportSubject"),
    t,
  });
  if (!report.ok) {
    errors.reportOn = (report as TimeProblem).message;
    parts.reportOn = (report as TimeProblem).parts;
  }
  const responded = readDateField(form, "respondedOn", {
    subject: t("disclosures.prevention.respondedSubject"),
    t,
    optional: true,
  });
  if (!responded.ok) {
    errors.respondedOn = (responded as TimeProblem).message;
    parts.respondedOn = (responded as TimeProblem).parts;
  }
  const reportOn = report.ok ? report.date : null;
  const respondedOn = responded.ok ? responded.date : null;
  if (reportOn && respondedOn && respondedOn < reportOn) {
    errors.respondedOn = t("disclosures.prevention.beforeReport");
  }
  if (Object.keys(errors).length > 0 || !reportOn) return failed(errors, parts);
  return {
    ok: true,
    body: { reportOn, respondedOn, expectedVersion: options.expectedVersion },
  };
}

/** Which next steps the request's state allows, in order (the API checks permissions again). */
export function disclosureSteps(request: {
  readonly state: string;
  readonly collectedAt: string | null;
  readonly items: { readonly total: number; readonly pending: number };
}): ("collect" | "prepare" | "decide" | "release" | "withdraw")[] {
  switch (request.state) {
    case "requested": {
      const steps: ("collect" | "prepare" | "withdraw")[] = ["collect"];
      if (request.collectedAt && request.items.total > 0 && request.items.pending === 0) {
        steps.push("prepare");
      }
      steps.push("withdraw");
      return steps;
    }
    case "prepared":
      return ["decide", "withdraw"];
    case "approved":
      return ["release", "withdraw"];
    default:
      return [];
  }
}
