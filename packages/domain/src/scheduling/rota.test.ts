import { describe, expect, it } from "vitest";
import { readRateTable } from "../../test/rate-table";
import {
  compareStaffing,
  type DependencyScaleDefinition,
  type ScaleVersionRecord,
  STAFFING_STATUS_WORDS,
  staffingRequirement,
} from "./dependency";
import { resolveWorkingTimeRates } from "./rates";
import {
  checkPattern,
  checkShiftShape,
  fewestPresent,
  noticeMinutes,
  overlaps,
  patternShifts,
  plannedWorkPeriods,
  type RosteredShift,
  rotaDates,
  type ShiftShape,
  shiftTimes,
  staffingProvided,
  wallClockMinutes,
  workingTimeWindow,
} from "./rota";
import { checkWorkingTime } from "./working-time";

const day: ShiftShape = {
  kind: "work",
  startMinute: 8 * 60,
  endMinute: 20 * 60,
  breakMinutes: 30,
  requiredCompetences: [],
  requiredSkills: [],
};

describe("shift shapes (scheduling.md section 14 rule 1)", () => {
  it.each([
    ["a day shift", day, []],
    ["a night across midnight", { ...day, startMinute: 20 * 60, endMinute: 8 * 60 }, []],
    ["a start outside the day", { ...day, startMinute: 1440 }, ["start_out_of_day"]],
    ["an end outside the day", { ...day, endMinute: -1 }, ["end_out_of_day"]],
    ["a break of part minutes", { ...day, breakMinutes: 2.5 }, ["break_not_whole"]],
    ["a break as long as the shift", { ...day, breakMinutes: 720 }, ["break_too_long"]],
    [
      "an unknown competence",
      { ...day, requiredCompetences: ["juggling"] },
      ["unknown_competence"],
    ],
    ["an unknown skill", { ...day, requiredSkills: ["flying"] }, ["unknown_skill"]],
    [
      "a skill listed twice",
      { ...day, requiredSkills: ["driver", "driver"] },
      ["duplicate_requirement"],
    ],
  ] as const)("%s", (_, shape, problems) => {
    expect(checkShiftShape(shape, ["medicines_administration"])).toEqual(problems);
  });

  it.each([
    [480, 1200, 720],
    [1200, 480, 720],
    [0, 0, 1440],
  ])("a shift from %i to %i is %i wall-clock minutes", (start, end, minutes) => {
    expect(wallClockMinutes(start, end)).toBe(minutes);
  });
});

describe("shift times on UK dates, clock changes included", () => {
  it.each([
    ["an ordinary night", "2026-11-02", 12 * 60],
    ["the night the clocks go back", "2026-10-24", 13 * 60],
    ["the night the clocks go forward", "2026-03-28", 11 * 60],
  ])("%s", (_, date, minutes) => {
    const s = shiftTimes(date, 20 * 60, 8 * 60);
    const length = (s.end.getTime() - s.start.getTime()) / 60000;
    expect(length).toBe(minutes);
  });

  it("starts a winter day shift at 08:00 GMT", () => {
    expect(shiftTimes("2026-11-02", 480, 1200).start.toISOString()).toBe(
      "2026-11-02T08:00:00.000Z",
    );
  });

  it("starts a summer day shift at 08:00 BST", () => {
    expect(shiftTimes("2026-07-01", 480, 1200).start.toISOString()).toBe(
      "2026-07-01T07:00:00.000Z",
    );
  });
});

describe("patterns (scheduling.md section 14 rule 2)", () => {
  const T1 = "t1";
  const T2 = "t2";
  it.each([
    ["a valid pattern", 7, [{ day: 0, templateId: T1, count: 2 }], []],
    ["no entries", 7, [], ["no_entries"]],
    [
      "a cycle of 0",
      0,
      [{ day: 0, templateId: T1, count: 1 }],
      ["cycle_not_whole", "day_outside_cycle"],
    ],
    ["a day past the cycle", 7, [{ day: 7, templateId: T1, count: 1 }], ["day_outside_cycle"]],
    ["a count of 0", 7, [{ day: 1, templateId: T1, count: 0 }], ["count_not_whole"]],
    ["an archived template", 7, [{ day: 1, templateId: "gone", count: 1 }], ["unknown_template"]],
  ] as const)("%s", (_, cycle, entries, problems) => {
    expect(checkPattern(cycle, entries, [T1, T2])).toEqual(problems);
  });

  it("runs the cycle from its anchor, so the next rota carries on", () => {
    const entries = [
      { day: 0, templateId: T1, count: 2 },
      { day: 1, templateId: T2, count: 1 },
    ];
    expect(patternShifts(2, entries, "2026-11-02", "2026-11-02", "2026-11-04")).toEqual([
      { date: "2026-11-02", templateId: T1 },
      { date: "2026-11-02", templateId: T1 },
      { date: "2026-11-03", templateId: T2 },
      { date: "2026-11-04", templateId: T1 },
      { date: "2026-11-04", templateId: T1 },
    ]);
    expect(patternShifts(2, entries, "2026-11-02", "2026-11-05", "2026-11-05")).toEqual([
      { date: "2026-11-05", templateId: T2 },
    ]);
    expect(patternShifts(2, entries, "2026-11-02", "2026-11-01", "2026-11-01")).toEqual([
      { date: "2026-11-01", templateId: T2 },
    ]);
  });
});

const at = (iso: string) => new Date(iso);
const shift = (over: Partial<RosteredShift>): RosteredShift => ({
  id: "s",
  kind: "work",
  start: at("2026-11-02T08:00:00Z"),
  end: at("2026-11-02T20:00:00Z"),
  breakMinutes: 60,
  countsAsCare: true,
  workerId: "w1",
  workerSkills: [],
  ...over,
});
const dayWindow = { start: at("2026-11-02T08:00:00Z"), end: at("2026-11-02T20:00:00Z") };

describe("hazard HZ-123 what the rota gives on a period", () => {
  it("hazard HZ-123 counts assigned care shifts less their breaks, and nothing else", () => {
    const provided = staffingProvided(
      [
        shift({ id: "a", workerSkills: ["medicines_competent"] }),
        shift({ id: "b", workerId: "w2", workerSkills: ["medicines_competent", "driver"] }),
        shift({ id: "open", workerId: null }),
        shift({ id: "sleep", kind: "sleep_in", workerId: "w3" }),
        shift({
          id: "night",
          workerId: "w4",
          start: at("2026-11-02T20:00:00Z"),
          end: at("2026-11-03T08:00:00Z"),
        }),
      ],
      dayWindow,
    );
    expect(provided.careMinutes).toBe(2 * (720 - 60));
    expect(provided.shiftIds).toEqual(["a", "b"]);
    expect(provided.openShiftIds).toEqual(["open"]);
    expect(provided.staffWithSkill).toEqual({
      registered_nurse: 0,
      medicines_competent: 2,
      moving_and_handling: 0,
      driver: 1,
    });
    expect(provided.method.length).toBeGreaterThan(0);
  });

  it("hazard HZ-123 counts only the part of a shift inside the period, with its break in proportion", () => {
    const provided = staffingProvided(
      [
        shift({
          start: at("2026-11-02T14:00:00Z"),
          end: at("2026-11-02T22:00:00Z"),
          breakMinutes: 60,
        }),
      ],
      dayWindow,
    );
    expect(provided.careMinutes).toBe(360 - 45);
  });

  it("hazard HZ-123 leaves a skill uncovered in the gap between one worker's two shifts", () => {
    const provided = staffingProvided(
      [
        shift({ id: "a", end: at("2026-11-02T12:00:00Z"), workerSkills: ["driver"] }),
        shift({ id: "b", start: at("2026-11-02T13:00:00Z"), workerSkills: ["driver"] }),
      ],
      dayWindow,
    );
    expect(provided.staffWithSkill.driver).toBe(0);
  });

  it("hazard HZ-123 does not count a handover overlap as a skill holder on the period", () => {
    const provided = staffingProvided(
      [
        shift({
          id: "night-nurse",
          start: at("2026-11-01T19:45:00Z"),
          end: at("2026-11-02T08:15:00Z"),
          workerSkills: ["registered_nurse"],
        }),
        shift({ id: "day-carer", workerId: "w2" }),
      ],
      dayWindow,
    );
    expect(provided.staffWithSkill.registered_nurse).toBe(0);
  });

  it("hazard HZ-123 counts two holders one after the other as one present", () => {
    const provided = staffingProvided(
      [
        shift({ id: "a", end: at("2026-11-02T14:00:00Z"), workerSkills: ["registered_nurse"] }),
        shift({
          id: "b",
          workerId: "w2",
          start: at("2026-11-02T14:00:00Z"),
          workerSkills: ["registered_nurse"],
        }),
      ],
      dayWindow,
    );
    expect(provided.staffWithSkill.registered_nurse).toBe(1);
  });

  it("hazard HZ-123 gives no care minutes for a shift the organisation does not count as care", () => {
    const provided = staffingProvided(
      [shift({ id: "kitchen", countsAsCare: false, workerSkills: ["driver"] })],
      dayWindow,
    );
    expect(provided.careMinutes).toBe(0);
    expect(provided.notCareShiftIds).toEqual(["kitchen"]);
    expect(provided.staffWithSkill.driver).toBe(0);
  });

  it.each([
    ["nobody", [], 0],
    ["one throughout", [["08:00", "20:00", "a"]], 1],
    [
      "two throughout",
      [
        ["08:00", "20:00", "a"],
        ["08:00", "20:00", "b"],
      ],
      2,
    ],
    [
      "a gap in the middle",
      [
        ["08:00", "12:00", "a"],
        ["13:00", "20:00", "b"],
      ],
      0,
    ],
    [
      "one throughout and one for part",
      [
        ["08:00", "20:00", "a"],
        ["10:00", "12:00", "b"],
      ],
      1,
    ],
  ] as const)("hazard HZ-123 fewest present: %s", (_, spans, expected) => {
    const list = spans.map(([s, e, h]) => ({
      start: at(`2026-11-02T${s}:00Z`),
      end: at(`2026-11-02T${e}:00Z`),
      holder: h,
    }));
    expect(fewestPresent(list, dayWindow)).toBe(expected);
  });

  const definition: DependencyScaleDefinition = {
    periods: [
      { key: "day", label: "Day", startMinute: 480 },
      { key: "night", label: "Night", startMinute: 1200 },
    ],
    categories: [
      {
        key: "low",
        label: "Low",
        description: "",
        careMinutes: [
          { periodKey: "day", minutes: 600 },
          { periodKey: "night", minutes: 120 },
        ],
      },
    ],
    skillMix: [{ skill: "medicines_competent", periodKey: "day", minimumStaff: 1 }],
    reviewIntervalDays: null,
  };
  const version: ScaleVersionRecord = {
    id: "v1",
    scaleId: "sc",
    versionNumber: 1,
    state: "approved",
    definition,
    authorId: "a",
    contributorIds: ["a"],
    approvedBy: "b",
    approvedAt: at("2026-10-01T09:00:00Z"),
  };
  const record = (id: string, personId: string) => ({
    id,
    personId,
    scaleId: "sc",
    scaleVersionId: "v1",
    categoryKey: "low",
    oneToOne: [],
    kind: "initial" as const,
    effectiveFrom: "2026-10-02",
    supersedesId: null,
    decidedBy: "a",
    reason: "Assessed",
    recordedAt: at("2026-10-02T10:00:00Z"),
  });
  const requirement = (onLeave: boolean) =>
    staffingRequirement({
      locationId: "loc",
      date: "2026-11-02",
      periodKey: "day",
      scale: { scaleId: "sc", name: "Scale", versions: [version] },
      people: [
        {
          personId: "p1",
          presence: "present",
          records: [record("r1", "p1")],
        },
        ...(onLeave
          ? [{ personId: "p2", presence: "away" as const, records: [record("r2", "p2")] }]
          : []),
      ],
    })[0];

  it("hazard HZ-123 shows 'met, but' whenever a warning stands", () => {
    const req = requirement(true);
    if (!req) throw new Error("no requirement");
    const window = req.period ? { start: req.period.start, end: req.period.end } : dayWindow;
    const provided = staffingProvided(
      [shift({ start: window.start, end: window.end, workerSkills: ["medicines_competent"] })],
      window,
    );
    const comparison = compareStaffing(req, provided);
    expect(comparison.status).toBe("met_with_warnings");
    expect(comparison.word).toBe(STAFFING_STATUS_WORDS.met_with_warnings);
    expect(comparison.warnings.length).toBeGreaterThan(0);
  });

  it("hazard HZ-123 an open shift leaves the rota below the scale", () => {
    const req = requirement(false);
    if (!req) throw new Error("no requirement");
    const window = req.period ? { start: req.period.start, end: req.period.end } : dayWindow;
    const comparison = compareStaffing(
      req,
      staffingProvided([shift({ start: window.start, end: window.end, workerId: null })], window),
    );
    expect(comparison.status).toBe("below");
  });
});

describe("the working time check reads the rota's planned periods (advice only)", () => {
  it("places a planned break in the middle of the shift", () => {
    const [p] = plannedWorkPeriods([
      {
        id: "s",
        kind: "work",
        start: at("2026-11-02T08:00:00Z"),
        end: at("2026-11-02T20:00:00Z"),
        breakMinutes: 60,
      },
    ]);
    expect(p?.breaks?.[0]?.start.toISOString()).toBe("2026-11-02T13:30:00.000Z");
    expect(p?.breaks?.[0]?.end.toISOString()).toBe("2026-11-02T14:30:00.000Z");
  });

  it("gives no break when none is planned", () => {
    const [p] = plannedWorkPeriods([
      {
        id: "s",
        kind: "work",
        start: at("2026-11-02T08:00:00Z"),
        end: at("2026-11-02T12:00:00Z"),
        breakMinutes: 0,
      },
    ]);
    expect(p?.breaks).toBeUndefined();
  });

  it("finds too little daily rest between a late and an early on the rota", () => {
    const rates = resolveWorkingTimeRates(readRateTable(), "england", "2026-11-02");
    const report = checkWorkingTime({
      worker: {
        dateOfBirth: "1990-01-01",
        employmentStart: "2025-01-01",
        optOuts: [],
        designatedNightWorker: false,
        specialHazards: false,
        contractProvidesWorkAfter22: false,
      },
      setting: {
        derogations: [],
        successiveReferencePeriodsFrom: null,
        agreedReferencePeriodWeeks: null,
        agreedNightReferencePeriodWeeks: null,
        agreedNightTime: null,
        weeklyRestBasis: "each_week",
        weeklyRestPeriodsFrom: null,
        weeklyRestMayIncludeDailyRest: false,
        hospitalOrSimilarEstablishment: false,
      },
      periods: plannedWorkPeriods([
        { id: "late", kind: "work", ...shiftTimes("2026-11-02", 840, 1320), breakMinutes: 30 },
        { id: "early", kind: "work", ...shiftTimes("2026-11-03", 420, 900), breakMinutes: 30 },
      ]),
      excludedDays: [],
      evaluateFrom: "2026-11-02",
      evaluateTo: "2026-11-03",
      known: { start: at("2026-11-02T00:00:00Z"), end: at("2026-11-04T00:00:00Z") },
      rates,
    });
    expect(report.findings.some((f) => f.rule === "daily_rest" && f.outcome === "breach")).toBe(
      true,
    );
  });
});

describe("notice and overlaps", () => {
  it.each([
    ["two weeks", "2026-11-02T08:00:00Z", "2026-11-16T08:00:00Z", 14 * 24 * 60],
    ["after the first shift started", "2026-11-02T09:00:00Z", "2026-11-02T08:00:00Z", 0],
  ])("notice of %s", (_, published, first, minutes) => {
    expect(noticeMinutes(at(published), at(first))).toBe(minutes);
  });

  it("has no notice to give with nothing published", () => {
    expect(noticeMinutes(at("2026-11-02T08:00:00Z"), null)).toBeNull();
  });

  it.each([
    [
      "back to back",
      "2026-11-02T08:00:00Z",
      "2026-11-02T20:00:00Z",
      "2026-11-02T20:00:00Z",
      "2026-11-03T08:00:00Z",
      false,
    ],
    [
      "overlapping",
      "2026-11-02T08:00:00Z",
      "2026-11-02T20:00:00Z",
      "2026-11-02T19:00:00Z",
      "2026-11-03T08:00:00Z",
      true,
    ],
  ])("%s shifts", (_, s1, e1, s2, e2, expected) => {
    expect(overlaps({ start: at(s1), end: at(e1) }, { start: at(s2), end: at(e2) })).toBe(expected);
  });
});

describe("the rota's dates and the working time window", () => {
  it("lists every date of a rota", () => {
    expect(rotaDates("2026-10-31", "2026-11-02")).toEqual([
      "2026-10-31",
      "2026-11-01",
      "2026-11-02",
    ]);
  });

  it("reads back the reference period and to the end of the day after, knowing only the rota", () => {
    const w = workingTimeWindow("2026-11-02", "2026-11-08", 17);
    expect(w.from.toISOString()).toBe("2026-07-05T23:00:00.000Z");
    expect(w.to.toISOString()).toBe("2026-11-10T00:00:00.000Z");
    expect(w.known.start.toISOString()).toBe("2026-11-02T00:00:00.000Z");
    expect(w.known.end.toISOString()).toBe("2026-11-09T00:00:00.000Z");
  });
});
