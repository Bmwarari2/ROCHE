/**
 * Body map marks (care.md section 4 rule 7; hazard HZ-019). Every region is on the front or back
 * view, and sides are always the person's own left and right: on the front view the person's left
 * is on the viewer's right, on the back view it is on the viewer's left. Staff choose the side in
 * words as well as on the drawing, and a mark cannot be saved until the two agree.
 *
 * Pressure ulcer categories follow NPIAP, EPUAP and PPPIA (International guideline, 2019) as
 * adopted by NHS Improvement (Pressure ulcers: revised definition and measurement, 2018): category
 * 1 to 4, unstageable and deep tissue injury. Device-related pressure ulcers are categorised the
 * same way and flagged; moisture-associated skin damage is a separate mark type, never a category.
 * Category 2 or worse, or an unexplained bruise, prompts an incident report and the safeguarding
 * decision guide (see safety.md).
 */

import type { CareTrigger, InputIssue } from "./assessment";

export type BodyView = "front" | "back";
export type BodySide = "left" | "right" | "midline";

/** Paired regions are always on one side; central regions may also be on the midline. */
type RegionShape = "paired" | "central";

const REGIONS = {
  front: {
    head: ["Head", "central"],
    face: ["Face", "central"],
    ear: ["Ear", "paired"],
    neck: ["Neck", "central"],
    shoulder: ["Shoulder", "paired"],
    chest: ["Chest", "central"],
    breast: ["Breast", "paired"],
    abdomen: ["Abdomen", "central"],
    groin: ["Groin", "central"],
    genitals: ["Genitals", "central"],
    upper_arm: ["Upper arm", "paired"],
    inner_elbow: ["Inner elbow", "paired"],
    forearm: ["Forearm", "paired"],
    wrist: ["Wrist", "paired"],
    hand: ["Hand (palm)", "paired"],
    hip: ["Hip", "paired"],
    thigh: ["Thigh", "paired"],
    knee: ["Knee", "paired"],
    shin: ["Shin", "paired"],
    ankle: ["Ankle", "paired"],
    foot: ["Foot (top)", "paired"],
    toes: ["Toes", "paired"],
  },
  back: {
    back_of_head: ["Back of head", "central"],
    ear: ["Ear", "paired"],
    back_of_neck: ["Back of neck", "central"],
    shoulder_blade: ["Shoulder blade", "paired"],
    upper_back: ["Upper back", "central"],
    spine: ["Spine", "central"],
    lower_back: ["Lower back", "central"],
    sacrum: ["Sacrum", "central"],
    coccyx: ["Coccyx", "central"],
    buttock: ["Buttock", "paired"],
    back_of_upper_arm: ["Back of upper arm", "paired"],
    elbow: ["Elbow", "paired"],
    back_of_forearm: ["Back of forearm", "paired"],
    back_of_hand: ["Back of hand", "paired"],
    hip: ["Hip", "paired"],
    back_of_thigh: ["Back of thigh", "paired"],
    back_of_knee: ["Back of knee", "paired"],
    calf: ["Calf", "paired"],
    ankle: ["Ankle", "paired"],
    heel: ["Heel", "paired"],
    sole: ["Sole of foot", "paired"],
  },
} as const satisfies Record<BodyView, Record<string, readonly [string, RegionShape]>>;

export type FrontRegion = keyof (typeof REGIONS)["front"];
export type BackRegion = keyof (typeof REGIONS)["back"];

export interface BodyRegion {
  /** For example `back.sacrum`. */
  readonly code: string;
  readonly view: BodyView;
  readonly region: string;
  readonly label: string;
  readonly sides: readonly BodySide[];
}

const SIDES: Readonly<Record<RegionShape, readonly BodySide[]>> = {
  paired: ["left", "right"],
  central: ["left", "right", "midline"],
};

export const BODY_MAP_REGIONS: readonly BodyRegion[] = (
  Object.entries(REGIONS) as [BodyView, Record<string, readonly [string, RegionShape]>][]
).flatMap(([view, regions]) =>
  Object.entries(regions).map(([region, [label, shape]]) => ({
    code: `${view}.${region}`,
    view,
    region,
    label,
    sides: SIDES[shape],
  })),
);

export function findBodyRegion(view: BodyView, region: string): BodyRegion | undefined {
  return BODY_MAP_REGIONS.find((r) => r.view === view && r.region === region);
}

/**
 * The person's side for a point on the drawing. The front view faces the viewer, so the viewer's
 * left is the person's right; the back view faces away, so the two agree.
 */
export function personSideFromDrawing(
  view: BodyView,
  viewerSide: "viewer_left" | "viewer_right" | "centre",
): BodySide {
  if (viewerSide === "centre") return "midline";
  const viewerLeft = viewerSide === "viewer_left";
  if (view === "front") return viewerLeft ? "right" : "left";
  return viewerLeft ? "left" : "right";
}

/** Where on the drawing, as the person recording sees it: its left, its centre band, its right. */
export type ViewerZone = "viewer_left" | "centre" | "viewer_right";

export const VIEWER_ZONES: readonly ViewerZone[] = ["viewer_left", "centre", "viewer_right"];

/**
 * The body map drawing every Harbour screen places marks on, in its own units: 120 wide and 240
 * high, x from the viewer's left edge and y from the top, the same on the front and back views
 * (HZ-019; clinical review C5 of #15). The body's midline is x = 60. A narrow centre band,
 * `centreHalfWidth` either side of it, exists only over the head, neck and trunk (above
 * `legsTop`, where the legs begin), so a mark on a leg or an arm is always on a side. Screens
 * drawn at another size scale their points to these units before sending them.
 */
export const BODY_MAP_DRAWING = {
  width: 120,
  height: 240,
  midline: 60,
  legsTop: 124,
  centreHalfWidth: 4,
} as const;

/** A point on the body map drawing, in `BODY_MAP_DRAWING` units. */
export interface DrawnPoint {
  readonly x: number;
  readonly y: number;
}

/** True when the point is on the drawing (its edges included). */
export function onDrawing(point: DrawnPoint): boolean {
  return (
    Number.isFinite(point.x) &&
    Number.isFinite(point.y) &&
    point.x >= 0 &&
    point.x <= BODY_MAP_DRAWING.width &&
    point.y >= 0 &&
    point.y <= BODY_MAP_DRAWING.height
  );
}

/**
 * Which zone of the drawing a point falls in: split at the body's midline, with the narrow centre
 * band over the central areas only. A point on the midline below the trunk reads as the viewer's
 * right, as the phone has always read it.
 */
export function zoneAtPoint(point: DrawnPoint): ViewerZone {
  const central = point.y < BODY_MAP_DRAWING.legsTop;
  if (central && Math.abs(point.x - BODY_MAP_DRAWING.midline) <= BODY_MAP_DRAWING.centreHalfWidth) {
    return "centre";
  }
  return point.x < BODY_MAP_DRAWING.midline ? "viewer_left" : "viewer_right";
}

/** How a mark was placed: a point on the drawing, or a zone chosen with the buttons beside it. */
export interface DrawnPlace {
  readonly point?: DrawnPoint | null;
  readonly zone?: ViewerZone | null;
}

export type DrawnSideCheck =
  | { readonly ok: true; readonly zone: ViewerZone; readonly side: BodySide }
  | { readonly ok: false; readonly message: string };

/**
 * The person's side where a mark was drawn, worked out from the place on the drawing and the view
 * (HZ-019): the server never takes the side a device says it drew, it works it out again. A point
 * wins over a zone; when both are given they must agree. With neither there is no drawing to
 * check the side in words against.
 */
export function sideFromDrawing(view: BodyView, place: DrawnPlace): DrawnSideCheck {
  const point = place.point ?? null;
  const zone = place.zone ?? null;
  if (point) {
    if (!onDrawing(point)) {
      return { ok: false, message: "The place marked is not on the body map drawing." };
    }
    const found = zoneAtPoint(point);
    if (zone && zone !== found) {
      return {
        ok: false,
        message: "The place marked on the drawing and the side of the drawing chosen disagree.",
      };
    }
    return { ok: true, zone: found, side: personSideFromDrawing(view, found) };
  }
  if (zone) {
    if (!VIEWER_ZONES.includes(zone)) {
      return { ok: false, message: "Choose a side of the drawing." };
    }
    return { ok: true, zone, side: personSideFromDrawing(view, zone) };
  }
  return {
    ok: false,
    message: "Mark the place on the body map drawing, so the side can be checked.",
  };
}

export type PressureUlcerCategory =
  | "category_1"
  | "category_2"
  | "category_3"
  | "category_4"
  | "unstageable"
  | "deep_tissue_injury";

export const PRESSURE_ULCER_CATEGORIES: Readonly<Record<PressureUlcerCategory, string>> = {
  category_1: "Category 1: non-blanchable erythema of intact skin",
  category_2: "Category 2: partial-thickness skin loss with exposed dermis",
  category_3: "Category 3: full-thickness skin loss",
  category_4: "Category 4: full-thickness skin and tissue loss",
  unstageable: "Unstageable: obscured full-thickness skin and tissue loss",
  deep_tissue_injury:
    "Deep tissue injury: persistent non-blanchable deep red, maroon or purple discolouration",
};

/** Category 2 or worse: unstageable and deep tissue injury count as worse than category 2. */
const CATEGORY_2_OR_WORSE: readonly PressureUlcerCategory[] = [
  "category_2",
  "category_3",
  "category_4",
  "unstageable",
  "deep_tissue_injury",
];

export type BodyMarkType =
  | "bruise"
  | "pressure_ulcer"
  | "moisture_associated_skin_damage"
  | "skin_tear"
  | "laceration"
  | "burn"
  | "rash"
  | "wound"
  | "other";

const MARK_TYPES: readonly BodyMarkType[] = [
  "bruise",
  "pressure_ulcer",
  "moisture_associated_skin_damage",
  "skin_tear",
  "laceration",
  "burn",
  "rash",
  "wound",
  "other",
];

export interface BodyMarkInput {
  readonly view: BodyView;
  readonly region: string;
  /** The person's side derived from where the mark was drawn (see personSideFromDrawing). */
  readonly drawnSide: BodySide;
  /** The side staff chose in words. */
  readonly statedSide: BodySide;
  readonly markType: BodyMarkType;
  /** Pressure ulcers only. */
  readonly pressureUlcerCategory?: PressureUlcerCategory | null;
  /** Pressure ulcers only: caused by a medical device, recorded separately for reporting. */
  readonly deviceRelated?: boolean | null;
  /** Bruises only: whether the cause is known and recorded. */
  readonly bruiseExplained?: boolean | null;
}

export type BodyMarkCheck =
  | { readonly ok: true; readonly code: string; readonly triggers: readonly CareTrigger[] }
  | { readonly ok: false; readonly issues: readonly InputIssue[] };

const SIDE_WORDS: Readonly<Record<BodySide, string>> = {
  left: "the person's left",
  right: "the person's right",
  midline: "the midline",
};

/** Validates a body map mark before saving (HZ-019) and returns the prompts it raises. */
export function validateMark(mark: BodyMarkInput): BodyMarkCheck {
  const issues: InputIssue[] = [];
  const add = (item: string, problem: InputIssue["problem"], message: string) =>
    issues.push({ item, problem, message });

  const region = findBodyRegion(mark.view, mark.region);
  if (!region) {
    add("region", "not_allowed", `Choose a body area shown on the ${mark.view} view.`);
  } else if (!region.sides.includes(mark.statedSide)) {
    add("statedSide", "not_allowed", `${region.label} must be on the person's left or right.`);
  }
  if (mark.drawnSide !== mark.statedSide) {
    add(
      "statedSide",
      "not_allowed",
      `The mark is drawn on ${SIDE_WORDS[mark.drawnSide]} but ${SIDE_WORDS[mark.statedSide]} was chosen. Check the side and try again.`,
    );
  }
  if (!MARK_TYPES.includes(mark.markType)) {
    add("markType", "not_allowed", "Choose a type of mark from the list.");
  }

  const isPressureUlcer = mark.markType === "pressure_ulcer";
  const category = mark.pressureUlcerCategory ?? null;
  if (isPressureUlcer && category === null) {
    add("pressureUlcerCategory", "missing", "Pressure ulcer category is missing.");
  } else if (isPressureUlcer && !Object.hasOwn(PRESSURE_ULCER_CATEGORIES, category as string)) {
    add("pressureUlcerCategory", "not_allowed", "Choose a pressure ulcer category from the list.");
  } else if (!isPressureUlcer && category !== null) {
    add(
      "pressureUlcerCategory",
      "not_allowed",
      mark.markType === "moisture_associated_skin_damage"
        ? "Moisture-associated skin damage is recorded separately and has no pressure ulcer category."
        : "Only a pressure ulcer has a category.",
    );
  }
  if (isPressureUlcer && (mark.deviceRelated === null || mark.deviceRelated === undefined)) {
    add(
      "deviceRelated",
      "missing",
      "Say whether the pressure ulcer is related to a medical device.",
    );
  } else if (!isPressureUlcer && mark.deviceRelated !== null && mark.deviceRelated !== undefined) {
    add("deviceRelated", "not_allowed", "Device-related is recorded for pressure ulcers only.");
  }
  const isBruise = mark.markType === "bruise";
  if (isBruise && (mark.bruiseExplained === null || mark.bruiseExplained === undefined)) {
    add("bruiseExplained", "missing", "Say whether the cause of the bruise is known.");
  } else if (!isBruise && mark.bruiseExplained !== null && mark.bruiseExplained !== undefined) {
    add(
      "bruiseExplained",
      "not_allowed",
      "Whether the cause is known is recorded for bruises only.",
    );
  }
  if (issues.length > 0) return { ok: false, issues };

  return {
    ok: true,
    code: `${mark.view}.${mark.region}`,
    triggers: markTriggers(mark),
  };
}

/**
 * A pressure ulcer of category 2 or worse, or an unexplained bruise, prompts an incident report and
 * the safeguarding decision guide.
 */
export function markTriggers(
  mark: Pick<BodyMarkInput, "markType" | "pressureUlcerCategory" | "bruiseExplained">,
): CareTrigger[] {
  let reason: string | null = null;
  if (
    mark.markType === "pressure_ulcer" &&
    mark.pressureUlcerCategory &&
    CATEGORY_2_OR_WORSE.includes(mark.pressureUlcerCategory)
  ) {
    reason = `Pressure ulcer: ${PRESSURE_ULCER_CATEGORIES[mark.pressureUlcerCategory]}`;
  } else if (mark.markType === "bruise" && mark.bruiseExplained === false) {
    reason = "Unexplained bruise";
  }
  if (reason === null) return [];
  return [
    { kind: "task", task: "incident_report", reason },
    { kind: "task", task: "safeguarding_decision_guide", reason },
  ];
}
