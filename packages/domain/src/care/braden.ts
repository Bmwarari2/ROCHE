/**
 * Braden Scale for predicting pressure sore risk, calculated exactly as published (care.md
 * section 4 rule 5; hazard HZ-012). Licence awaits confirmation (human action H-25): the form says
 * permission should be sought at www.bradenscale.com and use in profit-making ventures needs
 * further permission. See TOOLS_AWAITING_LICENCE_CONFIRMATION.
 *
 * Source: Bergstrom N, Braden BJ, Laguzza A, Holman V. The Braden Scale for predicting pressure
 * sore risk. Nursing Research 1987;36(4):205–210. Braden Scale form, © Barbara Braden and Nancy
 * Bergstrom 1988. Six subscales: five scored 1 to 4 and friction and shear scored 1 to 3; total 6
 * to 23, where a lower total means a higher risk. Band wording follows the publisher: 9 or less
 * severe risk, 10 to 12 high risk, 13 to 14 moderate risk, and 15 to 18 at risk (the publisher's
 * cut-off is 18: Bergstrom N and others, Nursing Research 1998;47(5):261–269, cited in the
 * bradenscale.com FAQs; the 1988 form prints "mild risk" for 15 to 18). A total of 19 or more has
 * no risk band on the form and is shown as below the at-risk threshold, never as "no risk".
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
  | "severe_risk"
  | "high_risk"
  | "moderate_risk"
  | "at_risk"
  | "below_at_risk_threshold";

const BANDS: readonly {
  readonly upTo: number;
  readonly band: BradenBand;
  readonly label: string;
}[] = [
  { upTo: 9, band: "severe_risk", label: "Severe risk" },
  { upTo: 12, band: "high_risk", label: "High risk" },
  { upTo: 14, band: "moderate_risk", label: "Moderate risk" },
  { upTo: 18, band: "at_risk", label: "At risk" },
  { upTo: 23, band: "below_at_risk_threshold", label: "Below the at-risk threshold" },
];

export type BradenInput = { readonly [K in BradenSubscale]?: number | null };

export interface BradenResult extends ToolResult<"braden", BradenBand> {
  /** The publisher's wording for the band, shown beside the total. */
  readonly bandLabel: string;
}

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
  const { band, label } = BANDS.find((b) => score <= b.upTo) as (typeof BANDS)[number];
  return {
    ok: true,
    result: {
      toolKey: "braden",
      toolVersion: BRADEN_TOOL_VERSION,
      score,
      band,
      bandLabel: label,
      workings,
      triggers: [],
    },
  };
}
