import { describe, expect, it } from "vitest";
import { UK_TIME_ZONE } from "../shared/time";
import { type FluidDayInput, type FluidEntry, fluidDaySummary, ukDayBounds } from "./fluid-balance";

/** Fluid balance day totals in the location's time zone (hazard HZ-009 for the clock changes). */

const intake = (iso: string, volumeMl: number): FluidEntry => ({
  occurredAt: new Date(iso),
  kind: "intake",
  volumeMl,
});
const output = (iso: string, volumeMl: number): FluidEntry => ({
  occurredAt: new Date(iso),
  kind: "output",
  volumeMl,
});

function summary(input: Partial<FluidDayInput>) {
  const outcome = fluidDaySummary({
    date: "2026-10-11",
    timeZone: UK_TIME_ZONE,
    entries: [],
    targetMl: null,
    ...input,
  });
  if (!outcome.ok) throw new Error(JSON.stringify(outcome.issues));
  return outcome.summary;
}

describe("hazard HZ-009 fluid balance days run from 00:00 to 24:00 UK time", () => {
  it.each([
    ["a summer day", "2026-10-11", "2026-10-10T23:00:00.000Z", "2026-10-11T23:00:00.000Z", 24],
    ["a winter day", "2026-12-01", "2026-12-01T00:00:00.000Z", "2026-12-02T00:00:00.000Z", 24],
    [
      "spring forward is 23 hours",
      "2026-03-29",
      "2026-03-29T00:00:00.000Z",
      "2026-03-29T23:00:00.000Z",
      23,
    ],
    [
      "autumn back is 25 hours",
      "2026-10-25",
      "2026-10-24T23:00:00.000Z",
      "2026-10-26T00:00:00.000Z",
      25,
    ],
  ])("%s", (_name, date, startsAt, endsAt, hours) => {
    const day = summary({ date });
    expect(day.startsAt.toISOString()).toBe(startsAt);
    expect(day.endsAt.toISOString()).toBe(endsAt);
    expect(day.hoursInDay).toBe(hours);
    expect(ukDayBounds(date).startsAt.toISOString()).toBe(startsAt);
  });

  it("counts every entry of the 25-hour day and none from the days either side", () => {
    const day = summary({
      date: "2026-10-25",
      entries: [
        intake("2026-10-24T22:59:00Z", 1000), // 23:59 BST on the 24th
        intake("2026-10-24T23:00:00Z", 100), // 00:00 BST on the 25th
        intake("2026-10-25T00:30:00Z", 200), // 01:30 BST, first pass
        intake("2026-10-25T01:30:00Z", 300), // 01:30 GMT, second pass
        intake("2026-10-25T23:59:00Z", 400), // 23:59 GMT on the 25th
        intake("2026-10-26T00:00:00Z", 1000), // 00:00 on the 26th
      ],
    });
    expect(day.intakeMl).toBe(1000);
    expect(day.entriesCounted).toBe(4);
  });

  it("counts the 23-hour day without losing the skipped hour's neighbours", () => {
    const day = summary({
      date: "2026-03-29",
      entries: [
        intake("2026-03-29T00:59:00Z", 150), // 00:59 GMT
        intake("2026-03-29T01:00:00Z", 250), // 02:00 BST
        intake("2026-03-29T22:59:00Z", 350), // 23:59 BST
        intake("2026-03-29T23:00:00Z", 1000), // 00:00 BST on the 30th
      ],
    });
    expect(day.intakeMl).toBe(750);
  });
});

describe("fluid balance totals and target", () => {
  const entries = [
    intake("2026-10-11T07:00:00Z", 200),
    intake("2026-10-11T11:00:00Z", 300),
    output("2026-10-11T12:00:00Z", 250),
    intake("2026-10-11T17:00:00Z", 400),
  ];

  it("totals intake and output and shows the balance", () => {
    expect(summary({ entries })).toMatchObject({ intakeMl: 900, outputMl: 250, balanceMl: 650 });
  });

  it("reports no target rather than inventing one", () => {
    expect(summary({ entries }).target).toEqual({ status: "no_target" });
  });

  it.each([
    ["short of the target", 1500, 600, false],
    ["exactly at the target", 900, 0, true],
    ["over the target", 800, 0, true],
  ])("%s", (_name, targetMl, shortfallMl, met) => {
    expect(summary({ entries, targetMl }).target).toEqual({
      status: "target_set",
      targetMl,
      shortfallMl,
      met,
    });
  });

  it("shows the shortfall so far by mid-afternoon", () => {
    const day = summary({ entries, targetMl: 1500, asAt: new Date("2026-10-11T14:00:00Z") });
    expect(day.intakeMl).toBe(500);
    expect(day.target).toMatchObject({ shortfallMl: 1000, met: false });
  });

  it.each([
    ["a volume of 0", { entries: [intake("2026-10-11T07:00:00Z", 0)] }, "entries.0.volumeMl"],
    ["a negative volume", { entries: [intake("2026-10-11T07:00:00Z", -50)] }, "entries.0.volumeMl"],
    [
      "a fractional volume",
      { entries: [intake("2026-10-11T07:00:00Z", 12.5)] },
      "entries.0.volumeMl",
    ],
    ["a target of 0", { targetMl: 0 }, "targetMl"],
    ["a date that does not exist", { date: "2026-13-01" }, "date"],
  ] as const)("refuses %s", (_name, input, item) => {
    const outcome = fluidDaySummary({
      date: "2026-10-11",
      timeZone: UK_TIME_ZONE,
      entries: [],
      targetMl: null,
      ...input,
    });
    expect(outcome).toMatchObject({ ok: false, issues: [{ item }] });
  });

  const refusedDrink = (iso: string, volumeMl: number): FluidEntry => ({
    ...intake(iso, volumeMl),
    refused: true,
  });

  // #26 review round 3: a drink offered and refused was not taken, so it never hides a shortfall.
  it.each([
    {
      name: "a refused drink adds nothing to the intake and is reported as offered",
      entries: [intake("2026-10-11T07:00:00Z", 200), refusedDrink("2026-10-11T09:00:00Z", 250)],
      intakeMl: 200,
      shortfallMl: 1300,
      entriesCounted: 1,
      refusedEntries: 1,
      refusedOfferedMl: 250,
    },
    {
      name: "every drink refused leaves the whole target short",
      entries: [
        refusedDrink("2026-10-11T07:00:00Z", 200),
        refusedDrink("2026-10-11T12:00:00Z", 300),
      ],
      intakeMl: 0,
      shortfallMl: 1500,
      entriesCounted: 0,
      refusedEntries: 2,
      refusedOfferedMl: 500,
    },
    {
      name: "a drink not refused counts in full",
      entries: [intake("2026-10-11T07:00:00Z", 1500)],
      intakeMl: 1500,
      shortfallMl: 0,
      entriesCounted: 1,
      refusedEntries: 0,
      refusedOfferedMl: 0,
    },
    {
      name: "a refused drink outside the day is neither counted nor offered",
      entries: [refusedDrink("2026-10-10T22:30:00Z", 400), intake("2026-10-11T07:00:00Z", 100)],
      intakeMl: 100,
      shortfallMl: 1400,
      entriesCounted: 1,
      refusedEntries: 0,
      refusedOfferedMl: 0,
    },
  ])(
    "$name",
    ({ entries, intakeMl, shortfallMl, entriesCounted, refusedEntries, refusedOfferedMl }) => {
      const day = summary({ entries, targetMl: 1500 });
      expect(day).toMatchObject({ intakeMl, entriesCounted, refusedEntries, refusedOfferedMl });
      expect(day.target).toMatchObject({ shortfallMl, met: shortfallMl === 0 });
    },
  );

  it("refuses to compute the bounds of a day that does not exist", () => {
    expect(() => ukDayBounds("2026-02-30")).toThrow(RangeError);
  });
});
