import { z } from "zod";
import { entryDowntimeInput, entryDowntimeOutput, entryInput, entryOutput } from "./entries";
import { EscalationPolicyRef } from "./escalation-policy";

/**
 * Point-of-care record contracts (master prompt 10.1, docs/specs/care.md): daily notes, chart
 * observations, body-map marks and the person's care profile. Ids may be generated on the device
 * (UUIDv7) so offline uploads are idempotent. Times are ISO 8601 with offset.
 */

const uuid = z.uuid();
const isoDateTime = z.iso.datetime({ offset: true });
const isoDate = z.iso.date();

export const CareNoteCategory = z
  .enum(["personal_care", "nutrition", "mood", "activity", "visit", "health", "night", "other"])
  .meta({ id: "CareNoteCategory" });

export const CreateCareNote = z
  .object({
    ...entryInput,
    ...entryDowntimeInput,
    category: CareNoteCategory,
    body: z.string().trim().min(1).max(4000),
    tags: z
      .array(z.string().regex(/^[a-z_]{2,40}$/))
      .max(10)
      .default([]),
    attachmentDocumentIds: z.array(uuid).max(10).default([]),
  })
  .meta({ id: "CreateCareNote" });
export type CreateCareNote = z.infer<typeof CreateCareNote>;

export const CareNoteItem = z
  .object({
    ...entryOutput,
    ...entryDowntimeOutput,
    category: CareNoteCategory,
    body: z.string(),
    tags: z.array(z.string()),
    attachmentDocumentIds: z.array(uuid),
  })
  .meta({ id: "CareNoteItem" });
export type CareNoteItem = z.infer<typeof CareNoteItem>;

export const CareNoteList = z.object({ items: z.array(CareNoteItem) }).meta({ id: "CareNoteList" });
export type CareNoteList = z.infer<typeof CareNoteList>;

const iddsiFood = z.enum(["3", "4", "5", "6", "7EC", "7"]);
const iddsiDrink = z.enum(["0", "1", "2", "3", "4"]);

/** Typed values per chart; the API validates them and computes flags. */
export const ObservationValues = z
  .discriminatedUnion("chart", [
    z.object({
      chart: z.literal("fluid_intake"),
      ml: z.number().int().min(0).max(5000),
      drink: z.string().trim().max(60).optional(),
      /**
       * The drink's IDDSI level as given. Required whenever the person has a drink level
       * prescribed (HZ-016): refused without it from the web; from a device the entry is kept,
       * flagged `level_not_recorded` and the nurse in charge alerted.
       */
      iddsiLevel: iddsiDrink.optional(),
      overrideReason: z.string().trim().max(300).optional(),
      refused: z.boolean().default(false),
    }),
    z.object({
      chart: z.literal("fluid_output"),
      ml: z.number().int().min(0).max(5000),
      kind: z.enum(["urine", "vomit", "drain", "other"]),
    }),
    z.object({
      chart: z.literal("food"),
      meal: z.enum(["breakfast", "lunch", "dinner", "supper", "snack"]),
      portion: z.enum(["none", "quarter", "half", "three_quarters", "all"]),
      iddsiLevel: iddsiFood,
      overrideReason: z.string().trim().max(300).optional(),
      description: z.string().trim().max(200).optional(),
      refused: z.boolean().default(false),
    }),
    z.object({
      chart: z.literal("repositioning"),
      position: z.enum(["left", "right", "back", "front", "sitting"]),
      skinChecked: z.boolean(),
      declined: z.boolean().default(false),
    }),
    z.object({
      chart: z.literal("bowel"),
      bristolType: z.number().int().min(1).max(7).nullable(),
      noMovement: z.boolean().default(false),
      amount: z.enum(["small", "medium", "large"]).optional(),
    }),
    z.object({
      chart: z.literal("weight"),
      kg: z.number().min(20).max(300),
      method: z.enum(["standing", "chair", "hoist", "bed"]),
    }),
    z.object({
      chart: z.literal("vitals"),
      respirationRate: z.number().int(),
      spo2: z.number().int(),
      onOxygen: z.boolean(),
      systolic: z.number().int(),
      pulse: z.number().int(),
      consciousness: z.enum(["alert", "new_confusion", "voice", "pain", "unresponsive"]),
      temperature: z.number(),
    }),
  ])
  .meta({ id: "ObservationValues" });
export type ObservationValues = z.infer<typeof ObservationValues>;

export const CreateObservation = z
  .object({ ...entryInput, ...entryDowntimeInput, values: ObservationValues })
  .meta({ id: "CreateObservation" });
export type CreateObservation = z.infer<typeof CreateObservation>;

export const ObservationItem = z
  .object({
    ...entryOutput,
    ...entryDowntimeOutput,
    chart: z.string(),
    values: z.record(z.string(), z.unknown()),
    /**
     * Computed: NEWS2 result and components, IDDSI comparison (`iddsi`, `iddsiAlert`, and
     * `iddsiProblem` when an entry from a device was kept despite a missing level or reason:
     * `level_not_recorded`, `reason_missing` or `prescribed_unreadable`), prompts raised.
     */
    flags: z.record(z.string(), z.unknown()),
    /**
     * Vital signs scored with NEWS2: the organisation's escalation policy for the score's band, or
     * that none is configured. Null for every other chart.
     */
    escalationPolicy: EscalationPolicyRef.nullable(),
  })
  .meta({ id: "ObservationItem" });
export type ObservationItem = z.infer<typeof ObservationItem>;

export const ObservationList = z
  .object({ items: z.array(ObservationItem) })
  .meta({ id: "ObservationList" });
export type ObservationList = z.infer<typeof ObservationList>;

export const FluidDay = z
  .object({
    date: isoDate,
    intakeMl: z.number().int(),
    outputMl: z.number().int(),
    targetMl: z.number().int().nullable(),
    /** Target minus intake so far; null when no target is set. */
    shortfallMl: z.number().int().nullable(),
    entries: z.number().int(),
    /**
     * Of the entries counted, those a device recorded deleting (`deviceDeletion` on the entry), and
     * the intake and output they add. They stay in the totals, flagged: show them beside the total
     * so staff check for duplicates (HZ-040; whether they should count is for the CSO, H-165).
     */
    flaggedEntries: z.number().int(),
    flaggedIntakeMl: z.number().int(),
    flaggedOutputMl: z.number().int(),
    /**
     * Drinks offered and refused that day, and the amount offered. A refused drink was not taken:
     * it is never in `intakeMl` or the shortfall; show the amount as offered (#26 review round 3;
     * whether to show it beside the total is for the CSO, H-167).
     */
    refusedEntries: z.number().int(),
    refusedOfferedMl: z.number().int(),
  })
  .meta({ id: "FluidDay", description: "Fluid balance for one UK calendar day (00:00 to 24:00)" });
export type FluidDay = z.infer<typeof FluidDay>;

export const BodyMarkType = z
  .enum([
    "bruise",
    "pressure_ulcer",
    "moisture_associated_skin_damage",
    "skin_tear",
    "laceration",
    "burn",
    "rash",
    "wound",
    "other",
  ])
  .meta({ id: "BodyMarkType" });

export const PressureUlcerCategory = z
  .enum([
    "category_1",
    "category_2",
    "category_3",
    "category_4",
    "unstageable",
    "deep_tissue_injury",
  ])
  .meta({ id: "PressureUlcerCategory" });

/** Where on the body map drawing, as the person recording saw it. */
export const BodyMapViewerZone = z.enum(["viewer_left", "centre", "viewer_right"]).meta({
  id: "BodyMapViewerZone",
  description:
    "The left of the drawing, its centre band, or its right, as the person recording saw it",
});

/**
 * A point on the body map drawing in its own units (`BODY_MAP_DRAWING` in packages/domain): 120
 * wide and 240 high, x from the viewer's left edge and y from the top, on the view named. A screen
 * drawn at another size scales its point to these units.
 */
export const BodyMapPoint = z
  .object({ x: z.number().min(0).max(120), y: z.number().min(0).max(240) })
  .meta({ id: "BodyMapPoint" });
export type BodyMapPoint = z.infer<typeof BodyMapPoint>;

export const CreateBodyMapMark = z
  .object({
    ...entryInput,
    ...entryDowntimeInput,
    view: z.enum(["front", "back"]),
    region: z.string().regex(/^[a-z_]{2,40}$/),
    /**
     * Where the mark was placed on the drawing. The server works out the person's side from it and
     * the view, and refuses a mark whose `side` disagrees (HZ-019). Send it, or `drawnZone`.
     */
    drawnAt: BodyMapPoint.optional(),
    /**
     * The zone of the drawing chosen with the buttons beside it (screen readers), when no point
     * was tapped; with `drawnAt` it must agree with the point.
     */
    drawnZone: BodyMapViewerZone.optional(),
    /**
     * The side the device worked out from the drawing. With `drawnAt` or `drawnZone` the server
     * works the side out itself and refuses a mark whose `drawnSide` disagrees. Sent alone (a phone
     * from before the server read the drawing), it is read as the zone it names on the view and
     * the mark is flagged `drawnFromDeviceSide`.
     */
    drawnSide: z.enum(["left", "right", "midline"]).optional(),
    side: z.enum(["left", "right", "midline"]),
    markType: BodyMarkType,
    pressureCategory: PressureUlcerCategory.optional(),
    /** Pressure ulcers: caused by a medical device (reported separately). */
    deviceRelated: z.boolean().optional(),
    /** Bruises: whether the cause is known; an unexplained bruise prompts the safeguarding guide. */
    bruiseExplained: z.boolean().optional(),
    lengthMm: z.number().min(0).max(1000).optional(),
    widthMm: z.number().min(0).max(1000).optional(),
    depthMm: z.number().min(0).max(300).optional(),
    description: z.string().trim().max(1000).optional(),
    photoDocumentId: uuid.optional(),
    status: z.enum(["present", "healed"]).default("present"),
    /** The incident the mark is recorded for (safety.md section 2); the person must be on it. */
    incidentId: uuid.optional(),
  })
  .meta({ id: "CreateBodyMapMark" });
export type CreateBodyMapMark = z.infer<typeof CreateBodyMapMark>;

export const BodyMapMarkItem = z
  .object({
    ...entryOutput,
    ...entryDowntimeOutput,
    view: z.enum(["front", "back"]),
    region: z.string(),
    side: z.enum(["left", "right", "midline"]),
    /**
     * The person's side where the mark was drawn, as the server worked it out from the drawing;
     * null for marks recorded before the server did (HZ-019).
     */
    drawnSide: z.enum(["left", "right", "midline"]).nullable(),
    /**
     * True when the place on the drawing was taken from the side a phone said it drew (an app from
     * before the server read the drawing sent no point or zone; HZ-019): show that the side was
     * not checked against a place on the drawing.
     */
    drawnFromDeviceSide: z.boolean(),
    markType: BodyMarkType,
    pressureCategory: PressureUlcerCategory.nullable(),
    lengthMm: z.number().nullable(),
    widthMm: z.number().nullable(),
    depthMm: z.number().nullable(),
    description: z.string().nullable(),
    photoDocumentId: uuid.nullable(),
    status: z.enum(["present", "healed"]),
    incidentId: uuid.nullable(),
  })
  .meta({ id: "BodyMapMarkItem" });
export type BodyMapMarkItem = z.infer<typeof BodyMapMarkItem>;

export const BodyMapMarkList = z
  .object({ items: z.array(BodyMapMarkItem) })
  .meta({ id: "BodyMapMarkList" });
export type BodyMapMarkList = z.infer<typeof BodyMapMarkList>;

export const PersonCareProfile = z
  .object({
    personId: uuid,
    iddsiFoodLevel: iddsiFood.nullable(),
    iddsiDrinkLevel: iddsiDrink.nullable(),
    iddsiAdvisedBy: z.string().nullable(),
    iddsiChangedAt: isoDateTime.nullable(),
    fluidTargetMl: z.number().int().nullable(),
    spo2Scale2: z.boolean(),
    spo2Scale2Clinician: z.string().nullable(),
    spo2Scale2RecordedOn: isoDate.nullable(),
    skinRisk: z.enum(["not_at_risk", "at_risk", "high_risk"]),
    version: z.number().int(),
  })
  .meta({ id: "PersonCareProfile" });
export type PersonCareProfile = z.infer<typeof PersonCareProfile>;

export const UpdatePersonCareProfile = z
  .object({
    iddsiFoodLevel: iddsiFood.nullable().optional(),
    iddsiDrinkLevel: iddsiDrink.nullable().optional(),
    /** Required when an IDDSI level changes: who advised it (HZ-016). */
    iddsiAdvisedBy: z.string().trim().min(3).max(120).optional(),
    fluidTargetMl: z.number().int().min(500).max(4000).nullable().optional(),
    spo2Scale2: z.boolean().optional(),
    /** Required to switch scale 2 on: the clinician who decided it. */
    spo2Scale2Clinician: z.string().trim().min(3).max(120).optional(),
    spo2Scale2RecordedOn: isoDate.optional(),
    skinRisk: z.enum(["not_at_risk", "at_risk", "high_risk"]).optional(),
    /** The version read; 0 when no profile exists yet. */
    version: z.number().int().min(0),
  })
  .meta({ id: "UpdatePersonCareProfile" });
export type UpdatePersonCareProfile = z.infer<typeof UpdatePersonCareProfile>;
