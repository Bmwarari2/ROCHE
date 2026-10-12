import { describe, expect, it } from "vitest";
import { readRateTable } from "../../test/rate-table";
import { resolveRate } from "../platform/rates";
import type { Recurrence } from "../platform/tasks";
import {
  checkPlanAction,
  checkPublication,
  MIN_ROUND_GAP_MINUTES,
  planActionGeneratesTasks,
} from "./care-plan";
import {
  CARE_PLAN_TASK_RATE_KEYS,
  EARLIER_PLAN_NOTICE,
  NOT_A_ROUND_NOTICE,
  PLAN_ACTION_TASK_KIND,
  type PlanTaskAction,
  type PlanTaskSeries,
  planActionNotice,
  planActionTaskSeries,
  planActionTaskTitle,
  planRoundNotice,
  roundTimes,
  sameTaskSchedule,
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

const hourlyClock = daily(
  ...Array.from({ length: 24 }, (_, h) => `${String(h).padStart(2, "0")}:00`),
);
const halfHourlyClock = daily(
  ...Array.from({ length: 48 }, (_, i) => {
    const m = i * 30;
    return `${String(Math.floor(m / 60)).padStart(2, "0")}:${String(m % 60).padStart(2, "0")}`;
  }),
);

/** The rounds of a schedule over one UK day and the night either side. */
const roundsOn = (rule: Recurrence, day: string) =>
  roundTimes(
    { rule, startsOn: "2026-01-01" },
    new Date(`${day}T00:00:00Z`),
    new Date(new Date(`${day}T00:00:00Z`).getTime() + 2 * 86_400_000),
    DEFAULTS,
  );

const DAYS = [
  ["an ordinary day", "2026-10-11"],
  ["the clocks going forward in 2026", "2026-03-28"],
  ["the clocks going back in 2026", "2026-10-24"],
  ["the clocks going forward in 2027", "2027-03-27"],
  ["the clocks going back in 2027", "2027-10-30"],
] as const;

const SCHEDULES = [
  ["01:00 and 02:00", daily("01:00", "02:00")],
  ["01:30 and 02:30", daily("01:30", "02:30")],
  ["00:30 and 01:30", daily("00:30", "01:30")],
  ["08:00 and 08:45", daily("08:00", "08:45")],
  ["every hour on the clock", hourlyClock],
  ["every half hour on the clock", halfHourlyClock],
  ["every hour in real hours", turns(1)],
  ["every four hours", turns(4)],
] as const;

describe("hazard HZ-004 a round's window never reaches the next round's", () => {
  it("reads the window figures from the rate table", () => {
    expect(DEFAULTS).toEqual({ beforeMinutes: 30, afterMinutes: 60 });
  });

  describe.each(DAYS)("on %s", (_label, day) => {
    it.each(SCHEDULES)("%s: every round has a window, and no instant is in two", (_name, rule) => {
      const rounds = roundsOn(rule, day);
      expect(rounds.length).toBeGreaterThan(0);
      for (const [i, r] of rounds.entries()) {
        // Never a window of nothing on either side, and never wider than the tenant's figures.
        expect(r.windowStart.getTime()).toBeLessThan(r.dueAt.getTime());
        expect(r.windowEnd.getTime()).toBeGreaterThan(r.dueAt.getTime());
        expect(r.dueAt.getTime() - r.windowStart.getTime()).toBeLessThanOrEqual(
          DEFAULTS.beforeMinutes * 60_000,
        );
        expect(r.windowEnd.getTime() - r.dueAt.getTime()).toBeLessThanOrEqual(
          DEFAULTS.afterMinutes * 60_000,
        );
        const next = rounds[i + 1];
        if (next) {
          expect(next.dueAt.getTime()).toBeGreaterThan(r.dueAt.getTime());
          expect(r.windowEnd.getTime()).toBeLessThan(next.windowStart.getTime());
        }
      }
    });
  });

  it.each([
    ["2026-03-29", "2026-03-29T01:00:00.000Z"],
    ["2027-03-28", "2027-03-28T01:00:00.000Z"],
  ])("merges 01:00 and 02:00 into one round on %s, when they are the same instant", (day, at) => {
    const onTheDay = roundsOn(daily("01:00", "02:00"), day).filter((r) =>
      r.dueAt.toISOString().startsWith(day),
    );
    expect(onTheDay.map((r) => r.dueAt.toISOString())).toEqual([at]);
  });

  it("keeps both rounds, and full windows, on an ordinary day", () => {
    const rounds = roundsOn(daily("01:00", "02:00"), "2026-10-11").filter((r) =>
      r.dueAt.toISOString().startsWith("2026-10-11"),
    );
    // 01:00 and 02:00 BST: an hour apart, shared without touching.
    expect(rounds.map((r) => r.dueAt.toISOString())).toEqual([
      "2026-10-11T00:00:00.000Z",
      "2026-10-11T01:00:00.000Z",
    ]);
    const [first, second] = rounds;
    expect(((first?.windowEnd.getTime() ?? 0) - (first?.dueAt.getTime() ?? 0)) / 60_000).toBe(29);
    expect(((second?.dueAt.getTime() ?? 0) - (second?.windowStart.getTime() ?? 0)) / 60_000).toBe(
      30,
    );
  });

  it("gives four-hourly turns the tenant's full window", () => {
    const [round] = roundsOn(turns(4), "2026-10-11");
    expect(round).toBeDefined();
    expect(((round?.dueAt.getTime() ?? 0) - (round?.windowStart.getTime() ?? 0)) / 60_000).toBe(30);
    expect(((round?.windowEnd.getTime() ?? 0) - (round?.dueAt.getTime() ?? 0)) / 60_000).toBe(60);
  });

  it.each([
    ["every half hour", halfHourlyClock, "2026-10-11T11:15:00Z"],
    // 101 minutes apart: each round's window is cut by a neighbour beyond the sum of the figures.
    ["08:00 and 09:41", daily("08:00", "09:41"), "2026-10-11T07:30:00Z"],
    ["08:00 and 09:41, cut later", daily("08:00", "09:41"), "2026-10-11T08:30:00Z"],
    ["over the clocks going back", hourlyClock, "2026-10-25T01:30:00Z"],
  ] as const)(
    "gives the same windows however the range is cut (%s), so it does not matter when rounds are made",
    (_label, rule, cut) => {
      const day = cut.slice(0, 10);
      const start = new Date(`${day}T00:00:00Z`);
      const end = new Date(start.getTime() + 86_400_000);
      const whole = roundTimes({ rule, startsOn: "2026-01-01" }, start, end, DEFAULTS);
      const halves = [
        ...roundTimes({ rule, startsOn: "2026-01-01" }, start, new Date(cut), DEFAULTS),
        ...roundTimes({ rule, startsOn: "2026-01-01" }, new Date(cut), end, DEFAULTS),
      ];
      expect(halves).toEqual(whole);
    },
  );

  it.each([
    ["two times 5 minutes apart", daily("08:00", "08:05"), false],
    [
      "the last time of a day and the first of the next 5 minutes apart",
      daily("23:58", "00:03"),
      false,
    ],
    ["times 10 minutes apart", daily("08:00", "08:10"), true],
    [
      "every other day, late and early",
      { freq: "daily", interval: 2, times: ["23:58", "00:03"] } as Recurrence,
      true,
    ],
    ["hourly turns", turns(1), true],
  ])("refuses or accepts %s", (_label, rule, ok) => {
    const check = checkPlanAction(
      { generatesTasks: true, recurrence: rule, roleKey: "care_worker", domain: "skin" },
      "2026-10-11",
    );
    expect(check.ok).toBe(ok);
    if (!check.ok) {
      expect(check.message).toBe(
        `Times for one action must be at least ${MIN_ROUND_GAP_MINUTES} minutes apart.`,
      );
    }
  });
});

describe("hazards HZ-024 and HZ-003 what a round and an action say about themselves", () => {
  it.each([
    ["active", true, null],
    ["superseded", false, EARLIER_PLAN_NOTICE],
    ["active", false, EARLIER_PLAN_NOTICE],
    ["superseded", true, EARLIER_PLAN_NOTICE],
  ] as const)(
    "hazard HZ-024 a round from a %s plan whose series is live (%s) says %j",
    (planStatus, seriesLive, notice) => {
      expect(planRoundNotice({ planStatus, seriesLive })).toBe(notice);
    },
  );

  it("hazard HZ-003 says a medicines action is not a round, and nothing on the rest", () => {
    expect(planActionNotice("medicines")).toBe("Not a round: see the medicines record");
    expect(NOT_A_ROUND_NOTICE).toBe("Not a round: see the medicines record");
    expect(planActionNotice("skin")).toBeNull();
    expect(EARLIER_PLAN_NOTICE).toBe("From an earlier plan: check the current plan");
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
