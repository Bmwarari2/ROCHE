import { describe, expect, it } from "vitest";
import { CARE_HOME, SETTING, tableWorkingTimeRates } from "../../test/working-time";
import {
  checkNightTime,
  checkOptOutAgreement,
  nightAverageReferenceWeeks,
  nightTimeFor,
  optOutInForce,
  optOutLastDay,
  weeklyAverageReferenceWeeks,
} from "./agreements";
import type { OptOutAgreement } from "./working-time-types";

const rates = tableWorkingTimeRates();

const signed: OptOutAgreement = {
  signedOn: "2026-01-05",
  endsOn: null,
  noticePeriod: null,
  noticeGivenOn: null,
};

describe("opt-outs from the 48-hour average (reg 4(1), 5; scheduling.md rule 3)", () => {
  it.each<[string, OptOutAgreement, string | null]>([
    ["indefinite with no notice given", signed, null],
    ["for a specified period", { ...signed, endsOn: "2026-06-30" }, "2026-06-30"],
    [
      "notice given, default notice period from the rate table",
      { ...signed, noticeGivenOn: "2026-11-02" },
      "default",
    ],
    [
      "notice given under the agreement's own one-month period",
      { ...signed, noticeGivenOn: "2026-11-02", noticePeriod: { amount: 1, unit: "months" } },
      "2026-12-02",
    ],
    [
      "an agreement's notice longer than the maximum is capped at it",
      { ...signed, noticeGivenOn: "2026-11-02", noticePeriod: { amount: 6, unit: "months" } },
      "2027-02-02",
    ],
    [
      "a specified period ending before the notice runs out",
      { ...signed, endsOn: "2026-11-04", noticeGivenOn: "2026-11-02" },
      "2026-11-04",
    ],
  ])("%s", (_name, agreement, expected) => {
    const last = optOutLastDay(agreement, rates);
    if (expected === "default") {
      const day = new Date("2026-11-02T00:00:00Z");
      day.setUTCDate(day.getUTCDate() + rates.optOutDefaultNoticeDays);
      expect(last).toBe(day.toISOString().split("T")[0]);
    } else {
      expect(last).toBe(expected);
    }
  });

  it("is in force from the day it is signed to its last day only", () => {
    const ending = { ...signed, endsOn: "2026-06-30" };
    expect(optOutInForce([ending], "2026-01-04", rates)).toBe(false);
    expect(optOutInForce([ending], "2026-01-05", rates)).toBe(true);
    expect(optOutInForce([ending], "2026-06-30", rates)).toBe(true);
    expect(optOutInForce([ending], "2026-07-01", rates)).toBe(false);
    expect(
      optOutInForce([ending, { ...signed, signedOn: "2026-07-01" }], "2026-07-01", rates),
    ).toBe(true);
  });

  it.each<[string, OptOutAgreement, string[]]>([
    ["a valid agreement", signed, []],
    [
      "notice longer than the maximum",
      { ...signed, noticePeriod: { amount: 4, unit: "months" } },
      ["notice_too_long"],
    ],
    [
      "notice of 100 days",
      { ...signed, noticePeriod: { amount: 100, unit: "days" } },
      ["notice_too_long"],
    ],
    [
      "notice of 0 days",
      { ...signed, noticePeriod: { amount: 0, unit: "days" } },
      ["notice_not_positive"],
    ],
    ["ending before it was signed", { ...signed, endsOn: "2025-12-31" }, ["ends_before_signed"]],
    [
      "notice before it was signed",
      { ...signed, noticeGivenOn: "2025-12-31" },
      ["notice_before_signed"],
    ],
  ])("checks %s", (_name, agreement, issues) => {
    expect(checkOptOutAgreement(agreement, rates)).toEqual(issues);
  });
});

describe("night time (reg 2; scheduling.md rule 6)", () => {
  it("defaults to the rate table's night time", () => {
    expect(nightTimeFor(SETTING, rates)).toEqual({
      startMinute: rates.nightDefaultStartMinute,
      endMinute: rates.nightDefaultEndMinute,
    });
  });

  it.each<[string, number, number, string[]]>([
    ["22:00 to 05:00", 1320, 300, []],
    ["00:00 to 07:00", 0, 420, []],
    ["23:00 to 05:00 (too short)", 1380, 300, ["too_short"]],
    ["01:00 to 08:00 (misses midnight)", 60, 480, ["misses_core_hours"]],
    ["21:00 to 04:00 (misses 04:00 to 05:00)", 1260, 240, ["misses_core_hours"]],
    ["not a minute of the day", 1440, 300, ["not_minutes_of_day"]],
    ["the same start and end, all day", 0, 0, []],
  ])("an agreed night time of %s", (_name, startMinute, endMinute, issues) => {
    expect(checkNightTime({ startMinute, endMinute }, rates)).toEqual(issues);
  });

  it("uses a valid agreed night time and refuses an invalid one", () => {
    const agreed = { startMinute: 1320, endMinute: 300 };
    expect(nightTimeFor({ ...SETTING, agreedNightTime: agreed }, rates)).toEqual(agreed);
    expect(() =>
      nightTimeFor({ ...SETTING, agreedNightTime: { startMinute: 60, endMinute: 480 } }, rates),
    ).toThrow(RangeError);
  });
});

describe("reference periods (reg 4(3), (5), 6(3), 23; scheduling.md rule 1)", () => {
  it("is the standard period, the special-case period, or an agreed period up to the maximum", () => {
    expect(weeklyAverageReferenceWeeks(SETTING, rates)).toBe(rates.referencePeriodWeeks);
    expect(weeklyAverageReferenceWeeks(CARE_HOME, rates)).toBe(
      rates.specialCaseReferencePeriodWeeks,
    );
    const max = rates.agreementMaxReferencePeriodWeeks;
    expect(
      weeklyAverageReferenceWeeks({ ...CARE_HOME, agreedReferencePeriodWeeks: max }, rates),
    ).toBe(max);
    expect(() =>
      weeklyAverageReferenceWeeks({ ...SETTING, agreedReferencePeriodWeeks: max + 1 }, rates),
    ).toThrow(RangeError);
    expect(() =>
      weeklyAverageReferenceWeeks({ ...SETTING, agreedReferencePeriodWeeks: 0 }, rates),
    ).toThrow(RangeError);
  });

  it("keeps the night period at the standard length unless an agreement changes it", () => {
    expect(nightAverageReferenceWeeks(CARE_HOME, rates)).toBe(rates.nightReferencePeriodWeeks);
    expect(
      nightAverageReferenceWeeks({ ...SETTING, agreedNightReferencePeriodWeeks: 26 }, rates),
    ).toBe(26);
  });
});
