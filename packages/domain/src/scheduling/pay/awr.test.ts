import { describe, expect, it } from "vitest";
import { readRateTable } from "../../../test/rate-table";
import { type AwrWeek, awrClock } from "./awr";
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
const breaks = (
  weeks: string[],
  reason: "none" | "sickness" | "protected_leave" | "annual_leave" | "shutdown",
): AwrWeek[] => weeks.map((week) => ({ week, kind: "break", reason }));

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

  it.each(["protected_leave", "annual_leave", "shutdown"] as const)(
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

  it("pauses for sickness up to its limit, then counts the excess as an ordinary break", () => {
    const sick = rates.awrSicknessPauseMaxWeeks;
    const pause = [
      ...worked(weeks.slice(0, 2)),
      ...breaks(weeks.slice(2, 2 + sick), "sickness"),
      ...worked(weeks.slice(2 + sick, 3 + sick)),
    ];
    expect(awrClock(pause, rates).qualifyingWeeks).toBe(3);
    const tooLong = sick + rates.awrBreakResetWeeks + 1;
    const reset = [
      ...worked(weeks.slice(0, 2)),
      ...breaks(weeks.slice(2, 2 + tooLong), "sickness"),
      ...worked(weeks.slice(2 + tooLong, 3 + tooLong)),
    ];
    expect(awrClock(reset, rates).qualifyingWeeks).toBe(1);
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
