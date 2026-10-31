import type {
  ComplaintItem,
  ComplaintState,
  CreateComplaint,
  CreateCompliment,
} from "@harbour/contracts";
import { COMPLAINT_WORKFLOW } from "@harbour/domain";
import type { Translator } from "@harbour/i18n";
import { formatDate } from "./format";
import type { SafetyChip } from "./incidents";
import { type FormLike, readDateField, readDateTimeField, type TimeProblem } from "./uk-time";

/**
 * The complaints and compliments screens (Phase 2 slice 62; SAFE-011; Regulation 16): pure and
 * unit tested. The API (`/v1/complaints`, `/v1/compliments`) checks every rule again, including
 * the response that must signpost the Ombudsman and keep a copy; these helpers name states, read
 * forms and say what each step needs, in words.
 */

export const COMPLAINT_PERMISSION = "safety.complaint.manage";

/** Shown to holders of safety.complaint.manage (the API's own check, where each record is). */
export function complaintsShown(permissions: readonly string[]): boolean {
  return permissions.includes(COMPLAINT_PERMISSION);
}

export const COMPLAINT_RELATIONSHIPS = [
  "person_using_service",
  "family_or_friend",
  "representative",
  "professional",
  "member_of_public",
  "other",
] as const;
export const COMPLAINT_CHANNELS = ["in_person", "phone", "email", "letter", "other"] as const;
export const COMPLAINT_OUTCOMES = ["upheld", "partly_upheld", "not_upheld"] as const;
export const COMPLAINT_SUMMARY_MAX = 10_000;
export const COMPLAINT_TEXT_MAX = 2_000;

const WAITING: ReadonlySet<string> = new Set(["received", "acknowledged", "appealed"]);
const UNDER_WAY: ReadonlySet<string> = new Set(["investigating", "responded", "appeal_responded"]);

/** The state as an icon and a word; one the web does not know is a warning, never a fact. */
export function complaintStateChip(state: string, t: Translator): SafetyChip {
  if (state === "closed") {
    return { status: "neutral", icon: "circle-check", label: t("complaints.state", { state }) };
  }
  if (WAITING.has(state)) {
    return { status: "due", icon: "clock", label: t("complaints.state", { state }) };
  }
  if (UNDER_WAY.has(state)) {
    return { status: "info", icon: "search", label: t("complaints.state", { state }) };
  }
  return {
    status: "overdue",
    icon: "triangle-alert",
    label: t("complaints.state", { state: "unknown" }),
  };
}

/** "Acknowledge by 03/11/2026. Respond by 28/11/2026." while those targets are still ahead. */
export function complaintTargets(item: Pick<ComplaintItem, "state" | "clocks">, t: Translator) {
  const lines: string[] = [];
  if (item.state === "received") {
    lines.push(t("complaints.acknowledgeBy", { date: formatDate(item.clocks.acknowledgeBy) }));
  }
  if (["received", "acknowledged", "investigating"].includes(item.state)) {
    lines.push(t("complaints.respondBy", { date: formatDate(item.clocks.respondBy) }));
  }
  return lines;
}

/** The steps the workflow allows from the state (the API checks the reader's permission again). */
export function complaintMoves(state: string): Exclude<ComplaintState, "received">[] {
  return COMPLAINT_WORKFLOW.transitions
    .filter((rule) => (Array.isArray(rule.from) ? rule.from : [rule.from]).includes(state))
    .map((rule) => rule.to as Exclude<ComplaintState, "received">);
}

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

function failed<T>(
  errors: Record<string, string>,
  parts: Record<string, readonly string[]>,
): Read<T> {
  return { ok: false, errors, ...(Object.keys(parts).length > 0 ? { parts } : {}) };
}

/** The new complaint form; the location comes from the page, never the form alone. */
export function readComplaint(
  form: FormLike,
  t: Translator,
  options: { readonly id: string; readonly locationId: string; readonly now?: Date },
): Read<CreateComplaint> {
  const errors: Record<string, string> = {};
  const parts: Record<string, readonly string[]> = {};
  const complainantName = text(form, "complainantName");
  if (complainantName.length < 1 || complainantName.length > 200) {
    errors.complainantName = t("complaints.form.nameError");
  }
  const relationship = oneOf(COMPLAINT_RELATIONSHIPS, text(form, "complainantRelationship"));
  if (!relationship) errors.complainantRelationship = t("complaints.form.relationshipError");
  const channel = oneOf(COMPLAINT_CHANNELS, text(form, "channel"));
  if (!channel) errors.channel = t("complaints.form.channelError");
  const contact = text(form, "complainantContact");
  if (contact.length > 500) errors.complainantContact = t("complaints.form.contactError");
  const summary = text(form, "summary");
  if (summary.length < 3 || summary.length > COMPLAINT_SUMMARY_MAX) {
    errors.summary = t("complaints.form.summaryError", { max: COMPLAINT_SUMMARY_MAX });
  }
  const received = readDateTimeField(form, "receivedAt", {
    subject: t("complaints.form.receivedSubject"),
    t,
    ...(options.now ? { now: options.now } : {}),
    futureToleranceMinutes: 0,
  });
  if (!received.ok) {
    errors.receivedAt = (received as TimeProblem).message;
    parts.receivedAt = (received as TimeProblem).parts;
  }
  const knew = readDateField(form, "knewOfMatterOn", {
    subject: t("complaints.form.knewSubject"),
    t,
  });
  if (!knew.ok) {
    errors.knewOfMatterOn = (knew as TimeProblem).message;
    parts.knewOfMatterOn = (knew as TimeProblem).parts;
  }
  const receivedAt = received.ok ? received.instant : null;
  const knewOfMatterOn = knew.ok ? knew.date : null;
  if (receivedAt && knewOfMatterOn && knewOfMatterOn > receivedAt.slice(0, 10)) {
    errors.knewOfMatterOn = t("complaints.form.knewAfterReceived");
  }
  if (
    Object.keys(errors).length > 0 ||
    !relationship ||
    !channel ||
    !receivedAt ||
    !knewOfMatterOn
  ) {
    return failed(errors, parts);
  }
  return {
    ok: true,
    body: {
      id: options.id,
      locationId: options.locationId,
      complainantName,
      complainantRelationship: relationship,
      ...(contact ? { complainantContact: contact } : {}),
      channel,
      receivedAt,
      knewOfMatterOn,
      summary,
    },
  };
}

export interface ComplaintStepBody {
  readonly to: Exclude<ComplaintState, "received">;
  readonly version: number;
  readonly reason?: string;
  readonly response?: {
    readonly outcome: (typeof COMPLAINT_OUTCOMES)[number];
    readonly actionsTaken: string;
    readonly ombudsmanSignposted: boolean;
    readonly documentId: string;
  };
  readonly appeal?: { readonly receivedAt: string; readonly reason: string };
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** A step's form: a response, an appeal, or a reason to close, as the step needs. */
export function readComplaintStep(
  form: FormLike,
  t: Translator,
  options: {
    readonly to: Exclude<ComplaintState, "received">;
    readonly version: number;
    readonly now?: Date;
  },
): Read<ComplaintStepBody> {
  const { to, version } = options;
  const errors: Record<string, string> = {};
  const parts: Record<string, readonly string[]> = {};
  if (to === "responded" || to === "appeal_responded") {
    const outcome = oneOf(COMPLAINT_OUTCOMES, text(form, "outcome"));
    if (!outcome) errors.outcome = t("complaints.step.outcomeError");
    const actionsTaken = text(form, "actionsTaken");
    if (actionsTaken.length < 3 || actionsTaken.length > COMPLAINT_TEXT_MAX) {
      errors.actionsTaken = t("complaints.step.actionsError", { max: COMPLAINT_TEXT_MAX });
    }
    const ombudsmanSignposted = text(form, "ombudsmanSignposted") === "yes";
    if (!ombudsmanSignposted) errors.ombudsmanSignposted = t("complaints.step.ombudsmanError");
    const documentId = text(form, "documentId");
    if (!UUID.test(documentId)) errors.documentId = t("complaints.step.documentError");
    if (Object.keys(errors).length > 0 || !outcome) return failed(errors, parts);
    return {
      ok: true,
      body: { to, version, response: { outcome, actionsTaken, ombudsmanSignposted, documentId } },
    };
  }
  if (to === "appealed") {
    const reason = text(form, "appealReason");
    if (reason.length < 3 || reason.length > COMPLAINT_TEXT_MAX) {
      errors.appealReason = t("complaints.step.appealReasonError", { max: COMPLAINT_TEXT_MAX });
    }
    const received = readDateTimeField(form, "appealReceivedAt", {
      subject: t("complaints.step.appealReceivedSubject"),
      t,
      ...(options.now ? { now: options.now } : {}),
      futureToleranceMinutes: 0,
    });
    if (!received.ok) {
      errors.appealReceivedAt = (received as TimeProblem).message;
      parts.appealReceivedAt = (received as TimeProblem).parts;
    }
    if (Object.keys(errors).length > 0 || !received.ok || !received.instant) {
      return failed(errors, parts);
    }
    return { ok: true, body: { to, version, appeal: { receivedAt: received.instant, reason } } };
  }
  if (to === "closed") {
    const reason = text(form, "reason");
    if (reason.length < 3 || reason.length > COMPLAINT_TEXT_MAX) {
      return failed({ reason: t("complaints.step.reasonError") }, parts);
    }
    return { ok: true, body: { to, version, reason } };
  }
  return { ok: true, body: { to, version } };
}

/** The new compliment form, with the staff it praises (members of the organisation). */
export function readCompliment(
  form: FormLike & { getAll?: (name: string) => unknown[] },
  t: Translator,
  options: { readonly id: string; readonly locationId: string; readonly now?: Date },
): Read<CreateCompliment> {
  const errors: Record<string, string> = {};
  const parts: Record<string, readonly string[]> = {};
  const fromName = text(form, "fromName");
  if (fromName.length < 1 || fromName.length > 200)
    errors.fromName = t("complaints.form.nameError");
  const relationship = oneOf(COMPLAINT_RELATIONSHIPS, text(form, "fromRelationship"));
  if (!relationship) errors.fromRelationship = t("complaints.form.relationshipError");
  const summary = text(form, "summary");
  if (summary.length < 3 || summary.length > COMPLAINT_SUMMARY_MAX) {
    errors.summary = t("complaints.form.summaryError", { max: COMPLAINT_SUMMARY_MAX });
  }
  const received = readDateTimeField(form, "receivedAt", {
    subject: t("complaints.form.receivedSubject"),
    t,
    ...(options.now ? { now: options.now } : {}),
    futureToleranceMinutes: 0,
  });
  if (!received.ok) {
    errors.receivedAt = (received as TimeProblem).message;
    parts.receivedAt = (received as TimeProblem).parts;
  }
  const staffIds = (form.getAll?.("staffIds") ?? []).filter(
    (v): v is string => typeof v === "string" && UUID.test(v),
  );
  if (Object.keys(errors).length > 0 || !relationship || !received.ok || !received.instant) {
    return failed(errors, parts);
  }
  return {
    ok: true,
    body: {
      id: options.id,
      locationId: options.locationId,
      fromName,
      fromRelationship: relationship,
      receivedAt: received.instant,
      summary,
      staffIds: [...new Set(staffIds)],
      evidenceStatementIds: [],
    },
  };
}
