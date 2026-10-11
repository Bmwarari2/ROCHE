import { describe, expect, it } from "vitest";
import { FLAGS } from "../platform/feature-flags";
import { BRADEN_TOOL_VERSION, type BradenInput, calculateBraden } from "./braden";
import { TOOLS_AWAITING_LICENCE_CONFIRMATION } from "./tools";

/** Braden Scale against the published form (hazard HZ-012). */

function input([
  sensoryPerception,
  moisture,
  activity,
  mobility,
  nutrition,
  frictionAndShear,
]: readonly number[]): BradenInput {
  return { sensoryPerception, moisture, activity, mobility, nutrition, frictionAndShear };
}

describe("hazard HZ-012 Braden totals and risk bands match the published form", () => {
  // Publisher's wording: 9 or less severe risk; 10 to 12 high risk; 13 to 14 moderate risk; 15 to 18
  // at risk (cut-off 18, Bergstrom 1998); 19 or more has no risk band on the form.
  it.each([
    ["6, the minimum", [1, 1, 1, 1, 1, 1], 6, "severe_risk", "Severe risk"],
    ["9", [4, 1, 1, 1, 1, 1], 9, "severe_risk", "Severe risk"],
    ["10", [4, 2, 1, 1, 1, 1], 10, "high_risk", "High risk"],
    ["12", [4, 4, 1, 1, 1, 1], 12, "high_risk", "High risk"],
    ["13", [4, 4, 2, 1, 1, 1], 13, "moderate_risk", "Moderate risk"],
    ["14", [4, 4, 3, 1, 1, 1], 14, "moderate_risk", "Moderate risk"],
    ["15", [4, 4, 4, 1, 1, 1], 15, "at_risk", "At risk"],
    ["18", [4, 4, 4, 4, 1, 1], 18, "at_risk", "At risk"],
    ["19", [4, 4, 4, 4, 2, 1], 19, "below_at_risk_threshold", "Below the at-risk threshold"],
    [
      "23, the maximum",
      [4, 4, 4, 4, 4, 3],
      23,
      "below_at_risk_threshold",
      "Below the at-risk threshold",
    ],
  ] as const)("total %s", (_name, scores, score, band, bandLabel) => {
    const outcome = calculateBraden(input(scores));
    expect(outcome).toMatchObject({
      ok: true,
      result: {
        toolKey: "braden",
        toolVersion: BRADEN_TOOL_VERSION,
        score,
        band,
        bandLabel,
        triggers: [],
      },
    });
  });

  it("shows each subscale with its published label", () => {
    const outcome = calculateBraden(input([2, 3, 1, 2, 4, 2]));
    expect(outcome.ok && outcome.result.workings).toEqual([
      { item: "Sensory perception", value: "2: Very limited", points: 2 },
      { item: "Moisture", value: "3: Occasionally moist", points: 3 },
      { item: "Activity", value: "1: Bedfast", points: 1 },
      { item: "Mobility", value: "2: Very limited", points: 2 },
      { item: "Nutrition", value: "4: Excellent", points: 4 },
      { item: "Friction and shear", value: "2: Potential problem", points: 2 },
    ]);
  });
});

describe("hazard HZ-012 Braden gives no total for missing or impossible subscale scores", () => {
  it.each([
    [
      "a missing subscale",
      { ...input([2, 2, 2, 2, 2, 2]), nutrition: null },
      "nutrition",
      "incomplete",
    ],
    ["a subscale scored 0", input([0, 2, 2, 2, 2, 2]), "sensoryPerception", "invalid"],
    ["a subscale scored 5", input([2, 5, 2, 2, 2, 2]), "moisture", "invalid"],
    ["friction and shear scored 4", input([2, 2, 2, 2, 2, 4]), "frictionAndShear", "invalid"],
    ["a fractional score", input([2, 2, 2.5, 2, 2, 2]), "activity", "invalid"],
  ] as const)("refuses %s", (_name, braden, item, code) => {
    expect(calculateBraden(braden)).toMatchObject({ ok: false, code, issues: [{ item }] });
  });
});

describe("validated tools awaiting licence confirmation", () => {
  it("lists Waterlow and Braden against human action H-25, each behind an off-by-default flag", () => {
    expect(TOOLS_AWAITING_LICENCE_CONFIRMATION).toEqual([
      { toolKey: "waterlow", humanAction: "H-25", flagKey: "care.tool.waterlow" },
      { toolKey: "braden", humanAction: "H-25", flagKey: "care.tool.braden" },
    ]);
    for (const { flagKey } of TOOLS_AWAITING_LICENCE_CONFIRMATION) {
      expect(FLAGS[flagKey].defaultEnabled).toBe(false);
    }
  });
});
