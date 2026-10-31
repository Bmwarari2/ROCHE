/**
 * The rate-table figures the Phase 2 quality rules read (quality.md section 17, docs/specs/rates.md).
 * The CQC rating scale is England's until the nation packs; the rest are Harbour defaults or scheme
 * figures that apply everywhere. Every lookup fails loudly when a row is missing.
 */

import { type RateNation, type RateRow, resolveRate } from "../platform/rates";

type LookupNation = Exclude<RateNation, "uk" | "all">;

export const QUALITY_PHASE_2_RATE_KEYS = {
  ratingScaleMin: "cqc.rating_scale.min",
  ratingScaleMax: "cqc.rating_scale.max",
  bedDaysBase: "quality.indicator.bed_days_base",
  minGroupSize: "quality.indicator.min_group_size",
  incidentReviewTargetDays: "quality.incident_review.target_days",
  auditActionDueDays: "quality.audit.action_due_days",
  readAndSignReminderDays: "policy.read_and_sign.reminder_days",
  policyReviewDueSoonDays: "policy.review_due_soon_days",
  policyReviewIntervalMonthsMax: "policy.review_interval_months.max",
  renewalReminderDays: "quality.renewal_reminder_days",
  cyberEssentialsValidMonths: "cyber_essentials.certificate_valid_months",
  icoRenewalMonths: "ico.registration.renewal_months",
  dsptDeadlineMonth: "dspt.submission_deadline.month",
  dsptDeadlineDay: "dspt.submission_deadline.day",
} as const;

export type QualityPhase2Rates = {
  readonly [K in keyof typeof QUALITY_PHASE_2_RATE_KEYS]: number;
};

/** Every Phase 2 quality figure for a tenant at a location's nation on a UK date. */
export function resolveQualityPhase2Rates(
  rows: readonly RateRow[],
  nation: LookupNation,
  on: string,
  tenantId: string | null,
): QualityPhase2Rates {
  const keys = QUALITY_PHASE_2_RATE_KEYS;
  const entries = (Object.keys(keys) as (keyof typeof keys)[]).map(
    (name) => [name, resolveRate(rows, keys[name], nation, on, tenantId).value] as const,
  );
  return Object.fromEntries(entries) as QualityPhase2Rates;
}
