import type { IncidentDetail, StatutoryNotificationDetail } from "@harbour/contracts";
import { availableTransitions, INCIDENT_WORKFLOW, type IncidentState } from "@harbour/domain";
import type { Translator } from "@harbour/i18n";
import type { ActionResult, FieldErrors } from "./outcome";
import { readDateTimeField } from "./uk-time";

/**
 * The manager's side of an incident and its statutory notifications (safety.md sections 3 and 5;
 * register rows SAFE-001 to SAFE-003; hazard HZ-013): which forms the viewer is offered, and
 * reading those forms. Pure, so every rule is unit tested; the API checks everything again.
 */

/** Shortest and longest reason the API takes for closing, reopening or "not required". */
export const REASON_MIN = 3;
export const REASON_MAX = 1000;
/** The longest regulator's reference the API takes. */
export const REFERENCE_MAX = 120;
/** The longest answer in the prepared form, and the longest key for one. */
export const CONTENT_MAX = 8000;
export const CONTENT_KEY_MAX = 80;
/** The key of the prepared form's free field, below the required content. */
export const CONTENT_NOTES = "Other details";

type FormValues = Pick<FormData, "get">;
const text = (form: FormValues, name: string) => String(form.get(name) ?? "").trim();

/** Why a manager is not offered "close", or what must happen first. */
export type CloseOffer =
  | { readonly kind: "form" }
  /** The person who raised it never closes it (safety.md rule 11): the API refuses them. */
  | { readonly kind: "raisedByYou" }
  /** What must be done first, as the API checks it (`incidentCloseProblems`, HZ-013). */
  | {
      readonly kind: "blocked";
      readonly notifications: readonly { readonly id: string; readonly kind: string }[];
      readonly questions: number;
    };

export interface IncidentManageView {
  /** "under_review" to start the review, "open" to send it back with a reason, or neither. */
  readonly review: "under_review" | "open" | null;
  readonly close: CloseOffer;
}

/**
 * The review and close forms one viewer is offered on an incident, or null for none: only to a
 * holder of `safety.incident.manage`, never on a closed incident or one they cannot see whole
 * (the API refuses both), and "close" never to the person who raised it. With a notification
 * still a draft or ready, or a question still open, the page says what to do first instead of
 * offering a form the API would refuse. The duty of candour record is not on the incident, so a
 * candour record still open is said by the API's refusal.
 */
export function incidentManageView(
  incident: Pick<
    IncidentDetail,
    "status" | "raisedBy" | "restricted" | "openQuestionCount" | "classifier"
  >,
  viewer: { readonly tenantUserId: string; readonly permissions: readonly string[] },
): IncidentManageView | null {
  if (!viewer.permissions.includes("safety.incident.manage")) return null;
  if (incident.restricted || incident.status === "closed") return null;
  const moves = availableTransitions(
    INCIDENT_WORKFLOW,
    { state: incident.status as IncidentState, createdBy: incident.raisedBy },
    viewer.tenantUserId,
    new Set(viewer.permissions),
  );
  const review = moves.find((to) => to === "under_review" || to === "open") ?? null;
  if (!moves.includes("closed")) return { review, close: { kind: "raisedByYou" } };
  const notifications = (incident.classifier?.notifications ?? [])
    .filter((n) => n.status === "draft" || n.status === "ready")
    .map((n) => ({ id: n.id, kind: n.kind }));
  const questions = incident.openQuestionCount;
  if (notifications.length > 0 || questions > 0) {
    return { review, close: { kind: "blocked", notifications, questions } };
  }
  return { review, close: { kind: "form" } };
}

/** The forms one viewer is offered on a statutory notification. */
export interface NotificationManageView {
  /** Fill in the regulator's form, and mark it ready or back to draft. */
  readonly prepare: boolean;
  /** Record that it was submitted: only once it is ready (the workflow takes no other step). */
  readonly submit: boolean;
  /** Decide it is not required, with a reason. */
  readonly notRequired: boolean;
}

/**
 * Which of the notification forms a viewer is offered (ADR-0071): each needs its permission held
 * and, for a notification about a person, listed in the API's `access.reaching` for that person;
 * a submitted or not-required notification takes none. Without an `access` block (a notification
 * about no one) the held permissions decide, and the API checks the scope again.
 */
export function notificationManageView(
  item: Pick<StatutoryNotificationDetail, "status">,
  permissions: readonly string[],
  reaching: readonly string[] | null,
): NotificationManageView {
  const may = (permission: string) =>
    permissions.includes(permission) && (reaching === null || reaching.includes(permission));
  const open = item.status === "draft" || item.status === "ready";
  return {
    prepare: open && may("safety.incident.manage"),
    submit: item.status === "ready" && may("safety.notification.submit"),
    notRequired: open && may("safety.notification.submit"),
  };
}

export type ReasonRead =
  | { readonly ok: true; readonly reason: string }
  | { readonly ok: false; readonly errors: FieldErrors };

/** What one of these forms did, for its address: the page says it when it opens again. */
export const MANAGE_DONE = [
  "reviewing",
  "reopened",
  "closed",
  "saved",
  "ready",
  "draft",
  "submitted",
  "notRequired",
] as const;
export type ManageDone = (typeof MANAGE_DONE)[number];

/** The `done` value from a page's address, when it is one of these. */
export function manageDone(value: string | string[] | undefined): ManageDone | null {
  return typeof value === "string" && (MANAGE_DONE as readonly string[]).includes(value)
    ? (value as ManageDone)
    : null;
}

/** The statuses a record can have once each form is done. */
const DONE_STATUS: Record<ManageDone, readonly string[]> = {
  reviewing: ["under_review"],
  reopened: ["open"],
  closed: ["closed"],
  saved: ["draft", "ready"],
  ready: ["ready"],
  draft: ["draft"],
  submitted: ["submitted"],
  notRequired: ["not_required"],
};

/**
 * The `done` to announce, only while the record's status still matches it: an old address
 * (bookmarked, or opened again after someone else changed the record) says nothing.
 */
export function doneToShow(done: ManageDone | null, status: string): ManageDone | null {
  return done && DONE_STATUS[done].includes(status) ? done : null;
}

/**
 * A result as these forms say it. A version conflict may be this person's own earlier attempt,
 * saved after the connection failed, so it never says someone else changed the record.
 */
export function manageResult<T>(result: ActionResult<T>, t: Translator): ActionResult<T> {
  if (!result.ok && result.code === "version_conflict") {
    return { ...result, message: t("safety.manage.conflict") };
  }
  return result;
}

/**
 * The shortest reason for deciding "not required" on a notification Harbour found needed (not
 * provisional, still indicated): a sentence, not a word (#58 review round 1; the CSO confirms the
 * figure, H-265).
 */
export const NEEDED_REASON_MIN = 20;

/**
 * Whether Harbour found this notification needed: neither provisional (resting on "not sure")
 * nor flagged no longer indicated. Deciding "not required" on one then asks for a longer reason
 * and an explicit confirmation (HZ-013).
 */
export function judgedNeeded(
  item: Pick<StatutoryNotificationDetail, "provisional" | "noLongerIndicated">,
): boolean {
  return !item.provisional && !item.noLongerIndicated;
}

/**
 * A reason of 3 (or `min`) to 1,000 characters and, with `confirm`, the confirmation ticked; or
 * the words that say what to do, at each field.
 */
export function readReason(
  form: FormValues,
  t: Translator,
  purpose: string,
  options: { readonly min?: number; readonly confirm?: boolean } = {},
): ReasonRead {
  const reason = text(form, "reason");
  const min = options.min ?? REASON_MIN;
  const errors: Record<string, string> = {};
  if (reason.length < min || reason.length > REASON_MAX) {
    errors.reason = t("safety.manage.reasonError", { purpose, min });
  }
  if (options.confirm && text(form, "confirm") !== "yes") {
    errors.confirm = t("safety.manage.confirmError");
  }
  return Object.keys(errors).length > 0 ? { ok: false, errors } : { ok: true, reason };
}

/** One field of the prepared form: the required content line it answers, and its key. */
export interface ContentField {
  /** The form field's name. */
  readonly name: string;
  /** The key the answer is stored under (the line, cut to the API's 80 characters). */
  readonly key: string;
  /** The API's own English line; null for the free field. */
  readonly line: string | null;
}

/**
 * The prepared form's fields: one per line of required content, in the API's order, then a free
 * field for anything else the regulator's form asks. Each answer is stored under its line, so it
 * is found again when the page is drawn again. A repeated line is asked once.
 */
export function contentFields(requiredContent: readonly string[]): ContentField[] {
  const fields: ContentField[] = [];
  const seen = new Set<string>([CONTENT_NOTES]);
  for (const line of requiredContent) {
    const key = line.trim().slice(0, CONTENT_KEY_MAX);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    fields.push({ name: `content-${fields.length}`, key, line });
  }
  fields.push({ name: "content-notes", key: CONTENT_NOTES, line: null });
  return fields;
}

export type PrepareRead =
  | { readonly ok: true; readonly content: Record<string, string> }
  | { readonly ok: false; readonly errors: FieldErrors };

/**
 * Reads the prepared form. Saving a draft takes what is there; marking it ready needs every line
 * of required content answered (the API does not check this: HZ-013). Blank answers are left out.
 */
export function readPrepareForm(
  form: FormValues,
  fields: readonly ContentField[],
  ready: boolean,
  t: Translator,
): PrepareRead {
  const content: Record<string, string> = {};
  const errors: Record<string, string> = {};
  for (const field of fields) {
    const value = text(form, field.name);
    if (value.length > CONTENT_MAX) {
      errors[field.name] = t("safety.manage.contentError", { error: "tooLong" });
    } else if (value) {
      content[field.key] = value;
    } else if (ready && field.line !== null) {
      errors[field.name] = t("safety.manage.contentError", { error: "required" });
    }
  }
  return Object.keys(errors).length > 0 ? { ok: false, errors } : { ok: true, content };
}

export type SubmitRead =
  | {
      readonly ok: true;
      /** Null for "just now": the server action takes its own time (HZ-090). */
      readonly submittedAt: string | null;
      readonly externalReference: string;
    }
  | {
      readonly ok: false;
      readonly errors: FieldErrors;
      readonly parts?: Readonly<Record<string, readonly string[]>>;
    };

/**
 * Reads "record that it was submitted": when, chosen every time (just now, or earlier with the
 * date and time, never in the future), and the regulator's reference. The web cannot attach the
 * submitted form yet, so the reference is needed (`submissionEvidenceProblems`).
 */
export function readSubmitForm(form: FormValues, now: Date, t: Translator): SubmitRead {
  const errors: Record<string, string> = {};
  const parts: Record<string, readonly string[]> = {};
  const mode = text(form, "submittedAt-mode");
  let submittedAt: string | null = null;
  if (mode === "earlier") {
    const read = readDateTimeField(form, "submittedAt", {
      subject: t("safety.manage.submittedSubject"),
      t,
      now,
      // The API refuses any submission time after it receives the form.
      futureToleranceMinutes: 0,
    });
    if (read.ok && read.instant) submittedAt = read.instant;
    else if (!read.ok) {
      errors.submittedAt = read.message;
      parts.submittedAt = read.parts;
    } else {
      errors.submittedAt = t("safety.manage.submitError", { field: "submittedAt" });
    }
  } else if (mode !== "now") {
    errors.submittedAt = t("safety.manage.submitError", { field: "submittedAt" });
  }
  const externalReference = text(form, "externalReference");
  if (!externalReference || externalReference.length > REFERENCE_MAX) {
    errors.externalReference = t("safety.manage.submitError", { field: "externalReference" });
  }
  if (Object.keys(errors).length > 0) {
    return { ok: false, errors, ...(Object.keys(parts).length > 0 ? { parts } : {}) };
  }
  return { ok: true, submittedAt, externalReference };
}
