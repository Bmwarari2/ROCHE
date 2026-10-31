import { describe, expect, it } from "vitest";
import { tableMedicinesRates } from "../../test/rate-table";
import { formatUkTime, fromUkWallClock } from "../shared/time";
import {
  doseNotices,
  doseWindow,
  driftCorrectedTime,
  escalationAt,
  isTimeCritical,
  recordedTiming,
  SCHEDULED_DOSE_WORDS,
  scheduledDoseState,
} from "./timing";

const rates = tableMedicinesRates();
const MINUTE = 60_000;
const dueAt = fromUkWallClock(2026, 11, 2, 8, 0);
const plus = (minutes: number) => new Date(dueAt.getTime() + minutes * MINUTE);

describe("hazard HZ-003 time-critical medicines escalate at the earlier threshold", () => {
  it("reads every window from the rate table, narrower for an entry tagged time-critical", () => {
    const regular = doseWindow(dueAt, false, rates);
    const critical = doseWindow(dueAt, true, rates);
    expect(regular.opensAt).toEqual(plus(-rates.doseEarlyMinutes));
    expect(regular.lateAfter).toEqual(plus(rates.doseLateMinutes));
    expect(critical.opensAt).toEqual(plus(-rates.timeCriticalEarlyMinutes));
    expect(escalationAt(critical)).toEqual(plus(rates.timeCriticalLateMinutes));
    expect(escalationAt(critical).getTime()).toBeLessThan(escalationAt(regular).getTime());
  });

  it("never lets a tenant make the time-critical window wider than the regular one", () => {
    const wide = { ...rates, timeCriticalEarlyMinutes: 999, timeCriticalLateMinutes: 999 };
    const window = doseWindow(dueAt, true, wide);
    expect(window.opensAt).toEqual(plus(-rates.doseEarlyMinutes));
    expect(window.lateAfter).toEqual(plus(rates.doseLateMinutes));
  });

  it("is time-critical only when a person tagged the entry so (ADR-0082)", () => {
    expect(isTimeCritical({ tags: ["time_critical"] })).toBe(true);
    expect(isTimeCritical({ tags: ["paracetamol", "psychotropic"] })).toBe(false);
  });
});

describe("hazard HZ-003 a dose with no recorded outcome stays outstanding after its window", () => {
  const window = doseWindow(dueAt, false, rates);
  it.each<[string, number, boolean, keyof typeof SCHEDULED_DOSE_WORDS]>([
    ["before its window", -rates.doseEarlyMinutes - 1, false, "not_yet_due"],
    ["as its window opens", -rates.doseEarlyMinutes, false, "due"],
    ["at its due time", 0, false, "due"],
    ["at the end of its window", rates.doseLateMinutes, false, "due"],
    ["a minute after its window", rates.doseLateMinutes + 1, false, "late"],
    ["a day later", 24 * 60, false, "late"],
    ["a day later, with an outcome", 24 * 60, true, "recorded"],
  ])("%s", (_name, minutes, recorded, state) => {
    expect(scheduledDoseState(window, recorded, plus(minutes))).toBe(state);
    expect(SCHEDULED_DOSE_WORDS[state]).not.toBe("");
  });

  it.each([
    [-rates.doseEarlyMinutes - 1, "early"],
    [-rates.doseEarlyMinutes, "on_time"],
    [rates.doseLateMinutes, "on_time"],
    [rates.doseLateMinutes + 1, "late"],
  ] as const)("a dose given %i minutes from its due time is %s", (minutes, timing) => {
    expect(recordedTiming(window, plus(minutes))).toBe(timing);
  });
});

describe("the tenant's rules a tag switches on, in words with the table's figures", () => {
  it("names the window, the before-food gap and the paracetamol interval", () => {
    const notices = doseNotices(
      { tags: ["time_critical", "bisphosphonate", "paracetamol"] },
      rates,
    );
    expect(notices).toEqual([
      `Time-critical: give between ${rates.timeCriticalEarlyMinutes} minutes before and ${rates.timeCriticalLateMinutes} minutes after the time due.`,
      `Give at least ${rates.bisphosphonateBeforeFoodMinutes} minutes before food or drink, as the label says.`,
      `Paracetamol: at least ${rates.paracetamolMinIntervalHours} hours between doses of any medicine tagged paracetamol.`,
    ]);
    expect(doseNotices({ tags: [] }, rates)).toEqual([]);
  });
});

describe("hazard HZ-010 times read from a device are corrected by its measured clock offset", () => {
  const deviceAt = fromUkWallClock(2026, 11, 2, 11, 52);
  it("adds the offset the last sync measured, and flags drift beyond the table's tolerance", () => {
    const slow = driftCorrectedTime(deviceAt, 10 * MINUTE, rates);
    expect(formatUkTime(slow.at)).toBe("12:02");
    expect(slow).toMatchObject({ corrected: true, drifted: 10 > rates.clockDriftMinutes });
    const close = driftCorrectedTime(deviceAt, rates.clockDriftMinutes * MINUTE, rates);
    expect(close.drifted).toBe(false);
  });

  it("says when the offset is not known yet, leaving the time as the device read it", () => {
    expect(driftCorrectedTime(deviceAt, null, rates)).toEqual({
      at: deviceAt,
      corrected: false,
      drifted: false,
    });
  });
});
