import { describe, expect, it } from "vitest";
import {
  balanceAfter,
  canMoveOrder,
  checkDisposalWitness,
  correctionStockChange,
  countAdjustment,
  crossedBelowZero,
  cycleStartOn,
  doseStockMove,
  nextCycleStart,
  orderDueFor,
  orderStatusFromReceipts,
  readingOutOfRange,
  type StockMovement,
  stockChange,
  storageRange,
  TEMPERATURE_TASK_TITLE,
} from "./stock";

/**
 * Medicines stock, ordering, disposal and temperatures (medicines.md section 15; MEDS-008; slice
 * 42). Table-driven. The figures here stand in for the rate table's, passed in as callers do.
 */

const RATES = {
  orderingCycleDays: 28,
  orderPromptDaysBefore: 7,
  fridgeMinCelsius: 2,
  fridgeMaxCelsius: 8,
  roomMaxCelsius: 25,
};

describe("hazard HZ-002 MEDS-008 rules 2 to 4 stock movements", () => {
  it.each<[StockMovement, number, number | string]>([
    ["receipt", 28, 28],
    ["carried_forward", 3.5, 3.5],
    ["administration", 1, -1],
    ["returned", 10, -10],
    ["disposal", 0.5, -0.5],
    ["administration_correction", -1, -1],
    ["administration_correction", 2, 2],
    ["count_adjustment", -3, -3],
    ["receipt", -1, "sign"],
    ["receipt", 0, "quantity"],
    ["administration", 0.0004, "quantity"],
  ])("%s of %d", (movement, quantity, want) => {
    const out = stockChange(movement, quantity);
    expect(out.ok ? out.change : out.problem).toBe(want);
  });

  it("keeps balances exact to thousandths", () => {
    expect(balanceAfter(0.1, 0.2)).toBe(0.3);
    expect(balanceAfter(1, -1.5)).toBe(-0.5);
  });

  it.each([
    ["a given dose with an item in its unit", { outcome: "given" }, -2],
    ["a refused dose", { outcome: "refused" }, null],
    ["a controlled drug", { isControlledDrug: true }, null],
    ["no item", { item: null }, null],
    ["another unit", { amount: { quantity: 2, unitCode: "ml" } }, null],
    ["no amount", { amount: null }, null],
  ])("a dose moves stock: %s", (_name, over, want) => {
    expect(
      doseStockMove({
        outcome: "given",
        isControlledDrug: false,
        item: { unitCode: "tablet" },
        amount: { quantity: 2, unitCode: "tablet" },
        ...over,
      }),
    ).toBe(want);
  });

  it.each([
    ["a dose corrected from 2 to 1", -1, -2, 1],
    ["a dose corrected to not given", 0, -2, 2],
    ["a dose corrected to given", -2, 0, -2],
    ["a correction of the time only", -2, -2, null],
  ])("%s", (_name, should, moved, want) => {
    expect(correctionStockChange({ shouldHaveLeft: should, alreadyMoved: moved })).toBe(want);
  });

  it("adjusts a count only when it differs, and asks for a count once below zero", () => {
    expect(countAdjustment(10, 10)).toBeNull();
    expect(countAdjustment(10, 8)).toBe(-2);
    expect(countAdjustment(-1, 0)).toBe(1);
    expect(countAdjustment(1, -1)).toBeNaN();
    expect(crossedBelowZero(1, -1)).toBe(true);
    expect(crossedBelowZero(0, -1)).toBe(true);
    expect(crossedBelowZero(-1, -2)).toBe(false);
  });
});

describe("hazard HZ-002 MEDS-008 rule 5 disposal witnesses", () => {
  it.each([
    ["a second member when required", true, "w", null, null],
    ["the recorder as their own witness", true, "r", null, "witness_is_recorder"],
    ["no witness when required", true, null, "Only one of us on shift", "witness_required"],
    ["no witness with a reason, where allowed", false, null, "Only one of us on shift", null],
    ["no witness with too short a reason", false, null, "alone", "no_witness_reason"],
    ["both a witness and a reason", false, "w", "Only one of us on shift", "witness_and_reason"],
  ])("%s", (_name, required, witnessId, reason, want) => {
    expect(
      checkDisposalWitness({
        witnessRequired: required,
        recorderId: "r",
        witnessId,
        noWitnessReason: reason,
      }),
    ).toBe(want);
  });
});

describe("MEDS-008 rule 6 the 28-day cycle and reorder prompts", () => {
  it.each([
    ["before the anchor", "2026-11-02", "2026-10-20", "2026-11-02"],
    ["on the anchor", "2026-11-02", "2026-11-02", "2026-11-02"],
    ["mid-cycle", "2026-11-02", "2026-11-20", "2026-11-02"],
    ["across the clock change", "2026-10-05", "2026-11-01", "2026-10-05"],
    ["the next cycle's first day", "2026-11-02", "2026-11-30", "2026-11-30"],
  ])("the cycle running %s", (_name, anchor, today, want) => {
    expect(cycleStartOn(anchor, today, 28)).toBe(want);
  });

  it("finds the next start, and prompts within the days before it", () => {
    expect(nextCycleStart("2026-11-02", "2026-11-20", 28)).toBe("2026-11-30");
    expect(nextCycleStart("2026-11-02", "2026-11-30", 28)).toBe("2026-11-30");
    expect(orderDueFor("2026-11-02", "2026-11-22", RATES)).toBeNull();
    expect(orderDueFor("2026-11-02", "2026-11-23", RATES)).toBe("2026-11-30");
    expect(orderDueFor("2026-11-02", "2026-11-30", RATES)).toBe("2026-11-30");
    expect(() => cycleStartOn("2026-11-02", "2026-11-03", 0)).toThrow();
  });
});

describe("MEDS-008 rule 7 order status", () => {
  it.each([
    ["draft", "submitted", true],
    ["draft", "received", false],
    ["submitted", "cancelled", true],
    ["received", "cancelled", false],
    ["cancelled", "submitted", false],
  ] as const)("%s to %s", (from, to, want) => {
    expect(canMoveOrder(from, to)).toBe(want);
  });

  it("follows the receipts", () => {
    expect(orderStatusFromReceipts([{ quantity: 28, received: 0 }])).toBe("submitted");
    expect(
      orderStatusFromReceipts([
        { quantity: 28, received: 14 },
        { quantity: 1, received: 0 },
      ]),
    ).toBe("part_received");
    expect(orderStatusFromReceipts([{ quantity: 28, received: 30 }])).toBe("received");
  });
});

describe("hazard HZ-002 MEDS-008 rule 8 storage temperatures", () => {
  const fridge = storageRange("fridge", RATES);
  const room = storageRange("room", RATES);
  it.each([
    ["a fridge at 2.0", fridge, { tenths: 20 }, false],
    ["a fridge at 8.0", fridge, { tenths: 80 }, false],
    ["a fridge at 8.1", fridge, { tenths: 81 }, true],
    ["a fridge at 1.9", fridge, { tenths: 19 }, true],
    ["a fridge at 5 whose maximum reached 9", fridge, { tenths: 50, maxTenths: 90 }, true],
    ["a fridge at 5 whose minimum fell to 1", fridge, { tenths: 50, minTenths: 10 }, true],
    ["a room at 25.0", room, { tenths: 250 }, false],
    ["a room at 25.1", room, { tenths: 251 }, true],
    ["a cold room", room, { tenths: 50 }, false],
  ])("%s", (_name, range, reading, want) => {
    expect(readingOutOfRange(reading, range)).toBe(want);
  });

  it("never tells anyone whether the medicines can be used", () => {
    expect(TEMPERATURE_TASK_TITLE).toMatch(/ask the pharmacist/);
    expect(TEMPERATURE_TASK_TITLE).not.toMatch(
      /safe to use|discard|throw away|still fine|use them/i,
    );
  });
});
