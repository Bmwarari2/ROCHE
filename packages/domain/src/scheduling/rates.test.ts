import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { readRateTable } from "../../test/rate-table";
import { RateNotFoundError, type RateRow } from "../platform/rates";
import { resolveWorkingTimeRates, WORKING_TIME_RATE_KEYS, type WorkingTimeRateName } from "./rates";

describe("working time figures come from the rate table", () => {
  const rows = readRateTable();

  it("finds every key in docs/specs/rates.md, verified, for each nation", () => {
    for (const nation of ["england", "wales", "scotland", "northern_ireland"] as const) {
      const rates = resolveWorkingTimeRates(rows, nation, "2026-10-31");
      for (const name of Object.keys(WORKING_TIME_RATE_KEYS) as WorkingTimeRateName[]) {
        const row = rows.find((r) => r.key === WORKING_TIME_RATE_KEYS[name] && r.validTo === null);
        expect(row?.verificationStatus).toBe("verified");
        expect(rates[name]).toBe(Number(row?.value));
      }
    }
  });

  it("ignores a tenant row, because the figures are statutory", () => {
    const looser: RateRow = {
      key: WORKING_TIME_RATE_KEYS.weeklyMaxHours,
      value: "60",
      unit: "hours",
      nation: "all",
      validFrom: "2026-01-01",
      validTo: null,
      tenantId: "tenant-a",
      verificationStatus: "tenant",
      source: "tenant policy",
    };
    const table = resolveWorkingTimeRates(rows, "england", "2026-10-31");
    expect(resolveWorkingTimeRates([...rows, looser], "england", "2026-10-31")).toEqual(table);
  });

  it("fails loudly when a figure is missing rather than guessing", () => {
    const without = rows.filter((r) => r.key !== WORKING_TIME_RATE_KEYS.youngUntilAgeYears);
    expect(() => resolveWorkingTimeRates(without, "england", "2026-10-31")).toThrow(
      RateNotFoundError,
    );
  });
});

/**
 * Section 18 and the Phase 2 gate: no statutory figure as a literal. The calendar units live in
 * `intervals.ts` (minutes in an hour, hours in a day, days in a week, months in a year) and the
 * money units in `pay/money.ts` (pence in a pound, basis points); elsewhere in the scheduling
 * source, working time and pay alike, no number but 0, 1 and 2 may appear, so every working time,
 * NMW, holiday, SSP and other pay figure must come through the rate table.
 */
describe("no working time or pay figure is a literal in the scheduling source", () => {
  const folder = fileURLToPath(new URL(".", import.meta.url));
  const sources = ["", "pay/"].flatMap((sub) =>
    readdirSync(`${folder}${sub}`)
      .filter((f) => f.endsWith(".ts") && !f.endsWith(".test.ts"))
      .map((f) => `${sub}${f}`),
  );
  const UNITS: Readonly<Record<string, readonly number[]>> = {
    "intervals.ts": [7, 12, 24, 60, 1000],
    "pay/money.ts": [100, 10],
  };

  function numbersIn(code: string): number[] {
    const stripped = code
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/\/\/.*$/gm, "")
      .replace(/"(?:[^"\\\n]|\\.)*"|'(?:[^'\\\n]|\\.)*'|`(?:[^`\\]|\\.)*`/g, '""');
    return [...stripped.matchAll(/(?<![\w.$])\d[\d_]*(?:\.\d+)?(?![\w.])/g)].map((m) =>
      Number(m[0].replaceAll("_", "")),
    );
  }

  it("scans the pay folder too", () => {
    expect(sources).toEqual(expect.arrayContaining(["pay/nmw.ts", "pay/ssp.ts", "pay/holiday.ts"]));
  });

  it.each(sources)("%s", (file) => {
    const allowed = new Set([0, 1, 2, ...(UNITS[file] ?? [])]);
    const found = numbersIn(readFileSync(`${folder}${file}`, "utf8")).filter(
      (n) => !allowed.has(n),
    );
    expect(found).toEqual([]);
  });

  it("would catch a figure written as a literal", () => {
    expect(numbersIn('const limit = 48 * 60; // 48 hours\nconst s = "11";')).toEqual([48, 60]);
  });
});
