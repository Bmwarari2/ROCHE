import { describe, expect, it } from "vitest";
import { readRateTable } from "../../../test/rate-table";
import { type AwrBreakReason, type AwrWeek, awrClock } from "./awr";
import { resolvePayRates } from "./rates";

const rates = resolvePayRates(readRateTable(), "england", "2026-10-31", null);

function mondays(from: string, count: number): string[] {
  return Array.from({ length: count }, (_, i) => {
    const d = new Date(`${from}T00:00:00Z`);
    d.setUTCDate(d.getUTCDate() + i * 7);
    return d.toISOString().slice(0, 10);
  });
}

const worked = (weeks: string[]): AwrWeek[] => weeks.map((week) => ({ week, kind: "worked" }));
const breaks = (weeks: string[], reason: AwrBreakReason): AwrWeek[] =>
  weeks.map((week) => ({ week, kind: "break", reason }));

describe("the AWR 12-week clock (scheduling.md 4b rule 6)", () => {
  const n = rates.awrQualifyingWeeks;
  const weeks = mondays(
    "2026-01-05",
    n + rates.awrSicknessPauseMaxWeeks + rates.awrBreakResetWeeks + 20,
  );

  it("qualifies after the qualifying weeks, from the week after", () => {
    const clock = awrClock(worked(weeks.slice(0, n)), rates);
    expect(clock).toEqual({ qualifyingWeeks: n, qualifiedFromWeek: weeks[n], resets: [] });
  });

  it("pauses for a break up to the reset limit", () => {
    const run = [
      ...worked(weeks.slice(0, 3)),
      ...breaks(weeks.slice(3, 3 + rates.awrBreakResetWeeks), "none"),
      ...worked(weeks.slice(3 + rates.awrBreakResetWeeks, 4 + rates.awrBreakResetWeeks)),
    ];
    expect(awrClock(run, rates).qualifyingWeeks).toBe(4);
  });

  it("resets after a break longer than the limit", () => {
    const run = [
      ...worked(weeks.slice(0, 3)),
      ...breaks(weeks.slice(3, 4 + rates.awrBreakResetWeeks), "none"),
      ...worked(weeks.slice(4 + rates.awrBreakResetWeeks, 5 + rates.awrBreakResetWeeks)),
    ];
    const clock = awrClock(run, rates);
    expect(clock.qualifyingWeeks).toBe(1);
    expect(clock.resets).toHaveLength(1);
  });

  it.each(["protected_leave", "annual_leave", "shutdown", "industrial_action"] as const)(
    "pauses without limit for %s",
    (reason) => {
      const long = rates.awrSicknessPauseMaxWeeks + 2;
      const run = [
        ...worked(weeks.slice(0, 2)),
        ...breaks(weeks.slice(2, 2 + long), reason),
        ...worked(weeks.slice(2 + long, 3 + long)),
      ];
      expect(awrClock(run, rates).qualifyingWeeks).toBe(3);
    },
  );

  it("pauses for jury service up to its own limit; longer resets (reg 7(8)(e), 9(b))", () => {
    const jury = rates.awrJuryServicePauseMaxWeeks;
    const pause = [
      ...worked(weeks.slice(0, 2)),
      ...breaks(weeks.slice(2, 2 + jury), "jury_service"),
      ...worked(weeks.slice(2 + jury, 3 + jury)),
    ];
    expect(awrClock(pause, rates).qualifyingWeeks).toBe(3);
    const reset = [
      ...worked(weeks.slice(0, 2)),
      ...breaks(weeks.slice(2, 3 + jury), "jury_service"),
      ...worked(weeks.slice(3 + jury, 4 + jury)),
    ];
    expect(awrClock(reset, rates).qualifyingWeeks).toBe(1);
  });

  it("pauses for sickness up to its limit; a longer sickness break resets (reg 7(9)(a))", () => {
    const sick = rates.awrSicknessPauseMaxWeeks;
    const pause = [
      ...worked(weeks.slice(0, 2)),
      ...breaks(weeks.slice(2, 2 + sick), "sickness"),
      ...worked(weeks.slice(2 + sick, 3 + sick)),
    ];
    expect(awrClock(pause, rates).qualifyingWeeks).toBe(3);
    const reset = [
      ...worked(weeks.slice(0, 2)),
      ...breaks(weeks.slice(2, 3 + sick), "sickness"),
      ...worked(weeks.slice(3 + sick, 4 + sick)),
    ];
    const clock = awrClock(reset, rates);
    expect(clock.qualifyingWeeks).toBe(1);
    expect(clock.resets).toEqual([{ week: weeks[2 + sick], reason: "break" }]);
  });

  it("resets a long break that is only partly for a covered reason (reg 7(8)(a), (h))", () => {
    const leave = 3;
    const none = rates.awrBreakResetWeeks + 1 - leave;
    const run = [
      ...worked(weeks.slice(0, 2)),
      ...breaks(weeks.slice(2, 2 + leave), "annual_leave"),
      ...breaks(weeks.slice(2 + leave, 2 + leave + none), "none"),
      ...worked(weeks.slice(2 + leave + none, 3 + leave + none)),
    ];
    expect(awrClock(run, rates).qualifyingWeeks).toBe(1);
  });

  it("keeps a long break made up wholly of covered reasons (reg 7(8)(h))", () => {
    const run = [
      ...worked(weeks.slice(0, 2)),
      ...breaks(weeks.slice(2, 6), "sickness"),
      ...breaks(weeks.slice(6, 12), "industrial_action"),
      ...worked(weeks.slice(12, 13)),
    ];
    expect(awrClock(run, rates).qualifyingWeeks).toBe(3);
  });

  it("counts protected leave within the assignment as weeks worked (reg 7(6))", () => {
    const deemed: AwrWeek[] = weeks
      .slice(2, 6)
      .map((week) => ({ week, kind: "break", reason: "protected_leave", deemedWorking: true }));
    const run = [...worked(weeks.slice(0, 2)), ...deemed, ...worked(weeks.slice(6, 7))];
    expect(awrClock(run, rates).qualifyingWeeks).toBe(7);
    const wrong: AwrWeek[] = [
      { week: weeks[0] as string, kind: "break", reason: "sickness", deemedWorking: true },
    ];
    expect(() => awrClock(wrong, rates)).toThrow(RangeError);
  });

  it("starts again in a substantively different role", () => {
    const run: AwrWeek[] = [
      ...worked(weeks.slice(0, 5)),
      { week: weeks[5] as string, kind: "worked", newRole: true },
    ];
    const clock = awrClock(run, rates);
    expect(clock.qualifyingWeeks).toBe(1);
    expect(clock.resets).toEqual([{ week: weeks[5], reason: "new_role" }]);
  });

  it("requalifies after a long break even once qualified", () => {
    const run = [
      ...worked(weeks.slice(0, n)),
      ...breaks(weeks.slice(n, n + rates.awrBreakResetWeeks + 1), "none"),
      ...worked(weeks.slice(n + rates.awrBreakResetWeeks + 1, n + rates.awrBreakResetWeeks + 2)),
    ];
    const clock = awrClock(run, rates);
    expect(clock.qualifiedFromWeek).toBeNull();
    expect(clock.qualifyingWeeks).toBe(1);
  });
});
