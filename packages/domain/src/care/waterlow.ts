/**
 * Waterlow pressure ulcer risk score, calculated exactly as published (care.md section 4 rule 5;
 * hazard HZ-012). Licence and authoritative source await confirmation (human action H-25): see
 * TOOLS_AWAITING_LICENCE_CONFIRMATION.
 *
 * Source: Waterlow J. Waterlow score card, © J Waterlow 1985, revised 2005 (the 2005 revision
 * incorporates research by Queensland Health). www.judy-waterlow.co.uk. The malnutrition section
 * is the Malnutrition Screening Tool (MST), Nutrition 1999;15(6), as printed on the card.
 *
 * The card's rules carried into code: "more than 1 score per category can be used" (skin type and
 * the special risks are multi-select and every selection counts); surgery scores "can be discounted
 * after 48 hours provided the patient is recovering normally", which is the assessor's decision not
 * to select them.
 *
 * Readings taken where the card leaves room (listed for CSO review in the medical-device boundary,
 * section 5):
 * 1. Obese at 30: the card prints "BMI > 30" after "25-29.9"; a BMI of 30.0 or more scores 2.
 * 2. BMI bands apply to the exact BMI: under 20, 20 up to 25, 25 up to 30, 30 or more.
 * 3. Medication, maximum 4: the card prints "MAX OF 4" with no per-item score; the category scores
 *    4 when any listed medicine applies, however many.
 * 4. Weight lost as categories: the card's bands share end points (0.5-5 kg, 5-10 kg, 10-15 kg), so
 *    the assessor chooses a band rather than entering kilograms.
 * 5. Neurological deficit capped at 6: each condition scores 4 to 6 at the assessor's choice, and
 *    the category total is capped at 6 (the card prints "MAX OF 6").
 */

import {
  bmiValue,
  type CareTrigger,
  compareBmi,
  exactBmi,
  formatBmi,
  InputCheck,
  type ScoreWorking,
  type ToolOutcome,
  type ToolResult,
} from "./assessment";
import { MUST_INPUT_LIMITS } from "./must";

export const WATERLOW_TOOL_VERSION = "waterlow-2005";

export type WaterlowBand = "not_at_risk" | "at_risk" | "high_risk" | "very_high_risk";

// Build and weight for height: average BMI 20-24.9 0; above average 25-29.9 1; obese 30 and over 2;
// below average under 20 3. The exact BMI is banded (under 20, 20 up to 25, 25 up to 30, 30 or
// more), which closes the card's gaps between 24.9 and 25 and between 29.9 and 30; it is rounded
// to one decimal place only in the workings text. Bounds in tenths of a kg/m².
export type WaterlowBuild = "average" | "above_average" | "obese" | "below_average";
const BUILD: Readonly<Record<WaterlowBuild, { label: string; points: number }>> = {
  average: { label: "Average (BMI 20 to 24.9)", points: 0 },
  above_average: { label: "Above average (BMI 25 to 29.9)", points: 1 },
  obese: { label: "Obese (BMI 30 or more)", points: 2 },
  below_average: { label: "Below average (BMI under 20)", points: 3 },
};
const BMI_AVERAGE_FROM_TENTHS = 200;
const BMI_ABOVE_AVERAGE_FROM_TENTHS = 250;
const BMI_OBESE_FROM_TENTHS = 300;

export type WaterlowSkin =
  | "healthy"
  | "tissue_paper"
  | "dry"
  | "oedematous"
  | "clammy_or_pyrexia"
  | "discoloured_grade_1"
  | "broken_or_spots_grade_2_to_4";
const SKIN: Readonly<Record<WaterlowSkin, { label: string; points: number }>> = {
  healthy: { label: "Healthy", points: 0 },
  tissue_paper: { label: "Tissue paper", points: 1 },
  dry: { label: "Dry", points: 1 },
  oedematous: { label: "Oedematous", points: 1 },
  clammy_or_pyrexia: { label: "Clammy, pyrexia", points: 1 },
  discoloured_grade_1: { label: "Discoloured grade 1", points: 2 },
  broken_or_spots_grade_2_to_4: { label: "Broken or spots grade 2 to 4", points: 3 },
};

export type WaterlowSex = "male" | "female";
const SEX: Readonly<Record<WaterlowSex, { label: string; points: number }>> = {
  male: { label: "Male", points: 1 },
  female: { label: "Female", points: 2 },
};

// Age bands: 14-49 1; 50-64 2; 65-74 3; 75-80 4; 81 and over 5.
const AGE: readonly { readonly from: number; readonly label: string; readonly points: number }[] = [
  { from: 81, label: "81 or over", points: 5 },
  { from: 75, label: "75 to 80", points: 4 },
  { from: 65, label: "65 to 74", points: 3 },
  { from: 50, label: "50 to 64", points: 2 },
  { from: 14, label: "14 to 49", points: 1 },
];

// Malnutrition Screening Tool. A: recent weight loss yes, go to B; no, go to C; unsure, score 2
// and go to C. B: 0.5-5 kg 1; 5-10 kg 2; 10-15 kg 3; over 15 kg 4; unsure 2. C: eating poorly or
// lack of appetite, no 0, yes 1. A nutrition score over 2: refer for nutrition assessment.
export type WaterlowRecentWeightLoss = "yes" | "no" | "unsure";
export type WaterlowWeightLossAmount =
  | "0.5_to_5_kg"
  | "5_to_10_kg"
  | "10_to_15_kg"
  | "over_15_kg"
  | "unsure";
const WEIGHT_LOSS_AMOUNT: Readonly<
  Record<WaterlowWeightLossAmount, { label: string; points: number }>
> = {
  "0.5_to_5_kg": { label: "0.5 to 5 kg", points: 1 },
  "5_to_10_kg": { label: "5 to 10 kg", points: 2 },
  "10_to_15_kg": { label: "10 to 15 kg", points: 3 },
  over_15_kg: { label: "over 15 kg", points: 4 },
  unsure: { label: "amount unsure", points: 2 },
};
const WEIGHT_LOSS_UNSURE_POINTS = 2;
const POOR_APPETITE_POINTS = 1;
const NUTRITION_REFERRAL_ABOVE = 2;

export type WaterlowContinence =
  | "complete_or_catheterised"
  | "urinary_incontinence"
  | "faecal_incontinence"
  | "urinary_and_faecal_incontinence";
const CONTINENCE: Readonly<Record<WaterlowContinence, { label: string; points: number }>> = {
  complete_or_catheterised: { label: "Complete or catheterised", points: 0 },
  urinary_incontinence: { label: "Urinary incontinence", points: 1 },
  faecal_incontinence: { label: "Faecal incontinence", points: 2 },
  urinary_and_faecal_incontinence: { label: "Urinary and faecal incontinence", points: 3 },
};

export type WaterlowMobility =
  | "fully"
  | "restless_or_fidgety"
  | "apathetic"
  | "restricted"
  | "bedbound"
  | "chairbound";
const MOBILITY: Readonly<Record<WaterlowMobility, { label: string; points: number }>> = {
  fully: { label: "Fully mobile", points: 0 },
  restless_or_fidgety: { label: "Restless or fidgety", points: 1 },
  apathetic: { label: "Apathetic", points: 2 },
  restricted: { label: "Restricted", points: 3 },
  bedbound: { label: "Bedbound, for example traction", points: 4 },
  chairbound: { label: "Chairbound, for example wheelchair", points: 5 },
};

export type WaterlowTissueMalnutrition =
  | "terminal_cachexia"
  | "multiple_organ_failure"
  | "single_organ_failure"
  | "peripheral_vascular_disease"
  | "anaemia"
  | "smoking";
const TISSUE_MALNUTRITION: Readonly<
  Record<WaterlowTissueMalnutrition, { label: string; points: number }>
> = {
  terminal_cachexia: { label: "Terminal cachexia", points: 8 },
  multiple_organ_failure: { label: "Multiple organ failure", points: 8 },
  single_organ_failure: {
    label: "Single organ failure (respiratory, renal, cardiac)",
    points: 5,
  },
  peripheral_vascular_disease: { label: "Peripheral vascular disease", points: 5 },
  anaemia: { label: "Anaemia (Hb under 8)", points: 2 },
  smoking: { label: "Smoking", points: 1 },
};

export type WaterlowNeurologicalCondition =
  | "diabetes_ms_or_cva"
  | "motor_or_sensory"
  | "paraplegia";
const NEUROLOGICAL: Readonly<Record<WaterlowNeurologicalCondition, string>> = {
  diabetes_ms_or_cva: "Diabetes, MS, CVA",
  motor_or_sensory: "Motor or sensory",
  paraplegia: "Paraplegia",
};
const NEUROLOGICAL_POINTS_MIN = 4;
const NEUROLOGICAL_POINTS_MAX = 6;
const NEUROLOGICAL_CATEGORY_MAX = 6;

export type WaterlowTimeOnTable = "not_applicable" | "over_2_hours" | "over_6_hours";
const ORTHOPAEDIC_OR_SPINAL_POINTS = 5;
const TIME_ON_TABLE: Readonly<Record<WaterlowTimeOnTable, { label: string; points: number }>> = {
  not_applicable: { label: "Not on table in the past 48 hours", points: 0 },
  over_2_hours: { label: "On table over 2 hours", points: 5 },
  over_6_hours: { label: "On table over 6 hours", points: 8 },
};

export type WaterlowMedication =
  | "cytotoxics"
  | "long_term_or_high_dose_steroids"
  | "anti_inflammatory";
const MEDICATION: Readonly<Record<WaterlowMedication, string>> = {
  cytotoxics: "Cytotoxics",
  long_term_or_high_dose_steroids: "Long-term or high-dose steroids",
  anti_inflammatory: "Anti-inflammatory",
};
const MEDICATION_CATEGORY_POINTS = 4;

// Bands: 10 or more at risk, 15 or more high risk, 20 or more very high risk.
const AT_RISK_FROM = 10;
const HIGH_RISK_FROM = 15;
const VERY_HIGH_RISK_FROM = 20;

function bandFor(score: number): WaterlowBand {
  if (score >= VERY_HIGH_RISK_FROM) return "very_high_risk";
  if (score >= HIGH_RISK_FROM) return "high_risk";
  return score >= AT_RISK_FROM ? "at_risk" : "not_at_risk";
}

export type WaterlowBuildInput =
  | {
      readonly kind: "calculated";
      readonly weightKg?: number | null;
      readonly heightM?: number | null;
    }
  | { readonly kind: "assessor_category"; readonly category?: WaterlowBuild | null };

export interface WaterlowInput {
  readonly build?: WaterlowBuildInput | null;
  /** Every skin type that applies; "healthy" stands alone. */
  readonly skin?: readonly WaterlowSkin[] | null;
  readonly sex?: WaterlowSex | null;
  /** Whole years; the card starts at 14. */
  readonly ageYears?: number | null;
  readonly malnutrition?: {
    readonly recentWeightLoss?: WaterlowRecentWeightLoss | null;
    /** Answered only when recent weight loss is "yes". */
    readonly weightLossAmount?: WaterlowWeightLossAmount | null;
    readonly eatingPoorlyOrLackOfAppetite?: boolean | null;
  } | null;
  readonly continence?: WaterlowContinence | null;
  readonly mobility?: WaterlowMobility | null;
  /** Special risks: an empty list means none apply. */
  readonly tissueMalnutrition?: readonly WaterlowTissueMalnutrition[] | null;
  readonly neurologicalDeficit?:
    | readonly { readonly condition: WaterlowNeurologicalCondition; readonly points: number }[]
    | null;
  readonly majorSurgeryOrTrauma?: {
    readonly orthopaedicOrSpinal?: boolean | null;
    readonly timeOnTable?: WaterlowTimeOnTable | null;
  } | null;
  readonly medication?: readonly WaterlowMedication[] | null;
}

export interface WaterlowResult extends ToolResult<"waterlow", WaterlowBand> {
  readonly bmi: number | null;
  /** The malnutrition screening tool score; over 2 raises a nutrition assessment task. */
  readonly malnutritionScore: number;
}

const keysOf = <T extends string>(record: Readonly<Record<T, unknown>>): T[] =>
  Object.keys(record) as T[];

function sumOf<T extends string>(
  selected: readonly T[],
  table: Readonly<Record<T, { readonly points: number }>>,
): number {
  return selected.reduce((sum, key) => sum + table[key].points, 0);
}

function listOf<T extends string>(selected: readonly T[], label: (key: T) => string): string {
  return selected.length === 0 ? "None" : selected.map(label).join("; ");
}

function buildWorking(check: InputCheck, build: WaterlowBuildInput) {
  if (build.kind === "assessor_category") {
    const category = check.option("build.category", "Build", build.category, keysOf(BUILD));
    if (category === undefined) return undefined;
    return {
      bmi: null,
      working: {
        item: "Build and weight for height",
        value: `${BUILD[category].label} (assessor's judgement)`,
        points: BUILD[category].points,
      },
    };
  }
  const weight = check.number(
    "build.weightKg",
    "Weight",
    build.weightKg,
    MUST_INPUT_LIMITS.weightKg,
  );
  const height = check.number("build.heightM", "Height", build.heightM, MUST_INPUT_LIMITS.heightM);
  if (weight === undefined || height === undefined) return undefined;
  const bmi = exactBmi(weight, height);
  let category: WaterlowBuild = "below_average";
  if (compareBmi(bmi, BMI_OBESE_FROM_TENTHS) >= 0) category = "obese";
  else if (compareBmi(bmi, BMI_ABOVE_AVERAGE_FROM_TENTHS) >= 0) category = "above_average";
  else if (compareBmi(bmi, BMI_AVERAGE_FROM_TENTHS) >= 0) category = "average";
  return {
    bmi: bmiValue(bmi),
    working: {
      item: "Build and weight for height",
      value: `BMI ${formatBmi(bmi)}: ${BUILD[category].label}`,
      points: BUILD[category].points,
    },
  };
}

function malnutritionWorking(check: InputCheck, input: NonNullable<WaterlowInput["malnutrition"]>) {
  const lost = check.option(
    "malnutrition.recentWeightLoss",
    "Recent weight loss",
    input.recentWeightLoss,
    ["yes", "no", "unsure"] as const,
  );
  const poorAppetite = check.present(
    "malnutrition.eatingPoorlyOrLackOfAppetite",
    "Eating poorly or lack of appetite",
    input.eatingPoorlyOrLackOfAppetite,
  );
  let amount: WaterlowWeightLossAmount | undefined;
  if (lost === "yes") {
    amount = check.option(
      "malnutrition.weightLossAmount",
      "Amount of weight lost",
      input.weightLossAmount,
      keysOf(WEIGHT_LOSS_AMOUNT),
    );
  } else if (input.weightLossAmount !== null && input.weightLossAmount !== undefined) {
    check.add(
      "malnutrition.weightLossAmount",
      "not_allowed",
      "Amount of weight lost is answered only when there has been recent weight loss.",
    );
  }
  if (lost === undefined || poorAppetite === undefined || (lost === "yes" && !amount)) {
    return undefined;
  }
  let weightLossPoints = 0;
  let weightLossText = "No recent weight loss";
  if (lost === "unsure") {
    weightLossPoints = WEIGHT_LOSS_UNSURE_POINTS;
    weightLossText = "Unsure about recent weight loss";
  } else if (amount) {
    weightLossPoints = WEIGHT_LOSS_AMOUNT[amount].points;
    weightLossText = `Recent weight loss ${WEIGHT_LOSS_AMOUNT[amount].label}`;
  }
  const score = weightLossPoints + (poorAppetite ? POOR_APPETITE_POINTS : 0);
  return {
    score,
    working: {
      item: "Malnutrition screening",
      value: `${weightLossText}; ${poorAppetite ? "eating poorly or lack of appetite" : "not eating poorly, no lack of appetite"}`,
      points: score,
    },
  };
}

export function calculateWaterlow(input: WaterlowInput): ToolOutcome<WaterlowResult> {
  const check = new InputCheck();
  const buildInput = check.present("build", "Build and weight for height", input.build);
  const build = buildInput && buildWorking(check, buildInput);
  const skin = check.options("skin", "Skin type", input.skin, keysOf(SKIN));
  if (skin && (skin.length === 0 || (skin.includes("healthy") && skin.length > 1))) {
    check.add(
      "skin",
      skin.length === 0 ? "missing" : "not_allowed",
      skin.length === 0
        ? "Skin type is missing."
        : "Healthy skin cannot be chosen with another skin type.",
    );
  }
  const sex = check.option("sex", "Sex", input.sex, keysOf(SEX));
  const age = check.number("ageYears", "Age", input.ageYears, { min: 14, max: 130, decimals: 0 });
  const malnutritionInput = check.present(
    "malnutrition",
    "Malnutrition screening",
    input.malnutrition,
  );
  const malnutrition = malnutritionInput && malnutritionWorking(check, malnutritionInput);
  const continence = check.option("continence", "Continence", input.continence, keysOf(CONTINENCE));
  const mobility = check.option("mobility", "Mobility", input.mobility, keysOf(MOBILITY));
  const tissue = check.options(
    "tissueMalnutrition",
    "Tissue malnutrition",
    input.tissueMalnutrition,
    keysOf(TISSUE_MALNUTRITION),
  );
  const neuro = check.present(
    "neurologicalDeficit",
    "Neurological deficit",
    input.neurologicalDeficit,
  );
  if (neuro) {
    const conditions = neuro.map((n) => n.condition);
    check.options("neurologicalDeficit", "Neurological deficit", conditions, keysOf(NEUROLOGICAL));
    for (const [index, n] of neuro.entries()) {
      check.number(`neurologicalDeficit.${index}.points`, "Neurological deficit score", n.points, {
        min: NEUROLOGICAL_POINTS_MIN,
        max: NEUROLOGICAL_POINTS_MAX,
        decimals: 0,
      });
    }
  }
  const surgeryInput = check.present(
    "majorSurgeryOrTrauma",
    "Major surgery or trauma",
    input.majorSurgeryOrTrauma,
  );
  const orthopaedic = surgeryInput
    ? check.present(
        "majorSurgeryOrTrauma.orthopaedicOrSpinal",
        "Orthopaedic or spinal surgery",
        surgeryInput.orthopaedicOrSpinal,
      )
    : undefined;
  const onTable = surgeryInput
    ? check.option(
        "majorSurgeryOrTrauma.timeOnTable",
        "Time on table",
        surgeryInput.timeOnTable,
        keysOf(TIME_ON_TABLE),
      )
    : undefined;
  const medication = check.options(
    "medication",
    "Medication",
    input.medication,
    keysOf(MEDICATION),
  );

  if (
    build === undefined ||
    skin === undefined ||
    sex === undefined ||
    age === undefined ||
    malnutrition === undefined ||
    continence === undefined ||
    mobility === undefined ||
    tissue === undefined ||
    neuro === undefined ||
    orthopaedic === undefined ||
    onTable === undefined ||
    medication === undefined ||
    check.failed
  ) {
    return check.failure();
  }

  const ageBand = AGE.find((a) => age >= a.from) as (typeof AGE)[number];
  const neuroPoints = Math.min(
    NEUROLOGICAL_CATEGORY_MAX,
    neuro.reduce((sum, n) => sum + n.points, 0),
  );
  const workings: ScoreWorking[] = [
    build.working,
    { item: "Skin type", value: listOf(skin, (k) => SKIN[k].label), points: sumOf(skin, SKIN) },
    { item: "Sex", value: SEX[sex].label, points: SEX[sex].points },
    { item: "Age", value: `${age} (${ageBand.label})`, points: ageBand.points },
    malnutrition.working,
    {
      item: "Continence",
      value: CONTINENCE[continence].label,
      points: CONTINENCE[continence].points,
    },
    { item: "Mobility", value: MOBILITY[mobility].label, points: MOBILITY[mobility].points },
    {
      item: "Special risks: tissue malnutrition",
      value: listOf(tissue, (k) => TISSUE_MALNUTRITION[k].label),
      points: sumOf(tissue, TISSUE_MALNUTRITION),
    },
    {
      item: "Special risks: neurological deficit (maximum 6)",
      value:
        neuro.length === 0
          ? "None"
          : neuro.map((n) => `${NEUROLOGICAL[n.condition]} ${n.points}`).join("; "),
      points: neuroPoints,
    },
    {
      item: "Special risks: major surgery or trauma",
      value: [
        orthopaedic ? "Orthopaedic or spinal" : "Not orthopaedic or spinal",
        TIME_ON_TABLE[onTable].label,
      ].join("; "),
      points: (orthopaedic ? ORTHOPAEDIC_OR_SPINAL_POINTS : 0) + TIME_ON_TABLE[onTable].points,
    },
    {
      item: "Special risks: medication (maximum 4)",
      value: listOf(medication, (k) => MEDICATION[k]),
      points: medication.length > 0 ? MEDICATION_CATEGORY_POINTS : 0,
    },
  ];
  const score = workings.reduce((sum, w) => sum + w.points, 0);
  const triggers: CareTrigger[] =
    malnutrition.score > NUTRITION_REFERRAL_ABOVE
      ? [
          {
            kind: "task",
            task: "nutrition_assessment",
            reason: `Waterlow nutrition score ${malnutrition.score}: refer for nutrition assessment`,
          },
        ]
      : [];
  return {
    ok: true,
    result: {
      toolKey: "waterlow",
      toolVersion: WATERLOW_TOOL_VERSION,
      score,
      band: bandFor(score),
      workings,
      triggers,
      bmi: build.bmi,
      malnutritionScore: malnutrition.score,
    },
  };
}
