import { sql } from "drizzle-orm";
import {
  type AnyPgColumn,
  boolean,
  check,
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
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { eventColumns, id, mutableColumns, tenantId } from "./_columns";
import { contact, person } from "./people";
import { document, location } from "./platform";
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
    /** The task series slice 5 creates for this action. */
    taskSeriesId: uuid("task_series_id"),
    ...mutableColumns(),
  },
  (t) => [
    unique("care_plan_action_tenant_id_id_key").on(t.tenantId, t.id),
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
    unique("activity_record_tenant_person_id_key").on(t.tenantId, t.personId, t.id),
    personRef("activity_record_person_fk", t),
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
    unique("visit_log_tenant_person_id_key").on(t.tenantId, t.personId, t.id),
    personRef("visit_log_person_fk", t),
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
