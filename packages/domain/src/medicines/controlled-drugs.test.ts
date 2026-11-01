import { describe, expect, it } from "vitest";
import { PERSON, PRODUCT } from "../../test/medicines-fixtures";
import { tableMedicinesRates } from "../../test/rate-table";
import { addUkDays, fromUkWallClock } from "../shared/time";
import {
  type CdEntry,
  type CdEntryProblem,
  type CdWitnessPolicy,
  cdBalanceAfter,
  cdPageBalance,
  cdPageKey,
  cdStockCheck,
  cdStockCheckDueAt,
  checkCdEntry,
  defaultCdWitnessPolicy,
  type ServiceType,
} from "./controlled-drugs";

const rates = tableMedicinesRates();
const NURSE = "member-nurse";
const WITNESS = "member-witness";
const page = cdPageKey(PERSON, PRODUCT.warfarin);
const at = (day: number, hour: number) => fromUkWallClock(2026, 11, day, hour, 0);
const cd = (id: string, overrides: Partial<CdEntry> = {}): CdEntry => ({
  id,
  pageKey: page,
  movement: "administration",
  quantity: 1,
  correctsId: null,
  corrects: null,
  reason: null,
  balanceAfter: 0,
  at: at(2, 8),
  recordedBy: NURSE,
  witnessedBy: WITNESS,
  noWitnessReason: null,
  ...overrides,
});
const receipt = cd("cd-1", { movement: "receipt", quantity: 28, balanceAfter: 28, at: at(1, 10) });
const given = cd("cd-2", { quantity: 1, balanceAfter: 27 });
const problems = (
  pageEntries: CdEntry[],
  entry: CdEntry,
  policy: CdWitnessPolicy = "required",
): CdEntryProblem[] => {
  const result = checkCdEntry(pageEntries, entry, policy);
  return result.ok ? [] : result.issues.map((i) => i.problem);
};

describe("one register page per person, drug, form and strength", () => {
  it("keys the page by the person and the dm+d VMP, which carries the drug, form and strength", () => {
    expect(cdPageKey(PERSON, PRODUCT.warfarin)).toBe(`${PERSON}|${PRODUCT.warfarin.vmpId}`);
    expect(cdPageKey(PERSON, PRODUCT.paracetamolBrandA)).toBe(
      cdPageKey(PERSON, PRODUCT.paracetamolBrandB),
    );
    expect(cdPageKey(PERSON, PRODUCT.paracetamolTablets)).not.toBe(
      cdPageKey(PERSON, PRODUCT.paracetamolCapsules),
    );
  });

  it("refuses an entry for another page", () => {
    expect(problems([receipt], cd("x", { pageKey: "other|page", balanceAfter: 27 }))).toEqual([
      "wrong_page",
    ]);
  });
});

describe("the running balance is stored on every entry and checked against the one before", () => {
  it.each([
    ["receipt", 10, 38],
    ["administration", 1, 27],
    ["disposal", 2, 26],
    ["transfer_out", 28, 0],
    ["destruction", 3, 25],
    ["correction", -1, 27],
    ["correction", 2, 30],
  ] as const)("a %s of %d after 28 leaves %d", (movement, quantity, balance) => {
    expect(cdBalanceAfter(28, movement, quantity)).toBe(balance);
  });

  it("keeps liquids to 3 decimal places", () => {
    expect(cdBalanceAfter(10.5, "administration", 2.5)).toBe(8);
    expect(cdBalanceAfter(0.3, "administration", 0.1)).toBe(0.2);
  });

  it.each<[string, Partial<CdEntry>, CdEntryProblem[]]>([
    ["the balance it should leave", {}, []],
    ["a balance that does not follow from the last", { balanceAfter: 26 }, ["balance_wrong"]],
    ["more than the page holds", { quantity: 29, balanceAfter: -1 }, ["balance_negative"]],
    ["no amount", { quantity: 0 }, ["bad_quantity"]],
    [
      "a negative amount that is not a correction",
      { quantity: -1, balanceAfter: 29 },
      ["bad_quantity"],
    ],
    ["an entry dated before the last", { at: at(1, 9) }, ["not_chronological"]],
  ])("refuses or takes an entry with %s", (_name, overrides, expected) => {
    expect(problems([receipt], cd("cd-2", { ...given, ...overrides }))).toEqual(expected);
  });

  it("reads the page's balance from its last entry, and none from an empty page", () => {
    expect(cdPageBalance([receipt, given])).toBe(27);
    expect(cdPageBalance([])).toBe(0);
  });

  it("says the balance it expected in words, including none", () => {
    const result = checkCdEntry(
      [receipt],
      cd("x", { movement: "transfer_out", quantity: 28, balanceAfter: 1 }),
      "required",
    );
    expect(result.ok ? "" : result.issues[0]?.message).toBe(
      "The balance after this entry is 0, not 1. Check the count.",
    );
  });
});

describe("a mistake is put right by a correction entry beside it, never by editing (margin correction)", () => {
  it("takes a correction that names the entry it corrects and why", () => {
    const correction = cd("cd-3", {
      movement: "correction",
      corrects: "quantity",
      quantity: 1,
      balanceAfter: 28,
      correctsId: "cd-2",
      reason: "Dose was refused; not given",
      at: at(2, 9),
    });
    expect(problems([receipt, given], correction)).toEqual([]);
  });

  it.each<[string, Partial<CdEntry>, CdEntryProblem[]]>([
    [
      "corrects the time and changes no quantity",
      { quantity: 0, balanceAfter: 27, reason: "Time was 08:10, not 08:00" },
      [],
    ],
    [
      "changes no quantity but leaves a different balance",
      { quantity: 0, balanceAfter: 28, reason: "Time was 08:10" },
      ["balance_wrong"],
    ],
    [
      "changes no quantity and says nothing",
      { quantity: 0, balanceAfter: 27, reason: " " },
      ["correction_needs_reason"],
    ],
    [
      "says it corrects a detail but changes the quantity",
      { quantity: 1, balanceAfter: 28, reason: "Time was 08:10" },
      ["correction_kind_mismatch"],
    ],
    [
      "corrects the quantity by nothing (a mistyped 0)",
      { corrects: "quantity", quantity: 0, balanceAfter: 27, reason: "Miscount" },
      ["bad_quantity"],
    ],
    [
      "does not say what it puts right",
      { corrects: null, quantity: 0, balanceAfter: 27, reason: "Time was 08:10" },
      ["bad_quantity", "correction_needs_kind"],
    ],
  ])("hazard HZ-116 a margin correction that %s", (_name, overrides, expected) => {
    const base = cd("cd-3", {
      movement: "correction",
      corrects: "detail",
      correctsId: "cd-2",
      at: at(2, 9),
    });
    expect(problems([receipt, given], { ...base, ...overrides })).toEqual(expected);
  });

  it("still refuses an entry of nothing that is not a correction", () => {
    expect(problems([receipt], cd("cd-2", { quantity: 0, balanceAfter: 28 }))).toEqual([
      "bad_quantity",
    ]);
  });

  it.each<[string, Partial<CdEntry>, CdEntryProblem[]]>([
    ["names no entry", { correctsId: null }, ["correction_needs_entry"]],
    ["names an entry on another page", { correctsId: "cd-99" }, ["correction_needs_entry"]],
    ["gives no reason", { reason: " " }, ["correction_needs_reason"]],
  ])("refuses a correction that %s", (_name, overrides, expected) => {
    const base = cd("cd-3", {
      movement: "correction",
      corrects: "quantity",
      quantity: 1,
      balanceAfter: 28,
      correctsId: "cd-2",
      reason: "Refused",
      at: at(2, 9),
    });
    expect(problems([receipt, given], { ...base, ...overrides })).toEqual(expected);
  });

  it("lets only a correction refer to another entry, or say what it corrects", () => {
    expect(problems([receipt], cd("cd-2", { ...given, correctsId: "cd-1" }))).toEqual([
      "not_a_correction",
    ]);
    expect(problems([receipt], cd("cd-2", { ...given, corrects: "detail" }))).toEqual([
      "not_a_correction",
    ]);
  });
});

describe("hazard HZ-116 a controlled drugs entry is witnessed by a second person, as the tenant's policy says", () => {
  it.each<[ServiceType, CdWitnessPolicy]>([
    ["residential", "required"],
    ["nursing", "required"],
    ["respite", "required"],
    ["childrens_home", "required"],
    ["domiciliary", "where_available"],
    ["supported_living", "where_available"],
    ["live_in", "where_available"],
    ["complex_care", "where_available"],
    ["day_service", "where_available"],
  ])("the default for %s is %s", (service, policy) => {
    expect(defaultCdWitnessPolicy(service)).toBe(policy);
  });

  it("refuses the recorder as their own witness", () => {
    expect(problems([receipt], { ...given, witnessedBy: NURSE })).toEqual(["witness_is_recorder"]);
  });

  it("refuses an entry with no witness where the policy requires one, even with a reason", () => {
    expect(problems([receipt], { ...given, witnessedBy: null })).toEqual(["witness_required"]);
    expect(
      problems([receipt], { ...given, witnessedBy: null, noWitnessReason: "Lone worker" }),
    ).toEqual(["witness_required"]);
  });

  it("lets a lone worker record why there was no witness where the policy allows, flagged for manager review", () => {
    const lone = {
      ...given,
      witnessedBy: null,
      noWitnessReason: "Lone visit; no second member of staff",
    };
    expect(checkCdEntry([receipt], lone, "where_available")).toEqual({
      ok: true,
      flags: ["no_witness_for_review"],
    });
    expect(problems([receipt], { ...given, witnessedBy: null }, "where_available")).toEqual([
      "witness_required",
    ]);
  });

  it("always needs a witness for destruction, whatever the policy", () => {
    const destroyed = cd("cd-2", {
      movement: "destruction",
      quantity: 2,
      balanceAfter: 26,
      witnessedBy: null,
      noWitnessReason: "None on shift",
    });
    expect(problems([receipt], destroyed, "where_available")).toEqual(["witness_required"]);
  });

  it.each<[string, Partial<CdEntry>, CdWitnessPolicy]>([
    ["an empty witness where one is required", { witnessedBy: "" }, "required"],
    ["a blank witness where one is required", { witnessedBy: "   " }, "required"],
    ["an empty witness where a lone worker may say why", { witnessedBy: "" }, "where_available"],
    [
      "an empty witness beside a reason there was none",
      { witnessedBy: "", noWitnessReason: "Lone visit" },
      "where_available",
    ],
    [
      "an empty witness to a destruction (the #162 probe)",
      { movement: "destruction", quantity: 1, balanceAfter: 27, witnessedBy: "" },
      "required",
    ],
  ])("hazard HZ-116 refuses %s", (_name, overrides, policy) => {
    expect(problems([receipt], { ...given, ...overrides }, policy)).toEqual(["witness_blank"]);
  });

  it("refuses a witness and a reason there was none on one entry", () => {
    expect(problems([receipt], { ...given, noWitnessReason: "None" })).toEqual([
      "witness_and_no_witness",
    ]);
  });

  it("takes a witnessed entry with no flag", () => {
    expect(checkCdEntry([receipt], given, "required")).toEqual({ ok: true, flags: [] });
  });
});

describe("stock checks", () => {
  it("raises an incident for any difference between the count and the page", () => {
    expect(cdStockCheck([receipt, given], 27)).toEqual({
      expected: 27,
      counted: 27,
      difference: 0,
      raiseIncident: false,
    });
    expect(cdStockCheck([receipt, given], 26)).toEqual({
      expected: 27,
      counted: 26,
      difference: -1,
      raiseIncident: true,
    });
    expect(cdStockCheck([receipt, given], 27.5).raiseIncident).toBe(true);
  });

  it("falls due the table's number of UK days after the last check", () => {
    expect(cdStockCheckDueAt(at(2, 10), rates)).toEqual(
      addUkDays(at(2, 10), rates.cdStockCheckIntervalDays),
    );
  });
});
