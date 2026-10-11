import { sql } from "drizzle-orm";
import {
  type AnyPgColumn,
  boolean,
  date,
  foreignKey,
  index,
  integer,
  jsonb,
  numeric,
  pgTable,
  text,
  timestamp,
  unique,
  uuid,
} from "drizzle-orm/pg-core";
import { eventColumns, id, mutableColumns, tenantId } from "./_columns";
import { person } from "./people";
import { document, location } from "./platform";

/**
 * The point-of-care record (master prompt 10.1, docs/specs/care.md). Notes, chart observations and
 * body-map marks are append-only: a correction is a new row that supersedes the original with a
 * reason (Reg 17, hazard HZ-017). Ids may be generated on the device (UUIDv7) so offline uploads
 * are idempotent. Every row carries the event time, the device time and the server-received time.
 */

const personRef = (name: string, t: { tenantId: AnyPgColumn; personId: AnyPgColumn }) =>
  foreignKey({
    name,
    columns: [t.tenantId, t.personId],
    foreignColumns: [person.tenantId, person.id],
  });

const locationRef = (name: string, t: { tenantId: AnyPgColumn; locationId: AnyPgColumn }) =>
  foreignKey({
    name,
    columns: [t.tenantId, t.locationId],
    foreignColumns: [location.tenantId, location.id],
  });

/** Columns every append-only point-of-care entry shares. */
const entryColumns = () => ({
  id: id(),
  tenantId: tenantId(),
  personId: uuid("person_id").notNull(),
  /** The person's location when the entry was made (handover and round views). */
  locationId: uuid("location_id").notNull(),
  ...eventColumns(),
  deviceId: text("device_id"),
  /** Written more than `care_note.late_entry_hours` after the event (HZ-017). */
  lateEntry: boolean("late_entry").notNull().default(false),
  /** The device clock disagreed with the server by more than the tolerance (HZ-010). */
  clockDrift: boolean("clock_drift").notNull().default(false),
  supersedesId: uuid("supersedes_id"),
  correctionReason: text("correction_reason"),
});

export const personCareProfile = pgTable(
  "person_care_profile",
  {
    id: id(),
    tenantId: tenantId(),
    personId: uuid("person_id").notNull(),
    /** IDDSI food level: 3, 4, 5, 6, 7 or 7EC (HZ-016). */
    iddsiFoodLevel: text("iddsi_food_level"),
    /** IDDSI drink level: 0 to 4 (HZ-016). */
    iddsiDrinkLevel: text("iddsi_drink_level"),
    /** Who advised the levels, for example a speech and language therapist. */
    iddsiAdvisedBy: text("iddsi_advised_by"),
    iddsiChangedAt: timestamp("iddsi_changed_at", { withTimezone: true }),
    fluidTargetMl: integer("fluid_target_ml"),
    /** SpO2 scale 2 for NEWS2 only on a clinician's recorded decision (hypercapnic failure). */
    spo2Scale2: boolean("spo2_scale2").notNull().default(false),
    spo2Scale2Clinician: text("spo2_scale2_clinician"),
    spo2Scale2RecordedOn: date("spo2_scale2_recorded_on"),
    /** `not_at_risk`, `at_risk` or `high_risk`: sets the repositioning interval (rate table). */
    skinRisk: text("skin_risk").notNull().default("not_at_risk"),
    ...mutableColumns(),
  },
  (t) => [
    unique("person_care_profile_person_key").on(t.tenantId, t.personId),
    personRef("person_care_profile_person_fk", t),
  ],
);

export const careNote = pgTable(
  "care_note",
  {
    ...entryColumns(),
    /** personal_care, nutrition, mood, activity, visit, health, night, other. */
    category: text("category").notNull(),
    body: text("body").notNull(),
    tags: text("tags").array().notNull().default(sql`'{}'::text[]`),
    attachmentDocumentIds: uuid("attachment_document_ids")
      .array()
      .notNull()
      .default(sql`'{}'::uuid[]`),
  },
  (t) => [
    unique("care_note_tenant_id_id_key").on(t.tenantId, t.id),
    personRef("care_note_person_fk", t),
    locationRef("care_note_location_fk", t),
    index("care_note_person_idx").on(t.tenantId, t.personId, t.occurredAt),
    index("care_note_location_idx").on(t.tenantId, t.locationId, t.occurredAt),
  ],
);

export const observation = pgTable(
  "observation",
  {
    ...entryColumns(),
    /** fluid_intake, fluid_output, food, repositioning, bowel, weight, vitals (NEWS2 set). */
    chart: text("chart").notNull(),
    /** Typed per chart and validated by the API (packages/contracts). */
    values: jsonb("values").notNull(),
    /** Computed flags, for example NEWS2 component scores or an IDDSI mismatch. */
    flags: jsonb("flags").notNull().default(sql`'{}'::jsonb`),
  },
  (t) => [
    unique("observation_tenant_id_id_key").on(t.tenantId, t.id),
    personRef("observation_person_fk", t),
    locationRef("observation_location_fk", t),
    index("observation_person_chart_idx").on(t.tenantId, t.personId, t.chart, t.occurredAt),
    index("observation_location_idx").on(t.tenantId, t.locationId, t.occurredAt),
  ],
);

export const bodyMapMark = pgTable(
  "body_map_mark",
  {
    ...entryColumns(),
    view: text("view").notNull(),
    region: text("region").notNull(),
    /** The person's side, stated in words and checked against the drawing (HZ-019). */
    side: text("side").notNull(),
    markType: text("mark_type").notNull(),
    pressureCategory: text("pressure_category"),
    /** Pressure ulcers: caused by a medical device (counted separately in reporting). */
    deviceRelated: boolean("device_related"),
    /** Bruises: whether the cause is known; unexplained bruises prompt the safeguarding guide. */
    bruiseExplained: boolean("bruise_explained"),
    lengthMm: numeric("length_mm", { precision: 6, scale: 1 }),
    widthMm: numeric("width_mm", { precision: 6, scale: 1 }),
    depthMm: numeric("depth_mm", { precision: 6, scale: 1 }),
    description: text("description"),
    photoDocumentId: uuid("photo_document_id"),
    incidentId: uuid("incident_id"),
    /** `present` or `healed`; a healed mark is a new row superseding the open one. */
    status: text("status").notNull().default("present"),
  },
  (t) => [
    unique("body_map_mark_tenant_id_id_key").on(t.tenantId, t.id),
    personRef("body_map_mark_person_fk", t),
    locationRef("body_map_mark_location_fk", t),
    foreignKey({
      name: "body_map_mark_photo_fk",
      columns: [t.tenantId, t.photoDocumentId],
      foreignColumns: [document.tenantId, document.id],
    }),
    index("body_map_mark_person_idx").on(t.tenantId, t.personId, t.occurredAt),
  ],
);

/** Narrow view used by handover and the round: the latest state of a person's charts. */
export type CareNoteRow = typeof careNote.$inferSelect;
export type ObservationRow = typeof observation.$inferSelect;
export type BodyMapMarkRow = typeof bodyMapMark.$inferSelect;
export type PersonCareProfileRow = typeof personCareProfile.$inferSelect;
export const CARE_ENTRY_TABLES = ["care_note", "observation", "body_map_mark"] as const;
