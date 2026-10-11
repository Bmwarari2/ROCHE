/**
 * The validated tools Harbour calculates, with the publisher, edition and source shown on screen
 * beside every result (medical-device boundary, section 5 rule 1; hazard HZ-012). Tool versions
 * are stored on every result so a later edition never rewrites an old score.
 */

import type { FlagKey } from "../platform/feature-flags";
import type { ValidatedToolKey } from "./assessment";
import { BRADEN_TOOL_VERSION } from "./braden";
import { MUST_TOOL_VERSION } from "./must";
import { NEWS2_TOOL_VERSION } from "./news2";
import { WATERLOW_TOOL_VERSION } from "./waterlow";

export interface ValidatedToolSource {
  readonly name: string;
  readonly version: string;
  readonly publisher: string;
  readonly edition: string;
  readonly url: string;
}

export const VALIDATED_TOOLS: Readonly<Record<ValidatedToolKey, ValidatedToolSource>> = {
  news2: {
    name: "National Early Warning Score 2 (NEWS2)",
    version: NEWS2_TOOL_VERSION,
    publisher: "Royal College of Physicians",
    edition: "2017",
    url: "https://www.rcp.ac.uk/improving-care/resources/national-early-warning-score-news-2/",
  },
  must: {
    name: "'Malnutrition Universal Screening Tool' ('MUST')",
    version: MUST_TOOL_VERSION,
    publisher: "BAPEN",
    edition: "2003, reviewed August 2011",
    url: "https://www.bapen.org.uk/must-and-self-screening/must-calculator",
  },
  waterlow: {
    name: "Waterlow score",
    version: WATERLOW_TOOL_VERSION,
    publisher: "Judy Waterlow",
    edition: "1985, revised 2005",
    url: "https://www.judy-waterlow.co.uk",
  },
  braden: {
    name: "Braden Scale for Predicting Pressure Sore Risk",
    version: BRADEN_TOOL_VERSION,
    publisher: "Barbara Braden and Nancy Bergstrom",
    edition: "1988",
    url: "https://www.bradenscale.com",
  },
};

/**
 * Tools whose terms of use in software are not yet confirmed (human action H-25). They stay off for
 * real tenants until the licence is confirmed: the feature flag named here defaults to off, and the
 * assessment API refuses the tool while it is off (care.md section 10).
 */
export const TOOLS_AWAITING_LICENCE_CONFIRMATION: readonly {
  readonly toolKey: ValidatedToolKey;
  readonly humanAction: "H-25";
  readonly flagKey: FlagKey;
}[] = [
  { toolKey: "waterlow", humanAction: "H-25", flagKey: "care.tool.waterlow" },
  { toolKey: "braden", humanAction: "H-25", flagKey: "care.tool.braden" },
];
