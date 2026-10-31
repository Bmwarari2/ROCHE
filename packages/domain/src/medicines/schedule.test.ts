/// <reference types="node" />
import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { UNIT } from "../../test/medicines-fixtures";
import { readRateTable, tableMedicinesRates } from "../../test/rate-table";
import { RateNotFoundError, type RateRow } from "../platform/rates";
import { formatUkDate, formatUkTime, fromUkWallClock } from "../shared/time";
import type { Dose } from "./dose";
import { MEDICINES_RATE_KEYS, resolveMedicinesRates } from "./rates";
import {
  checkSchedule,
  clockChangesIn,
  describeSchedule,
  expandSchedule,
  keepsCountFrom,
  type MarDose,
  marCycle,
  marCycleContaining,
  type RegularSchedule,
  type SchedulePattern,
  type ScheduleProblem,
  WEEKDAY_NAMES,
} from "./schedule";

const rates = tableMedicinesRates();
const days = rates.orderingCycleDays;
const two: Dose = { kind: "amount", quantity: 2, unit: UNIT.tablet };
const one: Dose = { kind: "amount", quantity: 1, unit: UNIT.tablet };
const at = (...times: string[]) => times.map((time) => ({ time, dose: one }));
const schedule = (pattern: SchedulePattern, times = at("08:00")): RegularSchedule => ({
  pattern,
  times,
});
const uk = (d: MarDose) => `${formatUkDate(d.dueAt)} ${formatUkTime(d.dueAt)}`;
/** A cycle starting on Monday 02/11/2026: no clock change inside it. */
const november = marCycle("2026-11-02", rates);
const fromStart = { startsAt: november.from, endsAt: null };

describe("the MAR cycle comes from the rate table", () => {
  it("reads medicines.ordering_cycle_days for each nation, and a tenant's own figure wins", () => {
    const rows = readRateTable();
    const row = rows.find((r) => r.key === MEDICINES_RATE_KEYS.orderingCycleDays);
    for (const nation of ["england", "wales", "scotland", "northern_ireland"] as const) {
      expect(resolveMedicinesRates(rows, nation, "2026-10-31", null).orderingCycleDays).toBe(
        Number(row?.value),
      );
    }
    const tenant: RateRow = {
      key: MEDICINES_RATE_KEYS.orderingCycleDays,
      value: "35",
      unit: "days",
      nation: "all",
      validFrom: "2026-01-01",
      validTo: null,
      tenantId: "tenant-a",
      verificationStatus: "tenant",
      source: "tenant policy",
    };
    expect(
      resolveMedicinesRates([...rows, tenant], "england", "2026-10-31", "tenant-a")
        .orderingCycleDays,
    ).toBe(35);
  });

  it("finds every medicines figure in docs/specs/rates.md for each nation", () => {
    const rows = readRateTable();
    for (const nation of ["england", "wales", "scotland", "northern_ireland"] as const) {
      const resolved = resolveMedicinesRates(rows, nation, "2026-10-31", null);
      for (const [name, key] of Object.entries(MEDICINES_RATE_KEYS)) {
        const row = rows.find((r) => r.key === key && r.validTo === null);
        expect(resolved[name as keyof typeof resolved], key).toBe(Number(row?.value));
      }
    }
  });

  it("fails loudly when the figure is missing rather than guessing", () => {
    const rows = readRateTable().filter((r) => r.key !== MEDICINES_RATE_KEYS.orderingCycleDays);
    expect(() => resolveMedicinesRates(rows, "england", "2026-10-31", null)).toThrow(
      RateNotFoundError,
    );
  });

  it("holds no rate-table figure as a literal in the medicines rules", () => {
    const dir = fileURLToPath(new URL(".", import.meta.url));
    const rows = readRateTable();
    // Every figure of two digits or more the medicines rules read (single digits are too common
    // in ordinary code to scan for; their rules are tested against the table instead).
    const values = [
      ...new Set(
        Object.values(MEDICINES_RATE_KEYS)
          .map((key) => String(rows.find((r) => r.key === key && r.validTo === null)?.value ?? ""))
          .filter((v) => v.length >= 2),
      ),
    ];
    expect(values).toContain(String(days));
    for (const file of readdirSync(dir).filter(
      (f) => f.endsWith(".ts") && !f.endsWith(".test.ts"),
    )) {
      const code = readFileSync(`${dir}${file}`, "utf8").replace(/\/\/.*|\/\*[\s\S]*?\*\//g, "");
      for (const value of values) {
        expect(code, `${file}: ${value}`).not.toMatch(new RegExp(`\\b${value}\\b`));
      }
    }
  });

  it("runs a cycle from 00:00 UK time on its first day for the table's number of days", () => {
    expect(november.startsOn).toBe("2026-11-02");
    expect(november.days).toBe(days);
    expect(november.from).toEqual(fromUkWallClock(2026, 11, 2, 0, 0));
    expect((november.to.getTime() - november.from.getTime()) / 86_400_000).toBe(days);
    expect(november.endsOn).toBe(
      formatUkDate(new Date(november.to.getTime() - 1))
        .split("/")
        .reverse()
        .join("-"),
    );
  });

  it("finds the cycle containing a date from the tenant's cycle start, either side of it", () => {
    expect(marCycleContaining("2026-11-02", "2026-11-02", rates).startsOn).toBe("2026-11-02");
    expect(marCycleContaining("2026-11-02", november.endsOn, rates).startsOn).toBe("2026-11-02");
    const next = marCycleContaining("2026-11-02", formatIso(november.to), rates);
    expect(next.from).toEqual(november.to);
    const before = marCycleContaining("2026-11-02", "2026-11-01", rates);
    expect(before.to).toEqual(november.from);
  });

  it("refuses a date that does not exist or a cycle of no days", () => {
    expect(() => marCycle("2026-02-30", rates)).toThrow(RangeError);
    expect(() => marCycle("02/11/2026", rates)).toThrow(RangeError);
    expect(() => marCycle("2026-11-02", { orderingCycleDays: 0 })).toThrow(RangeError);
  });
});

function formatIso(instant: Date): string {
  return formatUkDate(instant).split("/").reverse().join("-");
}

describe("hazard HZ-003 expands every supported frequency into the correct doses across a 28-day cycle", () => {
  it.each<[string, SchedulePattern, string[], number, string, string]>([
    [
      "every day, twice",
      { kind: "every_day" },
      ["08:00", "20:00"],
      2 * days,
      "02/11/2026 08:00",
      "20:00",
    ],
    [
      "every other day",
      { kind: "every_n_days", intervalDays: 2, anchorOn: "2026-11-02" },
      ["08:00"],
      Math.ceil(days / 2),
      "02/11/2026 08:00",
      "08:00",
    ],
    [
      "every 3 days",
      { kind: "every_n_days", intervalDays: 3, anchorOn: "2026-11-02" },
      ["09:00"],
      Math.ceil(days / 3),
      "02/11/2026 09:00",
      "09:00",
    ],
    [
      "weekly on Monday",
      { kind: "weekly", weekdays: ["mon"], intervalWeeks: 1, anchorOn: "2026-11-02" },
      ["07:00"],
      days / 7,
      "02/11/2026 07:00",
      "07:00",
    ],
    [
      "weekly on Monday and Thursday",
      { kind: "weekly", weekdays: ["thu", "mon"], intervalWeeks: 1, anchorOn: "2026-11-02" },
      ["07:00"],
      (2 * days) / 7,
      "02/11/2026 07:00",
      "07:00",
    ],
    [
      "fortnightly on Wednesday",
      { kind: "weekly", weekdays: ["wed"], intervalWeeks: 2, anchorOn: "2026-11-02" },
      ["10:00"],
      Math.ceil(days / 14),
      "04/11/2026 10:00",
      "10:00",
    ],
    [
      "monthly on the 15th",
      { kind: "monthly", dayOfMonth: 15 },
      ["08:00"],
      1,
      "15/11/2026 08:00",
      "08:00",
    ],
  ])("%s", (_name, pattern, times, count, first, lastTime) => {
    const doses = expandSchedule(schedule(pattern, at(...times)), fromStart, november);
    expect(doses).toHaveLength(count);
    expect(uk(doses[0] as MarDose)).toBe(first);
    expect(formatUkTime((doses.at(-1) as MarDose).dueAt)).toBe(lastTime);
    for (const dose of doses) {
      expect(dose.dueAt.getTime()).toBeGreaterThanOrEqual(november.from.getTime());
      expect(dose.dueAt.getTime()).toBeLessThan(november.to.getTime());
      expect(formatUkTime(dose.dueAt)).toBe(dose.time);
      expect(dose.clockChange).toBeNull();
    }
    const sorted = [...doses].sort((a, b) => a.dueAt.getTime() - b.dueAt.getTime());
    expect(doses).toEqual(sorted);
  });

  it.each([
    ["2026-11-02", ["04/11/2026 08:00", "06/11/2026 08:00", "08/11/2026 08:00"]],
    ["2026-11-03", ["05/11/2026 08:00", "07/11/2026 08:00", "09/11/2026 08:00"]],
  ])(
    "hazard HZ-003 counts every other day from its anchor %s, never from when the entry starts",
    (anchorOn, first) => {
      const startsAt = fromUkWallClock(2026, 11, 3, 12, 0);
      const doses = expandSchedule(
        schedule({ kind: "every_n_days", intervalDays: 2, anchorOn }),
        { startsAt, endsAt: null },
        november,
      );
      expect(doses.slice(0, 3).map(uk)).toEqual(first);
    },
  );

  it.each([
    ["2026-11-09", ["13/11/2026 08:00", "23/11/2026 08:00", "27/11/2026 08:00"]],
    ["2026-11-02", ["16/11/2026 08:00", "20/11/2026 08:00"]],
  ])(
    "hazard HZ-003 counts fortnights from the week of its anchor %s, never from when the entry starts",
    (anchorOn, doses) => {
      const startsAt = fromUkWallClock(2026, 11, 10, 9, 0);
      const pattern: SchedulePattern = {
        kind: "weekly",
        weekdays: ["mon", "fri"],
        intervalWeeks: 2,
        anchorOn,
      };
      expect(
        expandSchedule(schedule(pattern), { startsAt, endsAt: null }, november).map(uk),
      ).toEqual(doses);
    },
  );

  it.each<[string, string | null, SchedulePattern, boolean]>([
    [
      "no earlier dose",
      null,
      { kind: "every_n_days", intervalDays: 3, anchorOn: "2026-11-03" },
      true,
    ],
    ["every day", "2026-11-02", { kind: "every_day" }, true],
    [
      "every 3 days on the grid",
      "2026-11-02",
      { kind: "every_n_days", intervalDays: 3, anchorOn: "2026-11-08" },
      true,
    ],
    [
      "every 3 days off the grid",
      "2026-11-02",
      { kind: "every_n_days", intervalDays: 3, anchorOn: "2026-11-03" },
      false,
    ],
    [
      "every 4 days from every 3",
      "2026-11-02",
      { kind: "every_n_days", intervalDays: 4, anchorOn: "2026-11-03" },
      false,
    ],
    [
      "fortnightly Monday kept",
      "2026-11-02",
      { kind: "weekly", weekdays: ["mon"], intervalWeeks: 2, anchorOn: "2026-11-16" },
      true,
    ],
    [
      "fortnightly Monday moved to Tuesday (due again the next day)",
      "2026-11-02",
      { kind: "weekly", weekdays: ["tue"], intervalWeeks: 2, anchorOn: "2026-11-02" },
      false,
    ],
    [
      "fortnightly moved a week",
      "2026-11-02",
      { kind: "weekly", weekdays: ["mon"], intervalWeeks: 2, anchorOn: "2026-11-09" },
      false,
    ],
    [
      "weekly Monday moved to Tuesday",
      "2026-11-02",
      { kind: "weekly", weekdays: ["tue"], intervalWeeks: 1, anchorOn: "2026-11-03" },
      false,
    ],
    [
      "weekly Monday kept, Thursday added",
      "2026-11-02",
      { kind: "weekly", weekdays: ["mon", "thu"], intervalWeeks: 1, anchorOn: "2026-11-02" },
      true,
    ],
    ["monthly day moved", "2026-11-15", { kind: "monthly", dayOfMonth: 16 }, false],
    ["monthly day kept", "2026-11-15", { kind: "monthly", dayOfMonth: 15 }, true],
    [
      "an unreadable anchor",
      "2026-11-02",
      { kind: "every_n_days", intervalDays: 3, anchorOn: "" },
      false,
    ],
    [
      "an anchor missing altogether",
      "2026-11-02",
      { kind: "every_n_days", intervalDays: 3 } as unknown as SchedulePattern,
      false,
    ],
  ])(
    "hazard HZ-003 the count is kept from the last dose due: %s",
    (_name, lastDueOn, pattern, kept) => {
      expect(keepsCountFrom(lastDueOn, pattern)).toBe(kept);
    },
  );

  it("refuses a missing or unreadable anchor instead of throwing", () => {
    const missing = { kind: "every_n_days", intervalDays: 3 } as unknown as SchedulePattern;
    expect(checkSchedule(schedule(missing), [UNIT.tablet]).map((i) => i.problem)).toEqual([
      "bad_anchor",
    ]);
    expect(describeSchedule(schedule(missing))).toContain("no recorded day to count from");
    const fortnight = {
      kind: "weekly",
      weekdays: ["mon"],
      intervalWeeks: 2,
      anchorOn: "x",
    } as SchedulePattern;
    expect(describeSchedule(schedule(fortnight))).toContain("no recorded week to count from");
  });

  it("starts at the time the medicine starts and ends before it stops", () => {
    const startsAt = fromUkWallClock(2026, 11, 10, 14, 0);
    const endsAt = fromUkWallClock(2026, 11, 12, 8, 0);
    const doses = expandSchedule(
      schedule({ kind: "every_day" }, at("08:00", "20:00")),
      { startsAt, endsAt },
      november,
    );
    expect(doses.map(uk)).toEqual(["10/11/2026 20:00", "11/11/2026 08:00", "11/11/2026 20:00"]);
  });

  it("keeps each time's own dose", () => {
    const doses = expandSchedule(
      schedule({ kind: "every_day" }, [
        { time: "20:00", dose: one },
        { time: "08:00", dose: two },
      ]),
      fromStart,
      { from: november.from, to: fromUkWallClock(2026, 11, 3, 0, 0) },
    );
    expect(doses.map((d) => [d.time, d.dose])).toEqual([
      ["08:00", two],
      ["20:00", one],
    ]);
  });

  it("gives nothing outside the period the medicine is in force", () => {
    const endsAt = november.from;
    expect(
      expandSchedule(schedule({ kind: "every_day" }), { startsAt: new Date(0), endsAt }, november),
    ).toEqual([]);
  });

  it("puts a monthly dose on the last day of a shorter month and says so", () => {
    const october = marCycle("2026-10-05", rates);
    const pattern: SchedulePattern = { kind: "monthly", dayOfMonth: 31 };
    const inOctober = expandSchedule(
      schedule(pattern),
      { startsAt: october.from, endsAt: null },
      october,
    );
    expect(inOctober.map((d) => [d.date, d.lastDayOfShorterMonth])).toEqual([
      ["2026-10-31", false],
    ]);
    const monthEnd = marCycle("2026-11-16", rates);
    const inNovember = expandSchedule(schedule(pattern), fromStart, monthEnd);
    expect(inNovember.map((d) => [d.date, d.lastDayOfShorterMonth])).toEqual([
      ["2026-11-30", true],
    ]);
  });
});

describe("hazard HZ-005 non-daily schedules show the day on every MAR row", () => {
  it.each<[string, SchedulePattern]>([
    ["every other day", { kind: "every_n_days", intervalDays: 2, anchorOn: "2026-11-02" }],
    [
      "weekly",
      { kind: "weekly", weekdays: ["mon", "thu"], intervalWeeks: 1, anchorOn: "2026-11-02" },
    ],
    [
      "fortnightly",
      { kind: "weekly", weekdays: ["wed"], intervalWeeks: 2, anchorOn: "2026-11-02" },
    ],
    ["monthly", { kind: "monthly", dayOfMonth: 15 }],
  ])("%s: every dose names its day", (_name, pattern) => {
    const doses = expandSchedule(schedule(pattern), fromStart, november);
    expect(doses.length).toBeGreaterThan(0);
    for (const dose of doses) {
      expect(dose.dayName).toBe(WEEKDAY_NAMES[dose.weekday]);
      const weekday = new Intl.DateTimeFormat("en-GB", {
        weekday: "long",
        timeZone: "Europe/London",
      });
      expect(dose.dayName).toBe(weekday.format(dose.dueAt));
    }
  });

  it("a daily medicine's rows need no day", () => {
    for (const dose of expandSchedule(schedule({ kind: "every_day" }), fromStart, november)) {
      expect(dose.dayName).toBeNull();
    }
  });

  it.each<[SchedulePattern, string]>([
    [{ kind: "every_day" }, "2 tablets every day at 08:00 and 20:00"],
    [
      { kind: "weekly", weekdays: ["thu", "mon"], intervalWeeks: 1, anchorOn: "2026-11-02" },
      "2 tablets every Monday and Thursday at 08:00 and 20:00",
    ],
    [
      { kind: "weekly", weekdays: ["wed"], intervalWeeks: 2, anchorOn: "2026-11-02" },
      "2 tablets every other week on Wednesday at 08:00 and 20:00, counting from the week of 02/11/2026",
    ],
    [
      { kind: "weekly", weekdays: ["sun"], intervalWeeks: 4, anchorOn: "2026-11-02" },
      "2 tablets every 4 weeks on Sunday at 08:00 and 20:00, counting from the week of 02/11/2026",
    ],
    [
      { kind: "every_n_days", intervalDays: 2, anchorOn: "2026-11-02" },
      "2 tablets every other day at 08:00 and 20:00, counting from Monday 02/11/2026",
    ],
    [
      { kind: "every_n_days", intervalDays: 3, anchorOn: "2026-11-02" },
      "2 tablets every 3 days at 08:00 and 20:00, counting from Monday 02/11/2026",
    ],
    [{ kind: "monthly", dayOfMonth: 1 }, "2 tablets once a month on day 1 at 08:00 and 20:00"],
    [
      { kind: "monthly", dayOfMonth: 30 },
      "2 tablets once a month on day 30 at 08:00 and 20:00 (the last day of a shorter month)",
    ],
  ])("%o reads %s", (pattern, words) => {
    const times = [
      { time: "20:00", dose: two },
      { time: "08:00", dose: two },
    ];
    expect(describeSchedule({ pattern, times })).toBe(words);
  });

  it("gives each time's dose when they differ", () => {
    const times = [
      { time: "08:00", dose: two },
      { time: "20:00", dose: one },
    ];
    expect(
      describeSchedule({
        pattern: { kind: "weekly", weekdays: ["mon"], intervalWeeks: 1, anchorOn: "2026-11-02" },
        times,
      }),
    ).toBe("Every Monday: 08:00 2 tablets; 20:00 1 tablet");
    expect(
      describeSchedule({
        pattern: { kind: "every_n_days", intervalDays: 2, anchorOn: "2026-11-02" },
        times,
      }),
    ).toBe("Every other day, counting from Monday 02/11/2026: 08:00 2 tablets; 20:00 1 tablet");
  });
});

/** The four transitions the hazard log names. */
const SPRING = [
  [2026, 3, 29],
  [2027, 3, 28],
] as const;
const AUTUMN = [
  [2026, 10, 25],
  [2027, 10, 31],
] as const;
const daily = (time: string) => schedule({ kind: "every_day" }, at(time));
/** 00:00 UK time on the day `offset` days after a date (UTC calendar arithmetic, never overflowing). */
const ukMidnight = (y: number, m: number, d: number, offset: number) => {
  const day = new Date(Date.UTC(y, m - 1, d + offset));
  return fromUkWallClock(day.getUTCFullYear(), day.getUTCMonth() + 1, day.getUTCDate(), 0, 0);
};
const aroundDay = (y: number, m: number, d: number) => ({
  from: ukMidnight(y, m, d, -1),
  to: ukMidnight(y, m, d, 2),
});
const always = { startsAt: new Date("2026-01-01T00:00:00Z"), endsAt: null };

describe("hazard HZ-009 a 01:30 dose on a spring-forward day moves to 02:30 BST and is flagged", () => {
  it.each(SPRING)("%d-%d-%d", (y, m, d) => {
    const doses = expandSchedule(daily("01:30"), always, aroundDay(y, m, d));
    expect(doses).toHaveLength(3);
    const [before, change, after] = doses as [MarDose, MarDose, MarDose];
    expect(change.time).toBe("01:30");
    expect(formatUkTime(change.dueAt)).toBe("02:30");
    expect(change.dueAt.toISOString()).toBe(`${y}-0${m}-${d}T01:30:00.000Z`);
    expect(change.clockChange).toBe("time_skipped");
    expect([before.clockChange, after.clockChange]).toEqual([null, null]);
    expect(formatUkTime(before.dueAt)).toBe("01:30");
    expect(formatUkTime(after.dueAt)).toBe("01:30");
  });

  it.each(SPRING)(
    "a time moved onto another prescribed time keeps both doses, flagged, on %d-%d-%d",
    (y, m, d) => {
      const doses = expandSchedule(schedule({ kind: "every_day" }, at("02:30", "01:30")), always, {
        from: ukMidnight(y, m, d, 0),
        to: ukMidnight(y, m, d, 1),
      });
      expect(doses.map((x) => [x.time, formatUkTime(x.dueAt), x.sameInstantAs])).toEqual([
        ["01:30", "02:30", "02:30"],
        ["02:30", "02:30", "01:30"],
      ]);
    },
  );
});

describe("hazard HZ-009 a 01:30 dose on a clocks-back day occurs once", () => {
  it.each(AUTUMN)("%d-%d-%d", (y, m, d) => {
    const doses = expandSchedule(daily("01:30"), always, aroundDay(y, m, d));
    const onTheDay = doses.filter((x) => x.date === `${y}-${m}-${d}`);
    expect(onTheDay).toHaveLength(1);
    const [dose] = onTheDay as [MarDose];
    expect(dose.dueAt.toISOString()).toBe(`${y}-${m}-${d}T00:30:00.000Z`);
    expect(dose.clockChange).toBe("time_repeated");
    expect(doses).toHaveLength(3);
  });
});

describe("hazard HZ-009 every-n-days and fortnightly doses keep their days and times across the clock changes", () => {
  it.each([...SPRING, ...AUTUMN])(
    "every 2 days at 01:30, and fortnightly on Sunday at 08:00, around %d-%d-%d",
    (y, m, d) => {
      const anchorOn = new Date(Date.UTC(y, m - 1, d - 4)).toISOString().slice(0, 10);
      const window = { from: ukMidnight(y, m, d, -4), to: ukMidnight(y, m, d, 5) };
      const everyOther = expandSchedule(
        schedule({ kind: "every_n_days", intervalDays: 2, anchorOn }, at("01:30")),
        always,
        window,
      );
      expect(everyOther.map((x) => x.time)).toEqual(Array(everyOther.length).fill("01:30"));
      const days = everyOther.map((x) => Date.parse(`${x.date}T00:00:00Z`));
      for (let i = 1; i < days.length; i++)
        expect((days[i] as number) - (days[i - 1] as number)).toBe(2 * 86_400_000);
      const onTheDay = everyOther.find(
        (x) => x.date === new Date(Date.UTC(y, m - 1, d)).toISOString().slice(0, 10),
      );
      expect(onTheDay?.clockChange).toBe(m === 3 ? "time_skipped" : "time_repeated");
      const sundays = expandSchedule(
        schedule({ kind: "weekly", weekdays: ["sun"], intervalWeeks: 2, anchorOn }, at("08:00")),
        always,
        { from: ukMidnight(y, m, d, -14), to: ukMidnight(y, m, d, 15) },
      );
      expect(sundays.map((x) => formatUkTime(x.dueAt))).toEqual(
        Array(sundays.length).fill("08:00"),
      );
      for (let i = 1; i < sundays.length; i++) {
        const gap =
          ((sundays[i] as MarDose).dueAt.getTime() - (sundays[i - 1] as MarDose).dueAt.getTime()) /
          3_600_000;
        expect([14 * 24 - 1, 14 * 24, 14 * 24 + 1]).toContain(gap);
      }
    },
  );
});

describe("hazard HZ-009 an 08:00 daily dose stays at 08:00 local time either side of each transition", () => {
  it.each([...SPRING, ...AUTUMN])("%d-%d-%d", (y, m, d) => {
    const doses = expandSchedule(daily("08:00"), always, aroundDay(y, m, d));
    expect(doses.map((x) => formatUkTime(x.dueAt))).toEqual(["08:00", "08:00", "08:00"]);
    expect(doses.every((x) => x.clockChange === null)).toBe(true);
    const [before, change] = doses as [MarDose, MarDose];
    const hours = (change.dueAt.getTime() - before.dueAt.getTime()) / 3_600_000;
    expect(hours).toBe(m === 3 ? 23 : 25);
  });

  it("the MAR names the days in a cycle when the clocks change", () => {
    expect(clockChangesIn(marCycleContaining("2026-11-02", "2026-10-25", rates))).toEqual([
      { date: "2026-10-25", change: "back" },
    ]);
    expect(clockChangesIn(marCycleContaining("2026-11-02", "2027-03-28", rates))).toEqual([
      { date: "2027-03-28", change: "forward" },
    ]);
    expect(clockChangesIn(november)).toEqual([]);
  });
});

describe("schedules a MAR entry can hold", () => {
  const permitted = [UNIT.tablet];
  it.each<[RegularSchedule, ScheduleProblem[]]>([
    [schedule({ kind: "every_day" }, []), ["no_times"]],
    [schedule({ kind: "every_day" }, at("8:00")), ["bad_time"]],
    [schedule({ kind: "every_day" }, at("24:00")), ["bad_time"]],
    [schedule({ kind: "every_day" }, at("08:00", "08:00")), ["duplicate_time"]],
    [schedule({ kind: "every_n_days", intervalDays: 1, anchorOn: "2026-11-02" }), ["bad_interval"]],
    [
      schedule({ kind: "every_n_days", intervalDays: 2.5, anchorOn: "2026-11-02" }),
      ["bad_interval"],
    ],
    [
      schedule({ kind: "weekly", weekdays: ["mon"], intervalWeeks: 0, anchorOn: "2026-11-02" }),
      ["bad_interval"],
    ],
    [
      schedule({ kind: "weekly", weekdays: [], intervalWeeks: 1, anchorOn: "2026-11-02" }),
      ["no_weekdays"],
    ],
    [
      schedule({
        kind: "weekly",
        weekdays: ["monday" as "mon"],
        intervalWeeks: 1,
        anchorOn: "2026-11-02",
      }),
      ["bad_weekday"],
    ],
    [schedule({ kind: "monthly", dayOfMonth: 0 }), ["bad_day_of_month"]],
    [schedule({ kind: "monthly", dayOfMonth: 32 }), ["bad_day_of_month"]],
    [
      schedule({ kind: "every_day" }, [
        { time: "08:00", dose: { kind: "amount", quantity: 5, unit: UNIT.ml } },
      ]),
      ["unit_not_permitted"],
    ],
    [schedule({ kind: "every_n_days", intervalDays: 2, anchorOn: "02/11/2026" }), ["bad_anchor"]],
    [
      schedule({ kind: "weekly", weekdays: ["mon"], intervalWeeks: 2, anchorOn: "2026-02-30" }),
      ["bad_anchor"],
    ],
    [schedule({ kind: "every_n_days", intervalDays: 2, anchorOn: "2026-11-02" }), []],
  ])("%o has problems %o", (s, problems) => {
    expect(checkSchedule(s, permitted).map((i) => i.problem)).toEqual(problems);
  });

  it("names the time a dose problem is at", () => {
    const s = schedule({ kind: "every_day" }, [
      { time: "08:00", dose: one },
      { time: "20:00", dose: { kind: "amount", quantity: 0, unit: UNIT.tablet } },
    ]);
    expect(checkSchedule(s, permitted)).toEqual([
      expect.objectContaining({ problem: "not_a_dose_quantity", time: "20:00" }),
    ]);
  });

  it("refuses to expand a schedule it cannot read", () => {
    expect(() =>
      expandSchedule(schedule({ kind: "every_day" }, at("8am")), fromStart, november),
    ).toThrow(RangeError);
  });
});
