import { BradenAnswers, CreateAssessment, MustAnswers, WaterlowAnswers } from "@harbour/contracts";
import { describe, expect, it } from "vitest";
import {
  BRADEN_SUBSCALES,
  type FormLike,
  MUST_BMI_CATEGORIES,
  MUST_BMI_JUDGEMENT,
  MUST_HEIGHT_METHODS,
  MUST_LOSS_CATEGORIES,
  MUST_LOSS_JUDGEMENT,
  MUST_WEIGHT_METHODS,
  messageKey,
  readBraden,
  readFalls,
  readMust,
  readWaterlow,
  WATERLOW,
} from "./assessment-answers";

/** The choices a contract enum allows, sorted, to compare with the form's. */
const sorted = (values: readonly string[]) => [...values].sort();

describe("answer options match the API's contract (care.md rule 5)", () => {
  it("offers exactly the MUST choices the contract accepts", () => {
    const [calculated, judged] = MustAnswers.shape.bmi.options;
    expect(sorted(MUST_WEIGHT_METHODS)).toEqual(sorted(calculated.shape.weightMethod.options));
    expect(sorted(MUST_HEIGHT_METHODS)).toEqual(sorted(calculated.shape.heightMethod.options));
    expect(sorted(MUST_BMI_CATEGORIES)).toEqual(sorted(judged.shape.category.options));
    expect(sorted(MUST_BMI_JUDGEMENT)).toEqual(sorted(judged.shape.method.options));
    const [, lossJudged] = MustAnswers.shape.weightLoss.options;
    expect(sorted(MUST_LOSS_CATEGORIES)).toEqual(sorted(lossJudged.shape.category.options));
    expect(sorted(MUST_LOSS_JUDGEMENT)).toEqual(sorted(lossJudged.shape.method.options));
  });

  it("offers exactly the Waterlow choices the contract accepts", () => {
    const shape = WaterlowAnswers.shape;
    const [, buildJudged] = shape.build.options;
    expect(sorted(WATERLOW.build)).toEqual(sorted(buildJudged.shape.category.options));
    expect(sorted(WATERLOW.skin)).toEqual(sorted(shape.skin.element.options));
    expect(sorted(WATERLOW.sex)).toEqual(sorted(shape.sex.options));
    expect(sorted(WATERLOW.recentWeightLoss)).toEqual(
      sorted(shape.malnutrition.shape.recentWeightLoss.options),
    );
    expect(sorted(WATERLOW.weightLossAmount)).toEqual(
      sorted(shape.malnutrition.shape.weightLossAmount.unwrap().unwrap().options),
    );
    expect(sorted(WATERLOW.continence)).toEqual(sorted(shape.continence.options));
    expect(sorted(WATERLOW.mobility)).toEqual(sorted(shape.mobility.options));
    expect(sorted(WATERLOW.tissue)).toEqual(sorted(shape.tissueMalnutrition.element.options));
    expect(sorted(WATERLOW.neuro)).toEqual(
      sorted(shape.neurologicalDeficit.element.shape.condition.options),
    );
    expect(sorted(WATERLOW.timeOnTable)).toEqual(
      sorted(shape.majorSurgeryOrTrauma.shape.timeOnTable.options),
    );
    expect(sorted(WATERLOW.medication)).toEqual(sorted(shape.medication.element.options));
  });

  it("asks every Braden subscale the contract has", () => {
    expect(sorted(BRADEN_SUBSCALES)).toEqual(sorted(Object.keys(BradenAnswers.shape)));
  });
});

/** A form as the readers see it, from a plain map (lists for ticked boxes). */
function form(entries: Record<string, string | string[]>): FormLike {
  return {
    get: (name) => {
      const value = entries[name];
      return Array.isArray(value) ? (value[0] ?? null) : (value ?? null);
    },
    getAll: (name) => {
      const value = entries[name];
      return value === undefined ? [] : Array.isArray(value) ? value : [value];
    },
  };
}

/** Every reader's output must be what the API's contract accepts. */
function expectAccepted(toolKey: CreateAssessment["toolKey"], answers: unknown) {
  const parsed = CreateAssessment.safeParse({
    toolKey,
    answers,
    occurredAt: "2026-10-11T10:00:00+01:00",
  });
  expect(parsed.success, JSON.stringify(parsed.error?.issues)).toBe(true);
}

describe("MUST answers", () => {
  it("reads measured BMI and two weights", () => {
    const answers = readMust(
      form({
        weightKg: "50",
        heightM: "1.65",
        weightMethod: "measured",
        heightMethod: "ulna_length",
        previousWeightKg: "55",
        currentWeightKg: "50",
        acuteDiseaseEffect: "no",
      }),
    );
    expect(answers).toEqual({
      bmi: {
        kind: "calculated",
        weightKg: 50,
        heightM: 1.65,
        weightMethod: "measured",
        heightMethod: "ulna_length",
      },
      weightLoss: { kind: "calculated", previousWeightKg: 55, currentWeightKg: 50 },
      acuteDiseaseEffect: false,
    });
    expectAccepted("must", answers);
  });

  it("reads the assessor's judgement for both steps", () => {
    const answers = readMust(
      form({
        bmiSource: "assessor_category",
        bmiCategory: "under_18_5",
        bmiMethod: "mid_upper_arm_circumference",
        lossSource: "assessor_category",
        lossCategory: "5_to_10",
        lossMethod: "reported_weight_loss",
        acuteDiseaseEffect: "yes",
      }),
    );
    expect(answers?.bmi).toEqual({
      kind: "assessor_category",
      category: "under_18_5",
      method: "mid_upper_arm_circumference",
    });
    expectAccepted("must", answers);
  });

  it("asks for every answer rather than guessing one", () => {
    expect(
      readMust(form({ weightKg: "50", heightM: "1.65", acuteDiseaseEffect: "no" })),
    ).toBeNull();
    expect(
      readMust(
        form({
          weightKg: "fifty",
          heightM: "1.65",
          weightMethod: "measured",
          heightMethod: "measured",
          previousWeightKg: "55",
          currentWeightKg: "50",
          acuteDiseaseEffect: "no",
        }),
      ),
    ).toBeNull();
  });
});

describe("NG249 falls answers", () => {
  it("reads the residential questions", () => {
    const answers = readFalls(
      form({ setting: "residential", occasion: "after_fall", fallenInLastYear: "yes" }),
    );
    expect(answers).toEqual({
      setting: "residential",
      occasion: "after_fall",
      fallenInLastYear: true,
      presentingAfterFall: null,
    });
    expectAccepted("ng249_falls", answers);
    expect(readFalls(form({ setting: "residential" }))).toBeNull();
  });

  it("reads the community criteria only when there was a fall", () => {
    const fell = readFalls(
      form({ setting: "community", presentingAfterFall: "yes", criteria: ["lostConsciousness"] }),
    );
    expect(fell).toMatchObject({
      setting: "community",
      criteria: {
        lostConsciousness: true,
        livingWithFrailty: false,
        twoOrMoreFallsInLastYear: false,
      },
    });
    expectAccepted("ng249_falls", fell);
    const noFall = readFalls(
      form({ setting: "community", fallenInLastYear: "no", presentingAfterFall: "no" }),
    );
    expect(noFall).toMatchObject({ criteria: null });
    expectAccepted("ng249_falls", noFall);
  });
});

describe("Braden answers", () => {
  it("reads six subscale scores, friction and shear from 1 to 3", () => {
    const answers = readBraden(
      form({
        sensoryPerception: "3",
        moisture: "2",
        activity: "1",
        mobility: "2",
        nutrition: "3",
        frictionAndShear: "2",
      }),
    );
    expect(answers).toEqual({
      sensoryPerception: 3,
      moisture: 2,
      activity: 1,
      mobility: 2,
      nutrition: 3,
      frictionAndShear: 2,
    });
    expectAccepted("braden", answers);
    expect(
      readBraden(
        form({
          sensoryPerception: "3",
          moisture: "2",
          activity: "1",
          mobility: "2",
          nutrition: "3",
          frictionAndShear: "4",
        }),
      ),
    ).toBeNull();
  });
});

describe("Waterlow answers", () => {
  const complete = {
    weightKg: "62",
    heightM: "1.6",
    skin: ["dry", "oedematous", "not-a-skin-type"],
    sex: "female",
    ageYears: "88",
    recentWeightLoss: "yes",
    weightLossAmount: "0.5_to_5_kg",
    eatingPoorly: "no",
    continence: "urinary_incontinence",
    mobility: "restricted",
    tissue: ["anaemia"],
    neuro: ["motor_or_sensory"],
    "neuroPoints.motor_or_sensory": "5",
    orthopaedic: "no",
    timeOnTable: "not_applicable",
    medication: [],
  };

  it("reads the score card, ticked boxes and points", () => {
    const answers = readWaterlow(form(complete));
    expect(answers).toMatchObject({
      build: { kind: "calculated", weightKg: 62, heightM: 1.6 },
      skin: ["dry", "oedematous"],
      sex: "female",
      ageYears: 88,
      malnutrition: {
        recentWeightLoss: "yes",
        weightLossAmount: "0.5_to_5_kg",
        eatingPoorlyOrLackOfAppetite: false,
      },
      neurologicalDeficit: [{ condition: "motor_or_sensory", points: 5 }],
      majorSurgeryOrTrauma: { orthopaedicOrSpinal: false, timeOnTable: "not_applicable" },
      medication: [],
    });
    expectAccepted("waterlow", answers);
  });

  it("drops the amount unless weight was lost, and needs every single-choice answer", () => {
    expect(readWaterlow(form({ ...complete, recentWeightLoss: "no" }))?.malnutrition).toEqual({
      recentWeightLoss: "no",
      weightLossAmount: null,
      eatingPoorlyOrLackOfAppetite: false,
    });
    expect(readWaterlow(form({ ...complete, sex: "" }))).toBeNull();
    expect(messageKey("0.5_to_5_kg")).toBe("0_5_to_5_kg");
  });
});
