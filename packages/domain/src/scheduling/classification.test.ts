import { describe, expect, it } from "vitest";
import { HOUR, shift, uk } from "../../test/working-time";
import { classifyWorkingTime, nmwMinutes, workingMinutes } from "./classification";
import type { WorkPeriod } from "./working-time-types";

const base = shift("p1", "2026-11-02 22:00", "2026-11-03 07:00");

describe("what counts as working time and as minimum-wage time (scheduling.md rules 9 and 10)", () => {
  it.each<[string, Partial<WorkPeriod>, boolean, string]>([
    ["a shift", { kind: "work" }, true, "whole"],
    ["training", { kind: "training" }, true, "whole"],
    ["on call at the workplace", { kind: "on_call_at_workplace" }, true, "whole"],
    ["on call away from the workplace", { kind: "on_call_away" }, false, "none"],
    ["travel between visits", { kind: "travel", travel: "between_assignments" }, true, "whole"],
    [
      "home to the first visit with no fixed workplace",
      { kind: "travel", travel: "home_to_first_assignment" },
      true,
      "none",
    ],
    [
      "last visit to home with no fixed workplace",
      { kind: "travel", travel: "last_assignment_to_home" },
      true,
      "none",
    ],
    [
      "commuting to a fixed workplace",
      { kind: "travel", travel: "commute_to_fixed_workplace" },
      false,
      "none",
    ],
    [
      "a sleep-in, sleep expected, suitable facilities",
      {
        kind: "sleep_in",
        sleepIn: { expectedToSleep: true, suitableSleepingFacilities: true, awake: [] },
      },
      true,
      "awake_only",
    ],
    [
      "a sleep-in expected to work most of it",
      {
        kind: "sleep_in",
        sleepIn: { expectedToSleep: false, suitableSleepingFacilities: true, awake: [] },
      },
      true,
      "whole",
    ],
    [
      "a sleep-in with no suitable sleeping facilities",
      {
        kind: "sleep_in",
        sleepIn: { expectedToSleep: true, suitableSleepingFacilities: false, awake: [] },
      },
      true,
      "whole",
    ],
  ])("%s: working time %s, minimum wage %s", (_name, extra, workingTime, nmw) => {
    const result = classifyWorkingTime({ ...base, ...extra });
    expect(result.workingTime).toBe(workingTime);
    expect(result.nmw).toBe(nmw);
    expect(result.source).not.toBe("");
  });

  it("counts a whole sleep-in as working time but only the awake times for the minimum wage", () => {
    const sleepIn: WorkPeriod = {
      ...base,
      kind: "sleep_in",
      sleepIn: {
        expectedToSleep: true,
        suitableSleepingFacilities: true,
        awake: [
          { start: uk("2026-11-03 01:00"), end: uk("2026-11-03 01:40") },
          { start: uk("2026-11-03 01:30"), end: uk("2026-11-03 02:00") },
          { start: uk("2026-11-03 05:00"), end: uk("2026-11-03 05:15") },
        ],
      },
    };
    expect(workingMinutes(sleepIn)).toBe(9 * HOUR);
    expect(nmwMinutes(sleepIn)).toBe(75);
  });

  it("pays the whole sleep-in when the worker is expected to work most of it", () => {
    const sleepIn: WorkPeriod = {
      ...base,
      kind: "sleep_in",
      sleepIn: { expectedToSleep: false, suitableSleepingFacilities: true, awake: [] },
    };
    expect(nmwMinutes(sleepIn)).toBe(9 * HOUR);
  });

  it("gives no minimum-wage time for home to first visit, and none for on call at home", () => {
    expect(nmwMinutes({ ...base, kind: "travel", travel: "home_to_first_assignment" })).toBe(0);
    expect(workingMinutes({ ...base, kind: "on_call_away" })).toBe(0);
  });

  it("takes breaks out of working time", () => {
    const withBreak = shift("p2", "2026-11-02 08:00", "2026-11-02 20:00", {
      breaks: [{ start: uk("2026-11-02 12:00"), end: uk("2026-11-02 12:30") }],
    });
    expect(workingMinutes(withBreak)).toBe(11.5 * HOUR);
  });

  it.each([
    ["the night the clocks go back", "2026-10-24 20:00", "2026-10-25 08:00", 13],
    ["the night the clocks go forward", "2026-03-28 20:00", "2026-03-29 08:00", 11],
    ["an ordinary night", "2026-11-07 20:00", "2026-11-08 08:00", 12],
  ])("measures hours in elapsed time on %s", (_name, from, to, hours) => {
    expect(workingMinutes(shift("n", from, to))).toBe(hours * HOUR);
  });

  it.each<[string, WorkPeriod]>([
    ["ends before it starts", shift("x", "2026-11-02 10:00", "2026-11-02 09:00")],
    ["travel without its journey", { ...base, kind: "travel" }],
    ["a sleep-in without its details", { ...base, kind: "sleep_in" }],
    [
      "a break outside the period",
      { ...base, breaks: [{ start: uk("2026-11-02 21:00"), end: uk("2026-11-02 21:30") }] },
    ],
  ])("refuses a period that %s", (_name, period) => {
    expect(() => classifyWorkingTime(period)).toThrow(RangeError);
  });
});
