import { describe, expect, it } from "vitest";
import { readRateTable } from "../../test/rate-table";
import {
  BED_RAIL_RATE_KEYS,
  checkRiskAssessment,
  RISK_TEMPLATE_KEYS,
  RISK_TEMPLATES,
  type RiskAssessmentInput,
  type RiskBand,
  resolveBedRailLimits,
  riskBand,
  riskRating,
} from "./risk-assessment";

/**
 * Positive risk assessments (master prompt 10.1, Reg 12; register row CARE-002). Templates are code
 * constants; the rating uses the published NPSA 5 x 5 matrix on the assessor's own judgements, and
 * the falls template never rates (NICE NG249 1.1.1). Bed rail gaps are checked against the MHRA
 * figures in the rate table.
 */

const rows = readRateTable();
const limits = resolveBedRailLimits(rows, "england", "2026-10-11", null);
const REVIEW_MONTHS = 1;

const base = (overrides: Partial<RiskAssessmentInput> = {}): RiskAssessmentInput => ({
  templateKey: "moving_and_handling",
  hazard: "Transfers from bed to chair",
  whoAtRisk: "Ada and the staff helping her",
  answers: {
    bears_weight: false,
    cooperates: true,
    equipment_needed: true,
    equipment_examined: true,
  },
  likelihood: 3,
  severity: 4,
  residualLikelihood: 1,
  residualSeverity: 4,
  controls: ["Full-body hoist with a medium sling", "Two staff for every transfer"],
  positiveRiskStatement: null,
  assessedOn: "2026-10-11",
  reviewDueOn: null,
  ...overrides,
});

describe("templates", () => {
  it("covers every template the master prompt lists, plus a general one", () => {
    expect([...RISK_TEMPLATE_KEYS].sort()).toEqual(
      [
        "absconding",
        "bed_rails",
        "choking",
        "environmental",
        "falls",
        "financial",
        "fire_setting",
        "general",
        "going_out_alone",
        "moving_and_handling",
        "self_harm_and_suicide",
        "sexual_safety",
        "skin",
        "smoking",
        "substance_and_alcohol_use",
      ].sort(),
    );
  });

  it.each(RISK_TEMPLATE_KEYS)("%s has a title, a source, unique questions and controls", (key) => {
    const template = RISK_TEMPLATES[key];
    expect(template.key).toBe(key);
    expect(template.title.length).toBeGreaterThan(3);
    expect(template.source.length).toBeGreaterThan(3);
    const questionKeys = template.questions.map((q) => q.key);
    expect(new Set(questionKeys).size).toBe(questionKeys.length);
    if (key !== "general") expect(template.questions.length).toBeGreaterThan(2);
    expect(template.suggestedControls.length).toBeGreaterThan(key === "general" ? -1 : 1);
  });

  it("never states a statutory figure in a template: measurements name their rate-table key", () => {
    for (const template of Object.values(RISK_TEMPLATES)) {
      for (const question of template.questions) {
        expect(question.text).not.toMatch(/\d/);
        if (question.kind === "measurement_mm") {
          expect(Object.values(BED_RAIL_RATE_KEYS)).toContain(question.limit.rateKey);
        }
      }
      for (const control of template.suggestedControls) expect(control).not.toMatch(/\d/);
    }
  });
});

describe("rating with the NPSA 5 x 5 risk matrix", () => {
  it.each<[number, number, number, RiskBand]>([
    [1, 1, 1, "low"],
    [1, 3, 3, "low"],
    [3, 1, 3, "low"],
    [2, 2, 4, "moderate"],
    [1, 5, 5, "moderate"],
    [2, 3, 6, "moderate"],
    [2, 4, 8, "high"],
    [3, 3, 9, "high"],
    [3, 4, 12, "high"],
    [3, 5, 15, "extreme"],
    [4, 4, 16, "extreme"],
    [5, 5, 25, "extreme"],
  ])("likelihood %i x severity %i = %i (%s)", (likelihood, severity, rating, band) => {
    expect(riskRating(likelihood, severity)).toBe(rating);
    expect(riskBand(rating)).toBe(band);
  });

  it.each([
    [0, 3],
    [6, 3],
    [2.5, 3],
    [3, Number.NaN],
  ])("refuses likelihood %s and severity %s", (likelihood, severity) => {
    expect(() => riskRating(likelihood, severity)).toThrow(RangeError);
  });
});

const check = (overrides: Partial<RiskAssessmentInput>) =>
  checkRiskAssessment(base(overrides), { limits, reviewIntervalMonths: REVIEW_MONTHS });

describe("checking an assessment", () => {
  it("rates the initial and residual risk and defaults the review date", () => {
    const outcome = check({});
    expect(outcome).toEqual({
      ok: true,
      value: {
        rating: 12,
        band: "high",
        residualRating: 4,
        residualBand: "moderate",
        findings: [],
        outsideLimits: false,
        reviewDueOn: "2026-11-11",
      },
    });
  });

  it.each<[string, Partial<RiskAssessmentInput>, string]>([
    ["an unknown template", { templateKey: "juggling" as never }, "templateKey"],
    ["no hazard", { hazard: " " }, "hazard"],
    ["no one at risk", { whoAtRisk: "" }, "whoAtRisk"],
    ["no controls", { controls: [] }, "controls"],
    ["a blank control", { controls: ["Hoist", " "] }, "controls"],
    ["no likelihood", { likelihood: null }, "likelihood"],
    ["a severity of 6", { severity: 6 }, "severity"],
    ["no residual likelihood", { residualLikelihood: null }, "residualLikelihood"],
    ["a residual risk above the initial risk", { residualLikelihood: 5 }, "residualLikelihood"],
    ["an unanswered yes or no question", { answers: { bears_weight: false } }, "answers"],
    [
      "an answer to a question not on the template",
      { answers: { ...base().answers, colour: "red" } },
      "answers",
    ],
    [
      "a yes or no question answered with text",
      { answers: { ...base().answers, cooperates: "yes" } },
      "answers",
    ],
    ["a review date before the assessment", { reviewDueOn: "2026-10-10" }, "reviewDueOn"],
    [
      "a review date beyond the care plan review interval",
      { reviewDueOn: "2026-12-12" },
      "reviewDueOn",
    ],
    ["an assessment date that is not real", { assessedOn: "2026-13-01" }, "assessedOn"],
  ])("refuses %s", (_label, overrides, field) => {
    const outcome = check(overrides);
    expect(outcome.ok ? [] : outcome.issues.map((i) => i.field)).toContain(field);
  });

  it("needs a positive-risk statement when a high or extreme residual risk is accepted", () => {
    const accepted = { residualLikelihood: 3, residualSeverity: 4 };
    expect(check(accepted).ok).toBe(false);
    expect(
      check({
        ...accepted,
        positiveRiskStatement:
          "Ada chooses to sit in the garden; the benefit to her mood outweighs the risk.",
      }).ok,
    ).toBe(true);
  });

  it("does not need the statement for a moderate residual risk", () => {
    expect(check({ residualLikelihood: 2, residualSeverity: 3 }).ok).toBe(true);
  });
});

describe("NICE NG249 1.1.1: the falls template never produces a rating", () => {
  const falls = {
    templateKey: "falls" as const,
    answers: {
      fallen_last_year: true,
      walking_aid: true,
      environment_hazards: false,
      footwear_safe: true,
      falls_assessment_offered: true,
    },
    controls: ["Walking frame within reach", "Night light on"],
  };

  it("records answers and controls with no likelihood, severity or band", () => {
    const outcome = check({
      ...falls,
      likelihood: null,
      severity: null,
      residualLikelihood: null,
      residualSeverity: null,
    });
    expect(outcome).toMatchObject({
      ok: true,
      value: { rating: null, band: null, residualRating: null, residualBand: null },
    });
  });

  it("refuses a likelihood or severity on a falls assessment", () => {
    const outcome = check(falls);
    expect(outcome.ok ? [] : outcome.issues.map((i) => i.field)).toEqual(
      expect.arrayContaining(["likelihood", "severity"]),
    );
  });
});

describe("hazard HZ-025 bed rails against the MHRA figures in the rate table", () => {
  const value = (key: string) => Number(rows.find((r) => r.key === key)?.value);
  const betweenBars = value(BED_RAIL_RATE_KEYS.betweenBars);
  const betweenBarsSmall = value(BED_RAIL_RATE_KEYS.betweenBarsSmallOrAtypical);
  const railToMattress = value(BED_RAIL_RATE_KEYS.railToMattress);
  const railEnd = value(BED_RAIL_RATE_KEYS.railEndToHeadboard);
  const height = value(BED_RAIL_RATE_KEYS.heightMin);

  const answers = (overrides: Record<string, unknown> = {}) => ({
    risk_of_falling_from_bed: true,
    could_climb_over: false,
    entrapment_risk: false,
    small_or_atypical_body: false,
    consent_or_best_interests: true,
    gap_between_bars_mm: betweenBars - 1,
    gap_rail_to_mattress_mm: railToMattress - 1,
    gap_rail_end_to_headboard_mm: railEnd - 1,
    rail_height_mm: height,
    ...overrides,
  });

  const bedRails = (overrides: Record<string, unknown> = {}) =>
    check({ templateKey: "bed_rails", answers: answers(overrides) });

  const outside = (outcome: ReturnType<typeof check>) =>
    outcome.ok
      ? outcome.value.findings.filter((f) => !f.withinLimit).map((f) => f.questionKey)
      : null;

  it("reads every bed rail figure from the rate table", () => {
    expect(limits).toEqual({
      [BED_RAIL_RATE_KEYS.betweenBars]: betweenBars,
      [BED_RAIL_RATE_KEYS.betweenBarsSmallOrAtypical]: betweenBarsSmall,
      [BED_RAIL_RATE_KEYS.railToMattress]: railToMattress,
      [BED_RAIL_RATE_KEYS.railEndToHeadboard]: railEnd,
      [BED_RAIL_RATE_KEYS.heightMin]: height,
    });
  });

  it.each<[string, Record<string, unknown>, string[]]>([
    ["every measurement inside the limits", {}, []],
    [
      "a gap between the bars at the limit (MHRA: under the figure)",
      { gap_between_bars_mm: betweenBars },
      ["gap_between_bars_mm"],
    ],
    [
      "a gap to the mattress at the limit",
      { gap_rail_to_mattress_mm: railToMattress },
      ["gap_rail_to_mattress_mm"],
    ],
    [
      "a gap to the headboard at the limit",
      { gap_rail_end_to_headboard_mm: railEnd },
      ["gap_rail_end_to_headboard_mm"],
    ],
    ["a rail just under the minimum height", { rail_height_mm: height - 1 }, ["rail_height_mm"]],
    [
      "a small or atypical body with the standard gap between the bars",
      { small_or_atypical_body: true },
      betweenBars - 1 < betweenBarsSmall ? [] : ["gap_between_bars_mm"],
    ],
    [
      "a small or atypical body with a gap under the smaller figure",
      { small_or_atypical_body: true, gap_between_bars_mm: betweenBarsSmall - 1 },
      [],
    ],
  ])("%s", (_label, overrides, expected) => {
    const outcome = bedRails(overrides);
    expect(outside(outcome)).toEqual(expected);
    if (outcome.ok) expect(outcome.value.outsideLimits).toBe(expected.length > 0);
  });

  it("refuses a negative measurement", () => {
    expect(bedRails({ rail_height_mm: -5 }).ok).toBe(false);
  });
});
