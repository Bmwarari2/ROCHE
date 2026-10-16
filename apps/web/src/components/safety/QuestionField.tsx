"use client";

import { Checkbox, RadioGroup, TextField } from "@harbour/ui";
import type { ReactNode } from "react";
import { t } from "@/lib/i18n";
import { type QuestionItem, questionField, questionWords } from "@/lib/incident-forms";

const unsure = () => ({
  value: "unsure",
  label: t("safety.questions.answer", { answer: "unsure" }),
});

/**
 * One of the classifier's questions (safety.md section 4), in the catalogue's words: yes, no or
 * not sure; a whole number of days or hours, or not sure; one option; or several. "Not sure yet"
 * is always an answer, never assumed. A question the catalogue does not know is shown in the
 * API's English, marked as English. `id` goes on the first control, for the error summary.
 */
export function QuestionField({
  question,
  id,
  error,
}: {
  readonly question: QuestionItem;
  readonly id: string;
  readonly error?: string | undefined;
}) {
  const words = questionWords(question, t);
  const name = questionField(question.key);
  const legend = words.text.text;
  const hint = words.help?.text;
  const errorProps = error ? { error } : {};
  const hintProps = hint ? { hint } : {};
  let field: ReactNode;
  switch (question.kind) {
    case "yes_no_unsure":
      field = (
        <RadioGroup
          legend={legend}
          name={name}
          id={id}
          layout="inline"
          options={(["yes", "no", "unsure"] as const).map((answer) => ({
            value: answer,
            label: t("safety.questions.answer", { answer }),
          }))}
          {...hintProps}
          {...errorProps}
        />
      );
      break;
    case "choice":
      field = (
        <RadioGroup
          legend={legend}
          name={name}
          id={id}
          options={[...words.options.map((o) => ({ value: o.value, label: o.text })), unsure()]}
          {...hintProps}
          {...errorProps}
        />
      );
      break;
    case "days":
    case "hours":
      field = (
        <fieldset className="m-0 flex flex-col gap-2 border-0 p-0">
          <legend className="mb-1 p-0 font-semibold">{legend}</legend>
          {hint ? <p className="hb-field__hint m-0">{hint}</p> : null}
          <TextField
            id={id}
            name={name}
            label={t("safety.questions.number", { kind: question.kind })}
            inputMode="numeric"
            autoComplete="off"
            maxLength={6}
            className="max-w-xs"
            {...errorProps}
          />
          <Checkbox name={`${name}-unsure`} value="unsure" label={t("safety.questions.notSure")} />
        </fieldset>
      );
      break;
    case "choices": {
      const errorId = `${id}-error`;
      field = (
        <fieldset
          className="m-0 flex flex-col gap-1 border-0 p-0"
          aria-describedby={error ? errorId : undefined}
        >
          <legend className="mb-1 p-0 font-semibold">{legend}</legend>
          {hint ? <p className="hb-field__hint m-0">{hint}</p> : null}
          {error ? (
            <p id={errorId} className="hb-field__error m-0">
              {error}
            </p>
          ) : null}
          {[...words.options.map((o) => ({ value: o.value, label: o.text })), unsure()].map(
            (option, index) => (
              <Checkbox
                key={option.value}
                {...(index === 0 ? { id } : {})}
                name={name}
                value={option.value}
                label={option.label}
                aria-invalid={error ? true : undefined}
              />
            ),
          )}
        </fieldset>
      );
      break;
    }
  }
  // The API's English, when the catalogue does not know the question.
  return <div lang={words.text.lang ?? undefined}>{field}</div>;
}
