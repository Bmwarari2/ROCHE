/**
 * The rate-table figures the pay rules read (scheduling.md section 4b, rates.md; ADR-0086). Money
 * comes back in whole pence. Rows that exist only for some nations (holiday accrual, SSP) resolve to
 * null where the nation has none, and the rule then does not apply (H-529); every other figure must
 * exist or resolving fails loudly.
 */

import {
  type RateNation,
  RateNotFoundError,
  type RateRow,
  resolveRate,
} from "../../platform/rates";
import { PENCE_PER_POUND } from "./money";

const MONEY = {
  nmw21Plus: "nmw.hourly.21_plus",
  nmw18To20: "nmw.hourly.18_to_20",
  nmwUnder18: "nmw.hourly.under_18",
  nmwApprentice: "nmw.hourly.apprentice",
  accommodationOffsetDaily: "nmw.accommodation_offset.daily",
  sspWeekly: "ssp.weekly",
  familyPayStandardWeekly: "family_pay.standard_weekly",
  smpStandardWeekly: "smp.standard_weekly",
  aeTriggerWeekly: "auto_enrolment.earnings_trigger.weekly",
  aeTriggerMonthly: "auto_enrolment.earnings_trigger.monthly",
  aeLowerWeekly: "auto_enrolment.qualifying_earnings.lower.weekly",
  aeLowerMonthly: "auto_enrolment.qualifying_earnings.lower.monthly",
  aeUpperWeekly: "auto_enrolment.qualifying_earnings.upper.weekly",
  aeUpperMonthly: "auto_enrolment.qualifying_earnings.upper.monthly",
} as const;

const FIGURES = {
  nmwAge21Plus: "nmw.age.21_plus",
  nmwAge18To20: "nmw.age.18_to_20",
  apprenticeAgeLimit: "nmw.apprentice.age_limit",
  apprenticeFirstYearMonths: "nmw.apprentice.first_year_months",
  holidayAccrualPercent: "holiday.accrual_percentage.irregular_hours",
  sspEarningsPercent: "ssp.earnings_percentage",
  sspWaitingDays: "ssp.waiting_days",
  sspMaxWeeks: "ssp.max_weeks",
  familyPayEarningsPercent: "family_pay.earnings_percentage",
  smpHigherRateWeeks: "smp.higher_rate_weeks",
  smpTotalWeeks: "smp.total_weeks",
  awrQualifyingWeeks: "awr.qualifying_weeks",
  awrBreakResetWeeks: "awr.break_reset_weeks",
  awrSicknessPauseMaxWeeks: "awr.sickness_pause_max_weeks",
  aeEligibleMinAge: "auto_enrolment.eligible_min_age",
  aeMinAge: "auto_enrolment.min_age",
  aeMaxAge: "auto_enrolment.max_age",
  bradfordWindowWeeks: "absence.bradford.window_weeks",
} as const;

/** Rates that only some nations have: null elsewhere, and the rule does not apply there. */
const NATION_ONLY = new Set<string>([
  "holidayAccrualPercent",
  "sspEarningsPercent",
  "sspWaitingDays",
  "sspWeekly",
]);

export const PAY_RATE_KEYS = { ...MONEY, ...FIGURES } as const;

type MoneyName = keyof typeof MONEY;
type FigureName = keyof typeof FIGURES;
type Optional = "holidayAccrualPercent" | "sspEarningsPercent" | "sspWaitingDays" | "sspWeekly";

/** Money in whole pence; other figures as published; the nation-only ones may be null. */
export type PayRates = {
  readonly [K in MoneyName | FigureName]: K extends Optional ? number | null : number;
};

/**
 * Figures a tenant may set for itself (tenant defaults). Every other figure is statutory, so a
 * tenant row never replaces it: a lower minimum wage or a shorter AWR clock cannot be configured.
 */
const TENANT_DEFAULTS = new Set<string>(["bradfordWindowWeeks"]);

/** Pounds as written in the rate table to whole pence, without floating-point drift. */
export function toPence(pounds: string | number): number {
  return Math.round(Number(pounds) * PENCE_PER_POUND);
}

export function resolvePayRates(
  rows: readonly RateRow[],
  nation: Exclude<RateNation, "uk" | "all">,
  on: string,
  tenantId: string | null,
): PayRates {
  const read = (name: string, key: string): number | null => {
    try {
      const tenant = TENANT_DEFAULTS.has(name) ? tenantId : null;
      return resolveRate(rows, key, nation, on, tenant).value;
    } catch (error) {
      if (NATION_ONLY.has(name) && error instanceof RateNotFoundError) return null;
      throw error;
    }
  };
  const out: Record<string, number | null> = {};
  for (const [name, key] of Object.entries(MONEY)) {
    const value = read(name, key);
    out[name] = value === null ? null : toPence(value);
  }
  for (const [name, key] of Object.entries(FIGURES)) out[name] = read(name, key);
  return out as PayRates;
}
