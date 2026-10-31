import { sql } from "drizzle-orm";
import {
  type AnyPgColumn,
  boolean,
  check,
  date,
  doublePrecision,
  foreignKey,
  index,
  integer,
  jsonb,
  numeric,
  pgTable,
  text,
  time,
  timestamp,
  unique,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import {
  createdColumns,
  eventColumns,
  id,
  mutableColumns,
  searchVector,
  tenantId,
} from "./_columns";
import { outage } from "./operations";
import { contact, person } from "./people";
import { document, location, tenantUser } from "./platform";
import { incident } from "./safety";
import { taskSeries } from "./work";

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
  /**
   * Accepted after the person left or died, for an event at or before then (people.md rule 3,
   * HZ-006): for example observations a phone recorded offline before a death.
   */
  recordedAfterExit: boolean("recorded_after_exit").notNull().default(false),
  /** The task the entry named (for example the 02:00 turn), whatever happened to it. */
  taskId: uuid("task_id"),
  /**
   * What the entry did to that task (`TASK_LINK_OUTCOMES`): completed it, was kept as late evidence
   * for a cancelled task, or was kept unlinked or after the task closed and flagged for review;
   * for a medicines task it could not complete, kept with an urgent conflict review (HZ-004,
   * HZ-006). Null when the entry named no task.
   */
  taskOutcome: text("task_outcome"),
  supersedesId: uuid("supersedes_id"),
  correctionReason: text("correction_reason"),
});

export const TASK_LINK_OUTCOMES = [
  "completed",
  "task_cancelled",
  "task_already_closed",
  "not_linked",
  "medicines_conflict",
] as const;
const TASK_LINK_OUTCOMES_SQL = sql.raw(TASK_LINK_OUTCOMES.map((o) => `'${o}'`).join(", "));

/**
 * Who sent an entry for its author (`created_by`) when a manager handed over that member's held
 * entries from a device (care.md section 6, Device integrity part 6): shown as "Sent by". Null when
 * its author sent it, a hand-over by the owner included. Only the five tables a device writes.
 */
const handedOverByColumn = () => ({ handedOverBy: uuid("handed_over_by") });

const handedOverByRef = (name: string, t: { tenantId: AnyPgColumn; handedOverBy: AnyPgColumn }) =>
  foreignKey({
    name,
    columns: [t.tenantId, t.handedOverBy],
    foreignColumns: [tenantUser.tenantId, tenantUser.id],
  });

/** An entry names a task when it records what happened to it, and only then. */
const entryTaskOutcome = (table: string) =>
  check(
    `${table}_task_outcome`,
    sql`(task_id IS NULL) = (task_outcome IS NULL) AND (task_outcome IS NULL OR task_outcome IN (${TASK_LINK_OUTCOMES_SQL}))`,
  );

/**
 * Back-entry from paper during an outage (operations.md rules 11 to 13; HZ-017), on the five
 * entries a device or the web writes (migration 0053, expand only: empty on every entry written at
 * the time). A back-entry has the late-entry reason `downtime`, its outage, the date and time as
 * written on the form (UK wall clock, with the occurrence chosen in the repeated autumn hour), the
 * form's reference, and a reason when the paper time is outside the outage. An entry written later
 * for a time inside an outage that was not copied from paper names the outage and says why.
 */
const backEntryColumns = () => ({
  lateEntryReason: text("late_entry_reason"),
  outageId: uuid("outage_id"),
  paperDate: date("paper_date"),
  paperTime: time("paper_time"),
  paperOccurrence: text("paper_occurrence"),
  outsideOutageReason: text("outside_outage_reason"),
  paperReference: text("paper_reference"),
  notFromPaperReason: text("not_from_paper_reason"),
});

const BACK_ENTRY_CHECK = sql`CASE WHEN late_entry_reason = 'downtime'
  THEN outage_id IS NOT NULL AND paper_date IS NOT NULL AND paper_time IS NOT NULL
    AND extract(second FROM paper_time) = 0 AND paper_occurrence IN ('only', 'earlier', 'later')
    AND not_from_paper_reason IS NULL
    AND (outside_outage_reason IS NULL OR btrim(outside_outage_reason) <> '')
  ELSE late_entry_reason IS NULL AND paper_date IS NULL AND paper_time IS NULL
    AND paper_occurrence IS NULL AND outside_outage_reason IS NULL AND paper_reference IS NULL
    AND (outage_id IS NULL) = (not_from_paper_reason IS NULL)
    AND (not_from_paper_reason IS NULL OR btrim(not_from_paper_reason) <> '')
END`;

/** The outage reference (composite, so it never reaches another tenant's), the rule and an index. */
const backEntryConstraints = (
  table: string,
  t: { tenantId: AnyPgColumn; outageId: AnyPgColumn; supersedesId: AnyPgColumn },
) => [
  foreignKey({
    name: `${table}_outage_fk`,
    columns: [t.tenantId, t.outageId],
    foreignColumns: [outage.tenantId, outage.id],
  }),
  check(`${table}_back_entry`, BACK_ENTRY_CHECK),
  index(`${table}_outage_idx`).on(t.tenantId, t.outageId).where(sql`outage_id IS NOT NULL`),
  // A back-entry is corrected once; a further correction supersedes the correction, so each
  // paper record has one current version (#38 review round 2). Ordinary entries keep concurrent
  // offline corrections.
  uniqueIndex(`${table}_back_entry_correction_key`)
    .on(t.tenantId, t.supersedesId)
    .where(sql`late_entry_reason = 'downtime' AND supersedes_id IS NOT NULL`),
];

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
    ...handedOverByColumn(),
    ...backEntryColumns(),
    /** personal_care, nutrition, mood, activity, visit, health, night, other. */
    category: text("category").notNull(),
    body: text("body").notNull(),
    /** Search vector of the note text. */
    searchBody: searchVector("search_body", sql`app.search_vector(body)`),
    tags: text("tags").array().notNull().default(sql`'{}'::text[]`),
    attachmentDocumentIds: uuid("attachment_document_ids")
      .array()
      .notNull()
      .default(sql`'{}'::uuid[]`),
  },
  (t) => [
    unique("care_note_tenant_id_id_key").on(t.tenantId, t.id),
    ...backEntryConstraints("care_note", t),
    personRef("care_note_person_fk", t),
    entryTaskOutcome("care_note"),
    handedOverByRef("care_note_handed_over_by_fk", t),
    locationRef("care_note_location_fk", t),
    index("care_note_person_idx").on(t.tenantId, t.personId, t.occurredAt),
    index("care_note_location_idx").on(t.tenantId, t.locationId, t.occurredAt),
  ],
);

export const observation = pgTable(
  "observation",
  {
    ...entryColumns(),
    ...handedOverByColumn(),
    ...backEntryColumns(),
    /** fluid_intake, fluid_output, food, repositioning, bowel, weight, vitals (NEWS2 set). */
    chart: text("chart").notNull(),
    /** Typed per chart and validated by the API (packages/contracts). */
    values: jsonb("values").notNull(),
    /** Computed flags, for example NEWS2 component scores or an IDDSI mismatch. */
    flags: jsonb("flags").notNull().default(sql`'{}'::jsonb`),
  },
  (t) => [
    unique("observation_tenant_id_id_key").on(t.tenantId, t.id),
    ...backEntryConstraints("observation", t),
    personRef("observation_person_fk", t),
    entryTaskOutcome("observation"),
    handedOverByRef("observation_handed_over_by_fk", t),
    locationRef("observation_location_fk", t),
    index("observation_person_chart_idx").on(t.tenantId, t.personId, t.chart, t.occurredAt),
    index("observation_location_idx").on(t.tenantId, t.locationId, t.occurredAt),
  ],
);

export const bodyMapMark = pgTable(
  "body_map_mark",
  {
    ...entryColumns(),
    ...handedOverByColumn(),
    ...backEntryColumns(),
    view: text("view").notNull(),
    region: text("region").notNull(),
    /** The person's side, stated in words and checked against the drawing (HZ-019). */
    side: text("side").notNull(),
    /**
     * Where the mark was placed on the drawing (`BODY_MAP_DRAWING` units, x from the viewer's
     * left, y from the top), when a point was tapped; and the zone of the drawing, from the point
     * or the buttons beside it. Null for marks recorded before the server worked out the side.
     */
    drawnX: doublePrecision("drawn_x"),
    drawnY: doublePrecision("drawn_y"),
    drawnZone: text("drawn_zone"),
    /** The person's side as the server worked it out from the drawing and the view (HZ-019). */
    drawnSide: text("drawn_side"),
    /**
     * True when the place was taken from the side a phone said it drew, because an app from
     * before the server read the drawing sent no point or zone (migration 0045; #26 review round
     * 2, C4): the zone is the one that side names on the view, not one the server read.
     */
    drawnFromDeviceSide: boolean("drawn_from_device_side").notNull().default(false),
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
    ...backEntryConstraints("body_map_mark", t),
    personRef("body_map_mark_person_fk", t),
    entryTaskOutcome("body_map_mark"),
    handedOverByRef("body_map_mark_handed_over_by_fk", t),
    locationRef("body_map_mark_location_fk", t),
    foreignKey({
      name: "body_map_mark_photo_fk",
      columns: [t.tenantId, t.photoDocumentId],
      foreignColumns: [document.tenantId, document.id],
    }),
    // A mark recorded for an incident (safety.md section 2; slice 7).
    foreignKey({
      name: "body_map_mark_incident_fk",
      columns: [t.tenantId, t.incidentId],
      foreignColumns: [incident.tenantId, incident.id],
    }),
    index("body_map_mark_person_idx").on(t.tenantId, t.personId, t.occurredAt),
    index("body_map_mark_incident_idx").on(t.tenantId, t.incidentId),
    check(
      "body_map_mark_drawing",
      sql`(drawn_x IS NULL) = (drawn_y IS NULL)
        AND (drawn_x IS NULL OR (drawn_x BETWEEN 0 AND 120 AND drawn_y BETWEEN 0 AND 240))
        AND (drawn_zone IS NULL OR drawn_zone IN ('viewer_left', 'centre', 'viewer_right'))
        AND (drawn_side IS NULL OR drawn_side IN ('left', 'right', 'midline'))
        AND ((drawn_side IS NULL) = (drawn_zone IS NULL))
        AND (drawn_x IS NULL OR drawn_zone IS NOT NULL)`,
    ),
    // A place taken from the device's side has a zone and no point.
    check(
      "body_map_mark_drawn_from_device_side",
      sql`NOT drawn_from_device_side OR (drawn_zone IS NOT NULL AND drawn_x IS NULL)`,
    ),
  ],
);

/** The tools whose results link an escalation policy (`ESCALATION_POLICY_TOOLS` in the domain). */
export const ESCALATION_POLICY_TOOL_KEYS = [
  "news2",
  "must",
  "waterlow",
  "braden",
  "ng249_falls",
] as const;

/** The bands a link may name, per tool (`ESCALATION_POLICY_BANDS` in the domain; a test checks). */
export const ESCALATION_POLICY_TOOL_BANDS: Readonly<
  Record<(typeof ESCALATION_POLICY_TOOL_KEYS)[number], readonly string[]>
> = {
  news2: ["low", "low_medium", "medium", "high"],
  must: ["low", "medium", "high"],
  waterlow: ["not_at_risk", "at_risk", "high_risk", "very_high_risk"],
  braden: ["severe_risk", "high_risk", "moderate_risk", "at_risk", "below_at_risk_threshold"],
  ng249_falls: [],
};

const ESCALATION_BAND_CHECK = sql.raw(
  Object.entries(ESCALATION_POLICY_TOOL_BANDS)
    .map(([tool, bands]) =>
      bands.length === 0
        ? `(tool_key = '${tool}' AND band IS NULL)`
        : `(tool_key = '${tool}' AND (band IS NULL OR band IN (${bands.map((b) => `'${b}'`).join(", ")})))`,
    )
    .join(" OR "),
);

/**
 * The organisation's escalation policy for a validated tool's result (care.md section 5,
 * escalation policies; medical-device boundary section 5 rule 4; HZ-012, HZ-014): a tool, one of
 * its bands or every band, the whole organisation or one location, and the policy's own name,
 * reference and document. Results link the most specific live link; Harbour adds no
 * recommendation. Configuration, not personal data: every member reads it, holders of
 * `quality.policy.manage` change it (organisation-wide links only with tenant-wide scope).
 * Mutable, versioned; removal is a soft delete.
 */
export const escalationPolicyLink = pgTable(
  "escalation_policy_link",
  {
    id: id(),
    tenantId: tenantId(),
    /** `ESCALATION_POLICY_TOOL_KEYS`. */
    toolKey: text("tool_key").notNull(),
    /** One band of the tool; null for every band. */
    band: text("band"),
    /** One location; null for the whole organisation. */
    locationId: uuid("location_id"),
    title: text("title").notNull(),
    reference: text("reference"),
    documentId: uuid("document_id"),
    ...mutableColumns(),
  },
  (t) => [
    unique("escalation_policy_link_tenant_id_id_key").on(t.tenantId, t.id),
    // One live link per tool, band and place: every band is '' and the organisation the nil id.
    uniqueIndex("escalation_policy_link_live_key")
      .on(
        t.tenantId,
        t.toolKey,
        sql`coalesce(${t.band}, '')`,
        sql`coalesce(${t.locationId}, '00000000-0000-0000-0000-000000000000'::uuid)`,
      )
      .where(sql`deleted_at IS NULL`),
    locationRef("escalation_policy_link_location_fk", t),
    foreignKey({
      name: "escalation_policy_link_document_fk",
      columns: [t.tenantId, t.documentId],
      foreignColumns: [document.tenantId, document.id],
    }),
    check("escalation_policy_link_band", sql`${ESCALATION_BAND_CHECK}`),
    check(
      "escalation_policy_link_text",
      sql`char_length(btrim(title)) BETWEEN 3 AND 200 AND (reference IS NULL OR char_length(reference) <= 100)`,
    ),
  ],
);
export type EscalationPolicyLinkRow = typeof escalationPolicyLink.$inferSelect;

// ------------------------------------------------------------------------------------------------
// Slice 4b: care plans, risk assessments, stored assessments, activities, visits and advance care
// records (care.md section 2). Child rows carry the person and reference their parent through
// (tenant_id, person_id, id), so a row can never claim a different person from its parent: the
// person-scope policy relies on that column.
// ------------------------------------------------------------------------------------------------

const PCSP_DOMAIN_SQL = sql.raw(
  [
    "mobility",
    "skin",
    "nutrition_and_hydration",
    "continence",
    "communication",
    "cognition",
    "mood",
    "behaviour",
    "sleep",
    "pain",
    "breathing",
    "medicines",
    "personal_care",
    "social_and_spiritual",
    "sexuality_and_relationships",
    "end_of_life",
  ]
    .map((d) => `'${d}'`)
    .join(", "),
);

/** The personalised care and support plan: one row per published version (care.md rules 1, 2). */
export const carePlan = pgTable(
  "care_plan",
  {
    id: id(),
    tenantId: tenantId(),
    personId: uuid("person_id").notNull(),
    locationId: uuid("location_id").notNull(),
    /** `draft`, `active` (drives tasks) or `superseded` by a later publication. */
    status: text("status").notNull().default("draft"),
    /** 1 for the person's first published plan, then 2, 3 and so on; null while a draft. */
    publishedVersion: integer("published_version"),
    /** The active plan the draft was started from, if any. */
    basedOnPlanId: uuid("based_on_plan_id"),
    /**
     * Whether starting the draft asked for the active plan to be copied (`copyFromActive`), kept
     * so a start sent again with its client id is compared with it (HZ-029; #26 review round 3).
     * Null for drafts started before migration 0047.
     */
    copyFromActive: boolean("copy_from_active"),
    summary: text("summary"),
    reviewDueOn: date("review_due_on"),
    /** Why a review was brought forward (a change in needs) and when. */
    reviewReason: text("review_reason"),
    reviewRequestedAt: timestamp("review_requested_at", { withTimezone: true }),
    publishedAt: timestamp("published_at", { withTimezone: true }),
    publishedBy: uuid("published_by"),
    supersededAt: timestamp("superseded_at", { withTimezone: true }),
    supersededByPlanId: uuid("superseded_by_plan_id"),
    /** `person`, `representative` (name and authority) or `unable` (with the reason). */
    signOffKind: text("sign_off_kind"),
    signOffRepresentativeName: text("sign_off_representative_name"),
    signOffAuthority: text("sign_off_authority"),
    signOffContactId: uuid("sign_off_contact_id"),
    signOffUnableReason: text("sign_off_unable_reason"),
    signedOffAt: timestamp("signed_off_at", { withTimezone: true }),
    signedOffRecordedBy: uuid("signed_off_recorded_by"),
    ...mutableColumns(),
  },
  (t) => [
    unique("care_plan_tenant_id_id_key").on(t.tenantId, t.id),
    unique("care_plan_tenant_person_id_key").on(t.tenantId, t.personId, t.id),
    personRef("care_plan_person_fk", t),
    locationRef("care_plan_location_fk", t),
    foreignKey({
      name: "care_plan_based_on_fk",
      columns: [t.tenantId, t.personId, t.basedOnPlanId],
      foreignColumns: [t.tenantId, t.personId, t.id],
    }),
    foreignKey({
      name: "care_plan_superseded_by_fk",
      columns: [t.tenantId, t.personId, t.supersededByPlanId],
      foreignColumns: [t.tenantId, t.personId, t.id],
    }),
    foreignKey({
      name: "care_plan_sign_off_contact_fk",
      columns: [t.tenantId, t.personId, t.signOffContactId],
      foreignColumns: [contact.tenantId, contact.personId, contact.id],
    }),
    // Only one active plan and one open draft per person (care.md rule 2).
    uniqueIndex("care_plan_one_active")
      .on(t.tenantId, t.personId)
      .where(sql`status = 'active' AND deleted_at IS NULL`),
    uniqueIndex("care_plan_one_draft")
      .on(t.tenantId, t.personId)
      .where(sql`status = 'draft' AND deleted_at IS NULL`),
    check("care_plan_status", sql`status IN ('draft', 'active', 'superseded')`),
    check("care_plan_published", sql`(status = 'draft') = (published_version IS NULL)`),
    check(
      "care_plan_sign_off",
      sql`sign_off_kind IS NULL
        OR sign_off_kind = 'person'
        OR (sign_off_kind = 'representative' AND sign_off_representative_name IS NOT NULL
            AND sign_off_authority IS NOT NULL)
        OR (sign_off_kind = 'unable' AND sign_off_unable_reason IS NOT NULL)`,
    ),
    index("care_plan_person_idx").on(t.tenantId, t.personId, t.status),
    index("care_plan_review_idx").on(t.tenantId, t.status, t.reviewDueOn),
  ],
);

/** One need domain of a plan: the need, the outcome in the person's words, strengths, contingency. */
export const carePlanSection = pgTable(
  "care_plan_section",
  {
    id: id(),
    tenantId: tenantId(),
    personId: uuid("person_id").notNull(),
    planId: uuid("plan_id").notNull(),
    /** One of the 16 PCSP need domains (packages/domain PCSP_DOMAINS). */
    domain: text("domain").notNull(),
    need: text("need"),
    outcome: text("outcome"),
    strengths: text("strengths"),
    contingency: text("contingency"),
    ...mutableColumns(),
  },
  (t) => [
    unique("care_plan_section_tenant_id_id_key").on(t.tenantId, t.id),
    unique("care_plan_section_tenant_person_id_key").on(t.tenantId, t.personId, t.id),
    unique("care_plan_section_domain_key").on(t.tenantId, t.planId, t.domain),
    personRef("care_plan_section_person_fk", t),
    foreignKey({
      name: "care_plan_section_plan_fk",
      columns: [t.tenantId, t.personId, t.planId],
      foreignColumns: [carePlan.tenantId, carePlan.personId, carePlan.id],
    }),
    check("care_plan_section_domain", sql`domain IN (${PCSP_DOMAIN_SQL})`),
  ],
);

/** A positive risk assessment (Reg 12): mutable and versioned through record_version. */
export const riskAssessment = pgTable(
  "risk_assessment",
  {
    id: id(),
    tenantId: tenantId(),
    personId: uuid("person_id").notNull(),
    /** A template from packages/domain RISK_TEMPLATES, and the template version answered. */
    templateKey: text("template_key").notNull(),
    templateVersion: text("template_version").notNull(),
    hazard: text("hazard").notNull(),
    whoAtRisk: text("who_at_risk").notNull(),
    answers: jsonb("answers").notNull().default(sql`'{}'::jsonb`),
    /** Measurements checked against rate-table figures (MHRA bed rail gaps). */
    findings: jsonb("findings").notNull().default(sql`'[]'::jsonb`),
    /** NPSA matrix, the assessor's judgements; null for templates that are never rated (falls). */
    likelihood: integer("likelihood"),
    severity: integer("severity"),
    riskRating: integer("risk_rating"),
    riskBand: text("risk_band"),
    controls: text("controls").array().notNull().default(sql`'{}'::text[]`),
    residualLikelihood: integer("residual_likelihood"),
    residualSeverity: integer("residual_severity"),
    residualRating: integer("residual_rating"),
    residualBand: text("residual_band"),
    positiveRiskStatement: text("positive_risk_statement"),
    /** What the person wants, in their words. */
    personViews: text("person_views"),
    assessedOn: date("assessed_on").notNull(),
    reviewDueOn: date("review_due_on").notNull(),
    /** `active` or `closed` (no longer relevant, with the reason). */
    status: text("status").notNull().default("active"),
    closedReason: text("closed_reason"),
    closedAt: timestamp("closed_at", { withTimezone: true }),
    ...mutableColumns(),
  },
  (t) => [
    unique("risk_assessment_tenant_id_id_key").on(t.tenantId, t.id),
    unique("risk_assessment_tenant_person_id_key").on(t.tenantId, t.personId, t.id),
    personRef("risk_assessment_person_fk", t),
    check("risk_assessment_status", sql`status IN ('active', 'closed')`),
    check("risk_assessment_closed_reason", sql`status = 'active' OR closed_reason IS NOT NULL`),
    check(
      "risk_assessment_scales",
      sql`(likelihood IS NULL OR likelihood BETWEEN 1 AND 5)
        AND (severity IS NULL OR severity BETWEEN 1 AND 5)
        AND (residual_likelihood IS NULL OR residual_likelihood BETWEEN 1 AND 5)
        AND (residual_severity IS NULL OR residual_severity BETWEEN 1 AND 5)`,
    ),
    check(
      "risk_assessment_rating",
      sql`risk_rating IS NOT DISTINCT FROM likelihood * severity
        AND residual_rating IS NOT DISTINCT FROM residual_likelihood * residual_severity`,
    ),
    check("risk_assessment_review", sql`review_due_on >= assessed_on`),
    index("risk_assessment_person_idx").on(t.tenantId, t.personId, t.status),
    index("risk_assessment_review_idx").on(t.tenantId, t.status, t.reviewDueOn),
  ],
);

/** What carries out a plan: who (role) and when (a Recurrence in the location's time zone). */
export const carePlanAction = pgTable(
  "care_plan_action",
  {
    id: id(),
    tenantId: tenantId(),
    personId: uuid("person_id").notNull(),
    planId: uuid("plan_id").notNull(),
    sectionId: uuid("section_id").notNull(),
    action: text("action").notNull(),
    /** The role that carries it out, for example `care_worker`. */
    roleKey: text("role_key"),
    /** A Recurrence from packages/domain (UK local times); null for actions done as needed. */
    recurrence: jsonb("recurrence"),
    /** When it happens, in words, for actions without a schedule ("after meals"). */
    whenText: text("when_text"),
    /** Slice 5 turns active plans' task-generating actions into task series. */
    generatesTasks: boolean("generates_tasks").notNull().default(false),
    evidenceRequired: boolean("evidence_required").notNull().default(false),
    riskAssessmentId: uuid("risk_assessment_id"),
    /** The task series this action created or took over (care.md rule 14). */
    taskSeriesId: uuid("task_series_id"),
    /**
     * The action of the earlier version this one was copied from: an unchanged action takes over
     * that action's task series when the new version is published, so its rounds carry on.
     */
    basedOnActionId: uuid("based_on_action_id"),
    ...mutableColumns(),
  },
  (t) => [
    unique("care_plan_action_tenant_id_id_key").on(t.tenantId, t.id),
    foreignKey({
      name: "care_plan_action_based_on_fk",
      columns: [t.tenantId, t.basedOnActionId],
      foreignColumns: [t.tenantId, t.id],
    }),
    personRef("care_plan_action_person_fk", t),
    foreignKey({
      name: "care_plan_action_plan_fk",
      columns: [t.tenantId, t.personId, t.planId],
      foreignColumns: [carePlan.tenantId, carePlan.personId, carePlan.id],
    }),
    foreignKey({
      name: "care_plan_action_section_fk",
      columns: [t.tenantId, t.personId, t.sectionId],
      foreignColumns: [carePlanSection.tenantId, carePlanSection.personId, carePlanSection.id],
    }),
    foreignKey({
      name: "care_plan_action_risk_assessment_fk",
      columns: [t.tenantId, t.personId, t.riskAssessmentId],
      foreignColumns: [riskAssessment.tenantId, riskAssessment.personId, riskAssessment.id],
    }),
    foreignKey({
      name: "care_plan_action_task_series_fk",
      columns: [t.tenantId, t.taskSeriesId],
      foreignColumns: [taskSeries.tenantId, taskSeries.id],
    }),
    check(
      "care_plan_action_schedule",
      sql`NOT generates_tasks OR (recurrence IS NOT NULL AND role_key IS NOT NULL)`,
    ),
    index("care_plan_action_plan_idx").on(t.tenantId, t.planId),
  ],
);

/** A stored result of a locked validated tool (care.md rule 5): append-only, corrections supersede. */
export const assessment = pgTable(
  "assessment",
  {
    ...entryColumns(),
    toolKey: text("tool_key").notNull(),
    toolVersion: text("tool_version").notNull(),
    answers: jsonb("answers").notNull(),
    /** Null for the NG249 falls pathway, which never scores. */
    score: integer("score"),
    band: text("band"),
    workings: jsonb("workings").notNull().default(sql`'[]'::jsonb`),
    triggers: jsonb("triggers").notNull().default(sql`'[]'::jsonb`),
    details: jsonb("details").notNull().default(sql`'{}'::jsonb`),
    nextDueOn: date("next_due_on"),
  },
  (t) => [
    unique("assessment_tenant_id_id_key").on(t.tenantId, t.id),
    unique("assessment_tenant_person_id_key").on(t.tenantId, t.personId, t.id),
    personRef("assessment_person_fk", t),
    entryTaskOutcome("assessment"),
    locationRef("assessment_location_fk", t),
    foreignKey({
      name: "assessment_supersedes_fk",
      columns: [t.tenantId, t.personId, t.supersedesId],
      foreignColumns: [t.tenantId, t.personId, t.id],
    }),
    check("assessment_tool_key", sql`tool_key IN ('must', 'waterlow', 'braden', 'ng249_falls')`),
    check(
      "assessment_correction_reason",
      sql`supersedes_id IS NULL OR correction_reason IS NOT NULL`,
    ),
    index("assessment_person_tool_idx").on(t.tenantId, t.personId, t.toolKey, t.occurredAt),
  ],
);

/** Activities and wellbeing (CARE-014): append-only; a group session is recorded per person. */
export const activityRecord = pgTable(
  "activity_record",
  {
    ...entryColumns(),
    ...handedOverByColumn(),
    ...backEntryColumns(),
    activity: text("activity").notNull(),
    /** `group` or `one_to_one`. */
    format: text("format").notNull(),
    groupSessionId: uuid("group_session_id"),
    attendance: text("attendance").notNull(),
    engagement: text("engagement"),
    durationMinutes: integer("duration_minutes"),
    notes: text("notes"),
  },
  (t) => [
    unique("activity_record_tenant_id_id_key").on(t.tenantId, t.id),
    ...backEntryConstraints("activity_record", t),
    unique("activity_record_tenant_person_id_key").on(t.tenantId, t.personId, t.id),
    personRef("activity_record_person_fk", t),
    entryTaskOutcome("activity_record"),
    handedOverByRef("activity_record_handed_over_by_fk", t),
    locationRef("activity_record_location_fk", t),
    foreignKey({
      name: "activity_record_supersedes_fk",
      columns: [t.tenantId, t.personId, t.supersedesId],
      foreignColumns: [t.tenantId, t.personId, t.id],
    }),
    check("activity_record_format", sql`format IN ('group', 'one_to_one')`),
    check(
      "activity_record_attendance",
      sql`attendance IN ('attended', 'partly_attended', 'declined', 'not_able')`,
    ),
    check(
      "activity_record_group_session",
      sql`(format = 'group') = (group_session_id IS NOT NULL)`,
    ),
    index("activity_record_person_idx").on(t.tenantId, t.personId, t.occurredAt),
    index("activity_record_session_idx").on(t.tenantId, t.groupSessionId),
  ],
);

/**
 * The Regulation 9A visiting log (CARE-014): facilitated visits, visits out and accompaniment.
 * `occurred_at` is when the visit started. Append-only; restrictions are recorded with the reason.
 */
export const visitLog = pgTable(
  "visit_log",
  {
    ...entryColumns(),
    ...handedOverByColumn(),
    ...backEntryColumns(),
    /** `facilitated_visit`, `visit_out` or `accompaniment`. */
    kind: text("kind").notNull(),
    contactId: uuid("contact_id"),
    visitorName: text("visitor_name"),
    visitorRelationship: text("visitor_relationship"),
    endedAt: timestamp("ended_at", { withTimezone: true }),
    restrictionsApplied: boolean("restrictions_applied").notNull().default(false),
    restrictionReason: text("restriction_reason"),
    notes: text("notes"),
  },
  (t) => [
    unique("visit_log_tenant_id_id_key").on(t.tenantId, t.id),
    ...backEntryConstraints("visit_log", t),
    unique("visit_log_tenant_person_id_key").on(t.tenantId, t.personId, t.id),
    personRef("visit_log_person_fk", t),
    entryTaskOutcome("visit_log"),
    handedOverByRef("visit_log_handed_over_by_fk", t),
    locationRef("visit_log_location_fk", t),
    foreignKey({
      name: "visit_log_contact_fk",
      columns: [t.tenantId, t.personId, t.contactId],
      foreignColumns: [contact.tenantId, contact.personId, contact.id],
    }),
    foreignKey({
      name: "visit_log_supersedes_fk",
      columns: [t.tenantId, t.personId, t.supersedesId],
      foreignColumns: [t.tenantId, t.personId, t.id],
    }),
    check("visit_log_kind", sql`kind IN ('facilitated_visit', 'visit_out', 'accompaniment')`),
    check("visit_log_visitor", sql`contact_id IS NOT NULL OR visitor_name IS NOT NULL`),
    check(
      "visit_log_restriction_reason",
      sql`restrictions_applied = (restriction_reason IS NOT NULL)`,
    ),
    check("visit_log_times", sql`ended_at IS NULL OR ended_at >= occurred_at`),
    index("visit_log_person_idx").on(t.tenantId, t.personId, t.occurredAt),
  ],
);

/**
 * ReSPECT, DNACPR, ADRT and advance care plans (CARE-015, hazard HZ-015). Mutable and versioned;
 * at most one active record of each kind per person, and a new one supersedes the old.
 */
export const advanceCareRecord = pgTable(
  "advance_care_record",
  {
    id: id(),
    tenantId: tenantId(),
    personId: uuid("person_id").notNull(),
    kind: text("kind").notNull(),
    /** `active`, `withdrawn` (with the reason) or `superseded` by a newer record of the kind. */
    status: text("status").notNull().default("active"),
    /** `attempt_cpr` or `do_not_attempt_cpr`: ReSPECT and DNACPR only. */
    cprDecision: text("cpr_decision"),
    clinicianName: text("clinician_name"),
    clinicianRole: text("clinician_role"),
    completedOn: date("completed_on").notNull(),
    reviewDueOn: date("review_due_on"),
    /** The scanned form in the document store; the signed original stays with the person. */
    documentId: uuid("document_id"),
    /** Other recommendations or the treatments refused, as written on the form. */
    details: text("details"),
    withdrawnAt: timestamp("withdrawn_at", { withTimezone: true }),
    withdrawnReason: text("withdrawn_reason"),
    supersededByRecordId: uuid("superseded_by_record_id"),
    ...mutableColumns(),
  },
  (t) => [
    unique("advance_care_record_tenant_id_id_key").on(t.tenantId, t.id),
    unique("advance_care_record_tenant_person_id_key").on(t.tenantId, t.personId, t.id),
    personRef("advance_care_record_person_fk", t),
    foreignKey({
      name: "advance_care_record_document_fk",
      columns: [t.tenantId, t.documentId],
      foreignColumns: [document.tenantId, document.id],
    }),
    foreignKey({
      name: "advance_care_record_superseded_by_fk",
      columns: [t.tenantId, t.personId, t.supersededByRecordId],
      foreignColumns: [t.tenantId, t.personId, t.id],
    }),
    // HZ-015: only one active record of each kind.
    uniqueIndex("advance_care_record_one_active")
      .on(t.tenantId, t.personId, t.kind)
      .where(sql`status = 'active' AND deleted_at IS NULL`),
    check(
      "advance_care_record_kind",
      sql`kind IN ('respect', 'dnacpr', 'adrt', 'advance_care_plan')`,
    ),
    check("advance_care_record_status", sql`status IN ('active', 'withdrawn', 'superseded')`),
    check(
      "advance_care_record_cpr",
      sql`CASE kind
        WHEN 'dnacpr' THEN cpr_decision IS NOT DISTINCT FROM 'do_not_attempt_cpr'
        WHEN 'respect' THEN cpr_decision IS NOT NULL
          AND cpr_decision IN ('attempt_cpr', 'do_not_attempt_cpr')
        ELSE cpr_decision IS NULL
      END`,
    ),
    check(
      "advance_care_record_withdrawn",
      sql`status <> 'withdrawn' OR withdrawn_reason IS NOT NULL`,
    ),
    check(
      "advance_care_record_review",
      sql`review_due_on IS NULL OR review_due_on >= completed_on`,
    ),
    index("advance_care_record_person_idx").on(t.tenantId, t.personId, t.status),
  ],
);

// ------------------------------------------------------------------------------------------------
// Slice 5: the shift handover (care.md rule 8, COMMS-006, hazard HZ-018). The handover is compiled
// by rule from the shift's records, in the system's view of the organisation; its items are
// references only, in their own append-only table so each follows its person's scope (HZ-011).
// Notes and acknowledgements are append-only.
// ------------------------------------------------------------------------------------------------

/**
 * One handover per location and shift: mutable while it is compiled (its refresh and lock times),
 * then locked. Only the system's view of the organisation writes it (row-level security).
 */
export const handover = pgTable(
  "handover",
  {
    id: id(),
    tenantId: tenantId(),
    locationId: uuid("location_id").notNull(),
    /** The shift's name in the location's pattern ("day", "night"). */
    shiftName: text("shift_name").notNull(),
    shiftStart: timestamp("shift_start", { withTimezone: true }).notNull(),
    /** Exclusive. */
    shiftEnd: timestamp("shift_end", { withTimezone: true }).notNull(),
    compiledAt: timestamp("compiled_at", { withTimezone: true }).notNull(),
    /** The last time the sources were read again for late additions. */
    refreshedAt: timestamp("refreshed_at", { withTimezone: true }).notNull(),
    /** Set at the end of the shift; notes close then, late additions and acknowledgements go on. */
    lockedAt: timestamp("locked_at", { withTimezone: true }),
    ...mutableColumns(),
  },
  (t) => [
    unique("handover_tenant_id_id_key").on(t.tenantId, t.id),
    unique("handover_location_shift_key").on(t.tenantId, t.locationId, t.shiftStart),
    locationRef("handover_location_fk", t),
    check("handover_shift", sql`shift_end > shift_start`),
    check("handover_refreshed", sql`refreshed_at >= compiled_at`),
    index("handover_location_idx").on(t.tenantId, t.locationId, t.shiftEnd),
  ],
);

/** A note the outgoing staff add to a handover or to one of its items, while it is open. */
/**
 * One compiled item (`HandoverItem` from packages/domain): kind, person, source table and id, when,
 * and whether and when it was added late, with its worded summary (`summary`). Append-only: an
 * item is never changed or removed (HZ-018), and a reader sees only the items about people they
 * may see (HZ-011).
 */
export const handoverItem = pgTable(
  "handover_item",
  {
    id: id(),
    tenantId: tenantId(),
    handoverId: uuid("handover_id").notNull(),
    /** Stable identity within the handover: the same record never appears twice under one kind. */
    key: text("key").notNull(),
    /** The order items were compiled and added in (0 first). */
    position: integer("position").notNull(),
    kind: text("kind").notNull(),
    personId: uuid("person_id"),
    sourceType: text("source_type").notNull(),
    sourceId: uuid("source_id").notNull(),
    /** When it happened, or when the task fell due. */
    at: timestamp("at", { withTimezone: true }).notNull(),
    lateAddition: boolean("late_addition").notNull(),
    addedAt: timestamp("added_at", { withTimezone: true }).notNull(),
    /**
     * What the item says, as a catalogue key and its parameters (`HandoverItemSummary` from
     * packages/domain), so a screen words it in the reader's language without reading the source
     * (the phone holds neither incidents, alerts nor skipped tasks; H-300). The parameters are codes
     * (a NEWS2 band, a chart, an incident type, an alert kind, a mark's type and region) and, for a
     * task, its title and the reason it was not done. Null on items compiled before migration 0071.
     */
    summary: jsonb("summary"),
    ...createdColumns(),
  },
  (t) => [
    unique("handover_item_key").on(t.tenantId, t.handoverId, t.key),
    unique("handover_item_position_key").on(t.tenantId, t.handoverId, t.position),
    foreignKey({
      name: "handover_item_handover_fk",
      columns: [t.tenantId, t.handoverId],
      foreignColumns: [handover.tenantId, handover.id],
    }),
    personRef("handover_item_person_fk", t),
    check("handover_item_position", sql`position >= 0`),
    check(
      "handover_item_kind",
      sql`kind IN ('fall', 'news2', 'incident', 'alert', 'body_map_mark', 'flagged_note', 'overdue_task', 'skipped_task', 'unfinished_task', 'must_follow_up', 'refusal')`,
    ),
    check(
      "handover_item_source_type",
      sql`source_type IN ('task', 'observation', 'incident', 'body_map_mark', 'care_note', 'notification')`,
    ),
    // One of the eleven summary keys and an object of parameters, nothing else, each a string,
    // number or boolean, at most 4 KiB in all. The key and codes are never English, but a task's
    // parameters are staff's free text (title, plan action, reason not done). A malformed summary
    // is refused, not taken as none (migration 0071; #123 security review, L2).
    check(
      "handover_item_summary",
      sql`summary IS NULL OR coalesce(jsonb_typeof(summary) = 'object' AND jsonb_typeof(summary -> 'key') = 'string' AND summary ->> 'key' IN ('handover.summary.fall', 'handover.summary.news2', 'handover.summary.incident', 'handover.summary.alert', 'handover.summary.bodyMapMark', 'handover.summary.flaggedNote', 'handover.summary.overdueTask', 'handover.summary.skippedTask', 'handover.summary.unfinishedTask', 'handover.summary.mustFollowUp', 'handover.summary.refusal') AND jsonb_typeof(summary -> 'params') = 'object' AND (summary - 'key' - 'params') = '{}'::jsonb AND NOT jsonb_path_exists(summary -> 'params', 'strict $.* ? (@.type() == "object" || @.type() == "array")') AND octet_length(summary::text) <= 4096, false)`,
    ),
  ],
);

export const handoverNote = pgTable(
  "handover_note",
  {
    /** May be generated on the device, so a retried save is recorded once (HZ-029). */
    id: id(),
    tenantId: tenantId(),
    handoverId: uuid("handover_id").notNull(),
    /**
     * The item annotated (`handover_item.key`); null for a note on the whole handover. The writer
     * must be able to see the item (a trigger reads it under their row-level security).
     */
    itemKey: text("item_key"),
    /**
     * The person the annotated item is about, so the note follows that person's scope. Set by a
     * trigger from the item, whatever the writer sends.
     */
    personId: uuid("person_id"),
    body: text("body").notNull(),
    deviceId: text("device_id"),
    ...createdColumns(),
  },
  (t) => [
    foreignKey({
      name: "handover_note_handover_fk",
      columns: [t.tenantId, t.handoverId],
      foreignColumns: [handover.tenantId, handover.id],
    }),
    foreignKey({
      name: "handover_note_item_fk",
      columns: [t.tenantId, t.handoverId, t.itemKey],
      foreignColumns: [handoverItem.tenantId, handoverItem.handoverId, handoverItem.key],
    }),
    personRef("handover_note_person_fk", t),
    check("handover_note_body", sql`length(trim(body)) BETWEEN 1 AND 2000`),
    check("handover_note_person", sql`person_id IS NULL OR item_key IS NOT NULL`),
    index("handover_note_handover_idx").on(t.tenantId, t.handoverId, t.createdAt),
  ],
);

/**
 * Each acknowledgement of a handover by a member of staff (COMMS-006): how many items it held when
 * they acknowledged it, so a late addition asks them again for the new items only.
 */
export const handoverAcknowledgement = pgTable(
  "handover_acknowledgement",
  {
    /** May be generated on the device, so a retried acknowledgement is recorded once. */
    id: id(),
    tenantId: tenantId(),
    handoverId: uuid("handover_id").notNull(),
    /** Always the person acknowledging (row-level security refuses anyone else). */
    tenantUserId: uuid("tenant_user_id").notNull().default(sql`app.current_user_id()`),
    /**
     * The keys of the items the person could see when they acknowledged, recorded by the server
     * from its own view of the handover (never sent by the device).
     */
    itemKeys: text("item_keys").array().notNull(),
    /** Server time. */
    acknowledgedAt: timestamp("acknowledged_at", { withTimezone: true }).notNull().defaultNow(),
    deviceId: text("device_id"),
    ...createdColumns(),
  },
  (t) => [
    foreignKey({
      name: "handover_acknowledgement_handover_fk",
      columns: [t.tenantId, t.handoverId],
      foreignColumns: [handover.tenantId, handover.id],
    }),
    foreignKey({
      name: "handover_acknowledgement_user_fk",
      columns: [t.tenantId, t.tenantUserId],
      foreignColumns: [tenantUser.tenantId, tenantUser.id],
    }),
    index("handover_acknowledgement_handover_idx").on(t.tenantId, t.handoverId, t.tenantUserId),
  ],
);

export const HANDOVER_APPEND_ONLY_TABLES = ["handover_note", "handover_acknowledgement"] as const;
export type HandoverRow = typeof handover.$inferSelect;
export type HandoverNoteRow = typeof handoverNote.$inferSelect;
export type HandoverAcknowledgementRow = typeof handoverAcknowledgement.$inferSelect;

export const CARE_PLANNING_MUTABLE_TABLES = [
  "care_plan",
  "care_plan_section",
  "care_plan_action",
  "risk_assessment",
  "advance_care_record",
] as const;
export const CARE_PLANNING_APPEND_ONLY_TABLES = [
  "assessment",
  "activity_record",
  "visit_log",
] as const;

export type CarePlanRow = typeof carePlan.$inferSelect;
export type CarePlanSectionRow = typeof carePlanSection.$inferSelect;
export type CarePlanActionRow = typeof carePlanAction.$inferSelect;
export type RiskAssessmentRow = typeof riskAssessment.$inferSelect;
export type AssessmentRow = typeof assessment.$inferSelect;
export type ActivityRecordRow = typeof activityRecord.$inferSelect;
export type VisitLogRow = typeof visitLog.$inferSelect;
export type AdvanceCareRecordRow = typeof advanceCareRecord.$inferSelect;

/** Narrow view used by handover and the round: the latest state of a person's charts. */
export type CareNoteRow = typeof careNote.$inferSelect;
export type ObservationRow = typeof observation.$inferSelect;
export type BodyMapMarkRow = typeof bodyMapMark.$inferSelect;
export type PersonCareProfileRow = typeof personCareProfile.$inferSelect;
export const CARE_ENTRY_TABLES = ["care_note", "observation", "body_map_mark"] as const;
