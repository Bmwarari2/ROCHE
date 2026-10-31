import { describe, expect, it } from "vitest";
import {
  CARE_HOME,
  check,
  findingsFor,
  HOUR,
  pattern,
  SETTING,
  shift,
  tableWorkingTimeRates,
  uk,
  YOUNG,
} from "../../test/working-time";
import type { WorkingTimeSetting, WorkPeriod } from "./working-time-types";

const rates = tableWorkingTimeRates();
const dailyRest = rates.dailyRestHours * HOUR;

describe("daily rest (reg 10(1); scheduling.md rule 4)", () => {
  it.each<[string, WorkPeriod[], string, number | null]>([
    [
      "13-hour days with 11 hours between them",
      pattern("d", "2026-11-02", "2026-11-06", [1, 2, 3, 4, 5], "07:00", "20:00"),
      "2026-11-02",
      null,
    ],
    [
      "a quick return from an early to a night",
      [
        shift("early", "2026-11-02 07:00", "2026-11-02 15:00"),
        shift("night", "2026-11-02 22:00", "2026-11-03 07:00"),
      ],
      "2026-11-02",
      7,
    ],
    [
      "20:00 to 07:00 the night the clocks go forward (10 hours, though the clock shows 11)",
      [
        shift("sat", "2026-03-28 08:00", "2026-03-28 20:00"),
        shift("sun", "2026-03-29 07:00", "2026-03-29 19:00"),
      ],
      "2026-03-28",
      10,
    ],
    [
      "21:00 to 07:00 the night the clocks go back (11 hours, though the clock shows 10)",
      [
        shift("sat", "2026-10-24 09:00", "2026-10-24 21:00"),
        shift("sun", "2026-10-25 07:00", "2026-10-25 19:00"),
      ],
      "2026-10-24",
      null,
    ],
    [
      "a day shift and a sleep-in, which is working time, not rest",
      [
        shift("day", "2026-11-02 08:00", "2026-11-02 20:00"),
        {
          ...shift("sleep", "2026-11-02 22:00", "2026-11-03 07:00"),
          kind: "sleep_in",
          sleepIn: { expectedToSleep: true, suitableSleepingFacilities: true, awake: [] },
        },
      ],
      "2026-11-02",
      2,
    ],
  ])("%s", (_name, periods, on, restHours) => {
    const findings = findingsFor(check(periods, { on }), "daily_rest");
    if (restHours === null) {
      expect(findings).toEqual([]);
    } else {
      expect(findings).toMatchObject([
        { outcome: "breach", limitMinutes: dailyRest, actualMinutes: restHours * HOUR },
      ]);
    }
  });

  it("in a care home (reg 21) owes equivalent compensatory rest instead (reg 24)", () => {
    const periods = [
      shift("early", "2026-11-02 07:00", "2026-11-02 15:00"),
      shift("night", "2026-11-02 22:00", "2026-11-03 07:00"),
    ];
    expect(
      findingsFor(check(periods, { on: "2026-11-02", setting: CARE_HOME }), "daily_rest"),
    ).toMatchObject([
      {
        outcome: "conditional",
        conditions: ["compensatory_rest"],
        basis: "special_case",
        compensatoryRestMinutes: dailyRest - 7 * HOUR,
        periodIds: ["early", "night"],
      },
    ]);
  });

  it.each<[string, WorkingTimeSetting["derogations"][number]]>([
    ["a shift change", "shift_change"],
    ["a split shift", "split_shift"],
    ["a collective or workforce agreement", "relevant_agreement"],
  ])("is also allowed with compensatory rest for %s (reg 22, 23(a))", (_name, basis) => {
    const periods = [
      shift("early", "2026-11-02 07:00", "2026-11-02 15:00"),
      shift("night", "2026-11-02 22:00", "2026-11-03 07:00"),
    ];
    const setting = { ...SETTING, derogations: [basis] };
    expect(findingsFor(check(periods, { on: "2026-11-02", setting }), "daily_rest")[0]?.basis).toBe(
      basis,
    );
  });
});

describe("young workers' daily rest (reg 10(2), (3))", () => {
  const evening = [
    shift("a", "2026-11-02 13:00", "2026-11-02 17:00"),
    shift("b", "2026-11-02 18:00", "2026-11-02 21:00"),
    shift("c", "2026-11-03 08:00", "2026-11-03 12:00"),
  ];

  it("needs 12 hours, where 11 would do for an adult", () => {
    expect(findingsFor(check(evening, { on: "2026-11-02" }), "daily_rest")).toEqual([]);
    expect(
      findingsFor(check(evening, { on: "2026-11-02", worker: YOUNG }), "young_daily_rest"),
    ).toMatchObject([
      {
        outcome: "breach",
        limitMinutes: rates.youngDailyRestHours * HOUR,
        actualMinutes: 11 * HOUR,
      },
    ]);
  });

  it("allows an interruption for split or short work with the reason recorded", () => {
    const split: WorkPeriod[] = [
      {
        ...(evening[0] as WorkPeriod),
        youngWorkerException: { basis: "split_or_short_duration", reason: "Tea round cover" },
      },
      ...evening.slice(1),
    ];
    expect(
      findingsFor(check(split, { on: "2026-11-02", worker: YOUNG }), "young_daily_rest"),
    ).toMatchObject([
      { outcome: "conditional", conditions: ["reason_recorded"], basis: "split_or_short_duration" },
    ]);
    const blank: WorkPeriod[] = [
      {
        ...(evening[0] as WorkPeriod),
        youngWorkerException: { basis: "split_or_short_duration", reason: " " },
      },
      ...evening.slice(1),
    ];
    expect(
      findingsFor(check(blank, { on: "2026-11-02", worker: YOUNG }), "young_daily_rest")[0]
        ?.outcome,
    ).toBe("breach");
  });
});

describe("weekly rest (reg 11; scheduling.md rule 5)", () => {
  const weekly = rates.weeklyRestHours * HOUR;
  const sevenDays = pattern(
    "d",
    "2026-11-02",
    "2026-11-08",
    [1, 2, 3, 4, 5, 6, 7],
    "08:00",
    "20:00",
  );
  const sixDays = [
    ...pattern("d", "2026-11-02", "2026-11-07", [1, 2, 3, 4, 5, 6], "08:00", "20:00"),
    shift("next", "2026-11-09 08:00", "2026-11-09 20:00"),
  ];
  const twentyFourHoursOff = [
    ...pattern("d", "2026-11-02", "2026-11-07", [1, 2, 3, 4, 5, 6], "08:00", "20:00"),
    shift("sun-night", "2026-11-08 20:00", "2026-11-09 08:00"),
  ];

  it("is breached when every day of the week is worked", () => {
    expect(
      findingsFor(check(sevenDays, { on: "2026-11-02", to: "2026-11-08" }), "weekly_rest"),
    ).toMatchObject([{ outcome: "breach", limitMinutes: weekly, actualMinutes: 8 * HOUR }]);
  });

  it("is met by Saturday evening to Monday morning", () => {
    expect(
      findingsFor(check(sixDays, { on: "2026-11-02", to: "2026-11-08" }), "weekly_rest"),
    ).toEqual([]);
  });

  it("does not let the weekly rest include the daily rest (reg 11(7)) unless the reasons are recorded", () => {
    const strict = findingsFor(
      check(twentyFourHoursOff, { on: "2026-11-02", to: "2026-11-08" }),
      "weekly_rest",
    );
    expect(strict).toMatchObject([{ outcome: "breach", actualMinutes: weekly - dailyRest }]);
    const setting = { ...SETTING, weeklyRestMayIncludeDailyRest: true };
    expect(
      findingsFor(
        check(twentyFourHoursOff, { on: "2026-11-02", to: "2026-11-08", setting }),
        "weekly_rest",
      ),
    ).toEqual([]);
  });

  it("owes compensatory rest for the shortfall in a care home", () => {
    expect(
      findingsFor(
        check(sevenDays, { on: "2026-11-02", to: "2026-11-08", setting: CARE_HOME }),
        "weekly_rest",
      ),
    ).toMatchObject([
      { outcome: "conditional", basis: "special_case", compensatoryRestMinutes: weekly - 8 * HOUR },
    ]);
  });

  describe("on the fortnightly basis the employer may choose (reg 11(2))", () => {
    const fortnightly: WorkingTimeSetting = {
      ...SETTING,
      weeklyRestBasis: "each_fortnight",
      weeklyRestPeriodsFrom: "2026-11-02",
    };
    const fiveThenSeven = [
      ...pattern("a", "2026-11-02", "2026-11-06", [1, 2, 3, 4, 5], "08:00", "20:00"),
      ...pattern("b", "2026-11-09", "2026-11-16", [1, 2, 3, 4, 5, 6, 7], "08:00", "20:00"),
    ];
    const twoWeekends = [
      ...pattern("a", "2026-11-02", "2026-11-07", [1, 2, 3, 4, 5, 6], "08:00", "20:00"),
      ...pattern("b", "2026-11-09", "2026-11-14", [1, 2, 3, 4, 5, 6], "08:00", "20:00"),
      shift("next", "2026-11-16 08:00", "2026-11-16 20:00"),
    ];
    const oneShortWeekend = [
      ...pattern("a", "2026-11-02", "2026-11-07", [1, 2, 3, 4, 5, 6], "08:00", "20:00"),
      shift("sun", "2026-11-08 12:00", "2026-11-08 20:00"),
      ...pattern("b", "2026-11-09", "2026-11-16", [1, 2, 3, 4, 5, 6, 7], "08:00", "20:00"),
    ];

    it("accepts one long rest in the fortnight that a weekly check would refuse", () => {
      const range = { on: "2026-11-02", to: "2026-11-15" };
      expect(
        findingsFor(check(fiveThenSeven, { ...range, setting: fortnightly }), "weekly_rest"),
      ).toEqual([]);
      expect(findingsFor(check(fiveThenSeven, range), "weekly_rest")).toHaveLength(1);
    });

    it("accepts two separate weekly rests in the fortnight", () => {
      expect(
        findingsFor(
          check(twoWeekends, { on: "2026-11-02", to: "2026-11-15", setting: fortnightly }),
          "weekly_rest",
        ),
      ).toEqual([]);
    });

    it("refuses a fortnight with neither", () => {
      expect(
        findingsFor(
          check(oneShortWeekend, { on: "2026-11-02", to: "2026-11-15", setting: fortnightly }),
          "weekly_rest",
        ),
      ).toMatchObject([{ outcome: "breach", limitMinutes: rates.fortnightlyRestHours * HOUR }]);
    });
  });
});

describe("young workers' weekly rest (reg 11(3), (8))", () => {
  const mornings = pattern("m", "2026-11-02", "2026-11-07", [1, 2, 3, 4, 5, 6], "07:00", "12:00");

  it("needs 48 hours; 36 is allowed only for a recorded technical or organisation reason", () => {
    const report = check(mornings, { on: "2026-11-02", to: "2026-11-08", worker: YOUNG });
    expect(findingsFor(report, "young_weekly_rest")).toMatchObject([
      {
        outcome: "breach",
        limitMinutes: rates.youngWeeklyRestHours * HOUR,
        actualMinutes: rates.youngWeeklyRestReducedMinHours * HOUR,
      },
    ]);
    const reasoned = mornings.map((p) => ({
      ...p,
      youngWorkerException: { basis: "technical_or_organisational" as const, reason: "Rota gap" },
    }));
    expect(
      findingsFor(
        check(reasoned, { on: "2026-11-02", to: "2026-11-08", worker: YOUNG }),
        "young_weekly_rest",
      ),
    ).toMatchObject([{ outcome: "conditional", basis: "technical_or_organisational" }]);
  });

  it("allows interrupted rest for split or short work only with the reason recorded", () => {
    const everyDay = pattern(
      "m",
      "2026-11-02",
      "2026-11-08",
      [1, 2, 3, 4, 5, 6, 7],
      "07:00",
      "09:00",
    );
    const plain = check(everyDay, { on: "2026-11-02", to: "2026-11-08", worker: YOUNG });
    expect(findingsFor(plain, "young_weekly_rest")[0]?.outcome).toBe("breach");
    const technical = everyDay.map((p) => ({
      ...p,
      youngWorkerException: { basis: "technical_or_organisational" as const, reason: "Rota gap" },
    }));
    expect(
      findingsFor(
        check(technical, { on: "2026-11-02", to: "2026-11-08", worker: YOUNG }),
        "young_weekly_rest",
      )[0]?.outcome,
    ).toBe("breach");
    const split = everyDay.map((p) => ({
      ...p,
      youngWorkerException: {
        basis: "split_or_short_duration" as const,
        reason: "Breakfast cover",
      },
    }));
    expect(
      findingsFor(
        check(split, { on: "2026-11-02", to: "2026-11-08", worker: YOUNG }),
        "young_weekly_rest",
      ),
    ).toMatchObject([{ outcome: "conditional", basis: "split_or_short_duration" }]);
  });
});

describe("rest breaks (reg 12(1), (3); scheduling.md rule 5)", () => {
  const breakMinutes = rates.breakMinutes;
  const on = "2026-11-02";
  const longDay = (breaks: [string, string][]) =>
    shift("day", "2026-11-02 08:00", "2026-11-02 20:00", {
      breaks: breaks.map(([from, to]) => ({
        start: uk(`2026-11-02 ${from}`),
        end: uk(`2026-11-02 ${to}`),
      })),
    });

  it.each<[string, WorkPeriod[], number | null]>([
    [
      "exactly the threshold with no break",
      [shift("s", "2026-11-02 08:00", "2026-11-02 14:00")],
      null,
    ],
    [
      "a minute over the threshold with no break",
      [shift("s", "2026-11-02 08:00", "2026-11-02 14:01")],
      0,
    ],
    ["a long day with one break of the minimum inside it", [longDay([["12:00", "12:20"]])], null],
    ["a break taken at the very start of the day", [longDay([["08:00", "08:30"]])], 0],
    [
      "two shorter breaks that add up",
      [
        longDay([
          ["11:00", "11:10"],
          ["15:00", "15:10"],
        ]),
      ],
      10,
    ],
    [
      "a split shift whose gap is the break",
      [
        shift("am", "2026-11-02 07:00", "2026-11-02 11:00", { dutyId: "split" }),
        shift("pm", "2026-11-02 15:00", "2026-11-02 19:00", { dutyId: "split" }),
      ],
      null,
    ],
  ])("%s", (_name, periods, longest) => {
    const findings = findingsFor(check(periods, { on }), "rest_break");
    if (longest === null) expect(findings).toEqual([]);
    else
      expect(findings).toMatchObject([
        { outcome: "breach", limitMinutes: breakMinutes, actualMinutes: longest },
      ]);
  });

  it("owes the break as compensatory rest in a care home", () => {
    expect(
      findingsFor(check([longDay([])], { on, setting: CARE_HOME }), "rest_break"),
    ).toMatchObject([
      {
        outcome: "conditional",
        conditions: ["compensatory_rest"],
        compensatoryRestMinutes: breakMinutes,
      },
    ]);
  });
});

describe("young workers' breaks (reg 12(4), (5))", () => {
  const on = "2026-11-02";

  it.each<[string, WorkPeriod[], string | null]>([
    ["five hours with no break", [shift("s", "2026-11-02 09:00", "2026-11-02 14:00")], "breach"],
    [
      "five hours with one 30-minute break",
      [
        shift("s", "2026-11-02 09:00", "2026-11-02 14:30", {
          breaks: [{ start: uk("2026-11-02 11:00"), end: uk("2026-11-02 11:30") }],
        }),
      ],
      null,
    ],
    [
      "two 15-minute breaks: allowed with a reason, as one break is asked for if possible",
      [
        shift("s", "2026-11-02 09:00", "2026-11-02 14:30", {
          breaks: [
            { start: uk("2026-11-02 10:00"), end: uk("2026-11-02 10:15") },
            { start: uk("2026-11-02 12:00"), end: uk("2026-11-02 12:15") },
          ],
        }),
      ],
      "conditional",
    ],
    ["four hours here", [shift("s", "2026-11-02 09:00", "2026-11-02 13:00")], null],
    [
      "four hours here and two for another employer the same day",
      [
        shift("s", "2026-11-02 09:00", "2026-11-02 13:00"),
        shift("other", "2026-11-02 15:00", "2026-11-02 17:00", { employer: "other" }),
      ],
      "breach",
    ],
  ])("%s", (_name, periods, outcome) => {
    const findings = findingsFor(check(periods, { on, worker: YOUNG }), "young_rest_break");
    expect(findings.map((f) => f.outcome)).toEqual(outcome === null ? [] : [outcome]);
    expect(findingsFor(check(periods, { on, worker: YOUNG }), "rest_break")).toEqual([]);
  });
});
