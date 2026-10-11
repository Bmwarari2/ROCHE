import { describe, expect, it } from "vitest";
import {
  formatIsoDate,
  parseClockTime,
  parseInstant,
  resolveOccurredAt,
  ukDateTimeParts,
} from "./time";

describe("parseClockTime", () => {
  it.each([
    ["14:30", { hour: 14, minute: 30 }],
    ["9:05", { hour: 9, minute: 5 }],
    [" 00:00 ", { hour: 0, minute: 0 }],
    ["23:59", { hour: 23, minute: 59 }],
  ])("reads %j", (value, expected) => {
    expect(parseClockTime(value)).toEqual(expected);
  });

  it.each(["24:00", "12:60", "1430", "2pm", "", "12:3", "123:00", `${"9".repeat(5000)}:00`])(
    "refuses %j",
    (value) => {
      expect(parseClockTime(value)).toBeNull();
    },
  );
});

describe("hazard HZ-010 hazard HZ-017 when the event happened", () => {
  // 11 October 2026 is British Summer Time: 10:00 UTC is 11:00 in the UK.
  const now = new Date("2026-10-11T10:00:00Z");

  it("records now as the device clock", () => {
    expect(resolveOccurredAt({ kind: "now" }, now)).toEqual({ ok: true, occurredAt: now });
  });

  it("reads an earlier time today as UK time", () => {
    const result = resolveOccurredAt({ kind: "earlier", time: "08:15" }, now);
    expect(result.ok && result.occurredAt.toISOString()).toBe("2026-10-11T07:15:00.000Z");
  });

  it("refuses a time later than the device clock", () => {
    expect(resolveOccurredAt({ kind: "earlier", time: "11:01" }, now)).toEqual({
      ok: false,
      error: "mobile.when.future",
    });
  });

  it("refuses a time it cannot read", () => {
    expect(resolveOccurredAt({ kind: "earlier", time: "eleven" }, now)).toEqual({
      ok: false,
      error: "mobile.when.invalid",
    });
  });

  it("uses the UK date just after midnight, when UTC is still the previous day", () => {
    const justAfterMidnight = new Date("2026-10-10T23:30:00Z");
    const result = resolveOccurredAt({ kind: "earlier", time: "00:10" }, justAfterMidnight);
    expect(result.ok && result.occurredAt.toISOString()).toBe("2026-10-10T23:10:00.000Z");
  });
});

describe("parseInstant", () => {
  it.each([
    ["2026-10-11T09:00:00.000000Z", "2026-10-11T09:00:00.000Z"],
    ["2026-10-11T09:00:00.123456Z", "2026-10-11T09:00:00.123Z"],
    ["2026-10-11T09:00:00.1Z", "2026-10-11T09:00:00.100Z"],
    ["2026-10-11 09:00:00Z", "2026-10-11T09:00:00.000Z"],
    ["2026-10-11T09:00:00", "2026-10-11T09:00:00.000Z"],
    ["2026-10-11T10:00:00+01:00", "2026-10-11T09:00:00.000Z"],
  ])("reads %s", (value, expected) => {
    expect(parseInstant(value)?.toISOString()).toBe(expected);
  });

  it.each([
    null,
    "",
    "yesterday",
    "2026-13-45T99:99:99Z",
    `2026-10-11T09:00:00.${"1".repeat(20)}Z`,
  ])("returns null for %j", (value) => {
    expect(parseInstant(value)).toBeNull();
  });
});

describe("display", () => {
  it("shows UK date and 24-hour time", () => {
    expect(ukDateTimeParts(new Date("2026-10-11T13:05:00Z"))).toEqual({
      date: "11/10/2026",
      time: "14:05",
    });
  });

  it.each([
    ["2026-10-11", "11/10/2026"],
    ["2027-01-05T00:00:00Z", "05/01/2027"],
    [null, null],
    ["soon", null],
  ])("formats the date %j as %j", (value, expected) => {
    expect(formatIsoDate(value)).toBe(expected);
  });
});
