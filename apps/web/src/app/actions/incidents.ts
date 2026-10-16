"use server";

import type {
  ClassifierAnswerValue,
  ClassifierQuestionKey,
  ClassifierState,
  IncidentDetail,
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
