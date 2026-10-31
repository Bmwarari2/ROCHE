import { describe, expect, it } from "vitest";
import { t } from "./i18n";
import {
  clockTime,
  comparisonChip,
  hoursWords,
  justificationProblem,
  mayCheck,
  mayOverride,
  overrideKeys,
  periodKey,
  publishReadiness,
  readClockTime,
  rotaChip,
  rotaDays,
  rotaShown,
  shiftChip,
  shiftsByDate,
  shiftTimes,
  ukClock,
} from "./rota";

/** The rota builder's screens (SCHED-001, SCHED-002; HZ-123, HZ-124). */

describe("who sees what", () => {
  it.each([
    [["scheduling.rota.read"], true, false, false],
    [["scheduling.rota.manage"], true, false, false],
    [["scheduling.rota.manage", "care.plan.read"], true, true, false],
    [["scheduling.rota.manage", "care.plan.read", "scheduling.rota.approve"], true, true, true],
    [[], false, false, false],
  ])("%j", (permissions, shown, check, override) => {
    expect(rotaShown(permissions)).toBe(shown);
    expect(mayCheck(permissions)).toBe(check);
    expect(mayOverride(permissions)).toBe(override);
  });
});

describe("24-hour UK times", () => {
  it.each([
    [0, "00:00"],
    [450, "07:30"],
    [1439, "23:59"],
    [1440, "00:00"],
  ])("%i -> %s", (m, s) => expect(clockTime(m)).toBe(s));

  it.each([
    ["07:30", 450],
    ["7:30", 450],
    ["23:59", 1439],
    ["24:00", null],
    ["7.30", null],
    ["", null],
  ])("reads %j", (s, m) => expect(readClockTime(s)).toBe(m));

  it("says when a shift ends the next day", () => {
    expect(shiftTimes(450, 900, t)).toBe("07:30 to 15:00");
    expect(shiftTimes(1200, 480, t)).toBe("20:00 to 08:00 (next day)");
    expect(shiftTimes(480, 480, t)).toBe("08:00 to 08:00 (next day)");
  });

  it("reads an instant on the UK clock, across the change to GMT", () => {
    expect(ukClock("2026-10-24T06:30:00Z")).toBe("07:30");
    expect(ukClock("2026-10-26T07:30:00Z")).toBe("07:30");
  });

  it("puts hours and minutes in words", () => {
    expect(hoursWords(450, t)).toBe("7 h 30 min");
    expect(hoursWords(0, t)).toBe("0 h 0 min");
  });

  it("counts a rota's days inclusively", () => {
    expect(rotaDays("2026-11-02", "2026-11-08")).toBe(7);
    expect(rotaDays("2026-10-19", "2026-10-26")).toBe(8);
  });
});

describe("shifts by day", () => {
  it("groups by UK date in date and start order", () => {
    const groups = shiftsByDate([
      { id: "b", date: "2026-11-02", startsAt: "2026-11-02T20:00:00Z" },
      { id: "a", date: "2026-11-02", startsAt: "2026-11-02T07:00:00Z" },
      { id: "c", date: "2026-11-01", startsAt: "2026-11-01T07:00:00Z" },
    ]);
    expect(groups.map((g) => [g.date, g.shifts.map((s) => s.id)])).toEqual([
      ["2026-11-01", ["c"]],
      ["2026-11-02", ["a", "b"]],
    ]);
  });
});

describe("hazard HZ-123 the comparison is an icon and the API's word, never colour alone", () => {
  it.each([
    ["below", "overdue", "triangle-alert"],
    ["incomplete", "overdue", "circle-alert"],
    ["no_scale", "overdue", "circle-minus"],
    ["met_with_warnings", "due", "circle-alert"],
    ["met", "done", "circle-check"],
    ["something_new", "overdue", "circle-alert"],
  ])("%s", (status, chip, icon) => {
    const out = comparisonChip({ status: status as "met", word: "The word" });
    expect(out).toEqual({ status: chip, icon, label: "The word" });
  });

  it("names a period by date and period key", () => {
    expect(periodKey({ date: "2026-11-02", periodKey: "night" })).toBe("2026-11-02:night");
    expect(periodKey({ date: "2026-11-02", periodKey: null })).toBe("2026-11-02");
  });
});

describe("hazard HZ-123 publishing needs each period acknowledged by name", () => {
  const staffing = [
    { date: "2026-11-02", periodKey: "day" },
    { date: "2026-11-02", periodKey: "night" },
  ];
  const check = {
    blockedAssignmentIds: [] as string[],
    hasWarnings: true,
    periodsToAcknowledge: ["2026-11-02:night"],
    staffing,
  };
  it.each([
    ["all done", check, ["2026-11-02:night"], true, true, []],
    ["period not ticked", check, [], true, false, ["periods"]],
    ["warnings not read", check, ["2026-11-02:night"], false, false, ["warnings"]],
    ["no warnings", { ...check, hasWarnings: false }, ["2026-11-02:night"], false, true, []],
    [
      "blocked assignment",
      { ...check, blockedAssignmentIds: ["x"] },
      ["2026-11-02:night"],
      true,
      false,
      ["blocked"],
    ],
    [
      "a period the page cannot show",
      { ...check, periodsToAcknowledge: ["2026-11-03:day"] },
      ["2026-11-03:day"],
      true,
      false,
      ["notListed"],
    ],
  ])("%s", (_n, c, ticked, read, ready, reasons) => {
    const out = publishReadiness(c as never, new Set(ticked), read);
    expect(out.ready).toBe(ready);
    expect(out.reasons).toEqual(reasons);
    expect(out.acknowledgedPeriods).toEqual(c.periodsToAcknowledge);
  });
});

describe("hazard HZ-124 an override names exactly the blockers shown, with a justification", () => {
  it("sends the keys shown", () => {
    expect(overrideKeys([{ key: "dbs:expired" }, { key: "competence:medicines:missing" }])).toEqual(
      ["dbs:expired", "competence:medicines:missing"],
    );
  });

  it.each([
    ["", "Say why it is safe in at least 10 characters"],
    ["too short", "Say why it is safe in at least 10 characters"],
    ["Checked with the nurse in charge; shadowing all shift.", null],
    ["x".repeat(1001), "Keep the reason to 1000 characters or fewer"],
  ])("%j", (text, problem) => expect(justificationProblem(text, t)).toBe(problem));
});

describe("rota and shift states as an icon and a word", () => {
  it.each([
    [{ state: "draft", changedSincePublished: false }, "Draft"],
    [{ state: "published", changedSincePublished: false }, "Published"],
    [{ state: "published", changedSincePublished: true }, "Changed since published"],
    [{ state: "odd", changedSincePublished: false }, "Unknown: check with Harbour support"],
  ])("%j", (rota, label) => {
    expect(rotaChip(rota, t).label).toBe(label);
    expect(rotaChip(rota, t).icon).toBeTruthy();
  });

  it.each([
    [{ assignment: null }, "Open"],
    [{ assignment: { overridden: [] } }, "Filled"],
    [{ assignment: { overridden: ["dbs:expired"] } }, "Filled with an override"],
  ])("%j", (shift, label) => expect(shiftChip(shift as never, t).label).toBe(label));
});
