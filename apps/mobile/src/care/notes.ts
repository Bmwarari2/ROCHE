/**
 * Writing a daily note offline (care.md section 4 rules 3 and 4; register CARE-009). The note is
 * checked on the device against the same limits the API applies, then stored as a new row; the
 * upload queue sends it when there is a connection. Correcting a note writes a new note that
 * supersedes it with a reason (HZ-017); the original is never edited.
 */
import type { CreateCareNote } from "@harbour/contracts";
import { HANDOVER_NOTE_TAGS } from "@harbour/domain";
import {
  type Correction,
  checkCorrectionReason,
  type EntryContext,
  type EntryRow,
  entryRow,
  type FieldError,
} from "./entries";
import { resolveOccurredAt, type WhenChoice } from "./time";

export type NoteCategory = CreateCareNote["category"];

export const NOTE_CATEGORIES: readonly NoteCategory[] = [
  "personal_care",
  "nutrition",
  "mood",
  "activity",
  "visit",
  "health",
  "night",
  "other",
];

/** The fixed tag vocabulary handover reads (free-text tags are never matched). */
export const NOTE_TAGS: readonly string[] = Object.values(HANDOVER_NOTE_TAGS);

/** API limit from `@harbour/contracts` (`CreateCareNote.body`); a test keeps them equal. */
export const NOTE_BODY_MAX = 4000;

export interface NoteDraft {
  readonly category: NoteCategory | null;
  readonly body: string;
  readonly tags: readonly string[];
  readonly when: WhenChoice;
  /** Present when correcting an earlier note. */
  readonly correction: Correction | null;
}

export type NoteField = "category" | "body" | "when" | "reason";

export type NoteCheck =
  | { readonly ok: true; readonly row: EntryRow }
  | { readonly ok: false; readonly errors: Partial<Record<NoteField, FieldError>> };

export function checkNote(draft: NoteDraft, context: EntryContext, now: Date): NoteCheck {
  const errors: Partial<Record<NoteField, FieldError>> = {};
  if (!draft.category || !NOTE_CATEGORIES.includes(draft.category)) {
    errors.category = { key: "mobile.form.choose" };
  }
  const body = draft.body.trim();
  if (!body) errors.body = { key: "mobile.note.bodyRequired" };
  else if (body.length > NOTE_BODY_MAX) {
    errors.body = { key: "mobile.note.bodyTooLong", values: { max: NOTE_BODY_MAX } };
  }
  const when = resolveOccurredAt(draft.when, now);
  if (!when.ok) errors.when = { key: when.error };
  if (draft.correction) {
    const reason = checkCorrectionReason(draft.correction.reason);
    if (reason) errors.reason = reason;
  }
  if (Object.keys(errors).length > 0 || !when.ok || !draft.category) return { ok: false, errors };

  const tags = NOTE_TAGS.filter((tag) => draft.tags.includes(tag));
  return {
    ok: true,
    row: {
      ...entryRow(context, when.occurredAt, now, draft.correction),
      category: draft.category,
      body,
      tags: JSON.stringify(tags),
    },
  };
}
