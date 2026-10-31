import { describe, expect, it } from "vitest";
import { readRateTable } from "../../test/rate-table";
import { agencyAccessWindow, awrWeeksFromShifts, bookingCostPence } from "./agency";
import { awrClock } from "./pay/awr";
import { resolvePayRates } from "./pay/rates";

const at = (iso: string) => new Date(iso);

describe("what a booking costs", () => {
  it.each([
    [
      "a 12-hour day less 30 minutes at 2,500p an hour",
      "2026-11-02T08:00:00Z",
      "2026-11-02T20:00:00Z",
      30,
      2500,
      28750,
    ],
    ["no break", "2026-11-02T08:00:00Z", "2026-11-02T16:00:00Z", 0, 1999, 15992],
    ["rounded to the nearest penny", "2026-11-02T08:00:00Z", "2026-11-02T08:07:00Z", 0, 1001, 117],
    ["a break longer than the shift", "2026-11-02T08:00:00Z", "2026-11-02T08:20:00Z", 60, 2000, 0],
  ] as const)("%s", (_, start, end, breakMinutes, rate, pence) => {
    expect(bookingCostPence(at(start), at(end), breakMinutes, rate)).toBe(pence);
  });

  it("charges the elapsed time of a night the clocks go back", () => {
    expect(bookingCostPence(at("2026-10-24T19:00:00Z"), at("2026-10-25T08:00:00Z"), 0, 1000)).toBe(
      13000,
    );
  });
});

describe("the AWR weeks from bookings (AWR 2010 reg 7)", () => {
  it("counts each calendar week with a shift once, and weeks between as breaks", () => {
    const weeks = awrWeeksFromShifts(
      [at("2026-11-02T08:00:00Z"), at("2026-11-04T08:00:00Z"), at("2026-11-17T08:00:00Z")],
      "2026-11-18",
    );
    expect(weeks).toEqual([
      { week: "2026-11-02", kind: "worked" },
      { week: "2026-11-09", kind: "break", reason: "none" },
      { week: "2026-11-16", kind: "worked" },
    ]);
  });

  it("puts a Sunday night in its own week (UK dates)", () => {
    expect(awrWeeksFromShifts([at("2026-11-08T20:00:00Z")], "2026-11-08")).toEqual([
      { week: "2026-11-02", kind: "worked" },
    ]);
  });

  it("runs the breaks on to the date asked", () => {
    expect(awrWeeksFromShifts([at("2026-11-02T08:00:00Z")], "2026-11-16").length).toBe(3);
  });

  it("gives no weeks without a booking", () => {
    expect(awrWeeksFromShifts([], "2026-11-16")).toEqual([]);
  });

  it("feeds the slice 6 clock: twelve weeks in a row qualify", () => {
    const rates = resolvePayRates(readRateTable(), "england", "2026-11-02", null);
    const starts = Array.from({ length: rates.awrQualifyingWeeks }, (_, i) =>
      at(new Date(Date.UTC(2026, 10, 2 + i * 7, 8)).toISOString()),
    );
    const clock = awrClock(awrWeeksFromShifts(starts, "2026-11-02"), rates);
    expect(clock.qualifyingWeeks).toBe(rates.awrQualifyingWeeks);
    expect(clock.qualifiedFromWeek).not.toBeNull();
  });
});

describe("the access window a booked shift opens (ADR-0088)", () => {
  const day = { start: at("2026-11-02T08:00:00Z"), end: at("2026-11-02T20:00:00Z") };
  it.each([
    ["before the shift", "2026-11-02T07:59:00Z", null],
    ["at the start", "2026-11-02T08:00:00Z", "2026-11-02T22:00:00.000Z"],
    ["in the hours after", "2026-11-02T21:59:00Z", "2026-11-02T22:00:00.000Z"],
    ["when the hours after are over", "2026-11-02T22:00:00Z", null],
  ] as const)("%s", (_, now, until) => {
    const window = agencyAccessWindow([day], at(now), 2);
    expect(window?.end.toISOString() ?? null).toBe(until);
  });

  it("takes the longest of back-to-back shifts", () => {
    const night = { start: at("2026-11-02T20:00:00Z"), end: at("2026-11-03T08:00:00Z") };
    expect(agencyAccessWindow([day, night], at("2026-11-02T21:00:00Z"), 2)?.end.toISOString()).toBe(
      "2026-11-03T10:00:00.000Z",
    );
  });

  it("gives nothing with no booking", () => {
    expect(agencyAccessWindow([], at("2026-11-02T12:00:00Z"), 2)).toBeNull();
  });
});
