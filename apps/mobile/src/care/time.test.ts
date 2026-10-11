import { describe, expect, it } from "vitest";
import {
  ambiguousTime,
  formatIsoDate,
  maxDaysBack,
  parseClockTime,
  parseInstant,
  resolveOccurredAt,
  ukDateLabel,
  ukDateTimeParts,
  type WhenChoice,
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

const at = (
  choice: WhenChoice,
  clock: Date,
  windowDays: number | null = 7,
  toleranceMinutes = 0,
) => {
  const result = resolveOccurredAt(choice, clock, windowDays, toleranceMinutes);
  return result.ok ? result.occurredAt.toISOString() : result.error;
};

describe("hazard HZ-010 when the event happened", () => {
  // 11 October 2026 is British Summer Time: 10:00 UTC is 11:00 in the UK.
  const now = new Date("2026-10-11T10:00:00Z");

  it("records now as the device clock", () => {
    expect(resolveOccurredAt({ kind: "now" }, now)).toEqual({ ok: true, occurredAt: now });
  });

  it("reads an earlier time today as UK time", () => {
    expect(at({ kind: "earlier", time: "08:15" }, now)).toBe("2026-10-11T07:15:00.000Z");
  });

  it("hazard HZ-010 refuses a time later than now", () => {
    // The default day is today: a time still to come is refused, never moved to another day.
    expect(at({ kind: "earlier", time: "11:01" }, now)).toBe("mobile.when.future");
    expect(at({ kind: "earlier", time: "11:01", daysAgo: 0 }, now)).toBe("mobile.when.future");
  });

  it("hazard HZ-010 never rolls a later time back to yesterday", () => {
    // 00:30 on 12/10/2026 in the UK (BST) is 23:30 UTC on 11/10/2026: 23:45 today is still to come.
    const halfPastMidnight = new Date("2026-10-11T23:30:00Z");
    expect(at({ kind: "earlier", time: "23:45" }, halfPastMidnight)).toBe("mobile.when.future");
    // Yesterday only through the explicit day choice.
    expect(at({ kind: "earlier", time: "23:45", daysAgo: 1 }, halfPastMidnight)).toBe(
      "2026-10-11T22:45:00.000Z",
    );
  });

  it.each([
    [5, "11:04", "2026-10-11T10:04:00.000Z"],
    [5, "11:05", "2026-10-11T10:05:00.000Z"],
    [5, "11:06", "mobile.when.future"],
    [0, "11:01", "mobile.when.future"],
  ])(
    "hazard HZ-010 with a tolerance of %i minutes from the rate table reads %s as %s",
    (tolerance, time, expected) => {
      expect(at({ kind: "earlier", time }, now, 7, tolerance)).toBe(expected);
    },
  );

  it("refuses a time it cannot read", () => {
    expect(at({ kind: "earlier", time: "eleven" }, now)).toBe("mobile.when.invalid");
  });

  it("uses the UK date just after midnight, when UTC is still the previous day", () => {
    const justAfterMidnight = new Date("2026-10-10T23:30:00Z");
    expect(at({ kind: "earlier", time: "00:10" }, justAfterMidnight)).toBe(
      "2026-10-10T23:10:00.000Z",
    );
  });
});

describe("hazard HZ-017 earlier days within the offline window (C4)", () => {
  const now = new Date("2026-10-11T10:00:00Z");

  it.each([
    [0, "2026-10-11T07:15:00.000Z"],
    [1, "2026-10-10T07:15:00.000Z"],
    [6, "2026-10-05T07:15:00.000Z"],
  ])("takes %i days ago at the time typed", (daysAgo, expected) => {
    expect(at({ kind: "earlier", time: "08:15", daysAgo }, now)).toBe(expected);
  });

  it("refuses a day before the offline window", () => {
    expect(at({ kind: "earlier", time: "08:15", daysAgo: 7 }, now, 7)).toBe(
      "mobile.when.outsideWindow",
    );
    expect(at({ kind: "earlier", time: "08:15", daysAgo: 3 }, now, 3)).toBe(
      "mobile.when.outsideWindow",
    );
  });

  it("always allows yesterday, even before the window is known", () => {
    expect(maxDaysBack(null)).toBe(1);
    expect(at({ kind: "earlier", time: "08:15", daysAgo: 1 }, now, null)).toBe(
      "2026-10-10T07:15:00.000Z",
    );
  });

  it.each([
    [{ kind: "earlier", time: "08:15", daysAgo: -1 } as const],
    [{ kind: "earlier", time: "08:15", daysAgo: 1.5 } as const],
  ])("refuses a day that is not a whole number of days back (%j)", (choice) => {
    expect(at(choice, now)).toBe("mobile.when.invalid");
  });

  it.each([
    [0, "11/10/2026"],
    [1, "10/10/2026"],
    [11, "30/09/2026"],
  ])("labels %i days back as %s", (daysAgo, label) => {
    expect(ukDateLabel(now, daysAgo)).toBe(label);
  });
});

describe("hazard HZ-017 a correction keeps the original instant unchanged (C4)", () => {
  const now = new Date("2026-10-11T10:00:00Z");

  it("uses the original's time, whatever the clock says now", () => {
    expect(resolveOccurredAt({ kind: "original", at: "2026-10-10T21:05:00.000000Z" }, now)).toEqual(
      { ok: true, occurredAt: new Date("2026-10-10T21:05:00.000Z") },
    );
  });

  it("hazard HZ-009 keeps an original in the repeated autumn hour exactly, never re-reading it", () => {
    // 01:30 GMT, the second 01:30 of 25/10/2026: a correction keeps it, with no BST or GMT question.
    const later = new Date("2026-10-26T12:00:00Z");
    expect(at({ kind: "original", at: "2026-10-25T01:30:00Z" }, later)).toBe(
      "2026-10-25T01:30:00.000Z",
    );
    expect(ambiguousTime({ kind: "original", at: "2026-10-25T01:30:00Z" }, later)).toBeNull();
  });

  it("refuses an original time it cannot read or that is later than now beyond the tolerance", () => {
    expect(at({ kind: "original", at: "soon" }, now)).toBe("mobile.when.invalid");
    expect(at({ kind: "original", at: "2026-10-11T11:00:00Z" }, now)).toBe("mobile.when.future");
    expect(at({ kind: "original", at: "2026-10-11T10:04:00Z" }, now, 7, 5)).toBe(
      "2026-10-11T10:04:00.000Z",
    );
  });
});

describe("hazard HZ-009 the clock changes (C4, round 3 H1)", () => {
  // Spring: 29/03/2026 at 01:00 GMT the clocks went forward to 02:00 BST.
  const springMorning = new Date("2026-03-29T09:00:00Z");

  it("hazard HZ-009 refuses a time that did not happen when the clocks went forward", () => {
    expect(at({ kind: "earlier", time: "01:30", daysAgo: 0 }, springMorning)).toBe(
      "mobile.when.skipped",
    );
    // In the default mode too: the day is today unless the carer chooses another.
    expect(at({ kind: "earlier", time: "01:30" }, springMorning)).toBe("mobile.when.skipped");
  });

  it.each([
    ["00:30", "2026-03-29T00:30:00.000Z"],
    ["00:59", "2026-03-29T00:59:00.000Z"],
    ["02:00", "2026-03-29T01:00:00.000Z"],
    ["03:15", "2026-03-29T02:15:00.000Z"],
  ])("reads %s on the spring change day either side of the gap", (time, expected) => {
    expect(at({ kind: "earlier", time }, springMorning)).toBe(expected);
  });

  // Autumn: 25/10/2026 at 02:00 BST the clocks went back to 01:00 GMT, so 01:00 to 01:59 happened twice.
  const autumnMorning = new Date("2026-10-25T03:00:00Z");

  it("hazard HZ-009 asks BST or GMT, with no default, when both have passed", () => {
    expect(at({ kind: "earlier", time: "01:30" }, autumnMorning)).toBe("mobile.when.zoneRequired");
    expect(
      ambiguousTime({ kind: "earlier", time: "01:30" }, autumnMorning)?.earlier.toISOString(),
    ).toBe("2026-10-25T00:30:00.000Z");
    expect(at({ kind: "earlier", time: "01:30", zone: "BST" }, autumnMorning)).toBe(
      "2026-10-25T00:30:00.000Z",
    );
    expect(at({ kind: "earlier", time: "01:30", zone: "GMT" }, autumnMorning)).toBe(
      "2026-10-25T01:30:00.000Z",
    );
  });

  it.each([
    // Between them: the first (BST) one, because the second is still to come; nothing to ask.
    ["2026-10-25T01:10:00Z", "01:30", "2026-10-25T00:30:00.000Z"],
    // Outside the repeated hour: one reading only.
    ["2026-10-25T03:00:00Z", "02:30", "2026-10-25T02:30:00.000Z"],
    ["2026-10-25T03:00:00Z", "00:30", "2026-10-24T23:30:00.000Z"],
  ])("hazard HZ-009 at %s reads %s on the autumn change day as %s", (clock, time, expected) => {
    expect(at({ kind: "earlier", time }, new Date(clock))).toBe(expected);
    expect(ambiguousTime({ kind: "earlier", time }, new Date(clock))).toBeNull();
  });

  it("hazard HZ-009 asks as soon as the second occurrence has passed", () => {
    expect(at({ kind: "earlier", time: "01:10" }, new Date("2026-10-25T01:20:00Z"))).toBe(
      "mobile.when.zoneRequired",
    );
  });

  it("hazard HZ-009 keeps 25 hours between the same time on the days either side of a change", () => {
    const now = new Date("2026-10-26T12:00:00Z");
    const before = at({ kind: "earlier", time: "09:00", daysAgo: 2 }, now);
    const after = at({ kind: "earlier", time: "09:00", daysAgo: 1 }, now);
    // 24/10 09:00 BST is 08:00 UTC; 25/10 09:00 GMT is 09:00 UTC: 25 hours apart on the clock change.
    expect([before, after]).toEqual(["2026-10-24T08:00:00.000Z", "2026-10-25T09:00:00.000Z"]);
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
    ["2026-10-25T00:30:00Z", { date: "25/10/2026", time: "01:30 BST" }],
    ["2026-10-25T01:30:00Z", { date: "25/10/2026", time: "01:30 GMT" }],
    ["2026-03-29T02:15:00Z", { date: "29/03/2026", time: "03:15 BST" }],
    ["2026-10-24T08:00:00Z", { date: "24/10/2026", time: "09:00" }],
  ])(
    "hazard HZ-009 shows BST or GMT beside times on a clock-change day only (%s)",
    (value, parts) => {
      expect(ukDateTimeParts(new Date(value))).toEqual(parts);
    },
  );

  it.each([
    ["2026-10-11", "11/10/2026"],
    ["2027-01-05T00:00:00Z", "05/01/2027"],
    [null, null],
    ["soon", null],
  ])("formats the date %j as %j", (value, expected) => {
    expect(formatIsoDate(value)).toBe(expected);
  });
});
