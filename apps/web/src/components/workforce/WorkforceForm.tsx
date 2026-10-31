"use client";

import { Button, Checkbox, DateInput, SelectField, TextArea, TextField } from "@harbour/ui";
import { useRouter } from "next/navigation";
import { type FormEvent, useId, useState, useTransition } from "react";
import { ManageFeedback } from "@/components/safety/ManageForms";
import { characterCount, t } from "@/lib/i18n";
import { type ActionResult, errorFor, fieldErrors } from "@/lib/outcome";
import { readDateField } from "@/lib/uk-time";
import type { WorkforceField, WorkforceValues } from "@/lib/workforce";

/**
 * One workforce form (plan slice 58): the fields it is given, checked in the browser for what is
 * required, then sent to its server action, which the API checks again. On success the page is
 * read again and a message says what was done; a refusal is said in words, each at its field, and
 * a step that needs step-up asks for the passkey or authenticator code with the way back.
 */
export function WorkforceForm({
  title,
  intro,
  fields,
  submit,
  done,
  path,
  action,
  destructive = false,
  headingLevel = 3,
}: {
  readonly title: string;
  readonly intro?: string;
  readonly fields: readonly WorkforceField[];
  readonly submit: string;
  readonly done: string;
  readonly path: string;
  readonly action: (values: WorkforceValues) => Promise<ActionResult<unknown>>;
  readonly destructive?: boolean;
  readonly headingLevel?: 2 | 3 | 4;
}) {
  const router = useRouter();
  const base = useId();
  const ids = Object.fromEntries(fields.map((f) => [f.name, `${base}-${f.name}`]));
  const titleId = `${base}-title`;
  const [result, setResult] = useState<ActionResult<unknown> | null>(null);
  const [sent, setSent] = useState(false);
  const [pending, startTransition] = useTransition();
  const Heading = `h${headingLevel}` as const;

  const onSubmit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setSent(false);
    const data = new FormData(event.currentTarget);
    const values: Record<string, string | boolean | null> = {};
    const errors: Record<string, string> = {};
    const parts: Record<string, readonly string[]> = {};
    for (const field of fields) {
      if (field.kind === "checkbox") {
        values[field.name] = data.get(field.name) === "yes";
        if (field.required && values[field.name] !== true) {
          errors[field.name] = t("workforce.form.confirmRequired");
        }
        continue;
      }
      if (field.kind === "date") {
        const read = readDateField(data, field.name, {
          subject: field.label,
          optional: !field.required,
          t,
        });
        if (read.ok) values[field.name] = read.date;
        else {
          errors[field.name] = read.message;
          parts[field.name] = read.parts;
        }
        continue;
      }
      const raw = data.get(field.name);
      const text = typeof raw === "string" ? raw.trim() : "";
      values[field.name] = text === "" ? null : text;
      if (field.required && text === "") {
        errors[field.name] = t("workforce.form.required", { field: field.label });
      }
    }
    if (Object.keys(errors).length > 0) {
      const failed = fieldErrors(errors);
      setResult(failed.ok ? failed : { ...failed, parts });
      return;
    }
    startTransition(async () => {
      const outcome = await action(values);
      setResult(outcome);
      if (!outcome.ok) return;
      setSent(true);
      event.currentTarget?.reset?.();
      router.refresh();
    });
  };

  return (
    <div className="flex flex-col gap-4">
      <form
        method="post"
        className="flex flex-col gap-4"
        onSubmit={onSubmit}
        noValidate
        aria-labelledby={titleId}
      >
        <div className="flex flex-col gap-1">
          <Heading id={titleId} className="m-0 text-body font-semibold">
            {title}
          </Heading>
          {intro ? (
            <p className="m-0 max-w-prose text-body-dense text-text-secondary">{intro}</p>
          ) : null}
        </div>
        {fields.map((field) => {
          const id = ids[field.name] ?? field.name;
          const error = errorFor(result, field.name);
          const errorProps = error ? { error } : {};
          const hintProps = field.hint ? { hint: field.hint } : {};
          switch (field.kind) {
            case "text":
              return (
                <TextField
                  key={field.name}
                  id={id}
                  name={field.name}
                  label={field.label}
                  required={field.required}
                  maxLength={field.maxLength}
                  {...(field.inputMode ? { inputMode: field.inputMode } : {})}
                  {...hintProps}
                  {...errorProps}
                />
              );
            case "textarea":
              return (
                <TextArea
                  key={field.name}
                  id={id}
                  name={field.name}
                  label={field.label}
                  rows={4}
                  required={field.required}
                  maxLength={field.maxLength}
                  formatCount={(remaining) => characterCount(remaining)}
                  {...hintProps}
                  {...errorProps}
                />
              );
            case "select":
              return (
                <SelectField
                  key={field.name}
                  id={id}
                  name={field.name}
                  label={field.label}
                  required={field.required}
                  options={field.options}
                  emptyOption={field.emptyOption}
                  {...hintProps}
                  {...errorProps}
                />
              );
            case "date":
              return (
                <DateInput
                  key={field.name}
                  id={id}
                  name={field.name}
                  legend={field.label}
                  hint={field.hint ?? t("workforce.form.dateHint")}
                  {...(field.defaultValue ? { defaultValue: field.defaultValue } : {})}
                  {...errorProps}
                  {...(result && !result.ok && result.parts?.[field.name]
                    ? { errorParts: result.parts[field.name] as never }
                    : {})}
                />
              );
            case "checkbox":
              return (
                <Checkbox
                  key={field.name}
                  id={id}
                  name={field.name}
                  value="yes"
                  label={field.label}
                  required={field.required}
                  {...hintProps}
                  {...errorProps}
                />
              );
            default:
              return null;
          }
        })}
        <div>
          <Button
            type="submit"
            variant={destructive ? "destructive" : "primary"}
            disabled={pending}
            aria-disabled={pending}
          >
            {pending ? t("common.saving") : submit}
          </Button>
        </div>
      </form>
      {sent && result?.ok ? (
        <p role="status" className="m-0 text-body-dense">
          {done}
        </p>
      ) : null}
      <ManageFeedback result={result} path={path} fieldIds={ids} />
    </div>
  );
}
