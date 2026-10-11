"use client";

import type { RiskAssessmentItem, RiskTemplateList } from "@harbour/contracts";
import { Button, Checkbox, RadioGroup, TextArea, TextField } from "@harbour/ui";
import { useRouter } from "next/navigation";
import { type FormEvent, useState, useTransition } from "react";
import { recordRiskAssessment, reviewRiskAssessment } from "@/app/actions/care-plan";
import { characterCount, t } from "@/lib/i18n";
import type { ActionResult } from "@/lib/outcome";
import { answerField, type RiskTemplate, readRiskFields, splitControls } from "@/lib/risk";
import { FormFeedback } from "./FormFeedback";

function Scale({
  legend,
  name,
  labels,
  defaultValue,
}: {
  readonly legend: string;
  readonly name: string;
  readonly labels: readonly string[];
  readonly defaultValue: number | null;
}) {
  return (
    <RadioGroup
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
  const controls = existing ? splitControls(existing.controls, template) : null;
  const answer = (key: string) => existing?.answers[key];

  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const fields = readRiskFields(new FormData(event.currentTarget), template);
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
      <p className="m-0 text-callout text-text-secondary">
        {t("care.risk.templateSource", { source: template.source, version: template.version })}
      </p>
      <TextField
        name="hazard"
        label={t("care.risk.form.hazard")}
        hint={t("care.risk.form.hazardHint")}
        defaultValue={existing?.hazard ?? ""}
        maxLength={500}
      />
      <TextField
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
          />
          <Scale
            legend={t("care.risk.form.severity")}
            name="severity"
            labels={matrix.severity}
            defaultValue={existing?.severity ?? null}
          />
          <Scale
            legend={t("care.risk.form.residualLikelihood")}
            name="residualLikelihood"
            labels={matrix.likelihood}
            defaultValue={existing?.residualLikelihood ?? null}
          />
          <Scale
            legend={t("care.risk.form.residualSeverity")}
            name="residualSeverity"
            labels={matrix.severity}
            defaultValue={existing?.residualSeverity ?? null}
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
        name="otherControls"
        label={t("care.risk.form.otherControls")}
        defaultValue={controls?.other.join("\n") ?? ""}
        rows={3}
      />
      <TextArea
        name="positiveRiskStatement"
        label={t("care.risk.form.positiveRisk")}
        hint={t("care.risk.form.positiveRiskHint", { name })}
        defaultValue={existing?.positiveRiskStatement ?? ""}
        rows={3}
        maxLength={2000}
        formatCount={(remaining) => characterCount(remaining)}
      />
      <TextArea
        name="personViews"
        label={t("care.risk.form.personViews", { name })}
        defaultValue={existing?.personViews ?? ""}
        rows={2}
        maxLength={2000}
        formatCount={(remaining) => characterCount(remaining)}
      />
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
        <TextField
          type="date"
          name="assessedOn"
          label={t("care.risk.form.assessedOn")}
          defaultValue={today}
          max={today}
        />
        <TextField
          type="date"
          name="reviewDueOn"
          label={t("care.risk.form.reviewDueOn")}
          hint={t("care.risk.form.reviewDueHint")}
        />
      </div>
      <FormFeedback result={result} success={t("care.risk.form.saved")} />
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
