import { describe, expect, it } from "vitest";
import {
  addDays,
  formatUkTime,
  isIsoDate,
  ukDateTimeInput,
  ukLocalToIso,
  ukOffsetMinutes,
  ukToday,
} from "./uk-time";

describe("ukLocalToIso (hazard HZ-009)", () => {
  it.each([
    // Summer time (BST, UTC+1) and winter time (GMT).
    ["2026-07-01T14:05", "2026-07-01T14:05:00+01:00"],
    ["2026-12-01T09:30", "2026-12-01T09:30:00+00:00"],
    // The October hour that happens twice is read as the first (BST) one.
    ["2026-10-25T01:30", "2026-10-25T01:30:00+01:00"],
    ["2026-10-25T02:30", "2026-10-25T02:30:00+00:00"],
    // The March hour that is skipped is read as clocks show it, an hour later in BST.
    ["2026-03-29T01:30", "2026-03-29T02:30:00+01:00"],
    ["2026-03-29T02:30", "2026-03-29T02:30:00+01:00"],
  ])("%s is %s", (local, iso) => {
    expect(ukLocalToIso(local)).toBe(iso);
  });

  it("gives instants that are the same moment as the UK wall time", () => {
    expect(new Date(ukLocalToIso("2026-07-01T14:05") ?? "").toISOString()).toBe(
      "2026-07-01T13:05:00.000Z",
    );
  });

  it.each(["", "2026-02-31T10:00", "2026-10-11T24:00", "2026-10-11 10:00", "11/10/2026 10:00"])(
    "refuses %j",
    (value) => {
      expect(ukLocalToIso(value)).toBeNull();
    },
  );
});

describe("UK dates and times", () => {
  it("knows the UK offset either side of the clock changes", () => {
    expect(ukOffsetMinutes(new Date("2026-10-25T00:59:00Z"))).toBe(60);
    expect(ukOffsetMinutes(new Date("2026-10-25T01:00:00Z"))).toBe(0);
  });

  it("gives today's UK date, which is not the UTC date just after midnight in summer", () => {
    expect(ukToday(new Date("2026-07-01T23:30:00Z"))).toBe("2026-07-02");
    expect(ukToday(new Date("2026-12-31T23:30:00Z"))).toBe("2026-12-31");
  });

  it("fills a datetime-local input in UK time", () => {
    expect(ukDateTimeInput(new Date("2026-07-01T13:05:42Z"))).toBe("2026-07-01T14:05");
    expect(ukDateTimeInput("2026-12-01T09:30:00Z")).toBe("2026-12-01T09:30");
    expect(ukDateTimeInput("not a date")).toBe("");
  });

  it("checks and moves calendar dates without time zones", () => {
    expect(isIsoDate("2026-02-28")).toBe(true);
    expect(isIsoDate("2026-02-29")).toBe(false);
    expect(isIsoDate("28/02/2026")).toBe(false);
    expect(addDays("2026-10-25", 1)).toBe("2026-10-26");
    expect(addDays("2026-03-01", -1)).toBe("2026-02-28");
    expect(addDays("nonsense", 1)).toBe("nonsense");
  });

  it("shows times on the 24-hour clock in UK time", () => {
    expect(formatUkTime("2026-07-01T13:05:00Z")).toBe("14:05");
    expect(formatUkTime(null)).toBeNull();
    expect(formatUkTime("x")).toBeNull();
  });
});
