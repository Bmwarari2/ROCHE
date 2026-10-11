"use client";

import type { CreateCareNote } from "@harbour/contracts";
import { Button, SelectField, TextArea } from "@harbour/ui";
import { type FormEvent, useState, useTransition } from "react";
import { recordNote } from "@/app/actions/care-record";
import { NOTE_CATEGORIES, NOTE_MAX_LENGTH } from "@/lib/care-record";
import { characterCount, t } from "@/lib/i18n";
import { type ActionResult, errorFor, partsFor, partsRefusal, refused } from "@/lib/outcome";
import { readWhen } from "@/lib/uk-time";
import { FormFeedback } from "./FormFeedback";
import { useEntryId, useFieldIds } from "./form-state";
import { WhenField } from "./WhenField";

const FIELDS = ["category", "body", "occurredAt"] as const;

/** Write a daily note (append-only, care.md rule 4). */
export function NoteForm({ personId }: { readonly personId: string }) {
  const [result, setResult] = useState<ActionResult<unknown> | null>(null);
  const [round, setRound] = useState(0);
  const [pending, startTransition] = useTransition();
  const ids = useFieldIds(FIELDS);
  const entry = useEntryId();

  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    const body = String(form.get("body") ?? "");
    if (!body.trim()) {
      setResult(refused(t("care.notes.bodyRequired"), "invalid", ["body"]));
      return;
    }
    const when = readWhen(form, "occurredAt", t);
    if (!when.ok) {
      setResult(partsRefusal("occurredAt", when));
      return;
    }
    startTransition(async () => {
      const outcome = await recordNote(personId, {
        id: entry.id,
        category: String(form.get("category")) as CreateCareNote["category"],
        body,
        occurredAt: when.instant,
        sentAt: new Date().toISOString(),
      });
      setResult(outcome);
      // A fresh form for the next note, with the time back to "now" and a new id. After an
      // unknown outcome the id stays, so trying again cannot save the note twice.
      if (outcome.ok) {
        setRound((n) => n + 1);
        entry.next();
      }
    });
  };

  return (
    <div className="flex flex-col gap-4">
      <form key={round} className="flex flex-col gap-4" onSubmit={submit} noValidate>
        <SelectField
          id={ids.category}
          name="category"
          label={t("care.notes.form.category")}
          defaultValue="personal_care"
          options={NOTE_CATEGORIES.map((category) => ({
            value: category,
            label: t("care.notes.category", { category }),
          }))}
          className="max-w-sm"
        />
        <TextArea
          id={ids.body}
          name="body"
          label={t("care.notes.form.body")}
          hint={t("care.notes.form.bodyHint")}
          rows={5}
          required
          maxLength={NOTE_MAX_LENGTH}
          formatCount={(remaining) => characterCount(remaining)}
          error={errorFor(result, "body")}
        />
        <WhenField
          id={ids.occurredAt}
          error={errorFor(result, "occurredAt")}
          errorParts={partsFor(result, "occurredAt")}
        />
        <div>
          <Button type="submit" disabled={pending}>
            {pending ? t("common.saving") : t("care.notes.form.submit")}
          </Button>
        </div>
      </form>
      <FormFeedback result={result} success={t("care.notes.saved")} fieldIds={ids} />
    </div>
  );
}
