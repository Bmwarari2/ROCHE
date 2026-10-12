/**
 * Body map marks offline (care.md section 4 rule 7; register CARE-012; hazard HZ-019). The carer
 * marks the place on the drawing and also chooses the side in words; the mark cannot be saved until
 * the two agree. Sides are always the person's own: on the front view the drawing faces the carer,
 * so the person's left is on the carer's right. The rules are `sideFromDrawing` and
 * `validateMark` from `@harbour/domain`. The device sends the place drawn (the point tapped, or the
 * zone chosen with the buttons) and the API works the side out again from it and the view, so the
 * check never rests on the side the device says it drew.
 */
import {
  BODY_MAP_DRAWING,
  BODY_MAP_REGIONS,
  type BodyMarkType,
  type BodyRegion,
  type BodySide,
  type BodyView,
  VIEWER_ZONES as DOMAIN_VIEWER_ZONES,
  type ViewerZone as DomainViewerZone,
  type DrawnPoint,
  findBodyRegion,
  markTriggers,
  PRESSURE_ULCER_CATEGORIES,
  type PressureUlcerCategory,
  personSideFromDrawing,
  sideFromDrawing,
  validateMark,
  zoneAtPoint,
  zoneForPersonSide,
} from "@harbour/domain";
import {
  type Correction,
  checkCorrectionReason,
  type EntryContext,
  type EntryRow,
  entryRow,
  type FieldError,
} from "./entries";
import { resolveOccurredAt, type WhenChoice } from "./time";

export type ViewerZone = DomainViewerZone;
export type { DrawnPoint };

export const VIEWER_ZONES: readonly ViewerZone[] = DOMAIN_VIEWER_ZONES;
export const BODY_VIEWS: readonly BodyView[] = ["front", "back"];
export const MARK_TYPES: readonly BodyMarkType[] = [
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
export const PRESSURE_CATEGORIES = Object.keys(
  PRESSURE_ULCER_CATEGORIES,
) as PressureUlcerCategory[];

/** API limit from `@harbour/contracts` (`CreateBodyMapMark.description`). */
export const MARK_DESCRIPTION_MAX = 1000;

/** The person's side for a zone of the drawing on a view (HZ-019). */
export function drawnSide(view: BodyView, zone: ViewerZone): BodySide {
  return personSideFromDrawing(view, zone);
}

/**
 * The zone of the drawing that reads as a side on a view, as the API reads it (`zoneForPersonSide`):
 * the inverse of `drawnSide`. Used for an entry queued before the device stored the zone, which
 * kept only the side it worked out.
 */
export function zoneForSide(view: BodyView, side: BodySide): ViewerZone | null {
  return zoneForPersonSide(view, side);
}

/**
 * The drawing's own coordinates (the SVG viewBox, 120 by 240), shared with the web and the API
 * (`BODY_MAP_DRAWING`). The body's midline is x = 60; the head, neck and trunk end where the legs
 * begin.
 */
export const DRAWING = {
  width: BODY_MAP_DRAWING.width,
  height: BODY_MAP_DRAWING.height,
  midline: BODY_MAP_DRAWING.midline,
  legsTop: BODY_MAP_DRAWING.legsTop,
} as const;

/**
 * Half the width of the centre band, in drawing units. It exists only over the central areas
 * (head, neck and trunk), so a mark on a leg or an arm is always on a side (clinical review C5).
 */
export const CENTRE_HALF_WIDTH = BODY_MAP_DRAWING.centreHalfWidth;

/**
 * Which zone of the drawing a point falls in: split at the body's midline, with a narrow centre
 * band over the central areas only. On the front view the person's left leg is on the carer's
 * right, so it falls in `viewer_right`, which reads as the person's left. The API reads the point
 * the same way (`zoneAtPoint` in `@harbour/domain`).
 */
export function zoneAt(point: DrawnPoint): ViewerZone {
  return zoneAtPoint(point);
}

/**
 * Converts a tap on the drawing's frame (in points) to drawing units, for an SVG scaled to fit
 * and centred ("xMidYMid meet"). Null outside the drawing.
 */
export function toDrawing(
  tap: { readonly x: number; readonly y: number },
  frame: { readonly width: number; readonly height: number },
): { readonly x: number; readonly y: number } | null {
  if (frame.width <= 0 || frame.height <= 0) return null;
  const scale = Math.min(frame.width / DRAWING.width, frame.height / DRAWING.height);
  const x = (tap.x - (frame.width - DRAWING.width * scale) / 2) / scale;
  const y = (tap.y - (frame.height - DRAWING.height * scale) / 2) / scale;
  if (x < 0 || x > DRAWING.width || y < 0 || y > DRAWING.height) return null;
  return { x, y };
}

/** Body areas on a view, in the domain's order. */
export function regionsFor(view: BodyView): readonly BodyRegion[] {
  return BODY_MAP_REGIONS.filter((r) => r.view === view);
}

export interface MarkDraft {
  readonly view: BodyView;
  readonly zone: ViewerZone | null;
  /**
   * Where on the drawing the carer tapped, in drawing units; null or absent when the zone was
   * chosen with the buttons beside the drawing. Sent so the API works out the side itself.
   */
  readonly point?: DrawnPoint | null;
  readonly region: string | null;
  readonly side: BodySide | null;
  readonly markType: BodyMarkType | null;
  readonly pressureCategory: PressureUlcerCategory | null;
  readonly deviceRelated: boolean | null;
  readonly bruiseExplained: boolean | null;
  readonly description: string;
  readonly when: WhenChoice;
  readonly correction: Correction | null;
}

export type MarkField =
  | "zone"
  | "region"
  | "side"
  | "markType"
  | "pressureCategory"
  | "deviceRelated"
  | "bruiseExplained"
  | "when"
  | "reason";

export type MarkCheck =
  | { readonly ok: true; readonly row: EntryRow; readonly prompts: boolean }
  | { readonly ok: false; readonly errors: Partial<Record<MarkField, FieldError>> };

/** The side words for messages: "the person's left". */
export type SideWords = (side: BodySide) => string;

export function checkMark(
  draft: MarkDraft,
  context: EntryContext,
  now: Date,
  sideWords: SideWords,
): MarkCheck {
  const errors: Partial<Record<MarkField, FieldError>> = {};
  const point = draft.point ?? null;
  // The same reading of the drawing the API makes on upload: a point that is off the drawing, or
  // that disagrees with the zone, is asked for again rather than sent.
  const place = draft.zone ? sideFromDrawing(draft.view, { point, zone: draft.zone }) : null;
  if (!place?.ok) errors.zone = { key: "mobile.bodyMap.drawingRequired" };
  if (!draft.region || !findBodyRegion(draft.view, draft.region)) {
    errors.region = { key: "mobile.bodyMap.regionRequired" };
  }
  if (!draft.side) errors.side = { key: "mobile.bodyMap.sideRequired" };
  if (!draft.markType) errors.markType = { key: "mobile.bodyMap.markTypeRequired" };
  const when = resolveOccurredAt(
    draft.when,
    now,
    context.windowDays,
    context.clockToleranceMinutes ?? 0,
  );
  if (!when.ok) errors.when = { key: when.error };
  if (draft.correction) {
    const reason = checkCorrectionReason(draft.correction.reason);
    if (reason) errors.reason = reason;
  }
  if (draft.markType === "pressure_ulcer") {
    if (!draft.pressureCategory)
      errors.pressureCategory = { key: "mobile.bodyMap.categoryRequired" };
    if (draft.deviceRelated === null)
      errors.deviceRelated = { key: "mobile.bodyMap.answerRequired" };
  }
  if (draft.markType === "bruise" && draft.bruiseExplained === null) {
    errors.bruiseExplained = { key: "mobile.bodyMap.answerRequired" };
  }

  if (place?.ok && draft.region && draft.side && draft.markType && !errors.region) {
    const drawn = place.side;
    const isUlcer = draft.markType === "pressure_ulcer";
    const isBruise = draft.markType === "bruise";
    const check = validateMark({
      view: draft.view,
      region: draft.region,
      drawnSide: drawn,
      statedSide: draft.side,
      markType: draft.markType,
      pressureUlcerCategory: isUlcer ? draft.pressureCategory : null,
      deviceRelated: isUlcer ? draft.deviceRelated : null,
      bruiseExplained: isBruise ? draft.bruiseExplained : null,
    });
    if (!check.ok) {
      const region = findBodyRegion(draft.view, draft.region);
      if (drawn !== draft.side) {
        errors.side = {
          key: "mobile.bodyMap.mismatch",
          values: { drawn: sideWords(drawn), stated: sideWords(draft.side) },
        };
      } else if (region && !region.sides.includes(draft.side)) {
        errors.side = { key: "mobile.bodyMap.sideNotAllowed", values: { region: region.label } };
      }
    }
  }

  const description = draft.description.trim();
  if (
    Object.keys(errors).length > 0 ||
    !when.ok ||
    !place?.ok ||
    !draft.region ||
    !draft.side ||
    !draft.markType
  ) {
    return { ok: false, errors };
  }
  const isUlcer = draft.markType === "pressure_ulcer";
  const isBruise = draft.markType === "bruise";
  const boolean = (value: boolean | null) => (value === null ? null : value ? 1 : 0);
  return {
    ok: true,
    prompts:
      markTriggers({
        markType: draft.markType,
        pressureUlcerCategory: isUlcer ? draft.pressureCategory : null,
        bruiseExplained: isBruise ? draft.bruiseExplained : null,
      }).length > 0,
    row: {
      ...entryRow(context, when.occurredAt, now, draft.correction),
      view: draft.view,
      region: draft.region,
      side: draft.side,
      drawn_side: place.side,
      drawn_zone: place.zone,
      drawn_x: point ? point.x : null,
      drawn_y: point ? point.y : null,
      mark_type: draft.markType,
      pressure_category: isUlcer ? draft.pressureCategory : null,
      device_related: isUlcer ? boolean(draft.deviceRelated) : null,
      bruise_explained: isBruise ? boolean(draft.bruiseExplained) : null,
      length_mm: null,
      width_mm: null,
      depth_mm: null,
      description: description ? description.slice(0, MARK_DESCRIPTION_MAX) : null,
      status: "present",
    },
  };
}
