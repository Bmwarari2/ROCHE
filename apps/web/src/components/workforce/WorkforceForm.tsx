"use client";

import type { MessageKey } from "@harbour/i18n";
import { Button, Checkbox, DateInput, SelectField, TextArea, TextField } from "@harbour/ui";
import { useRouter } from "next/navigation";
import { type FormEvent, useId, useState, useTransition } from "react";
import { FormFeedback } from "@/components/care/FormFeedback";
import { StepUpNotice } from "@/components/safety/ManageForms";
import { characterCount, t } from "@/lib/i18n";
import { type ActionResult, errorFor, fieldErrors } from "@/lib/outcome";
import { readDateField } from "@/lib/uk-time";
import type { WorkforceField, WorkforceValues } from "@/lib/workforce";

/**
 * One workforce form (plan slice 58): the fields it is given, checked in the browser for what is
 * required, then sent to its server action, which the API checks again. On success the page is
 * opened again at `?done=<key>` and WorkforceArrival says what was done, with focus on the page's
 * heading (the house pattern, as useManageSend). The form is cleared, so an append-only entry is
 * not sent twice by mistake. A refusal is said in words, each at its field; a step that needs
 * step-up or a verified second factor asks for it, in the step's own words, with the way back.
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
  stepUp,
}: {
  readonly title: string;
  readonly intro?: string;
  readonly fields: readonly WorkforceField[];
  readonly submit: string;
  /** The catalogue key of what was done, said when the page opens again. */
  readonly done: MessageKey;
  readonly path: string;
  readonly action: (values: WorkforceValues) => Promise<ActionResult<unknown>>;
  readonly destructive?: boolean;
  readonly headingLevel?: 2 | 3 | 4;
  /** The step-up notice's words for this step, when it needs step-up. */
  readonly stepUp?: string;
}) {
  const router = useRouter();
  const base = useId();
  // Field ids carry their own prefix, so a field named "title" never shares the heading's id.
  const ids = Object.fromEntries(fields.map((f) => [f.name, `${base}-field-${f.name}`]));
  const titleId = `${base}-heading`;
  const [result, setResult] = useState<ActionResult<unknown> | null>(null);
  const [pending, startTransition] = useTransition();
  const Heading = `h${headingLevel}` as const;

  const onSubmit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    // Kept before the await: the event's currentTarget is null once the handler has returned.
    const form = event.currentTarget;
    if (pending) return;
    const data = new FormData(form);
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
        errors[field.name] =
          field.requiredMessage ??
          t(field.kind === "select" ? "workforce.form.chooseRequired" : "workforce.form.required", {
            field: field.label,
          });
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
      form.reset();
      // `at` makes each save a new arrival, so a second identical save is said and focused again.
      router.replace(`${path}?done=${encodeURIComponent(done)}&at=${Date.now()}`);
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
                  {...(field.type ? { type: field.type } : {})}
                  {...(field.autoComplete ? { autoComplete: field.autoComplete } : {})}
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
                  {...(field.defaultValue ? { defaultValue: field.defaultValue } : {})}
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
            aria-disabled={pending}
          >
            {pending ? t("common.saving") : submit}
          </Button>
        </div>
      </form>
      {result && !result.ok ? (
        result.code === "step_up_required" || result.code === "mfa_verification_required" ? (
          <StepUpNotice next={path} refusal={result} body={stepUp ?? t("workforce.form.stepUp")} />
        ) : (
          <FormFeedback result={result} success="" fieldIds={ids} />
        )
      ) : null}
    </div>
  );
}
