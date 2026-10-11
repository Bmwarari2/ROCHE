import { describe, expect, it } from "vitest";
import {
  addUkDays,
  clockDriftMinutes,
  formatUkDate,
  formatUkDateTime,
  formatUkTime,
  fromUkWallClock,
  hasClockDrift,
  toUkWallClock,
  ukOffsetMinutes,
} from "./time";

/** Hazard HZ-009: time-zone and daylight-saving errors. 2026 clocks change on 29 March and 25 October. */

describe("UK formatting", () => {
  it.each([
    ["2026-10-11T09:05:00Z", "11/10/2026", "10:05"],
    ["2026-12-25T23:30:00Z", "25/12/2026", "23:30"],
    ["2026-06-30T23:30:00Z", "01/07/2026", "00:30"],
  ])("%s -> %s %s", (iso, date, time) => {
    const instant = new Date(iso);
    expect(formatUkDate(instant)).toBe(date);
    expect(formatUkTime(instant)).toBe(time);
    expect(formatUkDateTime(instant)).toBe(`${date} ${time}`);
  });
});

describe("UK offset", () => {
  it.each([
    ["2026-01-15T12:00:00Z", 0],
    ["2026-07-15T12:00:00Z", 60],
    ["2026-03-29T00:59:59Z", 0],
    ["2026-03-29T01:00:00Z", 60],
    ["2026-10-25T00:59:59Z", 60],
    ["2026-10-25T01:00:00Z", 0],
  ])("%s -> %s minutes", (iso, offset) => {
    expect(ukOffsetMinutes(new Date(iso))).toBe(offset);
  });
});

describe("fromUkWallClock", () => {
  it.each([
    ["winter", [2026, 1, 15, 8, 0], "2026-01-15T08:00:00.000Z"],
    ["summer", [2026, 7, 15, 8, 0], "2026-07-15T07:00:00.000Z"],
    ["spring-forward gap moves an hour later", [2026, 3, 29, 1, 30], "2026-03-29T01:30:00.000Z"],
    [
      "autumn overlap takes the first (BST) occurrence",
      [2026, 10, 25, 1, 30],
      "2026-10-25T00:30:00.000Z",
    ],
  ] as const)("%s", (_name, [y, m, d, h, min], expected) => {
    expect(fromUkWallClock(y, m, d, h, min).toISOString()).toBe(expected);
  });

  it("round-trips through the wall clock", () => {
    const instant = new Date("2026-08-01T16:45:00Z");
    const w = toUkWallClock(instant);
    expect(fromUkWallClock(w.year, w.month, w.day, w.hour, w.minute).toISOString()).toBe(
      instant.toISOString(),
    );
  });
});

describe("addUkDays keeps the wall-clock time across a clock change", () => {
  it.each([
    ["08:00 the day before spring forward", "2026-03-28T08:00:00Z", 1, "2026-03-29T07:00:00.000Z"],
    ["08:00 the day before autumn back", "2026-10-24T07:00:00Z", 1, "2026-10-25T08:00:00.000Z"],
    ["a week in winter", "2026-01-01T09:00:00Z", 7, "2026-01-08T09:00:00.000Z"],
  ])("%s", (_name, iso, days, expected) => {
    const next = addUkDays(new Date(iso), days);
    expect(next.toISOString()).toBe(expected);
    expect(formatUkTime(next)).toBe(formatUkTime(new Date(iso)));
  });
});

describe("clock drift (HZ-010)", () => {
  const server = new Date("2026-10-11T10:00:00Z");
  it.each([
    ["in step", "2026-10-11T10:00:30Z", false, 1],
    ["five minutes fast is tolerated", "2026-10-11T10:05:00Z", false, 5],
    ["six minutes fast is flagged", "2026-10-11T10:06:00Z", true, 6],
    ["ten minutes slow is flagged", "2026-10-11T09:50:00Z", true, -10],
  ])("%s", (_name, device, drift, minutes) => {
    expect(hasClockDrift(new Date(device), server)).toBe(drift);
    expect(clockDriftMinutes(new Date(device), server)).toBe(minutes);
  });

  it("accepts a custom tolerance", () => {
    expect(hasClockDrift(new Date("2026-10-11T10:02:00Z"), server, 1)).toBe(true);
  });
});
