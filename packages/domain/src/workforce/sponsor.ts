import { addWorkingDays, type BankHolidays } from "../shared/working-days";

/**
 * Sponsor licence duties (workforce.md rule 9; WORK-003; Home Office guidance for sponsors). A
 * reportable change is due within `sponsor.change_report_working_days` working days of the day it
 * happened (the location nation's bank holidays; the event's own day never counts). The salary
 * check: guaranteed basic gross pay a year at least the annual floor and, worked out over the
 * contracted weekly hours (counting at most `sponsor.counted_weekly_hours_max` a week), at least the
 * hourly floor. Both must be met.
 */

/** Weeks in a year as the Home Office counts pay: a calendar fact, not a statutory figure. */
const WEEKS_IN_YEAR = 52;

export interface SponsorRates {
  readonly sponsorSalaryFloorYearly: number;
  readonly sponsorSalaryFloorHourly: number;
  readonly sponsorChangeReportWorkingDays: number;
  readonly sponsorCountedWeeklyHoursMax: number;
}

/** The last day a change that happened on `happenedOn` may be reported. */
export function changeReportDueOn(
  happenedOn: string,
  holidays: BankHolidays,
  rates: SponsorRates,
): string {
  return addWorkingDays(happenedOn, rates.sponsorChangeReportWorkingDays, holidays);
}

export function changeReportState(
  happenedOn: string,
  reportedOn: string | null,
  today: string,
  holidays: BankHolidays,
  rates: SponsorRates,
): { readonly dueOn: string; readonly state: "reported" | "reported_late" | "open" | "overdue" } {
  const dueOn = changeReportDueOn(happenedOn, holidays, rates);
  if (reportedOn) return { dueOn, state: reportedOn <= dueOn ? "reported" : "reported_late" };
  return { dueOn, state: today > dueOn ? "overdue" : "open" };
}

export interface SalaryCheck {
  readonly meetsYearly: boolean;
  readonly meetsHourly: boolean;
  readonly passes: boolean;
  /** Pay an hour over the hours counted, in pounds to the penny. */
  readonly hourlyPay: number;
  readonly countedWeeklyHours: number;
}

/** Pay in whole pence avoids floating-point drift; inputs are pounds. */
export function salaryCheck(
  yearlyPay: number,
  weeklyHours: number,
  rates: SponsorRates,
): SalaryCheck {
  if (!(weeklyHours > 0)) throw new RangeError("Weekly hours must be more than zero.");
  const counted = Math.min(weeklyHours, rates.sponsorCountedWeeklyHoursMax);
  const pence = Math.round(yearlyPay * 100);
  const hourlyPence = Math.floor(pence / (counted * WEEKS_IN_YEAR));
  const meetsYearly = pence >= Math.round(rates.sponsorSalaryFloorYearly * 100);
  const meetsHourly = hourlyPence >= Math.round(rates.sponsorSalaryFloorHourly * 100);
  return {
    meetsYearly,
    meetsHourly,
    passes: meetsYearly && meetsHourly,
    hourlyPay: hourlyPence / 100,
    countedWeeklyHours: counted,
  };
}
