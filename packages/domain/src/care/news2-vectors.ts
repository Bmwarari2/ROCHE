/**
 * NEWS2 reference vectors (hazard HZ-012; clinical reviews C6 and round 3): fixed readings with the
 * points for every parameter, the total, the band and the RCP chart 4 threshold, worked out by hand
 * from the published chart 1 (the NEWS scoring system) and chart 2 (thresholds and triggers),
 * Royal College of Physicians, 2017.
 * https://www.rcp.ac.uk/improving-care/resources/national-early-warning-score-news-2/
 *
 * The expected values are never produced by `calculateNews2`: they are written down, so the
 * server's calculator (the domain tests) and the device's path from typed readings (the mobile
 * tests) are both checked against the published tool, not against each other. Each parameter's
 * points are checked, not only the total, so two errors cannot cancel out. The Clinical Safety
 * Officer spot-checks these vectors against chart 1 (human action H-129).
 */
import type { News2Band, News2Consciousness, News2ResponseThreshold } from "./news2";

/** Points per parameter, in chart 1's order. */
export interface News2Points {
  readonly respirationRate: number;
  readonly spo2: number;
  readonly airOrOxygen: number;
  readonly systolicBp: number;
  readonly pulse: number;
  readonly consciousness: number;
  readonly temperature: number;
}

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
    readonly points: News2Points;
    readonly score: number;
    readonly band: News2Band;
    readonly threshold: News2ResponseThreshold;
    readonly redScore: boolean;
  };
}

/** Reads a result's workings as points per parameter, to compare with a vector. */
export function news2PointsOf(
  workings: ReadonlyArray<{ readonly item: string; readonly points: number }>,
): News2Points {
  const find = (match: (item: string) => boolean) => {
    const working = workings.find((w) => match(w.item));
    if (!working) throw new Error("A NEWS2 parameter is missing from the workings.");
    return working.points;
  };
  return {
    respirationRate: find((i) => i === "Respiration rate"),
    spo2: find((i) => i.startsWith("SpO2")),
    airOrOxygen: find((i) => i === "Air or oxygen"),
    systolicBp: find((i) => i === "Systolic blood pressure"),
    pulse: find((i) => i === "Pulse"),
    consciousness: find((i) => i === "Consciousness"),
    temperature: find((i) => i === "Temperature"),
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

const ZERO: News2Points = {
  respirationRate: 0,
  spo2: 0,
  airOrOxygen: 0,
  systolicBp: 0,
  pulse: 0,
  consciousness: 0,
  temperature: 0,
};
const points = (overrides: Partial<News2Points>): News2Points => ({ ...ZERO, ...overrides });

export const NEWS2_REFERENCE_VECTORS: readonly News2ReferenceVector[] = [
  {
    // Every parameter in its 0 row.
    name: "all readings in the normal range",
    input: normal,
    expected: { points: ZERO, score: 0, band: "low", threshold: "score_0", redScore: false },
  },
  {
    // RR 21 (2) + SpO2 95 on scale 1 (1) + pulse 95 (1) = 4.
    name: "total 4 with no single 3",
    input: { ...normal, respirationRate: 21, spo2: 95, pulse: 95, temperature: 36.5 },
    expected: {
      points: points({ respirationRate: 2, spo2: 1, pulse: 1 }),
      score: 4,
      band: "low",
      threshold: "score_1_to_4",
      redScore: false,
    },
  },
  {
    // RR 8 (3), the rest 0: a single parameter scoring 3.
    name: "respiration rate 8 alone",
    input: { ...normal, respirationRate: 8 },
    expected: {
      points: points({ respirationRate: 3 }),
      score: 3,
      band: "low_medium",
      threshold: "single_parameter_3",
      redScore: true,
    },
  },
  {
    // RR 25 (3): the lowest rate in the top row.
    name: "respiration rate 25 alone",
    input: { ...normal, respirationRate: 25 },
    expected: {
      points: points({ respirationRate: 3 }),
      score: 3,
      band: "low_medium",
      threshold: "single_parameter_3",
      redScore: true,
    },
  },
  {
    // New confusion (3), the rest 0.
    name: "new confusion alone",
    input: { ...normal, consciousness: "new_confusion" },
    expected: {
      points: points({ consciousness: 3 }),
      score: 3,
      band: "low_medium",
      threshold: "single_parameter_3",
      redScore: true,
    },
  },
  {
    // RR 22 (2) + SpO2 94 (1) + systolic 100 (2) = 5.
    name: "total 5",
    input: { ...normal, respirationRate: 22, spo2: 94, systolicBp: 100 },
    expected: {
      points: points({ respirationRate: 2, spo2: 1, systolicBp: 2 }),
      score: 5,
      band: "medium",
      threshold: "score_5_or_more",
      redScore: false,
    },
  },
  {
    // RR 21 (2) + SpO2 92 (2) + systolic 101 (1) + pulse 91 (1) = 6.
    name: "total 6",
    input: { ...normal, respirationRate: 21, spo2: 92, systolicBp: 101, pulse: 91 },
    expected: {
      points: points({ respirationRate: 2, spo2: 2, systolicBp: 1, pulse: 1 }),
      score: 6,
      band: "medium",
      threshold: "score_5_or_more",
      redScore: false,
    },
  },
  {
    // Pulse 131 (3) + temperature 39.1 (2) = 5, which outranks the single 3.
    name: "total 5 including a single 3",
    input: { ...normal, pulse: 131, temperature: 39.1 },
    expected: {
      points: points({ pulse: 3, temperature: 2 }),
      score: 5,
      band: "medium",
      threshold: "score_5_or_more",
      redScore: true,
    },
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
    expected: {
      points: points({ respirationRate: 2, spo2: 2, airOrOxygen: 2, systolicBp: 1 }),
      score: 7,
      band: "high",
      threshold: "score_7_or_more",
      redScore: false,
    },
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
    expected: {
      points: {
        respirationRate: 2,
        spo2: 2,
        airOrOxygen: 2,
        systolicBp: 1,
        pulse: 2,
        consciousness: 3,
        temperature: 1,
      },
      score: 13,
      band: "high",
      threshold: "score_7_or_more",
      redScore: true,
    },
  },
  {
    // Systolic 220 (3): the lowest pressure in the top row.
    name: "systolic 220 alone",
    input: { ...normal, systolicBp: 220 },
    expected: {
      points: points({ systolicBp: 3 }),
      score: 3,
      band: "low_medium",
      threshold: "single_parameter_3",
      redScore: true,
    },
  },
  {
    // Systolic 219 (0): the highest pressure in the 0 row.
    name: "systolic 219 alone",
    input: { ...normal, systolicBp: 219 },
    expected: { points: ZERO, score: 0, band: "low", threshold: "score_0", redScore: false },
  },
  {
    // Temperature 35.1 (1): the lowest temperature in the 1 row.
    name: "temperature 35.1 alone",
    input: { ...normal, temperature: 35.1 },
    expected: {
      points: points({ temperature: 1 }),
      score: 1,
      band: "low",
      threshold: "score_1_to_4",
      redScore: false,
    },
  },
  {
    // Pulse 41 (1): the lowest pulse in the 1 row.
    name: "pulse 41 alone",
    input: { ...normal, pulse: 41 },
    expected: {
      points: points({ pulse: 1 }),
      score: 1,
      band: "low",
      threshold: "score_1_to_4",
      redScore: false,
    },
  },
  {
    // Pulse 50 (1): the highest pulse in the 1 row.
    name: "pulse 50 alone",
    input: { ...normal, pulse: 50 },
    expected: {
      points: points({ pulse: 1 }),
      score: 1,
      band: "low",
      threshold: "score_1_to_4",
      redScore: false,
    },
  },
  {
    // Temperature 35.0 (3) + systolic 90 (3) + pulse 40 (3) = 9.
    name: "low temperature, blood pressure and pulse",
    input: { ...normal, temperature: 35.0, systolicBp: 90, pulse: 40 },
    expected: {
      points: points({ temperature: 3, systolicBp: 3, pulse: 3 }),
      score: 9,
      band: "high",
      threshold: "score_7_or_more",
      redScore: true,
    },
  },
  {
    // SpO2 90 on air: scale 1 scores 3; scale 2 (88 to 92) scores 0.
    name: "SpO2 90 on air, scale 1",
    input: { ...normal, spo2: 90 },
    expected: {
      points: points({ spo2: 3 }),
      score: 3,
      band: "low_medium",
      threshold: "single_parameter_3",
      redScore: true,
    },
  },
  {
    name: "SpO2 90 on air, scale 2 recorded by a clinician",
    input: { ...normal, spo2: 90, spo2Scale2Decision: true },
    expected: { points: ZERO, score: 0, band: "low", threshold: "score_0", redScore: false },
  },
  {
    // Scale 2 on air: 93 or more scores 0.
    name: "SpO2 97 on air, scale 2",
    input: { ...normal, spo2: 97, spo2Scale2Decision: true },
    expected: { points: ZERO, score: 0, band: "low", threshold: "score_0", redScore: false },
  },
  {
    // Scale 2 on oxygen, the boundaries of chart 1's oxygen rows: 88 to 92 scores 0 (+ oxygen 2).
    name: "SpO2 92 on oxygen, scale 2",
    input: { ...normal, spo2: 92, supplementalOxygen: true, spo2Scale2Decision: true },
    expected: {
      points: points({ spo2: 0, airOrOxygen: 2 }),
      score: 2,
      band: "low",
      threshold: "score_1_to_4",
      redScore: false,
    },
  },
  {
    // Scale 2 on oxygen: 93 to 94 scores 1 (+ oxygen 2).
    name: "SpO2 93 on oxygen, scale 2",
    input: { ...normal, spo2: 93, supplementalOxygen: true, spo2Scale2Decision: true },
    expected: {
      points: points({ spo2: 1, airOrOxygen: 2 }),
      score: 3,
      band: "low",
      threshold: "score_1_to_4",
      redScore: false,
    },
  },
  {
    name: "SpO2 94 on oxygen, scale 2",
    input: { ...normal, spo2: 94, supplementalOxygen: true, spo2Scale2Decision: true },
    expected: {
      points: points({ spo2: 1, airOrOxygen: 2 }),
      score: 3,
      band: "low",
      threshold: "score_1_to_4",
      redScore: false,
    },
  },
  {
    // Scale 2 on oxygen: 95 to 96 scores 2 (+ oxygen 2).
    name: "SpO2 95 on oxygen, scale 2",
    input: { ...normal, spo2: 95, supplementalOxygen: true, spo2Scale2Decision: true },
    expected: {
      points: points({ spo2: 2, airOrOxygen: 2 }),
      score: 4,
      band: "low",
      threshold: "score_1_to_4",
      redScore: false,
    },
  },
  {
    name: "SpO2 96 on oxygen, scale 2",
    input: { ...normal, spo2: 96, supplementalOxygen: true, spo2Scale2Decision: true },
    expected: {
      points: points({ spo2: 2, airOrOxygen: 2 }),
      score: 4,
      band: "low",
      threshold: "score_1_to_4",
      redScore: false,
    },
  },
  {
    // Scale 2 on oxygen: 97 or more scores 3, oxygen scores 2: 5.
    name: "SpO2 97 on oxygen, scale 2",
    input: { ...normal, spo2: 97, supplementalOxygen: true, spo2Scale2Decision: true },
    expected: {
      points: points({ spo2: 3, airOrOxygen: 2 }),
      score: 5,
      band: "medium",
      threshold: "score_5_or_more",
      redScore: true,
    },
  },
  {
    // Scale 2: 83 or less scores 3. (Clinical review round 4 boundary.)
    name: "SpO2 83 on air, scale 2",
    input: { ...normal, spo2: 83, spo2Scale2Decision: true },
    expected: {
      points: points({ spo2: 3 }),
      score: 3,
      band: "low_medium",
      threshold: "single_parameter_3",
      redScore: true,
    },
  },
  {
    // Scale 2: 84 to 85 scores 2. (Clinical review round 4 boundary.)
    name: "SpO2 84 on air, scale 2",
    input: { ...normal, spo2: 84, spo2Scale2Decision: true },
    expected: {
      points: points({ spo2: 2 }),
      score: 2,
      band: "low",
      threshold: "score_1_to_4",
      redScore: false,
    },
  },
  {
    // Scale 2: 84 to 85 scores 2. (Clinical review round 4 boundary.)
    name: "SpO2 85 on air, scale 2",
    input: { ...normal, spo2: 85, spo2Scale2Decision: true },
    expected: {
      points: points({ spo2: 2 }),
      score: 2,
      band: "low",
      threshold: "score_1_to_4",
      redScore: false,
    },
  },
  {
    // Scale 2: 86 to 87 scores 1. (Clinical review round 4 boundary.)
    name: "SpO2 86 on air, scale 2",
    input: { ...normal, spo2: 86, spo2Scale2Decision: true },
    expected: {
      points: points({ spo2: 1 }),
      score: 1,
      band: "low",
      threshold: "score_1_to_4",
      redScore: false,
    },
  },
  {
    // Scale 2: 86 to 87 scores 1. (Clinical review round 4 boundary.)
    name: "SpO2 87 on air, scale 2",
    input: { ...normal, spo2: 87, spo2Scale2Decision: true },
    expected: {
      points: points({ spo2: 1 }),
      score: 1,
      band: "low",
      threshold: "score_1_to_4",
      redScore: false,
    },
  },
  {
    // RR 9 to 11 scores 1. (Clinical review round 4 boundary.)
    name: "respiration rate 9 alone",
    input: { ...normal, respirationRate: 9 },
    expected: {
      points: points({ respirationRate: 1 }),
      score: 1,
      band: "low",
      threshold: "score_1_to_4",
      redScore: false,
    },
  },
  {
    // RR 9 to 11 scores 1. (Clinical review round 4 boundary.)
    name: "respiration rate 11 alone",
    input: { ...normal, respirationRate: 11 },
    expected: {
      points: points({ respirationRate: 1 }),
      score: 1,
      band: "low",
      threshold: "score_1_to_4",
      redScore: false,
    },
  },
  {
    // RR 12 to 20 scores 0. (Clinical review round 4 boundary.)
    name: "respiration rate 12 alone",
    input: { ...normal, respirationRate: 12 },
    expected: {
      points: ZERO,
      score: 0,
      band: "low",
      threshold: "score_0",
      redScore: false,
    },
  },
  {
    // RR 12 to 20 scores 0. (Clinical review round 4 boundary.)
    name: "respiration rate 20 alone",
    input: { ...normal, respirationRate: 20 },
    expected: {
      points: ZERO,
      score: 0,
      band: "low",
      threshold: "score_0",
      redScore: false,
    },
  },
  {
    // Pulse 51 to 90 scores 0. (Clinical review round 4 boundary.)
    name: "pulse 51 alone",
    input: { ...normal, pulse: 51 },
    expected: {
      points: ZERO,
      score: 0,
      band: "low",
      threshold: "score_0",
      redScore: false,
    },
  },
  {
    // Pulse 51 to 90 scores 0. (Clinical review round 4 boundary.)
    name: "pulse 90 alone",
    input: { ...normal, pulse: 90 },
    expected: {
      points: ZERO,
      score: 0,
      band: "low",
      threshold: "score_0",
      redScore: false,
    },
  },
  {
    // Pulse 91 to 110 scores 1. (Clinical review round 4 boundary.)
    name: "pulse 110 alone",
    input: { ...normal, pulse: 110 },
    expected: {
      points: points({ pulse: 1 }),
      score: 1,
      band: "low",
      threshold: "score_1_to_4",
      redScore: false,
    },
  },
  {
    // Pulse 111 to 130 scores 2. (Clinical review round 4 boundary.)
    name: "pulse 111 alone",
    input: { ...normal, pulse: 111 },
    expected: {
      points: points({ pulse: 2 }),
      score: 2,
      band: "low",
      threshold: "score_1_to_4",
      redScore: false,
    },
  },
  {
    // Pulse 111 to 130 scores 2. (Clinical review round 4 boundary.)
    name: "pulse 130 alone",
    input: { ...normal, pulse: 130 },
    expected: {
      points: points({ pulse: 2 }),
      score: 2,
      band: "low",
      threshold: "score_1_to_4",
      redScore: false,
    },
  },
  {
    // Temperature 35.1 to 36.0 scores 1. (Clinical review round 4 boundary.)
    name: "temperature 36.0 alone",
    input: { ...normal, temperature: 36.0 },
    expected: {
      points: points({ temperature: 1 }),
      score: 1,
      band: "low",
      threshold: "score_1_to_4",
      redScore: false,
    },
  },
  {
    // Temperature 36.1 to 38.0 scores 0. (Clinical review round 4 boundary.)
    name: "temperature 36.1 alone",
    input: { ...normal, temperature: 36.1 },
    expected: {
      points: ZERO,
      score: 0,
      band: "low",
      threshold: "score_0",
      redScore: false,
    },
  },
  {
    // Temperature 36.1 to 38.0 scores 0. (Clinical review round 4 boundary.)
    name: "temperature 38.0 alone",
    input: { ...normal, temperature: 38.0 },
    expected: {
      points: ZERO,
      score: 0,
      band: "low",
      threshold: "score_0",
      redScore: false,
    },
  },
  {
    // Temperature 38.1 to 39.0 scores 1. (Clinical review round 4 boundary.)
    name: "temperature 38.1 alone",
    input: { ...normal, temperature: 38.1 },
    expected: {
      points: points({ temperature: 1 }),
      score: 1,
      band: "low",
      threshold: "score_1_to_4",
      redScore: false,
    },
  },
  {
    // Temperature 38.1 to 39.0 scores 1. (Clinical review round 4 boundary.)
    name: "temperature 39.0 alone",
    input: { ...normal, temperature: 39.0 },
    expected: {
      points: points({ temperature: 1 }),
      score: 1,
      band: "low",
      threshold: "score_1_to_4",
      redScore: false,
    },
  },
];
