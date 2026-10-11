"use client";

import type { CreateCareNote } from "@harbour/contracts";
import { Button, SelectField, TextArea } from "@harbour/ui";
import { type FormEvent, useState, useTransition } from "react";
import { recordNote } from "@/app/actions/care-record";
import { NOTE_CATEGORIES, NOTE_MAX_LENGTH } from "@/lib/care-record";
import { characterCount, t } from "@/lib/i18n";
import { type ActionResult, refused } from "@/lib/outcome";
import { readWhen } from "@/lib/uk-time";
import { FormFeedback } from "./FormFeedback";
import { WhenField } from "./WhenField";

/** Write a daily note (append-only, care.md rule 4). */
export function NoteForm({ personId }: { readonly personId: string }) {
  const [result, setResult] = useState<ActionResult<unknown> | null>(null);
  const [round, setRound] = useState(0);
  const [pending, startTransition] = useTransition();

  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    const when = readWhen(form, "occurredAt", t);
    if (!when.ok) {
      setResult(refused(when.message));
      return;
    }
    startTransition(async () => {
      const outcome = await recordNote(personId, {
        category: String(form.get("category")) as CreateCareNote["category"],
        body: String(form.get("body") ?? ""),
        occurredAt: when.instant,
        sentAt: new Date().toISOString(),
      });
      setResult(outcome);
      // A fresh form for the next note, with the time back to "now".
      if (outcome.ok) setRound((n) => n + 1);
    });
  };

  return (
    <div className="flex flex-col gap-4">
      <form key={round} className="flex flex-col gap-4" onSubmit={submit} noValidate>
        <SelectField
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
          name="body"
          label={t("care.notes.form.body")}
          hint={t("care.notes.form.bodyHint")}
          rows={5}
          required
          maxLength={NOTE_MAX_LENGTH}
          formatCount={(remaining) => characterCount(remaining)}
        />
        <WhenField />
        <div>
          <Button type="submit" disabled={pending}>
            {pending ? t("common.saving") : t("care.notes.form.submit")}
          </Button>
        </div>
      </form>
      <FormFeedback result={result} success={t("care.notes.saved")} />
    </div>
  );
}
