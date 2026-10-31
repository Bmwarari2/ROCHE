import { describe, expect, it } from "vitest";
import { readRateTable } from "../../test/rate-table";
import { RateNotFoundError } from "../platform/rates";
import { QUALITY_PHASE_2_RATE_KEYS, resolveQualityPhase2Rates } from "./quality-rates";

describe("the Phase 2 quality figures come from the rate table (quality.md 17.4)", () => {
  const rows = readRateTable();

  it("resolves every figure for an English location from docs/specs/rates.md", () => {
    const rates = resolveQualityPhase2Rates(rows, "england", "2026-10-31", null);
    for (const name of Object.keys(QUALITY_PHASE_2_RATE_KEYS)) {
      expect(Number.isFinite(rates[name as keyof typeof rates]), name).toBe(true);
    }
    expect(rates.ratingScaleMin).toBeLessThan(rates.ratingScaleMax);
  });

  it("fails loudly when a row is missing, never guessing", () => {
    const without = rows.filter((r) => r.key !== QUALITY_PHASE_2_RATE_KEYS.bedDaysBase);
    expect(() => resolveQualityPhase2Rates(without, "england", "2026-10-31", null)).toThrow(
      RateNotFoundError,
    );
  });

  it("lets a tenant override a default", () => {
    const tenant = "0194d000-0000-7000-8000-000000000001";
    const override = rows
      .filter((r) => r.key === QUALITY_PHASE_2_RATE_KEYS.readAndSignReminderDays)
      .map((r) => ({ ...r, value: "14", tenantId: tenant, verificationStatus: "tenant" }));
    const rates = resolveQualityPhase2Rates(
      [...rows, ...override],
      "england",
      "2026-10-31",
      tenant,
    );
    expect(rates.readAndSignReminderDays).toBe(14);
  });
});
