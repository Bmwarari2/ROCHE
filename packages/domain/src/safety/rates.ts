/**
 * The rate-table figures the safety rules read (safety.md section 4, docs/specs/rates.md). Nothing in
 * the safety module holds one of these as a literal: callers resolve them once per request with
 * `resolveSafetyRates` (tenant override, then nation, then `uk`, then `all`) and pass them in.
 * Phase 1 classifies incidents in England; the other nations arrive with their nation packs.
 */

import { type RateRow, resolveRate } from "../platform/rates";

export const SAFETY_RATE_KEYS = {
  riddorReportDays: "riddor.report_days",
  riddorOver7DayReportDays: "riddor.over_7_day.report_days",
  riddorOver7DayThresholdDays: "riddor.over_7_day.threshold_days",
  candourWrittenWorkingDays: "candour.written_notification.working_days",
  candourProlongedHarmDays: "candour.prolonged_harm_days",
  reg18ProlongedHarmDays: "cqc.reg18.prolonged_harm_days",
  reg18InterruptionHours: "cqc.reg18.interruption_hours",
  ariCases: "outbreak.ari_cases",
  ariWindowDays: "outbreak.ari_window_days",
  diarrhoeaVomitingCases: "outbreak.diarrhoea_vomiting_cases",
  fluConfirmedCases: "outbreak.flu_confirmed_cases",
  pressureUlcerDecisionGuideHours: "pressure_ulcer.decision_guide_hours",
  fallsMonitoringHours: "falls.monitoring_hours",
  headInjuryPhase1IntervalMinutes: "falls.head_injury_obs.phase_1_interval_minutes",
  headInjuryPhase1Hours: "falls.head_injury_obs.phase_1_hours",
  headInjuryPhase2IntervalMinutes: "falls.head_injury_obs.phase_2_interval_minutes",
  headInjuryPhase2Hours: "falls.head_injury_obs.phase_2_hours",
  headInjuryPhase3IntervalMinutes: "falls.head_injury_obs.phase_3_interval_minutes",
} as const;

export type SafetyRateName = keyof typeof SAFETY_RATE_KEYS;

export type SafetyRates = { readonly [K in SafetyRateName]: number };

/** The nations whose incidents the classifier checks today. */
export const CLASSIFIER_NATIONS = ["england"] as const;
export type ClassifierNation = (typeof CLASSIFIER_NATIONS)[number];

/** Resolves every safety figure for an English location on a date; fails loudly if one is missing. */
export function resolveSafetyRates(
  rows: readonly RateRow[],
  nation: ClassifierNation,
  on: string,
  tenantId: string | null,
): SafetyRates {
  const entries = (Object.keys(SAFETY_RATE_KEYS) as SafetyRateName[]).map(
    (name) =>
      [name, resolveRate(rows, SAFETY_RATE_KEYS[name], nation, on, tenantId).value] as const,
  );
  return Object.fromEntries(entries) as SafetyRates;
}
