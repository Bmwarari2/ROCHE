import { describe, expect, it } from "vitest";
import { tableCareRates } from "../../test/rate-table";
import { addUkDays, formatUkTime } from "../shared/time";
import { addDaysToDate, addMonthsToDate } from "./assessment";
import {
  type BowelEntry,
  BRISTOL_STOOL_SCALE,
  checkBowelEntry,
  isBristolStoolType,
  noBowelMovementPrompt,
} from "./bowel";
import { repositioningInterval, repositioningStatus } from "./repositioning";
import { nextWeightDueOn, weightInterval } from "./weight";

/** Repositioning, bowel and weight chart rules; every interval comes from the rate table. */

const rates = tableCareRates();
const HOUR = 3_600_000;
const MINUTE = 60_000;

describe("repositioning intervals from skin risk", () => {
  it.each([
    [
      "at risk",
      "at_risk",
      { kind: "every", hours: rates.repositioningAtRiskHours, source: "default" },
    ],
    [
      "high risk",
      "high_risk",
      { kind: "every", hours: rates.repositioningHighRiskHours, source: "default" },
    ],
    ["not at risk", "not_at_risk", { kind: "none" }],
  ] as const)("a person %s gets the rate-table default", (_name, skinRisk, expected) => {
    expect(repositioningInterval({ skinRisk }, rates)).toEqual(expected);
  });

  it("uses the interval in the person's care plan instead of the default", () => {
    expect(
      repositioningInterval({ skinRisk: "high_risk", carePlanIntervalHours: 2 }, rates),
    ).toEqual({
      kind: "every",
      hours: 2,
      source: "care_plan",
    });
  });

  it("follows a tenant's own defaults", () => {
    const tenant = { ...rates, repositioningHighRiskHours: rates.repositioningHighRiskHours - 1 };
    expect(repositioningInterval({ skinRisk: "high_risk" }, tenant)).toMatchObject({
      hours: tenant.repositioningHighRiskHours,
    });
  });

  it("refuses an interval of 0 hours", () => {
    expect(() =>
      repositioningInterval({ skinRisk: "at_risk", carePlanIntervalHours: 0 }, rates),
    ).toThrow(RangeError);
    expect(() => repositioningStatus(new Date(), 0, new Date())).toThrow(RangeError);
  });
});

describe("repositioning next due and overdue", () => {
  const since = new Date("2026-10-11T07:00:00Z");
  const hours = rates.repositioningHighRiskHours;
  const due = new Date(since.getTime() + hours * HOUR);

  it.each([
    ["before it is due", new Date(due.getTime() - MINUTE), false, 0],
    ["exactly when due", due, false, 0],
    ["one minute late", new Date(due.getTime() + MINUTE), true, 1],
    ["ninety minutes late", new Date(due.getTime() + 90 * MINUTE), true, 90],
  ])("%s", (_name, now, overdue, overdueMinutes) => {
    expect(repositioningStatus(since, hours, now)).toEqual({ dueAt: due, overdue, overdueMinutes });
  });

  it("hazard HZ-009 counts elapsed hours across the autumn clock change", () => {
    const lastTurn = new Date("2026-10-25T00:00:00Z"); // 01:00 BST
    const status = repositioningStatus(lastTurn, 4, lastTurn);
    expect(status.dueAt.toISOString()).toBe("2026-10-25T04:00:00.000Z"); // 04:00 GMT, four hours on
  });
});

describe("bowel chart", () => {
  it.each([
    [1, true],
    [4, true],
    [7, true],
    [0, false],
    [8, false],
    [3.5, false],
  ])("Bristol stool type %s is valid: %s", (type, valid) => {
    expect(isBristolStoolType(type)).toBe(valid);
    expect(
      checkBowelEntry({ kind: "movement", occurredAt: new Date(), bristolType: type }).ok,
    ).toBe(valid);
  });

  it("describes all seven Bristol types and accepts a recorded 'no bowel movement'", () => {
    expect(Object.keys(BRISTOL_STOOL_SCALE)).toEqual(["1", "2", "3", "4", "5", "6", "7"]);
    expect(checkBowelEntry({ kind: "no_movement", occurredAt: new Date() })).toEqual({ ok: true });
    expect(checkBowelEntry({ kind: "movement", occurredAt: new Date(), bristolType: 9 })).toEqual({
      ok: false,
      message: "Choose a Bristol stool type from 1 to 7.",
    });
  });

  const chartStartedAt = new Date("2026-10-01T08:00:00Z");
  const lastMovement = new Date("2026-10-05T09:15:00Z");
  const entries: BowelEntry[] = [
    { kind: "movement", occurredAt: new Date("2026-10-03T08:00:00Z"), bristolType: 4 },
    { kind: "movement", occurredAt: lastMovement, bristolType: 5 },
    { kind: "no_movement", occurredAt: new Date("2026-10-06T20:00:00Z") },
    { kind: "no_movement", occurredAt: new Date("2026-10-07T20:00:00Z") },
  ];
  const dueAt = addUkDays(lastMovement, rates.bowelNoMovementPromptDays);

  it.each([
    ["one minute before the prompt is due", new Date(dueAt.getTime() - MINUTE), false],
    ["when the prompt is due", dueAt, true],
    ["a day after", new Date(dueAt.getTime() + 24 * HOUR), true],
  ])("prompts %s after the rate-table number of days", (_name, now, prompt) => {
    expect(noBowelMovementPrompt(entries, chartStartedAt, now, rates)).toEqual({
      lastMovementAt: lastMovement,
      promptDueAt: dueAt,
      prompt,
    });
  });

  it("counts from the start of the chart when no movement is recorded", () => {
    const result = noBowelMovementPrompt([], chartStartedAt, chartStartedAt, rates);
    expect(result.lastMovementAt).toBeNull();
    expect(result.promptDueAt).toEqual(addUkDays(chartStartedAt, rates.bowelNoMovementPromptDays));
  });

  it("ignores entries recorded with a time after now", () => {
    const now = new Date("2026-10-06T12:00:00Z");
    const future: BowelEntry = {
      kind: "movement",
      occurredAt: new Date("2026-10-07T12:00:00Z"),
      bristolType: 4,
    };
    expect(
      noBowelMovementPrompt([...entries, future], chartStartedAt, now, rates).lastMovementAt,
    ).toEqual(lastMovement);
  });

  it("hazard HZ-009 keeps the prompt at the same UK time across the autumn clock change", () => {
    const movement = new Date("2026-10-23T07:00:00Z"); // 08:00 BST
    const result = noBowelMovementPrompt(
      [{ kind: "movement", occurredAt: movement, bristolType: 4 }],
      chartStartedAt,
      movement,
      { bowelNoMovementPromptDays: 3 },
    );
    expect(result.promptDueAt.toISOString()).toBe("2026-10-26T08:00:00.000Z"); // 08:00 GMT
    expect(formatUkTime(result.promptDueAt)).toBe("08:00");
  });
});

describe("weight frequency", () => {
  it.each([
    ["no MUST result yet", null, { unit: "months", value: rates.weightDefaultIntervalMonths }],
    ["MUST low", "low", { unit: "months", value: rates.weightDefaultIntervalMonths }],
    ["MUST medium", "medium", { unit: "weeks", value: rates.weightAtRiskIntervalWeeks }],
    ["MUST high", "high", { unit: "weeks", value: rates.weightAtRiskIntervalWeeks }],
  ] as const)("%s", (_name, band, interval) => {
    expect(weightInterval(band, rates)).toEqual(interval);
  });

  it("dates the next weight from the last one", () => {
    expect(
      nextWeightDueOn("2026-10-11", { unit: "weeks", value: rates.weightAtRiskIntervalWeeks }),
    ).toBe(addDaysToDate("2026-10-11", rates.weightAtRiskIntervalWeeks * 7));
    expect(
      nextWeightDueOn("2026-10-11", { unit: "months", value: rates.weightDefaultIntervalMonths }),
    ).toBe(addMonthsToDate("2026-10-11", rates.weightDefaultIntervalMonths));
  });

  it.each([
    ["2 weeks", "2026-12-25", { unit: "weeks", value: 2 }, "2027-01-08"],
    ["1 month from 31 January", "2026-01-31", { unit: "months", value: 1 }, "2026-02-28"],
    [
      "1 month from 31 January in a leap year",
      "2028-01-31",
      { unit: "months", value: 1 },
      "2028-02-29",
    ],
  ] as const)("adds %s on the calendar", (_name, from, interval, due) => {
    expect(nextWeightDueOn(from, interval)).toBe(due);
  });

  it("refuses a date that does not exist", () => {
    expect(() => nextWeightDueOn("2026-02-29", { unit: "weeks", value: 1 })).toThrow(RangeError);
  });
});
