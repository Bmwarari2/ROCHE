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

/**
 * Writes for the point-of-care record: notes, chart entries, body-map marks and chart settings
 * (care.md slice 4a). Notes, entries and marks are append-only; a correction supersedes the
 * original with a reason and both stay readable. For a web entry "made" is when the server
 * receives it (care.md rule 3); the device's clock when the form was sent goes with it, so the
 * API can flag a clock that is wrong (HZ-010).
 */

export interface NoteInput extends EntryTiming {
  readonly category: CreateCareNote["category"];
  readonly body: string;
  /** For a correction: the note it replaces and why; `occurredAt` is then the original's. */
  readonly supersedesId?: string;
  readonly correctionReason?: string;
}

export async function recordNote(
  personId: string,
  input: NoteInput,
): Promise<ActionResult<CareNoteItem>> {
  const body = input.body.trim();
  if (!body) return refused(t("care.notes.bodyRequired"), "invalid", ["body"]);
  const when = entryTime(input);
  if (isRefusal(when)) return when;
  if (input.supersedesId !== undefined) {
    if (!isUuid(input.supersedesId)) return refused(t("errors.notFound"), "not_found");
    if ((input.correctionReason?.trim().length ?? 0) < 3) {
      return refused(t("care.notes.correct.reasonRequired"), "invalid", ["reason"]);
    }
  }
  return sendForPerson(personId, (api) =>
    api.POST("/v1/people/{id}/notes", {
      params: { path: { id: personId } },
      headers: when.headers,
      body: {
        id: when.id,
        occurredAt: when.occurredAt,
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
  input: EntryTiming & { readonly values: ObservationValues },
): Promise<ActionResult<ObservationItem>> {
  const when = entryTime(input);
  if (isRefusal(when)) return when;
  return sendForPerson(personId, (api) =>
    api.POST("/v1/people/{id}/observations", {
      params: { path: { id: personId } },
      headers: when.headers,
      body: { id: when.id, occurredAt: when.occurredAt, values: input.values },
    }),
  );
}

export type MarkInput = Omit<CreateBodyMapMark, "occurredAt" | "id" | "deviceTime" | "taskId"> &
  EntryTiming;

export async function recordBodyMark(
  personId: string,
  input: MarkInput,
): Promise<ActionResult<BodyMapMarkItem>> {
  const when = entryTime(input);
  if (isRefusal(when)) return when;
  const { id: _id, occurredAt: _when, sentAt: _sent, description, ...mark } = input;
  const text = optionalText(description);
  // The API decides whether the side drawn and the side stated agree (HZ-019).
  return sendForPerson(personId, (api) =>
    api.POST("/v1/people/{id}/body-map", {
      params: { path: { id: personId } },
      headers: when.headers,
      body: {
        ...mark,
        ...(text ? { description: text } : {}),
        id: when.id,
        occurredAt: when.occurredAt,
      },
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
