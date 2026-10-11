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
