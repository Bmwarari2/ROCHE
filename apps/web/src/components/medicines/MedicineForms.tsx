"use client";

import {
  Button,
  Checkbox,
  DateInput,
  DateTimeInput,
  RadioGroup,
  SelectField,
  TextArea,
  TextField,
} from "@harbour/ui";
import { Ban, ClipboardCheck, Pill, Search } from "lucide-react";
import { useRouter } from "next/navigation";
import { type FormEvent, type ReactNode, useEffect, useId, useState, useTransition } from "react";
import {
  checkMedicine,
  searchProducts,
  stopMedicine,
  transcribeMedicine,
} from "@/app/actions/medicines";
import { FormFeedback } from "@/components/care/FormFeedback";
import { useFieldIds } from "@/components/care/form-state";
import { t } from "@/lib/i18n";
import {
  DOSE_KINDS,
  entryHref,
  type FormWithAll,
  PATTERNS,
  type ProductHit,
  type Read,
  readCheck,
  readStop,
  readTranscription,
  SOURCE_KINDS,
  TIME_SLOTS,
  WEEKDAYS,
} from "@/lib/medicines";
import { type ActionResult, errorFor, fieldErrors } from "@/lib/outcome";
import { dateTimeLabels, ukRepeatedTime } from "@/lib/uk-time";

/**
 * The medicines record forms (MEDS-001; medicines.md section 13 rules 3 to 5). Each is read here
 * first, so a mistake is said at its field; the API runs every medicines rule again and its words
 * are shown as they are. A dose is sent exactly as typed. The person's allergies are shown beside
 * the product (passed in as `allergies`), never matched to it by Harbour.
 */

const icon = { size: 18, strokeWidth: 1.5, "aria-hidden": true } as const;
const dateLabels = {
  day: t("care.date.day"),
  month: t("care.date.month"),
  year: t("care.date.year"),
};

/** Sends a read form; on success refreshes the page and runs `after`. */
export function useMedicineSubmit<T, R>(
  read: (form: FormWithAll) => Read<T>,
  act: (body: T) => Promise<ActionResult<R>>,
  after?: (data: R) => void,
) {
  const router = useRouter();
  const [result, setResult] = useState<ActionResult<unknown> | null>(null);
  const [pending, startTransition] = useTransition();
  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const parsed = read(new FormData(event.currentTarget));
    if (!parsed.ok) return setResult(fieldErrors(parsed.errors));
    startTransition(async () => {
      const outcome = await act(parsed.body);
      setResult(outcome);
      if (outcome.ok) {
        after?.(outcome.data);
        router.refresh();
      }
    });
  };
  return { result, pending, submit };
}

/** Finds a product in dm+d and keeps the one chosen; the parent receives it. */
export function ProductPicker({
  chosen,
  onChoose,
  error,
  allergies,
}: {
  readonly chosen: ProductHit | null;
  readonly onChoose: (product: ProductHit | null) => void;
  readonly error?: string | undefined;
  readonly allergies: ReactNode;
}) {
  const id = useId();
  const [query, setQuery] = useState("");
  const [found, setFound] = useState<ProductHit[] | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();
  const search = () =>
    startTransition(async () => {
      const outcome = await searchProducts(query);
      if (!outcome.ok || !outcome.data) {
        setFound(null);
        setMessage(outcome.ok ? t("medicines.search.failed") : outcome.message);
        return;
      }
      setFound(outcome.data.items);
      setMessage(
        !outcome.data.loaded
          ? t("medicines.search.notLoaded")
          : t("medicines.search.found", { count: outcome.data.items.length }),
      );
    });
  return (
    <fieldset className="m-0 flex flex-col gap-3 border-0 p-0" id={`${id}-product`}>
      <legend className="mb-2 font-semibold">{t("medicines.form.product")}</legend>
      <div className="flex flex-wrap items-end gap-3">
        <TextField
          id={`${id}-query`}
          name="productQuery"
          label={t("medicines.search.label")}
          hint={t("medicines.search.hint")}
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault();
              search();
            }
          }}
          autoComplete="off"
          error={chosen ? undefined : error}
        />
        <Button
          type="button"
          variant="secondary"
          icon={<Search {...icon} />}
          onClick={search}
          disabled={pending}
        >
          {t("medicines.search.submit")}
        </Button>
      </div>
      <p role="status" className="m-0">
        {message ?? ""}
      </p>
      {found && found.length > 0 ? (
        <RadioGroup
          id={`${id}-results`}
          name="vmpId"
          legend={t("medicines.search.results")}
          options={found.map((p) => ({ value: p.vmpId, label: p.name }))}
          {...(chosen ? { defaultValue: chosen.vmpId } : {})}
          onValueChange={(value: string) => onChoose(found.find((p) => p.vmpId === value) ?? null)}
        />
      ) : null}
      {chosen ? (
        <div className="flex flex-col gap-2 rounded-input border border-border p-3">
          <p className="m-0 flex items-center gap-2 font-semibold">
            <Pill {...icon} />
            {t("medicines.form.chosen", { name: chosen.name })}
          </p>
          {allergies}
        </div>
      ) : null}
    </fieldset>
  );
}

/** What a version says (product, route, directions, dates, prescriber): shared by transcription and reconciliation. */
export function DraftFields({
  product,
  onProduct,
  result,
  ids,
  allergies,
}: {
  readonly product: ProductHit | null;
  readonly onProduct: (p: ProductHit | null) => void;
  readonly result: ActionResult<unknown> | null;
  readonly ids: Readonly<Record<string, string>>;
  readonly allergies: ReactNode;
}) {
  const [directionsKind, setDirectionsKind] = useState("regular");
  const [doseKind, setDoseKind] = useState("amount");
  const [pattern, setPattern] = useState("every_day");
  const err = (name: string) => errorFor(result, name);
  const doseFields = (prefix: string, label: string) =>
    doseKind === "variable" ? null : doseKind === "range" ? (
      <div className="flex flex-wrap gap-3">
        <TextField
          id={`${ids.form}-${prefix}from`}
          name={`${prefix}from`}
          label={t("medicines.form.from", { label })}
          inputMode="decimal"
          autoComplete="off"
          error={err(`${prefix}from`)}
        />
        <TextField
          id={`${ids.form}-${prefix}to`}
          name={`${prefix}to`}
          label={t("medicines.form.to", { label })}
          inputMode="decimal"
          autoComplete="off"
        />
      </div>
    ) : (
      <TextField
        id={`${ids.form}-${prefix}quantity`}
        name={`${prefix}quantity`}
        label={t("medicines.form.quantity", { label })}
        hint={t("medicines.form.quantityHint")}
        inputMode="decimal"
        autoComplete="off"
        error={err(`${prefix}quantity`)}
      />
    );
  return (
    <>
      <ProductPicker
        chosen={product}
        onChoose={onProduct}
        error={err("product")}
        allergies={allergies}
      />
      <SelectField
        id={ids.route}
        name="route"
        label={t("medicines.form.route")}
        hint={t("medicines.form.fromDmd")}
        defaultValue=""
        emptyOption={t("medicines.form.choose")}
        options={(product?.permittedRoutes ?? []).map((r) => ({ value: r.code, label: r.name }))}
        error={err("route")}
      />
      <SelectField
        id={ids.unit}
        name="unit"
        label={t("medicines.form.unit")}
        hint={t("medicines.form.fromDmd")}
        defaultValue=""
        emptyOption={t("medicines.form.choose")}
        options={(product?.permittedDoseUnits ?? []).map((u) => ({ value: u.code, label: u.name }))}
        error={err("unit")}
      />
      <RadioGroup
        id={ids.doseKind}
        name="doseKind"
        legend={t("medicines.form.doseKind")}
        options={DOSE_KINDS.map((k) => ({ value: k, label: t("medicines.doseKind", { kind: k }) }))}
        defaultValue="amount"
        onValueChange={setDoseKind}
        error={err("doseKind")}
      />
      <RadioGroup
        id={ids.directionsKind}
        name="directionsKind"
        legend={t("medicines.form.directions")}
        options={["regular", "when_required"].map((k) => ({
          value: k,
          label: t("medicines.directionsKind", { kind: k }),
        }))}
        defaultValue="regular"
        onValueChange={setDirectionsKind}
        error={err("directionsKind")}
      />
      {directionsKind === "when_required" ? (
        doseFields("prn-", t("medicines.form.eachDose"))
      ) : (
        <fieldset className="m-0 flex flex-col gap-3 border-0 p-0">
          <legend className="mb-2 font-semibold">{t("medicines.form.schedule")}</legend>
          <SelectField
            id={ids.pattern}
            name="pattern"
            label={t("medicines.form.pattern")}
            defaultValue="every_day"
            options={PATTERNS.map((p) => ({
              value: p,
              label: t("medicines.pattern", { pattern: p }),
            }))}
            onChange={(e) => setPattern(e.target.value)}
            error={err("pattern")}
          />
          {pattern === "every_n_days" ? (
            <TextField
              id={ids.intervalDays}
              name="intervalDays"
              label={t("medicines.form.intervalDays")}
              inputMode="numeric"
              error={err("intervalDays")}
            />
          ) : null}
          {pattern === "weekly" ? (
            <>
              <fieldset
                id={ids.weekdays}
                tabIndex={-1}
                className="m-0 flex flex-col gap-1 border-0 p-0"
              >
                <legend className="mb-2">{t("medicines.form.weekdays")}</legend>
                {err("weekdays") ? <p className="hb-field__error m-0">{err("weekdays")}</p> : null}
                {WEEKDAYS.map((d) => (
                  <Checkbox
                    key={d}
                    name="weekdays"
                    value={d}
                    label={t("medicines.weekday", { day: d })}
                  />
                ))}
              </fieldset>
              <TextField
                id={ids.intervalWeeks}
                name="intervalWeeks"
                label={t("medicines.form.intervalWeeks")}
                defaultValue="1"
                inputMode="numeric"
                error={err("intervalWeeks")}
              />
            </>
          ) : null}
          {pattern === "every_n_days" || pattern === "weekly" ? (
            <DateInput
              id={ids.anchorOn}
              name="anchorOn"
              legend={t("medicines.form.anchorOn")}
              hint={t("medicines.form.anchorHint")}
              labels={dateLabels}
              error={err("anchorOn")}
            />
          ) : null}
          {pattern === "monthly" ? (
            <TextField
              id={ids.dayOfMonth}
              name="dayOfMonth"
              label={t("medicines.form.dayOfMonth")}
              inputMode="numeric"
              error={err("dayOfMonth")}
            />
          ) : null}
          <p className="m-0 text-body-dense">
            {t("medicines.form.timesHint", { slots: TIME_SLOTS })}
          </p>
          {Array.from({ length: TIME_SLOTS }, (_, i) => i + 1).map((slot) => (
            <fieldset key={slot} className="m-0 flex flex-wrap gap-3 border-0 p-0">
              <legend className="mb-1 text-body-dense font-semibold">
                {t("medicines.form.timeSlot", { slot })}
              </legend>
              <TextField
                id={slot === 1 ? ids["time-1"] : `${ids.form}-time-${slot}`}
                name={`time-${slot}`}
                label={t("medicines.form.time")}
                hint={t("medicines.form.timeHint")}
                autoComplete="off"
                error={err(`time-${slot}`)}
              />
              {doseFields(`slot-${slot}-`, t("medicines.form.atThisTime"))}
            </fieldset>
          ))}
        </fieldset>
      )}
      <TextField
        id={ids.prescriber}
        name="prescriber"
        label={t("medicines.form.prescriber")}
        hint={t("medicines.form.prescriberHint")}
        autoComplete="off"
        error={err("prescriber")}
      />
      <DateTimeInput
        id={ids.startsAt}
        name="startsAt"
        legend={t("medicines.form.startsAt")}
        labels={dateTimeLabels(t)}
        repeated={ukRepeatedTime}
        error={err("startsAt")}
      />
      <DateTimeInput
        id={ids.stopsAt}
        name="stopsAt"
        legend={t("medicines.form.stopsAt")}
        hint={t("medicines.form.optional")}
        labels={dateTimeLabels(t)}
        repeated={ukRepeatedTime}
        error={err("stopsAt")}
      />
      <DateInput
        id={ids.reviewOn}
        name="reviewOn"
        legend={t("medicines.form.reviewOn")}
        hint={t("medicines.form.optional")}
        labels={dateLabels}
        error={err("reviewOn")}
      />
      <TextArea
        id={ids.indication}
        name="indication"
        label={t("medicines.form.indication")}
        hint={t("medicines.form.indicationHint")}
        rows={2}
        maxLength={1000}
      />
      <TextArea
        id={ids.specialInstructions}
        name="specialInstructions"
        label={t("medicines.form.specialInstructions")}
        hint={t("medicines.form.optional")}
        rows={2}
        maxLength={2000}
      />
    </>
  );
}

export const DRAFT_FIELDS = [
  "form",
  "product",
  "route",
  "unit",
  "doseKind",
  "directionsKind",
  "pattern",
  "intervalDays",
  "weekdays",
  "intervalWeeks",
  "anchorOn",
  "dayOfMonth",
  "time-1",
  "prn-quantity",
  "prn-from",
  "slot-1-quantity",
  "slot-1-from",
  "prescriber",
  "startsAt",
  "stopsAt",
  "reviewOn",
  "indication",
  "specialInstructions",
] as const;

/** Where a source document came from: its kind and reference. */
function SourceFields({
  ids,
  result,
  legend,
}: {
  readonly ids: Readonly<Record<string, string>>;
  readonly result: ActionResult<unknown> | null;
  readonly legend: string;
}) {
  return (
    <fieldset className="m-0 flex flex-col gap-3 border-0 p-0">
      <legend className="mb-2 font-semibold">{legend}</legend>
      <SelectField
        id={ids.sourceKind}
        name="sourceKind"
        label={t("medicines.form.sourceKind")}
        defaultValue=""
        emptyOption={t("medicines.form.choose")}
        options={SOURCE_KINDS.map((k) => ({
          value: k,
          label: t("medicines.sourceKind", { kind: k }),
        }))}
        error={errorFor(result, "sourceKind")}
      />
      <TextField
        id={ids.sourceReference}
        name="sourceReference"
        label={t("medicines.form.sourceReference")}
        hint={t("medicines.form.sourceReferenceHint")}
        autoComplete="off"
        error={errorFor(result, "sourceReference")}
      />
    </fieldset>
  );
}

/** A reason the API asked for, shown once it has (its words are the field's error). */
function AskedReason({
  id,
  name,
  label,
  result,
}: {
  readonly id: string;
  readonly name: string;
  readonly label: string;
  readonly result: ActionResult<unknown> | null;
}) {
  const asked = errorFor(result, name);
  const [shown, setShown] = useState(false);
  useEffect(() => {
    if (asked) setShown(true);
  }, [asked]);
  if (!asked && !shown) return null;
  return <TextArea id={id} name={name} label={label} rows={2} maxLength={2000} error={asked} />;
}

/** Transcribing a new medicine from its source. */
export function TranscribeForm({
  personId,
  allergies,
}: {
  readonly personId: string;
  readonly allergies: ReactNode;
}) {
  const ids = useFieldIds([
    ...DRAFT_FIELDS,
    "sourceKind",
    "sourceReference",
    "reanchorReason",
    "earlierDosesDueReason",
  ]);
  const router = useRouter();
  const [product, setProduct] = useState<ProductHit | null>(null);
  const { result, pending, submit } = useMedicineSubmit(
    (form) => readTranscription(form, t, product),
    (body) => transcribeMedicine(personId, body),
    (entry) => {
      if (entry) router.push(`${entryHref(personId, entry.id)}?done=transcribed&at=${Date.now()}`);
    },
  );
  return (
    <form method="post" className="flex flex-col gap-4" onSubmit={submit} noValidate>
      <p className="m-0 max-w-prose" id={ids.form}>
        {t("medicines.form.intro")}
      </p>
      <DraftFields
        product={product}
        onProduct={setProduct}
        result={result}
        ids={ids}
        allergies={allergies}
      />
      <SourceFields ids={ids} result={result} legend={t("medicines.form.source")} />
      <TextArea
        id={ids.earlierDosesDueReason}
        name="earlierDosesDueReason"
        label={t("medicines.form.earlierDoses")}
        hint={t("medicines.form.earlierDosesHint")}
        rows={2}
        maxLength={2000}
      />
      <AskedReason
        id={ids.reanchorReason}
        name="reanchorReason"
        label={t("medicines.form.reanchorReason")}
        result={result}
      />
      <div>
        <Button type="submit" icon={<Pill {...icon} />} disabled={pending}>
          {pending ? t("common.saving") : t("medicines.form.submit")}
        </Button>
      </div>
      <FormFeedback result={result} success={t("medicines.form.done")} fieldIds={ids} />
    </form>
  );
}

/** The second check by someone other than the transcriber, against the source itself. */
export function CheckForm({
  personId,
  entryId,
  source,
  allergies,
}: {
  readonly personId: string;
  readonly entryId: string;
  readonly source: string;
  readonly allergies: ReactNode;
}) {
  const ids = useFieldIds(["comparedWithSource", "outcome", "difference"]);
  const [outcome, setOutcome] = useState("");
  const { result, pending, submit } = useMedicineSubmit(
    (form) => readCheck(form, t),
    (body) => checkMedicine(personId, entryId, body),
  );
  return (
    <form method="post" className="flex flex-col gap-4" onSubmit={submit} noValidate>
      <p className="m-0 max-w-prose">{t("medicines.check.intro", { source })}</p>
      {allergies}
      <Checkbox
        id={ids.comparedWithSource}
        name="comparedWithSource"
        value="yes"
        required
        label={t("medicines.check.compared")}
        error={errorFor(result, "comparedWithSource")}
      />
      <RadioGroup
        id={ids.outcome}
        name="outcome"
        legend={t("medicines.check.outcome")}
        options={["matches_source", "differs_from_source"].map((o) => ({
          value: o,
          label: t("medicines.check.outcomeOption", { outcome: o }),
        }))}
        onValueChange={setOutcome}
        error={errorFor(result, "outcome")}
      />
      {outcome === "differs_from_source" ? (
        <TextArea
          id={ids.difference}
          name="difference"
          label={t("medicines.check.difference")}
          hint={t("medicines.check.differenceHint")}
          rows={3}
          maxLength={2000}
          error={errorFor(result, "difference")}
        />
      ) : null}
      <div>
        <Button type="submit" icon={<ClipboardCheck {...icon} />} disabled={pending}>
          {pending ? t("common.saving") : t("medicines.check.submit")}
        </Button>
      </div>
      <FormFeedback result={result} success={t("medicines.check.done")} fieldIds={ids} />
    </form>
  );
}

/** Stopping a medicine: when, why, and the source of the instruction. */
export function StopForm({
  personId,
  entryId,
  version,
}: {
  readonly personId: string;
  readonly entryId: string;
  readonly version: number;
}) {
  const ids = useFieldIds([
    "effectiveAt",
    "reason",
    "sourceKind",
    "sourceReference",
    "withdrawLaterReason",
  ]);
  const { result, pending, submit } = useMedicineSubmit(
    (form) => readStop(form, t, version),
    (body) => stopMedicine(personId, entryId, body),
  );
  return (
    <form method="post" className="flex flex-col gap-4" onSubmit={submit} noValidate>
      <p className="m-0 max-w-prose">{t("medicines.stop.intro")}</p>
      <DateTimeInput
        id={ids.effectiveAt}
        name="effectiveAt"
        legend={t("medicines.stop.when")}
        labels={dateTimeLabels(t)}
        repeated={ukRepeatedTime}
        error={errorFor(result, "effectiveAt")}
      />
      <TextArea
        id={ids.reason}
        name="reason"
        label={t("medicines.stop.reason")}
        rows={3}
        maxLength={2000}
        error={errorFor(result, "reason")}
      />
      <SourceFields ids={ids} result={result} legend={t("medicines.stop.source")} />
      <AskedReason
        id={ids.withdrawLaterReason}
        name="withdrawLaterReason"
        label={t("medicines.form.withdrawLaterReason")}
        result={result}
      />
      <div>
        <Button type="submit" variant="destructive" icon={<Ban {...icon} />} disabled={pending}>
          {pending ? t("common.saving") : t("medicines.stop.submit")}
        </Button>
      </div>
      <FormFeedback result={result} success={t("medicines.stop.done")} fieldIds={ids} />
    </form>
  );
}
