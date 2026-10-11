import { afterAll, describe, expect, it } from "vitest";
import {
  checkDateParts,
  checkDateTimeParts,
  datePartsOf,
  dateTimePartsAt,
  resolveWallClock,
  type WallClock,
  wallClockAt,
  zoneName,
  zoneOffsetMinutes,
} from "./zoned-time";

/**
 * UK clock changes (hazard HZ-009): the hour the clocks go back happens twice and the hour they go
 * forward never happens. Every minute of the four change days in 2026 and 2027 is checked, with the
 * process in three time zones, because the answer must not depend on the device's zone.
 */

const DEVICE_ZONES = ["Europe/London", "America/New_York", "UTC"] as const;
const originalZone = process.env.TZ;

afterAll(() => {
  if (originalZone === undefined) delete process.env.TZ;
  else process.env.TZ = originalZone;
});

/** Runs the checks with the process (the "device") in each zone in turn. */
function inEveryDeviceZone(check: () => void) {
  for (const zone of DEVICE_ZONES) {
    process.env.TZ = zone;
    // Node applies TZ when it changes; prove it did, so the loop is not testing one zone thrice.
    const winterOffset = new Date(2026, 0, 15, 12).getTimezoneOffset();
    expect(winterOffset, zone).toBe(zone === "America/New_York" ? 300 : 0);
    check();
  }
}

const CHANGE_DAYS = [
  { year: 2026, month: 3, day: 29, change: "forward" },
  { year: 2026, month: 10, day: 25, change: "back" },
  { year: 2027, month: 3, day: 28, change: "forward" },
  { year: 2027, month: 10, day: 31, change: "back" },
] as const;

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;

describe("UK wall clock on the days the clocks change", () => {
  for (const { year, month, day, change } of CHANGE_DAYS) {
    it(`hazard HZ-009 reads every minute of ${day}/${month}/${year} (clocks go ${change})`, () => {
      inEveryDeviceZone(() => {
        for (let minuteOfDay = 0; minuteOfDay < 24 * 60; minuteOfDay += 1) {
          const wall: WallClock = {
            year,
            month,
            day,
            hour: Math.floor(minuteOfDay / 60),
            minute: minuteOfDay % 60,
          };
          const asUtc = Date.UTC(year, month - 1, day, wall.hour, wall.minute);
          const label = `${wall.hour}:${wall.minute}`;
          const result = resolveWallClock(wall);
          if (wall.hour === 1) {
            if (change === "forward") {
              // 01:00 to 01:59 never happened: the clocks went from 01:00 GMT to 02:00 BST.
              expect(result.kind, label).toBe("skipped");
            } else {
              // 01:00 to 01:59 happened twice: first in BST (UTC+1), then in GMT.
              expect(result, label).toEqual({
                kind: "repeated",
                first: { instant: new Date(asUtc - HOUR).toISOString(), zoneName: "BST" },
                second: { instant: new Date(asUtc).toISOString(), zoneName: "GMT" },
              });
            }
            continue;
          }
          const summer = change === "forward" ? wall.hour >= 2 : wall.hour < 1;
          const instant = summer ? asUtc - HOUR : asUtc;
          expect(result, label).toEqual({
            kind: "exact",
            instant: new Date(instant).toISOString(),
            zoneName: summer ? "BST" : "GMT",
          });
          expect(wallClockAt(instant), label).toEqual(wall);
        }
      });
    });
  }

  it("hazard HZ-009 gives one instant on ordinary days in summer and winter", () => {
    inEveryDeviceZone(() => {
      expect(resolveWallClock({ year: 2026, month: 7, day: 1, hour: 14, minute: 5 })).toEqual({
        kind: "exact",
        instant: "2026-07-01T13:05:00.000Z",
        zoneName: "BST",
      });
      expect(resolveWallClock({ year: 2026, month: 12, day: 1, hour: 0, minute: 0 })).toEqual({
        kind: "exact",
        instant: "2026-12-01T00:00:00.000Z",
        zoneName: "GMT",
      });
      expect(zoneOffsetMinutes(Date.UTC(2026, 6, 1))).toBe(60);
      expect(zoneOffsetMinutes(Date.UTC(2026, 11, 1))).toBe(0);
      expect(zoneName(Date.UTC(2026, 6, 1))).toBe("BST");
    });
  });

  it("works in other zones too", () => {
    expect(
      resolveWallClock({ year: 2026, month: 11, day: 1, hour: 1, minute: 30 }, "America/New_York")
        .kind,
    ).toBe("repeated");
  });
});

describe("checkDateParts", () => {
  it("reads a real date typed as day, month and year", () => {
    expect(checkDateParts({ day: "5", month: "3", year: "2026" })).toEqual({
      ok: true,
      date: "2026-03-05",
      wall: { year: 2026, month: 3, day: 5 },
    });
    expect(checkDateParts({ day: " 29 ", month: "02", year: "2028" })).toMatchObject({
      ok: true,
      date: "2028-02-29",
    });
  });

  it("says which boxes are missing or wrong", () => {
    expect(checkDateParts({})).toEqual({
      ok: false,
      problem: "empty",
      parts: ["day", "month", "year"],
    });
    expect(checkDateParts({ day: "5", year: "2026" })).toEqual({
      ok: false,
      problem: "incomplete",
      parts: ["month"],
    });
    expect(checkDateParts({ day: "5", month: "13", year: "2026" })).toEqual({
      ok: false,
      problem: "not_real",
      parts: ["month"],
    });
    expect(checkDateParts({ day: "31", month: "4", year: "2026" })).toEqual({
      ok: false,
      problem: "not_real",
      parts: ["day"],
    });
    expect(checkDateParts({ day: "29", month: "2", year: "2027" })).toMatchObject({
      ok: false,
      problem: "not_real",
    });
    expect(checkDateParts({ day: "1.5", month: "-1", year: "26" })).toEqual({
      ok: false,
      problem: "not_real",
      parts: ["day", "month", "year"],
    });
  });
});

describe("checkDateTimeParts", () => {
  const parts = { day: "25", month: "10", year: "2026" };

  it("hazard HZ-009 turns a UK date and time into one instant", () => {
    inEveryDeviceZone(() => {
      expect(checkDateTimeParts({ ...parts, hour: "14", minute: "05" })).toEqual({
        ok: true,
        instant: "2026-10-25T14:05:00.000Z",
      });
      expect(
        checkDateTimeParts({ day: "1", month: "7", year: "2026", hour: "9", minute: "0" }),
      ).toEqual({ ok: true, instant: "2026-07-01T08:00:00.000Z" });
    });
  });

  it("hazard HZ-009 asks which time was meant in the hour the clocks go back", () => {
    const repeated = checkDateTimeParts({ ...parts, hour: "01", minute: "30" });
    expect(repeated).toMatchObject({ ok: false, problem: "which_time", parts: ["fold"] });
    expect(checkDateTimeParts({ ...parts, hour: "01", minute: "30" }, { fold: "first" })).toEqual({
      ok: true,
      instant: "2026-10-25T00:30:00.000Z",
    });
    expect(checkDateTimeParts({ ...parts, hour: "01", minute: "30" }, { fold: "second" })).toEqual({
      ok: true,
      instant: "2026-10-25T01:30:00.000Z",
    });
  });

  it("hazard HZ-009 refuses a time in the hour the clocks go forward", () => {
    expect(
      checkDateTimeParts({ day: "29", month: "3", year: "2026", hour: "1", minute: "30" }),
    ).toEqual({ ok: false, problem: "clocks_went_forward", parts: ["hour", "minute"] });
  });

  it("says which time boxes are missing or wrong", () => {
    expect(checkDateTimeParts({ ...parts, hour: "14" })).toEqual({
      ok: false,
      problem: "time_incomplete",
      parts: ["minute"],
    });
    expect(checkDateTimeParts({ ...parts, hour: "24", minute: "60" })).toEqual({
      ok: false,
      problem: "time_not_real",
      parts: ["hour", "minute"],
    });
    expect(checkDateTimeParts({ hour: "14", minute: "00" })).toMatchObject({
      ok: false,
      problem: "empty",
    });
  });
});

describe("parts for the boxes", () => {
  it("shows an instant's UK date and time in the boxes", () => {
    inEveryDeviceZone(() => {
      expect(dateTimePartsAt(Date.parse("2026-10-25T00:30:00Z"))).toEqual({
        day: "25",
        month: "10",
        year: "2026",
        hour: "01",
        minute: "30",
      });
    });
    expect(datePartsOf("2026-03-05")).toEqual({ day: "05", month: "03", year: "2026" });
    expect(datePartsOf("")).toEqual({ day: "", month: "", year: "" });
    expect(datePartsOf("05/03/2026")).toEqual({ day: "", month: "", year: "" });
  });
});
