import type { CreateAssessment } from "@harbour/contracts";
import { readNumber, readWholeNumber, readYesNo } from "./assessments";

/**
 * Reads a validated tool's answers from its form into the shape the API takes. Only the shape is
 * checked here (a number where one is needed, every question answered); the API applies the
 * published limits and calculates the result. Unit tested without a browser.
 */

/** The parts of FormData the readers use, so tests can pass a plain map. */
export interface FormLike {
  get(name: string): FormDataEntryValue | null;
  getAll(name: string): FormDataEntryValue[];
}

export type Answers<K extends CreateAssessment["toolKey"]> = Extract<
  CreateAssessment,
  { toolKey: K }
>["answers"];

/** Null when a question is unanswered; the form then asks for every answer. */
type Read<T> = T | null;

const value = (form: FormLike, name: string) => {
  const entry = form.get(name);
  return typeof entry === "string" ? entry.trim() : "";
};

function oneOf<T extends string>(form: FormLike, name: string, allowed: readonly T[]): T | null {
  const entry = value(form, name);
  return (allowed as readonly string[]).includes(entry) ? (entry as T) : null;
}

function many<T extends string>(form: FormLike, name: string, allowed: readonly T[]): T[] {
  return form
    .getAll(name)
    .filter(
      (entry): entry is T =>
        typeof entry === "string" && (allowed as readonly string[]).includes(entry),
    );
}

// ------------------------------------------------------------------------------------------------
// MUST (BAPEN): steps 1 to 3
// ------------------------------------------------------------------------------------------------

export const MUST_WEIGHT_METHODS = ["measured", "documented_or_reported"] as const;
export const MUST_HEIGHT_METHODS = [
  "measured",
  "documented_or_reported",
  "ulna_length",
  "knee_height",
  "demispan",
] as const;
export const MUST_BMI_CATEGORIES = ["over_20", "18_5_to_20", "under_18_5"] as const;
export const MUST_BMI_JUDGEMENT = ["mid_upper_arm_circumference", "subjective_criteria"] as const;
export const MUST_LOSS_CATEGORIES = ["under_5", "5_to_10", "over_10"] as const;
export const MUST_LOSS_JUDGEMENT = ["reported_weight_loss", "subjective_criteria"] as const;

export function readMust(form: FormLike): Read<Answers<"must">> {
  let bmi: Answers<"must">["bmi"];
  if (value(form, "bmiSource") === "assessor_category") {
    const category = oneOf(form, "bmiCategory", MUST_BMI_CATEGORIES);
    const method = oneOf(form, "bmiMethod", MUST_BMI_JUDGEMENT);
    if (!category || !method) return null;
    bmi = { kind: "assessor_category", category, method };
  } else {
    const weightKg = readNumber(form.get("weightKg"));
    const heightM = readNumber(form.get("heightM"));
    const weightMethod = oneOf(form, "weightMethod", MUST_WEIGHT_METHODS);
    const heightMethod = oneOf(form, "heightMethod", MUST_HEIGHT_METHODS);
    if (weightKg === null || heightM === null || !weightMethod || !heightMethod) return null;
    bmi = { kind: "calculated", weightKg, heightM, weightMethod, heightMethod };
  }
  let weightLoss: Answers<"must">["weightLoss"];
  if (value(form, "lossSource") === "assessor_category") {
    const category = oneOf(form, "lossCategory", MUST_LOSS_CATEGORIES);
    const method = oneOf(form, "lossMethod", MUST_LOSS_JUDGEMENT);
    if (!category || !method) return null;
    weightLoss = { kind: "assessor_category", category, method };
  } else {
    const previousWeightKg = readNumber(form.get("previousWeightKg"));
    const currentWeightKg = readNumber(form.get("currentWeightKg"));
    if (previousWeightKg === null || currentWeightKg === null) return null;
    weightLoss = { kind: "calculated", previousWeightKg, currentWeightKg };
  }
  const acuteDiseaseEffect = readYesNo(form.get("acuteDiseaseEffect"));
  if (acuteDiseaseEffect === null) return null;
  return { bmi, weightLoss, acuteDiseaseEffect };
}

// ------------------------------------------------------------------------------------------------
// NICE NG249 falls questions (no score)
// ------------------------------------------------------------------------------------------------

export const FALLS_OCCASIONS = ["admission", "review", "after_fall"] as const;
export const FALLS_CRITERIA = [
  "livingWithFrailty",
  "injuredAndNeededMedicalTreatment",
  "lostConsciousness",
  "unableToGetUpIndependently",
  "twoOrMoreFallsInLastYear",
] as const;

export function readFalls(form: FormLike): Read<Answers<"ng249_falls">> {
  const fallenInLastYear = readYesNo(form.get("fallenInLastYear"));
  const presentingAfterFall = readYesNo(form.get("presentingAfterFall"));
  if (value(form, "setting") === "community") {
    const ticked = new Set(many(form, "criteria", FALLS_CRITERIA));
    const anyFall = fallenInLastYear === true || presentingAfterFall === true;
    return {
      setting: "community",
      fallenInLastYear,
      presentingAfterFall,
      criteria: anyFall
        ? Object.fromEntries(FALLS_CRITERIA.map((criterion) => [criterion, ticked.has(criterion)]))
        : null,
    };
  }
  const occasion = oneOf(form, "occasion", FALLS_OCCASIONS);
  if (!occasion) return null;
  return { setting: "residential", occasion, fallenInLastYear, presentingAfterFall };
}

// ------------------------------------------------------------------------------------------------
// Braden Scale
// ------------------------------------------------------------------------------------------------

export const BRADEN_SUBSCALES = [
  "sensoryPerception",
  "moisture",
  "activity",
  "mobility",
  "nutrition",
  "frictionAndShear",
] as const;

/** Friction and shear is scored 1 to 3; the others 1 to 4. */
export function bradenPoints(subscale: (typeof BRADEN_SUBSCALES)[number]): readonly number[] {
  return subscale === "frictionAndShear" ? [1, 2, 3] : [1, 2, 3, 4];
}

export function readBraden(form: FormLike): Read<Answers<"braden">> {
  const scores: Partial<Record<(typeof BRADEN_SUBSCALES)[number], number>> = {};
  for (const subscale of BRADEN_SUBSCALES) {
    const score = readWholeNumber(form.get(subscale));
    if (score === null || !bradenPoints(subscale).includes(score)) return null;
    scores[subscale] = score;
  }
  return scores as Answers<"braden">;
}

// ------------------------------------------------------------------------------------------------
// Waterlow score card (2005 revision)
// ------------------------------------------------------------------------------------------------

export const WATERLOW = {
  build: ["average", "above_average", "obese", "below_average"],
  skin: [
    "healthy",
    "tissue_paper",
    "dry",
    "oedematous",
    "clammy_or_pyrexia",
    "discoloured_grade_1",
    "broken_or_spots_grade_2_to_4",
  ],
  sex: ["male", "female"],
  recentWeightLoss: ["yes", "no", "unsure"],
  weightLossAmount: ["0.5_to_5_kg", "5_to_10_kg", "10_to_15_kg", "over_15_kg", "unsure"],
  continence: [
    "complete_or_catheterised",
    "urinary_incontinence",
    "faecal_incontinence",
    "urinary_and_faecal_incontinence",
  ],
  mobility: ["fully", "restless_or_fidgety", "apathetic", "restricted", "bedbound", "chairbound"],
  tissue: [
    "terminal_cachexia",
    "multiple_organ_failure",
    "single_organ_failure",
    "peripheral_vascular_disease",
    "anaemia",
    "smoking",
  ],
  neuro: ["diabetes_ms_or_cva", "motor_or_sensory", "paraplegia"],
  timeOnTable: ["not_applicable", "over_2_hours", "over_6_hours"],
  medication: ["cytotoxics", "long_term_or_high_dose_steroids", "anti_inflammatory"],
} as const;

/** ICU select keys cannot contain a full stop: "0.5_to_5_kg" is "0_5_to_5_kg" in the catalogue. */
export function messageKey(value: string): string {
  return value.split(".").join("_");
}

export function readWaterlow(form: FormLike): Read<Answers<"waterlow">> {
  let build: Answers<"waterlow">["build"];
  if (value(form, "buildSource") === "assessor_category") {
    const category = oneOf(form, "buildCategory", WATERLOW.build);
    if (!category) return null;
    build = { kind: "assessor_category", category };
  } else {
    const weightKg = readNumber(form.get("weightKg"));
    const heightM = readNumber(form.get("heightM"));
    if (weightKg === null || heightM === null) return null;
    build = { kind: "calculated", weightKg, heightM };
  }
  const sex = oneOf(form, "sex", WATERLOW.sex);
  const ageYears = readWholeNumber(form.get("ageYears"));
  const recentWeightLoss = oneOf(form, "recentWeightLoss", WATERLOW.recentWeightLoss);
  const eatingPoorly = readYesNo(form.get("eatingPoorly"));
  const continence = oneOf(form, "continence", WATERLOW.continence);
  const mobility = oneOf(form, "mobility", WATERLOW.mobility);
  const orthopaedic = readYesNo(form.get("orthopaedic"));
  const timeOnTable = oneOf(form, "timeOnTable", WATERLOW.timeOnTable);
  if (
    !sex ||
    ageYears === null ||
    !recentWeightLoss ||
    eatingPoorly === null ||
    !continence ||
    !mobility ||
    orthopaedic === null ||
    !timeOnTable
  ) {
    return null;
  }
  const amount = oneOf(form, "weightLossAmount", WATERLOW.weightLossAmount);
  const neurologicalDeficit = many(form, "neuro", WATERLOW.neuro).map((condition) => ({
    condition,
    points: readWholeNumber(form.get(`neuroPoints.${condition}`)) ?? 4,
  }));
  return {
    build,
    skin: many(form, "skin", WATERLOW.skin),
    sex,
    ageYears,
    malnutrition: {
      recentWeightLoss,
      weightLossAmount: recentWeightLoss === "yes" ? amount : null,
      eatingPoorlyOrLackOfAppetite: eatingPoorly,
    },
    continence,
    mobility,
    tissueMalnutrition: many(form, "tissue", WATERLOW.tissue),
    neurologicalDeficit,
    majorSurgeryOrTrauma: { orthopaedicOrSpinal: orthopaedic, timeOnTable },
    medication: many(form, "medication", WATERLOW.medication),
  };
}
