/**
 * The rate-table figures the workforce rules read (workforce.md section 4, rates.md). Nothing in
 * the workforce module holds one of these as a literal: callers resolve them once with
 * `resolveWorkforceRates` (tenant override, then nation, then `uk`, then `all`) and pass them in.
 */

import { type RateNation, RateNotFoundError, type RateRow, resolveRate } from "../platform/rates";

export const WORKFORCE_RATE_KEYS = {
  trainingDefaultRefreshYears: "training.default_refresh_years",
  oliverMcGowanRefreshYears: "training.oliver_mcgowan.refresh_years",
  medicinesCompetenceRefreshMonths: "competence.medicines.refresh_months",
  competenceDefaultRefreshMonths: "competence.default_refresh_months",
  supervisionsPerYear: "supervision.per_year",
  appraisalsPerYear: "appraisal.per_year",
  reminderDaysFirst: "document_expiry.reminder_days.first",
  reminderDaysSecond: "document_expiry.reminder_days.second",
  reminderDaysThird: "document_expiry.reminder_days.third",
  nmcCycleYears: "nmc.revalidation.cycle_years",
  nmcPracticeHours: "nmc.revalidation.practice_hours",
  nmcCpdHours: "nmc.revalidation.cpd_hours",
  nmcParticipatoryCpdHours: "nmc.revalidation.participatory_cpd_hours",
  nmcFeedbackCount: "nmc.revalidation.feedback_count",
  nmcReflectiveAccounts: "nmc.revalidation.reflective_accounts",
  dbsUpdateServiceCheckMonths: "dbs.update_service.check_interval_months",
  drivingLicenceCheckMonths: "workforce.driving_licence_check_months",
  sponsorSalaryFloorYearly: "sponsor.salary_floor.care_worker",
  sponsorSalaryFloorHourly: "sponsor.salary_floor.care_worker_hourly",
  sponsorChangeReportWorkingDays: "sponsor.change_report_working_days",
  sponsorCountedWeeklyHoursMax: "sponsor.counted_weekly_hours_max",
} as const;

export type WorkforceRateName = keyof typeof WORKFORCE_RATE_KEYS;

/**
 * Figures that exist only in some nations: the Oliver McGowan Mandatory Training is England's
 * (rates.md), so elsewhere it resolves to null and a tenant's own requirement uses the default
 * refresh (workforce.md rule 5).
 */
const NATION_ONLY: ReadonlySet<WorkforceRateName> = new Set(["oliverMcGowanRefreshYears"]);

export type WorkforceRates = {
  readonly [K in WorkforceRateName]: K extends "oliverMcGowanRefreshYears" ? number | null : number;
};

/** Resolves every workforce figure for a tenant location on a date; fails loudly if one is missing. */
export function resolveWorkforceRates(
  rows: readonly RateRow[],
  nation: Exclude<RateNation, "uk" | "all">,
  on: string,
  tenantId: string | null,
): WorkforceRates {
  const entries = (Object.keys(WORKFORCE_RATE_KEYS) as WorkforceRateName[]).map((name) => {
    try {
      return [
        name,
        resolveRate(rows, WORKFORCE_RATE_KEYS[name], nation, on, tenantId).value,
      ] as const;
    } catch (error) {
      if (NATION_ONLY.has(name) && error instanceof RateNotFoundError) return [name, null] as const;
      throw error;
    }
  });
  return Object.fromEntries(entries) as WorkforceRates;
}

/** The three document-expiry reminder offsets in days, largest first. */
export function reminderDays(rates: WorkforceRates): readonly number[] {
  return [rates.reminderDaysFirst, rates.reminderDaysSecond, rates.reminderDaysThird].sort(
    (a, b) => b - a,
  );
}
