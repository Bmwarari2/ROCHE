import { describe, expect, it } from "vitest";
import {
  type FallsCriteria,
  type FallsPathwayInput,
  type FallsPathwayResult,
  NG249_VERSION,
  ng249FallsPathway,
} from "./falls";

/**
 * The NICE NG249 falls pathway: who is offered a comprehensive falls assessment, and why. It
 * raises tasks and never a score (NG249 1.1.1; medical-device boundary, section 4).
 */

function pathway(input: FallsPathwayInput): FallsPathwayResult {
  const outcome = ng249FallsPathway(input);
  if (!outcome.ok) throw new Error(outcome.message);
  return outcome.result;
}

const tasksOf = (result: FallsPathwayResult) =>
  result.triggers.map((t) => (t.kind === "task" ? t.task : t.kind));

const NO_CRITERIA: Required<FallsCriteria> = {
  livingWithFrailty: false,
  injuredAndNeededMedicalTreatment: false,
  lostConsciousness: false,
  unableToGetUpIndependently: false,
  twoOrMoreFallsInLastYear: false,
};

function numbersIn(value: unknown): number[] {
  if (typeof value === "number") return [value];
  if (value && typeof value === "object") return Object.values(value).flatMap(numbersIn);
  return [];
}

describe("NG249 falls pathway in residential care settings (recommendation 1.1.7)", () => {
  it.each([
    ["admission", "on admission"],
    ["review", "at review"],
    ["after_fall", "after a fall"],
  ] as const)("offers everyone a comprehensive falls assessment %s", (occasion, words) => {
    const result = pathway({
      setting: "residential",
      occasion,
      fallenInLastYear: false,
      presentingAfterFall: false,
    });
    expect(result).toMatchObject({
      toolKey: "ng249_falls",
      toolVersion: NG249_VERSION,
      setting: "residential",
      outcome: "comprehensive_falls_assessment",
      recommendation: "1.1.7",
      reason: `NICE NG249 1.1.7: offer a comprehensive falls assessment to people in residential care settings (${words})`,
    });
    expect(tasksOf(result)[0]).toBe("comprehensive_falls_assessment");
  });

  it("offers the assessment whatever the answers about falls, which are recorded but not needed", () => {
    const result = pathway({ setting: "residential", occasion: "admission" });
    expect(result.outcome).toBe("comprehensive_falls_assessment");
    expect(result.answers).toEqual({ fallenInLastYear: null, presentingAfterFall: null });
  });

  it.each([
    ["no fall reported", { occasion: "review", fallenInLastYear: false }, false],
    ["a fall in the last year", { occasion: "admission", fallenInLastYear: true }, true],
    ["presenting after a fall", { occasion: "review", presentingAfterFall: true }, true],
    ["a review after a fall", { occasion: "after_fall" }, true],
  ] as const)(
    "raises a falls review only when a fall is reported: %s",
    (_name, answers, review) => {
      const result = pathway({ setting: "residential", ...answers });
      expect(tasksOf(result).includes("falls_review")).toBe(review);
    },
  );

  it("needs to know whether this is admission, review or after a fall", () => {
    expect(ng249FallsPathway({ setting: "residential", fallenInLastYear: true })).toMatchObject({
      ok: false,
      code: "incomplete",
      issues: [{ item: "occasion", problem: "missing" }],
      message: "Falls pathway incomplete: 1 answer missing.",
    });
  });
});

describe("NG249 falls pathway in community settings (recommendations 1.1.3, 1.1.4 and 1.1.6)", () => {
  it.each([
    ["livingWithFrailty", "are living with frailty"],
    [
      "injuredAndNeededMedicalTreatment",
      "were injured in a fall and needed medical (including surgical) treatment",
    ],
    ["lostConsciousness", "have experienced a loss of consciousness related to a fall"],
    ["unableToGetUpIndependently", "have been unable to get up independently after a fall"],
    ["twoOrMoreFallsInLastYear", "have had 2 or more falls in the last year"],
  ] as const)(
    "a fall in the last year and %s: comprehensive falls assessment (1.1.3)",
    (criterion, words) => {
      const result = pathway({
        setting: "community",
        fallenInLastYear: true,
        criteria: { ...NO_CRITERIA, [criterion]: true },
      });
      expect(result).toMatchObject({
        outcome: "comprehensive_falls_assessment",
        recommendation: "1.1.3",
        criteriaMet: [criterion],
        reason: `NICE NG249 1.1.3: fallen in the last year and ${words}`,
      });
      expect(tasksOf(result)).toEqual(["comprehensive_falls_assessment", "falls_review"]);
    },
  );

  it("lists every criterion met, and one yes is enough even if others are unanswered", () => {
    const result = pathway({
      setting: "community",
      presentingAfterFall: true,
      criteria: { livingWithFrailty: true, twoOrMoreFallsInLastYear: true },
    });
    expect(result.criteriaMet).toEqual(["livingWithFrailty", "twoOrMoreFallsInLastYear"]);
    expect(result.reason).toBe(
      "NICE NG249 1.1.3: fallen in the last year and are living with frailty; have had 2 or more falls in the last year",
    );
  });

  it.each([
    ["fallen in the last year", { fallenInLastYear: true }],
    ["presenting after a fall", { presentingAfterFall: true }],
  ] as const)(
    "%s without any 1.1.3 criterion: gait and balance check (1.1.4)",
    (_name, answers) => {
      const result = pathway({ setting: "community", ...answers, criteria: NO_CRITERIA });
      expect(result).toMatchObject({
        outcome: "gait_and_balance_assessment",
        recommendation: "1.1.4",
        criteriaMet: [],
        reason:
          "NICE NG249 1.1.4: fallen in the last year without the criteria in 1.1.3: assess gait and balance",
      });
      expect(tasksOf(result)).toEqual(["gait_and_balance_assessment", "falls_review"]);
    },
  );

  it.each([
    ["both answers no", { fallenInLastYear: false, presentingAfterFall: false }],
    ["no fall in the last year", { fallenInLastYear: false }],
  ] as const)("%s: no falls assessment, information and advice (1.1.6)", (_name, answers) => {
    expect(pathway({ setting: "community", ...answers })).toMatchObject({
      outcome: "no_falls_assessment",
      recommendation: "1.1.6",
      reason:
        "NICE NG249 1.1.6: no fall in the last year: offer health and wellbeing information, and advice on physical activity",
      triggers: [],
    });
  });

  it.each([
    ["no answer about falls in the last year", {}, ["fallenInLastYear"]],
    ["a fall but no criteria answered", { fallenInLastYear: true }, ["criteria"]],
    [
      "a fall with no criterion met and two unanswered",
      {
        fallenInLastYear: true,
        criteria: { ...NO_CRITERIA, lostConsciousness: null, twoOrMoreFallsInLastYear: undefined },
      },
      ["criteria.lostConsciousness", "criteria.twoOrMoreFallsInLastYear"],
    ],
  ] as const)("does not conclude with %s", (_name, answers, missing) => {
    const outcome = ng249FallsPathway({ setting: "community", ...answers });
    expect(outcome).toMatchObject({ ok: false, code: "incomplete" });
    expect(outcome.ok ? [] : outcome.issues.map((i) => i.item)).toEqual(missing);
  });
});

describe("NG249 falls pathway returns no score (NICE NG249 1.1.1, medical-device boundary)", () => {
  it.each([
    ["residential", { setting: "residential", occasion: "admission", fallenInLastYear: true }],
    [
      "community, comprehensive",
      { setting: "community", fallenInLastYear: true, criteria: { lostConsciousness: true } },
    ],
    [
      "community, gait and balance",
      { setting: "community", fallenInLastYear: true, criteria: NO_CRITERIA },
    ],
    ["community, no fall", { setting: "community", fallenInLastYear: false }],
  ] as const)("returns no numeric risk score, band or risk level: %s", (_name, input) => {
    const result = pathway(input as FallsPathwayInput);
    expect(numbersIn(result)).toEqual([]);
    expect(result).not.toHaveProperty("score");
    expect(result).not.toHaveProperty("band");
    expect(JSON.stringify(result)).not.toMatch(/risk|score/i);
  });
});
