import { describe, expect, it } from "vitest";
import {
  HR_RATE_MAX_PENCE,
  hrPayUnits,
  inboundPayPeriod,
  inboundRate,
  lowestRateIn,
  matchesHrPayPeriod,
  payCodesProblem,
  rateOn,
} from "./thapsus-hr-pay";

/**
 * Pay through Thapsus-HR (integrations.md section 11.5 rules 11 and 12; slice 89; ADR-0131;
 * HZ-133, HZ-140). Invented identifiers only.
 */

describe("hazard HZ-140 a pay period from Thapsus-HR is taken only when it is whole and real", () => {
  const ok = { id: "pp_1", frequency: "monthly", startsOn: "2026-11-01", endsOn: "2026-11-30" };
  it.each([
    ["a month", ok, true],
    ["a week", { ...ok, frequency: "weekly", endsOn: "2026-11-07" }, true],
    ["a fortnight frequency", { ...ok, frequency: "fortnightly" }, false],
    ["a day that does not exist", { ...ok, endsOn: "2026-11-31" }, false],
    ["an end before its start", { ...ok, endsOn: "2026-10-31" }, false],
    ["more than 31 days", { ...ok, endsOn: "2026-12-02" }, false],
    ["a bad identifier", { ...ok, id: "pp 1" }, false],
    ["no identifier", { ...ok, id: undefined }, false],
  ] as const)("%s", (_name, raw, taken) => {
    expect(inboundPayPeriod(raw as Record<string, unknown>) !== null).toBe(taken);
  });

  it("keeps only identifier, frequency and dates", () => {
    expect(inboundPayPeriod({ ...ok, payDate: "2026-11-28", gross: 100 })).toEqual(ok);
  });
});

describe("hazard HZ-140 an hourly rate is taken only in whole pence on a real day", () => {
  const ok = { employeeId: "emp_1", hourlyPence: 1_271, effectiveFrom: "2026-04-01" };
  it.each([
    ["a rate", ok, true],
    ["pounds, not pence", { ...ok, hourlyPence: 12.71 }, false],
    ["zero", { ...ok, hourlyPence: 0 }, false],
    ["above the ceiling", { ...ok, hourlyPence: HR_RATE_MAX_PENCE + 1 }, false],
    ["a text rate", { ...ok, hourlyPence: "1271" }, false],
    ["no date", { ...ok, effectiveFrom: null }, false],
    ["a day that does not exist", { ...ok, effectiveFrom: "2026-02-30" }, false],
  ] as const)("%s", (_name, raw, taken) => {
    expect(inboundRate(raw as Record<string, unknown>) !== null).toBe(taken);
  });

  it("drops everything but employee, rate and date", () => {
    expect(inboundRate({ ...ok, annualSalary: 30_000, niNumber: "QQ123456C" })).toEqual(ok);
  });
});

describe("hazard HZ-140 the rate on a day is the latest that took effect by then", () => {
  const rates = [
    { employeeId: "e", hourlyPence: 1_200, effectiveFrom: "2026-04-01" },
    { employeeId: "e", hourlyPence: 1_300, effectiveFrom: "2026-10-01" },
  ];
  it.each([
    ["before any", "2026-03-31", null],
    ["on the first", "2026-04-01", 1_200],
    ["the day before a rise", "2026-09-30", 1_200],
    ["on the rise", "2026-10-01", 1_300],
    ["after", "2027-01-01", 1_300],
  ] as const)("%s", (_name, day, pence) => {
    expect(rateOn(rates, day)?.hourlyPence ?? null).toBe(pence);
  });
});

describe("hazard HZ-140 the minimum wage is checked against the lowest rate in force in the period", () => {
  const r = (pence: number, from: string) => ({
    employeeId: "e",
    hourlyPence: pence,
    effectiveFrom: from,
  });
  it.each([
    ["one rate all period", [r(1_300, "2026-04-01")], 1_300],
    ["a cut part-way through", [r(1_300, "2026-04-01"), r(1_250, "2026-11-10")], 1_250],
    ["a rise part-way through", [r(1_300, "2026-04-01"), r(1_400, "2026-11-10")], 1_300],
    ["a starter whose rate begins during it", [r(1_280, "2026-11-04")], 1_280],
    ["a rate only after it", [r(1_300, "2026-12-01")], null],
    ["no rate", [], null],
  ] as const)("%s", (_name, rates, pence) => {
    expect(lowestRateIn([...rates], "2026-11-02", "2026-11-15")?.hourlyPence ?? null).toBe(pence);
  });
});

describe("hazard HZ-140 a pay run uses Thapsus-HR's pay period exactly (rule 11)", () => {
  const periods = [
    { id: "pp_1", frequency: "monthly", startsOn: "2026-11-01", endsOn: "2026-11-30" },
  ] as const;
  it.each([
    [
      "the same period",
      { frequency: "monthly", periodStart: "2026-11-01", periodEnd: "2026-11-30" },
      "pp_1",
    ],
    [
      "a day short",
      { frequency: "monthly", periodStart: "2026-11-01", periodEnd: "2026-11-29" },
      null,
    ],
    [
      "another frequency",
      { frequency: "weekly", periodStart: "2026-11-01", periodEnd: "2026-11-30" },
      null,
    ],
  ] as const)("%s", (_name, run, id) => {
    expect(matchesHrPayPeriod(run, periods)?.id ?? null).toBe(id);
  });
});

describe("hazard HZ-140 units go out by pay code, summed, and never with a kind left unmapped (rule 11)", () => {
  const codes = { hours: "BASIC", hours_night: "NIGHT", sleep_in: "SLEEP", hours_weekend: "BASIC" };

  it("maps kinds to codes, sums per employee and code, and rounds to 2 places", () => {
    const plan = hrPayUnits(
      "pp_1",
      [
        {
          employeeId: "emp_2",
          units: [
            { kind: "hours", quantity: 7.333 },
            { kind: "hours_weekend", quantity: 4 },
            { kind: "sleep_in", quantity: 2 },
          ],
        },
        { employeeId: "emp_1", units: [{ kind: "hours_night", quantity: 8 }] },
      ],
      codes,
    );
    expect(plan).toEqual({
      unmapped: [],
      units: [
        { employeeId: "emp_1", payPeriodId: "pp_1", payCode: "NIGHT", units: 8 },
        { employeeId: "emp_2", payPeriodId: "pp_1", payCode: "BASIC", units: 11.33 },
        { employeeId: "emp_2", payPeriodId: "pp_1", payCode: "SLEEP", units: 2 },
      ],
    });
  });

  it("sends nothing for the period while any kind has no pay code, and names it", () => {
    const plan = hrPayUnits(
      "pp_1",
      [
        { employeeId: "emp_1", units: [{ kind: "hours", quantity: 8 }] },
        { employeeId: "emp_2", units: [{ kind: "mileage", quantity: 12.5 }] },
      ],
      codes,
    );
    expect(plan).toEqual({ units: [], unmapped: ["mileage"] });
  });

  it("ignores zero and negative quantities, and never takes an inherited key as a code", () => {
    expect(
      hrPayUnits(
        "pp_1",
        [
          {
            employeeId: "emp_1",
            units: [
              { kind: "hours", quantity: 0 },
              { kind: "toString", quantity: 1 },
            ],
          },
        ],
        codes,
      ).unmapped,
    ).toEqual(["toString"]);
  });

  it.each([
    [
      "known kinds and codes",
      { hours: "BASIC", hours_night_weekend: "NW", mileage: "MILES" },
      null,
    ],
    ["an unknown kind", { overtime_pay: "OT" }, "unknown unit kind overtime_pay"],
    ["a code with spaces", { hours: "BASIC PAY" }, "pay code for hours"],
    ["a number for a code", { hours: 1 }, "pay code for hours"],
  ] as const)("checks a mapping: %s", (_name, mapping, problem) => {
    expect(payCodesProblem(mapping)).toBe(problem);
  });
});
