"use client";

import type { PersonCareProfile, UpdatePersonCareProfile } from "@harbour/contracts";
import { Button, Checkbox, SelectField, TextField } from "@harbour/ui";
import { type FormEvent, useState, useTransition } from "react";
import { updateCareProfile } from "@/app/actions/care-record";
import { readWholeNumber } from "@/lib/assessments";
import { IDDSI_DRINK_LEVELS, IDDSI_FOOD_LEVELS, iddsiLabel } from "@/lib/care-record";
import { formatDateTime } from "@/lib/format";
import { t } from "@/lib/i18n";
import { type ActionResult, refused } from "@/lib/outcome";
import { FormFeedback } from "./FormFeedback";

const SKIN_RISKS = ["not_at_risk", "at_risk", "high_risk"] as const;

/**
 * The person's chart settings: prescribed IDDSI levels (a change records who advised it, HZ-016),
 * the daily fluid target, skin risk and the NEWS2 SpO2 scale (scale 2 only with the clinician who
 * decided it). For staff who write care plans.
 */
export function ChartSettingsForm({
  personId,
  profile,
}: {
  readonly personId: string;
  readonly profile: PersonCareProfile;
}) {
  const [result, setResult] = useState<ActionResult<unknown> | null>(null);
  const [scale2, setScale2] = useState(profile.spo2Scale2);
  const [pending, startTransition] = useTransition();

  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    const food = String(form.get("iddsiFoodLevel") ?? "");
    const drink = String(form.get("iddsiDrinkLevel") ?? "");
    const targetText = String(form.get("fluidTargetMl") ?? "").trim();
    const target = targetText === "" ? null : readWholeNumber(targetText);
    if (target !== null && (target < 500 || target > 4000)) {
      setResult(refused(t("care.profile.fluidTargetHint")));
      return;
    }
    if (targetText !== "" && target === null) {
      setResult(refused(t("care.profile.fluidTargetHint")));
      return;
    }
    const advisedBy = String(form.get("iddsiAdvisedBy") ?? "").trim();
    const clinician = String(form.get("spo2Scale2Clinician") ?? "").trim();
    const update: UpdatePersonCareProfile = {
      version: profile.version,
      iddsiFoodLevel: food ? (food as (typeof IDDSI_FOOD_LEVELS)[number]) : null,
      iddsiDrinkLevel: drink ? (drink as (typeof IDDSI_DRINK_LEVELS)[number]) : null,
      fluidTargetMl: target,
      skinRisk: String(form.get("skinRisk")) as (typeof SKIN_RISKS)[number],
      spo2Scale2: scale2,
      ...(advisedBy ? { iddsiAdvisedBy: advisedBy } : {}),
      ...(scale2 && clinician ? { spo2Scale2Clinician: clinician } : {}),
    };
    startTransition(async () => {
      setResult(await updateCareProfile(personId, update));
    });
  };

  return (
    <form className="flex flex-col gap-4" onSubmit={submit} noValidate>
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
        <SelectField
          name="iddsiFoodLevel"
          label={t("care.profile.foodLevel")}
          defaultValue={profile.iddsiFoodLevel ?? ""}
          emptyOption={t("care.profile.noLevel")}
          options={IDDSI_FOOD_LEVELS.map((level) => ({
            value: level,
            label: iddsiLabel("food", level, t),
          }))}
        />
        <SelectField
          name="iddsiDrinkLevel"
          label={t("care.profile.drinkLevel")}
          defaultValue={profile.iddsiDrinkLevel ?? ""}
          emptyOption={t("care.profile.noLevel")}
          options={IDDSI_DRINK_LEVELS.map((level) => ({
            value: level,
            label: iddsiLabel("drink", level, t),
          }))}
        />
      </div>
      <TextField
        name="iddsiAdvisedBy"
        label={t("care.profile.advisedBy")}
        hint={
          profile.iddsiAdvisedBy && profile.iddsiChangedAt
            ? `${t("care.profile.advisedByHint")} ${t("care.profile.advisedByCurrent", {
                date: formatDateTime(profile.iddsiChangedAt) ?? "",
                advisedBy: profile.iddsiAdvisedBy,
              })}`
            : t("care.profile.advisedByHint")
        }
        maxLength={120}
      />
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
        <TextField
          name="fluidTargetMl"
          label={t("care.profile.fluidTarget")}
          hint={t("care.profile.fluidTargetHint")}
          defaultValue={profile.fluidTargetMl === null ? "" : String(profile.fluidTargetMl)}
          inputMode="numeric"
          autoComplete="off"
        />
        <SelectField
          name="skinRisk"
          label={t("care.profile.skinRisk")}
          defaultValue={profile.skinRisk}
          options={SKIN_RISKS.map((risk) => ({
            value: risk,
            label: t("care.profile.skinRiskOption", { risk }),
          }))}
        />
      </div>
      <Checkbox
        name="spo2Scale2"
        label={t("care.profile.scale2")}
        hint={t("care.profile.scale2Hint")}
        checked={scale2}
        onChange={(event) => setScale2(event.currentTarget.checked)}
      />
      {scale2 && !profile.spo2Scale2 ? (
        <TextField
          name="spo2Scale2Clinician"
          label={t("care.profile.clinician")}
          hint={t("care.profile.clinicianHint")}
          maxLength={120}
        />
      ) : null}
      <div>
        <Button type="submit" variant="secondary" disabled={pending}>
          {pending ? t("common.saving") : t("care.profile.submit")}
        </Button>
      </div>
      <FormFeedback result={result} success={t("care.profile.saved")} />
    </form>
  );
}
