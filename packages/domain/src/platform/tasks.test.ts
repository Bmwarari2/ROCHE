import { describe, expect, it } from "vitest";
import { formatUkDateTime } from "../shared/time";
import {
  checkTaskTransition,
  occurrences,
  RecurrenceError,
  type RecurrenceSeries,
  type TaskStatus,
  taskTimeState,
  validateRecurrence,
} from "./tasks";

const at = (iso: string) => new Date(iso);
const uk = (dates: Date[]) => dates.map(formatUkDateTime);

describe("task transitions", () => {
  it.each<[TaskStatus, TaskStatus, Record<string, unknown>, string | null]>([
    ["open", "done", {}, null],
    ["open", "in_progress", {}, null],
    ["in_progress", "open", {}, null],
    ["in_progress", "done", { evidenceRequired: true, evidenceId: "obs-1" }, null],
    ["open", "skipped", { reason: "Asleep, will try at 03:00" }, null],
    ["open", "cancelled", { reason: "Discharged" }, null],
    ["open", "skipped", {}, "reason_required"],
    ["open", "skipped", { reason: "  " }, "reason_required"],
    ["open", "cancelled", { reason: "no" }, "reason_required"],
    ["open", "done", { evidenceRequired: true }, "evidence_required"],
    ["done", "open", {}, "terminal"],
    ["skipped", "done", {}, "terminal"],
    ["cancelled", "in_progress", {}, "terminal"],
    ["open", "open", {}, "not_allowed"],
  ])("%s to %s with %o gives %s", (from, to, extra, expected) => {
    const result = checkTaskTransition(from, { to, ...extra });
    if (expected === null) expect(result).toEqual({ ok: true });
    else expect(result).toMatchObject({ ok: false, problem: expected });
  });

  it("explains every refusal in plain English", () => {
    const result = checkTaskTransition("open", { to: "skipped" });
    expect(result.ok ? "" : result.message).toBe("Say why the task was not done.");
  });
});

describe("hazard HZ-008 task timing escalates once, after a grace period", () => {
  const due = at("2026-11-02T02:00:00Z");
  it.each<[string, string, TaskStatus, string | null, string]>([
    ["before the window", "2026-11-02T01:00:00Z", "open", "2026-11-02T01:30:00Z", "upcoming"],
    ["inside the window", "2026-11-02T01:45:00Z", "open", "2026-11-02T01:30:00Z", "due"],
    ["at the due time", "2026-11-02T02:00:00Z", "open", null, "due"],
    ["one minute late", "2026-11-02T02:01:00Z", "open", null, "overdue"],
    ["just before escalation", "2026-11-02T02:29:00Z", "in_progress", null, "overdue"],
    ["at escalation", "2026-11-02T02:30:00Z", "open", null, "escalated"],
    ["done late", "2026-11-02T05:00:00Z", "done", null, "closed"],
    ["skipped", "2026-11-02T05:00:00Z", "skipped", null, "closed"],
  ])("%s", (_label, now, status, windowStart, expected) => {
    expect(
      taskTimeState(
        { status, dueAt: due, windowStart: windowStart ? at(windowStart) : null },
        at(now),
        30,
      ),
    ).toBe(expected);
  });

  it("uses the end of the window, not the due time, for lateness", () => {
    const task = {
      status: "open" as const,
      dueAt: at("2026-11-02T08:00:00Z"),
      windowEnd: at("2026-11-02T09:00:00Z"),
    };
    expect(taskTimeState(task, at("2026-11-02T08:59:00Z"), 30)).toBe("due");
    expect(taskTimeState(task, at("2026-11-02T09:10:00Z"), 30)).toBe("overdue");
  });
});

describe("hazard HZ-009 recurring tasks keep UK local times across clock changes", () => {
  it("falls due at 08:00 and 20:00 UK time before and after the October clock change", () => {
    const series: RecurrenceSeries = {
      rule: { freq: "daily", times: ["20:00", "08:00"] },
      startsOn: "2026-10-24",
    };
    const due = occurrences(series, at("2026-10-24T00:00:00Z"), at("2026-10-27T00:00:00Z"));
    expect(uk(due)).toEqual([
      "24/10/2026 08:00",
      "24/10/2026 20:00",
      "25/10/2026 08:00",
      "25/10/2026 20:00",
      "26/10/2026 08:00",
      "26/10/2026 20:00",
    ]);
    // 08:00 BST is 07:00 UTC; after the change 08:00 GMT is 08:00 UTC.
    expect(due[0]?.toISOString()).toBe("2026-10-24T07:00:00.000Z");
    expect(due[2]?.toISOString()).toBe("2026-10-25T08:00:00.000Z");
  });

  it("moves a time inside the spring-forward gap to the same time an hour later", () => {
    const due = occurrences(
      { rule: { freq: "daily", times: ["01:30"] }, startsOn: "2027-03-27" },
      at("2027-03-27T00:00:00Z"),
      at("2027-03-29T00:00:00Z"),
    );
    expect(uk(due)).toEqual(["27/03/2027 01:30", "28/03/2027 02:30"]);
  });

  it("counts every_hours in real elapsed hours, so a 4-hourly turn stays 4 hours apart", () => {
    const due = occurrences(
      { rule: { freq: "every_hours", hours: 4, anchorTime: "22:00" }, startsOn: "2026-10-24" },
      at("2026-10-24T20:00:00Z"),
      at("2026-10-25T12:00:00Z"),
    );
    const gaps = due.slice(1).map((d, i) => (d.getTime() - (due[i] as Date).getTime()) / 3_600_000);
    expect(gaps.every((g) => g === 4)).toBe(true);
    expect(uk(due)).toEqual([
      "24/10/2026 22:00",
      // 4 hours after 22:00 BST is 01:00 GMT: the clocks went back at 02:00 BST.
      "25/10/2026 01:00",
      "25/10/2026 05:00",
      "25/10/2026 09:00",
    ]);
  });
});

describe("recurrence rules", () => {
  it("repeats every other day from the start date", () => {
    const due = occurrences(
      { rule: { freq: "daily", interval: 2, times: ["09:00"] }, startsOn: "2026-11-02" },
      at("2026-11-01T00:00:00Z"),
      at("2026-11-08T00:00:00Z"),
    );
    expect(uk(due)).toEqual(["02/11/2026 09:00", "04/11/2026 09:00", "06/11/2026 09:00"]);
  });

  it("repeats on chosen weekdays every other week", () => {
    const due = occurrences(
      {
        rule: { freq: "weekly", interval: 2, weekdays: ["mon", "thu"], times: ["10:00"] },
        startsOn: "2026-11-04",
      },
      at("2026-11-01T00:00:00Z"),
      at("2026-11-30T00:00:00Z"),
    );
    expect(uk(due)).toEqual(["05/11/2026 10:00", "16/11/2026 10:00", "19/11/2026 10:00"]);
  });

  it("falls on the last day of shorter months", () => {
    const due = occurrences(
      { rule: { freq: "monthly", dayOfMonth: 31, times: ["07:00"] }, startsOn: "2027-01-31" },
      at("2027-01-01T00:00:00Z"),
      at("2027-05-01T00:00:00Z"),
    );
    expect(uk(due)).toEqual([
      "31/01/2027 07:00",
      "28/02/2027 07:00",
      "31/03/2027 07:00",
      "30/04/2027 07:00",
    ]);
  });

  it("repeats every three months for quarterly reviews", () => {
    const due = occurrences(
      {
        rule: { freq: "monthly", interval: 3, dayOfMonth: 15, times: ["09:00"] },
        startsOn: "2026-11-15",
      },
      at("2026-11-01T00:00:00Z"),
      at("2027-06-01T00:00:00Z"),
    );
    expect(uk(due)).toEqual(["15/11/2026 09:00", "15/02/2027 09:00", "15/05/2027 09:00"]);
  });

  it("stops after the end date and never before the start date", () => {
    const due = occurrences(
      { rule: { freq: "daily", times: ["12:00"] }, startsOn: "2026-11-03", endsOn: "2026-11-04" },
      at("2026-11-01T00:00:00Z"),
      at("2026-11-10T00:00:00Z"),
    );
    expect(uk(due)).toEqual(["03/11/2026 12:00", "04/11/2026 12:00"]);
  });

  it("treats the window as half-open", () => {
    const series: RecurrenceSeries = {
      rule: { freq: "daily", times: ["12:00"] },
      startsOn: "2026-11-03",
    };
    expect(
      occurrences(series, at("2026-11-03T12:00:00Z"), at("2026-11-04T12:00:00Z")),
    ).toHaveLength(1);
  });

  it.each<[string, RecurrenceSeries, string]>([
    ["a bad time", { rule: { freq: "daily", times: ["25:00"] }, startsOn: "2026-11-01" }, "HH:MM"],
    [
      "no times",
      { rule: { freq: "daily", times: [] }, startsOn: "2026-11-01" },
      "at least one time",
    ],
    [
      "a zero interval",
      { rule: { freq: "daily", interval: 0, times: ["09:00"] }, startsOn: "2026-11-01" },
      "whole number",
    ],
    [
      "no weekdays",
      { rule: { freq: "weekly", weekdays: [], times: ["09:00"] }, startsOn: "2026-11-01" },
      "day of the week",
    ],
    [
      "day 32",
      { rule: { freq: "monthly", dayOfMonth: 32, times: ["09:00"] }, startsOn: "2026-11-01" },
      "1 to 31",
    ],
    [
      "a 30-hour interval",
      { rule: { freq: "every_hours", hours: 30, anchorTime: "09:00" }, startsOn: "2026-11-01" },
      "1 to 24",
    ],
    [
      "an unreal date",
      { rule: { freq: "daily", times: ["09:00"] }, startsOn: "2026-02-30" },
      "real date",
    ],
    [
      "an end before the start",
      { rule: { freq: "daily", times: ["09:00"] }, startsOn: "2026-11-05", endsOn: "2026-11-01" },
      "ends before",
    ],
  ])("refuses %s", (_label, series, message) => {
    expect(() => validateRecurrence(series)).toThrow(message);
    expect(() => validateRecurrence(series)).toThrow(RecurrenceError);
  });

  it("refuses a window that would produce too many occurrences", () => {
    expect(() =>
      occurrences(
        { rule: { freq: "every_hours", hours: 1, anchorTime: "00:00" }, startsOn: "2026-01-01" },
        at("2026-01-01T00:00:00Z"),
        at("2026-12-31T00:00:00Z"),
      ),
    ).toThrow(RecurrenceError);
  });
});
