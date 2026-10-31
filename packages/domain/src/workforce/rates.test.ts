import { describe, expect, it } from "vitest";
import { readRateTable } from "../../test/rate-table";
import { RateNotFoundError } from "../platform/rates";
import {
  reminderDays,
  resolveWorkforceRates,
  WORKFORCE_RATE_KEYS,
  type WorkforceRateName,
} from "./rates";

describe("workforce rates come from the rate table", () => {
  const rows = readRateTable();

  it("finds every workforce key in docs/specs/rates.md for England, Wales and Scotland", () => {
    for (const nation of ["england", "wales", "scotland"] as const) {
      const rates = resolveWorkforceRates(rows, nation, "2026-10-31", null);
      for (const name of Object.keys(WORKFORCE_RATE_KEYS) as WorkforceRateName[]) {
        if (name === "oliverMcGowanRefreshYears" && nation !== "england") {
          // England's training only (rates.md): null elsewhere, never a made-up figure.
          expect(rates[name]).toBeNull();
          continue;
        }
        expect(rates[name], name).toBeGreaterThan(0);
      }
    }
  });

  it("fails loudly when a key is missing, never falling back to a literal", () => {
    const without = rows.filter((r) => r.key !== WORKFORCE_RATE_KEYS.supervisionsPerYear);
    expect(() => resolveWorkforceRates(without, "england", "2026-10-31", null)).toThrow(
      RateNotFoundError,
    );
  });

  it("orders the reminder days largest first", () => {
    const rates = resolveWorkforceRates(rows, "england", "2026-10-31", null);
    const days = reminderDays(rates);
    expect([...days]).toEqual([...days].sort((a, b) => b - a));
    expect(days).toHaveLength(3);
  });
});
