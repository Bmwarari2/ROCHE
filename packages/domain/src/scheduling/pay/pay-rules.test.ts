import { describe, expect, it } from "vitest";
import { grossPay, PayRuleError, type PayRuleSet } from "./pay-rules";

// A tenant's own figures (invented): rule sets hold them, never the rate table or the code.
const set: PayRuleSet = {
  id: "rules-1",
  version: 3,
  roleRates: { care_worker: 1300, senior_carer: 1450 },
  enhancements: [
    { kind: "night", mode: "flat_per_hour", value: 150 },
    { kind: "weekend", mode: "percent", value: 10 },
    { kind: "bank_holiday", mode: "percent", value: 50 },
  ],
  stackEnhancements: false,
  sleepInFlatPence: 9_000,
  mileagePencePerMile: 45,
  onCallFlatPence: 2_500,
};

describe("gross pay from a tenant's pay rule set (scheduling.md 4b rule 1)", () => {
  it("pays basic hours by role, rounded down to the penny, and shows each line", () => {
    const pay = grossPay(set, [
      { kind: "work", role: "care_worker", minutes: 450, enhancements: [] },
    ]);
    expect(pay).toMatchObject({
      basicPence: 9_750,
      premiumPence: 0,
      allowancePence: 0,
      totalPence: 9_750,
    });
    expect(pay.working[0]?.step).toBe("Pay rule set rules-1, version 3");
    expect(pay.working.at(-1)).toEqual({ step: "Gross pay", pence: 9_750 });
  });

  it.each([
    ["a flat night enhancement", ["night"], 900],
    ["a weekend percentage", ["weekend"], 780],
    ["the highest of two when they do not stack", ["night", "bank_holiday"], 3_900],
  ] as const)("adds %s", (_, enhancements, premium) => {
    const pay = grossPay(set, [
      { kind: "work", role: "care_worker", minutes: 360, enhancements: [...enhancements] },
    ]);
    expect(pay.basicPence).toBe(7_800);
    expect(pay.premiumPence).toBe(premium);
  });

  it("adds every enhancement when the set says they stack", () => {
    const pay = grossPay({ ...set, stackEnhancements: true }, [
      { kind: "work", role: "care_worker", minutes: 360, enhancements: ["night", "weekend"] },
    ]);
    expect(pay.premiumPence).toBe(900 + 780);
  });

  it("pays the sleep-in, on-call and mileage allowances as allowances", () => {
    const pay = grossPay(set, [
      { kind: "sleep_in" },
      { kind: "on_call" },
      { kind: "mileage", miles: 12.5 },
    ]);
    expect(pay.allowancePence).toBe(9_000 + 2_500 + 562);
    expect(pay.basicPence).toBe(0);
  });

  it("refuses a role with no rate, or minutes that are not whole", () => {
    expect(() =>
      grossPay(set, [{ kind: "work", role: "chef", minutes: 60, enhancements: [] }]),
    ).toThrow(PayRuleError);
    expect(() =>
      grossPay(set, [{ kind: "work", role: "care_worker", minutes: 1.5, enhancements: [] }]),
    ).toThrow(PayRuleError);
  });

  it("gives the same canonical input for the same inputs, and a different one when the version changes", () => {
    const entries = [{ kind: "sleep_in" } as const];
    expect(grossPay(set, entries).canonicalInput).toBe(
      grossPay({ ...set }, entries).canonicalInput,
    );
    expect(grossPay({ ...set, version: 4 }, entries).canonicalInput).not.toBe(
      grossPay(set, entries).canonicalInput,
    );
  });
});
