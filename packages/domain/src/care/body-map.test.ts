import { describe, expect, it } from "vitest";
import {
  BODY_MAP_REGIONS,
  type BodyMarkInput,
  findBodyRegion,
  markTriggers,
  PRESSURE_ULCER_CATEGORIES,
  personSideFromDrawing,
  validateMark,
} from "./body-map";

/** Body map marks (hazard HZ-019) and the pressure ulcer and bruise prompts. */

const MARK: BodyMarkInput = {
  view: "back",
  region: "heel",
  drawnSide: "left",
  statedSide: "left",
  markType: "pressure_ulcer",
  pressureUlcerCategory: "category_1",
  deviceRelated: false,
};

describe("hazard HZ-019 body map sides are the person's own left and right", () => {
  it.each([
    ["front", "viewer_left", "right"],
    ["front", "viewer_right", "left"],
    ["back", "viewer_left", "left"],
    ["back", "viewer_right", "right"],
    ["front", "centre", "midline"],
    ["back", "centre", "midline"],
  ] as const)("on the %s view a mark on the %s is on the person's %s", (view, viewerSide, side) => {
    expect(personSideFromDrawing(view, viewerSide)).toBe(side);
  });

  it("gives every region a unique code on the front or back view", () => {
    const codes = BODY_MAP_REGIONS.map((r) => r.code);
    expect(new Set(codes).size).toBe(codes.length);
    expect(codes).toContain("back.sacrum");
    expect(codes).toContain("front.knee");
    expect(findBodyRegion("front", "sacrum")).toBeUndefined();
  });

  it("allows the midline only for central regions", () => {
    expect(findBodyRegion("back", "sacrum")?.sides).toEqual(["left", "right", "midline"]);
    expect(findBodyRegion("back", "heel")?.sides).toEqual(["left", "right"]);
  });
});

describe("hazard HZ-019 a mark whose drawn side and stated side differ cannot be saved", () => {
  it.each([
    ["left drawn, left stated", "left", "left", true],
    ["right drawn, right stated", "right", "right", true],
    ["left drawn, right stated", "left", "right", false],
    ["right drawn, left stated", "right", "left", false],
  ] as const)("%s", (_name, drawnSide, statedSide, saved) => {
    expect(validateMark({ ...MARK, drawnSide, statedSide }).ok).toBe(saved);
  });

  it("explains the disagreement in words", () => {
    expect(validateMark({ ...MARK, drawnSide: "right", statedSide: "left" })).toEqual({
      ok: false,
      issues: [
        {
          item: "statedSide",
          problem: "not_allowed",
          message:
            "The mark is drawn on the person's right but the person's left was chosen. Check the side and try again.",
        },
      ],
    });
  });

  it("saves a central mark on the midline", () => {
    expect(
      validateMark({
        ...MARK,
        region: "sacrum",
        drawnSide: "midline",
        statedSide: "midline",
        pressureUlcerCategory: "category_2",
      }),
    ).toMatchObject({ ok: true, code: "back.sacrum" });
  });

  it.each([
    [
      "a paired region on the midline",
      { region: "heel", drawnSide: "midline", statedSide: "midline" },
      "statedSide",
    ],
    ["a region not on the chosen view", { view: "front", region: "sacrum" }, "region"],
    [
      "an unknown mark type",
      { markType: "tattoo" as never, pressureUlcerCategory: null, deviceRelated: null },
      "markType",
    ],
  ] as const)("refuses %s", (_name, change, item) => {
    expect(validateMark({ ...MARK, ...change })).toMatchObject({ ok: false, issues: [{ item }] });
  });
});

describe("pressure ulcer categories and the incident and safeguarding prompts", () => {
  it("lists category 1 to 4, unstageable and deep tissue injury", () => {
    expect(Object.keys(PRESSURE_ULCER_CATEGORIES)).toEqual([
      "category_1",
      "category_2",
      "category_3",
      "category_4",
      "unstageable",
      "deep_tissue_injury",
    ]);
  });

  it.each([
    ["category_1", false],
    ["category_2", true],
    ["category_3", true],
    ["category_4", true],
    ["unstageable", true],
    ["deep_tissue_injury", true],
  ] as const)(
    "a %s pressure ulcer prompts an incident and the safeguarding guide: %s",
    (category, prompted) => {
      const check = validateMark({ ...MARK, pressureUlcerCategory: category });
      const tasks = check.ok ? check.triggers.map((t) => t.kind === "task" && t.task) : [];
      expect(tasks).toEqual(prompted ? ["incident_report", "safeguarding_decision_guide"] : []);
    },
  );

  it("prompts for a device-related category 2 pressure ulcer too", () => {
    expect(
      markTriggers({ markType: "pressure_ulcer", pressureUlcerCategory: "category_2" }),
    ).toHaveLength(2);
    expect(
      validateMark({ ...MARK, pressureUlcerCategory: "category_2", deviceRelated: true }),
    ).toMatchObject({
      ok: true,
      triggers: [{ task: "incident_report" }, { task: "safeguarding_decision_guide" }],
    });
  });

  it.each([
    ["an unexplained bruise prompts", false, 2],
    ["an explained bruise does not prompt", true, 0],
  ] as const)("%s", (_name, bruiseExplained, count) => {
    const check = validateMark({
      ...MARK,
      markType: "bruise",
      pressureUlcerCategory: null,
      deviceRelated: null,
      bruiseExplained,
    });
    expect(check.ok && check.triggers).toHaveLength(count);
    if (count > 0) {
      expect(check.ok && check.triggers[0]).toEqual({
        kind: "task",
        task: "incident_report",
        reason: "Unexplained bruise",
      });
    }
  });

  it("records moisture-associated skin damage separately, with no category and no prompt", () => {
    const masd = {
      ...MARK,
      markType: "moisture_associated_skin_damage" as const,
      deviceRelated: null,
    };
    expect(validateMark({ ...masd, pressureUlcerCategory: null })).toMatchObject({
      ok: true,
      triggers: [],
    });
    expect(validateMark({ ...masd, pressureUlcerCategory: "category_2" })).toEqual({
      ok: false,
      issues: [
        {
          item: "pressureUlcerCategory",
          problem: "not_allowed",
          message:
            "Moisture-associated skin damage is recorded separately and has no pressure ulcer category.",
        },
      ],
    });
  });

  it.each([
    [
      "a pressure ulcer without a category",
      { pressureUlcerCategory: null },
      "pressureUlcerCategory",
      "missing",
    ],
    [
      "an unknown category",
      { pressureUlcerCategory: "grade_5" as never },
      "pressureUlcerCategory",
      "not_allowed",
    ],
    [
      "a pressure ulcer without the device question",
      { deviceRelated: undefined },
      "deviceRelated",
      "missing",
    ],
    [
      "a category on a skin tear",
      { markType: "skin_tear", deviceRelated: null },
      "pressureUlcerCategory",
      "not_allowed",
    ],
    [
      "device-related on a laceration",
      { markType: "laceration", pressureUlcerCategory: null, deviceRelated: true },
      "deviceRelated",
      "not_allowed",
    ],
    [
      "a bruise without saying whether it is explained",
      { markType: "bruise", pressureUlcerCategory: null, deviceRelated: null },
      "bruiseExplained",
      "missing",
    ],
    [
      "explained on a burn",
      { markType: "burn", pressureUlcerCategory: null, deviceRelated: null, bruiseExplained: true },
      "bruiseExplained",
      "not_allowed",
    ],
  ] as const)("refuses %s", (_name, change, item, problem) => {
    expect(validateMark({ ...MARK, ...(change as Partial<BodyMarkInput>) })).toMatchObject({
      ok: false,
      issues: [{ item, problem }],
    });
  });
});
