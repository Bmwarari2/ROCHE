import { describe, expect, it } from "vitest";
import { readRateTable } from "../../../test/rate-table";
import { IRREGULAR_HOURS_REFORM_FROM, irregularHoursHoliday } from "./holiday";
import { percentOf } from "./money";
import { resolvePayRates } from "./rates";

const rows = readRateTable();
const england = resolvePayRates(rows, "england", "2026-10-31", null);
const percent = england.holidayAccrualPercent ?? 0;

describe("holiday for irregular-hours workers (scheduling.md 4b rule 3)", () => {
  it.each([
    [600, Math.floor((600 * Math.round(percent * 100)) / 10_000)],
    [0, 0],
    [6_000, Math.floor((6_000 * Math.round(percent * 100)) / 10_000)],
  ])("accrues the rate table's percentage of %i minutes", (minutes, accrued) => {
    const result = irregularHoursHoliday(
      { leaveYearStart: "2026-04-01", minutesWorked: minutes, payPence: 0, rolledUp: false },
      england,
    );
    expect(result).toMatchObject({ applies: true, accruedMinutes: accrued, rolledUpPence: null });
  });

  it("itemises rolled-up holiday pay as its own line when the tenant uses it", () => {
    const result = irregularHoursHoliday(
      { leaveYearStart: "2026-04-01", minutesWorked: 600, payPence: 13_000, rolledUp: true },
      england,
    );
    if (!result.applies) throw new Error("expected to apply");
    expect(result.rolledUpPence).toBe(percentOf(13_000, percent));
    expect(result.working.at(-1)?.step).toContain("shown as its own line on the payslip");
  });

  it("does not apply to leave years before the reform", () => {
    expect(
      irregularHoursHoliday(
        { leaveYearStart: "2024-03-31", minutesWorked: 600, payPence: 0, rolledUp: true },
        england,
      ),
    ).toEqual({ applies: false, reason: "leave_year_before_reform" });
    expect(IRREGULAR_HOURS_REFORM_FROM).toBe("2024-04-01");
  });

  it("does not apply where the nation has no row (Northern Ireland)", () => {
    const ni = resolvePayRates(rows, "northern_ireland", "2026-10-31", null);
    expect(
      irregularHoursHoliday(
        { leaveYearStart: "2026-04-01", minutesWorked: 600, payPence: 0, rolledUp: false },
        ni,
      ),
    ).toEqual({ applies: false, reason: "no_rate_for_nation" });
  });
});
