"use client";

import type { CreateCareNote, EntryBackEntry } from "@harbour/contracts";
import { Button, TextArea, TextField } from "@harbour/ui";
import { PencilLine } from "lucide-react";
import { type FormEvent, useState, useTransition } from "react";
import { recordNote } from "@/app/actions/care-record";
import { correctionBackEntry } from "@/lib/back-entry";
import { NOTE_MAX_LENGTH } from "@/lib/care-record";
import { characterCount, t } from "@/lib/i18n";
import { type ActionResult, errorFor, refused } from "@/lib/outcome";
import { FormFeedback } from "./FormFeedback";
import { useEntryId, useFieldIds, useInlineForm } from "./form-state";

const FIELDS = ["body", "reason", "outsideOutageReason"] as const;

/**
 * "Correct this note" (CONTENT.md, corrections): notes are never edited or deleted. The correction
 * is a new note that supersedes the original with a reason; the original stays visible, struck
 * through. It keeps the original note's time, unchanged. Opening it moves focus to the text;
 * Cancel and saving put focus back on "Correct this note".
 *
 * A note entered from a paper form keeps its paper details (the API carries them). When the
 * outage was closed with a true end before the paper time (H-207), the API refuses until the
 * correction says why the time is outside the outage (H-208): the form then asks for that reason
 * and sends the paper details again with it. A paper record is corrected once; a second
 * correction is refused in words that say to reload and correct the current version.
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
    /** Set when the note was entered from a paper downtime form. */
    readonly backEntry?: EntryBackEntry | null;
  };
}) {
  const inline = useInlineForm<HTMLTextAreaElement>();
  const [result, setResult] = useState<ActionResult<unknown> | null>(null);
  const [pending, startTransition] = useTransition();
  const ids = useFieldIds(FIELDS);
  const entry = useEntryId();
  // Asked only once the API has said the paper time is outside the outage (H-208).
  const [askOutside, setAskOutside] = useState(false);

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
    const outside = String(form.get("outsideOutageReason") ?? "").trim();
    if (askOutside && note.backEntry && !outside) {
      setResult(refused(t("care.paper.outsideReasonAgain"), "invalid", ["outsideOutageReason"]));
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
        ...(askOutside && note.backEntry && outside
          ? { downtime: { backEntry: correctionBackEntry(note.backEntry, outside) } }
          : {}),
      });
      if (!outcome.ok && outcome.code === "outside_outage_reason_required") setAskOutside(true);
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
          {askOutside && note.backEntry ? (
            <TextArea
              id={ids.outsideOutageReason}
              name="outsideOutageReason"
              label={t("care.paper.correctOutsideReason")}
              hint={t("care.paper.outsideReasonHint")}
              rows={2}
              required
              maxLength={500}
              formatCount={(remaining) => characterCount(remaining)}
              error={errorFor(result, "outsideOutageReason")}
            />
          ) : null}
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
