import { describe, expect, it } from "vitest";
import { ukIsoDate } from "../shared/working-days";
import {
  addDays,
  addMonths,
  addYears,
  daysBetween,
  fromMonthIndex,
  isIsoDate,
  isYearMonth,
  monthIndex,
} from "./dates";

describe("UK calendar dates for the workforce rules", () => {
  it.each([
    ["2026-01-31", 1, "2026-02-28"],
    ["2028-01-31", 1, "2028-02-29"],
    ["2026-03-29", 12, "2027-03-29"],
    ["2026-12-15", 1, "2027-01-15"],
    ["2026-05-31", -1, "2026-04-30"],
  ])("%s plus %i months is %s (clamped to the month's end)", (from, months, to) => {
    expect(addMonths(from, months)).toBe(to);
  });

  it("adds years as twelve months, from 29 February too", () => {
    expect(addYears("2024-02-29", 1)).toBe("2025-02-28");
    expect(addYears("2024-02-29", 4)).toBe("2028-02-29");
  });

  it("counts days across the spring and autumn clock changes as whole days", () => {
    expect(daysBetween("2026-03-28", "2026-03-30")).toBe(2);
    expect(daysBetween("2026-10-24", "2026-10-26")).toBe(2);
    expect(addDays("2026-03-29", 1)).toBe("2026-03-30");
    expect(daysBetween("2026-10-26", "2026-10-24")).toBe(-2);
  });

  it("takes the UK date of an instant late at night either side of a clock change", () => {
    // 23:30 UTC on 28 March 2026 is still the 28th in the UK (GMT); after the change, 23:30 UTC on
    // 29 March is 00:30 BST on the 30th.
    expect(ukIsoDate(new Date("2026-03-28T23:30:00Z"))).toBe("2026-03-28");
    expect(ukIsoDate(new Date("2026-03-29T23:30:00Z"))).toBe("2026-03-30");
    // In autumn, 23:30 UTC on 24 October is 00:30 BST on the 25th; on the 25th itself it is GMT.
    expect(ukIsoDate(new Date("2026-10-24T23:30:00Z"))).toBe("2026-10-25");
    expect(ukIsoDate(new Date("2026-10-25T23:30:00Z"))).toBe("2026-10-25");
  });

  it.each([
    ["2026-02-29", false],
    ["2028-02-29", true],
    ["2026-13-01", false],
    ["26-01-01", false],
  ])("%s is a calendar date: %s", (value, expected) => {
    expect(isIsoDate(value)).toBe(expected);
  });

  it("refuses arithmetic on something that is not a date", () => {
    expect(() => addDays("2026-02-30", 1)).toThrow(RangeError);
  });

  it("counts year and month pairs", () => {
    expect(isYearMonth("2026-12")).toBe(true);
    expect(isYearMonth("2026-13")).toBe(false);
    expect(monthIndex("2027-01") - monthIndex("2026-12")).toBe(1);
    expect(fromMonthIndex(monthIndex("2026-07"))).toBe("2026-07");
    expect(() => monthIndex("2026-7")).toThrow(RangeError);
  });
});
