import { describe, expect, it } from "vitest";
import { readRateTable } from "../../test/rate-table";
import {
  agencyAccessWindow,
  agencyUploadDecision,
  awrWeeksFromShifts,
  bookingCostPence,
} from "./agency";
import { awrClock } from "./pay/awr";
import { resolvePayRates } from "./pay/rates";

const ukDate = (d: Date) => d.toLocaleDateString("en-CA", { timeZone: "Europe/London" });

const at = (iso: string) => new Date(iso);

describe("what a booking costs", () => {
  it.each([
    [
      "a 12-hour day less 30 minutes at 2,500p an hour",
      "2026-11-02T08:00:00Z",
      "2026-11-02T20:00:00Z",
      30,
      2500,
      28750,
    ],
    ["no break", "2026-11-02T08:00:00Z", "2026-11-02T16:00:00Z", 0, 1999, 15992],
    ["rounded to the nearest penny", "2026-11-02T08:00:00Z", "2026-11-02T08:07:00Z", 0, 1001, 117],
    ["a break longer than the shift", "2026-11-02T08:00:00Z", "2026-11-02T08:20:00Z", 60, 2000, 0],
  ] as const)("%s", (_, start, end, breakMinutes, rate, pence) => {
    expect(bookingCostPence(at(start), at(end), breakMinutes, rate)).toBe(pence);
  });

  it("charges the elapsed time of a night the clocks go back", () => {
    expect(bookingCostPence(at("2026-10-24T19:00:00Z"), at("2026-10-25T08:00:00Z"), 0, 1000)).toBe(
      13000,
    );
  });
});

describe("the AWR weeks from bookings (AWR 2010 reg 7(4): weeks from the first day)", () => {
  it("counts weeks of seven days from the first shift's day, and weeks between as breaks", () => {
    const weeks = awrWeeksFromShifts(
      [at("2026-11-04T08:00:00Z"), at("2026-11-06T08:00:00Z"), at("2026-11-19T08:00:00Z")],
      "2026-11-19",
    );
    expect(weeks).toEqual([
      { week: "2026-11-04", kind: "worked" },
      { week: "2026-11-11", kind: "break", reason: "none" },
      { week: "2026-11-18", kind: "worked" },
    ]);
  });

  it("counts a Sunday and the Monday after as one week when the first shift was on a Sunday", () => {
    expect(
      awrWeeksFromShifts([at("2026-11-08T08:00:00Z"), at("2026-11-09T08:00:00Z")], "2026-11-09"),
    ).toEqual([{ week: "2026-11-08", kind: "worked" }]);
  });

  it("uses UK dates: 23:30 BST on a Sunday is that Sunday", () => {
    expect(awrWeeksFromShifts([at("2026-07-05T22:30:00Z")], "2026-07-05")).toEqual([
      { week: "2026-07-05", kind: "worked" },
    ]);
  });

  it("never counts a booking that has not started by the date", () => {
    expect(
      awrWeeksFromShifts([at("2026-11-02T08:00:00Z"), at("2026-12-02T08:00:00Z")], "2026-11-02"),
    ).toEqual([{ week: "2026-11-02", kind: "worked" }]);
    expect(awrWeeksFromShifts([at("2026-12-02T08:00:00Z")], "2026-11-02")).toEqual([]);
  });

  it("runs the breaks on to the date asked", () => {
    expect(awrWeeksFromShifts([at("2026-11-02T08:00:00Z")], "2026-11-16").length).toBe(3);
  });

  it("gives no weeks without a booking", () => {
    expect(awrWeeksFromShifts([], "2026-11-16")).toEqual([]);
  });

  it("feeds the slice 6 clock: twelve weeks in a row qualify", () => {
    const rates = resolvePayRates(readRateTable(), "england", "2026-11-02", null);
    const starts = Array.from({ length: rates.awrQualifyingWeeks }, (_, i) =>
      at(new Date(Date.UTC(2026, 10, 2 + i * 7, 8)).toISOString()),
    );
    const last = ukDate(starts.at(-1) as Date);
    const clock = awrClock(awrWeeksFromShifts(starts, last), rates);
    expect(clock.qualifyingWeeks).toBe(rates.awrQualifyingWeeks);
    expect(clock.qualifiedFromWeek).not.toBeNull();
  });
});

describe("the access window a booked shift opens (ADR-0088)", () => {
  const day = { start: at("2026-11-02T08:00:00Z"), end: at("2026-11-02T20:00:00Z") };
  it.each([
    ["before the shift", "2026-11-02T07:59:00Z", null],
    ["at the start", "2026-11-02T08:00:00Z", "2026-11-02T22:00:00.000Z"],
    ["in the hours after", "2026-11-02T21:59:00Z", "2026-11-02T22:00:00.000Z"],
    ["when the hours after are over", "2026-11-02T22:00:00Z", null],
  ] as const)("%s", (_, now, until) => {
    const window = agencyAccessWindow([day], at(now), 2);
    expect(window?.end.toISOString() ?? null).toBe(until);
  });

  it("takes the longest of back-to-back shifts", () => {
    const night = { start: at("2026-11-02T20:00:00Z"), end: at("2026-11-03T08:00:00Z") };
    expect(agencyAccessWindow([day, night], at("2026-11-02T21:00:00Z"), 2)?.end.toISOString()).toBe(
      "2026-11-03T10:00:00.000Z",
    );
  });

  it.each([
    [
      "the night the clocks go back",
      "2026-10-24T19:00:00Z",
      "2026-10-25T08:00:00Z",
      "2026-10-25T09:59:00Z",
      true,
    ],
    [
      "the night the clocks go forward",
      "2027-03-27T20:00:00Z",
      "2027-03-28T07:00:00Z",
      "2027-03-28T09:00:00Z",
      false,
    ],
  ] as const)("measures the window in real time on %s", (_, start, end, now, open) => {
    expect(agencyAccessWindow([{ start: at(start), end: at(end) }], at(now), 2) !== null).toBe(
      open,
    );
  });

  it("gives nothing with no booking", () => {
    expect(agencyAccessWindow([], at("2026-11-02T12:00:00Z"), 2)).toBeNull();
  });
});

describe("break reasons and role changes on the AWR clock (H-924 recommended answer)", () => {
  const rates = resolvePayRates(readRateTable(), "england", "2026-10-31", null);
  // Weeks run from Monday 5 January 2026, the first shift.
  const first = at("2026-01-05T08:00:00Z");
  const after = (weeksOn: number) => at(`${addDays("2026-01-05", weeksOn * 7)}T08:00:00Z`);
  function addDays(d: string, n: number) {
    const x = new Date(`${d}T00:00:00Z`);
    x.setUTCDate(x.getUTCDate() + n);
    return x.toISOString().slice(0, 10);
  }

  it.each([
    ["no reason recorded: uncovered, a long break resets", [], 1],
    [
      "sickness covering every day of the break: the clock pauses",
      [{ from: "2026-01-12", to: addDays("2026-01-12", 10 * 7 - 1), reason: "sickness" as const }],
      2,
    ],
    [
      "a week only partly covered: uncovered, it resets",
      [{ from: "2026-01-13", to: addDays("2026-01-12", 10 * 7 - 1), reason: "sickness" as const }],
      1,
    ],
    [
      "maternity leave counts as weeks worked (reg 7(6))",
      [
        {
          from: "2026-01-12",
          to: addDays("2026-01-12", 10 * 7 - 1),
          reason: "protected_leave" as const,
        },
      ],
      12,
    ],
  ] as const)("%s", (_, records, qualifying) => {
    // Worked in week 0, a ten-week break, worked again in week 11.
    const weeks = awrWeeksFromShifts([first, after(11)], addDays("2026-01-05", 11 * 7), [
      ...records,
    ]);
    expect(awrClock(weeks, rates).qualifyingWeeks).toBe(qualifying);
  });

  it("restarts the clock in the week a new role was notified in writing (reg 7(3))", () => {
    const starts = [0, 1, 2, 3].map(after);
    const weeks = awrWeeksFromShifts(starts, addDays("2026-01-05", 3 * 7), [], ["2026-01-21"]);
    expect(weeks.filter((w) => w.kind === "worked" && w.newRole).map((w) => w.week)).toEqual([
      "2026-01-19",
    ]);
    const clock = awrClock(weeks, rates);
    expect(clock.qualifyingWeeks).toBe(2);
    expect(clock.resets).toEqual([{ week: "2026-01-19", reason: "new_role" }]);
  });
});

describe("hazard HZ-006 offline entries from a closed agency window (H-921 recommended answer)", () => {
  const booking = { start: at("2026-11-02T08:00:00Z"), end: at("2026-11-02T20:00:00Z") };
  it.each([
    [
      "recorded and uploaded in the window",
      "2026-11-02T12:00:00Z",
      "2026-11-02T13:00:00Z",
      { accept: true, late: false },
    ],
    [
      "uploaded after the window, within the grace period",
      "2026-11-02T12:00:00Z",
      "2026-11-05T21:59:00Z",
      { accept: true, late: true },
    ],
    [
      "uploaded after the grace period",
      "2026-11-02T12:00:00Z",
      "2026-11-05T22:00:00Z",
      { accept: false, reason: "upload_grace_ended" },
    ],
    [
      "recorded outside any booking",
      "2026-11-02T07:00:00Z",
      "2026-11-02T13:00:00Z",
      { accept: false, reason: "outside_booking" },
    ],
    [
      "recorded in the post-shift hours",
      "2026-11-02T21:30:00Z",
      "2026-11-03T10:00:00Z",
      { accept: true, late: true },
    ],
  ] as const)("hazard HZ-006 %s", (_, recorded, now, decision) => {
    expect(agencyUploadDecision([booking], at(recorded), at(now), 2, 72)).toEqual(decision);
  });
});
