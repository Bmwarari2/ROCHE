"use client";

import {
  Button,
  Checkbox,
  DateInput,
  RadioGroup,
  SelectField,
  TextArea,
  TextField,
} from "@harbour/ui";
import { CircleAlert, ClipboardPlus, Save, ShieldCheck, Siren } from "lucide-react";
import { useRouter } from "next/navigation";
import {
  closeOutbreak,
  declareOutbreak,
  recordOutbreakCase,
  updateOutbreak,
} from "@/app/actions/outbreaks";
import { FormFeedback } from "@/components/care/FormFeedback";
import { useFieldIds } from "@/components/care/form-state";
import { characterCount, t } from "@/lib/i18n";
import {
  CLOSE_REASON_MAX,
  OUTBREAK_OUTCOMES,
  OUTBREAK_SYMPTOMS,
  OUTBREAK_SYNDROMES,
  OUTBREAK_TEST_RESULTS,
  OUTBREAK_TEST_TYPES,
  readCloseOutbreak,
  readDeclareOutbreak,
  readRecordCase,
  readUpdateOutbreak,
  VACCINATION_ANSWERS,
} from "@/lib/outbreaks";
import { errorFor, partsFor } from "@/lib/outcome";
import { dateBoxesOf, dateTimeLabels } from "@/lib/uk-time";
import { useSubmit } from "./use-submit";

const icon = { size: 18, strokeWidth: 1.5, "aria-hidden": true } as const;
type Place = { readonly id: string; readonly name: string };

/** Declaring an outbreak of one illness at a home; the UKHSA report and its clock start with it. */
export function DeclareOutbreakForm({
  locations,
  locationId,
}: {
  readonly locations: readonly Place[];
  readonly locationId: string | null;
}) {
  const router = useRouter();
  const ids = useFieldIds(["locationId", "syndrome", "organism", "hptReference"]);
  const { submit, result, pending } = useSubmit(
    (form) => readDeclareOutbreak(form, t),
    declareOutbreak,
    (data) => {
      const declared = data as { id?: string };
      if (declared.id) router.push(`/outbreaks/${declared.id}`);
    },
  );
  return (
    <form method="post" className="flex flex-col gap-4" onSubmit={submit} noValidate>
      <SelectField
        id={ids.locationId}
        name="locationId"
        label={t("outbreaks.form.location")}
        defaultValue={locationId ?? locations[0]?.id ?? ""}
        options={locations.map((l) => ({ value: l.id, label: l.name }))}
        error={errorFor(result, "locationId")}
      />
      <RadioGroup
        id={ids.syndrome}
        name="syndrome"
        legend={t("outbreaks.form.syndrome")}
        options={OUTBREAK_SYNDROMES.map((value) => ({
          value,
          label: t("outbreaks.syndrome", { value }),
        }))}
        error={errorFor(result, "syndrome")}
      />
      <TextField
        id={ids.organism}
        name="organism"
        label={t("outbreaks.form.organism")}
        hint={t("outbreaks.form.organismHint")}
        autoComplete="off"
        error={errorFor(result, "organism")}
      />
      <TextField
        id={ids.hptReference}
        name="hptReference"
        label={t("outbreaks.form.reference")}
        hint={t("outbreaks.form.referenceHint")}
        autoComplete="off"
        error={errorFor(result, "hptReference")}
      />
      <div>
        <Button type="submit" icon={<Siren {...icon} />} disabled={pending}>
          {pending ? t("common.saving") : t("outbreaks.form.submit")}
        </Button>
      </div>
      <FormFeedback result={result} success={t("outbreaks.form.done")} fieldIds={ids} />
    </form>
  );
}

/** The organism and the health protection team's reference, as they become known. */
export function UpdateOutbreakForm({
  id,
  version,
  organism,
  hptReference,
}: {
  readonly id: string;
  readonly version: number;
  readonly organism: string | null;
  readonly hptReference: string | null;
}) {
  const ids = useFieldIds(["organism", "hptReference"]);
  const { submit, result, pending } = useSubmit(
    (form) => readUpdateOutbreak(form, t, { version }),
    (body) => updateOutbreak(id, body),
  );
  return (
    <form method="post" className="flex flex-col gap-4" onSubmit={submit} noValidate>
      <TextField
        id={ids.organism}
        name="organism"
        label={t("outbreaks.form.organism")}
        hint={t("outbreaks.form.organismHint")}
        defaultValue={organism ?? ""}
        autoComplete="off"
        error={errorFor(result, "organism")}
      />
      <TextField
        id={ids.hptReference}
        name="hptReference"
        label={t("outbreaks.form.reference")}
        hint={t("outbreaks.form.referenceHint")}
        defaultValue={hptReference ?? ""}
        autoComplete="off"
        error={errorFor(result, "hptReference")}
      />
      <div>
        <Button type="submit" variant="secondary" icon={<Save {...icon} />} disabled={pending}>
          {pending ? t("common.saving") : t("outbreaks.update.submit")}
        </Button>
      </div>
      <FormFeedback result={result} success={t("outbreaks.update.done")} fieldIds={ids} />
    </form>
  );
}

const choose = (list: readonly string[], key: "outbreaks.testType" | "outbreaks.testResult") =>
  list.map((value) => ({ value, label: t(key, { value }) }));

/** A resident's row on the line list: onset, symptoms, test, vaccination and how they are. */
export function RecordCaseForm({
  id,
  people,
}: {
  readonly id: string;
  readonly people: readonly Place[];
}) {
  const ids = useFieldIds([
    "personId",
    "onsetOn",
    "symptoms",
    "testType",
    "testedOn",
    "testResult",
    "fluVaccinated",
    "covidVaccinated",
    "outcome",
    "outcomeOn",
  ]);
  const { submit, result, pending } = useSubmit(
    (form) => readRecordCase(form, t),
    (body) => recordOutbreakCase(id, body),
    (_data, form) => form.reset(),
  );
  const symptomsError = errorFor(result, "symptoms");
  return (
    <form method="post" className="flex flex-col gap-4" onSubmit={submit} noValidate>
      <SelectField
        id={ids.personId}
        name="personId"
        label={t("outbreaks.case.person")}
        defaultValue={people[0]?.id ?? ""}
        options={people.map((p) => ({ value: p.id, label: p.name }))}
        error={errorFor(result, "personId")}
      />
      <DateInput
        id={ids.onsetOn}
        name="onsetOn"
        legend={t("outbreaks.case.onset")}
        hint={t("care.date.hint")}
        labels={dateTimeLabels(t)}
        error={errorFor(result, "onsetOn")}
        errorParts={dateBoxesOf(partsFor(result, "onsetOn"))}
      />
      <fieldset
        className="m-0 flex flex-col gap-1 border-0 p-0"
        {...(symptomsError ? { "aria-describedby": `${ids.symptoms}-error` } : {})}
      >
        <legend className="mb-2 text-body font-semibold">{t("outbreaks.case.symptoms")}</legend>
        {symptomsError ? (
          <p
            id={`${ids.symptoms}-error`}
            className="m-0 flex items-center gap-2 text-body-dense font-semibold text-danger"
          >
            <CircleAlert {...icon} />
            {symptomsError}
          </p>
        ) : null}
        {OUTBREAK_SYMPTOMS.map((value, index) => (
          <Checkbox
            key={value}
            // The first box carries the field's id, so the error summary's link focuses it.
            {...(index === 0 ? { id: ids.symptoms } : {})}
            name="symptoms"
            value={value}
            label={t("outbreaks.symptom", { value })}
            {...(symptomsError ? { "aria-invalid": true } : {})}
          />
        ))}
      </fieldset>
      <SelectField
        id={ids.testResult}
        name="testResult"
        label={t("outbreaks.case.testResult")}
        defaultValue="not_tested"
        options={choose(OUTBREAK_TEST_RESULTS, "outbreaks.testResult")}
      />
      <SelectField
        id={ids.testType}
        name="testType"
        label={t("outbreaks.case.testType")}
        hint={t("outbreaks.case.testTypeHint")}
        defaultValue=""
        options={[
          { value: "", label: t("outbreaks.case.choose") },
          ...choose(OUTBREAK_TEST_TYPES, "outbreaks.testType"),
        ]}
        error={errorFor(result, "testType")}
      />
      <DateInput
        id={ids.testedOn}
        name="testedOn"
        legend={t("outbreaks.case.testedOn")}
        hint={t("outbreaks.case.optionalDateHint")}
        labels={dateTimeLabels(t)}
        error={errorFor(result, "testedOn")}
        errorParts={dateBoxesOf(partsFor(result, "testedOn"))}
      />
      {(["fluVaccinated", "covidVaccinated"] as const).map((name) => (
        <RadioGroup
          key={name}
          id={ids[name]}
          name={name}
          legend={t("outbreaks.case.vaccinated", { vaccine: name })}
          defaultValue="unknown"
          options={VACCINATION_ANSWERS.map((value) => ({
            value,
            label: t("outbreaks.vaccination", { value }),
          }))}
        />
      ))}
      <RadioGroup
        id={ids.outcome}
        name="outcome"
        legend={t("outbreaks.case.outcome")}
        defaultValue="unwell"
        options={OUTBREAK_OUTCOMES.map((value) => ({
          value,
          label: t("outbreaks.outcome", { value }),
        }))}
      />
      <DateInput
        id={ids.outcomeOn}
        name="outcomeOn"
        legend={t("outbreaks.case.outcomeOn")}
        hint={t("outbreaks.case.outcomeOnHint")}
        labels={dateTimeLabels(t)}
        error={errorFor(result, "outcomeOn")}
        errorParts={dateBoxesOf(partsFor(result, "outcomeOn"))}
      />
      <div>
        <Button type="submit" icon={<ClipboardPlus {...icon} />} disabled={pending}>
          {pending ? t("common.saving") : t("outbreaks.case.submit")}
        </Button>
      </div>
      <FormFeedback result={result} success={t("outbreaks.case.done")} fieldIds={ids} />
    </form>
  );
}

/**
 * Closing the outbreak when the health protection team agrees it is over: a date, a reason, and
 * how many cases are still unwell, said before closing. Closing is final.
 */
export function CloseOutbreakForm({
  id,
  version,
  stillUnwell,
}: {
  readonly id: string;
  readonly version: number;
  readonly stillUnwell: number;
}) {
  const ids = useFieldIds(["closedOn", "reason"]);
  const { submit, result, pending } = useSubmit(
    (form) => readCloseOutbreak(form, t, { version }),
    (body) => closeOutbreak(id, body),
    undefined,
    t("outbreaks.close.done"),
  );
  return (
    <form method="post" className="flex flex-col gap-4" onSubmit={submit} noValidate>
      <p className="m-0">{t("outbreaks.close.stillUnwell", { count: stillUnwell })}</p>
      <p className="m-0">{t("outbreaks.close.final")}</p>
      <DateInput
        id={ids.closedOn}
        name="closedOn"
        legend={t("outbreaks.close.date")}
        hint={t("care.date.hint")}
        labels={dateTimeLabels(t)}
        error={errorFor(result, "closedOn")}
        errorParts={dateBoxesOf(partsFor(result, "closedOn"))}
      />
      <TextArea
        id={ids.reason}
        name="reason"
        label={t("outbreaks.close.reason")}
        hint={t("outbreaks.close.reasonHint")}
        rows={3}
        maxLength={CLOSE_REASON_MAX}
        formatCount={(remaining) => characterCount(remaining)}
        error={errorFor(result, "reason")}
      />
      <div>
        <Button
          type="submit"
          variant="secondary"
          icon={<ShieldCheck {...icon} />}
          disabled={pending}
        >
          {pending ? t("common.saving") : t("outbreaks.close.submit")}
        </Button>
      </div>
      <FormFeedback result={result} success={t("outbreaks.close.done")} fieldIds={ids} />
    </form>
  );
}
