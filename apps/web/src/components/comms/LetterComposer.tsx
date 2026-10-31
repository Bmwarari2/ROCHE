"use client";

import type { LetterPreview } from "@harbour/contracts";
import { Button, Checkbox, DateInput, SelectField, TextField } from "@harbour/ui";
import { Eye, Send } from "lucide-react";
import { useRouter } from "next/navigation";
import { type FormEvent, useEffect, useRef, useState, useTransition } from "react";
import { type LetterInput, previewLetter, sendLetter } from "@/app/actions/letters";
import { useFieldIds } from "@/components/care/form-state";
import { PersonAvatar } from "@/components/people/PersonAvatar";
import { SampleBadge } from "@/components/people/SampleBadge";
import { ManageFeedback } from "@/components/safety/ManageForms";
import { t } from "@/lib/i18n";
import { penceFrom, type TypedField } from "@/lib/letters";
import {
  type ActionResult,
  collectedRefusal,
  errorFor,
  type FieldProblem,
  partsFor,
} from "@/lib/outcome";
import { dateBoxesOf, readDateField } from "@/lib/uk-time";

export interface ComposerTemplate {
  readonly id: string;
  readonly name: string;
  readonly kind: string;
  readonly typed: readonly TypedField[];
}

const dateLabels = {
  day: t("care.date.day"),
  month: t("care.date.month"),
  year: t("care.date.year"),
};

const fieldName = (key: string) => key.replaceAll(".", "_");

/**
 * Making a posted letter from an approved template (comms.md rules 24 and 25; HZ-051, HZ-001).
 * The sender chooses the template, types only the admission or fee details it asks for, and
 * previews it: the preview shows who the letter is about (name, room, photo), the recipient, the
 * words and the personal details used. Sending repeats the preview's version and text hash; if
 * anything changed meanwhile the API refuses it and the new preview is shown to check again.
 */
export function LetterComposer({
  personId,
  path,
  templates,
  incidents,
}: {
  readonly personId: string;
  readonly path: string;
  readonly templates: readonly ComposerTemplate[];
  /** The person's incidents, for an incident follow-up letter; null when not offered. */
  readonly incidents: readonly { readonly id: string; readonly label: string }[] | null;
}) {
  const router = useRouter();
  const [templateId, setTemplateId] = useState(templates[0]?.id ?? "");
  const template = templates.find((item) => item.id === templateId);
  const keys = ["template", "incident", ...(template?.typed.map((f) => fieldName(f.key)) ?? [])];
  const ids = useFieldIds([...keys, "confirm"]);
  const [input, setInput] = useState<LetterInput | null>(null);
  const [preview, setPreview] = useState<LetterPreview | null>(null);
  const [changed, setChanged] = useState(false);
  const [result, setResult] = useState<ActionResult<unknown> | null>(null);
  const [pending, startTransition] = useTransition();
  const previewHeading = useRef<HTMLHeadingElement>(null);

  // A new preview takes focus at its heading, so the person checks it before sending.
  useEffect(() => {
    if (preview) previewHeading.current?.focus();
  }, [preview]);

  const readInput = (form: FormData): LetterInput | null => {
    if (!template) return null;
    const problems: FieldProblem[] = [];
    const values: Record<string, string | number> = {};
    for (const field of template.typed) {
      const name = fieldName(field.key);
      const subject = t("comms.letters.typed", { field: name });
      if (field.type === "money") {
        const pence = penceFrom(String(form.get(name) ?? ""));
        if (pence === null)
          problems.push({ field: name, message: t("comms.letters.moneyError", { subject }) });
        else values[field.key] = pence;
      } else {
        const date = readDateField(form, name, { subject, t });
        if (!date.ok) problems.push({ field: name, message: date.message, parts: date.parts });
        else if (date.date) values[field.key] = date.date;
      }
    }
    const incidentId = String(form.get("incident") ?? "");
    if (template.kind === "incident_follow_up" && !incidentId) {
      problems.push({ field: "incident", message: t("comms.letters.incidentRequired") });
    }
    const refusal = collectedRefusal(problems);
    if (refusal) {
      setResult(refusal);
      return null;
    }
    return {
      templateId: template.id,
      ...(incidentId ? { incidentId } : {}),
      ...(Object.keys(values).length > 0 ? { values } : {}),
    };
  };

  const onPreview = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const read = readInput(new FormData(event.currentTarget));
    if (!read) return;
    startTransition(async () => {
      const outcome = await previewLetter(personId, read);
      setResult(outcome.ok ? null : outcome);
      setChanged(false);
      setInput(outcome.ok ? read : null);
      setPreview(outcome.ok ? outcome.data : null);
    });
  };

  const onSend = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!input || !preview) return;
    if (new FormData(event.currentTarget).get("confirm") !== "yes") {
      setResult(collectedRefusal([{ field: "confirm", message: t("comms.letters.confirmError") }]));
      return;
    }
    startTransition(async () => {
      const outcome = await sendLetter(personId, {
        ...input,
        templateVersionId: preview.templateVersionId,
        textHash: preview.textHash,
      });
      if (outcome.ok) {
        router.replace(`${path}?done=sent&at=${Date.now()}`, { scroll: false });
        return;
      }
      if (outcome.code === "letter_changed") {
        // Show what would be sent now; nothing goes until it is checked and confirmed again.
        const again = await previewLetter(personId, input);
        setResult(again.ok ? null : again);
        setPreview(again.ok ? again.data : null);
        setChanged(again.ok);
        return;
      }
      setResult(outcome);
    });
  };

  if (templates.length === 0) return <p className="m-0">{t("comms.letters.noTemplates")}</p>;

  return (
    <div className="flex flex-col gap-6">
      <form method="post" className="flex flex-col gap-4" onSubmit={onPreview} noValidate>
        <SelectField
          id={ids.template}
          name="template"
          label={t("comms.letters.template")}
          value={templateId}
          onChange={(event) => {
            setTemplateId(event.target.value);
            setPreview(null);
            setResult(null);
          }}
          options={templates.map((item) => ({ value: item.id, label: item.name }))}
        />
        <p className="m-0 text-body-dense text-text-secondary">{t("comms.letters.recipient")}</p>
        {template?.kind === "incident_follow_up" && incidents ? (
          <SelectField
            id={ids.incident}
            name="incident"
            label={t("comms.letters.incident")}
            emptyOption={t("comms.letters.incidentChoose")}
            required
            error={errorFor(result, "incident")}
            options={incidents.map((item) => ({ value: item.id, label: item.label }))}
          />
        ) : null}
        {template?.typed.map((field) => {
          const name = fieldName(field.key);
          const label = t("comms.letters.typed", { field: name });
          return field.type === "money" ? (
            <TextField
              key={name}
              id={ids[name]}
              name={name}
              label={label}
              hint={t("comms.letters.moneyHint")}
              inputMode="decimal"
              error={errorFor(result, name)}
            />
          ) : (
            <DateInput
              key={name}
              id={ids[name]}
              name={name}
              legend={label}
              hint={t("care.date.hint")}
              labels={dateLabels}
              error={errorFor(result, name)}
              errorParts={dateBoxesOf(partsFor(result, name))}
            />
          );
        })}
        <div>
          <Button
            type="submit"
            variant={preview ? "secondary" : "primary"}
            icon={<Eye size={20} strokeWidth={1.5} aria-hidden="true" />}
            disabled={pending}
          >
            {t("comms.letters.preview")}
          </Button>
        </div>
        {preview ? null : <ManageFeedback result={result} path={path} fieldIds={ids} />}
      </form>

      {preview ? (
        <section aria-labelledby="letter-preview" className="flex flex-col gap-4">
          <h3
            id="letter-preview"
            ref={previewHeading}
            tabIndex={-1}
            className="m-0 text-body font-semibold"
          >
            {t("comms.letters.previewTitle")}
          </h3>
          {changed ? (
            <p
              role="alert"
              className="m-0 rounded-input border-s-4 border-warning bg-bg-secondary p-4"
            >
              {t("comms.letters.changed")}
            </p>
          ) : null}
          <div className="flex items-center gap-4">
            <PersonAvatar
              personId={preview.person.id}
              initials={initialsOf(preview.person.fullName)}
              hasPhoto={preview.person.photoUrl !== null}
              alt=""
              size="large"
            />
            <dl className="m-0 grid grid-cols-1 gap-1">
              <div>
                <dt className="inline font-semibold">{t("comms.letters.about")}: </dt>
                <dd className="m-0 inline">
                  {preview.person.fullName} <SampleBadge sample={preview.person.sample} />
                </dd>
              </div>
              {preview.person.roomLabel ? (
                <div>
                  <dt className="inline font-semibold">{t("comms.letters.room")}: </dt>
                  <dd className="m-0 inline">{preview.person.roomLabel}</dd>
                </div>
              ) : null}
              <div>
                <dt className="inline font-semibold">{t("comms.letters.to")}: </dt>
                <dd className="m-0 inline">{preview.recipientName}</dd>
              </div>
            </dl>
          </div>
          {preview.subject ? (
            <p className="m-0">
              <span className="font-semibold">{t("comms.templates.form.subject")}: </span>
              {preview.subject}
            </p>
          ) : null}
          <pre className="m-0 max-w-prose whitespace-pre-wrap break-words rounded-input border border-border p-4 font-sans">
            {preview.text}
          </pre>
          <p className="m-0 text-body-dense">
            {preview.personalDataFields.length > 0
              ? t("comms.templates.personalFields", {
                  fields: preview.personalDataFields.join(", "),
                })
              : t("comms.letters.noPersonal")}
            {preview.containsSpecialCategory ? ` ${t("comms.letters.specialCategory")}` : ""}
          </p>
          {/* A new preview (new version or new words) is a new form: the tick is never carried over. */}
          <form
            method="post"
            key={`${preview.templateVersionId}:${preview.textHash}`}
            className="flex flex-col gap-4"
            onSubmit={onSend}
            noValidate
          >
            <Checkbox
              id={ids.confirm}
              name="confirm"
              value="yes"
              label={t("comms.letters.confirm")}
              required
              error={errorFor(result, "confirm")}
            />
            <div>
              <Button
                type="submit"
                icon={<Send size={20} strokeWidth={1.5} aria-hidden="true" />}
                disabled={pending}
              >
                {t("comms.letters.send", { channel: preview.channel })}
              </Button>
            </div>
            <ManageFeedback result={result} path={path} fieldIds={ids} />
          </form>
        </section>
      ) : null}
    </div>
  );
}

function initialsOf(name: string): string {
  return name
    .split(" ")
    .filter(Boolean)
    .map((part) => part[0]?.toUpperCase() ?? "")
    .slice(0, 2)
    .join("");
}
