import { describe, expect, it } from "vitest";
import { addDays, addMonths, daysBetween, isIsoDate } from "./quality-dates";

describe("UK calendar dates for the quality rules", () => {
  it.each([
    ["2026-02-28", true],
    ["2026-02-29", false],
    ["2028-02-29", true],
    ["2026-13-01", false],
    ["31/10/2026", false],
  ])("%s is a date: %s", (value, ok) => {
    expect(isIsoDate(value)).toBe(ok);
  });

  it.each([
    ["2026-01-31", 1, "2026-02-28"],
    ["2028-01-31", 1, "2028-02-29"],
    ["2026-10-31", 12, "2027-10-31"],
    ["2026-03-31", -1, "2026-02-28"],
  ])("%s plus %i months is %s, clamped to the month's end", (from, months, to) => {
    expect(addMonths(from, months)).toBe(to);
  });

  it("counts calendar days across the clock changes", () => {
    expect(addDays("2026-10-24", 2)).toBe("2026-10-26");
    expect(daysBetween("2026-03-28", "2026-03-30")).toBe(2);
    expect(daysBetween("2026-10-31", "2026-10-30")).toBe(-1);
  });

  it("refuses something that is not a date", () => {
    expect(() => addDays("tomorrow", 1)).toThrow(RangeError);
  });
});
