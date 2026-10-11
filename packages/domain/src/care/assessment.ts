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
  | "multifactorial_falls_assessment"
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

/** A follow-up a result raises; the task engine turns these into tasks, alerts and schedules. */
export type CareTrigger =
  | {
      readonly kind: "urgent_alert";
      readonly recipient: "nurse_in_charge";
      readonly reason: string;
    }
  | {
      readonly kind: "task";
      readonly task: CareTaskKind;
      readonly reason: string;
      /** For a record kept over several days, such as the MUST food and fluid record. */
      readonly forDays?: number;
    }
  | { readonly kind: "repeat_observations"; readonly frequency: MonitoringFrequency }
  | { readonly kind: "rescreen"; readonly toolKey: ValidatedToolKey; readonly dueOn: string }
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
 * Body mass index in tenths of a kg/m², rounded half up, computed in whole grams and millimetres so
 * that a boundary such as 18.5 or 20.0 is never missed by floating-point error.
 */
export function bmiTenths(weightKg: number, heightM: number): number {
  const grams = Math.round(weightKg * 1000);
  const mmSquared = Math.round(heightM * 1000) ** 2;
  return Math.floor((20_000 * grams + mmSquared) / (2 * mmSquared));
}

export function formatTenths(tenths: number): string {
  return (tenths / 10).toFixed(1);
}
