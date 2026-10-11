"use server";

import type {
  ActivityRecordItem,
  AdvanceCareItem,
  AssessmentItem,
  CreateActivityRecord,
  CreateAdvanceCareRecord,
  CreateAssessment,
  CreateVisit,
  VisitItem,
} from "@harbour/contracts";
import {
  type EntryTiming,
  entryTime,
  isRefusal,
  optionalText,
  sendForPerson,
} from "@/lib/care-actions";
import { isUuid } from "@/lib/context-cookies";
import { t } from "@/lib/i18n";
import { type ActionResult, refused } from "@/lib/outcome";
import { isIsoDate, isIsoInstant } from "@/lib/uk-time";

/**
 * Writes for validated tools, advance care records, activities and visits (care.md slice 4b).
 * The API calculates every tool result exactly as published and returns it with the workings;
 * the web app sends the answers only.
 */

type AssessmentAnswers = Pick<CreateAssessment, "toolKey" | "answers">;

export async function recordAssessment(
  personId: string,
  input: AssessmentAnswers & EntryTiming,
): Promise<ActionResult<AssessmentItem>> {
  const when = entryTime(input);
  if (isRefusal(when)) return when;
  const { id: _id, occurredAt: _when, sentAt: _sent, ...assessment } = input;
  return sendForPerson(personId, (api) =>
    api.POST("/v1/people/{id}/assessments", {
      params: { path: { id: personId } },
      headers: when.headers,
      body: { ...assessment, id: when.id, occurredAt: when.occurredAt } as CreateAssessment,
    }),
  );
}

export async function recordAdvanceCare(
  personId: string,
  input: CreateAdvanceCareRecord,
): Promise<ActionResult<AdvanceCareItem>> {
  if (!isIsoDate(input.completedOn)) {
    return refused(t("care.advance.form.dateRequired"), "invalid", ["completedOn"]);
  }
  if (input.reviewDueOn !== undefined && !isIsoDate(input.reviewDueOn)) {
    return refused(t("care.errors.invalid"), "invalid", ["reviewDueOn"]);
  }
  const clinicianName = optionalText(input.clinicianName);
  const clinicianRole = optionalText(input.clinicianRole);
  const details = optionalText(input.details);
  return sendForPerson(personId, (api) =>
    api.POST("/v1/people/{id}/advance-care", {
      params: { path: { id: personId } },
      body: {
        kind: input.kind,
        completedOn: input.completedOn,
        ...(input.cprDecision ? { cprDecision: input.cprDecision } : {}),
        ...(clinicianName ? { clinicianName } : {}),
        ...(clinicianRole ? { clinicianRole } : {}),
        ...(input.reviewDueOn ? { reviewDueOn: input.reviewDueOn } : {}),
        ...(details ? { details } : {}),
      },
    }),
  );
}

export async function withdrawAdvanceCare(
  personId: string,
  recordId: string,
  input: { readonly reason: string; readonly version: number },
): Promise<ActionResult<AdvanceCareItem>> {
  if (!isUuid(recordId)) return refused(t("errors.notFound"), "not_found");
  const reason = input.reason.trim();
  if (reason.length < 3) {
    return refused(t("care.advance.withdraw.reasonRequired"), "invalid", ["reason"]);
  }
  return sendForPerson(personId, (api) =>
    api.PUT("/v1/people/{id}/advance-care/{recordId}", {
      params: { path: { id: personId, recordId } },
      body: { withdrawnReason: reason, version: input.version },
    }),
  );
}

export async function recordActivity(
  personId: string,
  input: Omit<CreateActivityRecord, "occurredAt" | "groupSessionId"> & EntryTiming,
): Promise<ActionResult<ActivityRecordItem>> {
  const when = entryTime(input);
  if (isRefusal(when)) return when;
  const { id: _id, occurredAt: _when, sentAt: _sent, notes, ...activity } = input;
  const text = optionalText(notes);
  return sendForPerson(personId, (api) =>
    api.POST("/v1/people/{id}/activities", {
      params: { path: { id: personId } },
      headers: when.headers,
      body: {
        ...activity,
        ...(text ? { notes: text } : {}),
        // A group session recorded from one person's record is a session of its own; recording
        // a whole group at once is a follow-up.
        ...(activity.format === "group" ? { groupSessionId: crypto.randomUUID() } : {}),
        id: when.id,
        occurredAt: when.occurredAt,
      },
    }),
  );
}

export async function recordVisit(
  personId: string,
  input: Omit<CreateVisit, "occurredAt" | "endedAt"> &
    EntryTiming & {
      /** When the visit ended, as an ISO instant, or null when it is not recorded. */
      readonly endedAt: string | null;
    },
): Promise<ActionResult<VisitItem>> {
  const when = entryTime(input);
  if (isRefusal(when)) return when;
  if (input.endedAt !== null && !isIsoInstant(input.endedAt)) {
    return refused(t("care.errors.whenRequired"), "invalid", ["endedAt"]);
  }
  const endedAt = input.endedAt ?? undefined;
  const { id: _id, occurredAt: _when, sentAt: _sent, endedAt: _end, ...visit } = input;
  const visitorName = optionalText(visit.visitorName);
  const visitorRelationship = optionalText(visit.visitorRelationship);
  const restrictionReason = optionalText(visit.restrictionReason);
  const notes = optionalText(visit.notes);
  return sendForPerson(personId, (api) =>
    api.POST("/v1/people/{id}/visits", {
      params: { path: { id: personId } },
      headers: when.headers,
      body: {
        kind: visit.kind,
        restrictionsApplied: visit.restrictionsApplied,
        id: when.id,
        occurredAt: when.occurredAt,
        ...(endedAt ? { endedAt } : {}),
        ...(visitorName ? { visitorName } : {}),
        ...(visitorRelationship ? { visitorRelationship } : {}),
        ...(restrictionReason ? { restrictionReason } : {}),
        ...(notes ? { notes } : {}),
      },
    }),
  );
}
