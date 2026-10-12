import { describe, expect, it } from "vitest";
import { readRateTable } from "../../test/rate-table";
import { resolveRate } from "../platform/rates";
import { occurrences, type Recurrence } from "../platform/tasks";
import { checkPlanAction, checkPublication, planActionGeneratesTasks } from "./care-plan";
import {
  CARE_PLAN_TASK_RATE_KEYS,
  PLAN_ACTION_TASK_KIND,
  type PlanTaskAction,
  type PlanTaskSeries,
  planActionTaskSeries,
  planActionTaskTitle,
  planActionTaskWindow,
  sameTaskSchedule,
  shortestGapMinutes,
} from "./plan-tasks";

/**
 * Care plan actions generate the shift's tasks (care.md rule 14; register row CARE-013). An active
 * plan's task-generating actions each drive one task series; a new version carries an unchanged
 * action's series forward, so its rounds are neither cancelled nor made twice, and ends the series
 * of actions it changed or dropped.
 */

const rows = readRateTable();
const rate = (key: string) => Number(resolveRate(rows, key, "england", "2026-10-11", null).value);
const DEFAULTS = {
  beforeMinutes: rate(CARE_PLAN_TASK_RATE_KEYS.windowBeforeMinutes),
  afterMinutes: rate(CARE_PLAN_TASK_RATE_KEYS.windowAfterMinutes),
};

const daily = (...times: string[]): Recurrence => ({ freq: "daily", times });
const turns = (hours: number): Recurrence => ({ freq: "every_hours", hours, anchorTime: "02:00" });

const action = (id: string, extra: Partial<PlanTaskAction> = {}): PlanTaskAction => ({
  id,
  basedOnActionId: null,
  domain: "skin",
  generatesTasks: true,
  recurrence: turns(4),
  roleKey: "care_worker",
  evidenceRequired: true,
  ...extra,
});

const series = (
  id: string,
  actionId: string,
  extra: Partial<PlanTaskSeries> = {},
): PlanTaskSeries => ({
  id,
  actionId,
  active: true,
  lifecycleStopped: false,
  title: planActionTaskTitle("skin"),
  recurrence: turns(4),
  roleKey: "care_worker",
  evidenceRequired: true,
  ...extra,
});

describe("the window figures come from the rate table", () => {
  it("reads a window before and after the round's time for every nation", () => {
    for (const nation of ["england", "wales", "scotland", "northern_ireland"] as const) {
      for (const key of Object.values(CARE_PLAN_TASK_RATE_KEYS)) {
        expect(Number(resolveRate(rows, key, nation, "2026-10-11", null).value)).toBeGreaterThan(0);
      }
    }
  });
});

describe("rule 14: what a care plan task is called and who completes it", () => {
  it("names the need, never the person or the action's own words", () => {
    expect(planActionTaskTitle("nutrition_and_hydration")).toBe(
      "Care plan: nutrition and hydration",
    );
    expect(planActionTaskTitle("skin")).toBe("Care plan: skin");
    expect(PLAN_ACTION_TASK_KIND).toBe("care.plan_action");
  });

  it.each([
    ["skin", true],
    ["mobility", true],
    ["medicines", false],
  ] as const)(
    "hazard HZ-003 an action in the %s domain generates tasks: %s",
    (domain, expected) => {
      expect(planActionGeneratesTasks(domain)).toBe(expected);
    },
  );

  it("hazard HZ-003 refuses a task-generating action in the medicines domain: doses come from the MAR", () => {
    const check = checkPlanAction(
      {
        generatesTasks: true,
        recurrence: daily("08:00"),
        roleKey: "care_worker",
        domain: "medicines",
      },
      "2026-10-11",
    );
    expect(check).toEqual({
      ok: false,
      field: "generatesTasks",
      message:
        "Medicines rounds come from the medicines record, so a medicines action cannot generate tasks. Describe the support here and leave the rounds to the MAR.",
    });
    // As needed, it is still part of the plan.
    expect(
      checkPlanAction(
        { generatesTasks: false, recurrence: null, roleKey: null, domain: "medicines" },
        "2026-10-11",
      ),
    ).toEqual({ ok: true });
    const publication = checkPublication({
      status: "draft",
      sections: [
        {
          domain: "medicines",
          need: "Needs prompting to take tablets.",
          outcome: "I take my tablets with breakfast.",
          actions: [{ generatesTasks: true, recurrence: daily("08:00"), roleKey: "care_worker" }],
        },
      ],
    });
    expect(publication.ok).toBe(false);
  });
});

describe("hazard HZ-004 a round's window never reaches the next round's", () => {
  it.each([
    // A gap that spans 01:00 may be an hour shorter, on the night the clocks go forward.
    ["once a day", daily("09:00"), 1380],
    ["twice a day", daily("08:00", "20:00"), 660],
    ["morning and lunchtime", daily("12:30", "08:00"), 270],
    ["every other day", { freq: "daily", interval: 2, times: ["09:00"] } as Recurrence, 2820],
    ["four-hourly turns", turns(4), 240],
    ["hourly checks", turns(1), 60],
    [
      "Monday and Thursday mornings",
      { freq: "weekly", weekdays: ["mon", "thu"], times: ["10:00"] } as Recurrence,
      3 * 1440 - 60,
    ],
    [
      "Sunday night and Monday morning",
      { freq: "weekly", weekdays: ["mon", "sun"], times: ["07:00", "22:00"] } as Recurrence,
      8 * 60,
    ],
    [
      "every other Friday",
      { freq: "weekly", interval: 2, weekdays: ["fri"], times: ["14:00"] } as Recurrence,
      14 * 1440 - 60,
    ],
    ["monthly", { freq: "monthly", dayOfMonth: 1, times: ["10:00"] } as Recurrence, 28 * 1440 - 60],
    // An hour less on the spring night: 00:30 to 01:30 crosses 01:00, so it can be no time at all.
    ["either side of 01:00", daily("00:30", "01:30"), 0],
  ])("the shortest gap between rounds %s", (_label, rule, minutes) => {
    expect(shortestGapMinutes(rule)).toBe(minutes);
  });

  it.each([
    ["once a day keeps the defaults", daily("09:00"), DEFAULTS],
    ["four-hourly turns keep the defaults", turns(4), DEFAULTS],
    ["two-hourly turns keep the defaults", turns(2), DEFAULTS],
    ["hourly checks are cut to fit", turns(1), { beforeMinutes: 30, afterMinutes: 29 }],
    [
      "rounds 45 minutes apart are cut to fit",
      daily("08:00", "08:45"),
      { beforeMinutes: 22, afterMinutes: 22 },
    ],
    [
      "rounds either side of 01:00 have no window at all",
      daily("00:30", "01:30"),
      { beforeMinutes: 0, afterMinutes: 0 },
    ],
  ])("%s", (_label, rule, expected) => {
    expect(DEFAULTS).toEqual({ beforeMinutes: 30, afterMinutes: 60 });
    expect(planActionTaskWindow(rule, DEFAULTS)).toEqual(expected);
  });

  it("leaves no instant inside two rounds' windows across both clock changes", () => {
    for (const rule of [turns(1), daily("00:30", "01:30", "02:30"), daily("08:00", "08:45")]) {
      const window = planActionTaskWindow(rule, DEFAULTS);
      for (const [from, to] of [
        ["2026-03-28T00:00:00Z", "2026-03-30T00:00:00Z"],
        ["2026-10-24T00:00:00Z", "2026-10-26T00:00:00Z"],
      ] as const) {
        const due = occurrences({ rule, startsOn: "2026-01-01" }, new Date(from), new Date(to));
        for (let i = 1; i < due.length; i++) {
          const end = (due[i - 1] as Date).getTime() + window.afterMinutes * 60_000;
          const start = (due[i] as Date).getTime() - window.beforeMinutes * 60_000;
          if (window.beforeMinutes + window.afterMinutes === 0) {
            expect(end).toBeLessThanOrEqual(start);
          } else {
            expect(end).toBeLessThan(start);
          }
        }
      }
    }
  });
});

describe("hazard HZ-024 only the active plan's task-generating actions drive tasks", () => {
  it.each([
    ["draft", 0],
    ["superseded", 0],
    ["active", 1],
  ] as const)("a %s plan creates %i series", (status, created) => {
    const changes = planActionTaskSeries({ status, actions: [action("a1")] }, []);
    expect(changes.create).toHaveLength(created);
  });

  it("skips actions done as needed and lists medicines actions it will not generate", () => {
    const changes = planActionTaskSeries(
      {
        status: "active",
        actions: [
          action("as-needed", { generatesTasks: false, recurrence: null, roleKey: null }),
          action("tablets", { domain: "medicines", recurrence: daily("08:00") }),
          action("turns"),
        ],
      },
      [],
    );
    expect(changes.create).toEqual(["turns"]);
    expect(changes.notGenerated).toEqual([{ actionId: "tablets", reason: "medicines_domain" }]);
  });
});

describe("hazard HZ-024 publishing a new version changes only the rounds it changed", () => {
  it("is idempotent: an action that already drives a series keeps it", () => {
    const changes = planActionTaskSeries({ status: "active", actions: [action("a1")] }, [
      series("s1", "a1"),
    ]);
    expect(changes).toEqual({
      keep: [{ actionId: "a1", seriesId: "s1" }],
      adopt: [],
      create: [],
      end: [],
      notGenerated: [],
    });
  });

  it("hazard HZ-004 carries an unchanged action's series to the new version, so no round is cancelled or made twice", () => {
    const changes = planActionTaskSeries(
      {
        status: "active",
        actions: [action("v2-turns", { basedOnActionId: "v1-turns" })],
      },
      [series("s1", "v1-turns")],
    );
    expect(changes.adopt).toEqual([{ actionId: "v2-turns", seriesId: "s1" }]);
    expect(changes.create).toEqual([]);
    expect(changes.end).toEqual([]);
  });

  it.each([
    ["a new time", { recurrence: turns(2) }],
    ["a new role", { roleKey: "team_leader" }],
    ["evidence no longer asked for", { evidenceRequired: false }],
    ["moved to another need", { domain: "mobility" as const }],
  ])("ends the old series and starts a new one for %s", (_label, change) => {
    const changes = planActionTaskSeries(
      { status: "active", actions: [action("v2", { basedOnActionId: "v1", ...change })] },
      [series("s1", "v1")],
    );
    expect(changes.adopt).toEqual([]);
    expect(changes.create).toEqual(["v2"]);
    expect(changes.end).toEqual(["s1"]);
  });

  it("ends the series of an action the new version dropped, or stopped generating tasks", () => {
    const changes = planActionTaskSeries(
      {
        status: "active",
        actions: [
          action("v2-kept", { basedOnActionId: "v1-kept" }),
          action("v2-now-as-needed", {
            basedOnActionId: "v1-now-as-needed",
            generatesTasks: false,
          }),
        ],
      },
      [
        series("s-kept", "v1-kept"),
        series("s-dropped", "v1-dropped"),
        series("s-off", "v1-now-as-needed"),
      ],
    );
    expect(changes.adopt).toEqual([{ actionId: "v2-kept", seriesId: "s-kept" }]);
    expect(changes.end).toEqual(["s-dropped", "s-off"]);
  });

  it("gives a series to one action only when two copies come from the same original", () => {
    const changes = planActionTaskSeries(
      {
        status: "active",
        actions: [
          action("copy-1", { basedOnActionId: "v1" }),
          action("copy-2", { basedOnActionId: "v1" }),
        ],
      },
      [series("s1", "v1")],
    );
    expect(changes.adopt).toEqual([{ actionId: "copy-1", seriesId: "s1" }]);
    expect(changes.create).toEqual(["copy-2"]);
  });

  it("hazard HZ-003 keeps a series the people lifecycle stopped with its action, never making a second one", () => {
    const stopped = series("s1", "a1", { active: false, lifecycleStopped: true });
    const kept = planActionTaskSeries({ status: "active", actions: [action("a1")] }, [stopped]);
    expect(kept.keep).toEqual([{ actionId: "a1", seriesId: "s1" }]);
    expect(kept.create).toEqual([]);
    const carried = planActionTaskSeries(
      { status: "active", actions: [action("a2", { basedOnActionId: "a1" })] },
      [stopped],
    );
    expect(carried.adopt).toEqual([{ actionId: "a2", seriesId: "s1" }]);
  });

  it("ignores series already ended by an earlier version", () => {
    const ended = series("s-old", "a1", { active: false, lifecycleStopped: false });
    const changes = planActionTaskSeries({ status: "active", actions: [action("a1")] }, [ended]);
    expect(changes.create).toEqual(["a1"]);
    expect(changes.end).toEqual([]);
  });

  it("ends every live series when no plan is active", () => {
    const changes = planActionTaskSeries({ status: "superseded", actions: [action("a1")] }, [
      series("s1", "a1"),
      series("s2", "a2", { active: false, lifecycleStopped: true }),
    ]);
    expect(changes.end).toEqual(["s1", "s2"]);
  });
});

describe("rule 14: the same schedule", () => {
  it("ignores the order of times and weekdays, and a written interval of 1", () => {
    const s = series("s1", "a1", {
      recurrence: { freq: "weekly", weekdays: ["thu", "mon"], times: ["20:00", "08:00"] },
    });
    expect(
      sameTaskSchedule(
        s,
        action("a2", {
          recurrence: {
            freq: "weekly",
            interval: 1,
            weekdays: ["mon", "thu"],
            times: ["08:00", "20:00"],
          },
        }),
      ),
    ).toBe(true);
    expect(
      sameTaskSchedule(
        s,
        action("a2", {
          recurrence: {
            freq: "weekly",
            interval: 2,
            weekdays: ["mon", "thu"],
            times: ["08:00", "20:00"],
          },
        }),
      ),
    ).toBe(false);
  });
});
