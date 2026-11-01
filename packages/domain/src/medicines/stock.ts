import { type RateNation, type RateRow, resolveRate } from "../platform/rates";

/**
 * Medicines stock, the 28-day ordering cycle, disposal and storage temperatures (medicines.md
 * section 15; MEDS-008; plan slice 42; ADR-0103). Stock is kept per person and per dm+d product;
 * a controlled drug's stock is the register's (section 14), never counted here. Every figure comes
 * from the rate table through `resolveStockRates`; none is a literal. Nothing here says whether a
 * medicine can still be used after a temperature out of range: that is the pharmacist's call.
 */

export const STOCK_RATE_KEYS = {
  orderingCycleDays: "medicines.ordering_cycle_days",
  orderPromptDaysBefore: "medicines.order.prompt_days_before",
  fridgeMinCelsius: "medicines.fridge_min_celsius",
  fridgeMaxCelsius: "medicines.fridge_max_celsius",
  roomMaxCelsius: "medicines.room_max_celsius",
  temperatureAcknowledgeMinutes: "medicines.temperature.acknowledge_minutes",
  disposalWitnessRequired: "medicines.disposal.witness_required",
} as const;

export type StockRateName = keyof typeof STOCK_RATE_KEYS;
export type StockRates = { readonly [K in StockRateName]: number };

/** Every stock figure for a tenant location on a date; fails loudly if one is missing. */
export function resolveStockRates(
  rows: readonly RateRow[],
  nation: Exclude<RateNation, "uk" | "all">,
  on: string,
  tenantId: string | null,
): StockRates {
  const entries = (Object.keys(STOCK_RATE_KEYS) as StockRateName[]).map(
    (name) => [name, resolveRate(rows, STOCK_RATE_KEYS[name], nation, on, tenantId).value] as const,
  );
  return Object.fromEntries(entries) as StockRates;
}

export const STOCK_MOVEMENTS = [
  "receipt",
  "carried_forward",
  "administration",
  "returned",
  "disposal",
  "administration_correction",
  "count_adjustment",
] as const;
export type StockMovement = (typeof STOCK_MOVEMENTS)[number];

/** The sign a movement's change must have: +1, -1, or 0 for either (never zero itself). */
export const STOCK_MOVEMENT_SIGN: Readonly<Record<StockMovement, 1 | -1 | 0>> = {
  receipt: 1,
  carried_forward: 1,
  administration: -1,
  returned: -1,
  disposal: -1,
  administration_correction: 0,
  count_adjustment: 0,
};

export const DISPOSAL_REASONS = [
  "refused_dose",
  "dropped_or_spoilt",
  "out_of_date",
  "discontinued",
  "person_left",
  "other",
] as const;
export type DisposalReason = (typeof DISPOSAL_REASONS)[number];

export const ORDER_STATUSES = [
  "draft",
  "submitted",
  "part_received",
  "received",
  "cancelled",
] as const;
export type OrderStatus = (typeof ORDER_STATUSES)[number];

export const STORAGE_KINDS = ["fridge", "room"] as const;
export type StorageKind = (typeof STORAGE_KINDS)[number];

/** Quantities are kept to thousandths, as the database's numeric(12,3). */
export const toThousandths = (q: number) => Math.round(q * 1000);
const fromThousandths = (t: number) => t / 1000;

/** Rule 2 to 5: the signed change a movement makes, or why it cannot. */
export function stockChange(
  movement: StockMovement,
  quantity: number,
): { ok: true; change: number } | { ok: false; problem: "quantity" | "sign" } {
  if (!Number.isFinite(quantity) || toThousandths(quantity) === 0) {
    return { ok: false, problem: "quantity" };
  }
  if (toThousandths(Math.abs(quantity)) > 1_000_000_000) return { ok: false, problem: "quantity" };
  const sign = STOCK_MOVEMENT_SIGN[movement];
  if (sign === 0) return { ok: true, change: fromThousandths(toThousandths(quantity)) };
  if (quantity < 0) return { ok: false, problem: "sign" };
  return { ok: true, change: fromThousandths(sign * toThousandths(quantity)) };
}

/** The balance after a change, exactly to thousandths. */
export function balanceAfter(balance: number, change: number): number {
  return fromThousandths(toThousandths(balance) + toThousandths(change));
}

/** Rule 3: whether a dose moves stock, and how much leaves. */
export function doseStockMove(input: {
  readonly outcome: string;
  readonly isControlledDrug: boolean;
  readonly item: { readonly unitCode: string } | null;
  readonly amount: { readonly quantity: number; readonly unitCode: string } | null;
}): number | null {
  if (input.isControlledDrug || !input.item || input.outcome !== "given" || !input.amount) {
    return null;
  }
  if (input.amount.unitCode !== input.item.unitCode) return null;
  if (toThousandths(input.amount.quantity) <= 0) return null;
  return fromThousandths(-toThousandths(input.amount.quantity));
}

/**
 * Rule 3: a correction's movement. What the chain now says left stock, less what has already
 * left for it; null when nothing more moves.
 */
export function correctionStockChange(input: {
  /** What the corrected record says left stock (negative), or 0. */
  readonly shouldHaveLeft: number;
  /** What the chain's movements have taken so far (the sum of their changes). */
  readonly alreadyMoved: number;
}): number | null {
  const diff = toThousandths(input.shouldHaveLeft) - toThousandths(input.alreadyMoved);
  return diff === 0 ? null : fromThousandths(diff);
}

/** Rule 4: a count against the balance: the adjustment to make, or null when it matches. */
export function countAdjustment(balance: number, counted: number): number | null {
  if (!Number.isFinite(counted) || counted < 0) return Number.NaN;
  const diff = toThousandths(counted) - toThousandths(balance);
  return diff === 0 ? null : fromThousandths(diff);
}

/** Rule 3: a balance that crosses below zero asks for a count, once. */
export const crossedBelowZero = (before: number, after: number) =>
  toThousandths(before) >= 0 && toThousandths(after) < 0;

export type DisposalProblem =
  | "witness_is_recorder"
  | "witness_required"
  | "no_witness_reason"
  | "witness_and_reason";

/** Rule 5: a disposal's witness under the organisation's policy. */
export function checkDisposalWitness(input: {
  readonly witnessRequired: boolean;
  readonly recorderId: string;
  readonly witnessId: string | null;
  readonly noWitnessReason: string | null;
}): DisposalProblem | null {
  const reason = input.noWitnessReason?.trim() ?? "";
  if (input.witnessId && reason) return "witness_and_reason";
  if (input.witnessId === input.recorderId) return "witness_is_recorder";
  if (input.witnessId) return null;
  if (input.witnessRequired) return "witness_required";
  return reason.length >= 10 ? null : "no_witness_reason";
}

const DAY = 86_400_000;
const dayNumber = (iso: string) => Math.round(Date.parse(`${iso}T00:00:00Z`) / DAY);
const isoOfDay = (n: number) => new Date(n * DAY).toISOString().slice(0, 10);

/** Rule 6: the first day of the cycle running on `today`, or of the next one from the anchor. */
export function cycleStartOn(anchorOn: string, today: string, cycleDays: number): string {
  if (!Number.isInteger(cycleDays) || cycleDays < 1) throw new RangeError("cycle days");
  const a = dayNumber(anchorOn);
  const t = dayNumber(today);
  if (t <= a) return anchorOn;
  return isoOfDay(a + Math.floor((t - a) / cycleDays) * cycleDays);
}

/** Rule 6: the next cycle to start after `today` (today itself when it starts today). */
export function nextCycleStart(anchorOn: string, today: string, cycleDays: number): string {
  const current = cycleStartOn(anchorOn, today, cycleDays);
  if (current >= today) return current;
  return isoOfDay(dayNumber(current) + cycleDays);
}

/**
 * Rule 6: the cycle an order is due for on `today`: the next cycle when it starts within
 * `promptDaysBefore` days, else null.
 */
export function orderDueFor(
  anchorOn: string,
  today: string,
  rates: Pick<StockRates, "orderingCycleDays" | "orderPromptDaysBefore">,
): string | null {
  const next = nextCycleStart(anchorOn, today, rates.orderingCycleDays);
  return dayNumber(next) - dayNumber(today) <= rates.orderPromptDaysBefore ? next : null;
}

const ORDER_STEPS: Readonly<Record<OrderStatus, readonly OrderStatus[]>> = {
  draft: ["submitted", "cancelled"],
  submitted: ["part_received", "received", "cancelled"],
  part_received: ["part_received", "received", "cancelled"],
  received: [],
  cancelled: [],
};

/** Rule 7: whether an order may move from one status to another. */
export const canMoveOrder = (from: OrderStatus, to: OrderStatus) => ORDER_STEPS[from].includes(to);

/** Rule 7: an order's status from what its lines asked for and what has been received. */
export function orderStatusFromReceipts(
  lines: readonly { readonly quantity: number; readonly received: number }[],
): "submitted" | "part_received" | "received" {
  const any = lines.some((l) => toThousandths(l.received) > 0);
  const all = lines.every((l) => toThousandths(l.received) >= toThousandths(l.quantity));
  return all && lines.length > 0 ? "received" : any ? "part_received" : "submitted";
}

/** Rule 8: the range for a kind of storage, in tenths of a degree (a room has no minimum here). */
export function storageRange(
  kind: StorageKind,
  rates: Pick<StockRates, "fridgeMinCelsius" | "fridgeMaxCelsius" | "roomMaxCelsius">,
): { readonly lowTenths: number | null; readonly highTenths: number } {
  return kind === "fridge"
    ? {
        lowTenths: Math.round(rates.fridgeMinCelsius * 10),
        highTenths: Math.round(rates.fridgeMaxCelsius * 10),
      }
    : { lowTenths: null, highTenths: Math.round(rates.roomMaxCelsius * 10) };
}

/** Rule 8: whether a reading, with its minimum and maximum when given, is out of range. */
export function readingOutOfRange(
  reading: {
    readonly tenths: number;
    readonly minTenths?: number | null;
    readonly maxTenths?: number | null;
  },
  range: { readonly lowTenths: number | null; readonly highTenths: number },
): boolean {
  const lowest = Math.min(reading.tenths, reading.minTenths ?? reading.tenths);
  const highest = Math.max(reading.tenths, reading.maxTenths ?? reading.tenths);
  return highest > range.highTenths || (range.lowTenths !== null && lowest < range.lowTenths);
}

/** The out-of-range task's fixed words: never advice on whether the medicines can be used. */
export const TEMPERATURE_TASK_TITLE =
  "Medicines storage out of range. Check the storage, and ask the pharmacist whether the medicines in it can still be used.";
export const STOCK_COUNT_TASK_TITLE = "Medicines stock count needed";
export const ORDER_DUE_TASK_TITLE = "Medicines order due";
export const DISPOSAL_WITNESS_TASK_TITLE = "Witness a medicines disposal";
