"use client";

import type { CreateCareNote } from "@harbour/contracts";
import { Button, SelectField, TextArea } from "@harbour/ui";
import { type FormEvent, useState, useTransition } from "react";
import { recordNote } from "@/app/actions/care-record";
import { NOTE_CATEGORIES, NOTE_MAX_LENGTH } from "@/lib/care-record";
import { characterCount, t } from "@/lib/i18n";
import type { ActionResult } from "@/lib/outcome";
import { FormFeedback } from "./FormFeedback";
import { WhenField } from "./WhenField";

/** Write a daily note (append-only, care.md rule 4). */
export function NoteForm({
  personId,
  nowLocal,
}: {
  readonly personId: string;
  /** Now in UK time, for the "when" field. */
  readonly nowLocal: string;
}) {
  const [result, setResult] = useState<ActionResult<unknown> | null>(null);
  const [round, setRound] = useState(0);
  const [pending, startTransition] = useTransition();

  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    startTransition(async () => {
      const outcome = await recordNote(personId, {
        category: String(form.get("category")) as CreateCareNote["category"],
        body: String(form.get("body") ?? ""),
        occurredAtLocal: String(form.get("occurredAt") ?? ""),
      });
      setResult(outcome);
      // A fresh form for the next note, with the time moved on to now.
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
        <WhenField defaultValue={nowLocal} />
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
