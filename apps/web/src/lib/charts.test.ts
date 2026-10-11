import { createTranslator } from "@harbour/i18n";
import { describe, expect, it } from "vitest";
import {
  fluidDayView,
  iddsiOutcome,
  isChart,
  news2Chip,
  news2FromFlags,
  observationSummary,
  readWorkings,
} from "./charts";

const t = createTranslator("en-GB");

/** The flags the API stores with a vital signs entry (apps/api/src/routes/care.ts). */
const storedNews2 = {
  news2: {
    toolVersion: "rcp-2017",
    score: 6,
    band: "medium",
    redScore: false,
    spo2Scale: 1,
    clinicalRisk: "Medium",
    response: "Key threshold for urgent response",
    monitoring: "Minimum 1 hourly",
    workings: [
      { item: "Respiration rate", value: "22 per minute", points: 2 },
      { item: "broken row", points: "2" },
    ],
  },
};

describe("NEWS2 from the API (never scored in the web app)", () => {
  it("hazard HZ-014 reads the score, band and the RCP's response wording as stored", () => {
    const news2 = news2FromFlags(storedNews2);
    expect(news2).toMatchObject({
      score: 6,
      band: "medium",
      clinicalRisk: "Medium",
      response: "Key threshold for urgent response",
      monitoring: "Minimum 1 hourly",
      spo2Scale: 1,
    });
    expect(news2?.workings).toEqual([
      { item: "Respiration rate", value: "22 per minute", points: 2 },
    ]);
  });

  it("gives nothing rather than a guess when no result was stored", () => {
    expect(news2FromFlags({})).toBeNull();
    expect(news2FromFlags({ news2: { score: "6" } })).toBeNull();
    expect(news2FromFlags({ news2: [] })).toBeNull();
    expect(readWorkings("x")).toEqual([]);
  });

  it("shows medium and high results as the strongest chip, and a single 3 as a warning", () => {
    expect(news2Chip("high")).toBe("overdue");
    expect(news2Chip("medium")).toBe("overdue");
    expect(news2Chip("low_medium")).toBe("due");
    expect(news2Chip("low")).toBe("neutral");
  });

  it("summarises a vital signs entry with the API's response", () => {
    expect(observationSummary({ chart: "vitals", values: {}, flags: storedNews2 }, t)).toEqual([
      "NEWS2 6: Key threshold for urgent response",
    ]);
    expect(observationSummary({ chart: "vitals", values: {}, flags: {} }, t)).toEqual([
      "Vital signs, no NEWS2 result stored",
    ]);
  });
});

describe("fluid balance day", () => {
  const day = {
    date: "2026-10-11",
    intakeMl: 900,
    outputMl: 400,
    targetMl: 1500,
    shortfallMl: 600,
    entries: 5,
  };

  it("shows the intake against the target and the shortfall the API worked out", () => {
    const view = fluidDayView(day, t);
    expect(view.valueText).toBe("900 ml of a 1,500 ml target");
    expect(view.status).toBe("due");
    expect(view.statusText).toBe("600 ml below the target so far");
    expect(view.meterMax).toBe(1500);
    expect(view.outputText).toBe("Output: 400 ml");
    expect(view.entriesText).toBe("5 fluid entries");
  });

  it("says when the target is reached and when there is no target", () => {
    expect(fluidDayView({ ...day, intakeMl: 1650, shortfallMl: 0 }, t)).toMatchObject({
      status: "done",
      statusText: "Target reached",
      meterMax: 1650,
    });
    expect(fluidDayView({ ...day, targetMl: null, shortfallMl: null }, t)).toMatchObject({
      status: "notApplicable",
      statusText: "No daily target set",
      valueText: "900 ml",
    });
  });
});

describe("chart entries in words", () => {
  it("hazard HZ-016 shows IDDSI levels with number, name and colour", () => {
    expect(
      observationSummary(
        {
          chart: "fluid_intake",
          values: { ml: 250, drink: "Tea", iddsiLevel: "2", refused: false },
          flags: {},
        },
        t,
      ),
    ).toEqual(["250 ml", "Tea", "Level 2 Mildly thick (pink)"]);
    expect(
      observationSummary(
        {
          chart: "food",
          values: { meal: "lunch", portion: "half", iddsiLevel: "5", refused: true },
          flags: {},
        },
        t,
      ),
    ).toEqual(["Lunch: half eaten", "Level 5 Minced and moist (orange)", "Refused"]);
  });

  it.each([
    ["fluid_output", { ml: 300, kind: "urine" }, ["300 ml urine"]],
    [
      "repositioning",
      { position: "left", skinChecked: true, declined: false },
      ["Left side", "Skin checked"],
    ],
    ["bowel", { bristolType: 4, noMovement: false, amount: "medium" }, ["Bristol type 4, medium"]],
    ["bowel", { bristolType: null, noMovement: true }, ["No bowel movement"]],
    ["weight", { kg: 62.4, method: "chair" }, ["62.4 kg, chair scales"]],
  ] as const)("%s %o", (chart, values, expected) => {
    expect(observationSummary({ chart, values: { ...values }, flags: {} }, t)).toEqual(expected);
  });

  it("reads the stored IDDSI comparison and the chart kinds", () => {
    expect(iddsiOutcome({ iddsi: { outcome: "unsafe_mismatch" } })).toBe("unsafe_mismatch");
    expect(iddsiOutcome({ iddsi: { outcome: "other" } })).toBeNull();
    expect(iddsiOutcome({})).toBeNull();
    expect(isChart("vitals")).toBe(true);
    expect(isChart("blood_glucose")).toBe(false);
  });
});
