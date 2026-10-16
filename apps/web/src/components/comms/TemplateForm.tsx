"use client";

import { Button, RadioGroup, SelectField, TextArea, TextField } from "@harbour/ui";
import { useRouter } from "next/navigation";
import { type FormEvent, useState, useTransition } from "react";
import { createTemplate, editDraft } from "@/app/actions/letters";
import { useFieldIds } from "@/components/care/form-state";
import { ManageFeedback } from "@/components/safety/ManageForms";
import { characterCount, t } from "@/lib/i18n";
import {
  BODY_MAX,
  NAME_MAX,
  readDraft,
  SUBJECT_MAX,
  TEMPLATE_CHANNELS,
  TEMPLATE_KINDS,
  type TemplateChannel,
  type TemplateKind,
} from "@/lib/letters";
import { type ActionResult, errorFor, type FieldErrors, fieldErrors } from "@/lib/outcome";

const FIELDS = ["kind", "channel", "name", "subject", "body"] as const;

type Mode =
  | { readonly kind: "create" }
  | {
      readonly kind: "edit";
      readonly templateId: string;
      readonly versionId: string;
      readonly version: number;
      readonly channel: TemplateChannel;
      readonly words: {
        readonly name: string;
        readonly subject: string | null;
        readonly body: string;
      };
      /** What the API found in the saved draft, at each field (rules 18 to 21). */
      readonly issues: FieldErrors;
    };

/**
 * Writing a template's draft (comms.md rules 18 to 21; HZ-051). The form checks the lengths; the
 * API checks the merge fields and where personal data may go, saves the draft with its problems
 * listed, and the page shows each problem at its field. Approval is a separate step by someone
 * else. Kind and channel are chosen once, when the template is made.
 */
export function TemplateForm({ mode, path }: { readonly mode: Mode; readonly path: string }) {
  const router = useRouter();
  const ids = useFieldIds(FIELDS);
  const [channel, setChannel] = useState<TemplateChannel>(
    mode.kind === "edit" ? mode.channel : "letter",
  );
  const [result, setResult] = useState<ActionResult<unknown> | null>(null);
  const [pending, startTransition] = useTransition();
  const saved = mode.kind === "edit" ? mode.issues : {};
  // A refusal from this attempt wins at its field; otherwise the saved draft's problems show.
  const fieldError = (field: string) => errorFor(result, field) ?? saved[field];

  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    const read = readDraft(form, channel, t);
    if (!read.ok) return setResult(fieldErrors(read.errors));
    const words = { name: read.name, subject: read.subject, body: read.body };
    startTransition(async () => {
      if (mode.kind === "create") {
        const kind = String(form.get("kind") ?? "") as TemplateKind;
        const outcome = await createTemplate({ ...words, kind, channel });
        setResult(outcome);
        if (outcome.ok) router.push(`/letters/${outcome.data.id}?done=drafted&at=${Date.now()}`);
        return;
      }
      const ref = { templateId: mode.templateId, versionId: mode.versionId, version: mode.version };
      const outcome = await editDraft(ref, words);
      setResult(outcome);
      if (outcome.ok) router.replace(`${path}?done=saved&at=${Date.now()}`, { scroll: false });
    });
  };

  return (
    <form className="flex flex-col gap-4" onSubmit={submit} noValidate>
      {mode.kind === "create" ? (
        <>
          <SelectField
            id={ids.kind}
            name="kind"
            label={t("comms.templates.form.kind")}
            required
            defaultValue="general"
            options={TEMPLATE_KINDS.map((kind) => ({
              value: kind,
              label: t("comms.templates.kind", { kind }),
            }))}
          />
          <RadioGroup<TemplateChannel>
            id={ids.channel}
            name="channel"
            legend={t("comms.templates.form.channel")}
            hint={t("comms.templates.form.channelHint")}
            value={channel}
            onValueChange={setChannel}
            layout="inline"
            error={fieldError("channel")}
            options={TEMPLATE_CHANNELS.map((value) => ({
              value,
              label: t("comms.templates.channel", { channel: value }),
            }))}
          />
        </>
      ) : null}
      <TextField
        id={ids.name}
        name="name"
        label={t("comms.templates.form.name")}
        required
        maxLength={NAME_MAX}
        defaultValue={mode.kind === "edit" ? mode.words.name : ""}
        error={fieldError("name")}
      />
      {channel === "email" ? (
        <TextField
          id={ids.subject}
          name="subject"
          label={t("comms.templates.form.subject")}
          hint={t("comms.templates.form.subjectHint")}
          required
          maxLength={SUBJECT_MAX}
          defaultValue={mode.kind === "edit" ? (mode.words.subject ?? "") : ""}
          error={fieldError("subject")}
        />
      ) : null}
      <TextArea
        id={ids.body}
        name="body"
        label={t("comms.templates.form.body")}
        hint={t("comms.templates.form.bodyHint")}
        rows={12}
        required
        maxLength={BODY_MAX}
        formatCount={(remaining) => characterCount(remaining)}
        defaultValue={mode.kind === "edit" ? mode.words.body : ""}
        error={fieldError("body")}
      />
      <div>
        <Button type="submit" disabled={pending}>
          {pending
            ? t("common.saving")
            : t(
                mode.kind === "create"
                  ? "comms.templates.form.create"
                  : "comms.templates.form.save",
              )}
        </Button>
      </div>
      <ManageFeedback result={result} path={path} fieldIds={ids} />
    </form>
  );
}
