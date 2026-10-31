import { describe, expect, it } from "vitest";
import { t } from "./i18n";
import {
  isOpen,
  isReviewTask,
  onlyReviews,
  readNewTask,
  readTaskReason,
  shownCount,
  sortTasks,
  splitByWindow,
  taskChip,
  taskStateOf,
  tasksHref,
  tasksQuery,
  taskWindow,
} from "./tasks";

const form = (values: Record<string, string>) => ({ get: (name: string) => values[name] ?? null });
const SELF = "0194d000-0000-7000-8000-000000000001";
/** 15:00 UK time on 01/12/2026 (GMT). */
const NOW = new Date("2026-12-01T15:00:00Z");
const due = (day: string, month: string, year: string, hour: string, minute: string) => ({
  "dueAt-day": day,
  "dueAt-month": month,
  "dueAt-year": year,
  "dueAt-hour": hour,
  "dueAt-minute": minute,
});

describe("task lists (PLAT-011)", () => {
  it("reads the list from the address, falling back to my open tasks", () => {
    expect(tasksQuery({})).toEqual({ view: "team", status: "open", range: "day", reviews: false });
    expect(tasksQuery({ view: "team", status: "closed", range: "week", reviews: "yes" })).toEqual({
      view: "team",
      status: "closed",
      range: "week",
      reviews: true,
    });
    expect(tasksQuery({ view: ["mine", "team"], status: "nonsense" })).toMatchObject({
      view: "mine",
      status: "open",
    });
  });

  it("writes the address with only what differs from the defaults", () => {
    const q = tasksQuery({});
    expect(tasksHref(q)).toBe("/tasks");
    expect(tasksHref(q, { view: "mine", reviews: true })).toBe("/tasks?view=mine&reviews=yes");
    expect(tasksHref(tasksQuery({ range: "week" }), { status: "closed" })).toBe(
      "/tasks?status=closed&range=week",
    );
  });

  it("asks for a day or a week either side, within the API's 31 days", () => {
    const day = taskWindow("day", NOW);
    expect(Date.parse(day.to) - Date.parse(day.from)).toBe(2 * 86_400_000);
    const week = taskWindow("week", NOW);
    expect(Date.parse(week.to) - Date.parse(week.from)).toBe(14 * 86_400_000);
  });

  it.each([
    ["care.entry_review", true],
    ["care.entry_conflict_review", true],
    ["people.late_entry_review", true],
    ["people.review.due", true],
    ["care.care_plan_review", true],
    ["platform.manual", false],
    ["medicines.round", false],
    ["care.reviewer_note", false],
  ])("hazard HZ-006 treats %s as a review: %s", (kind, review) => {
    expect(isReviewTask({ kind })).toBe(review);
  });

  it("narrows a list to its reviews", () => {
    expect(onlyReviews([{ kind: "care.entry_review" }, { kind: "platform.manual" }])).toEqual([
      { kind: "care.entry_review" },
    ]);
  });

  it.each([
    [{ status: "open", timeState: "upcoming" }, "upcoming", "Upcoming", "clock"],
    [{ status: "open", timeState: "due" }, "due", "Due", "clock"],
    [{ status: "in_progress", timeState: "due" }, "inProgress", "Started", "file-pen"],
    [{ status: "open", timeState: "overdue" }, "overdue", "Overdue", "circle-alert"],
    [
      { status: "open", timeState: "escalated" },
      "escalated",
      "Overdue: escalated",
      "triangle-alert",
    ],
    [{ status: "done", timeState: "closed" }, "done", "Done", "circle-check"],
    [{ status: "skipped", timeState: "closed" }, "skipped", "Not done", "circle-minus"],
    [{ status: "cancelled", timeState: "closed" }, "cancelled", "Cancelled", "circle-minus"],
  ] as const)(
    "says where a task stands with an icon and a word: %o",
    (task, state, label, icon) => {
      expect(taskStateOf(task)).toBe(state);
      expect(taskChip(task, t)).toMatchObject({ label, icon });
    },
  );

  it("warns for a state it does not know, never reading as calm", () => {
    const chip = taskChip({ status: "open", timeState: "closed" }, t);
    expect(chip.status).toBe("overdue");
    expect(chip.label).toMatch(/^Unknown/);
  });

  it("offers actions only on open tasks", () => {
    expect(isOpen({ status: "open" })).toBe(true);
    expect(isOpen({ status: "in_progress" })).toBe(true);
    expect(isOpen({ status: "done" })).toBe(false);
  });

  it("puts escalated and overdue tasks first, then by due time", () => {
    const at = (h: number) => `2026-12-01T${String(h).padStart(2, "0")}:00:00Z`;
    const sorted = sortTasks([
      { id: "a", status: "open", timeState: "upcoming", dueAt: at(9) },
      { id: "b", status: "done", timeState: "closed", dueAt: at(1) },
      { id: "c", status: "open", timeState: "overdue", dueAt: at(8) },
      { id: "d", status: "open", timeState: "escalated", dueAt: at(10) },
      { id: "e", status: "open", timeState: "due", dueAt: at(7) },
      { id: "f", status: "open", timeState: "due", dueAt: at(6) },
    ] as const);
    expect(sorted.map((s) => s.id)).toEqual(["d", "c", "f", "e", "a", "b"]);
  });
});

describe("the new task form", () => {
  it("reads a one-off task in UK time", () => {
    const read = readNewTask(
      form({
        title: "Check the fire doors",
        ...due("02", "12", "2026", "09", "30"),
        urgent: "yes",
      }),
      t,
      { now: NOW, selfId: SELF },
    );
    expect(read).toEqual({
      ok: true,
      kind: "once",
      body: {
        title: "Check the fire doors",
        dueAt: "2026-12-02T09:30:00.000Z",
        priority: "urgent",
      },
    });
  });

  it("reads British Summer Time as UK time and assigns it to the manager when asked", () => {
    const read = readNewTask(
      form({ title: "Summer check", ...due("01", "07", "2027", "09", "00"), assignToMe: "yes" }),
      t,
      { now: NOW, selfId: SELF },
    );
    expect(read).toMatchObject({
      ok: true,
      body: { dueAt: "2027-07-01T08:00:00.000Z", assigneeTenantUserId: SELF, priority: "routine" },
    });
  });

  it("makes a repeating task a series from the due day, at the due time", () => {
    const daily = readNewTask(
      form({
        title: "Fridge temperatures",
        ...due("02", "12", "2026", "08", "00"),
        repeat: "daily",
      }),
      t,
      { now: NOW, selfId: SELF },
    );
    expect(daily).toMatchObject({
      ok: true,
      kind: "series",
      body: { startsOn: "2026-12-02", recurrence: { freq: "daily", times: ["08:00"] } },
    });
    const weekly = readNewTask(
      form({ title: "Weekly audit", ...due("04", "12", "2026", "14", "15"), repeat: "weekly" }),
      t,
      { now: NOW, selfId: SELF },
    );
    expect(weekly).toMatchObject({
      ok: true,
      body: { recurrence: { freq: "weekly", weekdays: ["fri"], times: ["14:15"] } },
    });
  });

  it("says what is wrong at each field", () => {
    const read = readNewTask(form({ title: "x" }), t, { now: NOW, selfId: SELF });
    expect(read.ok).toBe(false);
    if (read.ok) return;
    expect(Object.keys(read.errors).sort()).toEqual(["dueAt", "title"]);
    expect(read.parts?.dueAt).toBeDefined();
  });

  it("refuses a one-off task due in the past", () => {
    const read = readNewTask(
      form({ title: "Too late", ...due("30", "11", "2026", "09", "00") }),
      t,
      { now: NOW, selfId: SELF },
    );
    expect(read).toMatchObject({
      ok: false,
      errors: { dueAt: "Choose a time that has not passed yet." },
    });
  });

  it("needs a reason of 3 to 500 characters for a task not done or cancelled", () => {
    expect(readTaskReason(form({ reason: "no" }), t, "skip").ok).toBe(false);
    expect(readTaskReason(form({ reason: "x".repeat(501) }), t, "cancel").ok).toBe(false);
    expect(readTaskReason(form({ reason: " Out at hospital " }), t, "skip")).toEqual({
      ok: true,
      reason: "Out at hospital",
    });
  });
});

describe("hazard HZ-009 due times across the clock changes (UK time)", () => {
  const BEFORE_SPRING = new Date("2026-03-20T12:00:00Z");
  const BEFORE_AUTUMN = new Date("2026-10-20T12:00:00Z");
  it.each([
    [
      "the hour before the clocks go forward",
      BEFORE_SPRING,
      due("29", "03", "2026", "00", "30"),
      "2026-03-29T00:30:00.000Z",
    ],
    [
      "the hour after the clocks go forward",
      BEFORE_SPRING,
      due("29", "03", "2026", "02", "30"),
      "2026-03-29T01:30:00.000Z",
    ],
    [
      "the morning after the clocks go back",
      BEFORE_AUTUMN,
      due("25", "10", "2026", "09", "00"),
      "2026-10-25T09:00:00.000Z",
    ],
    [
      "the day before the clocks go back",
      BEFORE_AUTUMN,
      due("24", "10", "2026", "09", "00"),
      "2026-10-24T08:00:00.000Z",
    ],
  ])("reads %s as UK time", (_name, now, fields, instant) => {
    expect(
      readNewTask(form({ title: "Clock check", ...fields }), t, { now, selfId: SELF }),
    ).toMatchObject({
      ok: true,
      body: { dueAt: instant },
    });
  });

  it("refuses a time that does not exist when the clocks go forward", () => {
    const read = readNewTask(
      form({ title: "Clock check", ...due("29", "03", "2026", "01", "30") }),
      t,
      {
        now: BEFORE_SPRING,
        selfId: SELF,
      },
    );
    expect(read).toMatchObject({ ok: false, errors: { dueAt: expect.stringContaining("01:30") } });
  });

  it("asks which time is meant in the hour the clocks go back", () => {
    const read = readNewTask(
      form({ title: "Clock check", ...due("25", "10", "2026", "01", "30") }),
      t,
      {
        now: BEFORE_AUTUMN,
        selfId: SELF,
      },
    );
    expect(read).toMatchObject({ ok: false, parts: { dueAt: ["fold"] } });
    const first = readNewTask(
      form({ title: "Clock check", ...due("25", "10", "2026", "01", "30"), "dueAt-fold": "first" }),
      t,
      { now: BEFORE_AUTUMN, selfId: SELF },
    );
    expect(first).toMatchObject({ ok: true, body: { dueAt: "2026-10-25T00:30:00.000Z" } });
  });

  it("hazard HZ-003 schedules a daily task across the change at the same UK wall-clock time", () => {
    const read = readNewTask(
      form({ title: "Night check", ...due("24", "10", "2026", "02", "00"), repeat: "daily" }),
      t,
      { now: BEFORE_AUTUMN, selfId: SELF },
    );
    expect(read).toMatchObject({
      ok: true,
      kind: "series",
      body: { startsOn: "2026-10-24", recurrence: { freq: "daily", times: ["02:00"] } },
    });
  });

  it("hazard HZ-003 refuses a repeating task that would start in the past", () => {
    const read = readNewTask(
      form({ title: "Late series", ...due("30", "11", "2026", "08", "00"), repeat: "daily" }),
      t,
      { now: NOW, selfId: SELF },
    );
    expect(read.ok).toBe(false);
  });
});

describe("hazard HZ-003 a long task list stays quick and keeps today's tasks in sight", () => {
  it.each([
    [undefined, 20],
    ["", 20],
    ["10", 20],
    ["20", 20],
    ["21", 40],
    ["40", 40],
    ["5000", 1000],
    ["abc", 20],
    [["60", "20"], 60],
  ] as const)("renders %o as %d tasks", (value, n) => {
    expect(shownCount(value as string | string[] | undefined)).toBe(n);
  });

  it("lists the window's own tasks apart from open tasks due before it", () => {
    const from = "2026-12-01T00:00:00.000Z";
    const { inWindow, earlier } = splitByWindow(
      [
        { id: "old", dueAt: "2026-11-20T09:00:00.000Z" },
        { id: "edge", dueAt: from },
        { id: "today", dueAt: "2026-12-01T09:00:00.000Z" },
      ],
      from,
    );
    expect(inWindow.map((i) => i.id)).toEqual(["edge", "today"]);
    expect(earlier.map((i) => i.id)).toEqual(["old"]);
  });
});
