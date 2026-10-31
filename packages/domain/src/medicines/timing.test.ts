import { describe, expect, it } from "vitest";
import { tableMedicinesRates } from "../../test/rate-table";
import { formatUkTime, fromUkWallClock, toUkWallClock, ukOffsetMinutes } from "../shared/time";
import {
  doseNotices,
  doseWindow,
  driftCorrectedTime,
  earlyNeedsReason,
  escalationAt,
  isTimeCritical,
  type RecordedTiming,
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
});

describe("hazard HZ-004 a dose is recorded no earlier than its window opens, and on time anywhere inside it", () => {
  const window = doseWindow(dueAt, false, rates);
  it.each<[number, RecordedTiming]>([
    [-rates.doseEarlyMinutes - 1, "before_window"],
    [-rates.doseEarlyMinutes, "on_time"],
    [-1, "on_time"],
    [0, "on_time"],
    [rates.doseLateMinutes, "on_time"],
    [rates.doseLateMinutes + 1, "late"],
  ])("a dose recorded %i minutes from its due time is %s", (minutes, timing) => {
    expect(recordedTiming(window, plus(minutes))).toBe(timing);
  });
});

describe("hazard HZ-004 an early dose inside its window needs a reason only when time-critical or too close to the last dose", () => {
  // The previous dose was due ten hours before this one.
  const previousDue = new Date(dueAt.getTime() - 10 * 60 * MINUTE);
  const regular = doseWindow(dueAt, false, rates);
  const critical = doseWindow(dueAt, true, rates);
  const limit = 10 * 60 - rates.doseEarlyMinutes;
  it.each<[string, typeof regular, number, number | null, boolean]>([
    ["regular, early, the last dose on time", regular, -1, -10 * 60, false],
    [
      "regular, early, the last dose a minute inside the limit",
      regular,
      -1,
      -1 - (limit - 1),
      true,
    ],
    ["regular, early, the last dose exactly at the limit", regular, -1, -1 - limit, false],
    ["regular, early, no last dose recorded", regular, -rates.doseEarlyMinutes, null, false],
    ["regular, at its due time, the last dose very close", regular, 0, -60, false],
    [
      "regular, before its window (refused elsewhere, not early)",
      regular,
      -rates.doseEarlyMinutes - 1,
      -10 * 60,
      false,
    ],
    ["time-critical, a minute early", critical, -1, -10 * 60, true],
    ["time-critical, at its due time", critical, 0, -10 * 60, false],
  ])("%s", (_name, window, minutes, lastMinutes, needs) => {
    const last = lastMinutes === null ? null : plus(lastMinutes);
    expect(earlyNeedsReason(window, plus(minutes), last, last === null ? null : previousDue)).toBe(
      needs,
    );
  });
});

describe("hazard HZ-009 a dose window on the days the clocks change is measured in elapsed time", () => {
  // The last Sundays of March and October 2027. Forward: 01:00 GMT becomes 02:00 BST, so a dose
  // due at 02:01 has its window open before the change. Back: 02:00 BST becomes 01:00 GMT, so a
  // dose due at the first 01:59 has its window end after the change.
  const forward = fromUkWallClock(2027, 3, 28, 2, 1);
  const back = fromUkWallClock(2027, 10, 31, 1, 59);
  const wallMinutes = (d: Date) => toUkWallClock(d).hour * 60 + toUkWallClock(d).minute;
  const minutesFrom = (due: Date, n: number) => new Date(due.getTime() + n * MINUTE);
  it.each<[string, Date, boolean, number, RecordedTiming]>([
    [
      "forward: a minute before the window opens",
      forward,
      false,
      -rates.doseEarlyMinutes - 1,
      "before_window",
    ],
    ["forward: as the window opens", forward, false, -rates.doseEarlyMinutes, "on_time"],
    [
      "forward: time-critical, a minute before its window",
      forward,
      true,
      -rates.timeCriticalEarlyMinutes - 1,
      "before_window",
    ],
    ["back: at the end of the window", back, false, rates.doseLateMinutes, "on_time"],
    ["back: a minute after the window", back, false, rates.doseLateMinutes + 1, "late"],
    [
      "back: time-critical, a minute after its window",
      back,
      true,
      rates.timeCriticalLateMinutes + 1,
      "late",
    ],
  ])("%s", (_name, due, critical, minutes, timing) => {
    const when = minutesFrom(due, minutes);
    // The record and the due time are either side of the change, so the clock face is an hour
    // out: after the clocks go back, a dose late by elapsed time can read as before its time.
    expect(ukOffsetMinutes(when)).not.toBe(ukOffsetMinutes(due));
    expect(wallMinutes(when) - wallMinutes(due)).toBe(minutes - 60);
    expect(recordedTiming(doseWindow(due, critical, rates), when)).toBe(timing);
  });

  it("keeps each window as long in elapsed time as on any other day", () => {
    for (const due of [forward, back]) {
      const window = doseWindow(due, false, rates);
      expect(window.lateAfter.getTime() - window.opensAt.getTime()).toBe(
        (rates.doseEarlyMinutes + rates.doseLateMinutes) * MINUTE,
      );
    }
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
