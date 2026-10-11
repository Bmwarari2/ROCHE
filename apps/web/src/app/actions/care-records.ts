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
import { isRefusal, occurredAt, optionalText, sendForPerson } from "@/lib/care-actions";
import { isUuid } from "@/lib/context-cookies";
import { t } from "@/lib/i18n";
import { type ActionResult, refused } from "@/lib/outcome";
import { isIsoDate } from "@/lib/uk-time";

/**
 * Writes for validated tools, advance care records, activities and visits (care.md slice 4b).
 * The API calculates every tool result exactly as published and returns it with the workings;
 * the web app sends the answers only.
 */

type AssessmentAnswers = Pick<CreateAssessment, "toolKey" | "answers">;

export async function recordAssessment(
  personId: string,
  input: AssessmentAnswers & { readonly occurredAtLocal: string },
): Promise<ActionResult<AssessmentItem>> {
  const when = occurredAt(input.occurredAtLocal);
  if (isRefusal(when)) return when;
  const { occurredAtLocal: _local, ...assessment } = input;
  return sendForPerson(personId, (api) =>
    api.POST("/v1/people/{id}/assessments", {
      params: { path: { id: personId } },
      body: { ...assessment, occurredAt: when } as CreateAssessment,
    }),
  );
}

export async function recordAdvanceCare(
  personId: string,
  input: CreateAdvanceCareRecord,
): Promise<ActionResult<AdvanceCareItem>> {
  if (!isIsoDate(input.completedOn)) return refused(t("care.advance.form.dateRequired"));
  if (input.reviewDueOn !== undefined && !isIsoDate(input.reviewDueOn)) {
    return refused(t("care.errors.invalid"));
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
  if (reason.length < 3) return refused(t("care.advance.withdraw.reasonRequired"));
  return sendForPerson(personId, (api) =>
    api.PUT("/v1/people/{id}/advance-care/{recordId}", {
      params: { path: { id: personId, recordId } },
      body: { withdrawnReason: reason, version: input.version },
    }),
  );
}

export async function recordActivity(
  personId: string,
  input: Omit<CreateActivityRecord, "occurredAt" | "groupSessionId"> & {
    readonly occurredAtLocal: string;
  },
): Promise<ActionResult<ActivityRecordItem>> {
  const when = occurredAt(input.occurredAtLocal);
  if (isRefusal(when)) return when;
  const { occurredAtLocal: _local, notes, ...activity } = input;
  const text = optionalText(notes);
  return sendForPerson(personId, (api) =>
    api.POST("/v1/people/{id}/activities", {
      params: { path: { id: personId } },
      body: {
        ...activity,
        ...(text ? { notes: text } : {}),
        // A group session recorded from one person's record is a session of its own; recording
        // a whole group at once is a follow-up.
        ...(activity.format === "group" ? { groupSessionId: crypto.randomUUID() } : {}),
        occurredAt: when,
      },
    }),
  );
}

export async function recordVisit(
  personId: string,
  input: Omit<CreateVisit, "occurredAt" | "endedAt"> & {
    readonly occurredAtLocal: string;
    readonly endedAtLocal: string;
  },
): Promise<ActionResult<VisitItem>> {
  const when = occurredAt(input.occurredAtLocal);
  if (isRefusal(when)) return when;
  let endedAt: string | undefined;
  if (input.endedAtLocal.trim()) {
    const ended = occurredAt(input.endedAtLocal);
    if (isRefusal(ended)) return ended;
    endedAt = ended;
  }
  const { occurredAtLocal: _start, endedAtLocal: _end, ...visit } = input;
  const visitorName = optionalText(visit.visitorName);
  const visitorRelationship = optionalText(visit.visitorRelationship);
  const restrictionReason = optionalText(visit.restrictionReason);
  const notes = optionalText(visit.notes);
  return sendForPerson(personId, (api) =>
    api.POST("/v1/people/{id}/visits", {
      params: { path: { id: personId } },
      body: {
        kind: visit.kind,
        restrictionsApplied: visit.restrictionsApplied,
        occurredAt: when,
        ...(endedAt ? { endedAt } : {}),
        ...(visitorName ? { visitorName } : {}),
        ...(visitorRelationship ? { visitorRelationship } : {}),
        ...(restrictionReason ? { restrictionReason } : {}),
        ...(notes ? { notes } : {}),
      },
    }),
  );
}
