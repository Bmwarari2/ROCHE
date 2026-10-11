import { afterAll, describe, expect, it } from "vitest";
import {
  checkDateParts,
  checkWallClockParts,
  datePartsOf,
  dateTimePartsAt,
  wallClockAt,
} from "./zoned-time";

/**
 * The boxes of the date and time inputs. Filling them from an instant must give UK time whatever
 * the device's zone, so these run with the process in three zones. Which instant a typed time
 * means across a clock change is the domain's rule (resolveRecordedUkTime), tested there and in
 * apps/web/src/lib/uk-time.test.ts.
 */

const DEVICE_ZONES = ["Europe/London", "America/New_York", "UTC"] as const;
const originalZone = process.env.TZ;

afterAll(() => {
  if (originalZone === undefined) delete process.env.TZ;
  else process.env.TZ = originalZone;
});

function inEveryDeviceZone(check: () => void) {
  for (const zone of DEVICE_ZONES) {
    process.env.TZ = zone;
    // Node applies TZ when it changes; prove it did, so the loop is not testing one zone thrice.
    expect(new Date(2026, 0, 15, 12).getTimezoneOffset(), zone).toBe(
      zone === "America/New_York" ? 300 : 0,
    );
    check();
  }
}

describe("filling the boxes from an instant", () => {
  it("hazard HZ-009 hazard HZ-017 shows UK time on every device, across both clock changes", () => {
    inEveryDeviceZone(() => {
      // The two 01:30s of 25/10/2026, and either side of 01:00 on 29/03/2026.
      expect(dateTimePartsAt(Date.parse("2026-10-25T00:30:00Z"))).toMatchObject({
        day: "25",
        hour: "01",
        minute: "30",
      });
      expect(dateTimePartsAt(Date.parse("2026-10-25T01:30:00Z"))).toMatchObject({
        hour: "01",
        minute: "30",
      });
      expect(wallClockAt(Date.parse("2026-03-29T00:59:00Z"))).toEqual({
        year: 2026,
        month: 3,
        day: 29,
        hour: 0,
        minute: 59,
      });
      expect(wallClockAt(Date.parse("2026-03-29T01:00:00Z"))).toMatchObject({ hour: 2, minute: 0 });
      expect(dateTimePartsAt(Date.parse("2026-12-31T23:59:00Z"))).toEqual({
        day: "31",
        month: "12",
        year: "2026",
        hour: "23",
        minute: "59",
      });
    });
  });

  it("works in other zones too", () => {
    expect(wallClockAt(Date.parse("2026-07-01T12:00:00Z"), "America/New_York").hour).toBe(8);
  });

  it("shows a stored date in the boxes", () => {
    expect(datePartsOf("2026-03-05")).toEqual({ day: "05", month: "03", year: "2026" });
    expect(datePartsOf("")).toEqual({ day: "", month: "", year: "" });
    expect(datePartsOf("05/03/2026")).toEqual({ day: "", month: "", year: "" });
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

describe("checkWallClockParts", () => {
  const date = { day: "25", month: "10", year: "2026" };

  it("reads a date and a 24-hour time as a wall-clock time", () => {
    expect(checkWallClockParts({ ...date, hour: "1", minute: "30" })).toEqual({
      ok: true,
      wall: { year: 2026, month: 10, day: 25, hour: 1, minute: 30 },
    });
  });

  it("says which time boxes are missing or wrong", () => {
    expect(checkWallClockParts({ ...date, hour: "14" })).toEqual({
      ok: false,
      problem: "time_incomplete",
      parts: ["minute"],
    });
    expect(checkWallClockParts({ ...date, hour: "24", minute: "60" })).toEqual({
      ok: false,
      problem: "time_not_real",
      parts: ["hour", "minute"],
    });
    expect(checkWallClockParts({ hour: "14", minute: "00" })).toMatchObject({
      ok: false,
      problem: "empty",
    });
  });
});
