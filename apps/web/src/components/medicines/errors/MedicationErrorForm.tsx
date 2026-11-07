"use client";

import {
  Button,
  Checkbox,
  DateInput,
  DateTimeInput,
  dateTimePartsAt,
  RadioGroup,
  SelectField,
  TextArea,
  TextField,
} from "@harbour/ui";
import { ClipboardCheck } from "lucide-react";
import { addMedicationError, changeMedicationError } from "@/app/actions/medication-errors";
import { FormFeedback } from "@/components/care/FormFeedback";
import { useFieldIds } from "@/components/care/form-state";
import { useArrival, useMedicineSubmit } from "@/components/medicines/MedicineForms";
import { characterCount, t } from "@/lib/i18n";
import {
  ANSWERS,
  CD_REFERENCE_MAX,
  type EditMedicationErrorBody,
  ERROR_KINDS,
  ERROR_STAGES,
  ERROR_TEXT_MAX,
  type MedicationError,
  medicationErrorHref,
  type NewMedicationErrorBody,
  readEditMedicationError,
  readNewMedicationError,
} from "@/lib/medication-errors";
import type { FormWithAll } from "@/lib/medicines";
import { errorFor } from "@/lib/outcome";
import { dateTimeLabels, ukRepeatedTime } from "@/lib/uk-time";

const icon = { size: 18, strokeWidth: 1.5, "aria-hidden": true } as const;
const count = (remaining: number) => characterCount(remaining);
const dateLabels = {
  day: t("care.date.day"),
  month: t("care.date.month"),
  year: t("care.date.year"),
};

export interface Choice {
  readonly value: string;
  readonly label: string;
}

const FIELDS = [
  "personId",
  "medicationId",
  "administrationId",
  "kinds",
  "stage",
  "reachedPerson",
  "controlledDrug",
  "deliberateOrRepeated",
  "immediateActions",
  "clinicianToldAt",
  "clinicianTold",
  "adviceGiven",
  "rootCause",
  "cdReportedOn",
  "cdReportReference",
] as const;

/**
 * The medication error details on a medication incident (slice 55; MEDS-012; medicines.md section
 * 14.1; HZ-134): what went wrong (the NRLS kinds and stage), the medicine and dose record when
 * known, slice 7's three questions, what was done, who was told and their advice, the root cause and
 * the controlled drug report. Adding chooses the person from those on the incident; changing sends
 * the version read. The API decides again, presumes a controlled drug from the medicine's schedule,
 * and returns the escalations, which the page shows in its words. Nothing here is sent anywhere
 * else.
 */
export function MedicationErrorForm({
  incidentId,
  occurredAt,
  people,
  medicines,
  doseRecords,
  current,
}: {
  readonly incidentId: string;
  readonly occurredAt: string;
  /** The people we support on the incident; only for adding. */
  readonly people: readonly Choice[];
  /** The person's medicines entries, or null when they could not be read. */
  readonly medicines: readonly Choice[] | null;
  /** The person's dose records around the incident, or null when they could not be read. */
  readonly doseRecords: readonly Choice[] | null;
  readonly current: MedicationError | null;
}) {
  const ids = useFieldIds(FIELDS);
  const arrive = useArrival();
  const { result, pending, submit } = useMedicineSubmit<
    NewMedicationErrorBody | EditMedicationErrorBody,
    null
  >(
    (form: FormWithAll) =>
      current
        ? readEditMedicationError(form, t, { occurredAt, version: current.version })
        : readNewMedicationError(form, t, { occurredAt, personIds: people.map((p) => p.value) }),
    (body) =>
      "personId" in body
        ? addMedicationError(incidentId, body)
        : changeMedicationError(incidentId, body),
    () => arrive(medicationErrorHref(incidentId), current ? "changed" : "added"),
  );
  const err = (name: (typeof FIELDS)[number]) => errorFor(result, name);
  const kindsError = err("kinds");
  const answer = (name: "reachedPerson" | "controlledDrug" | "deliberateOrRepeated") => (
    <RadioGroup
      id={ids[name]}
      name={name}
      legend={t("medicines.errors.form.question", { question: name })}
      hint={t("medicines.errors.form.questionHint", { question: name })}
      layout="inline"
      options={ANSWERS.map((a) => ({
        value: a,
        label: t("medicines.errors.answer", { answer: a }),
      }))}
      {...(current?.[name] ? { defaultValue: current[name] } : {})}
      error={err(name)}
    />
  );
  /** A choice that cannot be listed now keeps what was recorded. */
  const keep = (name: "medicationId" | "administrationId") =>
    current?.[name] ? <input type="hidden" name={name} value={current[name] ?? ""} /> : null;

  return (
    <form method="post" className="flex flex-col gap-4" onSubmit={submit} noValidate>
      <p className="m-0 max-w-prose">{t("medicines.errors.form.intro")}</p>
      {current ? null : (
        <RadioGroup
          id={ids.personId}
          name="personId"
          legend={t("medicines.errors.form.person")}
          options={people.map((p) => ({ value: p.value, label: p.label }))}
          {...(people.length === 1 && people[0] ? { defaultValue: people[0].value } : {})}
          error={err("personId")}
        />
      )}
      <fieldset
        id={ids.kinds}
        tabIndex={-1}
        className="m-0 flex flex-col gap-1 border-0 p-0"
        {...(kindsError ? { "aria-describedby": `${ids.kinds}-error` } : {})}
      >
        <legend className="mb-2 font-semibold">{t("medicines.errors.form.kinds")}</legend>
        <p className="m-0 mb-2 text-body-dense">{t("medicines.errors.form.kindsHint")}</p>
        {kindsError ? (
          <p id={`${ids.kinds}-error`} className="hb-field__error m-0">
            {kindsError}
          </p>
        ) : null}
        {ERROR_KINDS.map((k) => (
          <Checkbox
            key={k}
            name="kinds"
            value={k}
            defaultChecked={current?.kinds.includes(k) ?? false}
            label={t("medicines.errors.kind", { kind: k })}
          />
        ))}
      </fieldset>
      <SelectField
        id={ids.stage}
        name="stage"
        label={t("medicines.errors.form.stage")}
        defaultValue={current?.stage ?? ""}
        emptyOption={t("medicines.errors.form.notKnown")}
        options={ERROR_STAGES.map((s) => ({
          value: s,
          label: t("medicines.errors.stage", { stage: s }),
        }))}
        error={err("stage")}
      />
      {medicines ? (
        <SelectField
          id={ids.medicationId}
          name="medicationId"
          label={t("medicines.errors.form.medicine")}
          hint={t("medicines.errors.form.medicineHint")}
          defaultValue={current?.medicationId ?? ""}
          emptyOption={t("medicines.errors.form.notKnown")}
          options={medicines}
          error={err("medicationId")}
        />
      ) : (
        <>
          <p className="m-0" id={ids.medicationId}>
            {t("medicines.errors.form.medicinesUnreadable")}
          </p>
          {keep("medicationId")}
        </>
      )}
      {doseRecords ? (
        <SelectField
          id={ids.administrationId}
          name="administrationId"
          label={t("medicines.errors.form.doseRecord")}
          hint={t("medicines.errors.form.doseRecordHint")}
          defaultValue={current?.administrationId ?? ""}
          emptyOption={t("medicines.errors.form.notKnown")}
          options={doseRecords}
          error={err("administrationId")}
        />
      ) : (
        <>
          <p className="m-0" id={ids.administrationId}>
            {t("medicines.errors.form.doseRecordsUnreadable")}
          </p>
          {keep("administrationId")}
        </>
      )}
      {answer("reachedPerson")}
      {answer("controlledDrug")}
      {answer("deliberateOrRepeated")}
      <TextArea
        id={ids.immediateActions}
        name="immediateActions"
        label={t("medicines.errors.form.immediateActions")}
        hint={t("medicines.errors.form.immediateActionsHint")}
        rows={3}
        maxLength={ERROR_TEXT_MAX}
        formatCount={count}
        defaultValue={current?.immediateActions ?? ""}
        error={err("immediateActions")}
      />
      <fieldset className="m-0 flex flex-col gap-3 border-0 p-0">
        <legend className="mb-2 font-semibold">{t("medicines.errors.form.clinician")}</legend>
        <p className="m-0 max-w-prose text-body-dense">
          {t("medicines.errors.form.clinicianHint")}
        </p>
        <TextField
          id={ids.clinicianTold}
          name="clinicianTold"
          label={t("medicines.errors.form.clinicianTold")}
          hint={t("medicines.errors.form.clinicianToldHint")}
          autoComplete="off"
          defaultValue={current?.clinicianTold ?? ""}
          error={err("clinicianTold")}
        />
        <DateTimeInput
          id={ids.clinicianToldAt}
          name="clinicianToldAt"
          legend={t("medicines.errors.form.clinicianToldAt")}
          labels={dateTimeLabels(t)}
          repeated={ukRepeatedTime}
          defaultValue={
            current?.clinicianToldAt ? dateTimePartsAt(Date.parse(current.clinicianToldAt)) : null
          }
          error={err("clinicianToldAt")}
        />
        <TextArea
          id={ids.adviceGiven}
          name="adviceGiven"
          label={t("medicines.errors.form.adviceGiven")}
          hint={t("medicines.errors.form.adviceGivenHint")}
          rows={3}
          maxLength={ERROR_TEXT_MAX}
          formatCount={count}
          defaultValue={current?.adviceGiven ?? ""}
          error={err("adviceGiven")}
        />
      </fieldset>
      <TextArea
        id={ids.rootCause}
        name="rootCause"
        label={t("medicines.errors.form.rootCause")}
        hint={t("medicines.errors.form.rootCauseHint")}
        rows={3}
        maxLength={ERROR_TEXT_MAX}
        formatCount={count}
        defaultValue={current?.rootCause ?? ""}
        error={err("rootCause")}
      />
      <fieldset className="m-0 flex flex-col gap-3 border-0 p-0">
        <legend className="mb-2 font-semibold">{t("medicines.errors.form.cdReport")}</legend>
        <p className="m-0 max-w-prose text-body-dense">{t("medicines.errors.form.cdReportHint")}</p>
        <DateInput
          id={ids.cdReportedOn}
          name="cdReportedOn"
          legend={t("medicines.errors.form.cdReportedOn")}
          labels={dateLabels}
          defaultValue={current?.cdReportedOn ?? null}
          error={err("cdReportedOn")}
        />
        <TextField
          id={ids.cdReportReference}
          name="cdReportReference"
          label={t("medicines.errors.form.cdReportReference")}
          maxLength={CD_REFERENCE_MAX}
          autoComplete="off"
          defaultValue={current?.cdReportReference ?? ""}
          error={err("cdReportReference")}
        />
      </fieldset>
      <div>
        <Button type="submit" icon={<ClipboardCheck {...icon} />} disabled={pending}>
          {pending
            ? t("common.saving")
            : t("medicines.errors.form.submit", { mode: current ? "change" : "add" })}
        </Button>
      </div>
      <FormFeedback
        result={result}
        success={t("medicines.errors.done", { done: current ? "changed" : "added" })}
        fieldIds={ids}
      />
    </form>
  );
}
