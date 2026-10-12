import { CreateObservation, ObservationValues } from "@harbour/contracts";
import { NEWS2_REFERENCE_VECTORS, news2PointsOf } from "@harbour/domain";
import { describe, expect, it } from "vitest";
import { toCareUpload } from "../sync/care-upload";
import {
  type CareProfile,
  CHART_LIMITS,
  type ChartDraft,
  checkChart,
  news2Appearance,
  prescribedLevel,
  previewNews2,
  readNews2,
  readNumber,
} from "./charts";
import type { EntryContext } from "./entries";

const NOW = new Date("2026-10-11T10:00:00Z");
const context: EntryContext = {
  tenantId: "00000000-0000-4000-8000-0000000000a1",
  personId: "00000000-0000-4000-8000-0000000000b1",
  locationId: null,
  userId: null,
  newId: () => "0199d000-0000-7000-8000-000000000002",
};

/** Ada: minced and moist food (level 5), mildly thick drinks (level 2), SpO2 scale 1. */
const profile: CareProfile = { iddsi_food_level: "5", iddsi_drink_level: "2", spo2_scale2: 0 };

function draft(
  chart: ChartDraft["chart"],
  parts: Partial<Pick<ChartDraft, "text" | "choice" | "yesNo">> = {},
): ChartDraft {
  return {
    chart,
    text: parts.text ?? {},
    choice: parts.choice ?? {},
    yesNo: parts.yesNo ?? {},
    when: { kind: "now" },
    correction: null,
  };
}

const vitals = (overrides: Record<string, string> = {}, onOxygen = false, level = "alert") =>
  draft("vitals", {
    text: {
      respirationRate: "18",
      spo2: "97",
      systolic: "125",
      pulse: "72",
      temperature: "36.8",
      ...overrides,
    },
    choice: { consciousness: level },
    yesNo: { onOxygen },
  });

/** The upload body for a valid chart row, checked against the API's own schema. */
function uploadAccepted(result: ReturnType<typeof checkChart>): boolean {
  if (!result.ok) throw new Error(JSON.stringify(result.errors));
  const request = toCareUpload({
    op: "PUT",
    table: "observation",
    id: String(result.row.id),
    opData: result.row,
  });
  if (request.kind !== "request") throw new Error(request.message);
  return CreateObservation.safeParse(request.body).success;
}

describe("every chart builds values the API accepts", () => {
  it.each([
    [
      "fluid_intake",
      draft("fluid_intake", { text: { ml: "200", drink: "Tea" }, choice: { iddsiLevel: "2" } }),
    ],
    ["fluid_output", draft("fluid_output", { text: { ml: "350" }, choice: { kind: "urine" } })],
    ["food", draft("food", { choice: { meal: "lunch", portion: "half", iddsiLevel: "5" } })],
    [
      "repositioning",
      draft("repositioning", { choice: { position: "left" }, yesNo: { skinChecked: true } }),
    ],
    ["bowel", draft("bowel", { choice: { bristolType: "4", amount: "medium" } })],
    ["bowel (none)", draft("bowel", { choice: { bristolType: "none" } })],
    ["weight", draft("weight", { text: { kg: "61.4" }, choice: { method: "chair" } })],
    ["vitals", vitals()],
  ])("%s", (_label, input) => {
    const result = checkChart(input, profile, context, NOW);
    expect(uploadAccepted(result)).toBe(true);
    expect(result.ok && ObservationValues.safeParse(result.values).success).toBe(true);
  });

  it("matches the API's limits for amounts and weights", () => {
    const fluid = (ml: number) => ({ chart: "fluid_intake", ml });
    expect(ObservationValues.safeParse(fluid(CHART_LIMITS.ml.max)).success).toBe(true);
    expect(ObservationValues.safeParse(fluid(CHART_LIMITS.ml.max + 1)).success).toBe(false);
    const weight = (kg: number) => ({ chart: "weight", kg, method: "bed" });
    expect(ObservationValues.safeParse(weight(CHART_LIMITS.kg.min)).success).toBe(true);
    expect(ObservationValues.safeParse(weight(CHART_LIMITS.kg.min - 0.1)).success).toBe(false);
    expect(ObservationValues.safeParse(weight(CHART_LIMITS.kg.max + 0.1)).success).toBe(false);
  });
});

describe("hazard HZ-016 IDDSI levels on food and drink", () => {
  it("shows the prescribed level beside the choice, in number, name and colour", () => {
    expect(prescribedLevel("food", profile)).toBe("Level 5 Minced and moist (orange)");
    expect(prescribedLevel("drink", profile)).toBe("Level 2 Mildly thick (pink)");
    expect(prescribedLevel("food", null)).toBeNull();
  });

  it("refuses food more solid than prescribed without an override reason, saying it may not be safe", () => {
    const result = checkChart(
      draft("food", { choice: { meal: "lunch", portion: "all", iddsiLevel: "7" } }),
      profile,
      context,
      NOW,
    );
    expect(!result.ok && result.errors.overrideReason).toEqual({
      key: "mobile.iddsi.unsafe",
      values: { level: "Level 5 Minced and moist (orange)" },
    });
  });

  it("refuses a softer level than prescribed without a reason", () => {
    const result = checkChart(
      draft("food", { choice: { meal: "lunch", portion: "all", iddsiLevel: "4" } }),
      profile,
      context,
      NOW,
    );
    expect(!result.ok && result.errors.overrideReason?.key).toBe("mobile.iddsi.mismatch");
  });

  it("refuses a drink thinner than prescribed without a reason", () => {
    const result = checkChart(
      draft("fluid_intake", { text: { ml: "150" }, choice: { iddsiLevel: "0" } }),
      profile,
      context,
      NOW,
    );
    expect(!result.ok && result.errors.overrideReason?.key).toBe("mobile.iddsi.unsafe");
  });

  it("saves a mismatch with its reason and keeps the alert flag for the nurse in charge", () => {
    const result = checkChart(
      draft("food", {
        choice: { meal: "lunch", portion: "all", iddsiLevel: "7" },
        text: { overrideReason: "Speech and language therapist trial today" },
      }),
      profile,
      context,
      NOW,
    );
    expect(result.ok).toBe(true);
    expect(result.ok && JSON.parse(String(result.row.flags))).toEqual({
      iddsi: { outcome: "unsafe_mismatch", needsReason: true, raisesAlert: true },
      iddsiAlert: true,
    });
    expect(uploadAccepted(result)).toBe(true);
  });

  it("needs an IDDSI level for every food entry", () => {
    const result = checkChart(
      draft("food", { choice: { meal: "lunch", portion: "all" } }),
      profile,
      context,
      NOW,
    );
    expect(!result.ok && result.errors.iddsiLevel?.key).toBe("mobile.iddsi.levelRequired");
  });

  it("accepts any level when the profile says no level is prescribed", () => {
    const result = checkChart(
      draft("food", { choice: { meal: "lunch", portion: "all", iddsiLevel: "7" } }),
      { iddsi_food_level: null, iddsi_drink_level: null, spo2_scale2: 0 },
      context,
      NOW,
    );
    expect(result.ok && JSON.parse(String(result.row.flags)).iddsi).toEqual({
      outcome: "no_prescribed_level",
    });
  });

  it("says when the prescribed level itself is wrong", () => {
    const result = checkChart(
      draft("food", { choice: { meal: "lunch", portion: "all", iddsiLevel: "5" } }),
      { ...profile, iddsi_food_level: "9" },
      context,
      NOW,
    );
    expect(!result.ok && result.errors.iddsiLevel?.key).toBe("mobile.iddsi.prescribedInvalid");
  });
});

describe("hazard HZ-016 food and drink levels on the device (C3)", () => {
  it("needs the level given when a drink level is prescribed", () => {
    const result = checkChart(
      draft("fluid_intake", { text: { ml: "200" } }),
      profile,
      context,
      NOW,
    );
    expect(!result.ok && result.errors.iddsiLevel?.key).toBe("mobile.iddsi.levelRequired");
  });

  it("records a drink without a level when none is prescribed", () => {
    const result = checkChart(
      draft("fluid_intake", { text: { ml: "200" } }),
      { iddsi_food_level: null, iddsi_drink_level: null, spo2_scale2: 0 },
      context,
      NOW,
    );
    expect(result.ok).toBe(true);
  });

  it("asks no level for a drink refused, since none was given (#26 review round 2)", () => {
    const refused = draft("fluid_intake", { text: { ml: "200" }, yesNo: { refused: true } });
    expect(checkChart(refused, profile, context, NOW).ok).toBe(true);
    expect(checkChart(refused, null, context, NOW).ok).toBe(true);
  });

  it.each([
    ["food", draft("food", { choice: { meal: "lunch", portion: "all", iddsiLevel: "7" } })],
    ["fluid_intake", draft("fluid_intake", { text: { ml: "200" }, choice: { iddsiLevel: "0" } })],
  ] as const)(
    "blocks a %s level when the profile is not on the device, until the carer confirms they checked it",
    (_chart, entry) => {
      const blocked = checkChart(entry, null, context, NOW);
      expect(!blocked.ok && blocked.errors.levelChecked?.key).toBe(
        "mobile.iddsi.confirmUnrecorded",
      );
      const confirmed = checkChart(
        { ...entry, yesNo: { ...entry.yesNo, levelChecked: true } },
        null,
        context,
        NOW,
      );
      expect(confirmed.ok).toBe(true);
    },
  );

  it("hazard HZ-016 asks the same confirmation for a drink with no level when the profile is not on the device (round 3 M3)", () => {
    const entry = draft("fluid_intake", { text: { ml: "200" } });
    const blocked = checkChart(entry, null, context, NOW);
    expect(!blocked.ok && blocked.errors.levelChecked?.key).toBe("mobile.iddsi.confirmNoLevel");
    const confirmed = checkChart(
      { ...entry, yesNo: { ...entry.yesNo, levelChecked: true } },
      null,
      context,
      NOW,
    );
    expect(confirmed.ok).toBe(true);
  });
});

describe("hazard HZ-012 NEWS2 on the device against the reference vectors (C6)", () => {
  it.each(NEWS2_REFERENCE_VECTORS.map((v) => [v.name, v] as const))(
    "%s, typed on the device",
    (_name, vector) => {
      const input = vector.input;
      const typed = vitals(
        {
          respirationRate: String(input.respirationRate),
          spo2: String(input.spo2),
          systolic: String(input.systolicBp),
          pulse: String(input.pulse),
          temperature: input.temperature.toFixed(1),
        },
        input.supplementalOxygen,
        input.consciousness,
      );
      const preview = previewNews2(typed, {
        ...profile,
        spo2_scale2: input.spo2Scale2Decision ? 1 : 0,
      });
      if (preview.status !== "scored") throw new Error(preview.status);
      expect({
        points: news2PointsOf(preview.result.workings),
        score: preview.result.score,
        band: preview.result.band,
        threshold: preview.result.threshold,
        redScore: preview.result.redScore,
      }).toEqual(vector.expected);
    },
  );
});

describe("NEWS2 on the device (HZ-012, HZ-014)", () => {
  it.each([
    ["no care profile on the device", null],
    ["a profile without the SpO2 scale", { ...profile, spo2_scale2: null }],
  ])("gives no total with %s, and keeps the readings for the server (C6)", (_case, known) => {
    expect(previewNews2(vitals(), known)).toEqual({ status: "noScale" });
    const result = checkChart(vitals(), known, context, NOW);
    expect(result.ok && result.news2).toBeNull();
    expect(result.ok && JSON.parse(String(result.row.flags))).toEqual({});
    expect(result.ok && JSON.parse(String(result.row.chart_values))).toMatchObject({ spo2: 97 });
  });

  it("keeps the RCP chart 4 clinical response with the score", () => {
    const result = checkChart(
      vitals({ respirationRate: "25", pulse: "131" }),
      profile,
      context,
      NOW,
    );
    const stored = result.ok ? readNews2(String(result.row.flags)) : null;
    expect(stored?.clinicalResponse[0]).toBe(
      "Registered nurse to immediately inform the medical team caring for the patient",
    );
  });

  it("shows a raised score at once, with the published response", () => {
    const result = checkChart(
      vitals({ respirationRate: "25", pulse: "131" }),
      profile,
      context,
      NOW,
    );
    expect(result.ok && result.news2?.score).toBe(6);
    const stored = result.ok ? readNews2(String(result.row.flags)) : null;
    expect(stored).toMatchObject({ score: 6, band: "medium", clinicalRisk: "Medium" });
    expect(stored?.response).toBe("Key threshold for urgent response");
    expect(stored && news2Appearance(stored)).toEqual({
      tone: "danger",
      icon: "triangle-alert",
      raised: true,
    });
  });

  it("uses SpO2 scale 2 only when the person's record says a clinician decided it", () => {
    const scale2: CareProfile = { ...profile, spo2_scale2: 1 };
    const onAir = vitals({ spo2: "90" });
    const scale1Result = previewNews2(onAir, profile);
    const scale2Result = previewNews2(onAir, scale2);
    expect(scale1Result.status === "scored" && scale1Result.result.spo2Scale).toBe(1);
    expect(scale2Result.status === "scored" && scale2Result.result.spo2Scale).toBe(2);
    expect(scale1Result.status === "scored" && scale1Result.result.score).toBe(3);
    expect(scale2Result.status === "scored" && scale2Result.result.score).toBe(0);
  });

  it("waits for every reading before scoring", () => {
    expect(previewNews2(vitals({ pulse: "" }), profile)).toEqual({ status: "incomplete" });
    const result = checkChart(vitals({ pulse: "" }), profile, context, NOW);
    expect(!result.ok && result.errors.pulse?.key).toBe("mobile.form.required");
  });

  it("refuses readings that cannot be real rather than scoring them", () => {
    const preview = previewNews2(vitals({ temperature: "3.7" }), profile);
    expect(preview.status === "invalid" && preview.errors.temperature).toEqual({
      key: "mobile.form.range",
      values: { min: 20, max: 45 },
    });
    expect(previewNews2(vitals({ pulse: "72.5" }), profile)).toMatchObject({
      status: "invalid",
      errors: { pulse: { key: "mobile.form.wholeNumber" } },
    });
  });

  it.each([
    [{ score: 0, band: "low" }, "success", false],
    [{ score: 2, band: "low" }, "info", true],
    [{ score: 3, band: "low_medium" }, "warning", true],
    [{ score: 7, band: "high" }, "danger", true],
  ])("shows %j with the %s tone", (news2, tone, raised) => {
    expect(news2Appearance(news2)).toMatchObject({ tone, raised });
  });

  it("reads NEWS2 flags written by the device or the server, and nothing else", () => {
    expect(readNews2('{"news2":{"score":1,"band":"low"}}')?.score).toBe(1);
    expect(readNews2("{}")).toBeNull();
    expect(readNews2("not json")).toBeNull();
    expect(readNews2(null)).toBeNull();
  });
});

describe("other charts", () => {
  it.each([
    ["", { key: "mobile.form.required" }],
    ["abc", { key: "mobile.form.number" }],
    ["1e3", { key: "mobile.form.number" }],
    ["12.5", { key: "mobile.form.wholeNumber" }],
    ["6000", { key: "mobile.form.range", values: { min: 0, max: 5000 } }],
    ["250", 250],
  ])("reads the amount %j", (value, expected) => {
    expect(readNumber(value, CHART_LIMITS.ml)).toEqual(expected);
  });

  it("allows one decimal place for weight", () => {
    expect(readNumber("61.45", CHART_LIMITS.kg)).toEqual({
      key: "mobile.form.decimals",
      values: { decimals: 1 },
    });
  });

  it("records no bowel movement as such, for the 3-day prompt", () => {
    const result = checkChart(
      draft("bowel", { choice: { bristolType: "none" } }),
      profile,
      context,
      NOW,
    );
    expect(result.ok && result.values).toEqual({
      chart: "bowel",
      bristolType: null,
      noMovement: true,
    });
  });

  it("needs the skin check answered when repositioning", () => {
    const result = checkChart(
      draft("repositioning", { choice: { position: "back" } }),
      profile,
      context,
      NOW,
    );
    expect(!result.ok && result.errors.skinChecked?.key).toBe("mobile.form.required");
  });

  it("refuses an output type that is not on the list", () => {
    const result = checkChart(
      draft("fluid_output", { text: { ml: "100" }, choice: { kind: "blood" } }),
      profile,
      context,
      NOW,
    );
    expect(!result.ok && result.errors.kind?.key).toBe("mobile.form.choose");
  });
});
