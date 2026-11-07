import { describe, expect, it } from "vitest";
import {
  checkMedicineListItem,
  checkPrnOutcome,
  checkPrnProtocol,
  type PrnProtocolInput,
  type PrnReportDose,
  prnFrequency,
  prnProtocolStatus,
  protocolInForce,
} from "./prn-protocol";

/** Figures as a tenant's rate table would give them; never a literal default in the rules. */
const RATES = { reviewMaxDays: 182 };
const today = "2026-11-06";

describe("hazard HZ-117 a PRN protocol for a when-required medicine (slice 28)", () => {
  const good: PrnProtocolInput = {
    entry: { personId: "p1", directions: "when_required", state: "checked" },
    personId: "p1",
    purpose: "Distress in the evening that does not settle with reassurance",
    triggers: ["Pacing and calling out", "Pulling at clothes"],
    nonDrugAlternatives: ["Quiet room and music", "A walk with a member of staff"],
    purposeGroup: "Distress",
    orderOfUse: 2,
    expectedEffect: "Calmer within an hour",
    agreedWithName: "Dr A Example",
    agreedWithRole: "prescriber",
    agreedOn: "2026-11-01",
    reviewOn: "2027-01-01",
    takenOrders: [1],
  };
  const ctx = { today, reviewMaxDays: RATES.reviewMaxDays };

  it("accepts a complete protocol, and one with no order", () => {
    expect(checkPrnProtocol(good, ctx)).toEqual([]);
    expect(checkPrnProtocol({ ...good, purposeGroup: null, orderOfUse: null }, ctx)).toEqual([]);
  });

  it.each<[string, Partial<PrnProtocolInput>, string[]]>([
    ["no entry", { entry: null }, ["entry_other_person"]],
    [
      "another person's entry",
      { entry: { ...good.entry, personId: "p2" } as PrnProtocolInput["entry"] },
      ["entry_other_person"],
    ],
    [
      "a regular medicine",
      { entry: { personId: "p1", directions: "regular", state: "checked" } },
      ["entry_not_when_required"],
    ],
    [
      "a stopped medicine",
      { entry: { personId: "p1", directions: "when_required", state: "stopped" } },
      ["entry_not_current"],
    ],
    ["no triggers", { triggers: [" "] }, ["no_triggers"]],
    ["an order with no group", { purposeGroup: null }, ["order_without_group"]],
    ["a place already taken", { orderOfUse: 1 }, ["order_taken"]],
    [
      "an agreement in the future",
      { agreedOn: "2026-11-07", reviewOn: "2027-01-01" },
      ["agreed_in_future"],
    ],
    ["a review on the agreement", { reviewOn: "2026-11-01" }, ["review_not_after_agreement"]],
    ["a review past the rate table's days", { reviewOn: "2027-05-03" }, ["review_too_far"]],
  ])("refuses %s", (_name, change, problems) => {
    expect(checkPrnProtocol({ ...good, ...change }, ctx)).toEqual(problems);
  });

  it("allows the review on the last day the rate table allows", () => {
    expect(checkPrnProtocol({ ...good, reviewOn: "2027-05-02" }, ctx)).toEqual([]);
  });

  it.each([
    [{ state: "stopped", directions: "when_required" }, "medicine_stopped"],
    [{ state: "replaced", directions: "when_required" }, "medicine_stopped"],
    [{ state: "withdrawn", directions: "when_required" }, "medicine_stopped"],
    [{ state: "checked", directions: "regular" }, "not_when_required_now"],
    [{ state: "checked", directions: "when_required" }, "in_use"],
  ] as const)("reads the entry: %o is %s", (entry, state) => {
    expect(prnProtocolStatus({ withdrawnOn: null, reviewOn: "2027-01-01" }, today, entry)).toBe(
      state,
    );
  });

  it.each([
    [{ withdrawnOn: null, reviewOn: today }, "in_use"],
    [{ withdrawnOn: null, reviewOn: "2026-11-05" }, "review_overdue"],
    [{ withdrawnOn: today, reviewOn: "2027-01-01" }, "withdrawn"],
    [{ withdrawnOn: "2026-11-07", reviewOn: "2027-01-01" }, "in_use"],
  ] as const)("names a protocol's state %#", (p, state) => {
    expect(prnProtocolStatus(p, today)).toBe(state);
  });
});

describe("hazard HZ-117 the outcome of a when-required dose (slice 28)", () => {
  const givenAt = new Date("2026-11-06T10:00:00Z");
  const now = new Date("2026-11-06T12:00:00Z");
  const dose = { dueAt: null, outcome: "given", givenAt };

  it("accepts an outcome seen after the dose", () => {
    expect(checkPrnOutcome({ dose, observedAt: new Date("2026-11-06T11:00:00Z"), now })).toEqual(
      [],
    );
  });

  it.each<[string, Parameters<typeof checkPrnOutcome>[0], string[]]>([
    [
      "a scheduled dose",
      { dose: { ...dose, dueAt: givenAt }, observedAt: now, now },
      ["not_when_required"],
    ],
    [
      "a refused dose",
      { dose: { ...dose, outcome: "refused" }, observedAt: now, now },
      ["not_given"],
    ],
    [
      "a time before the dose",
      { dose, observedAt: new Date("2026-11-06T09:59:00Z"), now },
      ["before_dose"],
    ],
    [
      "a time in the future",
      { dose, observedAt: new Date("2026-11-06T12:01:00Z"), now },
      ["in_future"],
    ],
  ])("refuses %s", (_name, input, problems) => {
    expect(checkPrnOutcome(input)).toEqual(problems);
  });
});

describe("hazard HZ-117 the PRN frequency report counts, never judges (slice 28)", () => {
  const at = (iso: string) => new Date(iso);
  const base: PrnReportDose = {
    personId: "p1",
    medicineId: "m1",
    at: at("2026-10-24T10:00:00Z"),
    psychotropic: true,
    protocol: "current",
    outcome: "effective",
    outcomeDue: true,
  };

  it("counts doses, UK days, the most in a day, outcomes and doses without a protocol", () => {
    const lines = prnFrequency([
      base,
      { ...base, at: at("2026-10-24T22:30:00Z"), outcome: null },
      // BST ends at 01:00 UTC on 25/10/2026, so 23:30 UTC on the 24th is 00:30 on the 25th, UK time.
      { ...base, at: at("2026-10-24T23:30:00Z"), outcome: "not_effective", protocol: "none" },
      { ...base, medicineId: "m2", psychotropic: false, outcome: null, outcomeDue: false },
    ]);
    expect(lines).toEqual([
      {
        personId: "p1",
        medicineId: "m1",
        psychotropic: true,
        doses: 3,
        daysWithDoses: 2,
        mostInOneDay: 2,
        withoutProtocol: 1,
        underOverdueProtocol: 0,
        outcomes: {
          effective: 1,
          partly_effective: 0,
          not_effective: 1,
          person_asleep: 0,
          could_not_assess: 0,
        },
        outcomesOutstanding: 1,
      },
      {
        personId: "p1",
        medicineId: "m2",
        psychotropic: false,
        doses: 1,
        daysWithDoses: 1,
        mostInOneDay: 1,
        withoutProtocol: 0,
        underOverdueProtocol: 0,
        outcomes: {
          effective: 0,
          partly_effective: 0,
          not_effective: 0,
          person_asleep: 0,
          could_not_assess: 0,
        },
        outcomesOutstanding: 0,
      },
    ]);
  });

  it.each([
    // 25/10/2026, the 25-hour day: 00:30 UTC is 01:30 BST and 01:30 UTC is 01:30 GMT, one UK day.
    [
      "the day the clocks go back",
      ["2026-10-25T00:30:00Z", "2026-10-25T01:30:00Z", "2026-10-25T23:30:00Z"],
      1,
      3,
    ],
    // 29/03/2026, the 23-hour day: 23:30 UTC on the 29th is 00:30 BST on the 30th.
    [
      "the day the clocks go forward",
      ["2026-03-29T00:30:00Z", "2026-03-29T01:30:00Z", "2026-03-29T23:30:00Z"],
      2,
      2,
    ],
  ])("counts UK calendar days on %s", (_name, times, days, most) => {
    const [line] = prnFrequency(times.map((t) => ({ ...base, at: at(t) })));
    expect(line?.daysWithDoses).toBe(days);
    expect(line?.mostInOneDay).toBe(most);
  });

  it("counts a dose given under a protocol past its review apart", () => {
    const [line] = prnFrequency([base, { ...base, protocol: "review_overdue" }]);
    expect(line?.underOverdueProtocol).toBe(1);
    expect(line?.withoutProtocol).toBe(0);
  });

  it("is empty with no doses", () => {
    expect(prnFrequency([])).toEqual([]);
  });
});

describe("hazard HZ-117 which protocol was in force when a dose was given (slice 28)", () => {
  const recordedAt = new Date("2026-11-05T12:00:00Z");
  const p = {
    recordedAt,
    agreedFrom: new Date("2026-10-01T00:00:00Z"),
    withdrawnAt: new Date("2026-11-06T09:00:00Z"),
    reviews: [{ from: recordedAt, reviewOn: "2026-11-05" }],
  };
  it.each([
    ["before it was recorded, though agreed earlier", "2026-11-05T11:59:00Z", "none"],
    ["once recorded, before its review date passed", "2026-11-05T12:00:00Z", "current"],
    ["after its review date, still in force", "2026-11-06T08:00:00Z", "review_overdue"],
    ["earlier on the day it was withdrawn", "2026-11-06T08:59:00Z", "review_overdue"],
    ["once withdrawn", "2026-11-06T09:00:00Z", "none"],
  ])("is %s", (_name, when, expected) => {
    expect(protocolInForce([p], new Date(when))).toBe(expected);
  });

  it("keeps a dose given while overdue as overdue after a review recorded later", () => {
    const reviewed = {
      ...p,
      withdrawnAt: null,
      reviews: [
        { from: recordedAt, reviewOn: "2026-11-05" },
        { from: new Date("2026-11-07T10:00:00Z"), reviewOn: "2027-02-01" },
      ],
    };
    expect(protocolInForce([reviewed], new Date("2026-11-06T08:00:00Z"))).toBe("review_overdue");
    expect(protocolInForce([reviewed], new Date("2026-11-07T11:00:00Z"))).toBe("current");
  });
});

describe("hazard HZ-117 the tenant's medicine lists hold exact products (slice 28, ADR-0082)", () => {
  it.each<[string, string, string[]]>([
    ["a dm+d product", "90000011000001104", []],
    ["a name", "lorazepam", ["not_a_product"]],
    ["a product already listed", "90000071000001107", ["already_listed"]],
  ])("checks %s", (_name, vmp, problems) => {
    expect(checkMedicineListItem(vmp, new Set(["90000071000001107"]))).toEqual(problems);
  });
});
