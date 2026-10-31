/**
 * The rate-table figures the Phase 2 safety rules read (safety.md "Phase 2 rules", rates.md). Most
 * are tenant targets that no law sets, marked to verify and shown as targets, never as statutory
 * deadlines. Resolved once per request (tenant override, then nation, then `uk`, then `all`).
 */

import { type RateNation, type RateRow, resolveRate } from "../platform/rates";

export const SAFETY_PHASE2_RATE_KEYS = {
  safeguardingReferralHours: "safeguarding.referral_hours",
  complaintAcknowledgeWorkingDays: "complaint.acknowledge_working_days",
  complaintResponseWorkingDays: "complaint.response_working_days",
  lgscoTimeLimitMonths: "lgsco.time_limit_months",
  whistleblowingAcknowledgeWorkingDays: "whistleblowing.acknowledge_working_days",
  mortalityReviewDueDays: "mortality_review.due_days",
  missingPersonPoliceCallMinutes: "missing_person.police_call_minutes",
  herbertProtocolReviewMonths: "herbert_protocol.review_months",
  ahraResponseDays: "ahra.response_days",
  ahraRecentRecordResponseDays: "ahra.recent_record_response_days",
  ahraRecentRecordDays: "ahra.recent_record_days",
} as const;

export type SafetyPhase2RateName = keyof typeof SAFETY_PHASE2_RATE_KEYS;

export type SafetyPhase2Rates = { readonly [K in SafetyPhase2RateName]: number };

/** England only for now: the Ombudsman row is England's; other nations come with their packs. */
export function resolveSafetyPhase2Rates(
  rows: readonly RateRow[],
  nation: Exclude<RateNation, "uk" | "all">,
  on: string,
  tenantId: string | null,
): SafetyPhase2Rates {
  const entries = (Object.keys(SAFETY_PHASE2_RATE_KEYS) as SafetyPhase2RateName[]).map(
    (name) =>
      [name, resolveRate(rows, SAFETY_PHASE2_RATE_KEYS[name], nation, on, tenantId).value] as const,
  );
  return Object.fromEntries(entries) as SafetyPhase2Rates;
}
