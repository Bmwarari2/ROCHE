import { describe, expect, it } from "vitest";
import { formatDate, formatDateTime, formatNhsNumber } from "./format";

describe("formatDate", () => {
  it.each([
    ["1938-02-01", "01/02/1938"],
    ["2026-10-25", "25/10/2026"],
    ["01/02/1938", null],
    ["", null],
    [null, null],
  ])("%s gives %s", (value, expected) => {
    expect(formatDate(value)).toBe(expected);
  });
});

describe("formatDateTime", () => {
  it("shows UK local time on the 24-hour clock, across the October clock change", () => {
    expect(formatDateTime("2026-10-03T13:05:00Z")).toBe("03/10/2026 14:05");
    expect(formatDateTime("2026-10-25T00:30:00Z")).toBe("25/10/2026 01:30");
    expect(formatDateTime("2026-10-25T01:30:00Z")).toBe("25/10/2026 01:30");
    expect(formatDateTime("2026-12-01T00:00:00Z")).toBe("01/12/2026 00:00");
  });
  it("returns null for missing or unreadable values", () => {
    expect(formatDateTime(null)).toBeNull();
    expect(formatDateTime("not a date")).toBeNull();
  });
});

describe("formatNhsNumber", () => {
  it.each([
    ["9990000018", "999 000 0018"],
    ["999 000 0026", "999 000 0026"],
    ["12345", "12345"],
    [null, null],
  ])("%s gives %s", (value, expected) => {
    expect(formatNhsNumber(value)).toBe(expected);
  });
});
