import { describe, expect, it } from "vitest";
import { addWorkingDays, isWorkingDay, ukIsoDate, workingDaysDeadline } from "./working-days";

// Excerpts of docs/specs/calendar.md (GOV.UK); the database holds the full list.
const ENGLAND = new Set([
  "2026-08-31",
  "2026-12-25",
  "2026-12-28",
  "2027-01-01",
  "2027-03-26",
  "2027-03-29",
]);
const SCOTLAND = new Set(["2026-12-25", "2026-12-28", "2027-01-01", "2027-01-04", "2027-03-26"]);
const NORTHERN_IRELAND = new Set(["2027-03-17", "2027-03-26", "2027-03-29"]);

describe("isWorkingDay", () => {
  it.each([
    ["2026-10-12", ENGLAND, true, "a Monday"],
    ["2026-10-10", ENGLAND, false, "a Saturday"],
    ["2026-10-11", ENGLAND, false, "a Sunday"],
    ["2026-12-28", ENGLAND, false, "a substitute bank holiday"],
    ["2027-03-29", SCOTLAND, true, "Easter Monday in Scotland"],
    ["2027-03-29", ENGLAND, false, "Easter Monday in England"],
  ])("%s with %s is %s (%s)", (date, holidays, expected) => {
    expect(isWorkingDay(date, holidays)).toBe(expected);
  });
});

describe("addWorkingDays", () => {
  it.each([
    ["2026-10-12", 0, ENGLAND, "2026-10-12", "zero days is the same day"],
    ["2026-10-10", 1, ENGLAND, "2026-10-12", "a weekend start counts from Monday"],
    ["2026-10-16", 1, ENGLAND, "2026-10-19", "Friday plus one is Monday"],
    ["2026-12-24", 1, ENGLAND, "2026-12-29", "over Christmas and the substitute Boxing Day"],
    ["2027-03-19", 5, ENGLAND, "2027-03-30", "over Good Friday and Easter Monday in England"],
    ["2027-03-19", 5, SCOTLAND, "2027-03-29", "Scotland has no Easter Monday holiday"],
    ["2027-03-16", 1, NORTHERN_IRELAND, "2027-03-18", "St Patrick's Day in Northern Ireland"],
    ["2026-12-31", 2, SCOTLAND, "2027-01-06", "2 January substitute in Scotland"],
    ["2026-08-28", 10, ENGLAND, "2026-09-14", "ten working days over the summer bank holiday"],
  ])("%s plus %i working days is %s", (from, days, holidays, expected) => {
    expect(addWorkingDays(from, days, holidays)).toBe(expected);
  });

  it.each([-1, 1.5, Number.NaN])("refuses %s days", (days) => {
    expect(() => addWorkingDays("2026-10-12", days, ENGLAND)).toThrow(RangeError);
  });
});

describe("ukIsoDate", () => {
  it("uses the UK calendar date, not the UTC one", () => {
    expect(ukIsoDate(new Date("2026-07-01T23:30:00Z"))).toBe("2026-07-02");
    expect(ukIsoDate(new Date("2026-12-01T23:30:00Z"))).toBe("2026-12-01");
  });
});

describe("workingDaysDeadline", () => {
  it.each([
    [
      "2026-10-23T14:00:00Z",
      2,
      "2026-10-28T00:00:00.000Z",
      "across the October clock change, midnight GMT at the end of Tuesday",
    ],
    [
      "2026-07-01T23:30:00Z",
      1,
      "2026-07-03T23:00:00.000Z",
      "an event after midnight BST belongs to the next UK day",
    ],
    [
      "2027-03-25T09:00:00Z",
      1,
      "2027-03-30T23:00:00.000Z",
      "over Easter and the March clock change, midnight BST at the end of Tuesday",
    ],
  ])("from %s plus %i working days runs out at %s (%s)", (from, days, expected) => {
    expect(workingDaysDeadline(new Date(from), days, ENGLAND).toISOString()).toBe(expected);
  });

  it("without the holidays, a deadline falls early, never late", () => {
    const from = new Date("2026-12-24T10:00:00Z");
    expect(workingDaysDeadline(from, 1, new Set()).getTime()).toBeLessThan(
      workingDaysDeadline(from, 1, ENGLAND).getTime(),
    );
  });
});
