import { describe, expect, it } from "vitest";
import { formatUkDateTime } from "../shared/time";
import {
  catchUpTiming,
  checkTaskEvidence,
  checkTaskLink,
  checkTaskTransition,
  entryPermissionTime,
  hasOccurrence,
  isEvidenceFor,
  listMissedRounds,
  type MissedRound,
  occurrences,
  planTaskRestore,
  RecurrenceError,
  type RecurrenceSeries,
  restoreLookbackStart,
  type StoppedTask,
  type TaskLinkCheck,
  type TaskLinkOutcome,
  type TaskLinkReview,
  type TaskRestorePlan,
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

describe("hazards HZ-004 and HZ-006 what an entry does to the task it names", () => {
  const task = (
    kind: string,
    status: TaskStatus,
    personId: string | null = "p1",
    evidenceId: string | null = null,
  ) => ({ personId, kind, status, evidenceId });
  const kept = (outcome: TaskLinkOutcome, review: TaskLinkReview): TaskLinkCheck => ({
    ok: true,
    outcome,
    review,
    completes: false,
  });
  it.each<[string, ReturnType<typeof task>, boolean, ReturnType<typeof checkTaskLink>]>([
    [
      "completes an open round",
      task("care.reposition", "open"),
      true,
      { ok: true, outcome: "completed", review: "none", completes: true },
    ],
    [
      "completes a round in progress",
      task("care.reposition", "in_progress"),
      true,
      { ok: true, outcome: "completed", review: "none", completes: true },
    ],
    [
      "keeps the entry as late evidence for a cancelled round",
      task("care.reposition", "cancelled"),
      true,
      kept("task_cancelled", "none"),
    ],
    [
      "keeps a second entry for a cancelled round that already has evidence, for review (C4)",
      task("care.reposition", "cancelled", "p1", "e1"),
      true,
      kept("task_already_closed", "review"),
    ],
    [
      "keeps an entry for a round already done, flagged for review",
      task("care.reposition", "done"),
      true,
      kept("task_already_closed", "review"),
    ],
    [
      "keeps an entry for a round already skipped, flagged for review",
      task("care.reposition", "skipped"),
      true,
      kept("task_already_closed", "review"),
    ],
    [
      "keeps an entry for a round the user may not complete, unlinked and flagged",
      task("care.reposition", "open"),
      false,
      kept("not_linked", "review"),
    ],
    [
      "keeps a medicines entry by someone who may not complete the task, with an urgent conflict review",
      task("medicines.round", "open"),
      false,
      kept("medicines_conflict", "urgent"),
    ],
    [
      "keeps a medicines entry for a task already done (a second dose?), with an urgent conflict review",
      task("medicines.round", "done"),
      true,
      kept("medicines_conflict", "urgent"),
    ],
    [
      "keeps a medicines entry for a task already skipped, with an urgent conflict review",
      task("medicines.round", "skipped"),
      true,
      kept("medicines_conflict", "urgent"),
    ],
    [
      "keeps a second medicines entry for a cancelled task that already has evidence, urgently (C4)",
      task("medicines.round", "cancelled", "p1", "e1"),
      true,
      kept("medicines_conflict", "urgent"),
    ],
    [
      "keeps a medicines entry for a task the move cancelled as late evidence",
      task("medicines.round", "cancelled"),
      true,
      kept("task_cancelled", "none"),
    ],
    [
      "refuses a task for another person (HZ-001)",
      task("care.reposition", "open", "p2"),
      true,
      { ok: false, problem: "wrong_person", message: "That task is not for this person." },
    ],
  ])("hazard HZ-004 %s", (_label, t, mayComplete, expected) => {
    expect(checkTaskLink(t, { personId: "p1", mayComplete })).toEqual(expected);
  });

  it.each([
    [
      "a note, for a task that needs evidence",
      "care.plan_action",
      true,
      { table: "care_note" },
      false,
    ],
    [
      "the chart it names",
      "repositioning",
      true,
      { table: "observation", chart: "repositioning" },
      true,
    ],
    [
      "another chart",
      "repositioning",
      true,
      { table: "observation", chart: "fluid_intake" },
      false,
    ],
    ["a body map mark, for a chart's task", "vitals", true, { table: "body_map_mark" }, false],
    [
      "a recording entry, for a plan's task",
      "care.plan_action",
      true,
      { table: "observation", chart: "food" },
      true,
    ],
    [
      "a note, for a task that needs no evidence",
      "care.reposition",
      false,
      { table: "care_note" },
      true,
    ],
    ["an entry of unknown kind (an older caller)", "repositioning", true, undefined, true],
  ] as const)(
    "hazard HZ-029 only the entry a task asks for completes it: %s (#123 clinical review, M3)",
    (_label, kind, evidenceRequired, evidence, completes) => {
      expect(isEvidenceFor({ kind, evidenceRequired }, evidence)).toBe(completes);
      const check = checkTaskLink(
        { personId: "p1", kind, status: "open", evidenceRequired },
        { personId: "p1", mayComplete: true, evidence },
      );
      expect(check).toEqual(
        completes
          ? { ok: true, outcome: "completed", review: "none", completes: true }
          : { ok: true, outcome: "not_linked", review: "review", completes: false },
      );
    },
  );

  it("never completes a task except with the outcome completed", () => {
    for (const status of ["open", "done", "skipped", "cancelled"] as const) {
      for (const mayComplete of [true, false]) {
        const check = checkTaskLink(task("medicines.round", status), {
          personId: "p1",
          mayComplete,
        });
        if (check.ok) expect(check.completes).toBe(check.outcome === "completed");
      }
    }
  });
});

describe("hazards HZ-003 and HZ-004 tasks brought back after a return or a correction", () => {
  const at = (hhmm: string) => new Date(`2026-10-10T${hhmm}:00Z`);
  const stopped = (
    id: string,
    due: string,
    options: {
      series?: string | null;
      windowEnd?: string;
      evidence?: boolean;
      kind?: string;
    } = {},
  ): StoppedTask => ({
    id,
    seriesId: options.series === undefined ? "turns" : options.series,
    kind: options.kind ?? "care.reposition",
    dueAt: at(due),
    windowEnd: options.windowEnd ? at(options.windowEnd) : null,
    hasEvidence: options.evidence ?? false,
  });

  it.each<[string, StoppedTask[], string, string, Partial<TaskRestorePlan>]>([
    [
      "restores a round answered offline as done, not due again (10:05 entry, 10:10 turn)",
      [stopped("t1010", "10:10", { windowEnd: "10:40", evidence: true })],
      "10:08",
      "10:20",
      { done: ["t1010"], reopen: [], reopenOverdue: [], missed: [] },
    ],
    [
      "restores an answered round as done even when its window has passed",
      [stopped("t1010", "10:10", { evidence: true })],
      "10:08",
      "11:20",
      { done: ["t1010"], reopenOverdue: [], missed: [] },
    ],
    [
      "reopens a round still in its window",
      [stopped("t1200", "12:00", { windowEnd: "12:30" })],
      "10:00",
      "12:10",
      { reopen: ["t1200"], reopenOverdue: [], missed: [] },
    ],
    [
      "reopens a round due just before the return but still in its window",
      [stopped("t1300", "13:00", { windowEnd: "14:00" })],
      "13:30",
      "13:35",
      { reopen: ["t1300"] },
    ],
    [
      "leaves a round whose window closed before the return as it was",
      [stopped("t0900", "09:00", { windowEnd: "09:30" })],
      "10:00",
      "10:05",
      { done: [], reopen: [], reopenOverdue: [], missed: [] },
    ],
    [
      "reopens the latest missed round of a series as overdue and codes the earlier ones missed",
      [stopped("t1000", "10:00"), stopped("t1100", "11:00"), stopped("t1200", "12:00")],
      "09:30",
      "12:30",
      { reopen: [], reopenOverdue: ["t1200"], missed: ["t1000", "t1100"] },
    ],
    [
      "catches up each series once, and each one-off task",
      [
        stopped("turn10", "10:00"),
        stopped("turn11", "11:00"),
        stopped("fluid10", "10:00", { series: "fluids" }),
        stopped("weight", "10:30", { series: null }),
      ],
      "09:30",
      "12:00",
      { reopenOverdue: ["turn11", "fluid10", "weight"], missed: ["turn10"] },
    ],
    [
      "does not catch up a series whose later occurrence was done",
      [stopped("t1000", "10:00"), stopped("t1100", "11:00", { evidence: true })],
      "09:30",
      "12:00",
      { done: ["t1100"], reopenOverdue: [], missed: ["t1000"] },
    ],
    [
      "does not catch up a series whose later occurrence is open again (turns at 08:00 and 12:00, corrected at 12:10; C1)",
      [
        stopped("t0800", "08:00", { windowEnd: "09:00" }),
        stopped("t1200", "12:00", { windowEnd: "13:00" }),
      ],
      "07:30",
      "12:10",
      { reopen: ["t1200"], reopenOverdue: [], missed: ["t0800"] },
    ],
    [
      "makes only the dose still in its window due (paracetamol at 08:00 and 12:00, corrected at 12:10; C1)",
      [
        stopped("p0800", "08:00", {
          series: "paracetamol",
          windowEnd: "09:00",
          kind: "medicines.round",
        }),
        stopped("p1200", "12:00", {
          series: "paracetamol",
          windowEnd: "13:00",
          kind: "medicines.round",
        }),
      ],
      "07:30",
      "12:10",
      { reopen: ["p1200"], reopenOverdue: [], missed: ["p0800"] },
    ],
    [
      "never makes a missed medicines dose due again: it is listed for the nurse in charge (C1)",
      [
        stopped("m0800", "08:00", {
          series: "insulin",
          windowEnd: "08:30",
          kind: "medicines.round",
        }),
        stopped("m1200", "12:00", {
          series: "insulin",
          windowEnd: "12:30",
          kind: "medicines.round",
        }),
      ],
      "07:30",
      "13:00",
      { reopen: [], reopenOverdue: [], missed: ["m0800", "m1200"] },
    ],
    [
      "still reopens a medicines dose in its window",
      [
        stopped("m1200", "12:00", {
          series: "insulin",
          windowEnd: "12:30",
          kind: "medicines.round",
        }),
      ],
      "11:00",
      "12:10",
      { reopen: ["m1200"], reopenOverdue: [], missed: [] },
    ],
  ])("hazard HZ-003 %s", (_label, tasks, since, now, expected) => {
    expect(planTaskRestore(tasks, at(since), at(now))).toMatchObject(expected);
  });

  it("hazard HZ-008 gives a caught-up round a fresh window as long as its own, so it does not escalate at once", () => {
    const now = at("12:30");
    expect(
      catchUpTiming({ dueAt: at("10:00"), windowStart: at("09:45"), windowEnd: at("10:30") }, now),
    ).toEqual({ dueAt: now, windowStart: now, windowEnd: at("13:15") });
    expect(catchUpTiming({ dueAt: at("10:00"), windowStart: null, windowEnd: null }, now)).toEqual({
      dueAt: now,
      windowStart: now,
      windowEnd: now,
    });
  });
});

describe("hazards HZ-003 and HZ-008 the rounds a missed-rounds review lists", () => {
  const round = (taskId: string, kind: string, hhmm: string, reopened = false): MissedRound => ({
    taskId,
    kind,
    dueAt: `2026-10-11T${hhmm}:00.000Z`,
    reopened,
  });
  const turn = (id: string, hhmm: string) => round(id, "care.reposition", hhmm);
  const dose = (id: string, hhmm: string) => round(id, "medicines.round", hhmm);

  it.each<[string, MissedRound[], MissedRound[], number, string[], number]>([
    [
      "lists medicines rounds first, then the rest, each newest first",
      [],
      [turn("t1", "08:00"), dose("m1", "07:00"), turn("t2", "10:00"), dose("m2", "09:00")],
      50,
      ["m2", "m1", "t2", "t1"],
      0,
    ],
    [
      "keeps the newest of the rest and counts the older ones it cannot list",
      [],
      [turn("t1", "08:00"), turn("t2", "09:00"), turn("t3", "10:00"), dose("m1", "07:00")],
      3,
      ["m1", "t3", "t2"],
      1,
    ],
    [
      "never drops a missed dose, even beyond the limit, and counts only the rest",
      [],
      [dose("m1", "07:00"), dose("m2", "08:00"), dose("m3", "09:00"), turn("t1", "10:00")],
      2,
      ["m3", "m2", "m1"],
      1,
    ],
    [
      "merges with the rounds already listed, keeping the newest",
      [turn("t1", "08:00"), turn("t2", "09:00")],
      [turn("t3", "10:00"), dose("m1", "07:00")],
      3,
      ["m1", "t3", "t2"],
      1,
    ],
    [
      "lists a round found twice once, as last found",
      [turn("t1", "08:00")],
      [round("t1", "care.reposition", "08:00", true)],
      50,
      ["t1"],
      0,
    ],
  ])("%s", (_label, listed, found, limit, expected, omitted) => {
    const result = listMissedRounds(listed, found, limit);
    expect(result.items.map((r) => r.taskId)).toEqual(expected);
    expect(result.omitted).toBe(omitted);
  });

  it("keeps the last state of a round found twice", () => {
    const { items } = listMissedRounds(
      [turn("t1", "08:00")],
      [round("t1", "care.reposition", "08:00", true)],
      50,
    );
    expect(items[0]?.reopened).toBe(true);
  });

  it.each([
    ["in summer time", "2026-10-11T12:00:00Z", "2026-10-03T23:00:00.000Z"],
    ["just after midnight UK time", "2026-10-11T23:30:00Z", "2026-10-04T23:00:00.000Z"],
    ["across the change to winter time", "2026-10-28T10:00:00Z", "2026-10-20T23:00:00.000Z"],
    ["in winter time", "2026-12-15T09:00:00Z", "2026-12-08T00:00:00.000Z"],
  ])("hazard HZ-003 starts the seven-day look back at 00:00 UK time %s", (_label, now, start) => {
    expect(restoreLookbackStart(new Date(now), 7).toISOString()).toBe(start);
  });
});

describe("hazard HZ-003 whether a stopped series had rounds before the look back", () => {
  const hourly: RecurrenceSeries = {
    rule: { freq: "every_hours", hours: 1, anchorTime: "00:00" },
    startsOn: "2026-01-01",
  };
  const weekly: RecurrenceSeries = {
    rule: { freq: "weekly", weekdays: ["mon"], times: ["09:00"] },
    startsOn: "2026-01-01",
  };

  it.each<[string, RecurrenceSeries, string, string, boolean]>([
    [
      "an hourly round over months, past the occurrence limit",
      hourly,
      "2026-03-01",
      "2026-09-01",
      true,
    ],
    ["a weekly round over a long window", weekly, "2026-06-01T10:00:00Z", "2026-09-01", true],
    ["a weekly round with no Monday in the window", weekly, "2026-09-01", "2026-09-07", false],
    ["an empty window", hourly, "2026-09-01", "2026-09-01", false],
    [
      "a series that starts after the window",
      { ...hourly, startsOn: "2026-10-01" },
      "2026-03-01",
      "2026-09-01",
      false,
    ],
  ])("%s", (_label, series, from, to, expected) => {
    expect(hasOccurrence(series, new Date(from), new Date(to))).toBe(expected);
  });
});

describe("hazards HZ-004 and HZ-006 when permission for an entry is judged", () => {
  const at = (hhmm: string) => new Date(`2026-10-11T${hhmm}:00.000Z`);
  it.each([
    ["when the care was recorded, after the task was made", "18:00", "08:00", "20:00", "18:00"],
    [
      "no earlier than when the task was made (a backdated entry)",
      "06:00",
      "08:00",
      "20:00",
      "08:00",
    ],
    ["no later than the server's clock (a fast device clock)", "20:03", "08:00", "20:00", "20:00"],
  ])("%s", (_label, occurred, created, now, expected) => {
    expect(entryPermissionTime(at(occurred), at(created), at(now))).toEqual(at(expected));
  });
});

describe("checkTaskEvidence (a task completed directly with a cited record; HZ-029)", () => {
  const news2 = { personId: "p1", kind: "news2_response", evidenceRequired: true };
  const turns = { personId: "p1", kind: "repositioning", evidenceRequired: true };
  const reminder = { personId: "p1", kind: "manual", evidenceRequired: false };
  const entry = (personId: string, chart?: string) => ({ personId, chart: chart ?? null });

  it.each<
    [
      string,
      Parameters<typeof checkTaskEvidence>[0],
      Parameters<typeof checkTaskEvidence>[1],
      string | null,
    ]
  >([
    [
      "an observation for a NEWS2 task",
      news2,
      { type: "observation", id: "e1", found: entry("p1", "vitals") },
      null,
    ],
    [
      "a note for a NEWS2 task",
      news2,
      { type: "care_note", id: "e1", found: entry("p1") },
      "evidence_not_accepted",
    ],
    [
      "the chart a chart's task names",
      turns,
      { type: "observation", id: "e1", found: entry("p1", "repositioning") },
      null,
    ],
    [
      "another chart for a chart's task",
      turns,
      { type: "observation", id: "e1", found: entry("p1", "fluid_intake") },
      "evidence_not_accepted",
    ],
    [
      "an entry about another person",
      news2,
      { type: "observation", id: "e1", found: entry("p2", "vitals") },
      "evidence_wrong_person",
    ],
    [
      "an entry nobody can find (missing, another home's or organisation's)",
      news2,
      { type: "observation", id: "e1", found: null },
      "evidence_not_found",
    ],
    [
      "a type that is not evidence",
      news2,
      { type: "statutory_notification", id: "e1", found: entry("p1") },
      "evidence_not_accepted",
    ],
    ["an id without its type", news2, { type: null, id: "e1", found: null }, "evidence_incomplete"],
    [
      "a note for a task that needs no evidence",
      reminder,
      { type: "care_note", id: "e1", found: entry("p1") },
      null,
    ],
    [
      "a note about another person, for a task that needs no evidence",
      reminder,
      { type: "care_note", id: "e1", found: entry("p2") },
      "evidence_wrong_person",
    ],
    [
      "an entry for a task about nobody",
      { ...reminder, personId: null },
      { type: "care_note", id: "e1", found: entry("p1") },
      "evidence_wrong_person",
    ],
  ])("hazard HZ-029 %s", (_label, task, cited, expected) => {
    expect(checkTaskEvidence(task, cited)).toBe(expected);
  });

  it("follows isEvidenceFor (#123): a task that needs no evidence takes any entry", () => {
    expect(
      isEvidenceFor({ kind: "news2_response", evidenceRequired: false }, { table: "care_note" }),
    ).toBe(true);
    expect(
      isEvidenceFor({ kind: "vitals", evidenceRequired: true }, { table: "body_map_mark" }),
    ).toBe(false);
  });
});
