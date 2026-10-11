import { BODY_MAP_REGIONS, personSideFromDrawing } from "@harbour/domain";
import { describe, expect, it } from "vitest";
import {
  BODY_REGIONS,
  type BodyView,
  DRAWING,
  hotspots,
  nearestHotspot,
  parseRegionValue,
  regionSides,
  viewerX,
} from "./body-map";

describe("body map regions", () => {
  it("hazard HZ-019 match the API's regions and the sides each allows, on both views", () => {
    for (const view of ["front", "back"] as const) {
      const domain = BODY_MAP_REGIONS.filter((r) => r.view === view)
        .map((r) => `${r.region}:${[...r.sides].sort().join(",")}`)
        .sort();
      const web = BODY_REGIONS[view]
        .map((r) => `${r.region}:${[...regionSides(view, r.region)].sort().join(",")}`)
        .sort();
      expect(web).toEqual(domain);
    }
  });

  it("hazard HZ-019 places the person's left on your right on the front view and on your left on the back", () => {
    for (const view of ["front", "back"] as const satisfies readonly BodyView[]) {
      for (const side of ["left", "right"] as const) {
        const x = viewerX(view, side, 20);
        const viewerSide = x < DRAWING.centre ? "viewer_left" : "viewer_right";
        expect(personSideFromDrawing(view, viewerSide)).toBe(side);
      }
      expect(viewerX(view, "midline", 20)).toBe(DRAWING.centre);
    }
  });

  it("keeps every spot inside the drawing and gives each a unique value per view", () => {
    for (const view of ["front", "back"] as const) {
      const spots = hotspots(view);
      expect(new Set(spots.map((s) => s.value)).size).toBe(spots.length);
      for (const spot of spots) {
        expect(spot.x).toBeGreaterThan(0);
        expect(spot.x).toBeLessThan(DRAWING.width);
        expect(spot.y).toBeGreaterThan(0);
        expect(spot.y).toBeLessThan(DRAWING.height);
      }
    }
  });

  it("finds the spot under a tap and ignores taps away from the body", () => {
    const leftKneeFront = hotspots("front").find((s) => s.value === "knee:left");
    expect(leftKneeFront?.x).toBeGreaterThan(DRAWING.centre);
    expect(nearestHotspot("front", (leftKneeFront?.x ?? 0) + 3, 348)?.value).toBe("knee:left");
    expect(nearestHotspot("back", DRAWING.centre, 230)?.value).toBe("sacrum:midline");
    expect(nearestHotspot("front", 5, 5)).toBeNull();
  });

  it("reads region choices from the list and refuses ones the view does not have", () => {
    expect(parseRegionValue("front", "knee:left")).toEqual({ region: "knee", side: "left" });
    expect(parseRegionValue("front", "chest:midline")).toEqual({
      region: "chest",
      side: "midline",
    });
    expect(parseRegionValue("front", "knee:midline")).toBeNull();
    expect(parseRegionValue("front", "sacrum:midline")).toBeNull();
    expect(parseRegionValue("back", "")).toBeNull();
    expect(parseRegionValue("back", "heel")).toBeNull();
  });
});
