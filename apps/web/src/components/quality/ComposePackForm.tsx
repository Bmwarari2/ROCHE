"use client";

import { Button, Checkbox, DateInput, RadioGroup, TextArea, TextField } from "@harbour/ui";
import { type FormEvent, useState } from "react";
import { composeEvidencePack } from "@/app/actions/quality";
import { useFieldIds } from "@/components/care/form-state";
import {
  EMAIL_MAX,
  KEY_QUESTIONS,
  keyQuestionLabel,
  NAME_MAX,
  PURPOSE_MAX,
  readComposeForm,
} from "@/lib/evidence-packs";
import { characterCount, t } from "@/lib/i18n";
import { collectedRefusal, errorFor, partsFor } from "@/lib/outcome";
import { dateBoxesOf } from "@/lib/uk-time";
import { QualityFeedback, useQualitySend } from "./QualityForms";

const FIELDS = [
  "recipientName",
  "recipientOrganisation",
  "recipientEmail",
  "purpose",
  "from",
  "to",
  "locationIds",
  "personIds",
  "staffNames",
  "statements",
  "statementIds",
] as const;

const PATH = "/quality/evidence-packs/new";

const dateLabels = {
  day: t("care.date.day"),
  month: t("care.date.month"),
  year: t("care.date.year"),
};

interface Option {
  readonly id: string;
  readonly label: string;
  readonly hint?: string;
}

/** A group of tick boxes with one legend, hint and error (WCAG 1.3.1 and 3.3.1). */
export function TickGroup({
  id,
  name,
  legend,
  hint,
  options,
  error,
  defaultChecked = [],
}: {
  readonly id: string;
  readonly name: string;
  readonly legend: string;
  readonly hint: string;
  readonly options: readonly Option[];
  readonly error?: string | undefined;
  readonly defaultChecked?: readonly string[];
}) {
  const hintId = `${id}-hint`;
  const errorId = `${id}-error`;
  // The first box takes the group's id, so the error summary can move focus to it.
  const optionId = (value: string) =>
    value === options[0]?.id ? id : `${id}-${value.replace(/[^A-Za-z0-9_-]/g, "_")}`;
  return (
    <fieldset
      className="m-0 flex flex-col gap-1 border-0 p-0"
      aria-describedby={error ? `${hintId} ${errorId}` : hintId}
    >
      <legend className="mb-1 p-0 font-semibold">{legend}</legend>
      <p id={hintId} className="hb-field__hint m-0">
        {hint}
      </p>
      {error ? (
        <p id={errorId} className="hb-field__error m-0">
          {error}
        </p>
      ) : null}
      {options.map((option) => (
        <Checkbox
          key={option.id}
          id={optionId(option.id)}
          name={name}
          value={option.id}
          label={option.label}
          {...(option.hint ? { hint: option.hint } : {})}
          defaultChecked={defaultChecked.includes(option.id)}
          aria-invalid={error ? true : undefined}
          // Checkbox's own description (the option's hint) must survive the group's error.
          aria-describedby={
            [option.hint ? `${optionId(option.id)}-hint` : "", error ? errorId : ""]
              .join(" ")
              .trim() || undefined
          }
        />
      ))}
    </fieldset>
  );
}

/**
 * Compose a draft evidence pack (`quality.evidence_pack.compose`; quality.md rule 1; HZ-050): who
 * it is for, why, the dates, the locations and the people in scope, chosen one by one (there is no
 * "everyone"), and whether staff are named. Every problem is listed at once; the API checks again.
 */
export function ComposePackForm({
  locations,
  people,
  defaultLocationIds,
}: {
  readonly locations: readonly Option[];
  readonly people: readonly Option[];
  readonly defaultLocationIds: readonly string[];
}) {
  const ids = useFieldIds(FIELDS);
  const { result, pending, send, setResult } = useQualitySend(PATH);
  const [some, setSome] = useState(false);

  const onSubmit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const read = readComposeForm(new FormData(event.currentTarget), t);
    if (!read.ok) {
      setResult(collectedRefusal(read.problems));
      return;
    }
    send(
      (pack) => `/quality/evidence-packs/${pack.id}?done=composed&at=${Date.now()}`,
      () => composeEvidencePack(read.body),
    );
  };
  const error = (field: (typeof FIELDS)[number]) => errorFor(result, field);

  return (
    <div className="flex flex-col gap-6">
      <form
        className="flex flex-col gap-6"
        onSubmit={onSubmit}
        noValidate
        aria-labelledby="compose-title"
      >
        <h2 id="compose-title" className="m-0 text-heading-3 font-semibold">
          {t("quality.compose.formTitle")}
        </h2>
        <fieldset className="m-0 flex flex-col gap-4 border-0 p-0">
          <legend className="mb-2 text-body font-semibold">{t("quality.compose.recipient")}</legend>
          <TextField
            id={ids.recipientName}
            name="recipientName"
            label={t("quality.compose.recipientName")}
            hint={t("quality.compose.recipientNameHint")}
            required
            maxLength={NAME_MAX}
            autoComplete="off"
            {...(error("recipientName") ? { error: error("recipientName") } : {})}
          />
          <TextField
            id={ids.recipientOrganisation}
            name="recipientOrganisation"
            label={t("quality.compose.organisation")}
            hint={t("quality.compose.organisationHint")}
            required
            maxLength={NAME_MAX}
            autoComplete="off"
            {...(error("recipientOrganisation") ? { error: error("recipientOrganisation") } : {})}
          />
          <TextField
            id={ids.recipientEmail}
            name="recipientEmail"
            type="email"
            label={t("quality.compose.email")}
            hint={t("quality.compose.emailHint")}
            required
            maxLength={EMAIL_MAX}
            autoComplete="off"
            spellCheck={false}
            {...(error("recipientEmail") ? { error: error("recipientEmail") } : {})}
          />
        </fieldset>
        <TextArea
          id={ids.purpose}
          name="purpose"
          label={t("quality.compose.purpose")}
          hint={t("quality.compose.purposeHint")}
          rows={3}
          required
          maxLength={PURPOSE_MAX}
          formatCount={(remaining) => characterCount(remaining)}
          {...(error("purpose") ? { error: error("purpose") } : {})}
        />
        <div className="flex flex-col gap-4">
          <DateInput
            id={ids.from}
            name="from"
            legend={t("quality.compose.from")}
            hint={t("care.date.hint")}
            labels={dateLabels}
            error={error("from")}
            errorParts={dateBoxesOf(partsFor(result, "from"))}
          />
          <DateInput
            id={ids.to}
            name="to"
            legend={t("quality.compose.to")}
            hint={t("quality.compose.toHint")}
            labels={dateLabels}
            error={error("to")}
            errorParts={dateBoxesOf(partsFor(result, "to"))}
          />
        </div>
        <TickGroup
          id={ids.locationIds}
          name="locationIds"
          legend={t("quality.compose.locations")}
          hint={t("quality.compose.locationsHint")}
          options={locations}
          defaultChecked={defaultLocationIds}
          error={error("locationIds")}
        />
        <TickGroup
          id={ids.personIds}
          name="personIds"
          legend={t("quality.compose.people")}
          hint={t("quality.compose.peopleHint")}
          options={people}
          error={error("personIds")}
        />
        <RadioGroup
          id={ids.staffNames}
          name="staffNames"
          legend={t("quality.compose.staffNames")}
          hint={t("quality.compose.staffNamesHint")}
          defaultValue="role_only"
          options={[
            { value: "role_only", label: t("quality.staffNames", { mode: "role_only" }) },
            { value: "include", label: t("quality.staffNames", { mode: "include" }) },
          ]}
        />
        <RadioGroup
          id={ids.statements}
          name="statements"
          legend={t("quality.compose.statements")}
          hint={t("quality.compose.statementsHint")}
          defaultValue="all"
          onValueChange={(value) => setSome(value === "some")}
          options={[
            { value: "all", label: t("quality.compose.statementsMode", { mode: "all" }) },
            { value: "some", label: t("quality.compose.statementsMode", { mode: "some" }) },
          ]}
        />
        {some ? (
          <TickGroup
            id={ids.statementIds}
            name="statementIds"
            legend={t("quality.compose.keyQuestions")}
            hint={t("quality.compose.keyQuestionsHint")}
            options={KEY_QUESTIONS.map((q) => ({ id: q, label: keyQuestionLabel(q, t) }))}
            error={error("statementIds")}
          />
        ) : null}
        <div>
          <Button type="submit" disabled={pending}>
            {pending ? t("common.saving") : t("quality.compose.submit")}
          </Button>
        </div>
      </form>
      <QualityFeedback result={result} path={PATH} fieldIds={ids} />
    </div>
  );
}
