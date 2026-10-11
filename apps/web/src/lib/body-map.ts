/**
 * The body map drawing (care.md rule 7, hazard HZ-019). Regions match the API's list in
 * packages/domain/src/care/body-map.ts (a unit test keeps them in step). Sides are always the
 * person's own left and right: on the front view the person faces you, so their left is on your
 * right; on the back view their left is on your left. The drawing gives the side as drawn; the
 * person also states the side in words, and the API refuses the mark when the two disagree.
 */

export type BodyView = "front" | "back";
export type BodySide = "left" | "right" | "midline";

/** Paired regions are always on one side; central ones may also be on the midline. */
type Shape = "paired" | "central";

interface RegionPlacement {
  readonly region: string;
  readonly shape: Shape;
  /** Height on the 240 by 480 drawing. */
  readonly y: number;
  /** Distance from the centre line to each side's spot. */
  readonly dx: number;
}

const FRONT: readonly RegionPlacement[] = [
  { region: "head", shape: "central", y: 26, dx: 12 },
  { region: "face", shape: "central", y: 50, dx: 9 },
  { region: "ear", shape: "paired", y: 42, dx: 25 },
  { region: "neck", shape: "central", y: 80, dx: 8 },
  { region: "shoulder", shape: "paired", y: 100, dx: 46 },
  { region: "chest", shape: "central", y: 122, dx: 20 },
  { region: "breast", shape: "paired", y: 146, dx: 22 },
  { region: "abdomen", shape: "central", y: 190, dx: 18 },
  { region: "groin", shape: "central", y: 238, dx: 16 },
  { region: "genitals", shape: "central", y: 256, dx: 7 },
  { region: "upper_arm", shape: "paired", y: 140, dx: 60 },
  { region: "inner_elbow", shape: "paired", y: 174, dx: 64 },
  { region: "forearm", shape: "paired", y: 204, dx: 68 },
  { region: "wrist", shape: "paired", y: 232, dx: 72 },
  { region: "hand", shape: "paired", y: 256, dx: 76 },
  { region: "hip", shape: "paired", y: 222, dx: 36 },
  { region: "thigh", shape: "paired", y: 296, dx: 24 },
  { region: "knee", shape: "paired", y: 346, dx: 22 },
  { region: "shin", shape: "paired", y: 392, dx: 21 },
  { region: "ankle", shape: "paired", y: 434, dx: 21 },
  { region: "foot", shape: "paired", y: 452, dx: 24 },
  { region: "toes", shape: "paired", y: 468, dx: 27 },
];

const BACK: readonly RegionPlacement[] = [
  { region: "back_of_head", shape: "central", y: 30, dx: 12 },
  { region: "ear", shape: "paired", y: 42, dx: 25 },
  { region: "back_of_neck", shape: "central", y: 80, dx: 8 },
  { region: "shoulder_blade", shape: "paired", y: 120, dx: 28 },
  { region: "upper_back", shape: "central", y: 148, dx: 14 },
  { region: "spine", shape: "central", y: 176, dx: 10 },
  { region: "lower_back", shape: "central", y: 204, dx: 18 },
  { region: "sacrum", shape: "central", y: 228, dx: 10 },
  { region: "coccyx", shape: "central", y: 246, dx: 7 },
  { region: "buttock", shape: "paired", y: 266, dx: 24 },
  { region: "back_of_upper_arm", shape: "paired", y: 140, dx: 60 },
  { region: "elbow", shape: "paired", y: 174, dx: 64 },
  { region: "back_of_forearm", shape: "paired", y: 204, dx: 68 },
  { region: "back_of_hand", shape: "paired", y: 256, dx: 76 },
  { region: "hip", shape: "paired", y: 222, dx: 38 },
  { region: "back_of_thigh", shape: "paired", y: 304, dx: 24 },
  { region: "back_of_knee", shape: "paired", y: 346, dx: 22 },
  { region: "calf", shape: "paired", y: 392, dx: 21 },
  { region: "ankle", shape: "paired", y: 434, dx: 21 },
  { region: "heel", shape: "paired", y: 456, dx: 23 },
  { region: "sole", shape: "paired", y: 471, dx: 27 },
];

export const BODY_REGIONS: Readonly<Record<BodyView, readonly RegionPlacement[]>> = {
  front: FRONT,
  back: BACK,
};

export const DRAWING = { width: 240, height: 480, centre: 120 } as const;

/** The sides a region can be on: paired regions left or right, central ones also the midline. */
export function regionSides(view: BodyView, region: string): readonly BodySide[] {
  const placement = BODY_REGIONS[view].find((r) => r.region === region);
  if (!placement) return [];
  return placement.shape === "paired" ? ["left", "right"] : ["left", "midline", "right"];
}

/**
 * Where the person's side of a region sits on the drawing, as seen by you. On the front view the
 * person's left is on your right; on the back view it is on your left.
 */
export function viewerX(view: BodyView, side: BodySide, dx: number): number {
  if (side === "midline") return DRAWING.centre;
  const onViewersRight = view === "front" ? side === "left" : side === "right";
  return DRAWING.centre + (onViewersRight ? dx : -dx);
}

export interface Hotspot {
  /** "knee:left": the region and the person's side, as drawn. */
  readonly value: string;
  readonly region: string;
  readonly side: BodySide;
  readonly x: number;
  readonly y: number;
}

/** Every spot on a view that can be tapped, one per region and side. */
export function hotspots(view: BodyView): Hotspot[] {
  return BODY_REGIONS[view].flatMap((placement) =>
    regionSides(view, placement.region).map((side) => ({
      value: regionValue(placement.region, side),
      region: placement.region,
      side,
      x: viewerX(view, side, placement.dx),
      y: placement.y,
    })),
  );
}

export function regionValue(region: string, side: BodySide): string {
  return `${region}:${side}`;
}

const SIDES: readonly BodySide[] = ["left", "right", "midline"];

/** "knee:left" as its region and side, or null when it is not a spot on that view. */
export function parseRegionValue(
  view: BodyView,
  value: string,
): { readonly region: string; readonly side: BodySide } | null {
  const colon = value.indexOf(":");
  if (colon <= 0) return null;
  const region = value.slice(0, colon);
  const side = value.slice(colon + 1) as BodySide;
  if (!SIDES.includes(side) || !regionSides(view, region).includes(side)) return null;
  return { region, side };
}

/** The spot nearest to a tap on the drawing, within reach of a fingertip, or null. */
export function nearestHotspot(view: BodyView, x: number, y: number, reach = 18): Hotspot | null {
  let best: Hotspot | null = null;
  let bestDistance = reach;
  for (const spot of hotspots(view)) {
    const distance = Math.hypot(spot.x - x, spot.y - y);
    if (distance <= bestDistance) {
      best = spot;
      bestDistance = distance;
    }
  }
  return best;
}
