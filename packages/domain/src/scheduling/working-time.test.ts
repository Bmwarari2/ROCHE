import { describe, expect, it } from "vitest";
import {
  CARE_HOME,
  check,
  HOUR,
  SETTING,
  shift,
  tableWorkingTimeRates,
} from "../../test/working-time";
import type { WorkPeriod } from "./working-time-types";
import { ADULT_DEROGATIONS, derogationFor, WORKING_TIME_CITATIONS } from "./working-time-types";

/**
 * A week: a day with its break; a sleep-in after it (working time, so no daily rest) running
 * straight into a day shift with no break; and a long day without a break.
 */
const WEEK: WorkPeriod[] = [
  shift("mon", "2026-11-02 08:00", "2026-11-02 20:00", {
    breaks: [{ start: new Date("2026-11-02T12:00:00Z"), end: new Date("2026-11-02T12:30:00Z") }],
  }),
  {
    ...shift("sleep", "2026-11-02 22:00", "2026-11-03 07:00"),
    kind: "sleep_in",
    sleepIn: { expectedToSleep: true, suitableSleepingFacilities: true, awake: [] },
  },
  shift("tue", "2026-11-03 07:00", "2026-11-03 15:00"),
  shift("thu", "2026-11-05 08:00", "2026-11-05 20:00"),
];

describe("checkWorkingTime (SCHED-003)", () => {
  it("reports breaches outside a special case, in time order with their regulation", () => {
    const report = check(WEEK, { on: "2026-11-02", to: "2026-11-08" });
    expect(report.findings.map((f) => [f.rule, f.outcome])).toEqual([
      ["daily_rest", "breach"],
      ["rest_break", "breach"],
      ["rest_break", "breach"],
    ]);
    for (const f of report.findings) expect(f.citation).toBe(WORKING_TIME_CITATIONS[f.rule]);
    expect(report.findings.map((f) => f.periodIds)).toEqual([
      ["mon", "sleep", "tue"],
      ["sleep", "tue"],
      ["thu"],
    ]);
  });

  it("turns the same week into conditions in a care home: compensatory rest owed", () => {
    const report = check(WEEK, { on: "2026-11-02", to: "2026-11-08", setting: CARE_HOME });
    expect(report.findings.every((f) => f.outcome === "conditional")).toBe(true);
    const rates = tableWorkingTimeRates();
    // The 2 hours between the day and the sleep-in fall short of the daily rest; two duties lack a break.
    expect(report.findings.reduce((sum, f) => sum + f.compensatoryRestMinutes, 0)).toBe(
      rates.dailyRestHours * HOUR - 2 * HOUR + 2 * rates.breakMinutes,
    );
  });

  it("checks nothing outside the dates asked for", () => {
    expect(check(WEEK, { on: "2026-11-09", to: "2026-11-15" }).findings).toEqual([]);
  });

  it("refuses a range that ends before it starts, and an invalid agreed night time", () => {
    expect(() => check(WEEK, { on: "2026-11-08", to: "2026-11-02" })).toThrow(RangeError);
    const setting = { ...SETTING, agreedNightTime: { startMinute: 120, endMinute: 480 } };
    expect(() => check(WEEK, { on: "2026-11-02", setting })).toThrow(RangeError);
  });

  it("never lets a derogation touch the 48-hour average or a young worker's limits", () => {
    for (const rules of Object.values(ADULT_DEROGATIONS)) {
      expect(rules.some((r) => r === "weekly_average" || r.startsWith("young_"))).toBe(false);
    }
    expect(derogationFor("weekly_average", ["special_case", "relevant_agreement"])).toBeNull();
    expect(derogationFor("rest_break", ["shift_change", "relevant_agreement"])).toBe(
      "relevant_agreement",
    );
  });
});
