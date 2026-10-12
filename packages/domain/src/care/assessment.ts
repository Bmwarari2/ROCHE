/**
 * Shared shapes for validated assessment tools and chart rules (care.md section 4, rule 5; hazards
 * HZ-012 and HZ-014; medical-device boundary section 5). Every calculator returns its tool version,
 * the total, the published band, the workings shown to staff and the follow-ups the result raises.
 * Incomplete or impossible input gives a typed error, never a partial total.
 */

import { addPeriod } from "../platform/retention";

export type ValidatedToolKey = "news2" | "must" | "waterlow" | "braden";

/** One line of the calculation as shown to staff, so they can check the arithmetic by hand. */
export interface ScoreWorking {
  readonly item: string;
  readonly value: string;
  readonly points: number;
}

export type CareTaskKind =
  | "news2_response"
  | "food_and_fluid_record"
  | "dietitian_referral"
  | "nutrition_assessment"
  | "comprehensive_falls_assessment"
  | "gait_and_balance_assessment"
  | "falls_review"
  | "incident_report"
  | "safeguarding_decision_guide";

export interface RepeatInterval {
  readonly kind: "interval";
  /** Published wording, for example "Minimum 4–6 hourly". */
  readonly text: string;
  readonly shortestHours: number;
  readonly longestHours: number;
}

export interface ContinuousMonitoring {
  readonly kind: "continuous";
  readonly text: string;
}

export type MonitoringFrequency = RepeatInterval | ContinuousMonitoring;

export type WeightInterval =
  | { readonly unit: "weeks"; readonly value: number }
  | { readonly unit: "months"; readonly value: number };

/**
 * Why an urgent alert was raised, as a code: what an audit of an alert no one could be told about
 * records, never the result itself (#26 review round 3).
 */
export type UrgentAlertCode =
  | "news2_threshold"
  | "iddsi_level_not_recorded"
  | "iddsi_reason_missing"
  | "iddsi_prescribed_unreadable"
  | "iddsi_unsafe_level";

/** A follow-up a result raises; the task engine turns these into tasks, alerts and schedules. */
export type CareTrigger =
  | {
      readonly kind: "urgent_alert";
      readonly recipient: "nurse_in_charge";
      readonly reason: string;
      /** Absent on alerts stored before codes were kept. */
      readonly code?: UrgentAlertCode;
    }
  | {
      readonly kind: "task";
      readonly task: CareTaskKind;
      readonly reason: string;
      /** For a record kept over several days, such as the MUST food and fluid record. */
      readonly forDays?: number;
    }
  | { readonly kind: "repeat_observations"; readonly frequency: MonitoringFrequency }
  | {
      readonly kind: "rescreen";
      readonly toolKey: ValidatedToolKey | "ng249_falls";
      readonly dueOn: string;
    }
  | { readonly kind: "weight_interval"; readonly interval: WeightInterval };

export interface ToolResult<K extends ValidatedToolKey, B extends string> {
  readonly toolKey: K;
  readonly toolVersion: string;
  readonly score: number;
  readonly band: B;
  readonly workings: readonly ScoreWorking[];
  readonly triggers: readonly CareTrigger[];
}

export type InputProblem =
  | "missing"
  | "not_a_whole_number"
  | "too_many_decimal_places"
  | "out_of_range"
  | "not_allowed";

export interface InputIssue {
  /** The input field, for example `respirationRate`. */
  readonly item: string;
  readonly problem: InputProblem;
  readonly message: string;
}

export interface ToolFailure {
  readonly ok: false;
  /** `incomplete` when any value is missing, otherwise `invalid`. */
  readonly code: "incomplete" | "invalid";
  readonly issues: readonly InputIssue[];
  readonly message: string;
}

export type ToolOutcome<R> = { readonly ok: true; readonly result: R } | ToolFailure;

function plural(count: number, one: string, many: string): string {
  return `${count} ${count === 1 ? one : many}`;
}

/** Collects input problems so the screen can show all of them at once. */
export class InputCheck {
  readonly issues: InputIssue[] = [];

  add(item: string, problem: InputProblem, message: string): void {
    this.issues.push({ item, problem, message });
  }

  present<T>(item: string, label: string, value: T | null | undefined): T | undefined {
    if (value === null || value === undefined) {
      this.add(item, "missing", `${label} is missing.`);
      return undefined;
    }
    return value;
  }

  /** A number within [min, max] with at most `decimals` decimal places. */
  number(
    item: string,
    label: string,
    value: number | null | undefined,
    limits: { readonly min: number; readonly max: number; readonly decimals?: number },
  ): number | undefined {
    const present = this.present(item, label, value);
    if (present === undefined) return undefined;
    const decimals = limits.decimals ?? Number.POSITIVE_INFINITY;
    if (!Number.isFinite(present)) {
      this.add(item, "out_of_range", `${label} must be a number.`);
      return undefined;
    }
    if (decimals === 0 && !Number.isInteger(present)) {
      this.add(item, "not_a_whole_number", `${label} must be a whole number.`);
      return undefined;
    }
    if (decimals > 0 && Number.isFinite(decimals)) {
      const scaled = present * 10 ** decimals;
      if (Math.abs(scaled - Math.round(scaled)) > 1e-9) {
        this.add(
          item,
          "too_many_decimal_places",
          `${label} must have no more than ${plural(decimals, "decimal place", "decimal places")}.`,
        );
        return undefined;
      }
    }
    if (present < limits.min || present > limits.max) {
      this.add(item, "out_of_range", `${label} must be between ${limits.min} and ${limits.max}.`);
      return undefined;
    }
    return present;
  }

  /** A value from a fixed list of options. */
  option<T extends string>(
    item: string,
    label: string,
    value: T | null | undefined,
    allowed: readonly T[],
  ): T | undefined {
    const present = this.present(item, label, value);
    if (present === undefined) return undefined;
    if (!allowed.includes(present)) {
      this.add(item, "not_allowed", `${label} is not one of the published options.`);
      return undefined;
    }
    return present;
  }

  /** Several options chosen from a list, each at most once. An empty list is a valid answer. */
  options<T extends string>(
    item: string,
    label: string,
    values: readonly T[] | null | undefined,
    allowed: readonly T[],
  ): readonly T[] | undefined {
    const present = this.present(item, label, values);
    if (present === undefined) return undefined;
    if (present.some((v) => !allowed.includes(v)) || new Set(present).size !== present.length) {
      this.add(item, "not_allowed", `${label} has an option that is not published or is repeated.`);
      return undefined;
    }
    return present;
  }

  get failed(): boolean {
    return this.issues.length > 0;
  }

  failure(): ToolFailure {
    const missing = this.issues.filter((i) => i.problem === "missing").length;
    if (missing > 0) {
      return {
        ok: false,
        code: "incomplete",
        issues: this.issues,
        message: `Score incomplete: ${plural(missing, "value", "values")} missing.`,
      };
    }
    return {
      ok: false,
      code: "invalid",
      issues: this.issues,
      message: `Score not calculated: ${plural(this.issues.length, "value needs", "values need")} checking.`,
    };
  }
}

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

/** True for a real calendar date written yyyy-mm-dd. */
export function isIsoDate(value: string): boolean {
  if (!ISO_DATE.test(value)) return false;
  const date = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(date.getTime()) && date.toISOString().slice(0, 10) === value;
}

/** Adds whole months to a date (31 January plus one month is 28 or 29 February). */
export function addMonthsToDate(isoDate: string, months: number): string {
  return addPeriod(new Date(`${isoDate}T00:00:00Z`), months, "months")
    .toISOString()
    .slice(0, 10);
}

export function addDaysToDate(isoDate: string, days: number): string {
  const date = new Date(`${isoDate}T00:00:00Z`);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

/**
 * Body mass index (kg/m²) held as whole grams over square millimetres. Tool bands are compared on
 * this exact value, never on a rounded one, and without floating-point error, so a BMI of 18.49
 * is under 18.5 and 20.01 is over 20 (HZ-012). Rounding is for display only (`formatBmi`).
 */
export interface ExactBmi {
  readonly grams: number;
  readonly mmSquared: number;
}

export function exactBmi(weightKg: number, heightM: number): ExactBmi {
  return { grams: Math.round(weightKg * 1000), mmSquared: Math.round(heightM * 1000) ** 2 };
}

/** -1, 0 or 1 as the exact BMI is below, equal to or above `tenths` / 10 kg/m². */
export function compareBmi(bmi: ExactBmi, tenths: number): -1 | 0 | 1 {
  // BMI x 10 = grams x 10,000 / mm², so compare grams x 10,000 with tenths x mm² in whole numbers.
  const difference = bmi.grams * 10_000 - tenths * bmi.mmSquared;
  if (difference === 0) return 0;
  return difference < 0 ? -1 : 1;
}

export function bmiValue(bmi: ExactBmi): number {
  return (bmi.grams * 1000) / bmi.mmSquared;
}

/** For display only: BMI to one decimal place, rounded half up. */
export function formatBmi(bmi: ExactBmi): string {
  const tenths = Math.floor((20_000 * bmi.grams + bmi.mmSquared) / (2 * bmi.mmSquared));
  return (tenths / 10).toFixed(1);
}

/** A measurement as entered, with at least `decimals` places: 60 kg shows as 60.0, 73.96 as 73.96. */
export function formatMeasurement(value: number, decimals: number): string {
  const fixed = value.toFixed(decimals);
  return Number(fixed) === value ? fixed : String(value);
}
