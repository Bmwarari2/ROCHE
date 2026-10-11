"use server";

import type {
  BodyMapMarkItem,
  CareNoteItem,
  CreateBodyMapMark,
  CreateCareNote,
  ObservationItem,
  ObservationValues,
  PersonCareProfile,
  UpdatePersonCareProfile,
} from "@harbour/contracts";
import { isRefusal, occurredAt, optionalText, sendForPerson } from "@/lib/care-actions";
import { isUuid } from "@/lib/context-cookies";
import { t } from "@/lib/i18n";
import { type ActionResult, refused } from "@/lib/outcome";

/**
 * Writes for the point-of-care record: notes, chart entries, body-map marks and chart settings
 * (care.md slice 4a). Notes, entries and marks are append-only; a correction supersedes the
 * original with a reason and both stay readable. The web sends no device time: for a web entry
 * "made" is when the server receives it (care.md rule 3).
 */

export interface NoteInput {
  readonly category: CreateCareNote["category"];
  readonly body: string;
  /** UK wall-clock time from a `datetime-local` input. */
  readonly occurredAtLocal: string;
  /** For a correction: the note it replaces and why. */
  readonly supersedesId?: string;
  readonly correctionReason?: string;
}

export async function recordNote(
  personId: string,
  input: NoteInput,
): Promise<ActionResult<CareNoteItem>> {
  const body = input.body.trim();
  if (!body) return refused(t("care.notes.bodyRequired"));
  const when = occurredAt(input.occurredAtLocal);
  if (isRefusal(when)) return when;
  if (input.supersedesId !== undefined) {
    if (!isUuid(input.supersedesId)) return refused(t("errors.notFound"), "not_found");
    if ((input.correctionReason?.trim().length ?? 0) < 3) {
      return refused(t("care.notes.correct.reasonRequired"));
    }
  }
  return sendForPerson(personId, (api) =>
    api.POST("/v1/people/{id}/notes", {
      params: { path: { id: personId } },
      body: {
        occurredAt: when,
        category: input.category,
        body,
        tags: [],
        attachmentDocumentIds: [],
        ...(input.supersedesId
          ? {
              supersedesId: input.supersedesId,
              correctionReason: input.correctionReason?.trim() ?? "",
            }
          : {}),
      },
    }),
  );
}

export async function recordObservation(
  personId: string,
  input: { readonly occurredAtLocal: string; readonly values: ObservationValues },
): Promise<ActionResult<ObservationItem>> {
  const when = occurredAt(input.occurredAtLocal);
  if (isRefusal(when)) return when;
  return sendForPerson(personId, (api) =>
    api.POST("/v1/people/{id}/observations", {
      params: { path: { id: personId } },
      body: { occurredAt: when, values: input.values },
    }),
  );
}

export type MarkInput = Omit<CreateBodyMapMark, "occurredAt" | "id" | "deviceTime" | "taskId"> & {
  readonly occurredAtLocal: string;
};

export async function recordBodyMark(
  personId: string,
  input: MarkInput,
): Promise<ActionResult<BodyMapMarkItem>> {
  const when = occurredAt(input.occurredAtLocal);
  if (isRefusal(when)) return when;
  const { occurredAtLocal: _local, description, ...mark } = input;
  const text = optionalText(description);
  // The API decides whether the side drawn and the side stated agree (HZ-019); its refusal is
  // shown to the person word for word.
  return sendForPerson(personId, (api) =>
    api.POST("/v1/people/{id}/body-map", {
      params: { path: { id: personId } },
      body: { ...mark, ...(text ? { description: text } : {}), occurredAt: when },
    }),
  );
}

export async function updateCareProfile(
  personId: string,
  input: UpdatePersonCareProfile,
): Promise<ActionResult<PersonCareProfile>> {
  return sendForPerson(personId, (api) =>
    api.PUT("/v1/people/{id}/care-profile", {
      params: { path: { id: personId } },
      body: input,
    }),
  );
}
