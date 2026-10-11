import { describe, expect, it } from "vitest";
import {
  addUkDays,
  addUkMonths,
  clockDriftMinutes,
  formatUkDate,
  formatUkDateTime,
  formatUkTime,
  fromUkWallClock,
  hasClockDrift,
  isUkClockChangeDay,
  resolveRecordedUkTime,
  toUkWallClock,
  ukEndOfDay,
  ukOffsetMinutes,
  ukStartOfDay,
  ukWallClockOccurrences,
  ukZoneAbbreviation,
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

describe("hazard HZ-009 UK offset", () => {
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

describe("hazard HZ-009 fromUkWallClock", () => {
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

describe("hazard HZ-009 addUkDays keeps the wall-clock time across a clock change", () => {
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

describe("hazard HZ-009 addUkMonths and dated periods in UK time", () => {
  it.each([
    [
      "a year from 1 October across the autumn change",
      "2026-09-30T23:00:00Z",
      12,
      "2027-09-30T23:00:00.000Z",
    ],
    [
      "a month from 31 January falls back to 28 February",
      "2027-01-31T10:00:00Z",
      1,
      "2027-02-28T10:00:00.000Z",
    ],
    [
      "a year from 29 February falls back to 28 February",
      "2028-02-29T12:00:00Z",
      12,
      "2029-02-28T12:00:00.000Z",
    ],
    [
      "a month across the spring change keeps 09:00",
      "2027-03-01T09:00:00Z",
      1,
      "2027-04-01T08:00:00.000Z",
    ],
  ])("%s", (_name, iso, months, expected) => {
    expect(addUkMonths(new Date(iso), months).toISOString()).toBe(expected);
  });

  it("refuses part months", () => {
    expect(() => addUkMonths(new Date("2026-10-11T09:00:00Z"), 1.5)).toThrow(RangeError);
  });

  it.each([
    ["2026-07-01", "2026-06-30T23:00:00.000Z", "2026-07-01T23:00:00.000Z"],
    ["2026-10-25", "2026-10-24T23:00:00.000Z", "2026-10-26T00:00:00.000Z"],
    ["2027-03-28", "2027-03-28T00:00:00.000Z", "2027-03-28T23:00:00.000Z"],
  ])("%s starts at %s and ends at %s UK midnight", (iso, start, end) => {
    expect(ukStartOfDay(iso).toISOString()).toBe(start);
    expect(ukEndOfDay(iso).toISOString()).toBe(end);
  });
});

describe("hazard HZ-010 clock drift", () => {
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

describe("hazard HZ-009 ukWallClockOccurrences on every minute of the clock-change days", () => {
  // Spring forward: 01:00-01:59 does not happen. Autumn back: 01:00-01:59 happens twice.
  it.each([
    [2026, 3, 29, "spring"],
    [2026, 10, 25, "autumn"],
    [2027, 3, 28, "spring"],
    [2027, 10, 31, "autumn"],
  ] as const)("%i-%i-%i (%s)", (year, month, day, change) => {
    for (let hour = 0; hour < 24; hour++) {
      for (let minute = 0; minute < 60; minute++) {
        const occurrences = ukWallClockOccurrences(year, month, day, hour, minute);
        const expected = hour !== 1 ? 1 : change === "spring" ? 0 : 2;
        expect(occurrences, `${hour}:${minute}`).toHaveLength(expected);
        for (const instant of occurrences) {
          expect(toUkWallClock(instant)).toMatchObject({ year, month, day, hour, minute });
        }
        if (expected === 2) {
          const [first, second] = occurrences as [Date, Date];
          expect(second.getTime() - first.getTime()).toBe(60 * 60_000);
          expect(ukZoneAbbreviation(first)).toBe("BST");
          expect(ukZoneAbbreviation(second)).toBe("GMT");
        }
      }
    }
  });

  it("keeps fromUkWallClock's rule for computed times: first occurrence, gap moves forward", () => {
    expect(fromUkWallClock(2026, 10, 25, 1, 30).toISOString()).toBe("2026-10-25T00:30:00.000Z");
    expect(fromUkWallClock(2026, 3, 29, 1, 30).toISOString()).toBe("2026-03-29T01:30:00.000Z");
  });
});

describe("hazards HZ-009, HZ-010 and HZ-017 resolveRecordedUkTime", () => {
  const at = (iso: string) => new Date(iso);
  const tolerance = 5;
  it.each([
    // [what, typed wall clock, now, expected]
    [
      "an ordinary past time",
      [2026, 7, 1, 14, 0],
      "2026-07-01T15:00:00Z",
      { kind: "exact", instant: "2026-07-01T13:00:00.000Z" },
    ],
    [
      "a winter past time",
      [2026, 1, 15, 9, 30],
      "2026-01-15T12:00:00Z",
      { kind: "exact", instant: "2026-01-15T09:30:00.000Z" },
    ],
    [
      "within the clock tolerance ahead",
      [2026, 7, 1, 11, 2],
      "2026-07-01T10:00:00Z",
      { kind: "exact", instant: "2026-07-01T10:02:00.000Z" },
    ],
    [
      "just beyond the tolerance ahead",
      [2026, 7, 1, 11, 6],
      "2026-07-01T10:00:00Z",
      { kind: "future", instant: "2026-07-01T10:06:00.000Z" },
    ],
    [
      "rounded up within the tolerance, kept today, not rolled back to yesterday",
      [2026, 10, 11, 14, 0],
      "2026-10-11T12:58:00Z",
      { kind: "exact", instant: "2026-10-11T13:00:00.000Z" },
    ],
    [
      "later today, refused, never rolled back to yesterday",
      [2026, 10, 11, 14, 0],
      "2026-10-11T12:50:00Z",
      { kind: "future", instant: "2026-10-11T13:00:00.000Z" },
    ],
    ["a spring gap time", [2026, 3, 29, 1, 30], "2026-03-29T12:00:00Z", { kind: "skipped" }],
    [
      "the first minute of the spring gap",
      [2027, 3, 28, 1, 0],
      "2027-03-28T12:00:00Z",
      { kind: "skipped" },
    ],
    [
      "02:00 after the spring change",
      [2026, 3, 29, 2, 0],
      "2026-03-29T12:00:00Z",
      { kind: "exact", instant: "2026-03-29T01:00:00.000Z" },
    ],
    [
      "an autumn repeat with both past",
      [2026, 10, 25, 1, 30],
      "2026-10-25T03:00:00Z",
      { kind: "ambiguous", earlier: "2026-10-25T00:30:00.000Z", later: "2026-10-25T01:30:00.000Z" },
    ],
    [
      "an autumn repeat with only BST past",
      [2026, 10, 25, 1, 30],
      "2026-10-25T01:00:00Z",
      { kind: "exact", instant: "2026-10-25T00:30:00.000Z" },
    ],
    [
      "an autumn repeat with neither past",
      [2026, 10, 25, 1, 30],
      "2026-10-25T00:10:00Z",
      { kind: "future", instant: "2026-10-25T00:30:00.000Z" },
    ],
    [
      "the 2027 autumn repeat",
      [2027, 10, 31, 1, 0],
      "2027-10-31T09:00:00Z",
      { kind: "ambiguous", earlier: "2027-10-31T00:00:00.000Z", later: "2027-10-31T01:00:00.000Z" },
    ],
    [
      "02:00 after the autumn change",
      [2026, 10, 25, 2, 0],
      "2026-10-25T09:00:00Z",
      { kind: "exact", instant: "2026-10-25T02:00:00.000Z" },
    ],
  ] as const)("%s", (_what, [year, month, day, hour, minute], now, expected) => {
    const result = resolveRecordedUkTime(
      { year, month, day, hour, minute },
      { now: at(now), futureToleranceMinutes: tolerance },
    );
    const plain = Object.fromEntries(
      Object.entries(result).map(([k, v]) => [k, v instanceof Date ? v.toISOString() : v]),
    );
    expect(plain).toEqual(expected);
  });

  it.each([
    [{ year: 2026, month: 13, day: 1, hour: 0, minute: 0 }],
    [{ year: 2026, month: 2, day: 29, hour: 0, minute: 0 }],
    [{ year: 2026, month: 4, day: 31, hour: 0, minute: 0 }],
    [{ year: 2026, month: 1, day: 0, hour: 0, minute: 0 }],
    [{ year: 2026, month: 1, day: 1, hour: 24, minute: 0 }],
    [{ year: 2026, month: 1, day: 1, hour: 0, minute: 60 }],
    [{ year: 2026, month: 1, day: 1, hour: 1.5, minute: 0 }],
  ])("refuses an impossible date or time %o", (time) => {
    expect(() =>
      resolveRecordedUkTime(time, { now: at("2026-06-01T00:00:00Z"), futureToleranceMinutes: 5 }),
    ).toThrow(RangeError);
  });

  it("accepts 29 February in a leap year", () => {
    expect(
      resolveRecordedUkTime(
        { year: 2028, month: 2, day: 29, hour: 8, minute: 0 },
        { now: at("2028-03-01T00:00:00Z"), futureToleranceMinutes: 5 },
      ),
    ).toEqual({ kind: "exact", instant: at("2028-02-29T08:00:00Z") });
  });

  it.each([-1, Number.NaN, Number.POSITIVE_INFINITY])("refuses a tolerance of %s", (bad) => {
    expect(() =>
      resolveRecordedUkTime(
        { year: 2026, month: 7, day: 1, hour: 9, minute: 0 },
        { now: at("2026-07-01T12:00:00Z"), futureToleranceMinutes: bad },
      ),
    ).toThrow(RangeError);
  });
});

describe("hazard HZ-009 clock-change days", () => {
  it.each([
    [2026, 3, 29, true],
    [2026, 3, 28, false],
    [2026, 10, 25, true],
    [2026, 10, 26, false],
    [2027, 3, 28, true],
    [2027, 10, 31, true],
    [2026, 7, 1, false],
  ] as const)("%i-%i-%i -> %s", (year, month, day, expected) => {
    expect(isUkClockChangeDay(year, month, day)).toBe(expected);
  });

  it.each([
    ["2026-01-15T12:00:00Z", "GMT"],
    ["2026-07-15T12:00:00Z", "BST"],
  ] as const)("%s is %s", (iso, abbreviation) => {
    expect(ukZoneAbbreviation(new Date(iso))).toBe(abbreviation);
  });
});
