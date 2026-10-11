"use client";

import type { RiskAssessmentItem, RiskTemplateList } from "@harbour/contracts";
import { Button, Checkbox, DateInput, RadioGroup, TextArea, TextField } from "@harbour/ui";
import { useRouter } from "next/navigation";
import { type FormEvent, useState, useTransition } from "react";
import { recordRiskAssessment, reviewRiskAssessment } from "@/app/actions/care-plan";
import { characterCount, t } from "@/lib/i18n";
import { type ActionResult, errorFor, fieldErrors, partsFor, partsRefusal } from "@/lib/outcome";
import { answerField, type RiskTemplate, readRiskFields, splitControls } from "@/lib/risk";
import { dateBoxesOf, readDateField } from "@/lib/uk-time";
import { FormFeedback } from "./FormFeedback";
import { useFieldIds } from "./form-state";

const FIELDS = [
  "hazard",
  "whoAtRisk",
  "likelihood",
  "severity",
  "residualLikelihood",
  "residualSeverity",
  "otherControls",
  "positiveRiskStatement",
  "personViews",
  "assessedOn",
  "reviewDueOn",
] as const;

const dateLabels = {
  day: t("care.date.day"),
  month: t("care.date.month"),
  year: t("care.date.year"),
};

function Scale({
  legend,
  name,
  labels,
  defaultValue,
  id,
  error,
}: {
  readonly legend: string;
  readonly name: string;
  readonly labels: readonly string[];
  readonly defaultValue: number | null;
  readonly id: string;
  readonly error: string | undefined;
}) {
  return (
    <RadioGroup
      id={id}
      error={error}
      legend={legend}
      name={name}
      layout="inline"
      {...(defaultValue ? { defaultValue: String(defaultValue) } : {})}
      options={labels.map((label, index) => ({
        value: String(index + 1),
        label: t("care.risk.form.scaleOption", { score: index + 1, label }),
      }))}
    />
  );
}

/**
 * A positive risk assessment from a template (register row CARE-002): the hazard, the template's
 * questions, the assessor's judgements of likelihood and severity before and after the controls,
 * the controls and, where a risk is accepted, the positive risk statement. The API works out the
 * rating and checks bed rail measurements (HZ-025); falls are never rated.
 */
export function RiskForm({
  personId,
  template,
  matrix,
  name,
  today,
  existing,
}: {
  readonly personId: string;
  readonly template: RiskTemplate;
  readonly matrix: RiskTemplateList["matrix"];
  readonly name: string;
  readonly today: string;
  /** A review: the assessment as it stands, saved as its next version. */
  readonly existing?: RiskAssessmentItem;
}) {
  const router = useRouter();
  const [result, setResult] = useState<ActionResult<unknown> | null>(null);
  const [pending, startTransition] = useTransition();
  const ids = useFieldIds(FIELDS);
  const controls = existing ? splitControls(existing.controls, template) : null;
  const answer = (key: string) => existing?.answers[key];

  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    const assessed = readDateField(form, "assessedOn", {
      subject: t("care.date.subject.assessedOn"),
      t,
    });
    if (!assessed.ok) {
      setResult(partsRefusal("assessedOn", assessed));
      return;
    }
    const review = readDateField(form, "reviewDueOn", {
      subject: t("care.date.subject.reviewDueOn"),
      optional: true,
      t,
    });
    if (!review.ok) {
      setResult(partsRefusal("reviewDueOn", review));
      return;
    }
    const fields = readRiskFields(form, template, {
      assessedOn: assessed.date ?? "",
      reviewDueOn: review.date,
    });
    // The required words are checked here first, so each error shows at its field at once.
    const missing = {
      ...(fields.hazard ? {} : { hazard: t("care.refusal.hazard") }),
      ...(fields.whoAtRisk ? {} : { whoAtRisk: t("care.refusal.whoAtRisk") }),
      ...(fields.controls.length > 0 ? {} : { otherControls: t("care.refusal.controls") }),
    };
    if (Object.keys(missing).length > 0) {
      setResult(fieldErrors(missing));
      return;
    }
    startTransition(async () => {
      const outcome = existing
        ? await reviewRiskAssessment(personId, existing.id, {
            ...fields,
            version: existing.version,
          })
        : await recordRiskAssessment(personId, { templateKey: template.key, ...fields });
      setResult(outcome);
      if (outcome.ok) router.push(`/people/${personId}/risk-assessments?saved=${outcome.data.id}`);
    });
  };

  return (
    <form className="flex flex-col gap-4" onSubmit={submit} noValidate>
      <p className="m-0 text-body-dense text-text-secondary">
        {t("care.risk.templateSource", { source: template.source, version: template.version })}
      </p>
      <TextField
        id={ids.hazard}
        error={errorFor(result, "hazard")}
        name="hazard"
        label={t("care.risk.form.hazard")}
        hint={t("care.risk.form.hazardHint")}
        defaultValue={existing?.hazard ?? ""}
        maxLength={500}
      />
      <TextField
        id={ids.whoAtRisk}
        error={errorFor(result, "whoAtRisk")}
        name="whoAtRisk"
        label={t("care.risk.form.whoAtRisk")}
        hint={t("care.risk.form.whoAtRiskHint")}
        defaultValue={existing?.whoAtRisk ?? ""}
        maxLength={300}
      />
      {template.questions.length > 0 ? (
        <fieldset className="m-0 flex flex-col gap-4 rounded-input border border-border p-4">
          <legend className="px-1 font-semibold">{t("care.risk.form.questions")}</legend>
          {template.questions.map((question) => {
            const field = answerField(question.key);
            const current = answer(question.key);
            if (question.kind === "yes_no") {
              return (
                <RadioGroup
                  key={question.key}
                  legend={question.text}
                  name={field}
                  layout="inline"
                  {...(typeof current === "boolean"
                    ? { defaultValue: current ? "yes" : "no" }
                    : {})}
                  options={[
                    { value: "yes", label: t("care.common.yes") },
                    { value: "no", label: t("care.common.no") },
                  ]}
                />
              );
            }
            if (question.kind === "measurement_mm") {
              return (
                <TextField
                  key={question.key}
                  name={field}
                  label={t("care.risk.form.measurement", { question: question.text })}
                  {...(question.limit
                    ? {
                        hint: t("care.risk.form.limitHint", {
                          rule: question.limit.rule,
                          value: question.limit.valueMm,
                        }),
                      }
                    : {})}
                  defaultValue={typeof current === "number" ? String(current) : ""}
                  inputMode="decimal"
                  autoComplete="off"
                  className="max-w-xs"
                />
              );
            }
            return (
              <TextArea
                key={question.key}
                name={field}
                label={question.text}
                defaultValue={typeof current === "string" ? current : ""}
                rows={2}
                maxLength={1000}
                formatCount={(remaining) => characterCount(remaining)}
              />
            );
          })}
        </fieldset>
      ) : null}
      {template.rated ? (
        <fieldset className="m-0 flex flex-col gap-4 rounded-input border border-border p-4">
          <legend className="px-1 font-semibold">
            {t("care.risk.form.matrix", { source: matrix.source })}
          </legend>
          <Scale
            legend={t("care.risk.form.likelihood")}
            name="likelihood"
            labels={matrix.likelihood}
            defaultValue={existing?.likelihood ?? null}
            id={ids.likelihood}
            error={errorFor(result, "likelihood")}
          />
          <Scale
            legend={t("care.risk.form.severity")}
            name="severity"
            labels={matrix.severity}
            defaultValue={existing?.severity ?? null}
            id={ids.severity}
            error={errorFor(result, "severity")}
          />
          <Scale
            legend={t("care.risk.form.residualLikelihood")}
            name="residualLikelihood"
            labels={matrix.likelihood}
            defaultValue={existing?.residualLikelihood ?? null}
            id={ids.residualLikelihood}
            error={errorFor(result, "residualLikelihood")}
          />
          <Scale
            legend={t("care.risk.form.residualSeverity")}
            name="residualSeverity"
            labels={matrix.severity}
            defaultValue={existing?.residualSeverity ?? null}
            id={ids.residualSeverity}
            error={errorFor(result, "residualSeverity")}
          />
        </fieldset>
      ) : (
        <p className="m-0 font-semibold">{t("care.risk.notRated")}</p>
      )}
      <fieldset className="m-0 flex flex-col gap-1 border-0 p-0">
        <legend className="mb-1 p-0 font-semibold">{t("care.risk.form.suggestedControls")}</legend>
        {template.suggestedControls.map((control) => (
          <Checkbox
            key={control}
            name="controls"
            value={control}
            label={control}
            defaultChecked={controls?.suggested.includes(control) ?? false}
          />
        ))}
      </fieldset>
      <TextArea
        id={ids.otherControls}
        error={errorFor(result, "otherControls")}
        name="otherControls"
        label={t("care.risk.form.otherControls")}
        defaultValue={controls?.other.join("\n") ?? ""}
        rows={3}
      />
      <TextArea
        id={ids.positiveRiskStatement}
        error={errorFor(result, "positiveRiskStatement")}
        name="positiveRiskStatement"
        label={t("care.risk.form.positiveRisk")}
        hint={t("care.risk.form.positiveRiskHint", { name })}
        defaultValue={existing?.positiveRiskStatement ?? ""}
        rows={3}
        maxLength={2000}
        formatCount={(remaining) => characterCount(remaining)}
      />
      <TextArea
        id={ids.personViews}
        name="personViews"
        label={t("care.risk.form.personViews", { name })}
        defaultValue={existing?.personViews ?? ""}
        rows={2}
        maxLength={2000}
        formatCount={(remaining) => characterCount(remaining)}
      />
      <DateInput
        id={ids.assessedOn}
        error={errorFor(result, "assessedOn")}
        errorParts={dateBoxesOf(partsFor(result, "assessedOn"))}
        legend={t("care.risk.form.assessedOn")}
        hint={t("care.date.hint")}
        name="assessedOn"
        defaultValue={today}
        labels={dateLabels}
      />
      <DateInput
        id={ids.reviewDueOn}
        error={errorFor(result, "reviewDueOn")}
        errorParts={dateBoxesOf(partsFor(result, "reviewDueOn"))}
        legend={t("care.risk.form.reviewDueOn")}
        hint={t("care.risk.form.reviewDueHint")}
        name="reviewDueOn"
        labels={dateLabels}
      />
      <FormFeedback result={result} success={t("care.risk.form.saved")} fieldIds={ids} />
      <div>
        <Button type="submit" disabled={pending}>
          {pending
            ? t("common.saving")
            : existing
              ? t("care.risk.review.submit")
              : t("care.risk.form.submit")}
        </Button>
      </div>
    </form>
  );
}
