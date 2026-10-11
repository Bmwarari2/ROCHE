import { CreateAssessment } from "@harbour/contracts";
import { describe, expect, it } from "vitest";
import {
  type FormLike,
  messageKey,
  readBraden,
  readFalls,
  readMust,
  readWaterlow,
} from "./assessment-answers";

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
