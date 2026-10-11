/**
 * Retention engine rules (section 5.1). The schedule itself (record class, period, trigger) is
 * reference data seeded from docs/specs/retention.md; this module computes when a record becomes
 * eligible for destruction and enforces that tenant overrides never go below the default.
 */

export type RetentionTrigger =
  | "care_ended"
  | "last_entry"
  | "record_closed"
  | "employment_ended_or_75th_birthday"
  | "created"
  | "tenant_policy";

export interface RetentionRule {
  readonly recordClass: string;
  readonly period: number;
  readonly unit: "years" | "months";
  readonly trigger: RetentionTrigger;
}

export interface RetentionInput {
  /** The date the trigger event happened (care ended, last entry, record closed, created). */
  readonly triggerDate: Date;
  readonly legalHold: boolean;
}

export type RetentionDecision =
  | { readonly status: "retain"; readonly until: Date }
  | { readonly status: "eligible_for_destruction"; readonly since: Date }
  | { readonly status: "legal_hold" }
  | { readonly status: "tenant_policy" };

export function addPeriod(date: Date, period: number, unit: "years" | "months"): Date {
  const result = new Date(date.getTime());
  const day = result.getUTCDate();
  if (unit === "years") result.setUTCFullYear(result.getUTCFullYear() + period);
  else result.setUTCMonth(result.getUTCMonth() + period);
  // 29 February plus a year, or 31st plus a month, rolls back to the last day of the month.
  if (result.getUTCDate() !== day) result.setUTCDate(0);
  return result;
}

export function retentionDecision(
  rule: RetentionRule,
  input: RetentionInput,
  now: Date,
): RetentionDecision {
  if (input.legalHold) return { status: "legal_hold" };
  if (rule.trigger === "tenant_policy") return { status: "tenant_policy" };
  const until = addPeriod(input.triggerDate, rule.period, rule.unit);
  if (until.getTime() > now.getTime()) return { status: "retain", until };
  return { status: "eligible_for_destruction", since: until };
}

function inMonths(rule: Pick<RetentionRule, "period" | "unit">): number {
  return rule.unit === "years" ? rule.period * 12 : rule.period;
}

/** Tenants may keep records longer than the default, never shorter (section 9.1). */
export function validateTenantOverride(
  defaultRule: RetentionRule,
  override: Pick<RetentionRule, "period" | "unit">,
): { readonly ok: true } | { readonly ok: false; readonly message: string } {
  if (inMonths(override) < inMonths(defaultRule)) {
    return {
      ok: false,
      message: `Records of this kind must be kept for at least ${defaultRule.period} ${defaultRule.unit}.`,
    };
  }
  return { ok: true };
}
