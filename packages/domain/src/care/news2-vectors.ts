/**
 * NEWS2 reference vectors (hazard HZ-012; clinical review C6): fixed readings with the total, band
 * and RCP chart 4 threshold worked out by hand from the published chart 1 (the NEWS scoring
 * system) and chart 2 (thresholds and triggers), Royal College of Physicians, 2017.
 * https://www.rcp.ac.uk/improving-care/resources/national-early-warning-score-news-2/
 *
 * The expected values are never produced by `calculateNews2`: they are written down, with the
 * points per parameter in the comment, so the server's calculator (the domain tests) and the
 * device's path from typed readings (the mobile tests) are both checked against the published
 * tool, not against each other.
 */
import type { News2Band, News2Consciousness, News2ResponseThreshold } from "./news2";

export interface News2ReferenceVector {
  readonly name: string;
  readonly input: {
    readonly respirationRate: number;
    readonly spo2: number;
    readonly supplementalOxygen: boolean;
    readonly systolicBp: number;
    readonly pulse: number;
    readonly consciousness: News2Consciousness;
    readonly temperature: number;
    readonly spo2Scale2Decision: boolean;
  };
  readonly expected: {
    readonly score: number;
    readonly band: News2Band;
    readonly threshold: News2ResponseThreshold;
    readonly redScore: boolean;
  };
}

const normal = {
  respirationRate: 16,
  spo2: 97,
  supplementalOxygen: false,
  systolicBp: 120,
  pulse: 70,
  consciousness: "alert" as const,
  temperature: 37.0,
  spo2Scale2Decision: false,
};

export const NEWS2_REFERENCE_VECTORS: readonly News2ReferenceVector[] = [
  {
    // Every parameter in its 0 row.
    name: "all readings in the normal range",
    input: normal,
    expected: { score: 0, band: "low", threshold: "score_0", redScore: false },
  },
  {
    // RR 21 (2) + SpO2 95 on scale 1 (1) + pulse 95 (1) = 4.
    name: "total 4 with no single 3",
    input: { ...normal, respirationRate: 21, spo2: 95, pulse: 95, temperature: 36.5 },
    expected: { score: 4, band: "low", threshold: "score_1_to_4", redScore: false },
  },
  {
    // RR 8 (3), the rest 0: a single parameter scoring 3.
    name: "respiration rate 8 alone",
    input: { ...normal, respirationRate: 8 },
    expected: { score: 3, band: "low_medium", threshold: "single_parameter_3", redScore: true },
  },
  {
    // New confusion (3), the rest 0.
    name: "new confusion alone",
    input: { ...normal, consciousness: "new_confusion" },
    expected: { score: 3, band: "low_medium", threshold: "single_parameter_3", redScore: true },
  },
  {
    // RR 22 (2) + SpO2 94 (1) + systolic 100 (2) = 5.
    name: "total 5",
    input: { ...normal, respirationRate: 22, spo2: 94, systolicBp: 100 },
    expected: { score: 5, band: "medium", threshold: "score_5_or_more", redScore: false },
  },
  {
    // RR 21 (2) + SpO2 92 (2) + systolic 101 (1) + pulse 91 (1) = 6.
    name: "total 6",
    input: { ...normal, respirationRate: 21, spo2: 92, systolicBp: 101, pulse: 91 },
    expected: { score: 6, band: "medium", threshold: "score_5_or_more", redScore: false },
  },
  {
    // Pulse 131 (3) + temperature 39.1 (2) = 5, which outranks the single 3.
    name: "total 5 including a single 3",
    input: { ...normal, pulse: 131, temperature: 39.1 },
    expected: { score: 5, band: "medium", threshold: "score_5_or_more", redScore: true },
  },
  {
    // RR 24 (2) + SpO2 93 (2) + oxygen (2) + systolic 110 (1) = 7.
    name: "total 7 on oxygen",
    input: {
      ...normal,
      respirationRate: 24,
      spo2: 93,
      supplementalOxygen: true,
      systolicBp: 110,
      pulse: 60,
    },
    expected: { score: 7, band: "high", threshold: "score_7_or_more", redScore: false },
  },
  {
    // RR 23 (2) + SpO2 93 (2) + oxygen (2) + systolic 105 (1) + pulse 112 (2) + voice (3)
    // + temperature 38.6 (1) = 13.
    name: "total 13",
    input: {
      respirationRate: 23,
      spo2: 93,
      supplementalOxygen: true,
      systolicBp: 105,
      pulse: 112,
      consciousness: "voice",
      temperature: 38.6,
      spo2Scale2Decision: false,
    },
    expected: { score: 13, band: "high", threshold: "score_7_or_more", redScore: true },
  },
  {
    // SpO2 90 on air: scale 1 scores 3; scale 2 (88 to 92) scores 0.
    name: "SpO2 90 on air, scale 1",
    input: { ...normal, spo2: 90 },
    expected: { score: 3, band: "low_medium", threshold: "single_parameter_3", redScore: true },
  },
  {
    name: "SpO2 90 on air, scale 2 recorded by a clinician",
    input: { ...normal, spo2: 90, spo2Scale2Decision: true },
    expected: { score: 0, band: "low", threshold: "score_0", redScore: false },
  },
  {
    // Scale 2 on oxygen: SpO2 97 or more scores 3, oxygen scores 2: 5.
    name: "SpO2 97 on oxygen, scale 2",
    input: { ...normal, spo2: 97, supplementalOxygen: true, spo2Scale2Decision: true },
    expected: { score: 5, band: "medium", threshold: "score_5_or_more", redScore: true },
  },
  {
    // Temperature 35.0 (3) + systolic 90 (3) + pulse 40 (3) = 9.
    name: "low temperature, blood pressure and pulse",
    input: { ...normal, temperature: 35.0, systolicBp: 90, pulse: 40 },
    expected: { score: 9, band: "high", threshold: "score_7_or_more", redScore: true },
  },
];
