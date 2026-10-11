import { describe, expect, it } from "vitest";
import { tableCareRates } from "../../test/rate-table";
import { evaluateFlag, type FlagKey } from "../platform/feature-flags";
import type { CareTrigger } from "./assessment";
import { BRADEN_TOOL_VERSION } from "./braden";
import { NG249_VERSION } from "./falls";
import { MUST_TOOL_VERSION } from "./must";
import {
  ASSESSMENT_TOOL_KEYS,
  type AssessmentRecord,
  checkAssessmentCorrection,
  currentResults,
  needsPlanReview,
  runAssessment,
  toolAvailable,
  toolFlag,
} from "./validated-assessment";
import { WATERLOW_TOOL_VERSION } from "./waterlow";

/**
 * Stored results of the locked validated tools (care.md section 4 rule 5; register rows CARE-003
 * and CARE-006; hazards HZ-012 and HZ-014). The API runs the tool on the server by its key; the
 * stored result carries the tool version, score, band, workings, triggers and the next due date.
 */

const rates = tableCareRates();
const REVIEW_MONTHS = 1;
const context = { assessedOn: "2026-10-11", rates, reviewIntervalMonths: REVIEW_MONTHS };

function run(input: Parameters<typeof runAssessment>[0]): AssessmentRecord {
  const outcome = runAssessment(input, context);
  if (!outcome.ok) throw new Error(outcome.message);
  return outcome.result;
}

const kinds = (triggers: readonly CareTrigger[]) =>
  triggers.map((t) => (t.kind === "task" ? t.task : t.kind));

const mustHigh = {
  toolKey: "must" as const,
  answers: {
    bmi: {
      kind: "calculated" as const,
      weightKg: 45,
      heightM: 1.6,
      weightMethod: "measured" as const,
      heightMethod: "measured" as const,
    },
    weightLoss: { kind: "calculated" as const, previousWeightKg: 50, currentWeightKg: 45 },
    acuteDiseaseEffect: false,
  },
};

const braden = {
  toolKey: "braden" as const,
  answers: {
    sensoryPerception: 3,
    moisture: 3,
    activity: 2,
    mobility: 2,
    nutrition: 3,
    frictionAndShear: 2,
  },
};

describe("hazard HZ-012 the tool runs on the server by its key", () => {
  it("covers MUST, Waterlow, Braden and the NG249 falls pathway (NEWS2 is a vital signs chart)", () => {
    expect([...ASSESSMENT_TOOL_KEYS]).toEqual(["must", "waterlow", "braden", "ng249_falls"]);
  });

  it("hazard HZ-014 MUST high risk raises the dietitian referral and sets the next screening date", () => {
    const result = run(mustHigh);
    expect(result).toMatchObject({
      toolKey: "must",
      toolVersion: MUST_TOOL_VERSION,
      score: 3,
      band: "high",
      nextDueOn: "2026-11-11",
    });
    expect(kinds(result.triggers)).toEqual(["dietitian_referral", "rescreen", "weight_interval"]);
    expect(result.workings.map((w) => w.points)).toEqual([2, 1, 0]);
    expect(result.details).toMatchObject({ obese: false, weightLossPercent: 10 });
  });

  it("hazard HZ-014 MUST at medium or high risk weighs weekly; low risk monthly (rate table)", () => {
    const weight = (record: AssessmentRecord) =>
      record.triggers.find((t) => t.kind === "weight_interval");
    expect(weight(run(mustHigh))).toEqual({
      kind: "weight_interval",
      interval: { unit: "weeks", value: rates.weightAtRiskIntervalWeeks },
    });
    const low = run({
      ...mustHigh,
      answers: {
        ...mustHigh.answers,
        bmi: { ...mustHigh.answers.bmi, weightKg: 60 },
        weightLoss: { kind: "calculated", previousWeightKg: 60, currentWeightKg: 60 },
      },
    });
    expect(low.band).toBe("low");
    expect(weight(low)).toEqual({
      kind: "weight_interval",
      interval: { unit: "months", value: rates.weightDefaultIntervalMonths },
    });
  });

  it("stores Braden with the publisher's band wording and a review at the care plan interval", () => {
    const result = run(braden);
    expect(result).toMatchObject({
      toolKey: "braden",
      toolVersion: BRADEN_TOOL_VERSION,
      score: 15,
      band: "at_risk",
      details: { bandLabel: "At risk" },
      nextDueOn: "2026-11-11",
    });
    expect(result.triggers).toEqual([{ kind: "rescreen", toolKey: "braden", dueOn: "2026-11-11" }]);
  });

  it("stores Waterlow with the nutrition referral it raises", () => {
    const result = run({
      toolKey: "waterlow",
      answers: {
        build: { kind: "assessor_category", category: "below_average" },
        skin: ["tissue_paper"],
        sex: "female",
        ageYears: 88,
        malnutrition: {
          recentWeightLoss: "yes",
          weightLossAmount: "5_to_10_kg",
          eatingPoorlyOrLackOfAppetite: true,
        },
        continence: "urinary_incontinence",
        mobility: "restricted",
        tissueMalnutrition: [],
        neurologicalDeficit: [],
        majorSurgeryOrTrauma: { orthopaedicOrSpinal: false, timeOnTable: "not_applicable" },
        medication: [],
      },
    });
    expect(result).toMatchObject({
      toolKey: "waterlow",
      toolVersion: WATERLOW_TOOL_VERSION,
      score: 18,
      band: "high_risk",
      details: { malnutritionScore: 3 },
    });
    expect(kinds(result.triggers)).toEqual(["nutrition_assessment", "rescreen"]);
  });

  it("hazard HZ-012 stores the NG249 falls pathway with no score and no band", () => {
    const result = run({
      toolKey: "ng249_falls",
      answers: {
        setting: "residential",
        occasion: "after_fall",
        fallenInLastYear: true,
        presentingAfterFall: true,
      },
    });
    expect(result).toMatchObject({
      toolKey: "ng249_falls",
      toolVersion: NG249_VERSION,
      score: null,
      band: null,
      details: { outcome: "comprehensive_falls_assessment", recommendation: "1.1.7" },
      nextDueOn: "2026-11-11",
    });
    expect(kinds(result.triggers)).toEqual([
      "comprehensive_falls_assessment",
      "falls_review",
      "rescreen",
    ]);
  });

  it("gives no stored result for incomplete answers", () => {
    const outcome = runAssessment(
      { toolKey: "braden", answers: { ...braden.answers, moisture: null } },
      context,
    );
    expect(outcome).toMatchObject({ ok: false, code: "incomplete" });
  });

  it("refuses an assessment date that is not a real date", () => {
    const outcome = runAssessment(braden, { ...context, assessedOn: "2026-02-31" });
    expect(outcome.ok).toBe(false);
  });
});

describe("tools awaiting licence confirmation (H-25) are behind a flag", () => {
  const enabledBy = (rows: { flagKey: string; enabled: boolean }[]) => (flag: FlagKey) =>
    evaluateFlag(
      flag,
      rows.map((r) => ({ ...r, locationId: null })),
      null,
    );

  it.each([
    ["must", [], true],
    ["ng249_falls", [], true],
    ["waterlow", [], false],
    ["braden", [], false],
    ["waterlow", [{ flagKey: "care.tool.waterlow", enabled: true }], true],
    ["braden", [{ flagKey: "care.tool.waterlow", enabled: true }], false],
    ["braden", [{ flagKey: "care.tool.braden", enabled: true }], true],
  ] as const)("%s with flags %j is available: %s", (toolKey, rows, expected) => {
    expect(toolAvailable(toolKey, enabledBy([...rows]))).toBe(expected);
  });

  it("names the flag for each gated tool", () => {
    expect(toolFlag("waterlow")).toBe("care.tool.waterlow");
    expect(toolFlag("braden")).toBe("care.tool.braden");
    expect(toolFlag("must")).toBeNull();
  });
});

describe("hazard HZ-017 corrections supersede with a reason", () => {
  it.each([
    [{ toolKey: "must" }, "must", "Wrong height entered", null],
    [{ toolKey: "must" }, "must", "", "reason"],
    [{ toolKey: "must" }, "braden", "Wrong tool chosen", "tool"],
    [null, "must", "Wrong height entered", "not_found"],
  ] as const)("original %j corrected as %s with %j", (original, toolKey, reason, problem) => {
    const check = checkAssessmentCorrection(original, toolKey, reason);
    expect(check.ok ? null : check.problem).toBe(problem);
  });

  it("reads the latest result per tool, leaving superseded results in the history", () => {
    const at = (iso: string) => new Date(iso);
    const rows = [
      { id: "m1", toolKey: "must", occurredAt: at("2026-09-01T10:00:00Z"), supersedesId: null },
      { id: "m2", toolKey: "must", occurredAt: at("2026-10-01T10:00:00Z"), supersedesId: null },
      { id: "m3", toolKey: "must", occurredAt: at("2026-10-01T10:00:00Z"), supersedesId: "m2" },
      { id: "b1", toolKey: "braden", occurredAt: at("2026-10-05T10:00:00Z"), supersedesId: null },
    ];
    expect(currentResults(rows).map((r) => r.id)).toEqual(["b1", "m3"]);
  });
});

describe("rule 1: a change in the result brings the care plan review forward", () => {
  const result = (
    toolKey: AssessmentRecord["toolKey"],
    band: string | null,
    triggers: CareTrigger[] = [],
  ) => ({ toolKey, band, triggers }) as Pick<AssessmentRecord, "toolKey" | "band" | "triggers">;

  it.each([
    ["a first MUST result", null, result("must", "low"), false],
    ["the same MUST band", result("must", "low"), result("must", "low"), false],
    ["a worse MUST band", result("must", "low"), result("must", "high"), true],
    ["a better Braden band", result("braden", "high_risk"), result("braden", "at_risk"), true],
    [
      "a fall reported",
      null,
      result("ng249_falls", null, [
        { kind: "task", task: "falls_review", reason: "Fall reported" },
      ]),
      true,
    ],
    ["no fall reported", null, result("ng249_falls", null), false],
  ] as const)("%s", (_label, previous, next, expected) => {
    expect(needsPlanReview(previous, next)).toBe(expected);
  });
});
