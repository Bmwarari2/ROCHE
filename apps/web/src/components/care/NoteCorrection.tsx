"use client";

import type { CreateCareNote } from "@harbour/contracts";
import { Button, TextArea, TextField } from "@harbour/ui";
import { PencilLine } from "lucide-react";
import { type FormEvent, useState, useTransition } from "react";
import { recordNote } from "@/app/actions/care-record";
import { NOTE_MAX_LENGTH } from "@/lib/care-record";
import { characterCount, t } from "@/lib/i18n";
import { type ActionResult, errorFor, refused } from "@/lib/outcome";
import { FormFeedback } from "./FormFeedback";
import { useEntryId, useFieldIds, useInlineForm } from "./form-state";

const FIELDS = ["body", "reason"] as const;

/**
 * "Correct this note" (CONTENT.md, corrections): notes are never edited or deleted. The correction
 * is a new note that supersedes the original with a reason; the original stays visible, struck
 * through. It keeps the original note's time, unchanged. Opening it moves focus to the text;
 * Cancel and saving put focus back on "Correct this note".
 */
export function NoteCorrection({
  personId,
  note,
}: {
  readonly personId: string;
  readonly note: {
    readonly id: string;
    readonly category: CreateCareNote["category"];
    readonly body: string;
    /** When the note's event happened: a correction keeps that instant unchanged. */
    readonly occurredAt: string;
  };
}) {
  const inline = useInlineForm<HTMLTextAreaElement>();
  const [result, setResult] = useState<ActionResult<unknown> | null>(null);
  const [pending, startTransition] = useTransition();
  const ids = useFieldIds(FIELDS);
  const entry = useEntryId();

  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    const body = String(form.get("body") ?? "");
    const reason = String(form.get("reason") ?? "");
    if (!body.trim()) {
      setResult(refused(t("care.notes.bodyRequired"), "invalid", ["body"]));
      return;
    }
    if (reason.trim().length < 3) {
      setResult(refused(t("care.notes.correct.reasonRequired"), "invalid", ["reason"]));
      return;
    }
    startTransition(async () => {
      const outcome = await recordNote(personId, {
        id: entry.id,
        category: note.category,
        body,
        occurredAt: note.occurredAt,
        sentAt: new Date().toISOString(),
        supersedesId: note.id,
        correctionReason: reason,
      });
      setResult(outcome);
      if (outcome.ok) {
        entry.next();
        inline.hide();
      }
    });
  };

  return (
    <div className="flex flex-col gap-3">
      {inline.open ? (
        <form className="flex flex-col gap-4" onSubmit={submit} noValidate>
          <TextArea
            ref={inline.firstField}
            id={ids.body}
            name="body"
            label={t("care.notes.correct.body")}
            defaultValue={note.body}
            rows={4}
            required
            maxLength={NOTE_MAX_LENGTH}
            formatCount={(remaining) => characterCount(remaining)}
            error={errorFor(result, "body")}
          />
          <TextField
            id={ids.reason}
            name="reason"
            label={t("care.notes.correct.reason")}
            hint={t("care.notes.correct.reasonHint")}
            required
            maxLength={500}
            error={errorFor(result, "reason")}
          />
          <div className="flex flex-wrap gap-2">
            <Button type="submit" disabled={pending}>
              {pending ? t("common.saving") : t("care.notes.correct.submit")}
            </Button>
            <Button
              variant="secondary"
              onClick={() => {
                setResult(null);
                inline.hide();
              }}
            >
              {t("common.cancel")}
            </Button>
          </div>
        </form>
      ) : (
        <div>
          <Button
            ref={inline.trigger}
            variant="secondary"
            icon={<PencilLine size={16} strokeWidth={1.5} />}
            onClick={() => {
              setResult(null);
              inline.show();
            }}
          >
            {t("care.notes.correct.open")}
          </Button>
        </div>
      )}
      <FormFeedback
        result={result}
        success={t("care.notes.correct.saved")}
        fieldIds={ids}
        focusOnSuccess={inline.trigger}
      />
    </div>
  );
}
