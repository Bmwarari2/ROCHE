"use client";

import type { EscalationPolicyRef, OutageItem, PersonCareProfile } from "@harbour/contracts";
import { Button, Checkbox, RadioGroup, SelectField, TextField } from "@harbour/ui";
import { Lock, TriangleAlert } from "lucide-react";
import { type FormEvent, useRef, useState, useTransition } from "react";
import { recordObservation } from "@/app/actions/care-record";
import { keptForReview, PAPER_FIELDS, paperWritten, readEntryWhen } from "@/lib/back-entry";
import { IDDSI_DRINK_LEVELS, IDDSI_FOOD_LEVELS, iddsiLabel } from "@/lib/care-record";
import {
  AMOUNTS,
  BRISTOL,
  CHART_FIELDS,
  type ChartField,
  CONSCIOUSNESS,
  MEALS,
  OUTPUT_KINDS,
  PORTIONS,
  POSITIONS,
  readChartValues,
  WEIGHT_METHODS,
} from "@/lib/chart-entry";
import { type ChartKind, type News2Flags, news2FromFlags } from "@/lib/charts";
import { t } from "@/lib/i18n";
import { type ActionResult, collectedRefusal, errorFor, partsFor } from "@/lib/outcome";
import type { CareProfileLoad } from "@/lib/record-data";

import { FormFeedback } from "./FormFeedback";
import { useEntryId, useFieldIds } from "./form-state";
import { News2Result } from "./News2Result";
import { Notice } from "./Notice";
import { WhenField } from "./WhenField";

type Profile = Pick<PersonCareProfile, "iddsiFoodLevel" | "iddsiDrinkLevel" | "spo2Scale2">;
type Field = ChartField;
type Ids = Readonly<Record<Field, string>>;
const FIELDS = [...CHART_FIELDS, ...PAPER_FIELDS] as const;

function isRefusal(value: unknown): value is ActionResult<never> {
  return typeof value === "object" && value !== null && "ok" in value;
}

/**
 * The texture given (HZ-016). Nothing is chosen for anyone: the record must say what was given,
 * not repeat the prescription. The prescribed level shows beside the choice (or that it is not
 * available to the person viewing), and a different level asks for the reason.
 */
function IddsiChoice({
  kind,
  prescribed,
  required,
  profileKind,
  ids,
  result,
}: {
  readonly kind: "food" | "drink";
  readonly prescribed: string | null;
  readonly required: boolean;
  readonly profileKind: CareProfileLoad["kind"];
  readonly ids: Ids;
  readonly result: ActionResult<unknown> | null;
}) {
  const [chosen, setChosen] = useState("");
  const levels = kind === "food" ? IDDSI_FOOD_LEVELS : IDDSI_DRINK_LEVELS;
  const mismatch = prescribed !== null && chosen !== "" && chosen !== prescribed;
  return (
    <>
      <SelectField
        id={ids.iddsiLevel}
        error={errorFor(result, "iddsiLevel")}
        name="iddsiLevel"
        label={kind === "food" ? t("care.charts.foodLevel") : t("care.charts.drinkLevel")}
        hint={
          profileKind !== "ok"
            ? t("care.charts.prescribedUnavailable", { reason: profileKind })
            : prescribed
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
          id={ids.overrideReason}
          error={errorFor(result, "overrideReason")}
          name="overrideReason"
          label={t("care.charts.overrideReason")}
          hint={t("care.charts.mismatchHint")}
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
  outages = [],
  chart,
  profile,
  profileKind,
  name,
}: {
  readonly personId: string;
  /** Outages a paper record can be entered against at the person's location. */
  readonly outages?: readonly OutageItem[];
  readonly chart: ChartKind;
  readonly profile: Profile | null;
  /** Whether the person viewing could read the care profile (levels and SpO2 scale). */
  readonly profileKind: CareProfileLoad["kind"];
  /** The person's preferred name. */
  readonly name: string;
}) {
  const [result, setResult] = useState<ActionResult<unknown> | null>(null);
  const [news2, setNews2] = useState<News2Flags | null>(null);
  // The organisation's escalation policy the save returned, shown with the result (#26 round 3).
  const [policy, setPolicy] = useState<EscalationPolicyRef | null>(null);
  // A reading entered from paper: its result says it is from then (HZ-017).
  const [paperAt, setPaperAt] = useState<string | null>(null);
  const [round, setRound] = useState(0);
  const [noMovement, setNoMovement] = useState(false);
  const [pending, startTransition] = useTransition();
  const ids = useFieldIds(FIELDS);
  const entry = useEntryId();
  // After vital signs are saved, focus moves to the NEWS2 result, so its score and the RCP's
  // response are read out next.
  const news2Ref = useRef<HTMLElement>(null);
  const error = (field: Field) => ({ id: ids[field], error: errorFor(result, field) });

  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    const values = readChartValues(chart, form, t, {
      food: profile?.iddsiFoodLevel ?? null,
      drink: profile?.iddsiDrinkLevel ?? null,
    });
    if (isRefusal(values)) {
      setResult(values);
      return;
    }
    const when = readEntryWhen(form, "occurredAt", t, outages);
    if (!when.ok) {
      setResult(collectedRefusal(when.problems));
      return;
    }
    startTransition(async () => {
      const outcome = await recordObservation(personId, {
        id: entry.id,
        occurredAt: when.instant,
        downtime: when.downtime,
        sentAt: new Date().toISOString(),
        values,
      });
      setResult(outcome);
      setNews2(outcome.ok ? news2FromFlags(outcome.data.flags) : null);
      setPaperAt(
        outcome.ok && outcome.data.backEntry ? paperWritten(outcome.data.backEntry) : null,
      );
      setPolicy(outcome.ok ? outcome.data.escalationPolicy : null);
      // Kept for review after a reconciled outage: start again, so it is not saved twice.
      if (outcome.ok || keptForReview(outcome)) {
        setRound((n) => n + 1);
        setNoMovement(false);
        entry.next();
      }
    });
  };

  // NEWS2 scores SpO2 on the person's scale. Without the care profile the person viewing cannot
  // see which scale applies, so vital signs are not offered rather than guessed (HZ-012, HZ-014).
  if (chart === "vitals" && profileKind !== "ok") {
    return (
      <Notice
        tone="warning"
        icon={
          profileKind === "no_access" ? (
            <Lock size={20} strokeWidth={1.5} />
          ) : (
            <TriangleAlert size={20} strokeWidth={1.5} />
          )
        }
        title={t("care.charts.vitals.withheld.title")}
      >
        {t("care.charts.vitals.withheld.body", { reason: profileKind })}
      </Notice>
    );
  }

  return (
    <div className="flex flex-col gap-4">
      <form key={`${chart}-${round}`} className="flex flex-col gap-4" onSubmit={submit} noValidate>
        {chart === "fluid_intake" ? (
          <>
            <TextField
              {...error("ml")}
              name="ml"
              label={t("care.charts.amountMl")}
              hint={t("care.charts.amountHint")}
              className="max-w-xs"
              {...numberField}
              inputMode="numeric"
            />
            <TextField
              {...error("drink")}
              name="drink"
              label={t("care.charts.drink")}
              hint={t("care.charts.drinkHint")}
              maxLength={60}
              className="max-w-md"
            />
            <IddsiChoice
              kind="drink"
              prescribed={profile?.iddsiDrinkLevel ?? null}
              required={Boolean(profile?.iddsiDrinkLevel)}
              profileKind={profileKind}
              ids={ids}
              result={result}
            />
            <Checkbox name="refused" label={t("care.charts.refusedDrink", { name })} />
          </>
        ) : null}
        {chart === "fluid_output" ? (
          <>
            <TextField
              {...error("ml")}
              name="ml"
              label={t("care.charts.amountMl")}
              hint={t("care.charts.amountHint")}
              className="max-w-xs"
              {...numberField}
              inputMode="numeric"
            />
            <SelectField
              {...error("kind")}
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
              {...error("meal")}
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
              {...error("portion")}
              legend={t("care.charts.portion")}
              name="portion"
              layout="inline"
              options={PORTIONS.map((portion) => ({
                value: portion,
                label: t("care.charts.portionOption", { portion }),
              }))}
            />
            <TextField
              {...error("description")}
              name="description"
              label={t("care.charts.foodDescription")}
              maxLength={200}
              className="max-w-md"
            />
            <IddsiChoice
              kind="food"
              prescribed={profile?.iddsiFoodLevel ?? null}
              required
              profileKind={profileKind}
              ids={ids}
              result={result}
            />
            <Checkbox name="refused" label={t("care.charts.refusedFood", { name })} />
          </>
        ) : null}
        {chart === "repositioning" ? (
          <>
            <RadioGroup
              {...error("position")}
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
                  {...error("bristolType")}
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
                  {...error("amount")}
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
              {...error("kg")}
              name="kg"
              label={t("care.charts.weightKg")}
              hint={t("care.charts.weightHint")}
              className="max-w-xs"
              {...numberField}
            />
            <SelectField
              {...error("method")}
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
            <p className="m-0 text-body-dense text-text-secondary">
              {t("care.charts.vitals.scale", { scale: profile?.spo2Scale2 ? 2 : 1, name })}
            </p>
            <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
              <TextField
                {...error("respirationRate")}
                name="respirationRate"
                label={t("care.charts.vitals.respirationRate")}
                {...numberField}
                inputMode="numeric"
              />
              <TextField
                {...error("spo2")}
                name="spo2"
                label={t("care.charts.vitals.spo2")}
                {...numberField}
                inputMode="numeric"
              />
              <TextField
                {...error("systolic")}
                name="systolic"
                label={t("care.charts.vitals.systolic")}
                {...numberField}
                inputMode="numeric"
              />
              <TextField
                {...error("pulse")}
                name="pulse"
                label={t("care.charts.vitals.pulse")}
                {...numberField}
                inputMode="numeric"
              />
              <TextField
                {...error("temperature")}
                name="temperature"
                label={t("care.charts.vitals.temperature")}
                {...numberField}
              />
            </div>
            <RadioGroup
              {...error("oxygen")}
              legend={t("care.charts.vitals.oxygen")}
              name="oxygen"
              layout="inline"
              options={[
                { value: "air", label: t("care.charts.vitals.air") },
                { value: "oxygen", label: t("care.charts.vitals.onOxygen") },
              ]}
            />
            <RadioGroup
              {...error("consciousness")}
              legend={t("care.charts.vitals.consciousness")}
              name="consciousness"
              layout="inline"
              options={CONSCIOUSNESS.map((level) => ({
                value: level,
                label: t("care.charts.vitals.consciousnessOption", { level }),
              }))}
            />
          </>
        ) : null}
        <WhenField
          id={ids.occurredAt}
          error={errorFor(result, "occurredAt")}
          errorParts={partsFor(result, "occurredAt")}
          paper={{
            outages,
            ids,
            result,
            ...(chart === "vitals" ? { notice: t("care.paper.readingBefore") } : {}),
          }}
        />
        <div>
          <Button type="submit" disabled={pending}>
            {pending ? t("common.saving") : t("care.charts.submit")}
          </Button>
        </div>
      </form>
      <FormFeedback
        result={result}
        success={t("care.charts.saved")}
        fieldIds={ids}
        {...(chart === "vitals" ? { focusOnSuccess: news2Ref } : {})}
      />
      {news2 && result?.ok ? (
        <News2Result
          news2={news2}
          escalationPolicy={policy}
          headingLevel={4}
          ref={news2Ref}
          paperAt={paperAt}
        />
      ) : null}
    </div>
  );
}
