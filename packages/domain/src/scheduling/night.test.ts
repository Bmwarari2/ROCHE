import { describe, expect, it } from "vitest";
import {
  ADULT,
  CARE_HOME,
  check,
  findingsFor,
  HOUR,
  pattern,
  SETTING,
  shift,
  tableWorkingTimeRates,
  uk,
} from "../../test/working-time";
import { nightTimeFor } from "./agreements";
import { nightMinutes } from "./night";
import type { WorkPeriod } from "./working-time-types";

const rates = tableWorkingTimeRates();
const night = nightTimeFor(SETTING, rates);
const span = (from: string, to: string) => ({ start: uk(from), end: uk(to) });

// Night shifts starting Monday to Thursday (48 hours a week) or Monday to Friday (60 hours),
// across the 17 weeks ending Sunday 1 November 2026.
const FOUR_NIGHTS = pattern("n", "2026-07-06", "2026-11-01", [1, 2, 3, 4], "20:00", "08:00");
const FIVE_NIGHTS = pattern("n", "2026-07-06", "2026-11-01", [1, 2, 3, 4, 5], "20:00", "08:00");
const DAYS = pattern("d", "2026-07-06", "2026-11-01", [1, 2, 3, 4], "08:00", "20:00");

describe("night time is UK wall-clock time (reg 2; scheduling.md rule 6)", () => {
  it.each([
    ["the night the clocks go back", "2026-10-24 20:00", "2026-10-25 08:00", 8],
    ["the night the clocks go forward", "2026-03-28 20:00", "2026-03-29 08:00", 6],
    ["an ordinary night", "2026-11-07 20:00", "2026-11-08 08:00", 7],
    ["23:00 to 02:00 on an ordinary night", "2026-11-07 23:00", "2026-11-08 02:00", 3],
    ["23:00 to 02:00 the night the clocks go forward", "2026-03-28 23:00", "2026-03-29 02:00", 2],
  ])("holds the right hours on %s", (_name, from, to, hours) => {
    expect(nightMinutes([span(from, to)], night)).toBe(hours * HOUR);
  });
});

describe("who is a night worker (reg 2; scheduling.md rule 7)", () => {
  it.each<[string, WorkPeriod[], boolean]>([
    ["four nights a week", FOUR_NIGHTS, true],
    ["four days a week", DAYS, false],
    [
      "nights on fewer than half the days worked",
      [...DAYS, ...pattern("n", "2026-07-06", "2026-11-01", [5], "20:00", "08:00")],
      false,
    ],
    [
      "nights on exactly half the days worked (not a majority)",
      [
        ...pattern("d", "2026-07-06", "2026-11-01", [1, 2], "08:00", "20:00"),
        ...pattern("n", "2026-07-06", "2026-11-01", [3, 4], "20:00", "08:00"),
      ],
      false,
    ],
  ])("%s: %s", (_name, periods, nightWorker) => {
    const report = check(periods, { on: "2026-11-01" });
    expect(report.nightWorker).toMatchObject({ nightWorker, basis: "pattern" });
  });

  it("counts only the hours in the night time an agreement sets", () => {
    const lates = pattern("l", "2026-07-06", "2026-11-01", [1, 2, 3, 4], "17:00", "02:00");
    expect(check(lates, { on: "2026-11-01" }).nightWorker.nightWorker).toBe(true);
    const setting = { ...SETTING, agreedNightTime: { startMinute: 0, endMinute: 420 } };
    expect(check(lates, { on: "2026-11-01", setting }).nightWorker.nightWorker).toBe(false);
  });

  it("is one by contract whatever the pattern", () => {
    const report = check(DAYS, {
      on: "2026-11-01",
      worker: { ...ADULT, designatedNightWorker: true },
    });
    expect(report.nightWorker).toMatchObject({ nightWorker: true, basis: "designated" });
  });
});

describe("the night average, A / (B - C) (reg 6(1), (5); scheduling.md rule 7)", () => {
  const limit = rates.nightAverageMaxHours * HOUR;

  it("allows four 12-hour nights a week: 816 hours over 119 days less 17 days of weekly rest", () => {
    const report = check(FOUR_NIGHTS, { on: "2026-11-01" });
    expect(report.nightAverage).toMatchObject([
      {
        from: "2026-07-06",
        to: "2026-11-01",
        normalMinutes: 816 * HOUR,
        days: 119,
        weeklyRestDays: 17,
      },
    ]);
    expect(report.nightAverage[0]?.averageMinutes).toBe(limit);
    expect(findingsFor(report, "night_average")).toEqual([]);
  });

  it("is breached by five 12-hour nights a week, and no opt-out lifts it", () => {
    const optedOut = {
      ...ADULT,
      optOuts: [{ signedOn: "2026-01-05", endsOn: null, noticePeriod: null, noticeGivenOn: null }],
    };
    const report = check(FIVE_NIGHTS, { on: "2026-11-01", worker: optedOut });
    expect(findingsFor(report, "night_average")).toMatchObject([
      { outcome: "breach", limitMinutes: limit, actualMinutes: 10 * HOUR },
    ]);
  });

  it("needs protection for health and safety instead in a care home (reg 21, 24)", () => {
    expect(
      findingsFor(check(FIVE_NIGHTS, { on: "2026-11-01", setting: CARE_HOME }), "night_average"),
    ).toMatchObject([
      {
        outcome: "conditional",
        conditions: ["health_and_safety_protection"],
        basis: "special_case",
      },
    ]);
  });

  it("leaves occasional overtime out of normal hours", () => {
    const extra = pattern("x", "2026-07-06", "2026-11-01", [5], "20:00", "08:00");
    const occasional = extra.map((p) => ({ ...p, occasionalOvertime: true }));
    expect(
      findingsFor(check([...FOUR_NIGHTS, ...occasional], { on: "2026-11-01" }), "night_average"),
    ).toEqual([]);
    expect(
      findingsFor(check([...FOUR_NIGHTS, ...extra], { on: "2026-11-01" }), "night_average"),
    ).toHaveLength(1);
  });

  it("does not take leave out, unlike the 48-hour average", () => {
    const leave = [{ date: "2026-08-03", reason: "annual_leave" as const }];
    const withLeave = check(FIVE_NIGHTS, { on: "2026-11-01", excludedDays: leave });
    expect(withLeave.nightAverage).toEqual(check(FIVE_NIGHTS, { on: "2026-11-01" }).nightAverage);
  });

  it("is not worked out for a worker who is not a night worker", () => {
    expect(check(DAYS, { on: "2026-11-01" }).nightAverage).toEqual([]);
  });
});

describe("special hazards: no more than the limit in any 24 hours with night work (reg 6(7))", () => {
  const week = pattern("n", "2026-11-02", "2026-11-05", [1, 2, 3, 4], "20:00", "08:00");
  const hazardous = { ...ADULT, specialHazards: true, designatedNightWorker: true };

  it("is breached by 12-hour nights, reported once for the run of nights", () => {
    expect(
      findingsFor(
        check(week, { on: "2026-11-02", to: "2026-11-08", worker: hazardous }),
        "night_hazard",
      ),
    ).toMatchObject([
      {
        outcome: "breach",
        limitMinutes: rates.nightHazardMaxHours * HOUR,
        actualMinutes: 12 * HOUR,
      },
    ]);
  });

  it("does not apply without special hazards, or to long days with no night work", () => {
    const days = pattern("d", "2026-11-02", "2026-11-05", [1, 2, 3, 4], "08:00", "20:00");
    expect(
      findingsFor(
        check(week, {
          on: "2026-11-02",
          to: "2026-11-08",
          worker: { ...hazardous, specialHazards: false },
        }),
        "night_hazard",
      ),
    ).toEqual([]);
    expect(
      findingsFor(
        check(days, { on: "2026-11-02", to: "2026-11-08", worker: hazardous }),
        "night_hazard",
      ),
    ).toEqual([]);
  });

  it("needs protection for health and safety instead in a care home", () => {
    expect(
      findingsFor(
        check(week, { on: "2026-11-02", to: "2026-11-08", worker: hazardous, setting: CARE_HOME }),
        "night_hazard",
      )[0]?.conditions,
    ).toEqual(["health_and_safety_protection"]);
  });
});

describe("days worked are counted by the UK date each duty starts", () => {
  it("counts a day shift and a night shift as two days, one of them a night", () => {
    const report = check(
      [
        shift("day", "2026-11-02 08:00", "2026-11-02 20:00"),
        shift("night", "2026-11-03 20:00", "2026-11-04 08:00"),
      ],
      { on: "2026-11-02", to: "2026-11-04" },
    );
    expect(report.nightWorker).toMatchObject({ daysWorked: 2, nightDays: 1, nightWorker: false });
  });
});
