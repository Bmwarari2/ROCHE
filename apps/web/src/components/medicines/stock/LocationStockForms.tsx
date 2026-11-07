"use client";

import { Button, DateInput, RadioGroup, StatusChip, TextField } from "@harbour/ui";
import { Ban, CalendarClock, PackagePlus, Plus, Send, Thermometer } from "lucide-react";
import { useRouter } from "next/navigation";
import { type ReactNode, useRef, useState } from "react";
import {
  addStorage,
  cancelOrder,
  createOrder,
  recordReading,
  setOrderCycle,
  submitOrder,
} from "@/app/actions/medicine-stock";
import { FormFeedback } from "@/components/care/FormFeedback";
import { useFieldIds } from "@/components/care/form-state";
import { useArrival, useMedicineSubmit } from "@/components/medicines/MedicineForms";
import { t } from "@/lib/i18n";
import {
  locationStockHref,
  type OrderCandidate,
  orderHref,
  orderQuantityField,
  rangeWords,
  readCycle,
  readingChip,
  readNewOrder,
  readReading,
  readStorage,
  readSubmitOrder,
  type TemperatureReading,
} from "@/lib/medicine-stock";
import { errorFor } from "@/lib/outcome";

/**
 * The location's stock forms (slice 55; MEDS-008; medicines.md section 15): the 28-day cycle, a
 * new order and its steps, a fridge or room, and a temperature reading. Each is read here first so
 * a mistake is said at its field; the API decides again and its words are shown as they are.
 * After a save the page reloads at an address that says what was done, so it is announced.
 */

const icon = { size: 18, strokeWidth: 1.5, "aria-hidden": true } as const;
const dateLabels = {
  day: t("care.date.day"),
  month: t("care.date.month"),
  year: t("care.date.year"),
};

/** Sets the cycle by the first day of one cycle; the length is the rate table's. */
export function CycleForm({
  locationId,
  anchorOn,
  version,
}: {
  readonly locationId: string;
  readonly anchorOn: string | null;
  readonly version: number | null;
}) {
  const ids = useFieldIds(["anchorOn"]);
  const arrive = useArrival();
  const { result, pending, submit } = useMedicineSubmit(
    (form) => readCycle(form, t, version),
    (body) => setOrderCycle(locationId, body),
    () => arrive(locationStockHref(locationId), "cycle"),
  );
  return (
    <form method="post" className="flex flex-col gap-4" onSubmit={submit} noValidate>
      <DateInput
        id={ids.anchorOn}
        name="anchorOn"
        legend={t("medicines.stock.cycle.anchorOn")}
        hint={t("medicines.stock.cycle.anchorHint")}
        labels={dateLabels}
        defaultValue={anchorOn}
        error={errorFor(result, "anchorOn")}
      />
      <div>
        <Button type="submit" icon={<CalendarClock {...icon} />} disabled={pending}>
          {pending ? t("common.saving") : t("medicines.stock.cycle.submit")}
        </Button>
      </div>
      <FormFeedback result={result} success={t("medicines.stock.cycle.done")} fieldIds={ids} />
    </form>
  );
}

/** Adds a fridge or a medicines room or cupboard. */
export function AddStorageForm({ locationId }: { readonly locationId: string }) {
  const ids = useFieldIds(["kind", "name"]);
  const arrive = useArrival();
  const { result, pending, submit } = useMedicineSubmit(
    (form) => readStorage(form, t),
    (body) => addStorage(locationId, body),
    () => arrive(locationStockHref(locationId), "storage"),
  );
  return (
    <form method="post" className="flex flex-col gap-4" onSubmit={submit} noValidate>
      <RadioGroup
        id={ids.kind}
        name="kind"
        legend={t("medicines.stock.storage.kind")}
        layout="inline"
        options={(["fridge", "room"] as const).map((kind) => ({
          value: kind,
          label: t("medicines.stock.storage.kindOption", { kind }),
        }))}
        error={errorFor(result, "kind")}
      />
      <TextField
        id={ids.name}
        name="name"
        label={t("medicines.stock.storage.name")}
        hint={t("medicines.stock.storage.nameHint")}
        maxLength={80}
        error={errorFor(result, "name")}
      />
      <div>
        <Button type="submit" icon={<Plus {...icon} />} disabled={pending}>
          {pending ? t("common.saving") : t("medicines.stock.storage.submit")}
        </Button>
      </div>
      <FormFeedback result={result} success={t("medicines.stock.storage.done")} fieldIds={ids} />
    </form>
  );
}

/** One person's medicines on the new order form, with their name and each medicine's unit. */
export type OrderGroup = {
  readonly personId: string;
  readonly name: string;
  /** The person's communication needs (AIS), under their name. */
  readonly needs?: ReactNode;
  readonly medicines: readonly {
    readonly medicationId: string;
    readonly productName: string;
    readonly unitName: string | null;
  }[];
};

/**
 * A new order for a cycle: the cycle's first day (the next one by default) and, for each person,
 * a quantity for each medicine to order; a medicine left empty is not ordered.
 */
export function NewOrderForm({
  locationId,
  cycleStartsOn,
  groups,
}: {
  readonly locationId: string;
  readonly cycleStartsOn: string | null;
  readonly groups: readonly OrderGroup[];
}) {
  const candidates: OrderCandidate[] = groups.flatMap((g) =>
    g.medicines.map((m) => ({ personId: g.personId, medicationId: m.medicationId })),
  );
  const first = candidates[0];
  const ids = {
    cycleStartsOn: "order-cycle-starts-on",
    lines: first ? orderQuantityField(first) : "order-cycle-starts-on",
    ...Object.fromEntries(candidates.map((c) => [orderQuantityField(c), orderQuantityField(c)])),
  };
  const arrive = useArrival();
  const { result, pending, submit } = useMedicineSubmit(
    (form) => readNewOrder(form, t, candidates),
    (body) => createOrder(locationId, body),
    (order) => {
      if (order) arrive(orderHref(locationId, order.id), "created");
    },
  );
  return (
    <form method="post" className="flex flex-col gap-6" onSubmit={submit} noValidate>
      <DateInput
        id={ids.cycleStartsOn}
        name="cycleStartsOn"
        legend={t("medicines.stock.order.cycleStartsOn")}
        hint={t("medicines.stock.order.cycleHint")}
        labels={dateLabels}
        defaultValue={cycleStartsOn}
        error={errorFor(result, "cycleStartsOn")}
      />
      {errorFor(result, "lines") ? (
        <p className="hb-field__error m-0">{errorFor(result, "lines")}</p>
      ) : null}
      {groups.map((group) => (
        <fieldset key={group.personId} className="m-0 flex flex-col gap-3 border-0 p-0">
          <legend className="mb-2 text-body font-semibold">{group.name}</legend>
          {group.needs}
          {group.medicines.map((m) => {
            const field = orderQuantityField({
              personId: group.personId,
              medicationId: m.medicationId,
            });
            return (
              <TextField
                key={m.medicationId}
                id={field}
                name={field}
                label={t("medicines.stock.order.quantityFor", {
                  product: m.productName,
                  unit: m.unitName ?? "",
                })}
                hint={t("medicines.stock.order.quantityHint")}
                inputMode="decimal"
                error={errorFor(result, field)}
              />
            );
          })}
        </fieldset>
      ))}
      <div>
        <Button type="submit" icon={<PackagePlus {...icon} />} disabled={pending}>
          {pending ? t("common.saving") : t("medicines.stock.order.create")}
        </Button>
      </div>
      <FormFeedback result={result} success={t("medicines.stock.order.created")} fieldIds={ids} />
    </form>
  );
}

/** Submits a draft order: by hand, or through the pharmacy when it is connected. */
export function SubmitOrderForm({
  locationId,
  orderId,
  version,
}: {
  readonly locationId: string;
  readonly orderId: string;
  readonly version: number;
}) {
  const ids = useFieldIds(["via"]);
  const arrive = useArrival();
  const { result, pending, submit } = useMedicineSubmit(
    (form) => readSubmitOrder(form, t, version),
    (body) => submitOrder(locationId, orderId, body),
    () => arrive(orderHref(locationId, orderId), "submitted"),
  );
  return (
    <form method="post" className="flex flex-col gap-4" onSubmit={submit} noValidate>
      <RadioGroup
        id={ids.via}
        name="via"
        legend={t("medicines.stock.order.via")}
        hint={t("medicines.stock.order.viaHint")}
        options={(["manual", "pharmacy_port"] as const).map((via) => ({
          value: via,
          label: t("medicines.stock.order.viaOption", { via }),
        }))}
        error={errorFor(result, "via")}
      />
      <div>
        <Button type="submit" icon={<Send {...icon} />} disabled={pending}>
          {pending ? t("common.saving") : t("medicines.stock.order.submit")}
        </Button>
      </div>
      <FormFeedback result={result} success={t("medicines.stock.order.submitted")} fieldIds={ids} />
    </form>
  );
}

/** Cancels an order not yet received. */
export function CancelOrderForm({
  locationId,
  orderId,
  version,
}: {
  readonly locationId: string;
  readonly orderId: string;
  readonly version: number;
}) {
  const arrive = useArrival();
  const { result, pending, submit } = useMedicineSubmit(
    () => ({ ok: true as const, body: { version } }),
    (body) => cancelOrder(locationId, orderId, body),
    () => arrive(orderHref(locationId, orderId), "cancelled"),
  );
  return (
    <form method="post" className="flex flex-col gap-4" onSubmit={submit} noValidate>
      <p className="m-0 max-w-prose">{t("medicines.stock.order.cancelIntro")}</p>
      <div>
        <Button type="submit" variant="destructive" icon={<Ban {...icon} />} disabled={pending}>
          {pending ? t("common.saving") : t("medicines.stock.order.cancel")}
        </Button>
      </div>
      <FormFeedback result={result} success={t("medicines.stock.order.cancelled")} />
    </form>
  );
}

/**
 * Records a temperature reading. The answer shows the reading's state as an icon and a word, the
 * range that applied (the rate table's), and the API's words on what happens next; it never says
 * whether the medicines can be used (HZ-132).
 */
export function RecordReadingForm({
  locationId,
  storageId,
}: {
  readonly locationId: string;
  readonly storageId: string;
}) {
  const ids = useFieldIds(["celsius", "minCelsius", "maxCelsius"]);
  const router = useRouter();
  const formRef = useRef<HTMLFormElement>(null);
  const stateRef = useRef<HTMLDivElement>(null);
  const [recorded, setRecorded] = useState<{
    readonly reading: TemperatureReading;
    readonly message: string;
  } | null>(null);
  const { result, pending, submit } = useMedicineSubmit(
    (form) => readReading(form, t),
    (body) => recordReading(locationId, storageId, body),
    (data) => {
      if (data) setRecorded(data);
      formRef.current?.reset();
      router.refresh();
    },
  );
  const chip = recorded ? readingChip(recorded.reading, t) : null;
  return (
    <form ref={formRef} method="post" className="flex flex-col gap-4" onSubmit={submit} noValidate>
      <TextField
        id={ids.celsius}
        name="celsius"
        label={t("medicines.stock.reading.celsius")}
        hint={t("medicines.stock.reading.celsiusHint")}
        inputMode="decimal"
        error={errorFor(result, "celsius")}
      />
      <TextField
        id={ids.minCelsius}
        name="minCelsius"
        label={t("medicines.stock.reading.minCelsius")}
        hint={t("medicines.stock.reading.minMaxHint")}
        inputMode="decimal"
        error={errorFor(result, "minCelsius")}
      />
      <TextField
        id={ids.maxCelsius}
        name="maxCelsius"
        label={t("medicines.stock.reading.maxCelsius")}
        hint={t("medicines.stock.reading.minMaxHint")}
        inputMode="decimal"
        error={errorFor(result, "maxCelsius")}
      />
      <div>
        <Button type="submit" icon={<Thermometer {...icon} />} disabled={pending}>
          {pending ? t("common.saving") : t("medicines.stock.reading.submit")}
        </Button>
      </div>
      <FormFeedback
        result={result}
        success={recorded?.message ?? t("medicines.stock.reading.done")}
        fieldIds={ids}
        focusOnSuccess={stateRef}
      />
      {/* The reading's state and figures take focus, so they are read out (HZ-132). */}
      <div ref={stateRef} tabIndex={-1} className="flex flex-col gap-1">
        {recorded && chip && result?.ok ? (
          <>
            <p className="m-0 flex flex-wrap items-center gap-2">
              <StatusChip status={chip.status} label={chip.label} icon={chip.icon} />
              <span>
                {t("medicines.stock.reading.value", { celsius: recorded.reading.celsius })}
              </span>
            </p>
            <p className="m-0">{rangeWords(recorded.reading, t)}</p>
            {recorded.reading.minCelsius !== null ? (
              <p className="m-0">
                {t("medicines.stock.reading.minSince", { celsius: recorded.reading.minCelsius })}
              </p>
            ) : null}
            {recorded.reading.maxCelsius !== null ? (
              <p className="m-0">
                {t("medicines.stock.reading.maxSince", { celsius: recorded.reading.maxCelsius })}
              </p>
            ) : null}
          </>
        ) : null}
      </div>
    </form>
  );
}
