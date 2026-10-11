import { describe, expect, it } from "vitest";
import {
  formatIsoDate,
  maxDaysBack,
  parseClockTime,
  parseInstant,
  resolveOccurredAt,
  ukDateLabel,
  ukDateTimeParts,
  ukInstantsAt,
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

describe("hazard HZ-010 hazard HZ-017 when the event happened", () => {
  // 11 October 2026 is British Summer Time: 10:00 UTC is 11:00 in the UK.
  const now = new Date("2026-10-11T10:00:00Z");
  const at = (choice: WhenChoice, clock: Date, windowDays: number | null = 7) => {
    const result = resolveOccurredAt(choice, clock, windowDays);
    return result.ok ? result.occurredAt.toISOString() : result.error;
  };

  it("records now as the device clock", () => {
    expect(resolveOccurredAt({ kind: "now" }, now)).toEqual({ ok: true, occurredAt: now });
  });

  it("reads an earlier time today as UK time", () => {
    expect(at({ kind: "earlier", time: "08:15" }, now)).toBe("2026-10-11T07:15:00.000Z");
  });

  it("refuses a time later than the device clock on the day chosen", () => {
    expect(at({ kind: "earlier", time: "11:01", daysAgo: 0 }, now)).toBe("mobile.when.future");
  });

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

describe("hazard HZ-010 hazard HZ-017 earlier days within the offline window (C4)", () => {
  const at = (choice: WhenChoice, clock: Date, windowDays: number | null = 7) => {
    const result = resolveOccurredAt(choice, clock, windowDays);
    return result.ok ? result.occurredAt.toISOString() : result.error;
  };

  it("reads 23:45 typed at 00:30 as yesterday, not tonight", () => {
    // 00:30 on 12/10/2026 in the UK (BST) is 23:30 UTC on 11/10/2026.
    const halfPastMidnight = new Date("2026-10-11T23:30:00Z");
    expect(at({ kind: "earlier", time: "23:45" }, halfPastMidnight)).toBe(
      "2026-10-11T22:45:00.000Z",
    );
  });

  it.each([
    [0, "2026-10-11T07:15:00.000Z"],
    [1, "2026-10-10T07:15:00.000Z"],
    [6, "2026-10-05T07:15:00.000Z"],
  ])("takes %i days ago at the time typed", (daysAgo, expected) => {
    expect(at({ kind: "earlier", time: "08:15", daysAgo }, new Date("2026-10-11T10:00:00Z"))).toBe(
      expected,
    );
  });

  it("refuses a day before the offline window", () => {
    const now = new Date("2026-10-11T10:00:00Z");
    expect(at({ kind: "earlier", time: "08:15", daysAgo: 7 }, now, 7)).toBe(
      "mobile.when.outsideWindow",
    );
    expect(at({ kind: "earlier", time: "08:15", daysAgo: 3 }, now, 3)).toBe(
      "mobile.when.outsideWindow",
    );
  });

  it("always allows yesterday, even before the window is known", () => {
    const now = new Date("2026-10-11T10:00:00Z");
    expect(maxDaysBack(null)).toBe(1);
    expect(at({ kind: "earlier", time: "08:15", daysAgo: 1 }, now, null)).toBe(
      "2026-10-10T07:15:00.000Z",
    );
  });

  it.each([
    [{ kind: "earlier", time: "08:15", daysAgo: -1 } as const],
    [{ kind: "earlier", time: "08:15", daysAgo: 1.5 } as const],
  ])("refuses a day that is not a whole number of days back (%j)", (choice) => {
    expect(at(choice, new Date("2026-10-11T10:00:00Z"))).toBe("mobile.when.invalid");
  });

  it.each([
    [0, "11/10/2026"],
    [1, "10/10/2026"],
    [11, "30/09/2026"],
  ])("labels %i days back as %s", (daysAgo, label) => {
    expect(ukDateLabel(new Date("2026-10-11T10:00:00Z"), daysAgo)).toBe(label);
  });
});

describe("hazard HZ-017 a correction keeps the original's event time by default (C4)", () => {
  const now = new Date("2026-10-11T10:00:00Z");

  it("uses the original's time, whatever the clock says now", () => {
    expect(resolveOccurredAt({ kind: "original", at: "2026-10-10T21:05:00.000000Z" }, now)).toEqual(
      {
        ok: true,
        occurredAt: new Date("2026-10-10T21:05:00.000Z"),
      },
    );
  });

  it("refuses an original time it cannot read or that is in the future", () => {
    expect(resolveOccurredAt({ kind: "original", at: "soon" }, now)).toEqual({
      ok: false,
      error: "mobile.when.invalid",
    });
    expect(resolveOccurredAt({ kind: "original", at: "2026-10-11T11:00:00Z" }, now)).toEqual({
      ok: false,
      error: "mobile.when.future",
    });
  });
});

describe("hazard HZ-010 hazard HZ-017 the clock changes (C4)", () => {
  const at = (choice: WhenChoice, clock: Date) => {
    const result = resolveOccurredAt(choice, clock, 7);
    return result.ok ? result.occurredAt.toISOString() : result.error;
  };

  // Spring: 29/03/2026 at 01:00 GMT the clocks went forward to 02:00 BST.
  it("refuses a time that did not happen when the clocks went forward", () => {
    const morning = new Date("2026-03-29T09:00:00Z");
    expect(at({ kind: "earlier", time: "01:30", daysAgo: 0 }, morning)).toBe("mobile.when.skipped");
    expect(ukInstantsAt({ year: 2026, month: 3, day: 29 }, 1, 30)).toEqual([]);
  });

  it.each([
    ["00:30", "2026-03-29T00:30:00.000Z"],
    ["00:59", "2026-03-29T00:59:00.000Z"],
    ["02:00", "2026-03-29T01:00:00.000Z"],
    ["03:15", "2026-03-29T02:15:00.000Z"],
  ])("reads %s on the spring change day either side of the gap", (time, expected) => {
    expect(at({ kind: "earlier", time, daysAgo: 0 }, new Date("2026-03-29T09:00:00Z"))).toBe(
      expected,
    );
  });

  // Autumn: 25/10/2026 at 02:00 BST the clocks went back to 01:00 GMT, so 01:00 to 01:59 happened twice.
  it("finds both occurrences of a time that happened twice", () => {
    expect(
      ukInstantsAt({ year: 2026, month: 10, day: 25 }, 1, 30).map((d) => d.toISOString()),
    ).toEqual(["2026-10-25T00:30:00.000Z", "2026-10-25T01:30:00.000Z"]);
  });

  it.each([
    // After both: the second (GMT) one, the most recent.
    ["2026-10-25T03:00:00Z", "01:30", "2026-10-25T01:30:00.000Z"],
    // Between them: the first (BST) one, because the second is still to come.
    ["2026-10-25T01:10:00Z", "01:30", "2026-10-25T00:30:00.000Z"],
    // Just after the change, an hour that has only happened once so far.
    ["2026-10-25T01:20:00Z", "01:10", "2026-10-25T01:10:00.000Z"],
  ])("at %s reads %s on the autumn change day as %s", (clock, time, expected) => {
    expect(at({ kind: "earlier", time, daysAgo: 0 }, new Date(clock))).toBe(expected);
  });

  it("keeps 24 hours between the same time on the days either side of a change", () => {
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
    ["2026-10-11", "11/10/2026"],
    ["2027-01-05T00:00:00Z", "05/01/2027"],
    [null, null],
    ["soon", null],
  ])("formats the date %j as %j", (value, expected) => {
    expect(formatIsoDate(value)).toBe(expected);
  });
});
