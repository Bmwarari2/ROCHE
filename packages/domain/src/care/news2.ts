/**
 * NEWS2, calculated exactly as published (care.md section 4 rule 5; hazards HZ-012 and HZ-014).
 *
 * Source: Royal College of Physicians. National Early Warning Score (NEWS) 2: Standardising the
 * assessment of acute-illness severity in the NHS. Updated report of a working party. London: RCP,
 * 2017. Chart 1 (the NEWS scoring system), chart 2 (NEWS thresholds and triggers) and chart 4
 * (clinical response to the NEWS trigger thresholds), © Royal College of Physicians 2017.
 * https://www.rcp.ac.uk/improving-care/resources/national-early-warning-score-news-2/
 *
 * The tables below are the published tool definition, not rate-table figures. Do not edit them
 * except to follow a new RCP edition, and change NEWS2_TOOL_VERSION when you do.
 */

import {
  type CareTrigger,
  InputCheck,
  type MonitoringFrequency,
  type ToolOutcome,
  type ToolResult,
} from "./assessment";

export const NEWS2_TOOL_VERSION = "rcp-2017";

/** A row of a published scoring chart: inclusive bounds, open-ended when a bound is absent. */
interface ScoreBand {
  readonly min?: number;
  readonly max?: number;
  readonly points: number;
  /** SpO2 scale 2 only: the row applies on air or on oxygen. */
  readonly onOxygen?: boolean;
}

// Chart 1. Values are whole numbers except temperature, which is held in tenths of a degree so
// every comparison is exact.
const RESPIRATION_RATE: readonly ScoreBand[] = [
  { max: 8, points: 3 },
  { min: 9, max: 11, points: 1 },
  { min: 12, max: 20, points: 0 },
  { min: 21, max: 24, points: 2 },
  { min: 25, points: 3 },
];

const SPO2_SCALE_1: readonly ScoreBand[] = [
  { max: 91, points: 3 },
  { min: 92, max: 93, points: 2 },
  { min: 94, max: 95, points: 1 },
  { min: 96, points: 0 },
];

const SPO2_SCALE_2: readonly ScoreBand[] = [
  { max: 83, points: 3 },
  { min: 84, max: 85, points: 2 },
  { min: 86, max: 87, points: 1 },
  { min: 88, max: 92, points: 0 },
  { min: 93, points: 0, onOxygen: false },
  { min: 93, max: 94, points: 1, onOxygen: true },
  { min: 95, max: 96, points: 2, onOxygen: true },
  { min: 97, points: 3, onOxygen: true },
];

const AIR_OR_OXYGEN = { air: 0, oxygen: 2 } as const;

const SYSTOLIC_BP: readonly ScoreBand[] = [
  { max: 90, points: 3 },
  { min: 91, max: 100, points: 2 },
  { min: 101, max: 110, points: 1 },
  { min: 111, max: 219, points: 0 },
  { min: 220, points: 3 },
];

const PULSE: readonly ScoreBand[] = [
  { max: 40, points: 3 },
  { min: 41, max: 50, points: 1 },
  { min: 51, max: 90, points: 0 },
  { min: 91, max: 110, points: 1 },
  { min: 111, max: 130, points: 2 },
  { min: 131, points: 3 },
];

const TEMPERATURE_TENTHS: readonly ScoreBand[] = [
  { max: 350, points: 3 },
  { min: 351, max: 360, points: 1 },
  { min: 361, max: 380, points: 0 },
  { min: 381, max: 390, points: 1 },
  { min: 391, points: 2 },
];

export type News2Consciousness = "alert" | "new_confusion" | "voice" | "pain" | "unresponsive";

/** Alert scores 0; new confusion, voice, pain or unresponsive (CVPU) scores 3. */
const CONSCIOUSNESS: Readonly<Record<News2Consciousness, { label: string; points: number }>> = {
  alert: { label: "Alert", points: 0 },
  new_confusion: { label: "New confusion", points: 3 },
  voice: { label: "Responds to voice", points: 3 },
  pain: { label: "Responds to pain", points: 3 },
  unresponsive: { label: "Unresponsive", points: 3 },
};

export type News2Band = "low" | "low_medium" | "medium" | "high";

/** Chart 4 rows. */
export type News2ResponseThreshold =
  | "score_0"
  | "score_1_to_4"
  | "single_parameter_3"
  | "score_5_or_more"
  | "score_7_or_more";

interface PublishedResponse {
  readonly band: News2Band;
  /** Chart 2 wording. */
  readonly clinicalRisk: string;
  readonly response: string;
  /** Chart 4 wording. */
  readonly monitoring: MonitoringFrequency;
  readonly clinicalResponse: readonly string[];
}

// Charts 2 and 4, word for word. The response is the RCP's, not Harbour advice: the screen links
// it to the tenant's own escalation policy (medical-device boundary, section 5 rule 4).
const RESPONSES: Readonly<Record<News2ResponseThreshold, PublishedResponse>> = {
  score_0: {
    band: "low",
    clinicalRisk: "Low",
    response: "Ward-based response",
    monitoring: {
      kind: "interval",
      text: "Minimum 12 hourly",
      shortestHours: 12,
      longestHours: 12,
    },
    clinicalResponse: ["Continue routine NEWS monitoring"],
  },
  score_1_to_4: {
    band: "low",
    clinicalRisk: "Low",
    response: "Ward-based response",
    monitoring: { kind: "interval", text: "Minimum 4–6 hourly", shortestHours: 4, longestHours: 6 },
    clinicalResponse: [
      "Inform registered nurse, who must assess the patient",
      "Registered nurse decides whether increased frequency of monitoring and/or escalation of care is required",
    ],
  },
  single_parameter_3: {
    band: "low_medium",
    clinicalRisk: "Low–medium",
    response: "Urgent ward-based response",
    monitoring: { kind: "interval", text: "Minimum 1 hourly", shortestHours: 1, longestHours: 1 },
    clinicalResponse: [
      "Registered nurse to inform medical team caring for the patient, who will review and decide whether escalation of care is necessary",
    ],
  },
  score_5_or_more: {
    band: "medium",
    clinicalRisk: "Medium",
    response: "Key threshold for urgent response",
    monitoring: { kind: "interval", text: "Minimum 1 hourly", shortestHours: 1, longestHours: 1 },
    clinicalResponse: [
      "Registered nurse to immediately inform the medical team caring for the patient",
      "Registered nurse to request urgent assessment by a clinician or team with core competencies in the care of acutely ill patients",
      "Provide clinical care in an environment with monitoring facilities",
    ],
  },
  score_7_or_more: {
    band: "high",
    clinicalRisk: "High",
    response: "Urgent or emergency response",
    monitoring: { kind: "continuous", text: "Continuous monitoring of vital signs" },
    clinicalResponse: [
      "Registered nurse to immediately inform the medical team caring for the patient – this should be at least at specialist registrar level",
      "Emergency assessment by a team with critical care competencies, including practitioner(s) with advanced airway management skills",
      "Consider transfer of care to a level 2 or 3 clinical care facility, ie higher-dependency unit or ICU",
      "Clinical care in an environment with monitoring facilities",
    ],
  },
};

/**
 * Data-entry limits, not part of the published tool: a value outside them cannot be a real
 * reading, so it is refused as a likely typing error rather than scored (HZ-012).
 */
export const NEWS2_INPUT_LIMITS = {
  respirationRate: { min: 1, max: 80, decimals: 0 },
  spo2: { min: 50, max: 100, decimals: 0 },
  systolicBp: { min: 30, max: 300, decimals: 0 },
  pulse: { min: 20, max: 300, decimals: 0 },
  temperature: { min: 20, max: 45, decimals: 1 },
} as const;

export interface News2Input {
  /** Breaths per minute. */
  readonly respirationRate?: number | null;
  /** Oxygen saturation, percent. */
  readonly spo2?: number | null;
  /** True when the person is on supplemental oxygen, false on air. */
  readonly supplementalOxygen?: boolean | null;
  /** mmHg. */
  readonly systolicBp?: number | null;
  /** Beats per minute. */
  readonly pulse?: number | null;
  readonly consciousness?: News2Consciousness | null;
  /** Degrees Celsius to one decimal place. */
  readonly temperature?: number | null;
  /**
   * True only when a registered clinician has recorded on the person's record the decision to use
   * SpO2 scale 2 (a prescribed target range of 88–92%, for example in hypercapnic respiratory
   * failure). The scale follows the record; staff taking observations never choose it.
   */
  readonly spo2Scale2Decision: boolean;
}

export interface News2Result extends ToolResult<"news2", News2Band> {
  readonly spo2Scale: 1 | 2;
  /** A score of 3 in any single parameter (the RCP "red score"). */
  readonly redScore: boolean;
  readonly threshold: News2ResponseThreshold;
  readonly clinicalRisk: string;
  readonly response: string;
  readonly monitoring: MonitoringFrequency;
  readonly clinicalResponse: readonly string[];
}

function pointsFor(bands: readonly ScoreBand[], value: number, onOxygen = false): number {
  const band = bands.find(
    (b) =>
      (b.min === undefined || value >= b.min) &&
      (b.max === undefined || value <= b.max) &&
      (b.onOxygen === undefined || b.onOxygen === onOxygen),
  );
  // The published charts cover every value; reaching here means a table was edited wrongly.
  if (!band) throw new Error(`NEWS2 chart has no row for ${value}`);
  return band.points;
}

function thresholdFor(total: number, redScore: boolean): News2ResponseThreshold {
  if (total >= 7) return "score_7_or_more";
  if (total >= 5) return "score_5_or_more";
  if (redScore) return "single_parameter_3";
  return total === 0 ? "score_0" : "score_1_to_4";
}

export function calculateNews2(input: News2Input): ToolOutcome<News2Result> {
  const check = new InputCheck();
  const rr = check.number(
    "respirationRate",
    "Respiration rate",
    input.respirationRate,
    NEWS2_INPUT_LIMITS.respirationRate,
  );
  const spo2 = check.number("spo2", "SpO2", input.spo2, NEWS2_INPUT_LIMITS.spo2);
  const oxygen = check.present("supplementalOxygen", "Air or oxygen", input.supplementalOxygen);
  const sbp = check.number(
    "systolicBp",
    "Systolic blood pressure",
    input.systolicBp,
    NEWS2_INPUT_LIMITS.systolicBp,
  );
  const pulse = check.number("pulse", "Pulse", input.pulse, NEWS2_INPUT_LIMITS.pulse);
  const consciousness = check.option(
    "consciousness",
    "Consciousness",
    input.consciousness,
    Object.keys(CONSCIOUSNESS) as News2Consciousness[],
  );
  const temperature = check.number(
    "temperature",
    "Temperature",
    input.temperature,
    NEWS2_INPUT_LIMITS.temperature,
  );

  if (
    rr === undefined ||
    spo2 === undefined ||
    oxygen === undefined ||
    sbp === undefined ||
    pulse === undefined ||
    consciousness === undefined ||
    temperature === undefined
  ) {
    return check.failure();
  }

  const scale: 1 | 2 = input.spo2Scale2Decision ? 2 : 1;
  const temperatureTenths = Math.round(temperature * 10);
  const workings = [
    {
      item: "Respiration rate",
      value: `${rr} per minute`,
      points: pointsFor(RESPIRATION_RATE, rr),
    },
    {
      item: `SpO2 scale ${scale}`,
      value: `${spo2}%`,
      points: pointsFor(scale === 2 ? SPO2_SCALE_2 : SPO2_SCALE_1, spo2, oxygen),
    },
    {
      item: "Air or oxygen",
      value: oxygen ? "Oxygen" : "Air",
      points: oxygen ? AIR_OR_OXYGEN.oxygen : AIR_OR_OXYGEN.air,
    },
    { item: "Systolic blood pressure", value: `${sbp} mmHg`, points: pointsFor(SYSTOLIC_BP, sbp) },
    { item: "Pulse", value: `${pulse} per minute`, points: pointsFor(PULSE, pulse) },
    {
      item: "Consciousness",
      value: CONSCIOUSNESS[consciousness].label,
      points: CONSCIOUSNESS[consciousness].points,
    },
    {
      item: "Temperature",
      value: `${(temperatureTenths / 10).toFixed(1)}°C`,
      points: pointsFor(TEMPERATURE_TENTHS, temperatureTenths),
    },
  ];
  const score = workings.reduce((sum, w) => sum + w.points, 0);
  const redScore = workings.some((w) => w.points === 3);
  const threshold = thresholdFor(score, redScore);
  const published = RESPONSES[threshold];
  const triggers: CareTrigger[] = [
    { kind: "repeat_observations", frequency: published.monitoring },
  ];
  if (published.band !== "low") {
    const reason = `NEWS2 ${score}: ${published.clinicalRisk.toLowerCase()} clinical risk`;
    triggers.unshift(
      { kind: "urgent_alert", recipient: "nurse_in_charge", reason, code: "news2_threshold" },
      { kind: "task", task: "news2_response", reason },
    );
  }
  return {
    ok: true,
    result: {
      toolKey: "news2",
      toolVersion: NEWS2_TOOL_VERSION,
      score,
      band: published.band,
      workings,
      triggers,
      spo2Scale: scale,
      redScore,
      threshold,
      clinicalRisk: published.clinicalRisk,
      response: published.response,
      monitoring: published.monitoring,
      clinicalResponse: published.clinicalResponse,
    },
  };
}
