"use client";

import { Button, Checkbox, RadioGroup, SelectField, TextArea, TextField } from "@harbour/ui";
import { ClipboardCheck } from "lucide-react";
import { type ReactNode, useState } from "react";
import { recordDose } from "@/app/actions/medicine-round";
import { FormFeedback } from "@/components/care/FormFeedback";
import { useFieldIds } from "@/components/care/form-state";
import { characterCount, t } from "@/lib/i18n";
import {
  OUTCOME_REASON_CODES,
  OUTCOMES,
  type Outcome,
  outcomeTakesAmount,
  personRoundHref,
  readAdministration,
} from "@/lib/medicine-round";
import { errorFor } from "@/lib/outcome";
import { useArrival, useMedicineSubmit } from "./MedicineForms";

const icon = { size: 18, strokeWidth: 1.5, "aria-hidden": true } as const;
const count = (remaining: number) => characterCount(remaining);

/**
 * Recording one dose on the round (slice 53; medicines.md section 16): the outcome, a reason where
 * the outcome takes one, the amount when the person took it (offered as prescribed, in the entry's
 * unit), and covert when given under the person's covert record. The person and every allergy are
 * shown at the top (`person`, HZ-007), and the medicine with its covert record beside it on the
 * page. The API decides again; its words are shown at their fields. A reason the API asks for (late,
 * a different amount, a minimum interval) is offered as a field the person may fill.
 */
export function RecordDoseForm({
  personId,
  entryId,
  dueAt,
  recordId,
  unitCode,
  unitName,
  offeredQuantity,
  covertOffered,
  person,
}: {
  readonly personId: string;
  readonly entryId: string;
  readonly dueAt: string | null;
  /** The client's UUID for this record, made by the page, so a resend is the same record. */
  readonly recordId: string;
  readonly unitCode: string | null;
  readonly unitName: string | null;
  readonly offeredQuantity: string;
  /** The medicine has a covert record that is not ended. */
  readonly covertOffered: boolean;
  readonly person: ReactNode;
}) {
  const ids = useFieldIds([
    "outcome",
    "reasonCode",
    "reasonNote",
    "quantity",
    "amountDifferenceReason",
    "timingReason",
    "intervalOverrideReason",
    "covert",
  ]);
  const arrive = useArrival();
  const [outcome, setOutcome] = useState<string>("");
  const [code, setCode] = useState<string>("");
  const { result, pending, submit } = useMedicineSubmit(
    (form) => readAdministration(form, t, { id: recordId, entryId, dueAt, unitCode }),
    (body) => recordDose(personId, body),
    () => arrive(personRoundHref(personId), "recorded"),
  );
  const codes = (OUTCOMES as readonly string[]).includes(outcome)
    ? OUTCOME_REASON_CODES[outcome as Outcome]
    : [];
  return (
    <form method="post" className="flex flex-col gap-4" onSubmit={submit} noValidate>
      {person}
      <RadioGroup
        id={ids.outcome}
        name="outcome"
        legend={t("medicines.round.form.outcome")}
        options={OUTCOMES.map((o) => ({
          value: o,
          label: t("medicines.round.outcome", { outcome: o }),
        }))}
        onValueChange={(value) => {
          setOutcome(value);
          setCode("");
        }}
        error={errorFor(result, "outcome")}
      />
      {codes.length > 0 ? (
        <SelectField
          id={ids.reasonCode}
          name="reasonCode"
          label={t("medicines.round.form.reason")}
          defaultValue=""
          emptyOption={t("medicines.form.choose")}
          options={codes.map((c) => ({
            value: c,
            label: t("medicines.round.reason", { code: c }),
          }))}
          onChange={(e) => setCode(e.target.value)}
          error={errorFor(result, "reasonCode")}
        />
      ) : null}
      {code === "other" ? (
        <TextArea
          id={ids.reasonNote}
          name="reasonNote"
          label={t("medicines.round.form.reasonNote")}
          rows={2}
          maxLength={2000}
          formatCount={count}
          error={errorFor(result, "reasonNote")}
        />
      ) : null}
      {outcomeTakesAmount(outcome) ? (
        <>
          <TextField
            id={ids.quantity}
            name="quantity"
            label={
              unitName
                ? t("medicines.round.form.quantity", { unit: unitName })
                : t("medicines.round.form.quantityNoUnit")
            }
            hint={t("medicines.round.form.quantityHint")}
            inputMode="decimal"
            defaultValue={offeredQuantity}
            error={errorFor(result, "quantity")}
          />
          <TextArea
            id={ids.amountDifferenceReason}
            name="amountDifferenceReason"
            label={t("medicines.round.form.amountDifferenceReason")}
            hint={t("medicines.round.form.askedHint")}
            rows={2}
            maxLength={2000}
            formatCount={count}
            error={errorFor(result, "amountDifferenceReason")}
          />
        </>
      ) : null}
      {outcome === "given" && covertOffered ? (
        <Checkbox
          id={ids.covert}
          name="covert"
          value="yes"
          label={t("medicines.round.form.covert")}
          hint={t("medicines.round.form.covertHint")}
          error={errorFor(result, "covert")}
        />
      ) : null}
      {outcome ? (
        <>
          <TextArea
            id={ids.timingReason}
            name="timingReason"
            label={t("medicines.round.form.timingReason")}
            hint={t("medicines.round.form.askedHint")}
            rows={2}
            maxLength={2000}
            formatCount={count}
            error={errorFor(result, "timingReason")}
          />
          {dueAt === null ? (
            <TextArea
              id={ids.intervalOverrideReason}
              name="intervalOverrideReason"
              label={t("medicines.round.form.intervalOverrideReason")}
              hint={t("medicines.round.form.askedHint")}
              rows={2}
              maxLength={2000}
              formatCount={count}
              error={errorFor(result, "intervalOverrideReason")}
            />
          ) : null}
        </>
      ) : null}
      <div>
        <Button type="submit" icon={<ClipboardCheck {...icon} />} disabled={pending}>
          {pending ? t("common.saving") : t("medicines.round.form.submit")}
        </Button>
      </div>
      <FormFeedback result={result} success={t("medicines.round.form.done")} fieldIds={ids} />
    </form>
  );
}
