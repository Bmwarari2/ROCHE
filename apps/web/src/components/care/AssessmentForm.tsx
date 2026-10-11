"use client";

import type { AssessmentItem, AssessmentToolKey } from "@harbour/contracts";
import { Button, Checkbox, RadioGroup, SelectField, TextField } from "@harbour/ui";
import { type FormEvent, type ReactNode, useState, useTransition } from "react";
import { recordAssessment } from "@/app/actions/care-records";
import {
  BRADEN_SUBSCALES,
  bradenPoints,
  FALLS_CRITERIA,
  FALLS_OCCASIONS,
  type FormLike,
  MUST_BMI_CATEGORIES,
  MUST_BMI_JUDGEMENT,
  MUST_HEIGHT_METHODS,
  MUST_LOSS_CATEGORIES,
  MUST_LOSS_JUDGEMENT,
  MUST_WEIGHT_METHODS,
  messageKey,
  readBraden,
  readFalls,
  readMust,
  readWaterlow,
  WATERLOW,
} from "@/lib/assessment-answers";
import { t } from "@/lib/i18n";
import { type ActionResult, refused } from "@/lib/outcome";
import { AssessmentResult } from "./AssessmentResult";
import { FormFeedback } from "./FormFeedback";
import { WhenField } from "./WhenField";

const yesNo = [
  { value: "yes", label: t("care.common.yes") },
  { value: "no", label: t("care.common.no") },
];

const decimal = { inputMode: "decimal", autoComplete: "off" } as const;

function Section({ title, children }: { readonly title: string; readonly children: ReactNode }) {
  return (
    <fieldset className="m-0 flex flex-col gap-4 rounded-input border border-border p-4">
      <legend className="px-1 font-semibold">{title}</legend>
      {children}
    </fieldset>
  );
}

function MustFields({ name }: { readonly name: string }) {
  const [bmiSource, setBmiSource] = useState<"calculated" | "assessor_category">("calculated");
  const [lossSource, setLossSource] = useState<"calculated" | "assessor_category">("calculated");
  return (
    <>
      <Section title={t("care.must.step1")}>
        <RadioGroup
          legend={t("care.must.bmiSource")}
          name="bmiSource"
          layout="inline"
          value={bmiSource}
          onValueChange={setBmiSource}
          options={[
            { value: "calculated", label: t("care.must.fromMeasurements") },
            { value: "assessor_category", label: t("care.must.fromJudgement") },
          ]}
        />
        {bmiSource === "calculated" ? (
          <>
            <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
              <TextField name="weightKg" label={t("care.must.weightKg")} {...decimal} />
              <TextField
                name="heightM"
                label={t("care.must.heightM")}
                hint={t("care.must.heightHint")}
                {...decimal}
              />
            </div>
            <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
              <SelectField
                name="weightMethod"
                label={t("care.must.weightMethod")}
                defaultValue="measured"
                options={MUST_WEIGHT_METHODS.map((method) => ({
                  value: method,
                  label: t("care.must.method", { method }),
                }))}
              />
              <SelectField
                name="heightMethod"
                label={t("care.must.heightMethod")}
                defaultValue="measured"
                options={MUST_HEIGHT_METHODS.map((method) => ({
                  value: method,
                  label: t("care.must.method", { method }),
                }))}
              />
            </div>
          </>
        ) : (
          <>
            <RadioGroup
              legend={t("care.must.bmiCategory")}
              name="bmiCategory"
              layout="inline"
              options={MUST_BMI_CATEGORIES.map((category) => ({
                value: category,
                label: t("care.must.bmiCategoryOption", { category }),
              }))}
            />
            <RadioGroup
              legend={t("care.must.judgementMethod")}
              name="bmiMethod"
              layout="inline"
              options={MUST_BMI_JUDGEMENT.map((method) => ({
                value: method,
                label: t("care.must.method", { method }),
              }))}
            />
          </>
        )}
      </Section>
      <Section title={t("care.must.step2")}>
        <RadioGroup
          legend={t("care.must.lossSource")}
          name="lossSource"
          layout="inline"
          value={lossSource}
          onValueChange={setLossSource}
          options={[
            { value: "calculated", label: t("care.must.fromWeights") },
            { value: "assessor_category", label: t("care.must.fromJudgement") },
          ]}
        />
        {lossSource === "calculated" ? (
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
            <TextField name="previousWeightKg" label={t("care.must.previousWeight")} {...decimal} />
            <TextField name="currentWeightKg" label={t("care.must.currentWeight")} {...decimal} />
          </div>
        ) : (
          <>
            <RadioGroup
              legend={t("care.must.lossCategory")}
              name="lossCategory"
              layout="inline"
              options={MUST_LOSS_CATEGORIES.map((category) => ({
                value: category,
                label: t("care.must.lossCategoryOption", { category }),
              }))}
            />
            <RadioGroup
              legend={t("care.must.judgementMethod")}
              name="lossMethod"
              layout="inline"
              options={MUST_LOSS_JUDGEMENT.map((method) => ({
                value: method,
                label: t("care.must.method", { method }),
              }))}
            />
          </>
        )}
      </Section>
      <Section title={t("care.must.step3")}>
        <RadioGroup
          legend={t("care.must.acute", { name })}
          name="acuteDiseaseEffect"
          layout="inline"
          options={yesNo}
        />
      </Section>
    </>
  );
}

function FallsFields({ name }: { readonly name: string }) {
  const [setting, setSetting] = useState<"residential" | "community">("residential");
  return (
    <>
      <RadioGroup
        legend={t("care.falls.setting", { name })}
        name="setting"
        value={setting}
        onValueChange={setSetting}
        options={(["residential", "community"] as const).map((value) => ({
          value,
          label: t("care.falls.settingOption", { setting: value }),
        }))}
      />
      {setting === "residential" ? (
        <RadioGroup
          legend={t("care.falls.occasion")}
          name="occasion"
          layout="inline"
          options={FALLS_OCCASIONS.map((occasion) => ({
            value: occasion,
            label: t("care.falls.occasionOption", { occasion }),
          }))}
        />
      ) : null}
      <RadioGroup
        legend={t("care.falls.fallenInLastYear", { name })}
        name="fallenInLastYear"
        layout="inline"
        options={yesNo}
      />
      <RadioGroup
        legend={t("care.falls.presentingAfterFall", { name })}
        name="presentingAfterFall"
        layout="inline"
        options={yesNo}
      />
      {setting === "community" ? (
        <fieldset className="m-0 flex flex-col gap-1 border-0 p-0">
          <legend className="mb-1 p-0 font-semibold">{t("care.falls.criteria")}</legend>
          {FALLS_CRITERIA.map((criterion) => (
            <Checkbox
              key={criterion}
              name="criteria"
              value={criterion}
              label={t("care.falls.criterion", { criterion })}
            />
          ))}
        </fieldset>
      ) : null}
    </>
  );
}

function BradenFields() {
  return (
    <>
      {BRADEN_SUBSCALES.map((subscale) => (
        <RadioGroup
          key={subscale}
          legend={t("care.braden.subscale", { subscale })}
          name={subscale}
          layout="grid"
          options={bradenPoints(subscale).map((score) => ({
            value: String(score),
            label: t("care.braden.option", { subscale, score }),
          }))}
        />
      ))}
    </>
  );
}

function Ticks({
  legend,
  name,
  options,
}: {
  readonly legend: string;
  readonly name: string;
  readonly options: readonly { value: string; label: string }[];
}) {
  return (
    <fieldset className="m-0 flex flex-col gap-1 border-0 p-0">
      <legend className="mb-1 p-0 font-semibold">{legend}</legend>
      {options.map((option) => (
        <Checkbox key={option.value} name={name} value={option.value} label={option.label} />
      ))}
    </fieldset>
  );
}

function WaterlowFields({ name }: { readonly name: string }) {
  const [buildSource, setBuildSource] = useState<"calculated" | "assessor_category">("calculated");
  const [lostWeight, setLostWeight] = useState<string | null>(null);
  return (
    <>
      <Section title={t("care.waterlow.build")}>
        <RadioGroup
          legend={t("care.must.bmiSource")}
          name="buildSource"
          layout="inline"
          value={buildSource}
          onValueChange={setBuildSource}
          options={[
            { value: "calculated", label: t("care.must.fromMeasurements") },
            { value: "assessor_category", label: t("care.must.fromJudgement") },
          ]}
        />
        {buildSource === "calculated" ? (
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
            <TextField name="weightKg" label={t("care.must.weightKg")} {...decimal} />
            <TextField
              name="heightM"
              label={t("care.must.heightM")}
              hint={t("care.must.heightHint")}
              {...decimal}
            />
          </div>
        ) : (
          <RadioGroup
            legend={t("care.waterlow.build")}
            name="buildCategory"
            options={WATERLOW.build.map((category) => ({
              value: category,
              label: t("care.waterlow.buildOption", { category }),
            }))}
          />
        )}
      </Section>
      <Ticks
        legend={t("care.waterlow.skin")}
        name="skin"
        options={WATERLOW.skin.map((skin) => ({
          value: skin,
          label: t("care.waterlow.skinOption", { skin }),
        }))}
      />
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
        <RadioGroup
          legend={t("care.waterlow.sex")}
          name="sex"
          layout="inline"
          options={WATERLOW.sex.map((sex) => ({
            value: sex,
            label: t("care.waterlow.sexOption", { sex }),
          }))}
        />
        <TextField
          name="ageYears"
          label={t("care.waterlow.age")}
          inputMode="numeric"
          autoComplete="off"
        />
      </div>
      <RadioGroup
        legend={t("care.waterlow.recentWeightLoss", { name })}
        name="recentWeightLoss"
        layout="inline"
        value={lostWeight as "yes" | "no" | "unsure" | null}
        onValueChange={setLostWeight}
        options={WATERLOW.recentWeightLoss.map((answer) => ({
          value: answer,
          label: t("care.waterlow.yesNoUnsure", { answer }),
        }))}
      />
      {lostWeight === "yes" ? (
        <SelectField
          name="weightLossAmount"
          label={t("care.waterlow.weightLossAmount")}
          options={WATERLOW.weightLossAmount.map((amount) => ({
            value: amount,
            label: t("care.waterlow.weightLossOption", { amount: messageKey(amount) }),
          }))}
          className="max-w-xs"
        />
      ) : null}
      <RadioGroup
        legend={t("care.waterlow.eatingPoorly", { name })}
        name="eatingPoorly"
        layout="inline"
        options={yesNo}
      />
      <RadioGroup
        legend={t("care.waterlow.continence")}
        name="continence"
        layout="grid"
        options={WATERLOW.continence.map((continence) => ({
          value: continence,
          label: t("care.waterlow.continenceOption", { continence }),
        }))}
      />
      <RadioGroup
        legend={t("care.waterlow.mobility")}
        name="mobility"
        layout="grid"
        options={WATERLOW.mobility.map((mobility) => ({
          value: mobility,
          label: t("care.waterlow.mobilityOption", { mobility }),
        }))}
      />
      <Ticks
        legend={t("care.waterlow.tissue")}
        name="tissue"
        options={WATERLOW.tissue.map((risk) => ({
          value: risk,
          label: t("care.waterlow.tissueOption", { risk }),
        }))}
      />
      <fieldset className="m-0 flex flex-col gap-2 border-0 p-0">
        <legend className="mb-1 p-0 font-semibold">{t("care.waterlow.neuro")}</legend>
        {WATERLOW.neuro.map((condition) => (
          <div key={condition} className="flex flex-wrap items-end gap-4">
            <Checkbox
              name="neuro"
              value={condition}
              label={t("care.waterlow.neuroOption", { condition })}
            />
            <SelectField
              name={`neuroPoints.${condition}`}
              label={t("care.waterlow.neuroPoints", { condition })}
              defaultValue="4"
              options={["4", "5", "6"].map((points) => ({ value: points, label: points }))}
              className="w-56"
            />
          </div>
        ))}
      </fieldset>
      <Section title={t("care.waterlow.surgery")}>
        <RadioGroup
          legend={t("care.waterlow.orthopaedic")}
          name="orthopaedic"
          layout="inline"
          options={yesNo}
        />
        <SelectField
          name="timeOnTable"
          label={t("care.waterlow.timeOnTable")}
          defaultValue="not_applicable"
          options={WATERLOW.timeOnTable.map((time) => ({
            value: time,
            label: t("care.waterlow.timeOnTableOption", { time }),
          }))}
          className="max-w-xs"
        />
      </Section>
      <Ticks
        legend={t("care.waterlow.medication")}
        name="medication"
        options={WATERLOW.medication.map((medicine) => ({
          value: medicine,
          label: t("care.waterlow.medicationOption", { medicine }),
        }))}
      />
    </>
  );
}

function readAnswers(tool: AssessmentToolKey, form: FormLike) {
  switch (tool) {
    case "must":
      return { toolKey: "must" as const, answers: readMust(form) };
    case "ng249_falls":
      return { toolKey: "ng249_falls" as const, answers: readFalls(form) };
    case "braden":
      return { toolKey: "braden" as const, answers: readBraden(form) };
    case "waterlow":
      return { toolKey: "waterlow" as const, answers: readWaterlow(form) };
  }
}

/**
 * Run one validated tool (care.md rule 5): the published questions, then the result as the API
 * calculated it, with its workings and follow-ups. The web app never scores.
 */
export function AssessmentForm({
  personId,
  tool,
  nowLocal,
  name,
}: {
  readonly personId: string;
  readonly tool: AssessmentToolKey;
  readonly nowLocal: string;
  readonly name: string;
}) {
  const [result, setResult] = useState<ActionResult<AssessmentItem> | null>(null);
  const [round, setRound] = useState(0);
  const [pending, startTransition] = useTransition();

  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    const read = readAnswers(tool, form);
    if (read.answers === null) {
      setResult(refused(t("care.assessments.form.answerAll")));
      return;
    }
    startTransition(async () => {
      const outcome = await recordAssessment(personId, {
        ...(read as Exclude<typeof read, { answers: null }>),
        occurredAtLocal: String(form.get("occurredAt") ?? ""),
      } as Parameters<typeof recordAssessment>[1]);
      setResult(outcome);
      if (outcome.ok) setRound((n) => n + 1);
    });
  };

  return (
    <div className="flex flex-col gap-4">
      <form key={`${tool}-${round}`} className="flex flex-col gap-4" onSubmit={submit} noValidate>
        {tool === "must" ? <MustFields name={name} /> : null}
        {tool === "ng249_falls" ? <FallsFields name={name} /> : null}
        {tool === "braden" ? <BradenFields /> : null}
        {tool === "waterlow" ? <WaterlowFields name={name} /> : null}
        <WhenField defaultValue={nowLocal} label={t("care.assessments.form.when")} />
        <div>
          <Button type="submit" disabled={pending}>
            {pending ? t("common.saving") : t("care.assessments.form.submit")}
          </Button>
        </div>
      </form>
      <FormFeedback result={result} success={t("care.assessments.form.saved")} />
      {result?.ok ? (
        <div className="rounded-input border border-border p-4">
          <AssessmentResult item={result.data} headingLevel={4} />
        </div>
      ) : null}
    </div>
  );
}
