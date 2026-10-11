"use client";

import type { CreateCareNote } from "@harbour/contracts";
import { Button, TextArea, TextField } from "@harbour/ui";
import { PencilLine } from "lucide-react";
import { type FormEvent, useEffect, useId, useRef, useState, useTransition } from "react";
import { recordNote } from "@/app/actions/care-record";
import { NOTE_MAX_LENGTH } from "@/lib/care-record";
import { characterCount, t } from "@/lib/i18n";
import type { ActionResult } from "@/lib/outcome";
import { FormFeedback } from "./FormFeedback";

/**
 * "Correct this note" (CONTENT.md, corrections): notes are never edited or deleted. The correction
 * is a new note that supersedes the original with a reason; the original stays visible, struck
 * through.
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
  const [open, setOpen] = useState(false);
  const [result, setResult] = useState<ActionResult<unknown> | null>(null);
  const [pending, startTransition] = useTransition();
  const formId = useId();
  const bodyRef = useRef<HTMLTextAreaElement>(null);
  // Opening the form moves focus into it, at the corrected text.
  useEffect(() => {
    if (open) bodyRef.current?.focus();
  }, [open]);

  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    startTransition(async () => {
      const outcome = await recordNote(personId, {
        category: note.category,
        body: String(form.get("body") ?? ""),
        occurredAt: note.occurredAt,
        sentAt: new Date().toISOString(),
        supersedesId: note.id,
        correctionReason: String(form.get("reason") ?? ""),
      });
      setResult(outcome);
      if (outcome.ok) setOpen(false);
    });
  };

  return (
    <div className="flex flex-col gap-3">
      {open ? (
        <form id={formId} className="flex flex-col gap-4" onSubmit={submit} noValidate>
          <TextArea
            ref={bodyRef}
            name="body"
            label={t("care.notes.correct.body")}
            defaultValue={note.body}
            rows={4}
            required
            maxLength={NOTE_MAX_LENGTH}
            formatCount={(remaining) => characterCount(remaining)}
          />
          <TextField
            name="reason"
            label={t("care.notes.correct.reason")}
            hint={t("care.notes.correct.reasonHint")}
            required
            maxLength={500}
          />
          <div className="flex flex-wrap gap-2">
            <Button type="submit" disabled={pending}>
              {pending ? t("common.saving") : t("care.notes.correct.submit")}
            </Button>
            <Button variant="secondary" onClick={() => setOpen(false)}>
              {t("common.cancel")}
            </Button>
          </div>
        </form>
      ) : (
        <div>
          <Button
            variant="secondary"
            icon={<PencilLine size={16} strokeWidth={1.5} />}
            onClick={() => {
              setResult(null);
              setOpen(true);
            }}
          >
            {t("care.notes.correct.open")}
          </Button>
        </div>
      )}
      <FormFeedback result={result} success={t("care.notes.correct.saved")} />
    </div>
  );
}
