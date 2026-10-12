import { createTranslator } from "@harbour/i18n";
import { describe, expect, it } from "vitest";
import {
  alertRouteMessage,
  fluidDayView,
  iddsiOutcome,
  iddsiProblem,
  iddsiProblemMessage,
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
    expect(news2?.workings).toEqual({
      rows: [{ item: "Respiration rate", value: "22 per minute", points: 2 }],
      unreadable: 1,
    });
  });

  it("hazard HZ-014 counts workings it cannot read, and never assumes SpO2 scale 1", () => {
    expect(readWorkings("x")).toEqual({ rows: [], unreadable: 1 });
    expect(readWorkings(undefined)).toEqual({ rows: [], unreadable: 0 });
    const noScale = news2FromFlags({ news2: { ...storedNews2.news2, spo2Scale: undefined } });
    expect(noScale?.spo2Scale).toBeNull();
    const scale2 = news2FromFlags({ news2: { ...storedNews2.news2, spo2Scale: 2 } });
    expect(scale2?.spo2Scale).toBe(2);
  });

  it("gives nothing rather than a guess when no result was stored", () => {
    expect(news2FromFlags({})).toBeNull();
    expect(news2FromFlags({ news2: { score: "6" } })).toBeNull();
    expect(news2FromFlags({ news2: [] })).toBeNull();
  });

  it("shows medium and high results as the strongest chip, and a single 3 as a warning", () => {
    expect(news2Chip("high")).toBe("overdue");
    expect(news2Chip("medium")).toBe("overdue");
    expect(news2Chip("low_medium")).toBe("due");
    expect(news2Chip("low")).toBe("neutral");
  });

  it("summarises a vital signs entry by its readings; the NEWS2 result has its own line", () => {
    const values = {
      respirationRate: 22,
      spo2: 95,
      onOxygen: false,
      systolic: 105,
      pulse: 95,
      consciousness: "alert",
      temperature: 38.2,
    };
    expect(observationSummary({ chart: "vitals", values, flags: storedNews2 }, t)).toEqual([
      "Respiration rate 22, SpO2 95% on air, systolic 105 mmHg, pulse 95, alert, temperature 38.2 °C",
    ]);
    expect(observationSummary({ chart: "vitals", values: {}, flags: {} }, t)).toEqual([
      "Chart entry",
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
    flaggedEntries: 0,
    flaggedIntakeMl: 0,
    flaggedOutputMl: 0,
    refusedEntries: 0,
    refusedOfferedMl: 0,
  };

  it("shows the intake against the target and the shortfall the API worked out", () => {
    const view = fluidDayView(day, t);
    expect(view.valueText).toBe("900 ml of a 1,500 ml target");
    expect(view.status).toBe("due");
    expect(view.statusText).toBe("600 ml below the target so far");
    expect(view.meterMax).toBe(1500);
    expect(view.outputText).toBe("Output: 400 ml");
    expect(view.entriesText).toBe("5 fluid entries");
    expect(view.flaggedText).toBeNull();
  });

  it("hazard HZ-040 says beside the totals how much a device recorded deleting, never taking it out", () => {
    const view = fluidDayView(
      { ...day, flaggedEntries: 2, flaggedIntakeMl: 300, flaggedOutputMl: 0 },
      t,
    );
    expect(view.flaggedText).toBe(
      "Includes 2 entries that a device recorded as deleted (300 ml in, 0 ml out): check for duplicates.",
    );
    expect(view.valueText).toBe("900 ml of a 1,500 ml target");
  });

  it("hazard HZ-014 says beside the totals what was offered and refused, never as drunk (#26 review round 3)", () => {
    expect(fluidDayView(day, t).refusedText).toBeNull();
    const view = fluidDayView({ ...day, refusedEntries: 2, refusedOfferedMl: 450 }, t);
    expect(view.refusedText).toBe(
      "2 drinks offered and refused (450 ml), not counted in the intake.",
    );
    // The intake and the shortfall are the API's, which never count a refused drink.
    expect(view.valueText).toBe("900 ml of a 1,500 ml target");
    expect(view.statusText).toBe("600 ml below the target so far");
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
    // A refused drink's amount is what was offered (#26 review round 3).
    expect(
      observationSummary(
        { chart: "fluid_intake", values: { ml: 200, drink: "Tea", refused: true }, flags: {} },
        t,
      ),
    ).toEqual(["200 ml offered", "Tea", "Refused"]);
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
    expect(iddsiOutcome({ iddsi: { outcome: "level_not_recorded" } })).toBe("level_not_recorded");
    expect(iddsiProblem({ iddsiProblem: "reason_missing" })).toBe("reason_missing");
    expect(iddsiProblem({ iddsiProblem: "other" })).toBeNull();
    expect(iddsiProblem({})).toBeNull();
    expect(isChart("vitals")).toBe(true);
    expect(isChart("blood_glucose")).toBe(false);
  });

  it.each<[string, "fluid_intake" | "food", Record<string, unknown>, string | null]>([
    ["no problem", "fluid_intake", {}, null],
    [
      "a drink with no level",
      "fluid_intake",
      { iddsiProblem: "level_not_recorded", iddsiAlert: true },
      "care.charts.iddsiKeptNoLevel",
    ],
    [
      "a thinner drink with no reason, which alerted",
      "fluid_intake",
      { iddsiProblem: "reason_missing", iddsiAlert: true },
      "care.charts.iddsiKeptUnsafeDrink",
    ],
    [
      "more solid food with no reason, which alerted",
      "food",
      { iddsiProblem: "reason_missing", iddsiAlert: true },
      "care.charts.iddsiKeptUnsafeFood",
    ],
    [
      "a safer level with no reason",
      "food",
      { iddsiProblem: "reason_missing", iddsiAlert: false },
      "care.charts.iddsiKeptNoReason",
    ],
    [
      "a prescription that could not be read",
      "fluid_intake",
      { iddsiProblem: "prescribed_unreadable", iddsiAlert: true },
      "care.charts.iddsiKeptUnreadable",
    ],
  ])("hazard HZ-016 says every IDDSI problem of a kept entry: %s", (_name, chart, flags, key) => {
    expect(iddsiProblemMessage({ chart, flags })).toBe(key);
  });

  it.each<[string, Record<string, unknown>, string | null]>([
    ["the nurse in charge", { alertRoute: "nurse_in_charge" }, "The nurse in charge was told."],
    [
      "the fallback",
      { iddsiAlert: true, alertRoute: "fallback" },
      "The alert went to a manager or another member of staff who can see this person, not to a nurse in charge here.",
    ],
    [
      "no one",
      { iddsiAlert: true, alertRoute: "no_one" },
      "No one who can open this record could be told. Tell the nurse in charge or a manager now.",
    ],
    [
      "an alert saved before the route was kept",
      { iddsiAlert: true },
      "Check that the nurse in charge knows.",
    ],
    ["no alert", { iddsiAlert: false }, null],
  ])(
    "hazard HZ-014 hazard HZ-016 says who an alert actually reached: %s (#26 review round 3)",
    (_name, flags, words) => {
      const key = alertRouteMessage(flags);
      expect(key === null ? null : t(key)).toBe(words);
    },
  );
});
