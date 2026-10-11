import { describe, expect, it } from "vitest";
import { calculateNews2, NEWS2_TOOL_VERSION, type News2Input, type News2Result } from "./news2";
import { NEWS2_REFERENCE_VECTORS, news2PointsOf } from "./news2-vectors";

describe("hazard HZ-012 NEWS2 matches the reference vectors worked by hand from RCP chart 1", () => {
  it.each(NEWS2_REFERENCE_VECTORS.map((v) => [v.name, v] as const))("%s", (_name, vector) => {
    const outcome = calculateNews2(vector.input);
    if (!outcome.ok) throw new Error(outcome.message);
    expect({
      points: news2PointsOf(outcome.result.workings),
      score: outcome.result.score,
      band: outcome.result.band,
      threshold: outcome.result.threshold,
      redScore: outcome.result.redScore,
    }).toEqual(vector.expected);
  });

  it("covers every band and every chart 4 threshold", () => {
    const thresholds = new Set(NEWS2_REFERENCE_VECTORS.map((v) => v.expected.threshold));
    expect([...thresholds].sort()).toEqual([
      "score_0",
      "score_1_to_4",
      "score_5_or_more",
      "score_7_or_more",
      "single_parameter_3",
    ]);
  });
});

/**
 * NEWS2 against RCP 2017 charts 1, 2 and 4 (hazards HZ-012 and HZ-014). Every band boundary is
 * tested on both sides. The baseline scores 0 on every parameter.
 */

const NORMAL: News2Input = {
  respirationRate: 16,
  spo2: 97,
  supplementalOxygen: false,
  systolicBp: 120,
  pulse: 70,
  consciousness: "alert",
  temperature: 37.0,
  spo2Scale2Decision: false,
};

function scored(input: Partial<News2Input>): News2Result {
  const outcome = calculateNews2({ ...NORMAL, ...input });
  if (!outcome.ok) throw new Error(outcome.message);
  return outcome.result;
}

function pointsFor(result: News2Result, itemStart: string): number {
  const working = result.workings.find((w) => w.item.startsWith(itemStart));
  if (!working) throw new Error(`no working for ${itemStart}`);
  return working.points;
}

describe("hazard HZ-012 NEWS2 scores every parameter band boundary as published by the RCP", () => {
  it.each([
    // Respiration rate: <=8 3; 9-11 1; 12-20 0; 21-24 2; >=25 3.
    ["Respiration rate", { respirationRate: 1 }, 3],
    ["Respiration rate", { respirationRate: 8 }, 3],
    ["Respiration rate", { respirationRate: 9 }, 1],
    ["Respiration rate", { respirationRate: 11 }, 1],
    ["Respiration rate", { respirationRate: 12 }, 0],
    ["Respiration rate", { respirationRate: 20 }, 0],
    ["Respiration rate", { respirationRate: 21 }, 2],
    ["Respiration rate", { respirationRate: 24 }, 2],
    ["Respiration rate", { respirationRate: 25 }, 3],
    ["Respiration rate", { respirationRate: 80 }, 3],
    // SpO2 scale 1: <=91 3; 92-93 2; 94-95 1; >=96 0.
    ["SpO2 scale 1", { spo2: 50 }, 3],
    ["SpO2 scale 1", { spo2: 91 }, 3],
    ["SpO2 scale 1", { spo2: 92 }, 2],
    ["SpO2 scale 1", { spo2: 93 }, 2],
    ["SpO2 scale 1", { spo2: 94 }, 1],
    ["SpO2 scale 1", { spo2: 95 }, 1],
    ["SpO2 scale 1", { spo2: 96 }, 0],
    ["SpO2 scale 1", { spo2: 100 }, 0],
    ["SpO2 scale 1 on oxygen", { spo2: 91, supplementalOxygen: true }, 3],
    ["SpO2 scale 1 on oxygen", { spo2: 100, supplementalOxygen: true }, 0],
    // SpO2 scale 2: <=83 3; 84-85 2; 86-87 1; 88-92 or >=93 on air 0; 93-94 O2 1; 95-96 O2 2; >=97 O2 3.
    ["SpO2 scale 2", { spo2Scale2Decision: true, spo2: 83 }, 3],
    ["SpO2 scale 2", { spo2Scale2Decision: true, spo2: 84 }, 2],
    ["SpO2 scale 2", { spo2Scale2Decision: true, spo2: 85 }, 2],
    ["SpO2 scale 2", { spo2Scale2Decision: true, spo2: 86 }, 1],
    ["SpO2 scale 2", { spo2Scale2Decision: true, spo2: 87 }, 1],
    ["SpO2 scale 2", { spo2Scale2Decision: true, spo2: 88 }, 0],
    ["SpO2 scale 2", { spo2Scale2Decision: true, spo2: 92 }, 0],
    ["SpO2 scale 2 on air", { spo2Scale2Decision: true, spo2: 93 }, 0],
    ["SpO2 scale 2 on air", { spo2Scale2Decision: true, spo2: 100 }, 0],
    ["SpO2 scale 2 on oxygen", { spo2Scale2Decision: true, supplementalOxygen: true, spo2: 83 }, 3],
    ["SpO2 scale 2 on oxygen", { spo2Scale2Decision: true, supplementalOxygen: true, spo2: 84 }, 2],
    ["SpO2 scale 2 on oxygen", { spo2Scale2Decision: true, supplementalOxygen: true, spo2: 87 }, 1],
    ["SpO2 scale 2 on oxygen", { spo2Scale2Decision: true, supplementalOxygen: true, spo2: 88 }, 0],
    ["SpO2 scale 2 on oxygen", { spo2Scale2Decision: true, supplementalOxygen: true, spo2: 92 }, 0],
    ["SpO2 scale 2 on oxygen", { spo2Scale2Decision: true, supplementalOxygen: true, spo2: 93 }, 1],
    ["SpO2 scale 2 on oxygen", { spo2Scale2Decision: true, supplementalOxygen: true, spo2: 94 }, 1],
    ["SpO2 scale 2 on oxygen", { spo2Scale2Decision: true, supplementalOxygen: true, spo2: 95 }, 2],
    ["SpO2 scale 2 on oxygen", { spo2Scale2Decision: true, supplementalOxygen: true, spo2: 96 }, 2],
    ["SpO2 scale 2 on oxygen", { spo2Scale2Decision: true, supplementalOxygen: true, spo2: 97 }, 3],
    [
      "SpO2 scale 2 on oxygen",
      { spo2Scale2Decision: true, supplementalOxygen: true, spo2: 100 },
      3,
    ],
    // Air or oxygen: oxygen 2; air 0.
    ["Air or oxygen", { supplementalOxygen: false }, 0],
    ["Air or oxygen", { supplementalOxygen: true }, 2],
    // Systolic blood pressure: <=90 3; 91-100 2; 101-110 1; 111-219 0; >=220 3.
    ["Systolic blood pressure", { systolicBp: 30 }, 3],
    ["Systolic blood pressure", { systolicBp: 90 }, 3],
    ["Systolic blood pressure", { systolicBp: 91 }, 2],
    ["Systolic blood pressure", { systolicBp: 100 }, 2],
    ["Systolic blood pressure", { systolicBp: 101 }, 1],
    ["Systolic blood pressure", { systolicBp: 110 }, 1],
    ["Systolic blood pressure", { systolicBp: 111 }, 0],
    ["Systolic blood pressure", { systolicBp: 219 }, 0],
    ["Systolic blood pressure", { systolicBp: 220 }, 3],
    ["Systolic blood pressure", { systolicBp: 300 }, 3],
    // Pulse: <=40 3; 41-50 1; 51-90 0; 91-110 1; 111-130 2; >=131 3.
    ["Pulse", { pulse: 20 }, 3],
    ["Pulse", { pulse: 40 }, 3],
    ["Pulse", { pulse: 41 }, 1],
    ["Pulse", { pulse: 50 }, 1],
    ["Pulse", { pulse: 51 }, 0],
    ["Pulse", { pulse: 90 }, 0],
    ["Pulse", { pulse: 91 }, 1],
    ["Pulse", { pulse: 110 }, 1],
    ["Pulse", { pulse: 111 }, 2],
    ["Pulse", { pulse: 130 }, 2],
    ["Pulse", { pulse: 131 }, 3],
    ["Pulse", { pulse: 300 }, 3],
    // Consciousness: alert 0; new confusion, voice, pain or unresponsive 3.
    ["Consciousness", { consciousness: "alert" }, 0],
    ["Consciousness", { consciousness: "new_confusion" }, 3],
    ["Consciousness", { consciousness: "voice" }, 3],
    ["Consciousness", { consciousness: "pain" }, 3],
    ["Consciousness", { consciousness: "unresponsive" }, 3],
    // Temperature: <=35.0 3; 35.1-36.0 1; 36.1-38.0 0; 38.1-39.0 1; >=39.1 2.
    ["Temperature", { temperature: 20.0 }, 3],
    ["Temperature", { temperature: 35.0 }, 3],
    ["Temperature", { temperature: 35.1 }, 1],
    ["Temperature", { temperature: 36.0 }, 1],
    ["Temperature", { temperature: 36.1 }, 0],
    ["Temperature", { temperature: 38.0 }, 0],
    ["Temperature", { temperature: 38.1 }, 1],
    ["Temperature", { temperature: 39.0 }, 1],
    ["Temperature", { temperature: 39.1 }, 2],
    ["Temperature", { temperature: 45.0 }, 2],
  ] as const)("%s %o scores %i", (item, input, points) => {
    const result = scored(input);
    expect(pointsFor(result, item.replace(/ on (air|oxygen)$/, ""))).toBe(points);
  });

  it("sums the seven parameter scores and stores the tool version with the workings", () => {
    const result = scored({
      respirationRate: 22,
      spo2: 95,
      supplementalOxygen: true,
      systolicBp: 105,
      pulse: 112,
      consciousness: "alert",
      temperature: 38.4,
    });
    expect(result.workings).toEqual([
      { item: "Respiration rate", value: "22 per minute", points: 2 },
      { item: "SpO2 scale 1", value: "95%", points: 1 },
      { item: "Air or oxygen", value: "Oxygen", points: 2 },
      { item: "Systolic blood pressure", value: "105 mmHg", points: 1 },
      { item: "Pulse", value: "112 per minute", points: 2 },
      { item: "Consciousness", value: "Alert", points: 0 },
      { item: "Temperature", value: "38.4°C", points: 1 },
    ]);
    expect(result.score).toBe(9);
    expect(result.toolKey).toBe("news2");
    expect(result.toolVersion).toBe(NEWS2_TOOL_VERSION);
  });
});

describe("hazard HZ-012 NEWS2 adds 2 for supplemental oxygen and scores new confusion as published", () => {
  it("adds 2 when the person is on oxygen and nothing else changes", () => {
    expect(scored({ supplementalOxygen: false }).score).toBe(0);
    expect(scored({ supplementalOxygen: true }).score).toBe(2);
  });

  it("scores new confusion 3, the same as voice, pain or unresponsive", () => {
    const result = scored({ consciousness: "new_confusion" });
    expect(result.score).toBe(3);
    expect(result.redScore).toBe(true);
    expect(result.workings.find((w) => w.item === "Consciousness")?.value).toBe("New confusion");
  });
});

describe("hazard HZ-012 NEWS2 applies SpO2 Scale 2 only when a clinician decision is recorded", () => {
  it.each([
    ["90% on air without a decision uses scale 1", 90, false, false, 1, 3],
    ["90% on air with a decision uses scale 2", 90, false, true, 2, 0],
    ["97% on oxygen without a decision uses scale 1", 97, true, false, 1, 0],
    ["97% on oxygen with a decision uses scale 2", 97, true, true, 2, 3],
  ] as const)("%s", (_name, spo2, supplementalOxygen, spo2Scale2Decision, scale, points) => {
    const result = scored({ spo2, supplementalOxygen, spo2Scale2Decision });
    expect(result.spo2Scale).toBe(scale);
    expect(pointsFor(result, `SpO2 scale ${scale}`)).toBe(points);
  });
});

describe("hazard HZ-012 NEWS2 returns incomplete when any parameter is missing", () => {
  it.each([
    "respirationRate",
    "spo2",
    "supplementalOxygen",
    "systolicBp",
    "pulse",
    "consciousness",
    "temperature",
  ] as const)("no total without %s", (item) => {
    const outcome = calculateNews2({ ...NORMAL, [item]: null });
    expect(outcome).toMatchObject({
      ok: false,
      code: "incomplete",
      message: "Score incomplete: 1 value missing.",
      issues: [{ item, problem: "missing" }],
    });
    expect(outcome).not.toHaveProperty("result");
  });

  it("counts every missing value", () => {
    const outcome = calculateNews2({ spo2Scale2Decision: false, respirationRate: 18 });
    expect(outcome).toMatchObject({ ok: false, message: "Score incomplete: 6 values missing." });
  });

  it("reports missing values ahead of values that need checking", () => {
    const outcome = calculateNews2({ ...NORMAL, pulse: null, temperature: 37.25 });
    expect(outcome).toMatchObject({ ok: false, code: "incomplete" });
    expect(outcome.ok ? [] : outcome.issues.map((i) => i.problem)).toEqual([
      "missing",
      "too_many_decimal_places",
    ]);
  });
});

describe("hazard HZ-012 NEWS2 refuses impossible or malformed values rather than scoring them", () => {
  it.each([
    ["a fractional respiration rate", { respirationRate: 16.5 }, "not_a_whole_number"],
    ["a fractional SpO2", { spo2: 96.5 }, "not_a_whole_number"],
    ["a fractional pulse", { pulse: 70.2 }, "not_a_whole_number"],
    ["a temperature to two decimal places", { temperature: 37.25 }, "too_many_decimal_places"],
    ["SpO2 over 100%", { spo2: 101 }, "out_of_range"],
    ["a respiration rate of 0", { respirationRate: 0 }, "out_of_range"],
    ["a pulse of 0", { pulse: 0 }, "out_of_range"],
    ["a systolic pressure of 1200", { systolicBp: 1200 }, "out_of_range"],
    ["a temperature in Fahrenheit", { temperature: 98.6 }, "out_of_range"],
    ["a temperature that is not a number", { temperature: Number.NaN }, "out_of_range"],
    ["an unpublished consciousness level", { consciousness: "drowsy" as never }, "not_allowed"],
  ] as const)("refuses %s", (_name, input, problem) => {
    const outcome = calculateNews2({ ...NORMAL, ...input });
    expect(outcome).toMatchObject({
      ok: false,
      code: "invalid",
      message: "Score not calculated: 1 value needs checking.",
      issues: [{ problem }],
    });
  });

  it("names every value that needs checking", () => {
    const outcome = calculateNews2({ ...NORMAL, spo2: 101, pulse: 0.5 });
    expect(outcome).toMatchObject({
      ok: false,
      message: "Score not calculated: 2 values need checking.",
    });
  });
});

describe("hazard HZ-012 NEWS2 clinical risk follows RCP chart 2 at every threshold", () => {
  it.each([
    ["aggregate 0", {}, 0, "low", "score_0", "Low"],
    ["aggregate 1", { pulse: 95 }, 1, "low", "score_1_to_4", "Low"],
    ["aggregate 4", { respirationRate: 21, pulse: 111 }, 4, "low", "score_1_to_4", "Low"],
    [
      "a single 3, aggregate 3",
      { consciousness: "voice" },
      3,
      "low_medium",
      "single_parameter_3",
      "Low–medium",
    ],
    [
      "a single 3, aggregate 4",
      { systolicBp: 90, temperature: 38.5 },
      4,
      "low_medium",
      "single_parameter_3",
      "Low–medium",
    ],
    [
      "aggregate 5 without a single 3",
      { respirationRate: 21, pulse: 111, temperature: 38.5 },
      5,
      "medium",
      "score_5_or_more",
      "Medium",
    ],
    [
      "aggregate 5 with a single 3",
      { respirationRate: 21, consciousness: "pain" },
      5,
      "medium",
      "score_5_or_more",
      "Medium",
    ],
    [
      "aggregate 6",
      { respirationRate: 21, pulse: 111, supplementalOxygen: true },
      6,
      "medium",
      "score_5_or_more",
      "Medium",
    ],
    [
      "aggregate 7",
      { respirationRate: 25, pulse: 111, supplementalOxygen: true },
      7,
      "high",
      "score_7_or_more",
      "High",
    ],
    [
      "aggregate 20, the maximum",
      {
        respirationRate: 30,
        spo2: 88,
        supplementalOxygen: true,
        systolicBp: 80,
        pulse: 140,
        consciousness: "unresponsive",
        temperature: 34.0,
      },
      20,
      "high",
      "score_7_or_more",
      "High",
    ],
  ] as const)("%s", (_name, input, score, band, threshold, clinicalRisk) => {
    const result = scored(input);
    expect(result.score).toBe(score);
    expect(result.band).toBe(band);
    expect(result.threshold).toBe(threshold);
    expect(result.clinicalRisk).toBe(clinicalRisk);
  });

  it("returns the RCP chart 2 and chart 4 wording, not Harbour advice", () => {
    const high = scored({ respirationRate: 25, pulse: 111, supplementalOxygen: true });
    expect(high.response).toBe("Urgent or emergency response");
    expect(high.monitoring).toEqual({
      kind: "continuous",
      text: "Continuous monitoring of vital signs",
    });
    expect(high.clinicalResponse[0]).toBe(
      "Registered nurse to immediately inform the medical team caring for the patient – this should be at least at specialist registrar level",
    );
    expect(scored({}).clinicalResponse).toEqual(["Continue routine NEWS monitoring"]);
    expect(scored({ consciousness: "voice" }).response).toBe("Urgent ward-based response");
    expect(scored({ respirationRate: 21, pulse: 111, temperature: 38.5 }).response).toBe(
      "Key threshold for urgent response",
    );
  });
});

describe("hazard HZ-014 NEWS2 bands that call for a response raise a task and an urgent alert", () => {
  it.each([
    ["aggregate 0", {}, false, "Minimum 12 hourly", 12],
    ["aggregate 1 to 4", { pulse: 95 }, false, "Minimum 4–6 hourly", 6],
    [
      "a single parameter scoring 3",
      { consciousness: "new_confusion" },
      true,
      "Minimum 1 hourly",
      1,
    ],
    [
      "aggregate 5 to 6",
      { respirationRate: 21, pulse: 111, temperature: 38.5 },
      true,
      "Minimum 1 hourly",
      1,
    ],
  ] as const)("%s", (_name, input, urgent, text, longestHours) => {
    const result = scored(input);
    const kinds = result.triggers.map((t) => t.kind);
    expect(kinds.includes("urgent_alert")).toBe(urgent);
    expect(result.triggers.some((t) => t.kind === "task" && t.task === "news2_response")).toBe(
      urgent,
    );
    expect(result.triggers).toContainEqual({
      kind: "repeat_observations",
      frequency: expect.objectContaining({ kind: "interval", text, longestHours }),
    });
  });

  it("alerts the nurse in charge for aggregate 7 or more and asks for continuous monitoring", () => {
    const result = scored({ respirationRate: 25, pulse: 111, supplementalOxygen: true });
    expect(result.triggers).toEqual([
      {
        kind: "urgent_alert",
        recipient: "nurse_in_charge",
        reason: "NEWS2 7: high clinical risk",
      },
      { kind: "task", task: "news2_response", reason: "NEWS2 7: high clinical risk" },
      {
        kind: "repeat_observations",
        frequency: { kind: "continuous", text: "Continuous monitoring of vital signs" },
      },
    ]);
  });
});
