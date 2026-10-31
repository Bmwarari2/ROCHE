import { describe, expect, it } from "vitest";
import { readRateTable } from "../../../test/rate-table";
import { bradfordFactor } from "./bradford";
import { resolvePayRates } from "./rates";

const rates = resolvePayRates(readRateTable(), "england", "2026-10-31", null);
const TODAY = "2026-10-31";
const WEEKEND = new Set(["2026-10-17", "2026-10-18"]);

describe("the Bradford factor (scheduling.md 4b rule 8)", () => {
  it.each<[string, string[], number, number]>([
    ["no absence", [], 0, 0],
    ["one day", ["2026-10-05"], 1, 1],
    ["three days in a row", ["2026-10-05", "2026-10-06", "2026-10-07"], 1, 3],
    ["three separate days", ["2026-10-05", "2026-10-07", "2026-10-09"], 3, 3],
    ["Friday and Monday either side of a weekend off", ["2026-10-16", "2026-10-19"], 1, 2],
    ["the same day twice", ["2026-10-05", "2026-10-05"], 1, 1],
  ])("%s: %i spells, %i days", (_, days, spells, total) => {
    const result = bradfordFactor(days, WEEKEND, TODAY, rates);
    expect(result).toMatchObject({ spells, days: total, score: spells * spells * total });
  });

  it("counts only the window from the rate table", () => {
    const result = bradfordFactor(["2024-01-01", "2026-10-05"], new Set(), TODAY, rates);
    expect(result.days).toBe(1);
    const start = new Date(`${TODAY}T00:00:00Z`);
    start.setUTCDate(start.getUTCDate() - rates.bradfordWindowWeeks * 7 + 1);
    expect(result.windowStart).toBe(start.toISOString().slice(0, 10));
  });
});
