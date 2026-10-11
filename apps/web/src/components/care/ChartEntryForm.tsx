"use client";

import type { ObservationValues, PersonCareProfile } from "@harbour/contracts";
import { Button, Checkbox, RadioGroup, SelectField, TextField } from "@harbour/ui";
import { type FormEvent, useState, useTransition } from "react";
import { recordObservation } from "@/app/actions/care-record";
import { readNumber, readWholeNumber } from "@/lib/assessments";
import { IDDSI_DRINK_LEVELS, IDDSI_FOOD_LEVELS, iddsiLabel } from "@/lib/care-record";
import { type ChartKind, type News2Flags, news2FromFlags } from "@/lib/charts";
import { t } from "@/lib/i18n";
import { type ActionResult, refused } from "@/lib/outcome";
import { FormFeedback } from "./FormFeedback";
import { News2Result } from "./News2Result";
import { WhenField } from "./WhenField";

type Profile = Pick<PersonCareProfile, "iddsiFoodLevel" | "iddsiDrinkLevel" | "spo2Scale2">;

const OUTPUT_KINDS = ["urine", "vomit", "drain", "other"] as const;
const MEALS = ["breakfast", "lunch", "dinner", "supper", "snack"] as const;
const PORTIONS = ["none", "quarter", "half", "three_quarters", "all"] as const;
const POSITIONS = ["left", "right", "back", "front", "sitting"] as const;
const BRISTOL = [1, 2, 3, 4, 5, 6, 7] as const;
const AMOUNTS = ["small", "medium", "large"] as const;
const WEIGHT_METHODS = ["standing", "chair", "hoist", "bed"] as const;
const CONSCIOUSNESS = ["alert", "new_confusion", "voice", "pain", "unresponsive"] as const;

const text = (form: FormData, name: string) => String(form.get(name) ?? "").trim();
const optional = (value: string) => (value ? value : undefined);

/** The amount in whole millilitres, 0 to 5,000, as the API accepts. */
function readMl(form: FormData): number | null {
  const ml = readWholeNumber(form.get("ml"));
  return ml !== null && ml >= 0 && ml <= 5000 ? ml : null;
}

/**
 * Builds the chart entry from the form, or says what to fix. Limits here are only the shape the
 * API accepts; it checks IDDSI levels (HZ-016) and scores vital signs with NEWS2 itself.
 */
function readValues(chart: ChartKind, form: FormData): ObservationValues | ActionResult<never> {
  switch (chart) {
    case "fluid_intake": {
      const ml = readMl(form);
      if (ml === null) return refused(t("care.charts.amountRequired"));
      const level = text(form, "iddsiLevel");
      return {
        chart,
        ml,
        refused: form.get("refused") === "on",
        ...(optional(text(form, "drink")) ? { drink: text(form, "drink") } : {}),
        ...(level ? { iddsiLevel: level as (typeof IDDSI_DRINK_LEVELS)[number] } : {}),
        ...(optional(text(form, "overrideReason"))
          ? { overrideReason: text(form, "overrideReason") }
          : {}),
      };
    }
    case "fluid_output": {
      const ml = readMl(form);
      if (ml === null) return refused(t("care.charts.amountRequired"));
      return { chart, ml, kind: text(form, "kind") as (typeof OUTPUT_KINDS)[number] };
    }
    case "food": {
      const meal = text(form, "meal");
      const portion = text(form, "portion");
      const level = text(form, "iddsiLevel");
      if (!meal || !portion || !level) return refused(t("care.assessments.form.answerAll"));
      return {
        chart,
        meal: meal as (typeof MEALS)[number],
        portion: portion as (typeof PORTIONS)[number],
        iddsiLevel: level as (typeof IDDSI_FOOD_LEVELS)[number],
        refused: form.get("refused") === "on",
        ...(optional(text(form, "description")) ? { description: text(form, "description") } : {}),
        ...(optional(text(form, "overrideReason"))
          ? { overrideReason: text(form, "overrideReason") }
          : {}),
      };
    }
    case "repositioning": {
      const position = text(form, "position");
      if (!position) return refused(t("care.assessments.form.answerAll"));
      return {
        chart,
        position: position as (typeof POSITIONS)[number],
        skinChecked: form.get("skinChecked") === "on",
        declined: form.get("declined") === "on",
      };
    }
    case "bowel": {
      const noMovement = form.get("noMovement") === "on";
      const type = readWholeNumber(form.get("bristolType"));
      if (!noMovement && type === null) return refused(t("care.charts.bristolRequired"));
      const amount = text(form, "amount");
      return {
        chart,
        bristolType: noMovement ? null : type,
        noMovement,
        ...(amount && !noMovement ? { amount: amount as (typeof AMOUNTS)[number] } : {}),
      };
    }
    case "weight": {
      const kg = readNumber(form.get("kg"));
      if (kg === null || kg < 20 || kg > 300) return refused(t("care.charts.weightRequired"));
      return { chart, kg, method: text(form, "method") as (typeof WEIGHT_METHODS)[number] };
    }
    case "vitals": {
      const respirationRate = readWholeNumber(form.get("respirationRate"));
      const spo2 = readWholeNumber(form.get("spo2"));
      const systolic = readWholeNumber(form.get("systolic"));
      const pulse = readWholeNumber(form.get("pulse"));
      const temperature = readNumber(form.get("temperature"));
      const oxygen = text(form, "oxygen");
      const consciousness = text(form, "consciousness");
      if (
        respirationRate === null ||
        spo2 === null ||
        systolic === null ||
        pulse === null ||
        temperature === null ||
        !oxygen ||
        !consciousness
      ) {
        return refused(t("care.charts.vitals.required"));
      }
      return {
        chart,
        respirationRate,
        spo2,
        onOxygen: oxygen === "oxygen",
        systolic,
        pulse,
        consciousness: consciousness as (typeof CONSCIOUSNESS)[number],
        temperature,
      };
    }
  }
}

function isRefusal(value: unknown): value is ActionResult<never> {
  return typeof value === "object" && value !== null && "ok" in value;
}

/** A level select that shows the prescribed level beside it and asks for a reason on a mismatch. */
function IddsiChoice({
  kind,
  prescribed,
  required,
}: {
  readonly kind: "food" | "drink";
  readonly prescribed: string | null;
  readonly required: boolean;
}) {
  const [chosen, setChosen] = useState(prescribed ?? "");
  const levels = kind === "food" ? IDDSI_FOOD_LEVELS : IDDSI_DRINK_LEVELS;
  const mismatch = prescribed !== null && chosen !== "" && chosen !== prescribed;
  return (
    <>
      <SelectField
        name="iddsiLevel"
        label={kind === "food" ? t("care.charts.foodLevel") : t("care.charts.drinkLevel")}
        hint={
          prescribed
            ? t("care.charts.prescribed", { level: iddsiLabel(kind, prescribed, t) })
            : t("care.iddsi.notPrescribed")
        }
        value={chosen}
        onChange={(event) => setChosen(event.currentTarget.value)}
        emptyOption={required ? t("care.charts.choose") : t("care.charts.levelNotRecorded")}
        options={levels.map((level) => ({ value: level, label: iddsiLabel(kind, level, t) }))}
        className="max-w-md"
      />
      {mismatch ? (
        <TextField
          name="overrideReason"
          label={t("care.charts.overrideReason")}
          hint={`${t("care.charts.mismatchHint")} ${t("care.charts.overrideHint")}`}
          maxLength={300}
        />
      ) : null}
    </>
  );
}

const numberField = { type: "text", inputMode: "decimal", autoComplete: "off" } as const;

/** Record one chart entry for a person (care.md rule 6; register row CARE-010). */
export function ChartEntryForm({
  personId,
  chart,
  nowLocal,
  profile,
  name,
}: {
  readonly personId: string;
  readonly chart: ChartKind;
  readonly nowLocal: string;
  readonly profile: Profile | null;
  /** The person's preferred name. */
  readonly name: string;
}) {
  const [result, setResult] = useState<ActionResult<unknown> | null>(null);
  const [news2, setNews2] = useState<News2Flags | null>(null);
  const [round, setRound] = useState(0);
  const [noMovement, setNoMovement] = useState(false);
  const [pending, startTransition] = useTransition();

  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    const values = readValues(chart, form);
    if (isRefusal(values)) {
      setResult(values);
      return;
    }
    startTransition(async () => {
      const outcome = await recordObservation(personId, {
        occurredAtLocal: text(form, "occurredAt"),
        values,
      });
      setResult(outcome);
      setNews2(outcome.ok ? news2FromFlags(outcome.data.flags) : null);
      if (outcome.ok) {
        setRound((n) => n + 1);
        setNoMovement(false);
      }
    });
  };

  return (
    <div className="flex flex-col gap-4">
      <form key={`${chart}-${round}`} className="flex flex-col gap-4" onSubmit={submit} noValidate>
        {chart === "fluid_intake" ? (
          <>
            <TextField
              name="ml"
              label={t("care.charts.amountMl")}
              hint={t("care.charts.amountHint")}
              className="max-w-xs"
              {...numberField}
              inputMode="numeric"
            />
            <TextField
              name="drink"
              label={t("care.charts.drink")}
              hint={t("care.charts.drinkHint")}
              maxLength={60}
              className="max-w-md"
            />
            <IddsiChoice
              kind="drink"
              prescribed={profile?.iddsiDrinkLevel ?? null}
              required={false}
            />
            <Checkbox name="refused" label={t("care.charts.refusedDrink", { name })} />
          </>
        ) : null}
        {chart === "fluid_output" ? (
          <>
            <TextField
              name="ml"
              label={t("care.charts.amountMl")}
              hint={t("care.charts.amountHint")}
              className="max-w-xs"
              {...numberField}
              inputMode="numeric"
            />
            <SelectField
              name="kind"
              label={t("care.charts.outputKind")}
              defaultValue="urine"
              options={OUTPUT_KINDS.map((kind) => ({
                value: kind,
                label: t("care.charts.outputKindOption", { kind }),
              }))}
              className="max-w-xs"
            />
          </>
        ) : null}
        {chart === "food" ? (
          <>
            <SelectField
              name="meal"
              label={t("care.charts.meal")}
              emptyOption={t("care.charts.choose")}
              options={MEALS.map((meal) => ({
                value: meal,
                label: t("care.charts.mealOption", { meal }),
              }))}
              className="max-w-xs"
            />
            <RadioGroup
              legend={t("care.charts.portion")}
              name="portion"
              layout="inline"
              options={PORTIONS.map((portion) => ({
                value: portion,
                label: t("care.charts.portionOption", { portion }),
              }))}
            />
            <TextField
              name="description"
              label={t("care.charts.foodDescription")}
              maxLength={200}
              className="max-w-md"
            />
            <IddsiChoice kind="food" prescribed={profile?.iddsiFoodLevel ?? null} required />
            <Checkbox name="refused" label={t("care.charts.refusedFood", { name })} />
          </>
        ) : null}
        {chart === "repositioning" ? (
          <>
            <RadioGroup
              legend={t("care.charts.positionLegend")}
              name="position"
              layout="inline"
              options={POSITIONS.map((position) => ({
                value: position,
                label: t("care.charts.position", { position }),
              }))}
            />
            <Checkbox name="skinChecked" label={t("care.charts.skinCheckedLabel")} />
            <Checkbox name="declined" label={t("care.charts.declined", { name })} />
          </>
        ) : null}
        {chart === "bowel" ? (
          <>
            <Checkbox
              name="noMovement"
              label={t("care.charts.noMovementLabel")}
              hint={t("care.charts.noMovementHint")}
              checked={noMovement}
              onChange={(event) => setNoMovement(event.currentTarget.checked)}
            />
            {noMovement ? null : (
              <>
                <RadioGroup
                  legend={t("care.charts.bristolLegend")}
                  name="bristolType"
                  layout="grid"
                  options={BRISTOL.map((type) => ({
                    value: String(type),
                    label: t("care.charts.bristolOption", { type }),
                    description: t("care.charts.bristolDescription", { type }),
                  }))}
                />
                <SelectField
                  name="amount"
                  label={t("care.charts.amount")}
                  emptyOption={t("care.charts.levelNotRecorded")}
                  options={AMOUNTS.map((amount) => ({
                    value: amount,
                    label: t("care.charts.amountOption", { amount }),
                  }))}
                  className="max-w-xs"
                />
              </>
            )}
          </>
        ) : null}
        {chart === "weight" ? (
          <>
            <TextField
              name="kg"
              label={t("care.charts.weightKg")}
              hint={t("care.charts.weightHint")}
              className="max-w-xs"
              {...numberField}
            />
            <SelectField
              name="method"
              label={t("care.charts.weightMethod")}
              defaultValue="standing"
              options={WEIGHT_METHODS.map((method) => ({
                value: method,
                label: t("care.charts.weightMethodOption", { method }),
              }))}
              className="max-w-xs"
            />
          </>
        ) : null}
        {chart === "vitals" ? (
          <>
            <p className="m-0 text-callout text-text-secondary">
              {t("care.charts.vitals.scale", { scale: profile?.spo2Scale2 ? 2 : 1, name })}
            </p>
            <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
              <TextField
                name="respirationRate"
                label={t("care.charts.vitals.respirationRate")}
                {...numberField}
                inputMode="numeric"
              />
              <TextField
                name="spo2"
                label={t("care.charts.vitals.spo2")}
                {...numberField}
                inputMode="numeric"
              />
              <TextField
                name="systolic"
                label={t("care.charts.vitals.systolic")}
                {...numberField}
                inputMode="numeric"
              />
              <TextField
                name="pulse"
                label={t("care.charts.vitals.pulse")}
                {...numberField}
                inputMode="numeric"
              />
              <TextField
                name="temperature"
                label={t("care.charts.vitals.temperature")}
                {...numberField}
              />
            </div>
            <RadioGroup
              legend={t("care.charts.vitals.oxygen")}
              name="oxygen"
              layout="inline"
              defaultValue="air"
              options={[
                { value: "air", label: t("care.charts.vitals.air") },
                { value: "oxygen", label: t("care.charts.vitals.onOxygen") },
              ]}
            />
            <RadioGroup
              legend={t("care.charts.vitals.consciousness")}
              name="consciousness"
              layout="inline"
              defaultValue="alert"
              options={CONSCIOUSNESS.map((level) => ({
                value: level,
                label: t("care.charts.vitals.consciousnessOption", { level }),
              }))}
            />
          </>
        ) : null}
        <WhenField defaultValue={nowLocal} />
        <div>
          <Button type="submit" disabled={pending}>
            {pending ? t("common.saving") : t("care.charts.submit")}
          </Button>
        </div>
      </form>
      <FormFeedback result={result} success={t("care.charts.saved")} />
      {news2 && result?.ok ? <News2Result news2={news2} headingLevel={4} /> : null}
    </div>
  );
}
