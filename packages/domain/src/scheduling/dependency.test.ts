import { describe, expect, it } from "vitest";
import {
  checkDependencyRecord,
  checkScaleApproval,
  checkScaleDefinition,
  compareStaffing,
  correctedDependencyIds,
  currentDependency,
  DEPENDENCY_PROBLEM_MESSAGES,
  DEPENDENCY_SCALE_WORKFLOW,
  DEPENDENCY_TOOL_NOTICE,
  type DependencyProblem,
  type DependencyRecord,
  type DependencyScaleDefinition,
  dependencyChain,
  dependencyInForce,
  formatCareMinutes,
  type NewDependencyRecord,
  type PeriodRequirement,
  type PersonPresence,
  periodWindows,
  presenceOn,
  type RequirementPerson,
  SCALE_PROBLEM_MESSAGES,
  type ScaleProblem,
  type ScaleVersionRecord,
  STAFFING_STATUS_WORDS,
  type StaffingRequirement,
  sameDefinition,
  scaleForLocation,
  scaleVersionInForce,
  staffingRequirement,
} from "./dependency";

/** Invented scale figures: the organisation's own, as a tenant would enter them. */
const DAY = { key: "day", label: "Day", startMinute: 480 };
const NIGHT = { key: "night", label: "Night", startMinute: 1200 };
const LOW = {
  key: "low",
  label: "Low",
  description: null,
  careMinutes: [
    { periodKey: "day", minutes: 60 },
    { periodKey: "night", minutes: 20 },
  ],
};
const HIGH = {
  key: "high",
  label: "High",
  description: "Two carers for transfers",
  careMinutes: [
    { periodKey: "day", minutes: 180 },
    { periodKey: "night", minutes: 60 },
  ],
};
const NURSE_BY_DAY = { skill: "registered_nurse", periodKey: "day", minimumStaff: 1 } as const;
const DEFINITION: DependencyScaleDefinition = {
  periods: [DAY, NIGHT],
  categories: [LOW, HIGH],
  skillMix: [NURSE_BY_DAY, { skill: "medicines_competent", periodKey: "night", minimumStaff: 2 }],
  reviewIntervalDays: 30,
};

const SCALE = "scale-north";
const LOCATION = "location-north";

const version = (over: Partial<ScaleVersionRecord> = {}): ScaleVersionRecord => ({
  id: "v1",
  scaleId: SCALE,
  versionNumber: 1,
  state: "approved",
  definition: DEFINITION,
  authorId: "author",
  contributorIds: ["author"],
  approvedBy: "approver",
  approvedAt: new Date("2026-10-01T09:00:00Z"),
  ...over,
});

const record = (over: Partial<DependencyRecord> = {}): DependencyRecord => ({
  id: "r1",
  personId: "ada",
  scaleId: SCALE,
  scaleVersionId: "v1",
  categoryKey: "low",
  oneToOne: [],
  kind: "initial",
  effectiveFrom: "2026-10-20",
  supersedesId: null,
  decidedBy: "manager",
  reason: "Needs help with washing and dressing",
  recordedAt: new Date("2026-10-20T10:00:00Z"),
  ...over,
});

type Mutate = (d: DependencyScaleDefinition) => DependencyScaleDefinition;
const withCategory =
  (patch: object): Mutate =>
  (d) => ({
    ...d,
    categories: [{ ...(d.categories[0] as object), ...patch } as never, ...d.categories.slice(1)],
  });

describe("rule 1: the organisation's scale definition", () => {
  it("accepts a complete scale", () => {
    expect(checkScaleDefinition(DEFINITION)).toEqual([]);
    expect(checkScaleDefinition({ ...DEFINITION, reviewIntervalDays: null })).toEqual([]);
  });

  const cases: [string, Mutate, ScaleProblem, string][] = [
    ["no periods", (d) => ({ ...d, periods: [] }), "no_periods", "periods"],
    ["no categories", (d) => ({ ...d, categories: [] }), "no_categories", "categories"],
    [
      "a period key with capitals",
      (d) => ({ ...d, periods: [{ key: "Day", label: "Day", startMinute: 480 }, NIGHT] }),
      "invalid_key",
      "periods.0.key",
    ],
    [
      "a period key used twice",
      (d) => ({ ...d, periods: [DAY, { key: "day", label: "Late", startMinute: 900 }] }),
      "duplicate_key",
      "periods.1.key",
    ],
    [
      "a blank period name",
      (d) => ({ ...d, periods: [{ key: "day", label: "  ", startMinute: 480 }, NIGHT] }),
      "blank_label",
      "periods.0.label",
    ],
    [
      "a start at 24:00",
      (d) => ({ ...d, periods: [DAY, { key: "night", label: "N", startMinute: 1440 }] }),
      "period_start",
      "periods.1.startMinute",
    ],
    [
      "a start part way through a minute",
      (d) => ({ ...d, periods: [{ key: "day", label: "D", startMinute: 480.5 }, NIGHT] }),
      "period_start",
      "periods.0.startMinute",
    ],
    [
      "periods out of order",
      (d) => ({ ...d, periods: [NIGHT, DAY] }),
      "period_order",
      "periods.1.startMinute",
    ],
    [
      "periods starting at the same minute",
      (d) => ({ ...d, periods: [DAY, { key: "late", label: "Late", startMinute: 480 }] }),
      "period_order",
      "periods.1.startMinute",
    ],
    [
      "a category key used twice",
      (d) => ({ ...d, categories: [LOW, { ...HIGH, key: "low" }] }),
      "duplicate_key",
      "categories.1.key",
    ],
    ["a blank category name", withCategory({ label: "" }), "blank_label", "categories.0.label"],
    [
      "care minutes missing for a period",
      withCategory({ careMinutes: [{ periodKey: "day", minutes: 60 }] }),
      "care_minutes_missing",
      "categories.0.careMinutes",
    ],
    [
      "care minutes for a period the scale lacks",
      withCategory({
        careMinutes: [
          { periodKey: "day", minutes: 60 },
          { periodKey: "night", minutes: 20 },
          { periodKey: "twilight", minutes: 5 },
        ],
      }),
      "care_minutes_unknown_period",
      "categories.0.careMinutes.2.periodKey",
    ],
    [
      "care minutes given twice for a period",
      withCategory({
        careMinutes: [
          { periodKey: "day", minutes: 60 },
          { periodKey: "day", minutes: 30 },
          { periodKey: "night", minutes: 20 },
        ],
      }),
      "care_minutes_duplicate",
      "categories.0.careMinutes.1.periodKey",
    ],
    [
      "negative care minutes",
      withCategory({
        careMinutes: [
          { periodKey: "day", minutes: -1 },
          { periodKey: "night", minutes: 20 },
        ],
      }),
      "care_minutes_invalid",
      "categories.0.careMinutes.0.minutes",
    ],
    [
      "a skill not on the list",
      (d) => ({ ...d, skillMix: [{ skill: "chef" as never, periodKey: "day", minimumStaff: 1 }] }),
      "skill_unknown",
      "skillMix.0",
    ],
    [
      "a skill minimum for a period the scale lacks",
      (d) => ({
        ...d,
        skillMix: [{ skill: "driver", periodKey: "twilight", minimumStaff: 1 }],
      }),
      "skill_period_unknown",
      "skillMix.0.periodKey",
    ],
    [
      "a skill set twice for a period",
      (d) => ({ ...d, skillMix: [NURSE_BY_DAY, NURSE_BY_DAY] }),
      "skill_duplicate",
      "skillMix.1",
    ],
    [
      "a minimum of no staff",
      (d) => ({ ...d, skillMix: [{ skill: "driver", periodKey: "day", minimumStaff: 0 }] }),
      "skill_minimum_invalid",
      "skillMix.0.minimumStaff",
    ],
    [
      "a review interval of no days",
      (d) => ({ ...d, reviewIntervalDays: 0 }),
      "review_interval_invalid",
      "reviewIntervalDays",
    ],
  ];

  it.each(cases)("refuses %s", (_, mutate, problem, path) => {
    const issues = checkScaleDefinition(mutate(DEFINITION));
    expect(issues).toContainEqual({ problem, path, message: SCALE_PROBLEM_MESSAGES[problem] });
  });

  it("compares definitions whatever order their keys come back in (jsonb)", () => {
    const reordered = JSON.parse(
      JSON.stringify(DEFINITION, ["reviewIntervalDays", "skillMix", "categories", "periods"]),
    );
    const roundTrip = { ...reordered, ...JSON.parse(JSON.stringify(DEFINITION)) };
    expect(sameDefinition(DEFINITION, roundTrip)).toBe(true);
    expect(sameDefinition(DEFINITION, { ...DEFINITION, reviewIntervalDays: 28 })).toBe(false);
  });
});

describe("rules 2 to 5: versions, approval and the version in force", () => {
  const draft = version({
    id: "v2",
    versionNumber: 2,
    state: "draft",
    approvedBy: null,
    approvedAt: null,
    definition: { ...DEFINITION, reviewIntervalDays: 28 },
    authorId: "deputy",
    contributorIds: ["deputy", "nurse"],
  });

  it("moves a version only along the workflow", () => {
    expect(DEPENDENCY_SCALE_WORKFLOW.draft).toEqual(["approved", "discarded"]);
    expect(DEPENDENCY_SCALE_WORKFLOW.approved).toEqual(["superseded"]);
    expect(DEPENDENCY_SCALE_WORKFLOW.superseded).toEqual([]);
  });

  it.each([
    ["a second manager approves a changed draft", draft, version(), "manager", []],
    ["the first version, nothing in use", draft, null, "manager", []],
    ["its author", draft, version(), "deputy", ["author_cannot_approve"]],
    ["someone who changed it", draft, version(), "nurse", ["author_cannot_approve"]],
    ["a version already approved", version(), null, "manager", ["not_draft"]],
    [
      "a draft the same as the version in use",
      { ...draft, definition: DEFINITION },
      version(),
      "manager",
      ["unchanged"],
    ],
    [
      "a draft with problems",
      { ...draft, definition: { ...DEFINITION, periods: [] } },
      null,
      "manager",
      ["invalid_scale"],
    ],
  ] as const)("approval by %s", (_, d, current, approver, expected) => {
    expect(checkScaleApproval(d, current, approver)).toEqual(expected);
  });

  it("takes the version approved latest at or before the instant", () => {
    const v1 = version({ state: "superseded" });
    const v2 = version({
      id: "v2",
      versionNumber: 2,
      approvedAt: new Date("2026-10-15T12:00:00Z"),
    });
    const discarded = version({ id: "v3", state: "discarded", approvedAt: null });
    const versions = [v2, v1, discarded];
    expect(scaleVersionInForce(versions, new Date("2026-09-30T00:00:00Z"))).toBeNull();
    expect(scaleVersionInForce(versions, new Date("2026-10-01T09:00:00Z"))?.id).toBe("v1");
    expect(scaleVersionInForce(versions, new Date("2026-10-15T11:59:00Z"))?.id).toBe("v1");
    expect(scaleVersionInForce(versions, new Date("2026-10-15T12:00:00Z"))?.id).toBe("v2");
    expect(scaleVersionInForce([draft], new Date("2026-12-01T00:00:00Z"))).toBeNull();
  });

  it("hazard HZ-123 starts a version that moves the shift periods from the next UK day, so no day has a gap or an overlap", () => {
    const moved = version({
      id: "v2",
      versionNumber: 2,
      approvedAt: new Date("2026-11-02T12:00:00Z"),
      definition: {
        ...DEFINITION,
        periods: [
          { key: "day", label: "Day", startMinute: 420 },
          { key: "night", label: "Night", startMinute: 1140 },
        ],
      },
    });
    const sameShifts = version({
      id: "v3",
      versionNumber: 3,
      approvedAt: new Date("2026-11-04T12:00:00Z"),
      definition: { ...moved.definition, reviewIntervalDays: 28 },
    });
    const versions = [version({ state: "superseded" }), moved, sameShifts];
    expect(scaleVersionInForce(versions, new Date("2026-11-02T23:59:00Z"))?.id).toBe("v1");
    expect(scaleVersionInForce(versions, new Date("2026-11-03T00:00:00Z"))?.id).toBe("v2");
    expect(scaleVersionInForce(versions, new Date("2026-11-04T12:00:00Z"))?.id).toBe("v3");
    const [day, night] = staffingRequirement({
      locationId: LOCATION,
      date: "2026-11-02",
      scale: { scaleId: SCALE, name: "North", versions },
      people: [],
    });
    expect([day?.period?.start.toISOString(), night?.period?.start.toISOString()]).toEqual([
      "2026-11-02T08:00:00.000Z",
      "2026-11-02T20:00:00.000Z",
    ]);
    expect(day?.period?.end).toEqual(night?.period?.start);
  });

  it("uses a location's own scale, otherwise the organisation's", () => {
    const own = { id: "own", locationId: LOCATION };
    const wide = { id: "wide", locationId: null };
    expect(scaleForLocation([wide, own], LOCATION)?.id).toBe("own");
    expect(scaleForLocation([wide, own], "location-south")?.id).toBe("wide");
    expect(scaleForLocation([own], "location-south")).toBeNull();
  });
});

describe("rule 8: shift periods in UK wall-clock time", () => {
  it("covers the day: each period ends where the next starts", () => {
    const [day, night] = periodWindows(DEFINITION.periods, "2026-11-02");
    expect(day).toMatchObject({ key: "day", minutes: 720 });
    expect(day?.start.toISOString()).toBe("2026-11-02T08:00:00.000Z");
    expect(night?.start.toISOString()).toBe("2026-11-02T20:00:00.000Z");
    expect(night?.end.toISOString()).toBe("2026-11-03T08:00:00.000Z");
  });

  it.each([
    ["the night the clocks go back", "2026-10-24", 780, "2026-10-24T19:00:00.000Z"],
    ["the night the clocks go forward", "2026-03-28", 660, "2026-03-28T20:00:00.000Z"],
    ["a summer night", "2026-07-01", 720, "2026-07-01T19:00:00.000Z"],
  ])("hazard HZ-123 measures %s in elapsed time", (_, date, minutes, start) => {
    const night = periodWindows(DEFINITION.periods, date)[1];
    expect(night?.minutes).toBe(minutes);
    expect(night?.start.toISOString()).toBe(start);
  });

  it("gives one period the whole day, and no periods nothing", () => {
    const [whole] = periodWindows([{ key: "all", label: "All day", startMinute: 0 }], "2026-11-02");
    expect(whole?.minutes).toBe(1440);
    expect(periodWindows([], "2026-11-02")).toEqual([]);
  });
});

describe("rules 6 and 7: a person's category as an append-only chain", () => {
  const first = record();
  const review = record({
    id: "r2",
    kind: "review",
    supersedesId: "r1",
    categoryKey: "high",
    effectiveFrom: "2026-10-25",
  });
  const correction = record({
    id: "r3",
    kind: "correction",
    supersedesId: "r2",
    categoryKey: "low",
    effectiveFrom: "2026-10-25",
    oneToOne: [{ periodKey: "day", minutes: 120 }],
  });
  const all = [correction, first, review];

  it("orders the chain from the first record to the current one", () => {
    expect(dependencyChain(all).map((r) => r.id)).toEqual(["r1", "r2", "r3"]);
    expect(currentDependency(all)?.id).toBe("r3");
    expect(currentDependency([])).toBeNull();
    expect([...correctedDependencyIds(all)]).toEqual(["r2"]);
  });

  it.each([
    ["before the first", "2026-10-19T22:59:00Z", null],
    ["from 00:00 UK time on its date", "2026-10-19T23:00:00Z", "r1"],
    ["before the review", "2026-10-24T22:59:00Z", "r1"],
    ["the corrected review is never in force", "2026-10-24T23:00:00Z", "r3"],
  ])("is in force: %s", (_, at, expected) => {
    expect(dependencyInForce(all, new Date(at))?.id ?? null).toBe(expected);
  });

  const scale = version();
  const base: NewDependencyRecord = {
    kind: "review",
    categoryKey: "high",
    oneToOne: [{ periodKey: "day", minutes: 240 }],
    effectiveFrom: "2026-10-30",
    reason: "Now needs two carers for every transfer",
    decidedBy: "manager",
    supersedesId: "r1",
  };
  const ctx = { version: scale, records: [first], today: "2026-10-31" };

  it("accepts a review of the current record", () => {
    expect(checkDependencyRecord(base, ctx)).toEqual([]);
    expect(
      checkDependencyRecord(
        { ...base, kind: "initial", supersedesId: null },
        { ...ctx, records: [] },
      ),
    ).toEqual([]);
    expect(
      checkDependencyRecord({ ...base, kind: "correction", effectiveFrom: "2026-10-20" }, ctx),
    ).toEqual([]);
  });

  const cases: [
    string,
    Partial<NewDependencyRecord>,
    Partial<Omit<typeof ctx, "version">> & { version?: ScaleVersionRecord | null },
    DependencyProblem,
  ][] = [
    ["no scale approved", {}, { version: null }, "no_scale"],
    ["a draft scale", {}, { version: version({ state: "draft" }) }, "no_scale"],
    ["a category the scale lacks", { categoryKey: "medium" }, {}, "category_unknown"],
    [
      "one-to-one for a period the scale lacks",
      { oneToOne: [{ periodKey: "twilight", minutes: 30 }] },
      {},
      "one_to_one_unknown_period",
    ],
    [
      "one-to-one twice for a period",
      {
        oneToOne: [
          { periodKey: "day", minutes: 30 },
          { periodKey: "day", minutes: 30 },
        ],
      },
      {},
      "one_to_one_duplicate_period",
    ],
    [
      "no one-to-one minutes",
      { oneToOne: [{ periodKey: "day", minutes: 0 }] },
      {},
      "one_to_one_invalid",
    ],
    ["no reason", { reason: "  " }, {}, "reason_missing"],
    ["no one who decided", { decidedBy: null }, {}, "decider_missing"],
    ["a date after today", { effectiveFrom: "2026-11-01" }, {}, "effective_in_future"],
    ["a first record that supersedes", { kind: "initial" }, {}, "kind_mismatch"],
    ["a review that supersedes nothing", { supersedesId: null }, {}, "kind_mismatch"],
    ["a second first record", { kind: "initial", supersedesId: null }, {}, "initial_exists"],
    ["a review with nothing before it", {}, { records: [] }, "nothing_to_supersede"],
    ["a stale current record", { supersedesId: "r0" }, {}, "not_current"],
    [
      "a review dated before the record it replaces",
      { effectiveFrom: "2026-10-19" },
      {},
      "review_before_previous",
    ],
    [
      "a correction that moves the date",
      { kind: "correction", effectiveFrom: "2026-10-21" },
      {},
      "correction_date_changed",
    ],
  ];

  it.each(cases)("refuses %s", (_, input, context, problem) => {
    const problems = checkDependencyRecord({ ...base, ...input }, { ...ctx, ...context });
    expect(problems).toContain(problem);
    expect(DEPENDENCY_PROBLEM_MESSAGES[problem].length).toBeGreaterThan(10);
  });
});

describe("rule 9: who is at the location on a date", () => {
  const today = "2026-11-02";
  it.each([
    ["living there", "active", "2026-09-01", null, today, "present"],
    ["living there, on a later date", "active", "2026-09-01", null, "2026-11-09", "present"],
    ["before they were admitted", "active", "2026-09-01", null, "2026-08-31", "unknown"],
    ["in hospital today", "in_hospital", "2026-11-01", null, today, "away"],
    [
      "in hospital, asked about next week",
      "in_hospital",
      "2026-11-01",
      null,
      "2026-11-09",
      "away_return_unknown",
    ],
    [
      "on leave, asked about before the leave",
      "on_leave",
      "2026-11-01",
      null,
      "2026-10-31",
      "unknown",
    ],
    [
      "a planned admission on Monday, asked about Monday",
      "pre_admission",
      null,
      "2026-11-09",
      "2026-11-09",
      "planned_admission",
    ],
    [
      "a planned admission on Monday, asked about Sunday",
      "pre_admission",
      null,
      "2026-11-09",
      "2026-11-08",
      "not_yet_admitted",
    ],
    [
      "an admission overdue but not yet made",
      "pre_admission",
      null,
      "2026-10-30",
      today,
      "planned_admission",
    ],
    [
      "being admitted with no date, asked about tomorrow",
      "pre_admission",
      null,
      null,
      "2026-11-03",
      "admission_date_unknown",
    ],
    [
      "being admitted with no date, asked about last week",
      "pre_admission",
      null,
      null,
      "2026-10-26",
      "not_yet_admitted",
    ],
  ] as const)("hazard HZ-123 a person %s", (_, status, since, planned, date, expected) => {
    expect(
      presenceOn({ status, statusSince: since, plannedAdmissionOn: planned }, date, today),
    ).toBe(expected);
  });
});

describe("rules 9, 10 and 12: required care hours for a location and shift", () => {
  const date = "2026-11-02";
  const scale = { scaleId: SCALE, name: "North House dependency scale", versions: [version()] };
  const person = (
    id: string,
    over: Partial<DependencyRecord> | null,
    presence: PersonPresence = "present",
  ): RequirementPerson => ({
    personId: id,
    presence,
    records: over === null ? [] : [record({ id: `rec-${id}`, personId: id, ...over })],
  });
  const people = [
    person("ada", { categoryKey: "low" }),
    person("ben", { categoryKey: "high", oneToOne: [{ periodKey: "day", minutes: 240 }] }),
    person("cara", { categoryKey: "high" }),
  ];
  const run = (over: object = {}) =>
    staffingRequirement({ locationId: LOCATION, date, scale, people, ...over });
  const computed = (results: StaffingRequirement[], key: string) =>
    results.find((r) => r.status === "computed" && r.period.key === key) as PeriodRequirement;

  it("hazard HZ-123 adds up the organisation's figures for each period, with the method shown", () => {
    const day = computed(run(), "day");
    expect(day.figure).toBe("exact");
    expect(day.careMinutes).toBe(60 + 180 + 180);
    expect(day.oneToOneMinutes).toBe(240);
    expect(day.requiredMinutes).toBe(660);
    expect(day.complete).toBe(true);
    expect(day.warnings).toEqual([]);
    expect(day.categories).toEqual([
      { key: "low", label: "Low", minutesEach: 60, people: 1, minutes: 60 },
      { key: "high", label: "High", minutesEach: 180, people: 2, minutes: 360 },
    ]);
    expect(day.oneToOne).toEqual([{ personId: "ben", minutes: 240 }]);
    expect(day.skillMix).toEqual([{ skill: "registered_nurse", minimumStaff: 1 }]);
    expect(day.method).toEqual([
      "Scale: North House dependency scale, version 1, approved on 01/10/2026. This is your organisation's own scale.",
      "Period: Day, 02/11/2026 08:00 to 02/11/2026 20:00 (12 hours).",
      "Low: 1 person × 1 hour = 1 hour.",
      "High: 2 people × 3 hours = 6 hours.",
      "One-to-one: 4 hours for 1 person.",
      "Required care hours = 7 hours by category + 4 hours one-to-one = 11 hours.",
    ]);
    const night = computed(run(), "night");
    expect(night.requiredMinutes).toBe(20 + 60 + 60);
    expect(night.skillMix).toEqual([{ skill: "medicines_competent", minimumStaff: 2 }]);
  });

  it("hazard HZ-123 names the organisation's own scale as the source, never Harbour", () => {
    for (const result of run()) {
      expect(result.notice).toBe(DEPENDENCY_TOOL_NOTICE);
      expect(result.status).toBe("computed");
      const computedResult = result as PeriodRequirement;
      expect(computedResult.source).toEqual({
        kind: "organisation_scale",
        scaleId: SCALE,
        scaleName: "North House dependency scale",
        versionId: "v1",
        versionNumber: 1,
        approvedBy: "approver",
        approvedAt: new Date("2026-10-01T09:00:00Z"),
      });
      expect(computedResult.method[0]).toContain("your organisation's own scale");
      expectNoScore(computedResult);
    }
    expect(DEPENDENCY_TOOL_NOTICE).toContain("does not assess anyone's needs");
  });

  it("hazard HZ-123 gives no figure, never 0, when no scale is in force", () => {
    for (const result of [
      ...run({ scale: null }),
      ...run({ scale: { ...scale, versions: [version({ state: "draft", approvedAt: null })] } }),
    ]) {
      expect(result).toMatchObject({ status: "no_scale", period: null });
      expect(result).not.toHaveProperty("requiredMinutes");
      expect(result.warnings[0]?.code).toBe("no_scale");
    }
  });

  it("hazard HZ-123 shows a period before the first approval as having no scale", () => {
    const approvedAtNoon = {
      ...scale,
      versions: [version({ approvedAt: new Date("2026-11-02T12:00:00Z") })],
    };
    const results = run({ scale: approvedAtNoon });
    expect(results.map((r) => r.status)).toEqual(["no_scale", "computed"]);
    expect(results[0]?.period?.key).toBe("day");
  });

  it("hazard HZ-123 takes the version in force at each period's start when one is approved during the day", () => {
    const v2 = version({
      id: "v2",
      versionNumber: 2,
      approvedAt: new Date("2026-11-02T12:00:00Z"),
      definition: {
        ...DEFINITION,
        categories: DEFINITION.categories.map((c) =>
          c.key === "low"
            ? {
                ...c,
                careMinutes: [
                  { periodKey: "day", minutes: 90 },
                  { periodKey: "night", minutes: 30 },
                ],
              }
            : c,
        ),
      },
    });
    const results = run({ scale: { ...scale, versions: [version({ state: "superseded" }), v2] } });
    expect(computed(results, "day").source.versionNumber).toBe(1);
    const night = computed(results, "night");
    expect(night.source.versionNumber).toBe(2);
    expect(night.categories.find((c) => c.key === "low")?.minutesEach).toBe(30);
    expect(night.warnings.map((w) => w.code)).toContain("earlier_version");
    // A category recorded on version 2, read for the day period still on version 1.
    const laterDay = computed(
      run({
        scale: { ...scale, versions: [version({ state: "superseded" }), v2] },
        people: [person("ada", { scaleVersionId: "v2" })],
      }),
      "day",
    );
    expect(laterDay.people[0]?.flags).toEqual(["later_version"]);
    expect(laterDay.warnings.map((w) => w.code)).toEqual(["later_version"]);
  });

  it("returns one period when asked, and nothing for a period the scale lacks", () => {
    expect(run({ periodKey: "night" }).map((r) => r.period?.key)).toEqual(["night"]);
    expect(run({ periodKey: "twilight" })).toEqual([]);
  });

  it("hazard HZ-123 never counts an uncategorised person as needing nothing: the figure is at least, and names them", () => {
    const day = computed(run({ people: [...people, person("dev", null)] }), "day");
    expect(day.figure).toBe("at_least");
    expect(day.requiredMinutes).toBe(660);
    expect(day.complete).toBe(false);
    expect(day.warnings).toContainEqual({
      code: "not_assessed",
      message:
        "1 person is not counted: no dependency category is in force. Record their category.",
      personIds: ["dev"],
    });
    expect(day.method).toContain(
      "Required care hours = 7 hours by category + 4 hours one-to-one = at least 11 hours.",
    );
    expect(day.method.at(-1)).toBe(
      "Not counted: 1 person with no usable category or not known to be at the location, so the required care hours may be higher than shown.",
    );
  });

  it("hazard HZ-123 gives no figure when nobody is counted and people are left out (just after the first approval)", () => {
    const day = computed(run({ people: [person("ada", null), person("ben", null)] }), "day");
    expect(day).toMatchObject({
      figure: "none",
      requiredMinutes: null,
      careMinutes: null,
      oneToOneMinutes: null,
      complete: false,
    });
    expect(day.method).toContain(
      "No required care hours can be shown: nobody at the location is counted, and 2 people are left out (see the warnings).",
    );
    expect(day.method.join(" ")).not.toContain("= 0 hours");
  });

  it("gives an exact 0 for a location with nobody living there", () => {
    const day = computed(run({ people: [] }), "day");
    expect(day).toMatchObject({ figure: "exact", requiredMinutes: 0, complete: true });
  });

  it.each([
    ["categorised on another location's scale", { scaleId: "scale-south" }, "other_scale"],
    ["in a category the version in force lacks", { categoryKey: "medium" }, "not_in_scale_version"],
    [
      "with one-to-one for a period the version lacks",
      { oneToOne: [{ periodKey: "twilight", minutes: 60 }] },
      "not_in_scale_version",
    ],
    ["whose category starts after the period", { effectiveFrom: "2026-11-03" }, "not_assessed"],
  ] as const)("hazard HZ-123 leaves out and names a person %s", (_, over, code) => {
    const day = computed(run({ people: [...people, person("dev", over)] }), "day");
    expect(day.complete).toBe(false);
    expect(day.figure).toBe("at_least");
    expect(day.people.at(-1)?.standing).toBe(code);
    expect(day.warnings.map((w) => w.code)).toEqual([code]);
  });

  it("hazard HZ-123 lists people on leave or in hospital with the hours they would add", () => {
    const day = computed(
      run({
        people: [
          ...people,
          person("eve", { categoryKey: "high" }, "away"),
          person("fay", null, "away"),
        ],
      }),
      "day",
    );
    expect(day.requiredMinutes).toBe(660);
    expect(day.awayMinutes).toBe(180);
    expect(day.complete).toBe(true);
    expect(day.figure).toBe("exact");
    expect(day.warnings).toEqual([
      {
        code: "people_away",
        message: "1 person on leave or in hospital is not counted. They would add 3 hours.",
        personIds: ["eve"],
      },
    ]);
    expect(day.method).toContain(
      "Not counted: 1 person on leave or in hospital, who would add 3 hours.",
    );
  });

  it.each([
    ["away today with no return date", "away_return_unknown", "away_return_unknown"],
    ["being admitted with no planned date", "admission_date_unknown", "admission_date_unknown"],
    ["the record cannot place on the date", "unknown", "presence_unknown"],
  ] as const)(
    "hazard HZ-123 never treats a person %s as absent: the figure is at least",
    (_, presence, code) => {
      const day = computed(
        run({ people: [...people, person("gus", { categoryKey: "high" }, presence)] }),
        "day",
      );
      expect(day.complete).toBe(false);
      expect(day.figure).toBe("at_least");
      expect(day.requiredMinutes).toBe(660);
      expect(day.warnings.map((w) => w.code)).toContain(code);
      expect(day.warnings.find((w) => w.code === code)?.personIds).toEqual(["gus"]);
    },
  );

  it("hazard HZ-123 counts a planned admission from its date, and says so", () => {
    const day = computed(
      run({ people: [...people, person("hal", { categoryKey: "low" }, "planned_admission")] }),
      "day",
    );
    expect(day.requiredMinutes).toBe(720);
    expect(day.complete).toBe(true);
    expect(day.warnings.map((w) => w.code)).toEqual(["planned_admission"]);
    const before = computed(
      run({ people: [...people, person("hal", { categoryKey: "low" }, "not_yet_admitted")] }),
      "day",
    );
    expect(before.requiredMinutes).toBe(660);
    expect(before.warnings).toEqual([]);
  });

  it("hazard HZ-123 counts but flags a category older than the review interval", () => {
    const day = computed(
      run({
        people: [
          person("ada", { effectiveFrom: "2026-09-01" }),
          person("ben", { effectiveFrom: "2026-10-03" }),
        ],
      }),
      "day",
    );
    expect(day.people.map((p) => p.flags)).toEqual([["review_overdue"], []]);
    expect(day.requiredMinutes).toBe(120);
    expect(day.warnings).toContainEqual({
      code: "review_overdue",
      message: "1 person has a category older than your review interval of 30 days. Review them.",
      personIds: ["ada"],
    });
  });

  it("says nothing is overdue when the scale has no review interval", () => {
    const noInterval = {
      ...scale,
      versions: [version({ definition: { ...DEFINITION, reviewIntervalDays: null } })],
    };
    const day = computed(
      run({ scale: noInterval, people: [person("ada", { effectiveFrom: "2025-01-01" })] }),
      "day",
    );
    expect(day.people[0]?.flags).toEqual([]);
  });

  it.each([
    ["back", "2026-10-24", "extra", "13 hours", "12 hours"],
    ["forward", "2026-03-28", "lost", "11 hours", "12 hours"],
  ])(
    "hazard HZ-123 says the care minutes are not adjusted on the night the clocks go %s",
    (_, night, word, length, usual) => {
      const result = computed(
        staffingRequirement({
          locationId: LOCATION,
          date: night,
          scale: {
            ...scale,
            versions: [version({ approvedAt: new Date("2026-01-01T00:00:00Z") })],
          },
          people: [person("ada", { effectiveFrom: "2026-01-01" })],
        }),
        "night",
      );
      expect(result.requiredMinutes).toBe(20);
      expect(result.method).toContain(
        `Care minutes are as your scale sets them for this period; they are not adjusted for the ${word} hour of the clock change.`,
      );
      expect(result.warnings.find((w) => w.code === "clock_change")?.message).toBe(
        `The clocks change during this period, so it lasts ${length} instead of ${usual}. Your scale's care minutes are not adjusted for this.`,
      );
    },
  );
});

/** No field of a result names a score, a risk level or a judgement of safe staffing (rule 12). */
function expectNoScore(result: object) {
  const keys = JSON.stringify(Object.keys(result)).toLowerCase();
  for (const word of ["score", "risk", "safe", "acuity", "recommend"]) {
    expect(keys).not.toContain(word);
  }
}

describe("rule 11: comparison inputs for the rota", () => {
  const scale = { scaleId: SCALE, name: "North House", versions: [version()] };
  const ada: RequirementPerson = {
    personId: "ada",
    presence: "present",
    records: [record({ categoryKey: "high" })],
  };
  const requirementFor = (people: RequirementPerson[]) =>
    staffingRequirement({
      locationId: LOCATION,
      date: "2026-11-02",
      periodKey: "day",
      scale,
      people,
    })[0] as StaffingRequirement;
  const day = requirementFor([ada]);
  const incomplete = requirementFor([ada, { personId: "ben", presence: "present", records: [] }]);
  const nobody = requirementFor([{ personId: "ben", presence: "present", records: [] }]);
  const overdue = requirementFor([
    { ...ada, records: [record({ categoryKey: "high", effectiveFrom: "2026-01-01" })] },
  ]);

  it.each([
    ["enough hours and a nurse", day, 180, 1, "met"],
    ["more hours than required", day, 600, 2, "met"],
    ["an hour short", day, 120, 1, "below"],
    ["no nurse", day, 600, 0, "below"],
    ["enough for those counted, but someone is not counted", incomplete, 600, 1, "incomplete"],
    ["short and incomplete", incomplete, 60, 1, "below"],
    ["nobody counted, so nothing to compare", nobody, 600, 1, "incomplete"],
    ["enough, but every category is overdue for review", overdue, 600, 1, "met_with_warnings"],
  ] as const)("hazard HZ-123 %s", (_, requirement, minutes, nurses, status) => {
    const result = compareStaffing(requirement, {
      careMinutes: minutes,
      staffWithSkill: { registered_nurse: nurses },
    });
    expect(result.status).toBe(status);
    expect(result.word).toBe(STAFFING_STATUS_WORDS[status]);
    expect(result.notice).toBe(DEPENDENCY_TOOL_NOTICE);
    expectNoScore(result);
  });

  it("hazard HZ-123 carries every warning on the requirement into the comparison", () => {
    const result = compareStaffing(overdue, {
      careMinutes: 600,
      staffWithSkill: { registered_nurse: 1 },
    });
    expect(result.word).toBe(
      "Meets the hours and staff your scale requires, but read the warnings",
    );
    expect(result.warnings).toEqual([
      "1 person has a category older than your review interval of 30 days. Review them.",
    ]);
    const none = compareStaffing(nobody, { careMinutes: 600, staffWithSkill: {} });
    expect(none).toMatchObject({ requiredMinutes: null, shortMinutes: null, figure: "none" });
    expect(none.warnings.at(-1)).toBe(
      "Nobody at the location is counted, so the rota cannot be compared with your scale.",
    );
  });

  it("hazard HZ-123 says by how much and which skill is short, in words", () => {
    const result = compareStaffing(day, { careMinutes: 120, staffWithSkill: {} });
    expect(result.shortMinutes).toBe(60);
    expect(result.skills).toEqual([
      {
        skill: "registered_nurse",
        label: "Registered nurse",
        minimumStaff: 1,
        rostered: 0,
        short: 1,
      },
    ]);
    expect(result.warnings).toEqual([
      "The rota gives 2 hours of care on Day; your scale requires 3 hours, 1 hour short.",
      "Your scale requires at least 1 staff on Day with this skill: Registered nurse. The rota has 0.",
    ]);
    expect(result.method.at(-1)).toBe("Rota: 2 hours of care on Day.");
    expect(result.source?.kind).toBe("organisation_scale");
    const short = compareStaffing(incomplete, {
      careMinutes: 60,
      staffWithSkill: { registered_nurse: 1 },
    });
    expect(short.warnings).toContain(
      "The rota gives 1 hour of care on Day; your scale requires at least 3 hours, at least 2 hours short.",
    );
  });

  it("hazard HZ-123 is never met without a scale", () => {
    const [none] = staffingRequirement({
      locationId: LOCATION,
      date: "2026-11-02",
      scale: null,
      people: [ada],
    });
    const result = compareStaffing(none as StaffingRequirement, {
      careMinutes: 9999,
      staffWithSkill: {},
    });
    expect(result).toMatchObject({
      status: "no_scale",
      requiredMinutes: null,
      shortMinutes: null,
      source: null,
    });
    expect(result.warnings[0]).toContain("No dependency scale is in force");
  });
});

describe("hours in words", () => {
  it.each([
    [0, "0 hours"],
    [1, "1 minute"],
    [45, "45 minutes"],
    [60, "1 hour"],
    [61, "1 hour 1 minute"],
    [270, "4 hours 30 minutes"],
    [780, "13 hours"],
  ])("%i minutes reads %s", (minutes, words) => {
    expect(formatCareMinutes(minutes)).toBe(words);
  });
});
