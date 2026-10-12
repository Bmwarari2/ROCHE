import { describe, expect, it } from "vitest";
import {
  BODY_MAP_DRAWING,
  BODY_MAP_REGIONS,
  type BodyMarkInput,
  findBodyRegion,
  markTriggers,
  onDrawing,
  PRESSURE_ULCER_CATEGORIES,
  personSideFromDrawing,
  sideFromDrawing,
  validateMark,
  zoneAtPoint,
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

describe("hazard HZ-019 the server works out the side from the place drawn and the view", () => {
  it.each([
    // Legs: always on a side, even right beside the midline (clinical review C5).
    ["front", { x: 50, y: 150 }, "right"],
    ["front", { x: 62, y: 150 }, "left"],
    ["back", { x: 50, y: 150 }, "left"],
    ["back", { x: 62, y: 150 }, "right"],
    ["front", { x: 60, y: 124 }, "left"],
    ["back", { x: 60, y: 124 }, "right"],
    // Arms.
    ["front", { x: 27, y: 80 }, "right"],
    ["back", { x: 27, y: 80 }, "left"],
    // The centre band over the head and trunk only, 4 units either side of the midline.
    ["front", { x: 60, y: 22 }, "midline"],
    ["back", { x: 56, y: 123.9 }, "midline"],
    ["front", { x: 64, y: 80 }, "midline"],
    ["front", { x: 64.01, y: 80 }, "left"],
    ["front", { x: 55.99, y: 80 }, "right"],
    ["back", { x: 64.01, y: 80 }, "right"],
    // The edges of the drawing.
    ["front", { x: 0, y: 0 }, "right"],
    ["front", { x: 120, y: 240 }, "left"],
  ] as const)("on the %s view, a mark at %j is on the person's %s", (view, point, side) => {
    expect(sideFromDrawing(view, { point })).toEqual({
      ok: true,
      zone: zoneAtPoint(point),
      side,
    });
  });

  it.each([
    ["front", "viewer_left", "right"],
    ["front", "viewer_right", "left"],
    ["front", "centre", "midline"],
    ["back", "viewer_left", "left"],
    ["back", "viewer_right", "right"],
    ["back", "centre", "midline"],
  ] as const)("on the %s view, the %s button is the person's %s", (view, zone, side) => {
    expect(sideFromDrawing(view, { zone })).toEqual({ ok: true, zone, side });
  });

  it("takes the point and the zone together only when they agree", () => {
    expect(sideFromDrawing("front", { point: { x: 30, y: 150 }, zone: "viewer_left" })).toEqual({
      ok: true,
      zone: "viewer_left",
      side: "right",
    });
    expect(sideFromDrawing("front", { point: { x: 30, y: 150 }, zone: "viewer_right" })).toEqual({
      ok: false,
      message: "The place marked on the drawing and the side of the drawing chosen disagree.",
    });
  });

  it.each([
    ["no place at all", {}],
    ["a point off the drawing", { point: { x: 121, y: 10 } }],
    ["a point above the drawing", { point: { x: 60, y: -1 } }],
    ["a point that is not a number", { point: { x: Number.NaN, y: 10 } }],
    ["a zone that does not exist", { zone: "middle" }],
  ] as const)("refuses %s", (_name, place) => {
    expect(sideFromDrawing("front", place as Parameters<typeof sideFromDrawing>[1]).ok).toBe(false);
  });

  it("reads the drawing in its own units, with a narrow band over the trunk only", () => {
    expect(BODY_MAP_DRAWING).toEqual({
      width: 120,
      height: 240,
      midline: 60,
      legsTop: 124,
      centreHalfWidth: 4,
    });
    expect(onDrawing({ x: 120, y: 240 })).toBe(true);
    expect(onDrawing({ x: 120.5, y: 240 })).toBe(false);
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
