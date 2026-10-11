import { describe, expect, it } from "vitest";
import {
  isValidWindowDays,
  MAX_OFFLINE_WINDOW_DAYS,
  nextWindowChange,
  OFFLINE_DAYS_CLAIM,
  offlineWindowDays,
} from "../src/client/window";

/** The offline window carried in the `offline_days` sync token claim (ADR-0011). */
describe("offlineWindowDays", () => {
  it.each([
    // [now, window days, expected UTC days newest first]
    ["2026-10-11T09:00:00Z", 1, ["2026-10-12", "2026-10-11"]],
    ["2026-10-11T09:00:00Z", 3, ["2026-10-12", "2026-10-11", "2026-10-10", "2026-10-09"]],
    // 00:30 in London during British Summer Time is still the previous day in UTC.
    ["2026-10-10T23:30:00Z", 2, ["2026-10-11", "2026-10-10", "2026-10-09"]],
    // Across a month and a year end.
    ["2027-01-01T00:00:00Z", 3, ["2027-01-02", "2027-01-01", "2026-12-31", "2026-12-30"]],
    // Across the clock change (25 October 2026): UTC days have no gaps or repeats.
    ["2026-10-26T08:00:00Z", 3, ["2026-10-27", "2026-10-26", "2026-10-25", "2026-10-24"]],
    // Leap day.
    ["2028-03-01T12:00:00Z", 2, ["2028-03-02", "2028-03-01", "2028-02-29"]],
  ] as const)("at %s with %i days gives %j", (now, days, expected) => {
    expect(offlineWindowDays(new Date(now), days)).toEqual(expected);
  });

  it("holds tomorrow plus the window, so nothing older than the window stays", () => {
    const days = offlineWindowDays(new Date("2026-10-11T12:00:00Z"), 7);
    expect(days).toHaveLength(8);
    expect(days.at(-1)).toBe("2026-10-05");
    expect(new Set(days).size).toBe(days.length);
  });

  it.each([0, -1, 1.5, Number.NaN, MAX_OFFLINE_WINDOW_DAYS + 1])(
    "refuses a window of %s days rather than guessing",
    (days) => {
      expect(() => offlineWindowDays(new Date("2026-10-11T12:00:00Z"), days)).toThrow(RangeError);
    },
  );

  it("refuses an invalid clock", () => {
    expect(() => offlineWindowDays(new Date("not a date"), 7)).toThrow(RangeError);
  });
});

describe("isValidWindowDays", () => {
  it.each([
    [1, true],
    [7, true],
    [MAX_OFFLINE_WINDOW_DAYS, true],
    [0, false],
    ["7", false],
    [null, false],
    [7.2, false],
  ])("%j -> %s", (value, expected) => {
    expect(isValidWindowDays(value)).toBe(expected);
  });
});

describe("the offline_days claim", () => {
  it("is the token claim the streams read", () => {
    expect(OFFLINE_DAYS_CLAIM).toBe("offline_days");
    expect(offlineWindowDays(new Date("2026-10-11T12:00:00Z"), 1)).toEqual([
      "2026-10-12",
      "2026-10-11",
    ]);
  });
});

describe("nextWindowChange", () => {
  it.each([
    ["2026-10-11T09:00:00Z", "2026-10-12T00:00:00.000Z"],
    ["2026-10-11T00:00:00Z", "2026-10-12T00:00:00.000Z"],
    ["2026-12-31T23:59:59Z", "2027-01-01T00:00:00.000Z"],
  ])("after %s is %s", (now, expected) => {
    expect(nextWindowChange(new Date(now)).toISOString()).toBe(expected);
  });
});
