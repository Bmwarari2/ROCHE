"use server";

import type {
  ClassifierAnswerValue,
  ClassifierQuestionKey,
  ClassifierState,
  IncidentDetail,
  StatutoryNotificationDetail,
} from "@harbour/contracts";
import { sendAndRevalidate } from "@/lib/care-actions";
import { isUuid } from "@/lib/context-cookies";
import { t } from "@/lib/i18n";
import type { IncidentDraft } from "@/lib/incident-forms";
import { type ActionResult, refused } from "@/lib/outcome";
import { isIsoInstant } from "@/lib/uk-time";

/**
 * Writes for the incident screens (safety.md; register rows SAFE-001 and SAFE-002; hazards HZ-013
 * and HZ-027). The API checks the permission where the incident is (ADR-0071), every rule, and
 * runs the classifier; the web holds nothing of its own.
 */

export interface IncidentInput {
  /**
   * The incident's own UUIDv7, made by the form and sent with every attempt, so a retry after an
   * unknown outcome returns the incident already recorded instead of a second one (HZ-029).
   */
  readonly id: string;
  /** The device's clock when the form was sent, so the API can flag clock drift (HZ-010). */
  readonly sentAt: string;
  readonly draft: IncidentDraft;
}

/** Record an incident or near miss (`safety.incident.report`). */
export async function recordIncident(input: IncidentInput): Promise<ActionResult<IncidentDetail>> {
  if (!isUuid(input.id) || !isUuid(input.draft.locationId)) {
    return refused(t("care.errors.invalid"));
  }
  // "Just now" is when the server receives the form, never the browser's clock (HZ-090). A retry
  // keeps the incident's id, so the API returns the copy already recorded with its first time.
  const occurredAt = input.draft.occurredAt ?? new Date().toISOString();
  if (!isIsoInstant(occurredAt)) {
    return refused(t("care.errors.whenRequired"), "invalid", ["occurredAt"]);
  }
  const personPaths = (input.draft.people ?? []).flatMap((p) =>
    p.personId && isUuid(p.personId) ? [`/people/${p.personId}`] : [],
  );
  return sendAndRevalidate(["/incidents", "/notifications/statutory", ...personPaths], (api) =>
    api.POST("/v1/incidents", {
      headers: isIsoInstant(input.sentAt) ? { "x-harbour-sent-at": input.sentAt } : {},
      // For a web entry "made" is when the server receives it (care.md rule 3): no device time.
      body: { ...input.draft, occurredAt, id: input.id },
    }),
  );
}

/**
 * Answer some of an incident's open questions. The API keeps every answer (the latest per
 * question counts) and classifies the incident again. Answers carry no client id in the API, so
 * sending the same answer twice after an unknown outcome stores it twice, harmlessly.
 */
export async function answerIncidentQuestions(
  incidentId: string,
  answers: readonly { key: ClassifierQuestionKey; value: ClassifierAnswerValue }[],
): Promise<ActionResult<ClassifierState>> {
  if (!isUuid(incidentId)) return refused(t("errors.notFound"), "not_found");
  if (answers.length === 0) return refused(t("safety.questions.error", { error: "noAnswers" }));
  return sendAndRevalidate(["/incidents", "/notifications/statutory"], (api) =>
    api.POST("/v1/incidents/{id}/classifier", {
      params: { path: { id: incidentId } },
      body: { answers: [...answers] },
    }),
  );
}

/**
 * Start an incident's review, or send it back to open with a reason (`safety.incident.manage`).
 * The version makes a second attempt after an unknown outcome a conflict, never a second move.
 */
export async function reviewIncident(
  incidentId: string,
  input: {
    readonly to: "under_review" | "open";
    readonly reason?: string;
    readonly version: number;
  },
): Promise<ActionResult<IncidentDetail>> {
  if (!isUuid(incidentId)) return refused(t("errors.notFound"), "not_found");
  return sendAndRevalidate(["/incidents", "/notifications/statutory"], (api) =>
    api.POST("/v1/incidents/{id}/review", {
      params: { path: { id: incidentId } },
      body: {
        to: input.to,
        version: input.version,
        ...(input.reason ? { reason: input.reason } : {}),
      },
    }),
  );
}

/**
 * Close an incident with a reason (`safety.incident.manage`, never the person who raised it). The
 * API refuses while a notification is a draft or ready, a question is open or the candour record
 * is open, and says which.
 */
export async function closeIncident(
  incidentId: string,
  input: { readonly reason: string; readonly version: number },
): Promise<ActionResult<IncidentDetail>> {
  if (!isUuid(incidentId)) return refused(t("errors.notFound"), "not_found");
  return sendAndRevalidate(["/incidents", "/notifications/statutory"], (api) =>
    api.POST("/v1/incidents/{id}/close", {
      params: { path: { id: incidentId } },
      body: { reason: input.reason, version: input.version },
    }),
  );
}

/** The incident's pages and the notification pages, which show a notification's status. */
const notificationPaths = (incidentId: string | null) => [
  "/notifications/statutory",
  incidentId && isUuid(incidentId) ? `/incidents/${incidentId}` : "/incidents",
];

/** Fill in a notification's form, and mark it ready or back to draft (`safety.incident.manage`). */
export async function prepareNotification(
  notificationId: string,
  incidentId: string | null,
  input: {
    readonly content: Record<string, string>;
    readonly ready: boolean;
    readonly version: number;
  },
): Promise<ActionResult<StatutoryNotificationDetail>> {
  if (!isUuid(notificationId)) return refused(t("errors.notFound"), "not_found");
  return sendAndRevalidate(notificationPaths(incidentId), (api) =>
    api.POST("/v1/notifications/statutory/{id}/prepare", {
      params: { path: { id: notificationId } },
      body: { content: input.content, ready: input.ready, version: input.version },
    }),
  );
}

/**
 * Record that a ready notification was submitted on the regulator's own portal, with its
 * reference (`safety.notification.submit`, step-up). "Just now" is when the server receives the
 * form, never the browser's clock (HZ-090).
 */
export async function submitNotification(
  notificationId: string,
  incidentId: string | null,
  input: {
    readonly submittedAt: string | null;
    readonly externalReference: string;
    readonly version: number;
  },
): Promise<ActionResult<StatutoryNotificationDetail>> {
  if (!isUuid(notificationId)) return refused(t("errors.notFound"), "not_found");
  const submittedAt = input.submittedAt ?? new Date().toISOString();
  if (!isIsoInstant(submittedAt)) {
    return refused(t("safety.manage.submitError", { field: "submittedAt" }), "invalid", [
      "submittedAt",
    ]);
  }
  return sendAndRevalidate(notificationPaths(incidentId), (api) =>
    api.POST("/v1/notifications/statutory/{id}/submit", {
      params: { path: { id: notificationId } },
      body: { submittedAt, externalReference: input.externalReference, version: input.version },
    }),
  );
}

/** Decide a notification is not required, with the reason (`safety.notification.submit`, step-up). */
export async function markNotificationNotRequired(
  notificationId: string,
  incidentId: string | null,
  input: { readonly reason: string; readonly version: number },
): Promise<ActionResult<StatutoryNotificationDetail>> {
  if (!isUuid(notificationId)) return refused(t("errors.notFound"), "not_found");
  return sendAndRevalidate(notificationPaths(incidentId), (api) =>
    api.POST("/v1/notifications/statutory/{id}/not-required", {
      params: { path: { id: notificationId } },
      body: { reason: input.reason, version: input.version },
    }),
  );
}
