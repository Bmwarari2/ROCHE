/**
 * Braden Scale for predicting pressure sore risk, calculated exactly as published (care.md
 * section 4 rule 5; hazard HZ-012). Licence awaits confirmation (human action H-25): the form says
 * permission should be sought at www.bradenscale.com and use in profit-making ventures needs
 * further permission. See TOOLS_AWAITING_LICENCE_CONFIRMATION.
 *
 * Source: Bergstrom N, Braden BJ, Laguzza A, Holman V. The Braden Scale for predicting pressure
 * sore risk. Nursing Research 1987;36(4):205–210. Braden Scale form, © Barbara Braden and Nancy
 * Bergstrom 1988. Six subscales: five scored 1 to 4 and friction and shear scored 1 to 3; total 6
 * to 23, where a lower total means a higher risk.
 */

import { InputCheck, type ScoreWorking, type ToolOutcome, type ToolResult } from "./assessment";

export const BRADEN_TOOL_VERSION = "braden-1988";

export type BradenSubscale =
  | "sensoryPerception"
  | "moisture"
  | "activity"
  | "mobility"
  | "nutrition"
  | "frictionAndShear";

/** Published subscale names and the label for each score, lowest score first. */
const SUBSCALES: Readonly<Record<BradenSubscale, { name: string; levels: readonly string[] }>> = {
  sensoryPerception: {
    name: "Sensory perception",
    levels: ["Completely limited", "Very limited", "Slightly limited", "No impairment"],
  },
  moisture: {
    name: "Moisture",
    levels: ["Constantly moist", "Often moist", "Occasionally moist", "Rarely moist"],
  },
  activity: {
    name: "Activity",
    levels: ["Bedfast", "Chairfast", "Walks occasionally", "Walks frequently"],
  },
  mobility: {
    name: "Mobility",
    levels: ["Completely immobile", "Very limited", "Slightly limited", "No limitations"],
  },
  nutrition: {
    name: "Nutrition",
    levels: ["Very poor", "Probably inadequate", "Adequate", "Excellent"],
  },
  frictionAndShear: {
    name: "Friction and shear",
    levels: ["Problem", "Potential problem", "No apparent problem"],
  },
};

export type BradenBand =
  | "very_high_risk"
  | "high_risk"
  | "moderate_risk"
  | "mild_risk"
  | "not_at_risk";

// Bands: 9 or less very high risk; 10-12 high; 13-14 moderate; 15-18 mild (at risk); 19 or more
// not at risk.
const BANDS: readonly { readonly upTo: number; readonly band: BradenBand }[] = [
  { upTo: 9, band: "very_high_risk" },
  { upTo: 12, band: "high_risk" },
  { upTo: 14, band: "moderate_risk" },
  { upTo: 18, band: "mild_risk" },
  { upTo: 23, band: "not_at_risk" },
];

export type BradenInput = { readonly [K in BradenSubscale]?: number | null };

export type BradenResult = ToolResult<"braden", BradenBand>;

export function calculateBraden(input: BradenInput): ToolOutcome<BradenResult> {
  const check = new InputCheck();
  const workings: ScoreWorking[] = [];
  for (const key of Object.keys(SUBSCALES) as BradenSubscale[]) {
    const { name, levels } = SUBSCALES[key];
    const points = check.number(key, name, input[key], { min: 1, max: levels.length, decimals: 0 });
    if (points !== undefined) {
      workings.push({ item: name, value: `${points}: ${levels[points - 1]}`, points });
    }
  }
  if (check.failed) return check.failure();
  const score = workings.reduce((sum, w) => sum + w.points, 0);
  const band = (BANDS.find((b) => score <= b.upTo) as (typeof BANDS)[number]).band;
  return {
    ok: true,
    result: {
      toolKey: "braden",
      toolVersion: BRADEN_TOOL_VERSION,
      score,
      band,
      workings,
      triggers: [],
    },
  };
}
