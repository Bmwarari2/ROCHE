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
import { Ban, ClipboardCheck, Pill, Plus, Search } from "lucide-react";
import { useRouter } from "next/navigation";
import { type FormEvent, type ReactNode, useEffect, useRef, useState, useTransition } from "react";
import {
  checkMedicine,
  searchProducts,
  stopMedicine,
  transcribeMedicine,
} from "@/app/actions/medicines";
import { FormFeedback } from "@/components/care/FormFeedback";
import { useFieldIds } from "@/components/care/form-state";
import { characterCount, t } from "@/lib/i18n";
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
 * are shown as they are. A dose is sent as the number typed, with dm+d's unit. The person and every
 * allergy are shown at the top of each form (`person`), never matched by Harbour. After a save the
 * page reloads at an address that says what was done, so the outcome is announced and focus is
 * not lost when the form itself goes (accessibility review of slice 52, H3).
 */

const icon = { size: 18, strokeWidth: 1.5, "aria-hidden": true } as const;
const dateLabels = {
  day: t("care.date.day"),
  month: t("care.date.month"),
  year: t("care.date.year"),
};
const count = (remaining: number) => characterCount(remaining);

/** Field keys of one dose time, for the error summary's links. */
const slotKeys = (slot: number) =>
  [`time-${slot}`, `slot-${slot}-quantity`, `slot-${slot}-from`, `slot-${slot}-to`] as const;

/** Every field the draft can show, so each error links to its field. */
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
  "prn-quantity",
  "prn-from",
  "prn-to",
  ...Array.from({ length: TIME_SLOTS }, (_, i) => slotKeys(i + 1)).flat(),
  "prescriber",
  "startsAt",
  "stopsAt",
  "reviewOn",
  "indication",
  "specialInstructions",
] as const;

/** Sends a read form; on success runs `after` (usually a reload at a `?done=` address). */
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
        if (after) after(outcome.data);
        else router.refresh();
      }
    });
  };
  return { result, pending, submit };
}

/** Reloads `path` saying what was done, so the page announces it and focuses its heading. */
export function useArrival() {
  const router = useRouter();
  return (path: string, done: string) => {
    router.push(`${path}?done=${done}&at=${Date.now()}`);
    router.refresh();
  };
}

/** Finds a medicine in the NHS medicines list (dm+d) and keeps the one chosen. */
export function ProductPicker({
  chosen,
  onChoose,
  error,
  inputId,
}: {
  readonly chosen: ProductHit | null;
  readonly onChoose: (product: ProductHit | null) => void;
  readonly error?: string | undefined;
  readonly inputId: string;
}) {
  const [query, setQuery] = useState("");
  const [found, setFound] = useState<ProductHit[] | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();
  const search = () => {
    if (pending) return;
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
  };
  const choose = (product: ProductHit | null) => {
    onChoose(product);
    if (product) setMessage(t("medicines.search.chosen", { name: product.name }));
  };
  return (
    <fieldset className="m-0 flex flex-col gap-3 border-0 p-0">
      <legend className="mb-2 font-semibold">{t("medicines.form.product")}</legend>
      <div className="flex flex-wrap items-end gap-3">
        <TextField
          id={inputId}
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
          aria-disabled={pending}
        >
          {t("medicines.search.submit")}
        </Button>
      </div>
      <p role="status" className="m-0">
        {message ?? ""}
      </p>
      {found && found.length > 0 ? (
        <RadioGroup
          id={`${inputId}-results`}
          name="vmpId"
          legend={t("medicines.search.results")}
          options={found.map((p) => ({ value: p.vmpId, label: p.name }))}
          {...(chosen ? { defaultValue: chosen.vmpId } : {})}
          onValueChange={(value: string) => choose(found.find((p) => p.vmpId === value) ?? null)}
        />
      ) : null}
      {chosen ? (
        <p className="m-0 flex items-center gap-2 rounded-input border border-border p-3 font-semibold">
          <Pill {...icon} />
          {t("medicines.form.chosen", { name: chosen.name })}
        </p>
      ) : null}
    </fieldset>
  );
}

/** One dose: an amount, a range, or nothing to type for "variable". */
function DoseFields({
  ids,
  prefix,
  kind,
  result,
  each,
}: {
  readonly ids: Readonly<Record<string, string>>;
  readonly prefix: string;
  readonly kind: string;
  readonly result: ActionResult<unknown> | null;
  /** True for a when-required dose ("each time"), false for a dose at a time. */
  readonly each: boolean;
}) {
  const err = (name: string) => errorFor(result, name);
  if (kind === "variable") {
    return <p className="m-0 text-body-dense">{t("medicines.form.variableHint")}</p>;
  }
  if (kind === "range") {
    return (
      <div className="flex flex-wrap gap-3">
        <TextField
          id={ids[`${prefix}from`]}
          name={`${prefix}from`}
          label={t("medicines.form.rangeFrom", { each: String(each) })}
          hint={t("medicines.form.inUnit")}
          inputMode="decimal"
          autoComplete="off"
          error={err(`${prefix}from`)}
        />
        <TextField
          id={ids[`${prefix}to`]}
          name={`${prefix}to`}
          label={t("medicines.form.rangeTo", { each: String(each) })}
          hint={t("medicines.form.inUnit")}
          inputMode="decimal"
          autoComplete="off"
          error={err(`${prefix}to`)}
        />
      </div>
    );
  }
  return (
    <TextField
      id={ids[`${prefix}quantity`]}
      name={`${prefix}quantity`}
      label={t("medicines.form.amount", { each: String(each) })}
      hint={t("medicines.form.quantityHint")}
      inputMode="decimal"
      autoComplete="off"
      error={err(`${prefix}quantity`)}
    />
  );
}

/**
 * What a version says (product, route, directions, dates, prescriber): shared by transcription and
 * reconciliation. Everything after the product starts again when the product changes, so a dose
 * typed for one strength is never carried to another (clinical review of slice 52, M7; HZ-005).
 */
export function DraftFields({
  product,
  onProduct,
  result,
  ids,
}: {
  readonly product: ProductHit | null;
  readonly onProduct: (p: ProductHit | null) => void;
  readonly result: ActionResult<unknown> | null;
  readonly ids: Readonly<Record<string, string>>;
}) {
  return (
    <>
      <ProductPicker
        chosen={product}
        onChoose={onProduct}
        error={errorFor(result, "product")}
        inputId={ids.product ?? "product"}
      />
      <DraftDetails key={product?.vmpId ?? "none"} product={product} result={result} ids={ids} />
    </>
  );
}

function DraftDetails({
  product,
  result,
  ids,
}: {
  readonly product: ProductHit | null;
  readonly result: ActionResult<unknown> | null;
  readonly ids: Readonly<Record<string, string>>;
}) {
  const [directionsKind, setDirectionsKind] = useState("regular");
  const [doseKind, setDoseKind] = useState("amount");
  const [pattern, setPattern] = useState("every_day");
  const [slots, setSlots] = useState(1);
  const added = useRef(false);
  useEffect(() => {
    if (!added.current) return;
    document.getElementById(ids[`time-${slots}`] ?? "")?.focus();
  }, [slots, ids]);
  // An error on a slot the form is not showing yet shows that slot.
  useEffect(() => {
    for (let slot = TIME_SLOTS; slot > slots; slot--) {
      if (slotKeys(slot).some((k) => errorFor(result, k))) {
        setSlots(slot);
        return;
      }
    }
  }, [result, slots]);
  const err = (name: string) => errorFor(result, name);
  return (
    <>
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
        <DoseFields ids={ids} prefix="prn-" kind={doseKind} result={result} each={true} />
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
                {...(err("weekdays") ? { "aria-describedby": `${ids.weekdays}-error` } : {})}
              >
                <legend className="mb-2">{t("medicines.form.weekdays")}</legend>
                {err("weekdays") ? (
                  <p id={`${ids.weekdays}-error`} className="hb-field__error m-0">
                    {err("weekdays")}
                  </p>
                ) : null}
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
          {Array.from({ length: slots }, (_, i) => i + 1).map((slot) => (
            <fieldset key={slot} className="m-0 flex flex-wrap gap-3 border-0 p-0">
              <legend className="mb-1 text-body-dense font-semibold">
                {t("medicines.form.timeSlot", { slot })}
              </legend>
              <TextField
                id={ids[`time-${slot}`]}
                name={`time-${slot}`}
                label={t("medicines.form.time")}
                hint={t("medicines.form.timeHint")}
                autoComplete="off"
                error={err(`time-${slot}`)}
              />
              <DoseFields
                ids={ids}
                prefix={`slot-${slot}-`}
                kind={doseKind}
                result={result}
                each={false}
              />
            </fieldset>
          ))}
          {slots < TIME_SLOTS ? (
            <div>
              <Button
                type="button"
                variant="secondary"
                icon={<Plus {...icon} />}
                onClick={() => {
                  added.current = true;
                  setSlots((n) => Math.min(TIME_SLOTS, n + 1));
                }}
              >
                {t("medicines.form.addTime")}
              </Button>
            </div>
          ) : (
            <p className="m-0 text-body-dense">
              {t("medicines.form.timesMax", { slots: TIME_SLOTS })}
            </p>
          )}
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
        formatCount={count}
        error={err("indication")}
      />
      <TextArea
        id={ids.specialInstructions}
        name="specialInstructions"
        label={t("medicines.form.specialInstructions")}
        hint={t("medicines.form.optional")}
        rows={2}
        maxLength={2000}
        formatCount={count}
        error={err("specialInstructions")}
      />
    </>
  );
}

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
export function AskedReason({
  id,
  name,
  label,
  result,
}: {
  readonly id: string | undefined;
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
  return (
    <TextArea
      id={id}
      name={name}
      label={label}
      rows={2}
      maxLength={2000}
      formatCount={count}
      error={asked}
    />
  );
}

/** Transcribing a new medicine from its source. */
export function TranscribeForm({
  personId,
  person,
}: {
  readonly personId: string;
  readonly person: ReactNode;
}) {
  const ids = useFieldIds([
    ...DRAFT_FIELDS,
    "sourceKind",
    "sourceReference",
    "reanchorReason",
    "earlierDosesDueReason",
  ]);
  const arrive = useArrival();
  const [product, setProduct] = useState<ProductHit | null>(null);
  const { result, pending, submit } = useMedicineSubmit(
    (form) => readTranscription(form, t, product),
    (body) => transcribeMedicine(personId, body),
    (entry) => {
      if (entry) arrive(entryHref(personId, entry.id), "transcribed");
    },
  );
  return (
    <form method="post" className="flex flex-col gap-4" onSubmit={submit} noValidate>
      <p className="m-0 max-w-prose" id={ids.form}>
        {t("medicines.form.intro")}
      </p>
      {person}
      <DraftFields product={product} onProduct={setProduct} result={result} ids={ids} />
      <SourceFields ids={ids} result={result} legend={t("medicines.form.source")} />
      <TextArea
        id={ids.earlierDosesDueReason}
        name="earlierDosesDueReason"
        label={t("medicines.form.earlierDoses")}
        hint={t("medicines.form.earlierDosesHint")}
        rows={2}
        maxLength={2000}
        formatCount={count}
        error={errorFor(result, "earlierDosesDueReason")}
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
  person,
}: {
  readonly personId: string;
  readonly entryId: string;
  readonly source: string;
  readonly person: ReactNode;
}) {
  const ids = useFieldIds(["comparedWithSource", "outcome", "difference"]);
  const arrive = useArrival();
  const [outcome, setOutcome] = useState("");
  const { result, pending, submit } = useMedicineSubmit(
    (form) => readCheck(form, t),
    (body) => checkMedicine(personId, entryId, body),
    () => arrive(entryHref(personId, entryId), "checked"),
  );
  return (
    <form method="post" className="flex flex-col gap-4" onSubmit={submit} noValidate>
      <p className="m-0 max-w-prose">{t("medicines.check.intro", { source })}</p>
      {person}
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
          formatCount={count}
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
  product,
  person,
}: {
  readonly personId: string;
  readonly entryId: string;
  readonly version: number;
  readonly product: string;
  readonly person: ReactNode;
}) {
  const ids = useFieldIds([
    "effectiveAt",
    "reason",
    "sourceKind",
    "sourceReference",
    "withdrawLaterReason",
  ]);
  const arrive = useArrival();
  const { result, pending, submit } = useMedicineSubmit(
    (form) => readStop(form, t, version),
    (body) => stopMedicine(personId, entryId, body),
    () => arrive(entryHref(personId, entryId), "stopped"),
  );
  return (
    <form method="post" className="flex flex-col gap-4" onSubmit={submit} noValidate>
      <p className="m-0 max-w-prose">{t("medicines.stop.intro")}</p>
      {person}
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
        formatCount={count}
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
          {pending ? t("common.saving") : t("medicines.stop.submit", { product })}
        </Button>
      </div>
      <FormFeedback result={result} success={t("medicines.stop.done")} fieldIds={ids} />
    </form>
  );
}
