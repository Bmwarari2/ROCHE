import { CreateBodyMapMark } from "@harbour/contracts";
import type { BodySide } from "@harbour/domain";
import { describe, expect, it } from "vitest";
import { toCareUpload } from "../sync/care-upload";
import { checkMark, drawnSide, type MarkDraft, regionsFor } from "./body-map";
import type { EntryContext } from "./entries";

const NOW = new Date("2026-10-11T10:00:00Z");
const context: EntryContext = {
  tenantId: "00000000-0000-4000-8000-0000000000a1",
  personId: "00000000-0000-4000-8000-0000000000b1",
  locationId: null,
  userId: null,
  newId: () => "0199d000-0000-7000-8000-000000000003",
};
const sideWords = (side: BodySide) => `the person's ${side}`;

const draft = (overrides: Partial<MarkDraft> = {}): MarkDraft => ({
  view: "front",
  zone: "viewer_right",
  region: "shin",
  side: "left",
  markType: "bruise",
  pressureCategory: null,
  deviceRelated: null,
  bruiseExplained: true,
  description: "",
  when: { kind: "now" },
  correction: null,
  ...overrides,
});

describe("hazard HZ-019 the side on the drawing and in words", () => {
  it.each([
    // The front view faces the carer, so the carer's right is the person's left.
    ["front", "viewer_right", "left"],
    ["front", "viewer_left", "right"],
    // The back view faces away, so the two agree.
    ["back", "viewer_left", "left"],
    ["back", "viewer_right", "right"],
    ["front", "centre", "midline"],
  ] as const)("on the %s view, %s of the drawing is the person's %s", (view, zone, side) => {
    expect(drawnSide(view, zone)).toBe(side);
  });

  it("refuses a mark drawn on one side and described as the other", () => {
    // Tapped on the carer's left of the front view (the person's right), but "left" chosen.
    const result = checkMark(draft({ zone: "viewer_left", side: "left" }), context, NOW, sideWords);
    expect(result.ok).toBe(false);
    expect(!result.ok && result.errors.side).toEqual({
      key: "mobile.bodyMap.mismatch",
      values: { drawn: "the person's right", stated: "the person's left" },
    });
  });

  it("saves a mark whose two sides agree, keeping the drawn side for the API's own check", () => {
    const result = checkMark(draft(), context, NOW, sideWords);
    expect(result.ok && result.row).toMatchObject({
      side: "left",
      drawn_side: "left",
      view: "front",
    });
    if (!result.ok) throw new Error("expected a valid mark");
    const request = toCareUpload({
      op: "PUT",
      table: "body_map_mark",
      id: String(result.row.id),
      opData: result.row,
    });
    expect(request.kind === "request" && CreateBodyMapMark.safeParse(request.body).success).toBe(
      true,
    );
    expect(request.kind === "request" && request.body).toMatchObject({
      drawnSide: "left",
      side: "left",
    });
  });

  it("refuses the midline for a paired body area", () => {
    const result = checkMark(
      draft({ zone: "centre", side: "midline", region: "shin" }),
      context,
      NOW,
      sideWords,
    );
    expect(!result.ok && result.errors.side).toEqual({
      key: "mobile.bodyMap.sideNotAllowed",
      values: { region: "Shin" },
    });
  });

  it("allows the midline for a central area", () => {
    const result = checkMark(
      draft({ view: "back", zone: "centre", side: "midline", region: "sacrum" }),
      context,
      NOW,
      sideWords,
    );
    expect(result.ok).toBe(true);
  });

  it("needs a place on the drawing as well as the side in words", () => {
    const result = checkMark(draft({ zone: null }), context, NOW, sideWords);
    expect(!result.ok && result.errors.zone?.key).toBe("mobile.bodyMap.drawingRequired");
    const noWords = checkMark(draft({ side: null }), context, NOW, sideWords);
    expect(!noWords.ok && noWords.errors.side?.key).toBe("mobile.bodyMap.sideRequired");
  });

  it("only offers body areas on the chosen view", () => {
    expect(regionsFor("back").every((r) => r.view === "back")).toBe(true);
    expect(regionsFor("front").some((r) => r.region === "sacrum")).toBe(false);
  });
});

describe("mark details", () => {
  it("needs the category and the device question for a pressure ulcer", () => {
    const result = checkMark(
      draft({ markType: "pressure_ulcer", bruiseExplained: null }),
      context,
      NOW,
      sideWords,
    );
    expect(!result.ok && result.errors.pressureCategory?.key).toBe(
      "mobile.bodyMap.categoryRequired",
    );
    expect(!result.ok && result.errors.deviceRelated?.key).toBe("mobile.bodyMap.answerRequired");
  });

  it("says that a category 2 ulcer or an unexplained bruise prompts an incident and safeguarding", () => {
    const ulcer = checkMark(
      draft({
        view: "back",
        zone: "centre",
        side: "midline",
        region: "sacrum",
        markType: "pressure_ulcer",
        pressureCategory: "category_2",
        deviceRelated: false,
        bruiseExplained: null,
      }),
      context,
      NOW,
      sideWords,
    );
    expect(ulcer.ok && ulcer.prompts).toBe(true);
    const bruise = checkMark(draft({ bruiseExplained: false }), context, NOW, sideWords);
    expect(bruise.ok && bruise.prompts).toBe(true);
    const explained = checkMark(draft(), context, NOW, sideWords);
    expect(explained.ok && explained.prompts).toBe(false);
  });

  it("keeps ulcer and bruise answers only for their own mark types", () => {
    const result = checkMark(
      draft({ markType: "rash", bruiseExplained: true, deviceRelated: true }),
      context,
      NOW,
      sideWords,
    );
    expect(result.ok && result.row).toMatchObject({
      bruise_explained: null,
      device_related: null,
      pressure_category: null,
    });
  });
});
