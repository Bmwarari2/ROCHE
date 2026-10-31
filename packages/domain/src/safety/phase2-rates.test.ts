import { describe, expect, it } from "vitest";
import { readRateTable } from "../../test/rate-table";
import { RateNotFoundError } from "../platform/rates";
import {
  resolveSafetyPhase2Rates,
  SAFETY_PHASE2_RATE_KEYS,
  type SafetyPhase2RateName,
} from "./phase2-rates";

const rows = readRateTable();

describe("Phase 2 safety figures come from the rate table", () => {
  it("resolves every key for England, each a positive number", () => {
    const rates = resolveSafetyPhase2Rates(rows, "england", "2026-10-31", null);
    for (const name of Object.keys(SAFETY_PHASE2_RATE_KEYS) as SafetyPhase2RateName[]) {
      expect(rates[name], name).toBeGreaterThan(0);
    }
  });

  it("fails loudly without a figure, never falling back to a literal", () => {
    const without = rows.filter(
      (r) => r.key !== SAFETY_PHASE2_RATE_KEYS.complaintResponseWorkingDays,
    );
    expect(() => resolveSafetyPhase2Rates(without, "england", "2026-10-31", null)).toThrow(
      RateNotFoundError,
    );
  });
});
