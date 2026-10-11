import { describe, expect, it } from "vitest";
import { readRateTable } from "../../test/rate-table";
import {
  type BreakGlassEventView,
  breakGlassReportWeek,
  breakGlassWeeklyReport,
  previousBreakGlassReportWeek,
} from "./break-glass-report";
import { resolvePeopleRates } from "./rates";

const threshold = resolvePeopleRates(
  readRateTable(),
  "england",
  "2026-10-11",
  null,
).breakGlassRepeatThreshold;

// The week containing the autumn clock change: Monday 19 October 00:00 BST to Monday 26 October 00:00 GMT.
const WEEK = { start: new Date("2026-10-18T23:00:00Z"), end: new Date("2026-10-26T00:00:00Z") };

let sequence = 0;
function event(
  tenantUserId: string,
  personId: string,
  openedAt: string,
  extra: Partial<BreakGlassEventView> = {},
): BreakGlassEventView {
  sequence += 1;
  return {
    id: `bg-${String(sequence).padStart(2, "0")}`,
    tenantUserId,
    personId,
    reasonCode: "emergency_care",
    openedAt: new Date(openedAt),
    reviewedAt: new Date("2026-10-26T09:00:00Z"),
    ...extra,
  };
}

describe("report week", () => {
  it.each<[string, string, string, string]>([
    [
      "a Wednesday in summer time",
      "2026-10-21T12:00:00Z",
      "2026-10-18T23:00:00.000Z",
      "2026-10-26T00:00:00.000Z",
    ],
    [
      "the first minute of Monday in summer time",
      "2026-10-18T23:00:00Z",
      "2026-10-18T23:00:00.000Z",
      "2026-10-26T00:00:00.000Z",
    ],
    [
      "the last minute of Sunday after the clocks go back",
      "2026-10-25T23:59:00Z",
      "2026-10-18T23:00:00.000Z",
      "2026-10-26T00:00:00.000Z",
    ],
    [
      "the Monday after",
      "2026-10-26T00:00:00Z",
      "2026-10-26T00:00:00.000Z",
      "2026-11-02T00:00:00.000Z",
    ],
    [
      "the week the clocks go forward",
      "2026-03-29T12:00:00Z",
      "2026-03-23T00:00:00.000Z",
      "2026-03-29T23:00:00.000Z",
    ],
  ])("runs Monday to Monday in UK time for %s", (_label, at, start, end) => {
    const week = breakGlassReportWeek(new Date(at));
    expect(week.start.toISOString()).toBe(start);
    expect(week.end.toISOString()).toBe(end);
  });

  it("reports the last complete week on Monday morning", () => {
    expect(previousBreakGlassReportWeek(new Date("2026-10-26T07:00:00Z"))).toEqual(WEEK);
  });
});

describe("hazard HZ-011 weekly break-glass report", () => {
  it("is empty for a quiet week", () => {
    expect(breakGlassWeeklyReport([], WEEK, threshold)).toEqual({
      week: WEEK,
      totalEvents: 0,
      distinctUsers: 0,
      distinctPeople: 0,
      unreviewedEventIds: [],
      byUser: [],
      byPerson: [],
      byReason: [],
      flagged: [],
    });
  });

  it("aggregates by user, person and reason and ignores other weeks", () => {
    const events = [
      event("user-a", "person-1", "2026-10-19T08:00:00Z"),
      event("user-a", "person-2", "2026-10-20T08:00:00Z", { reasonCode: "covering_another_area" }),
      event("user-b", "person-1", "2026-10-21T08:00:00Z", { reasonCode: null, reviewedAt: null }),
      event("user-b", "person-3", "2026-10-18T22:59:00Z"), // Sunday 23:59 BST, the week before
      event("user-c", "person-3", "2026-10-26T00:00:00Z"), // Monday 00:00 GMT, the week after
    ];
    const report = breakGlassWeeklyReport(events, WEEK, threshold);
    expect(report).toMatchObject({ totalEvents: 3, distinctUsers: 2, distinctPeople: 2 });
    expect(report.byUser.map((u) => [u.tenantUserId, u.events, u.people, u.unreviewed])).toEqual([
      ["user-a", 2, 2, 0],
      ["user-b", 1, 1, 1],
    ]);
    expect(report.byPerson.map((p) => [p.personId, p.events, p.users])).toEqual([
      ["person-1", 2, 2],
      ["person-2", 1, 1],
    ]);
    expect(report.byReason).toEqual([
      { reason: "covering_another_area", events: 1 },
      { reason: "emergency_care", events: 1 },
      { reason: "not_categorised", events: 1 },
    ]);
    expect(report.unreviewedEventIds).toEqual([events[2]?.id]);
  });

  it("flags a user who reaches the repeat threshold from the rate table", () => {
    const events = Array.from({ length: threshold }, (_, i) =>
      event("user-a", `person-${i}`, `2026-10-2${i % 6}T08:00:00Z`),
    );
    const report = breakGlassWeeklyReport(events, WEEK, threshold);
    expect(report.byUser[0]?.flags).toEqual(["repeated_use"]);
    expect(report.flagged).toEqual([
      {
        flag: "repeated_use",
        tenantUserId: "user-a",
        personId: null,
        count: threshold,
        eventIds: events.map((e) => e.id),
      },
    ]);
    const below = breakGlassWeeklyReport(events.slice(1), WEEK, threshold);
    expect(below.flagged).toEqual([]);
  });

  it("flags a user who opens the same person more than once", () => {
    const events = [
      event("user-a", "person-1", "2026-10-19T08:00:00Z"),
      event("user-a", "person-1", "2026-10-22T08:00:00Z"),
    ];
    const report = breakGlassWeeklyReport(events, WEEK, threshold);
    expect(report.flagged).toEqual([
      {
        flag: "same_person_repeatedly",
        tenantUserId: "user-a",
        personId: "person-1",
        count: 2,
        eventIds: events.map((e) => e.id),
      },
    ]);
  });

  it("flags a person opened by many different users", () => {
    const events = Array.from({ length: threshold }, (_, i) =>
      event(`user-${i}`, "person-9", "2026-10-20T08:00:00Z"),
    );
    const report = breakGlassWeeklyReport(events, WEEK, threshold);
    expect(report.byPerson[0]).toMatchObject({
      personId: "person-9",
      users: threshold,
      flags: ["opened_by_many"],
    });
    expect(report.flagged.map((f) => f.flag)).toEqual(["opened_by_many"]);
  });

  it("orders flags by kind, then count", () => {
    const events = [
      ...Array.from({ length: threshold }, (_, i) =>
        event("user-z", `person-${i}`, "2026-10-20T08:00:00Z"),
      ),
      event("user-y", "person-5", "2026-10-20T09:00:00Z"),
      event("user-y", "person-5", "2026-10-20T10:00:00Z"),
    ];
    const flags = breakGlassWeeklyReport(events, WEEK, threshold).flagged.map((f) => f.flag);
    expect(flags[0]).toBe("repeated_use");
    expect(flags).toContain("same_person_repeatedly");
  });

  it("orders flags of one kind by count, then by user and person", () => {
    const events = [
      event("user-b", "person-1", "2026-10-19T08:00:00Z"),
      event("user-b", "person-1", "2026-10-19T09:00:00Z"),
      event("user-b", "person-2", "2026-10-19T10:00:00Z"),
      event("user-b", "person-2", "2026-10-19T11:00:00Z"),
      event("user-a", "person-3", "2026-10-20T08:00:00Z"),
      event("user-a", "person-3", "2026-10-20T09:00:00Z"),
      event("user-a", "person-3", "2026-10-20T10:00:00Z"),
    ];
    const flagged = breakGlassWeeklyReport(events, WEEK, 10).flagged;
    expect(flagged.map((f) => [f.tenantUserId, f.personId, f.count])).toEqual([
      ["user-a", "person-3", 3],
      ["user-b", "person-1", 2],
      ["user-b", "person-2", 2],
    ]);
  });

  it("refuses a threshold that would flag every opening", () => {
    expect(() => breakGlassWeeklyReport([], WEEK, 1)).toThrow(RangeError);
    expect(() => breakGlassWeeklyReport([], WEEK, 2.5)).toThrow(RangeError);
  });
});
