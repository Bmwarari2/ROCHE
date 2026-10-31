/**
 * Quality dashboard indicators (quality.md section 17, rules 16 to 22; QUAL-005; CQC Well-led).
 * Each indicator is a definition with its method in words; its value is worked out from a numerator
 * and denominator; its status is RAG against the tenant's own targets in the indicator's direction.
 * Rule 22, for HZ-129 (slice 47): missing data is never shown as good. Pure functions.
 */

import type { QualityPhase2Rates } from "./quality-rates";

export type IndicatorDirection = "lower_is_better" | "higher_is_better";

export interface IndicatorDefinition {
  readonly key: string;
  readonly title: string;
  readonly numerator: string;
  readonly denominator: string;
  /** What the ratio is multiplied by (1 for a count, 100 for a percentage, the bed-days base). */
  readonly multiplier: number;
  readonly unit: string;
  readonly direction: IndicatorDirection;
  /**
   * Rule 40: which counts could point at one person when small. A numerator always can; a
   * denominator only when it counts records about people (`both`), never bed-days.
   */
  readonly smallNumbers: "numerator" | "both";
}

/** The ten indicator keys (plan slice 47; master prompt 11.2). */
export const QUALITY_INDICATOR_KEYS = [
  "falls",
  "pressure_ulcers",
  "medication_errors",
  "missed_visits",
  "overdue_reviews",
  "training_compliance",
  "agency_hours",
  "complaints",
  "staff_turnover",
  "incident_response",
] as const;
export type QualityIndicatorKey = (typeof QUALITY_INDICATOR_KEYS)[number];

/**
 * Rule 39: where each indicator's figures come from today, in words; null where Harbour does not
 * record it yet (rule 38), so it is shown as "No data", never rated (quality.md 22.1).
 */
export const INDICATOR_SOURCES: Readonly<Record<QualityIndicatorKey, string | null>> = {
  falls: "Incidents recorded as a fall",
  pressure_ulcers: "Body map marks recorded as a new pressure ulcer",
  medication_errors: "Incidents recorded as a medication incident",
  missed_visits: null,
  overdue_reviews: "Active care plans and risk assessments",
  training_compliance: null,
  agency_hours: null,
  complaints: null,
  staff_turnover: null,
  incident_response: "Incidents and when each left open",
};

/** The method in words, shown beside every value (master prompt 11.2 "with the method shown"). */
export function indicatorMethod(definition: IndicatorDefinition): string {
  const times =
    definition.multiplier === 1 ? "" : ` × ${definition.multiplier.toLocaleString("en-GB")}`;
  return `${definition.title}: ${definition.numerator} ÷ ${definition.denominator}${times}.`;
}

/**
 * The Phase 2 indicators (master prompt 11.2), with the bed-days base from the rate table. The
 * source slices publish the numerators and denominators (slice 47).
 */
export function phase2Indicators(
  rates: Pick<QualityPhase2Rates, "bedDaysBase">,
): readonly IndicatorDefinition[] {
  const perBedDays = (key: string, title: string, numerator: string): IndicatorDefinition => ({
    key,
    title,
    numerator,
    denominator: "occupied bed-days",
    multiplier: rates.bedDaysBase,
    unit: `per ${rates.bedDaysBase.toLocaleString("en-GB")} occupied bed-days`,
    direction: "lower_is_better",
    smallNumbers: "numerator",
  });
  const percent = (
    key: string,
    title: string,
    numerator: string,
    denominator: string,
    direction: IndicatorDirection,
  ): IndicatorDefinition => ({
    key,
    title,
    numerator,
    denominator,
    multiplier: 100,
    unit: "percent",
    direction,
    smallNumbers: "both",
  });
  const count = (key: string, title: string, numerator: string): IndicatorDefinition => ({
    key,
    title,
    numerator,
    denominator: "1 (a count for the period)",
    multiplier: 1,
    unit: "count",
    direction: "lower_is_better",
    smallNumbers: "numerator",
  });
  return [
    perBedDays("falls", "Falls", "falls recorded"),
    perBedDays("pressure_ulcers", "Pressure ulcers", "new pressure ulcers recorded"),
    perBedDays("medication_errors", "Medication errors", "medication errors recorded"),
    percent("missed_visits", "Missed visits", "visits missed", "visits planned", "lower_is_better"),
    percent(
      "overdue_reviews",
      "Overdue reviews",
      "care plan and risk reviews overdue, and people with no care plan review date",
      "reviews due, and people with no care plan review date",
      "lower_is_better",
    ),
    percent(
      "training_compliance",
      "Training compliance",
      "required courses in date",
      "required courses",
      "higher_is_better",
    ),
    percent(
      "agency_hours",
      "Agency hours",
      "hours worked by agency staff",
      "hours worked",
      "lower_is_better",
    ),
    count("complaints", "Complaints", "complaints received"),
    percent(
      "staff_turnover",
      "Staff turnover",
      "staff who left",
      "average staff in post",
      "lower_is_better",
    ),
    percent(
      "incident_response",
      "Incidents reviewed in time",
      "incidents reviewed within the tenant's target",
      "incidents raised",
      "higher_is_better",
    ),
  ];
}

export interface IndicatorInput {
  readonly numerator: number | null;
  readonly denominator: number | null;
  /** The share (0 to 1) of the period and locations in view that has data. */
  readonly coverage: number;
}

export interface IndicatorTarget {
  /** The value at or better than which the indicator is green, in its direction. */
  readonly green: number;
  /** The value at or better than which it is amber; beyond it, red. */
  readonly amber: number;
}

export type RagStatus = "green" | "amber" | "red" | "no_data";

export type NoDataReason =
  | "unknown_indicator"
  | "no_value"
  | "no_denominator"
  | "incomplete_data"
  | "no_target"
  | "source_not_built"
  | "small_number";

export const NO_DATA_REASONS: Readonly<Record<NoDataReason, string>> = {
  unknown_indicator: "Harbour does not know this indicator.",
  no_value: "No data has been recorded for this period.",
  no_denominator: "There is nothing to measure against for this period.",
  incomplete_data: "Data incomplete for this period.",
  no_target: "No target has been set, so it is not rated.",
  source_not_built: "Harbour does not record this yet.",
  small_number:
    "A small number: not shown, so no one can be identified. Its status against your target is still shown.",
};

export interface IndicatorResult {
  readonly key: string;
  /** Exact; null whenever the status is `no_data` and nothing can be worked out. */
  readonly value: number | null;
  /** Rounded to one decimal for display; null with the value. */
  readonly display: number | null;
  readonly status: RagStatus;
  readonly reason: string | null;
  /** The reason as a code, for the screens' own words; null when rated. */
  readonly reasonCode: NoDataReason | null;
  readonly method: string;
}

/** Rule 17: numerator ÷ denominator × multiplier; null when there is no denominator or numerator. */
export function computeIndicator(
  definition: IndicatorDefinition,
  input: IndicatorInput,
): number | null {
  if (input.numerator === null || !Number.isFinite(input.numerator)) return null;
  if (input.denominator === null || !(input.denominator > 0)) return null;
  return (input.numerator / input.denominator) * definition.multiplier;
}

export type TargetProblem = "not_a_number" | "wrong_order";

/** Rule 18: the tenant's thresholds make sense in the indicator's direction. */
export function checkIndicatorTarget(
  definition: Pick<IndicatorDefinition, "direction">,
  target: IndicatorTarget,
): TargetProblem[] {
  if (!Number.isFinite(target.green) || !Number.isFinite(target.amber)) return ["not_a_number"];
  const ordered =
    definition.direction === "lower_is_better"
      ? target.green <= target.amber
      : target.green >= target.amber;
  return ordered ? [] : ["wrong_order"];
}

/** Rule 19: the band a value falls in, boundaries counting as the better band. */
export function ragStatus(
  definition: Pick<IndicatorDefinition, "direction">,
  value: number,
  target: IndicatorTarget,
): Exclude<RagStatus, "no_data"> {
  const atOrBetter = (threshold: number) =>
    definition.direction === "lower_is_better" ? value <= threshold : value >= threshold;
  if (atOrBetter(target.green)) return "green";
  if (atOrBetter(target.amber)) return "amber";
  return "red";
}

/**
 * Rules 17 to 22: an indicator's result for a view. **Missing data is never shown as good** (rule
 * 22, HZ-129): an unknown indicator, a missing value or denominator, incomplete coverage (rule 20)
 * or a missing or unusable target gives `no_data` with its reason, never `green` and never a value
 * of 0 that was not recorded.
 */
export function indicatorResult(
  definition: IndicatorDefinition | undefined,
  input: IndicatorInput,
  target: IndicatorTarget | null,
): IndicatorResult {
  const noData = (
    key: string,
    reason: NoDataReason,
    method: string,
    value: number | null = null,
  ) => ({
    key,
    value,
    display: value === null ? null : Math.round(value * 10) / 10,
    status: "no_data" as const,
    reason: NO_DATA_REASONS[reason],
    reasonCode: reason,
    method,
  });
  if (!definition) return noData("unknown", "unknown_indicator", "");
  const method = indicatorMethod(definition);
  if (input.numerator === null || !Number.isFinite(input.numerator)) {
    return noData(definition.key, "no_value", method);
  }
  if (input.denominator === null || !(input.denominator > 0)) {
    return noData(definition.key, "no_denominator", method);
  }
  if (!(input.coverage >= 1)) return noData(definition.key, "incomplete_data", method);
  const value = computeIndicator(definition, input) as number;
  if (target === null || checkIndicatorTarget(definition, target).length > 0) {
    // The value is real and shown, but without a target it is never rated, least of all green.
    return noData(definition.key, "no_target", method, value);
  }
  return {
    key: definition.key,
    value,
    display: Math.round(value * 10) / 10,
    status: ragStatus(definition, value, target),
    reason: null,
    reasonCode: null,
    method,
  };
}

export interface DashboardIndicator extends IndicatorResult {
  /** Rule 39: the working, or null where rule 40 withholds it (or there is none). */
  readonly numerator: number | null;
  readonly denominator: number | null;
}

/** Rule 40: a count of 1 or more but below the minimum group size could point at one person. */
export function isSmallNumber(count: number | null, minGroupSize: number): boolean {
  return count !== null && count >= 1 && count < minGroupSize;
}

/**
 * Rules 38 to 41: one indicator for the dashboard. A source not built yet, missing or incomplete
 * data each give `no_data` with their reason (never green, HZ-129), and an incomplete period shows
 * no working (its counts would be a running tally). A small count (rule 40), or for a count of
 * records about people a small denominator or a small remainder, is withheld with its value, but
 * its status against the target is still shown, so a rising signal is never hidden (slice 47
 * clinical review); with no target it stays unrated.
 */
export function dashboardIndicator(
  definition: IndicatorDefinition,
  input: IndicatorInput,
  target: IndicatorTarget | null,
  options: { readonly minGroupSize: number; readonly built: boolean },
): DashboardIndicator {
  const method = indicatorMethod(definition);
  if (!options.built) {
    return {
      key: definition.key,
      value: null,
      display: null,
      status: "no_data",
      reason: NO_DATA_REASONS.source_not_built,
      reasonCode: "source_not_built",
      method,
      numerator: null,
      denominator: null,
    };
  }
  const result = indicatorResult(definition, input, target);
  if (result.reasonCode === "incomplete_data") {
    return { ...result, numerator: null, denominator: null };
  }
  const small = (n: number | null) => isSmallNumber(n, options.minGroupSize);
  const aboutPeople = definition.smallNumbers === "both";
  const remainder =
    input.numerator !== null && input.denominator !== null
      ? input.denominator - input.numerator
      : null;
  const smallDenominator = aboutPeople && (small(input.denominator) || small(remainder));
  if (small(input.numerator) || smallDenominator) {
    const rated = result.status !== "no_data";
    return {
      key: definition.key,
      value: null,
      display: null,
      status: rated ? result.status : "no_data",
      reason: NO_DATA_REASONS.small_number,
      reasonCode: "small_number",
      method,
      numerator: null,
      denominator: smallDenominator ? null : input.denominator,
    };
  }
  return { ...result, numerator: input.numerator, denominator: input.denominator };
}

export interface StoredTarget extends IndicatorTarget {
  readonly locationId: string | null;
  readonly indicatorKey: string;
}

/** Rule 41: the location's own target, else the organisation default, else none. */
export function targetFor(
  key: string,
  targets: readonly StoredTarget[],
  locationId: string,
): IndicatorTarget | null {
  const pick = (t: StoredTarget | undefined) => (t ? { green: t.green, amber: t.amber } : null);
  return (
    pick(targets.find((t) => t.indicatorKey === key && t.locationId === locationId)) ??
    pick(targets.find((t) => t.indicatorKey === key && t.locationId === null))
  );
}
