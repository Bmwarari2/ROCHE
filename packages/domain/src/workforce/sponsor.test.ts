import { describe, expect, it } from "vitest";
import { readRateTable } from "../../test/rate-table";
import { addWorkingDays } from "../shared/working-days";
import { resolveWorkforceRates } from "./rates";
import { changeReportDueOn, changeReportState, salaryCheck } from "./sponsor";

const rates = resolveWorkforceRates(readRateTable(), "england", "2026-10-31", null);
const days = rates.sponsorChangeReportWorkingDays;
// England and Wales bank holidays around Christmas 2026 (from the bank_holiday table in production).
const HOLIDAYS = new Set(["2026-12-25", "2026-12-28"]);

describe("sponsor change reports in working days (workforce.md rule 9)", () => {
  it("counts working days from the day after the change, skipping weekends and bank holidays", () => {
    // Friday 18 December 2026: weekends and both holidays are skipped.
    expect(changeReportDueOn("2026-12-18", HOLIDAYS, rates)).toBe(
      addWorkingDays("2026-12-18", days, HOLIDAYS),
    );
    expect(
      changeReportDueOn("2026-12-18", HOLIDAYS, rates) >
        changeReportDueOn("2026-12-18", new Set(), rates),
    ).toBe(true);
  });

  it("counts a change on a Saturday from the next working day, never the Saturday itself", () => {
    expect(changeReportDueOn("2026-10-31", new Set(), rates)).toBe(
      addWorkingDays("2026-10-31", days, new Set()),
    );
  });

  it.each([
    ["reported on the last day", "2026-11-02", "reported"],
    ["reported a day late", "next", "reported_late"],
    ["not reported, still in time", null, "open"],
  ] as const)("%s", (_, reported, state) => {
    const due = changeReportDueOn("2026-10-19", new Set(), rates);
    const reportedOn = reported === "next" ? addWorkingDays(due, 1, new Set()) : reported;
    expect(changeReportState("2026-10-19", reportedOn, "2026-10-20", new Set(), rates).state).toBe(
      state,
    );
  });

  it("is overdue from the day after the last day", () => {
    const due = changeReportDueOn("2026-10-19", new Set(), rates);
    expect(
      changeReportState("2026-10-19", null, addWorkingDays(due, 1, new Set()), new Set(), rates)
        .state,
    ).toBe("overdue");
  });
});

describe("sponsor salary floor (workforce.md rule 9)", () => {
  const hoursForFloor = rates.sponsorSalaryFloorYearly / (rates.sponsorSalaryFloorHourly * 52);

  it("passes when both the yearly and the hourly floor are met", () => {
    const check = salaryCheck(rates.sponsorSalaryFloorYearly, Math.floor(hoursForFloor), rates);
    expect(check).toMatchObject({ meetsYearly: true, meetsHourly: true, passes: true });
  });

  it("fails the yearly floor by a penny", () => {
    const check = salaryCheck(rates.sponsorSalaryFloorYearly - 0.01, 30, rates);
    expect(check.meetsYearly).toBe(false);
    expect(check.passes).toBe(false);
  });

  it("fails the hourly floor when the yearly pay is spread over long hours", () => {
    const check = salaryCheck(rates.sponsorSalaryFloorYearly, Math.ceil(hoursForFloor) + 5, rates);
    expect(check.meetsYearly).toBe(true);
    expect(check.meetsHourly).toBe(false);
  });

  it("counts at most the weekly hours cap", () => {
    const check = salaryCheck(60_000, rates.sponsorCountedWeeklyHoursMax + 12, rates);
    expect(check.countedWeeklyHours).toBe(rates.sponsorCountedWeeklyHoursMax);
  });

  it("refuses zero hours", () => {
    expect(() => salaryCheck(30_000, 0, rates)).toThrow(RangeError);
  });
});
