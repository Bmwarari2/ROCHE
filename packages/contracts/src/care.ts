import { z } from "zod";

/**
 * Point-of-care record contracts (master prompt 10.1, docs/specs/care.md): daily notes, chart
 * observations, body-map marks and the person's care profile. Ids may be generated on the device
 * (UUIDv7) so offline uploads are idempotent. Times are ISO 8601 with offset.
 */

const uuid = z.uuid();
const isoDateTime = z.iso.datetime({ offset: true });
const isoDate = z.iso.date();

/** Fields every append-only entry shares when it is written. */
const entryInput = {
  /** Device-generated UUIDv7; a replayed upload with the same id is ignored. */
  id: uuid.optional(),
  occurredAt: isoDateTime,
  /** The device clock when the entry was made (for late-entry and clock-drift flags). */
  deviceTime: isoDateTime.optional(),
  supersedesId: uuid.optional(),
  correctionReason: z.string().trim().min(3).max(500).optional(),
  /** A task this entry completes (for example the 02:00 turn), as its evidence. */
  taskId: uuid.optional(),
};

const entryOutput = {
  id: uuid,
  personId: uuid,
  locationId: uuid,
  occurredAt: isoDateTime,
  recordedAt: isoDateTime,
  deviceTime: isoDateTime.nullable(),
  lateEntry: z.boolean(),
  clockDrift: z.boolean(),
  supersedesId: uuid.nullable(),
  correctionReason: z.string().nullable(),
  /** True when a later entry supersedes this one. */
  superseded: z.boolean(),
  recordedBy: uuid.nullable(),
};

export const CareNoteCategory = z
  .enum(["personal_care", "nutrition", "mood", "activity", "visit", "health", "night", "other"])
  .meta({ id: "CareNoteCategory" });

export const CreateCareNote = z
  .object({
    ...entryInput,
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
  .object({ ...entryInput, values: ObservationValues })
  .meta({ id: "CreateObservation" });
export type CreateObservation = z.infer<typeof CreateObservation>;

export const ObservationItem = z
  .object({
    ...entryOutput,
    chart: z.string(),
    values: z.record(z.string(), z.unknown()),
    /** Computed: NEWS2 result and components, IDDSI comparison, prompts raised. */
    flags: z.record(z.string(), z.unknown()),
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

export const CreateBodyMapMark = z
  .object({
    ...entryInput,
    view: z.enum(["front", "back"]),
    region: z.string().regex(/^[a-z_]{2,40}$/),
    /** The side as drawn (from the tap position); must agree with `side` (HZ-019). */
    drawnSide: z.enum(["left", "right", "midline"]),
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
  })
  .meta({ id: "CreateBodyMapMark" });
export type CreateBodyMapMark = z.infer<typeof CreateBodyMapMark>;

export const BodyMapMarkItem = z
  .object({
    ...entryOutput,
    view: z.enum(["front", "back"]),
    region: z.string(),
    side: z.enum(["left", "right", "midline"]),
    markType: BodyMarkType,
    pressureCategory: PressureUlcerCategory.nullable(),
    lengthMm: z.number().nullable(),
    widthMm: z.number().nullable(),
    depthMm: z.number().nullable(),
    description: z.string().nullable(),
    photoDocumentId: uuid.nullable(),
    status: z.enum(["present", "healed"]),
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
