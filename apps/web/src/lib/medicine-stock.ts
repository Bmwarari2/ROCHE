import type { components } from "@harbour/contracts/client";
import type { Translator } from "@harbour/i18n";
import type { StatusChipStatus } from "@harbour/ui";
import {
  Ban,
  CircleCheck,
  type LucideIcon,
  PackageCheck,
  PackageOpen,
  PencilLine,
  Send,
  ThermometerSnowflake,
  ThermometerSun,
  TriangleAlert,
} from "lucide-react";
import {
  type FormWithAll,
  type MedicineEntry,
  medicinesHref,
  type Read,
  readQuantity,
} from "./medicines";
import { readDateField } from "./uk-time";

/**
 * Medicines stock, ordering, disposal and storage temperatures on the web (slice 55; MEDS-008;
 * medicines.md section 15, on slice 42's API). Pure helpers for the location and person pages and
 * their forms. The API and the database run every stock rule again and decide whether a reading is
 * out of range, from the rate table (HZ-132); these read the forms so a mistake is said at its
 * field first, and give each state an icon and a word (never colour alone). Nothing here says
 * whether a medicine can still be used: that is the pharmacist's call (medical-device boundary).
 */

type Schemas = components["schemas"];
export type StockItem = Schemas["StockItemOut"];
export type StockMovement = Schemas["StockMovementOut"];
export type PersonStock = Schemas["PersonStock"];
export type MedicineOrder = Schemas["MedicineOrderOut"];
export type OrderStatus = MedicineOrder["status"];
export type OrderCycle = Schemas["OrderCycleOut"];
export type Storage = Schemas["MedicineStorageOut"];
export type TemperatureReading = Schemas["TemperatureReadingOut"];
export type Disposal = NonNullable<Schemas["DisposalOut"]>;

type Chip = {
  readonly status: StatusChipStatus;
  readonly icon: LucideIcon;
  readonly label: string;
};

/** Who manages stock: open items, receipts, counts, returns, disposals, cycles, orders, storage. */
export const STOCK_PERMISSION = "medicines.stock.manage";
/** Who reads stock, orders, storage and readings (the API's readers). */
export const STOCK_READERS = [
  "medicines.record.manage",
  "medicines.emar.administer",
  STOCK_PERMISSION,
] as const;
/** Who records a temperature reading. */
export const TEMPERATURE_RECORDERS = [STOCK_PERMISSION, "medicines.emar.administer"] as const;

export const stockShown = (permissions: readonly string[]) =>
  STOCK_READERS.some((p) => permissions.includes(p));
export const stockManaged = (permissions: readonly string[]) =>
  permissions.includes(STOCK_PERMISSION);
export const mayRecordTemperature = (permissions: readonly string[]) =>
  TEMPERATURE_RECORDERS.some((p) => permissions.includes(p));

export const STOCK_HOME = "/medicines-stock";
export const locationStockHref = (locationId: string) => `${STOCK_HOME}/${locationId}`;
export const orderHref = (locationId: string, orderId: string) =>
  `${locationStockHref(locationId)}/orders/${orderId}`;
export const newOrderHref = (locationId: string) => `${locationStockHref(locationId)}/orders/new`;
export const storageHref = (locationId: string, storageId: string) =>
  `${locationStockHref(locationId)}/storage/${storageId}`;
export const personStockHref = (personId: string) => `${medicinesHref(personId)}/stock`;
export const stockItemHref = (personId: string, itemId: string) =>
  `${personStockHref(personId)}/${itemId}`;
export const disposalWitnessHref = (personId: string, disposalId: string) =>
  `${personStockHref(personId)}/disposals/${disposalId}`;

/** An order's step as an icon and a word. */
export function orderChip(status: OrderStatus, t: Translator): Chip {
  const label = t("medicines.stock.order.status", { status });
  switch (status) {
    case "draft":
      return { status: "notApplicable", icon: PencilLine, label };
    case "submitted":
      return { status: "due", icon: Send, label };
    case "part_received":
      return { status: "due", icon: PackageOpen, label };
    case "received":
      return { status: "done", icon: PackageCheck, label };
    case "cancelled":
      return { status: "notApplicable", icon: Ban, label };
  }
}

/** Steps an order may still take on the web: submitted from a draft; cancelled until received. */
export const maySubmitOrder = (status: OrderStatus) => status === "draft";
export const mayCancelOrder = (status: OrderStatus) =>
  status === "draft" || status === "submitted" || status === "part_received";

/**
 * Which way a reading the API found out of range went, for its words and icon: above the range,
 * below it, or only the thermometer's maximum or minimum since the last reading. The API's
 * `outOfRange` decides; this only names it, and never says whether the medicines can be used.
 */
export function readingBreach(
  r: Pick<
    TemperatureReading,
    "celsius" | "minCelsius" | "maxCelsius" | "lowCelsius" | "highCelsius" | "outOfRange"
  >,
): "above" | "below" | "since_last" | null {
  if (!r.outOfRange) return null;
  if (r.celsius > r.highCelsius) return "above";
  if (r.lowCelsius !== null && r.celsius < r.lowCelsius) return "below";
  return "since_last";
}

/** A reading's state as an icon and a word (HZ-132; never colour alone). */
export function readingChip(
  r: Pick<
    TemperatureReading,
    "celsius" | "minCelsius" | "maxCelsius" | "lowCelsius" | "highCelsius" | "outOfRange"
  >,
  t: Translator,
): Chip {
  const breach = readingBreach(r);
  if (breach === null) {
    return { status: "done", icon: CircleCheck, label: t("medicines.stock.reading.inRange") };
  }
  const label = t("medicines.stock.reading.outOfRange", { breach });
  const icon =
    breach === "above" ? ThermometerSun : breach === "below" ? ThermometerSnowflake : TriangleAlert;
  return { status: "overdue", icon, label };
}

/** The range that applied to a reading, from the rate table as the API stored it. */
export function rangeWords(
  r: Pick<TemperatureReading, "lowCelsius" | "highCelsius">,
  t: Translator,
) {
  return r.lowCelsius === null
    ? t("medicines.stock.reading.rangeUpTo", { high: r.highCelsius })
    : t("medicines.stock.reading.range", { low: r.lowCelsius, high: r.highCelsius });
}

/** A balance below nought (a dose recorded with no stock left): the count is asked for (rule 3). */
export function balanceChip(balance: number, t: Translator): Chip | null {
  return balance < 0
    ? { status: "overdue", icon: TriangleAlert, label: t("medicines.stock.belowZero") }
    : null;
}

/** A disposal's witness state as an icon and a word. */
export function disposalChip(status: Disposal["status"], t: Translator): Chip {
  const label = t("medicines.stock.disposal.status", { status });
  return status === "awaiting_witness"
    ? { status: "due", icon: TriangleAlert, label }
    : { status: "done", icon: CircleCheck, label };
}

export type OrderLineChoice = {
  readonly id: string;
  readonly orderId: string;
  readonly cycleStartsOn: string;
  readonly quantity: number;
  readonly received: number;
};

/** The open order lines a receipt for this person's medicine can fill (submitted, part received). */
export function orderLineChoices(
  orders: readonly MedicineOrder[],
  personId: string,
  medicationId: string,
): OrderLineChoice[] {
  return orders
    .filter((o) => o.status === "submitted" || o.status === "part_received")
    .flatMap((o) =>
      o.lines
        .filter((l) => l.personId === personId && l.medicationId === medicationId)
        .map((l) => ({
          id: l.id,
          orderId: o.id,
          cycleStartsOn: o.cycleStartsOn,
          quantity: l.quantity,
          received: l.received,
        })),
    );
}

/** Entries on the MAR an item can still be opened from: in force, and without an item already. */
export function openableEntries<E extends { readonly id: string; readonly state: string }>(
  entries: readonly E[],
  items: readonly Pick<StockItem, "medicationId">[],
): E[] {
  const opened = new Set(items.map((i) => i.medicationId));
  return entries.filter(
    (e) =>
      !opened.has(e.id) &&
      (e.state === "not_yet_checked" || e.state === "checked" || e.state === "difference_found"),
  );
}

/** The dose unit an entry is counted and ordered in (its first dose's), as the API counts it. */
export function entryUnitName(entry: Pick<MedicineEntry, "directions">): string | null {
  const d = entry.directions;
  return d.kind === "when_required"
    ? d.dose.unit.name
    : (d.schedule.times[0]?.dose.unit.name ?? null);
}

/** The disposal movement a witness page is about, with its item, if the reader can see it. */
export function findDisposal(
  stock: Pick<PersonStock, "items">,
  disposalId: string,
): { readonly item: StockItem; readonly movement: StockMovement } | null {
  for (const item of stock.items) {
    const movement = item.movements.find((m) => m.disposalId === disposalId);
    if (movement) return { item, movement };
  }
  return null;
}

const text = (form: FormWithAll, name: string) => {
  const value = form.get(name);
  return typeof value === "string" ? value.trim() : "";
};
const optional = (form: FormWithAll, name: string) => text(form, name) || null;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** A count as typed: nought or more, at most three decimal places, no leading zero. */
export function readCount(raw: string): number | null {
  if (!/^(0|[1-9]\d*)(\.\d{1,3})?$/.test(raw)) return null;
  const value = Number(raw);
  return value >= 0 && value <= 1_000_000 ? value : null;
}

/** A stock quantity: above nought, at most three decimal places, at most a million (the contract). */
function readStockQuantity(raw: string): number | null {
  const value = readQuantity(raw);
  return value !== null && value <= 1_000_000 ? value : null;
}

/**
 * A temperature in degrees Celsius as typed: at most one decimal place (HZ-132: a reading at a
 * range's edge is never rounded into it), from -50 to 60. A comma is not read as a point.
 */
export function readCelsius(raw: string): number | null {
  if (!/^-?(0|[1-9]\d?)(\.\d)?$/.test(raw)) return null;
  const value = Number(raw);
  return value >= -50 && value <= 60 ? value : null;
}

/** Opening a stock item from one of the person's MAR entries (`OpenStockItem`). */
export function readOpenItem(form: FormWithAll, t: Translator): Read<Schemas["OpenStockItem"]> {
  const medicationId = text(form, "medicationId");
  if (!UUID.test(medicationId)) {
    return { ok: false, errors: { medicationId: t("medicines.stock.open.medicineError") } };
  }
  return { ok: true, body: { medicationId } };
}

/** A receipt or a return (`StockQuantity`); a receipt may name the order line it fills. */
export function readStockQuantityForm(
  form: FormWithAll,
  t: Translator,
  kind: "receipt" | "return",
): Read<Schemas["StockQuantity"]> {
  const quantity = readStockQuantity(text(form, "quantity"));
  const line = kind === "receipt" ? text(form, "orderLineId") : "";
  const errors: Record<string, string> = {};
  if (quantity === null) errors.quantity = t("medicines.stock.quantityError");
  if (line && !UUID.test(line)) errors.orderLineId = t("medicines.stock.receipt.lineError");
  if (quantity === null || Object.keys(errors).length > 0) return { ok: false, errors };
  return { ok: true, body: { quantity, orderLineId: line || null } };
}

/**
 * A count (`StockCount`): what was counted, and why when it differs from the balance the page
 * showed. The API compares with the balance again under a lock, and asks for the reason in words.
 */
export function readStockCount(
  form: FormWithAll,
  t: Translator,
  balance: number,
): Read<Schemas["StockCount"]> {
  const counted = readCount(text(form, "counted"));
  const reason = optional(form, "reason");
  const errors: Record<string, string> = {};
  if (counted === null) errors.counted = t("medicines.stock.count.countedError");
  if (counted !== null && counted !== balance && !reason) {
    errors.reason = t("medicines.stock.count.reasonError");
  }
  if (reason && (reason.length < 3 || reason.length > 500)) {
    errors.reason = t("medicines.stock.noteLengthError");
  }
  if (counted === null || Object.keys(errors).length > 0) return { ok: false, errors };
  return { ok: true, body: { counted, reason: counted === balance ? null : reason } };
}

export const DISPOSAL_REASONS = [
  "refused_dose",
  "dropped_or_spoilt",
  "out_of_date",
  "discontinued",
  "person_left",
  "other",
] as const satisfies readonly Schemas["RecordDisposal"]["reason"][];

/**
 * A disposal (`RecordDisposal`): the quantity, the reason, a note, and its witness, a second
 * member who confirms it themselves, or (where the organisation's policy allows; the API says
 * when it does not) why no one could witness it. Never both, and never the recorder.
 */
export function readDisposal(
  form: FormWithAll,
  t: Translator,
  me: string,
): Read<Schemas["RecordDisposal"]> {
  const errors: Record<string, string> = {};
  const quantity = readStockQuantity(text(form, "quantity"));
  if (quantity === null) errors.quantity = t("medicines.stock.quantityError");
  const reasonText = text(form, "reason");
  const reason = (DISPOSAL_REASONS as readonly string[]).includes(reasonText)
    ? (reasonText as Schemas["RecordDisposal"]["reason"])
    : null;
  if (!reason) errors.reason = t("medicines.stock.disposal.reasonError");
  const note = optional(form, "note");
  if (note && (note.length < 3 || note.length > 500)) {
    errors.note = t("medicines.stock.noteLengthError");
  }
  const witnessed = text(form, "witnessed");
  let witnessId: string | null = null;
  let noWitnessReason: string | null = null;
  if (witnessed === "witness") {
    const chosen = text(form, "witnessId");
    if (!UUID.test(chosen)) errors.witnessId = t("medicines.stock.disposal.witnessError");
    else if (chosen === me) errors.witnessId = t("medicines.stock.disposal.witnessIsYou");
    else witnessId = chosen;
  } else if (witnessed === "no_witness") {
    noWitnessReason = optional(form, "noWitnessReason");
    if (!noWitnessReason || noWitnessReason.length < 10 || noWitnessReason.length > 500) {
      errors.noWitnessReason = t("medicines.stock.disposal.noWitnessReasonError");
    }
  } else {
    errors.witnessed = t("medicines.stock.disposal.witnessedError");
  }
  if (quantity === null || !reason || Object.keys(errors).length > 0) return { ok: false, errors };
  return { ok: true, body: { quantity, reason, note, witnessId, noWitnessReason } };
}

/** The 28-day cycle by the first day of one cycle (`PutOrderCycle`), against the version read. */
export function readCycle(
  form: FormWithAll,
  t: Translator,
  version: number | null,
): Read<Schemas["PutOrderCycle"]> {
  const date = readDateField(form, "anchorOn", {
    subject: t("medicines.stock.cycle.anchorSubject"),
    t,
  });
  if (!date.ok) return { ok: false, errors: { anchorOn: date.message } };
  if (!date.date)
    return { ok: false, errors: { anchorOn: t("medicines.stock.cycle.anchorError") } };
  return { ok: true, body: { anchorOn: date.date, version } };
}

/** One medicine the new order form offers, for one person (from their MAR entry). */
export type OrderCandidate = {
  readonly personId: string;
  readonly medicationId: string;
};

/** The field that holds the quantity ordered for one person's medicine (also its id). */
export const orderQuantityField = (c: OrderCandidate) => `qty-${c.personId}-${c.medicationId}`;

/**
 * A new order for a cycle (`NewMedicineOrder`): the cycle's first day and every medicine given a
 * quantity; a medicine left empty is not ordered. At least one line. The API checks each line is
 * the person's own medicine at this home and never a controlled drug.
 */
export function readNewOrder(
  form: FormWithAll,
  t: Translator,
  candidates: readonly OrderCandidate[],
): Read<Schemas["NewMedicineOrder"]> {
  const errors: Record<string, string> = {};
  const date = readDateField(form, "cycleStartsOn", {
    subject: t("medicines.stock.order.cycleSubject"),
    t,
  });
  if (!date.ok) errors.cycleStartsOn = date.message;
  else if (!date.date) errors.cycleStartsOn = t("medicines.stock.order.cycleError");
  const lines: Schemas["NewMedicineOrder"]["lines"] = [];
  for (const c of candidates) {
    const field = orderQuantityField(c);
    const typed = text(form, field);
    if (!typed) continue;
    const quantity = readStockQuantity(typed);
    if (quantity === null) errors[field] = t("medicines.stock.quantityError");
    else lines.push({ personId: c.personId, medicationId: c.medicationId, quantity });
  }
  if (lines.length === 0 && Object.keys(errors).every((k) => k === "cycleStartsOn")) {
    errors.lines = t("medicines.stock.order.linesError");
  }
  if (!date.ok || !date.date || Object.keys(errors).length > 0) return { ok: false, errors };
  return { ok: true, body: { cycleStartsOn: date.date, lines } };
}

/** Submitting a draft (`SubmitMedicineOrder`): by hand, or through the pharmacy. */
export function readSubmitOrder(
  form: FormWithAll,
  t: Translator,
  version: number,
): Read<Schemas["SubmitMedicineOrder"]> {
  const via = text(form, "via");
  if (via !== "manual" && via !== "pharmacy_port") {
    return { ok: false, errors: { via: t("medicines.stock.order.viaError") } };
  }
  return { ok: true, body: { version, via } };
}

/** Adding a fridge or a medicines room or cupboard (`NewMedicineStorage`). */
export function readStorage(form: FormWithAll, t: Translator): Read<Schemas["NewMedicineStorage"]> {
  const errors: Record<string, string> = {};
  const kind = text(form, "kind");
  if (kind !== "fridge" && kind !== "room") errors.kind = t("medicines.stock.storage.kindError");
  const name = text(form, "name");
  if (name.length < 2 || name.length > 80) errors.name = t("medicines.stock.storage.nameError");
  if ((kind !== "fridge" && kind !== "room") || Object.keys(errors).length > 0) {
    return { ok: false, errors };
  }
  return { ok: true, body: { kind, name } };
}

/**
 * A temperature reading (`NewTemperatureReading`): the reading, and the thermometer's minimum and
 * maximum since the last reading when it shows them. Each to one decimal place at most. Whether
 * it is out of range is the database's decision, from the rate table (HZ-132).
 */
export function readReading(
  form: FormWithAll,
  t: Translator,
): Read<Schemas["NewTemperatureReading"]> {
  const errors: Record<string, string> = {};
  const read = (name: string, required: boolean) => {
    const typed = text(form, name);
    if (!typed && !required) return null;
    const value = readCelsius(typed);
    if (value === null) errors[name] = t("medicines.stock.reading.celsiusError");
    return value;
  };
  const celsius = read("celsius", true);
  const minCelsius = read("minCelsius", false);
  const maxCelsius = read("maxCelsius", false);
  if (celsius === null || Object.keys(errors).length > 0) return { ok: false, errors };
  return { ok: true, body: { celsius, minCelsius, maxCelsius } };
}

/**
 * Which form field each stock refusal belongs to (the API's code), so the API's words show there;
 * anything else shows above the form.
 */
export const STOCK_FIELD_FOR_PROBLEM: Readonly<Record<string, string>> = {
  controlled_drug_register: "medicationId",
  witness_required: "witnessed",
  witness_cannot_confirm: "witnessId",
  witness_is_recorder: "witnessId",
  witness_and_reason: "witnessed",
  no_witness_reason: "noWitnessReason",
  order_line: "orderLineId",
  order_line_entry: "lines",
  pharmacy_not_connected: "via",
};

/** Stock refusals whose words (the API's) are shown as they are. */
export const STOCK_PROBLEMS: ReadonlySet<string> = new Set([
  ...Object.keys(STOCK_FIELD_FOR_PROBLEM),
  "not_the_witness",
  "order_step",
  "pharmacy_unavailable",
  "order_needs_location_scope",
]);
