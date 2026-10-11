/**
 * 'MUST', the Malnutrition Universal Screening Tool, calculated exactly as published (care.md
 * section 4 rule 5; hazards HZ-012 and HZ-014).
 *
 * Source: BAPEN Malnutrition Advisory Group. 'Malnutrition Universal Screening Tool'. © BAPEN, first
 * published May 2003, reviewed and reprinted with minor changes March 2008, September 2010 and
 * August 2011. Steps 1 to 5 flow chart, BMI chart and weight-loss tables.
 * https://www.bapen.org.uk/must-and-self-screening/must-calculator
 *
 * The BMI and weight-loss bands are the published tool definition, not rate-table figures. The
 * screening interval, the food record length and the weighing intervals are tenant defaults from
 * the rate table and are passed in.
 */

import {
  addMonthsToDate,
  bmiTenths,
  type CareTrigger,
  formatTenths,
  InputCheck,
  isIsoDate,
  type ScoreWorking,
  type ToolOutcome,
  type ToolResult,
} from "./assessment";
import type { CareRates } from "./rates";
import { weightInterval } from "./weight";

export const MUST_TOOL_VERSION = "bapen-2011";

export type MustBand = "low" | "medium" | "high";

export type MustBmiCategory = "over_20" | "18_5_to_20" | "under_18_5";
export type MustWeightLossCategory = "under_5" | "5_to_10" | "over_10";

// Step 1: BMI > 20 scores 0 (over 30 is obese), 18.5 to 20 scores 1, under 18.5 scores 2.
// Bounds are in tenths of a kg/m².
const BMI_SCORE: Readonly<Record<MustBmiCategory, { label: string; points: number }>> = {
  over_20: { label: "BMI over 20", points: 0 },
  "18_5_to_20": { label: "BMI 18.5 to 20", points: 1 },
  under_18_5: { label: "BMI under 18.5", points: 2 },
};
const BMI_OVER_20_ABOVE_TENTHS = 200;
const BMI_UNDER_18_5_BELOW_TENTHS = 185;
const BMI_OBESE_ABOVE_TENTHS = 300;

// Step 2: unplanned weight loss in the past 3 to 6 months: under 5% scores 0, 5 to 10% scores 1,
// over 10% scores 2.
const WEIGHT_LOSS_SCORE: Readonly<
  Record<MustWeightLossCategory, { label: string; points: number }>
> = {
  under_5: { label: "under 5%", points: 0 },
  "5_to_10": { label: "5 to 10%", points: 1 },
  over_10: { label: "over 10%", points: 2 },
};
const WEIGHT_LOSS_LOWER_PERCENT = 5;
const WEIGHT_LOSS_UPPER_PERCENT = 10;

// Step 3: acutely ill and there has been, or is likely to be, no nutritional intake for more than
// 5 days scores 2.
const ACUTE_DISEASE_EFFECT_POINTS = 2;

// Step 4: 0 low, 1 medium, 2 or more high.
function bandFor(score: number): MustBand {
  if (score === 0) return "low";
  return score === 1 ? "medium" : "high";
}

/** How the height used for BMI was obtained (BAPEN alternative measurements). */
export type MustHeightMethod =
  | "measured"
  | "documented_or_reported"
  | "ulna_length"
  | "knee_height"
  | "demispan";
export type MustWeightMethod = "measured" | "documented_or_reported";
/** When BMI cannot be calculated: the assessor's judgement, supported by these criteria. */
export type MustBmiCategoryMethod = "mid_upper_arm_circumference" | "subjective_criteria";
export type MustWeightLossMethod = "reported_weight_loss" | "subjective_criteria";

export type MustBmiInput =
  | {
      readonly kind: "calculated";
      readonly weightKg?: number | null;
      readonly heightM?: number | null;
      readonly weightMethod: MustWeightMethod;
      readonly heightMethod: MustHeightMethod;
    }
  | {
      /** When weight or height cannot be obtained; the method is recorded with the result. */
      readonly kind: "assessor_category";
      readonly category?: MustBmiCategory | null;
      readonly method: MustBmiCategoryMethod;
    };

export type MustWeightLossInput =
  | {
      readonly kind: "calculated";
      /** Weight 3 to 6 months ago. */
      readonly previousWeightKg?: number | null;
      readonly currentWeightKg?: number | null;
    }
  | {
      readonly kind: "assessor_category";
      readonly category?: MustWeightLossCategory | null;
      readonly method: MustWeightLossMethod;
    };

export interface MustInput {
  readonly bmi?: MustBmiInput | null;
  readonly weightLoss?: MustWeightLossInput | null;
  /** Acutely ill and no nutritional intake, or likely to be none, for more than 5 days. */
  readonly acuteDiseaseEffect?: boolean | null;
  /** The date of screening, yyyy-mm-dd, from which the next screening falls due. */
  readonly screenedOn: string;
}

export interface MustResult extends ToolResult<"must", MustBand> {
  /** BMI to one decimal place when calculated, otherwise null. */
  readonly bmi: number | null;
  /** True when BMI is over 30, which BAPEN asks to be recorded. Null when BMI was not calculated. */
  readonly obese: boolean | null;
  /** Unplanned weight loss as a percentage of the earlier weight, to two decimal places. */
  readonly weightLossPercent: number | null;
  /** True when step 1 or step 2 used the assessor's judgement rather than measurements. */
  readonly assessorJudgement: boolean;
  readonly nextScreeningDueOn: string;
}

/** Data-entry limits, not part of the published tool. */
export const MUST_INPUT_LIMITS = {
  weightKg: { min: 10, max: 400 },
  heightM: { min: 0.5, max: 2.5 },
} as const;

const BMI_CATEGORIES = Object.keys(BMI_SCORE) as MustBmiCategory[];
const WEIGHT_LOSS_CATEGORIES = Object.keys(WEIGHT_LOSS_SCORE) as MustWeightLossCategory[];

const METHOD_LABELS: Readonly<
  Record<MustHeightMethod | MustWeightMethod | MustBmiCategoryMethod | MustWeightLossMethod, string>
> = {
  measured: "measured",
  documented_or_reported: "documented or reported",
  ulna_length: "estimated from ulna length",
  knee_height: "estimated from knee height",
  demispan: "estimated from demispan",
  mid_upper_arm_circumference: "assessor's judgement from mid upper arm circumference",
  subjective_criteria: "assessor's judgement from the subjective criteria",
  reported_weight_loss: "reported weight loss",
};

function bmiCategoryFor(tenths: number): MustBmiCategory {
  if (tenths > BMI_OVER_20_ABOVE_TENTHS) return "over_20";
  return tenths < BMI_UNDER_18_5_BELOW_TENTHS ? "under_18_5" : "18_5_to_20";
}

/**
 * Exact percentage comparison in whole grams: loss / previous against 5% and 10% without
 * floating-point error, so 3.5 kg lost from 70.0 kg is exactly 5% (BAPEN weight-loss table).
 */
function weightLossCategoryFor(previousGrams: number, lossGrams: number): MustWeightLossCategory {
  if (lossGrams * 100 < WEIGHT_LOSS_LOWER_PERCENT * previousGrams) return "under_5";
  return lossGrams * 100 > WEIGHT_LOSS_UPPER_PERCENT * previousGrams ? "over_10" : "5_to_10";
}

interface StepOne {
  readonly working: ScoreWorking;
  readonly tenths: number | null;
  readonly judgement: boolean;
}

function stepOne(check: InputCheck, bmi: MustBmiInput): StepOne | undefined {
  if (bmi.kind === "assessor_category") {
    const category = check.option("bmi.category", "BMI category", bmi.category, BMI_CATEGORIES);
    if (category === undefined) return undefined;
    const score = BMI_SCORE[category];
    return {
      working: {
        item: "Step 1: BMI score",
        value: `${score.label} (${METHOD_LABELS[bmi.method]})`,
        points: score.points,
      },
      tenths: null,
      judgement: true,
    };
  }
  const weight = check.number("bmi.weightKg", "Weight", bmi.weightKg, MUST_INPUT_LIMITS.weightKg);
  const height = check.number("bmi.heightM", "Height", bmi.heightM, MUST_INPUT_LIMITS.heightM);
  if (weight === undefined || height === undefined) return undefined;
  const tenths = bmiTenths(weight, height);
  const score = BMI_SCORE[bmiCategoryFor(tenths)];
  return {
    working: {
      item: "Step 1: BMI score",
      value: `BMI ${formatTenths(tenths)} from ${weight.toFixed(1)} kg (${METHOD_LABELS[bmi.weightMethod]}) and ${height.toFixed(2)} m (${METHOD_LABELS[bmi.heightMethod]})`,
      points: score.points,
    },
    tenths,
    judgement: false,
  };
}

interface StepTwo {
  readonly working: ScoreWorking;
  readonly percent: number | null;
  readonly judgement: boolean;
}

function stepTwo(check: InputCheck, loss: MustWeightLossInput): StepTwo | undefined {
  if (loss.kind === "assessor_category") {
    const category = check.option(
      "weightLoss.category",
      "Weight loss category",
      loss.category,
      WEIGHT_LOSS_CATEGORIES,
    );
    if (category === undefined) return undefined;
    const score = WEIGHT_LOSS_SCORE[category];
    return {
      working: {
        item: "Step 2: weight loss score",
        value: `Unplanned weight loss ${score.label} (${METHOD_LABELS[loss.method]})`,
        points: score.points,
      },
      percent: null,
      judgement: true,
    };
  }
  const previous = check.number(
    "weightLoss.previousWeightKg",
    "Weight 3 to 6 months ago",
    loss.previousWeightKg,
    MUST_INPUT_LIMITS.weightKg,
  );
  const current = check.number(
    "weightLoss.currentWeightKg",
    "Current weight",
    loss.currentWeightKg,
    MUST_INPUT_LIMITS.weightKg,
  );
  if (previous === undefined || current === undefined) return undefined;
  const previousGrams = Math.round(previous * 1000);
  const lossGrams = Math.max(0, previousGrams - Math.round(current * 1000));
  const score = WEIGHT_LOSS_SCORE[weightLossCategoryFor(previousGrams, lossGrams)];
  // Hundredths of a percent, rounded half up in whole numbers.
  const percent = Math.floor((lossGrams * 20_000 + previousGrams) / (2 * previousGrams)) / 100;
  return {
    working: {
      item: "Step 2: weight loss score",
      value: `${(lossGrams / 1000).toFixed(1)} kg lost from ${previous.toFixed(1)} kg: ${percent.toFixed(2)}% (${score.label})`,
      points: score.points,
    },
    percent,
    judgement: false,
  };
}

export function calculateMust(
  input: MustInput,
  rates: Pick<
    CareRates,
    | "mustScreeningIntervalMonths"
    | "mustMediumRiskFoodRecordDays"
    | "weightDefaultIntervalMonths"
    | "weightAtRiskIntervalWeeks"
  >,
): ToolOutcome<MustResult> {
  const check = new InputCheck();
  const bmiInput = check.present("bmi", "BMI", input.bmi);
  const lossInput = check.present("weightLoss", "Unplanned weight loss", input.weightLoss);
  const acute = check.present(
    "acuteDiseaseEffect",
    "Acute disease effect",
    input.acuteDiseaseEffect,
  );
  if (!isIsoDate(input.screenedOn)) {
    check.add("screenedOn", "not_allowed", "Screening date must be a real date (yyyy-mm-dd).");
  }
  const one = bmiInput === undefined ? undefined : stepOne(check, bmiInput);
  const two = lossInput === undefined ? undefined : stepTwo(check, lossInput);
  if (one === undefined || two === undefined || acute === undefined || check.failed) {
    return check.failure();
  }

  const workings: ScoreWorking[] = [
    one.working,
    two.working,
    {
      item: "Step 3: acute disease effect score",
      value: acute
        ? "Acutely ill and no nutritional intake for more than 5 days"
        : "Not acutely ill with no intake for more than 5 days",
      points: acute ? ACUTE_DISEASE_EFFECT_POINTS : 0,
    },
  ];
  const score = workings.reduce((sum, w) => sum + w.points, 0);
  const band = bandFor(score);
  const nextScreeningDueOn = addMonthsToDate(input.screenedOn, rates.mustScreeningIntervalMonths);
  const triggers: CareTrigger[] = [];
  if (band === "medium") {
    triggers.push({
      kind: "task",
      task: "food_and_fluid_record",
      reason: "MUST medium risk: document dietary intake",
      forDays: rates.mustMediumRiskFoodRecordDays,
    });
  }
  if (band === "high") {
    triggers.push({
      kind: "task",
      task: "dietitian_referral",
      reason: "MUST high risk: refer to dietitian or follow local policy",
    });
  }
  triggers.push(
    { kind: "rescreen", toolKey: "must", dueOn: nextScreeningDueOn },
    { kind: "weight_interval", interval: weightInterval(band, rates) },
  );
  return {
    ok: true,
    result: {
      toolKey: "must",
      toolVersion: MUST_TOOL_VERSION,
      score,
      band,
      workings,
      triggers,
      bmi: one.tenths === null ? null : one.tenths / 10,
      obese: one.tenths === null ? null : one.tenths > BMI_OBESE_ABOVE_TENTHS,
      weightLossPercent: two.percent,
      assessorJudgement: one.judgement || two.judgement,
      nextScreeningDueOn,
    },
  };
}
