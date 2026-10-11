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
  pgTable,
  text,
  timestamp,
  unique,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { sqlList } from "./_codes";
import { createdColumns, id, mutableColumns, tenantId } from "./_columns";
import { placementType } from "./enums";
import { bestInterestsDecision, capacityAssessment } from "./mca";
import { contact, person, placement, room } from "./people";
import { document, location, service, tenantUser } from "./platform";
import { incident } from "./safety";
import { workflowInstance } from "./work";

/**
 * The residential people lifecycle (slice 8; master prompt 9.2; docs/specs/people.md sections 2
 * and 4): pre-admission and the decision to admit, beds and moves, the welcome checklist,
 * property and keys, reviews, hospital transfers, exits, sharing decisions, About Me share links
 * and the weekly break-glass report. The rules live in packages/domain (`people/*`); the API calls
 * them before it writes, and these constraints are the backstop. Every table follows the person's
 * scope (ADR-0002) except the tenant's welcome checklist template and the weekly report, which
 * holds counts and opaque ids only.
 *
 * Code lists mirror the domain constants; packages/db/test/people-lifecycle.test.ts keeps them in
 * step. Two tables reference this module from people.ts and the other way round only inside
 * constraint callbacks, which Drizzle evaluates lazily.
 */

export const PRE_ADMISSION_STATUS_SQL = sqlList(["in_progress", "complete", "decided"]);
/** `INFORMATION_SOURCES` (pre-admission.ts). */
export const INFORMATION_SOURCE_SQL = sqlList([
  "person",
  "family_or_representative",
  "hospital",
  "gp",
  "social_worker",
  "previous_provider",
  "other",
]);
export const CAN_MEET_NEEDS_SQL = sqlList(["yes", "yes_with_conditions", "no"]);
/** `PROPERTY_CATEGORIES` (property.ts). Cash is never one: residents' money is a ledger. */
export const PROPERTY_CATEGORY_SQL = sqlList([
  "clothing",
  "jewellery",
  "watch",
  "electronics",
  "mobility_aid",
  "sensory_aid",
  "dentures",
  "documents",
  "furniture",
  "ornament_or_picture",
  "toiletries",
  "other",
]);
/** `PROPERTY_ITEM_STATUSES` (property.ts). */
export const PROPERTY_STATUS_SQL = sqlList([
  "held",
  "sent_with_person",
  "returned",
  "disposed",
  "lost",
]);
/** `RECIPIENT_CAPACITIES` (property.ts). */
export const RECIPIENT_CAPACITY_SQL = sqlList([
  "person",
  "representative",
  "personal_representative",
  "receiving_provider",
]);
const SIGNER_SQL = sqlList(["person", "representative", "unable_to_sign"]);
/** `CARE_PLAN_CHANGE_KINDS` (reviews.ts). */
export const CARE_PLAN_CHANGE_KIND_SQL = sqlList([
  "return_from_hospital",
  "fall",
  "change_in_needs",
  "new_diagnosis",
  "safeguarding",
  "end_of_life",
  "other",
]);
/** The review records people.md section 2 names (the scheduler's due items map onto them). */
export const REVIEW_RECORD_KIND_SQL = sqlList([
  "care_plan",
  "la_review",
  "family_involvement",
  "trial_review",
]);
/** `FAMILY_INVOLVEMENT_KINDS` (reviews.ts). */
export const FAMILY_INVOLVEMENT_KIND_SQL = sqlList([
  "attended_review",
  "contributed",
  "invited_declined",
  "person_declines_involvement",
  "no_family_or_representative",
]);
/** The states of `DISCHARGE_WORKFLOW`, `TRANSFER_WORKFLOW` and `DEATH_WORKFLOW` (exit.ts). */
export const EXIT_STATE_SQL = sqlList([
  "planned",
  "left",
  "recorded",
  "awaiting_return",
  "closed",
  "cancelled",
]);
/** `SHARING_SECTIONS` (sharing.ts). */
export const SHARING_SECTION_SQL = sqlList([
  "about_me",
  "daily_updates",
  "photos",
  "activities_and_visits",
  "care_plan",
  "health_summary",
  "medicines",
  "appointments",
  "finance",
  "documents",
]);
/** `SHARING_BASES` (sharing.ts). */
export const SHARING_BASIS_SQL = sqlList([
  "consent",
  "legal_authority",
  "best_interests",
  "direct_care",
]);
/** `AUTHORITY_ROLES` (sharing.ts). */
export const AUTHORITY_ROLE_SQL = sqlList([
  "lpa_health_welfare",
  "lpa_property_finance",
  "deputy_personal_welfare",
  "deputy_property_affairs",
  "appointee",
]);

const personRef = (name: string, t: { tenantId: AnyPgColumn; personId: AnyPgColumn }) =>
  foreignKey({
    name,
    columns: [t.tenantId, t.personId],
    foreignColumns: [person.tenantId, person.id],
  });

const userRef = (name: string, t: { tenantId: AnyPgColumn }, column: AnyPgColumn) =>
  foreignKey({
    name,
    columns: [t.tenantId, column],
    foreignColumns: [tenantUser.tenantId, tenantUser.id],
  });

// ------------------------------------------------------------------------------------------------
// Pre-admission and the decision to admit (rules 4 and 5)
// ------------------------------------------------------------------------------------------------

/**
 * The pre-admission assessment. `sections` is keyed by `PRE_ADMISSION_SECTIONS`: { status,
 * notes, notApplicableReason, completedBy, completedAt } and, for medicines, the list the
 * hospital transfer pack prints until the eMAR arrives (Phase 2). One open assessment per person.
 */
export const preAdmissionAssessment = pgTable(
  "pre_admission_assessment",
  {
    id: id(),
    tenantId: tenantId(),
    personId: uuid("person_id").notNull(),
    serviceId: uuid("service_id"),
    placementTypeSought: placementType("placement_type_sought"),
    /** `in_progress`, `complete` (every required section done) or `decided`. */
    status: text("status").notNull().default("in_progress"),
    sections: jsonb("sections").notNull().default(sql`'{}'::jsonb`),
    informationSources: text("information_sources").array().notNull().default(sql`'{}'::text[]`),
    /** Regulation 9: how the person took part, or why they could not. */
    personInvolved: boolean("person_involved"),
    involvementReason: text("involvement_reason"),
    assessorTenantUserId: uuid("assessor_tenant_user_id"),
    ...mutableColumns(),
  },
  (t) => [
    unique("pre_admission_assessment_tenant_id_id_key").on(t.tenantId, t.id),
    unique("pre_admission_assessment_tenant_person_id_key").on(t.tenantId, t.personId, t.id),
    uniqueIndex("pre_admission_assessment_one_open")
      .on(t.tenantId, t.personId)
      .where(sql`status <> 'decided' AND deleted_at IS NULL`),
    personRef("pre_admission_assessment_person_fk", t),
    foreignKey({
      name: "pre_admission_assessment_service_fk",
      columns: [t.tenantId, t.serviceId],
      foreignColumns: [service.tenantId, service.id],
    }),
    userRef("pre_admission_assessment_assessor_fk", t, t.assessorTenantUserId),
    check("pre_admission_assessment_status", sql`status IN (${PRE_ADMISSION_STATUS_SQL})`),
    check("pre_admission_assessment_sections", sql`jsonb_typeof(sections) = 'object'`),
    check(
      "pre_admission_assessment_sources",
      sql`information_sources <@ ARRAY[${INFORMATION_SOURCE_SQL}]::text[]`,
    ),
    check(
      "pre_admission_assessment_involvement",
      sql`person_involved IS NOT FALSE OR involvement_reason IS NOT NULL`,
    ),
  ],
);

/**
 * "Can we meet needs": append-only; a change is a new decision that supersedes it with a reason.
 * Who was told, and when, travels with the decision.
 */
export const admissionDecision = pgTable(
  "admission_decision",
  {
    id: id(),
    tenantId: tenantId(),
    personId: uuid("person_id").notNull(),
    assessmentId: uuid("assessment_id").notNull(),
    canMeetNeeds: text("can_meet_needs").notNull(),
    reasons: text("reasons").notNull(),
    plannedAdmissionOn: date("planned_admission_on"),
    trialEndsOn: date("trial_ends_on"),
    decidedBy: uuid("decided_by").notNull(),
    decidedAt: timestamp("decided_at", { withTimezone: true }).notNull(),
    toldWho: text("told_who"),
    toldAt: timestamp("told_at", { withTimezone: true }),
    supersedesId: uuid("supersedes_id"),
    correctionReason: text("correction_reason"),
    ...createdColumns(),
  },
  (t) => [
    unique("admission_decision_tenant_id_id_key").on(t.tenantId, t.id),
    unique("admission_decision_tenant_person_id_key").on(t.tenantId, t.personId, t.id),
    uniqueIndex("admission_decision_superseded_once")
      .on(t.tenantId, t.supersedesId)
      .where(sql`supersedes_id IS NOT NULL`),
    personRef("admission_decision_person_fk", t),
    foreignKey({
      name: "admission_decision_assessment_fk",
      columns: [t.tenantId, t.personId, t.assessmentId],
      foreignColumns: [
        preAdmissionAssessment.tenantId,
        preAdmissionAssessment.personId,
        preAdmissionAssessment.id,
      ],
    }),
    foreignKey({
      name: "admission_decision_supersedes_fk",
      columns: [t.tenantId, t.personId, t.supersedesId],
      foreignColumns: [t.tenantId, t.personId, t.id],
    }),
    userRef("admission_decision_decided_by_fk", t, t.decidedBy),
    check("admission_decision_can_meet_needs", sql`can_meet_needs IN (${CAN_MEET_NEEDS_SQL})`),
    check("admission_decision_reasons", sql`length(trim(reasons)) > 0`),
    check(
      "admission_decision_trial",
      sql`trial_ends_on IS NULL OR planned_admission_on IS NULL OR trial_ends_on > planned_admission_on`,
    ),
    check("admission_decision_told", sql`(told_who IS NULL) = (told_at IS NULL)`),
    check(
      "admission_decision_correction_reason",
      sql`supersedes_id IS NULL OR correction_reason IS NOT NULL`,
    ),
    index("admission_decision_person_idx").on(t.tenantId, t.personId, t.decidedAt),
  ],
);

/** A condition of a "yes, with conditions" decision, confirmed as met before admission. */
export const admissionCondition = pgTable(
  "admission_condition",
  {
    id: id(),
    tenantId: tenantId(),
    personId: uuid("person_id").notNull(),
    decisionId: uuid("decision_id").notNull(),
    position: integer("position").notNull(),
    condition: text("condition").notNull(),
    metBy: uuid("met_by"),
    metAt: timestamp("met_at", { withTimezone: true }),
    ...mutableColumns(),
  },
  (t) => [
    unique("admission_condition_position_key").on(t.tenantId, t.decisionId, t.position),
    personRef("admission_condition_person_fk", t),
    foreignKey({
      name: "admission_condition_decision_fk",
      columns: [t.tenantId, t.personId, t.decisionId],
      foreignColumns: [
        admissionDecision.tenantId,
        admissionDecision.personId,
        admissionDecision.id,
      ],
    }),
    userRef("admission_condition_met_by_fk", t, t.metBy),
    check("admission_condition_text", sql`length(trim(condition)) > 0`),
    check("admission_condition_met", sql`(met_by IS NULL) = (met_at IS NULL)`),
    check("admission_condition_position", sql`position >= 0`),
  ],
);

// ------------------------------------------------------------------------------------------------
// Rooms, beds and moves (rule 6)
// ------------------------------------------------------------------------------------------------

/**
 * A dated, half-open period [from_date, to_date) in one bed. Two exclusion constraints (migration
 * 0021, btree_gist) refuse a bed with two occupants on the same day and a person in two beds.
 */
export const bedOccupancy = pgTable(
  "bed_occupancy",
  {
    id: id(),
    tenantId: tenantId(),
    personId: uuid("person_id").notNull(),
    roomId: uuid("room_id").notNull(),
    bed: integer("bed").notNull().default(1),
    fromDate: date("from_date").notNull(),
    /** The day the person left the bed (exclusive); null while they occupy it. */
    toDate: date("to_date"),
    reason: text("reason").notNull(),
    /** Recorded after the day it happened (`planBedMove`). */
    backdated: boolean("backdated").notNull().default(false),
    ...mutableColumns(),
  },
  (t) => [
    unique("bed_occupancy_tenant_id_id_key").on(t.tenantId, t.id),
    personRef("bed_occupancy_person_fk", t),
    foreignKey({
      name: "bed_occupancy_room_fk",
      columns: [t.tenantId, t.roomId],
      foreignColumns: [room.tenantId, room.id],
    }),
    check("bed_occupancy_bed", sql`bed >= 1`),
    check("bed_occupancy_range", sql`to_date IS NULL OR to_date > from_date`),
    check("bed_occupancy_reason", sql`length(trim(reason)) > 0`),
    index("bed_occupancy_room_idx").on(t.tenantId, t.roomId, t.fromDate),
    index("bed_occupancy_person_idx").on(t.tenantId, t.personId, t.fromDate),
  ],
);

// ------------------------------------------------------------------------------------------------
// Welcome checklist (rule 5)
// ------------------------------------------------------------------------------------------------

/**
 * The tenant's welcome checklist (no personal data): `WelcomeChecklistItemDefinition[]`, checked
 * with `checkWelcomeChecklistDefinition`. Without a row the default checklist applies.
 */
export const welcomeChecklistTemplate = pgTable(
  "welcome_checklist_template",
  {
    id: id(),
    tenantId: tenantId(),
    items: jsonb("items").notNull(),
    ...mutableColumns(),
  },
  (t) => [
    uniqueIndex("welcome_checklist_template_one_per_tenant")
      .on(t.tenantId)
      .where(sql`deleted_at IS NULL`),
    check("welcome_checklist_template_items", sql`jsonb_typeof(items) = 'array'`),
  ],
);

/** One item of a placement's welcome checklist, copied from the definition at admission. */
export const welcomeChecklistItem = pgTable(
  "welcome_checklist_item",
  {
    id: id(),
    tenantId: tenantId(),
    personId: uuid("person_id").notNull(),
    placementId: uuid("placement_id").notNull(),
    itemKey: text("item_key").notNull(),
    title: text("title").notNull(),
    required: boolean("required").notNull(),
    safetyCritical: boolean("safety_critical").notNull(),
    allowNotApplicable: boolean("allow_not_applicable").notNull(),
    position: integer("position").notNull().default(0),
    /** `pending`, `done` or `not_applicable` (with a reason, where the item allows it). */
    status: text("status").notNull().default("pending"),
    reason: text("reason"),
    doneBy: uuid("done_by"),
    doneAt: timestamp("done_at", { withTimezone: true }),
    ...mutableColumns(),
  },
  (t) => [
    unique("welcome_checklist_item_key").on(t.tenantId, t.placementId, t.itemKey),
    personRef("welcome_checklist_item_person_fk", t),
    foreignKey({
      name: "welcome_checklist_item_placement_fk",
      columns: [t.tenantId, t.personId, t.placementId],
      foreignColumns: [placement.tenantId, placement.personId, placement.id],
    }),
    userRef("welcome_checklist_item_done_by_fk", t, t.doneBy),
    check("welcome_checklist_item_status", sql`status IN ('pending', 'done', 'not_applicable')`),
    check(
      "welcome_checklist_item_done",
      sql`status = 'pending' OR (done_by IS NOT NULL AND done_at IS NOT NULL)`,
    ),
    check(
      "welcome_checklist_item_not_applicable",
      sql`status <> 'not_applicable' OR (allow_not_applicable AND reason IS NOT NULL)`,
    ),
  ],
);

// ------------------------------------------------------------------------------------------------
// Property, valuables and keys (rule 7)
// ------------------------------------------------------------------------------------------------

/** One inventory item: in with an acknowledgement, out once (returned, disposed of or lost). */
export const propertyItem = pgTable(
  "property_item",
  {
    id: id(),
    tenantId: tenantId(),
    personId: uuid("person_id").notNull(),
    description: text("description").notNull(),
    category: text("category").notNull(),
    quantity: integer("quantity").notNull().default(1),
    /** Marked a valuable by staff; valuable categories count as valuables anyway. */
    valuable: boolean("valuable").notNull().default(false),
    photoDocumentIds: uuid("photo_document_ids").array().notNull().default(sql`'{}'::uuid[]`),
    receivedOn: date("received_on").notNull(),
    recordedBy: uuid("recorded_by").notNull(),
    ackSigner: text("ack_signer").notNull(),
    ackName: text("ack_name"),
    ackUnableReason: text("ack_unable_reason"),
    ackSignedAt: timestamp("ack_signed_at", { withTimezone: true }).notNull(),
    witnessedBy: uuid("witnessed_by"),
    status: text("status").notNull().default("held"),
    /** The hospital transfer the item went with, while it is away with the person. */
    hospitalTransferId: uuid("hospital_transfer_id"),
    returnedOn: date("returned_on"),
    returnRecipientName: text("return_recipient_name"),
    returnRecipientCapacity: text("return_recipient_capacity"),
    returnSigner: text("return_signer"),
    returnSignerName: text("return_signer_name"),
    returnUnableReason: text("return_unable_reason"),
    returnSignedAt: timestamp("return_signed_at", { withTimezone: true }),
    returnedBy: uuid("returned_by"),
    returnWitnessedBy: uuid("return_witnessed_by"),
    disposedOn: date("disposed_on"),
    disposalReason: text("disposal_reason"),
    disposedBy: uuid("disposed_by"),
    disposalWitnessedBy: uuid("disposal_witnessed_by"),
    lostOn: date("lost_on"),
    lossIncidentId: uuid("loss_incident_id"),
    ...mutableColumns(),
  },
  (t) => [
    unique("property_item_tenant_person_id_key").on(t.tenantId, t.personId, t.id),
    personRef("property_item_person_fk", t),
    userRef("property_item_recorded_by_fk", t, t.recordedBy),
    userRef("property_item_witnessed_by_fk", t, t.witnessedBy),
    userRef("property_item_returned_by_fk", t, t.returnedBy),
    userRef("property_item_return_witness_fk", t, t.returnWitnessedBy),
    userRef("property_item_disposed_by_fk", t, t.disposedBy),
    userRef("property_item_disposal_witness_fk", t, t.disposalWitnessedBy),
    foreignKey({
      name: "property_item_loss_incident_fk",
      columns: [t.tenantId, t.lossIncidentId],
      foreignColumns: [incident.tenantId, incident.id],
    }),
    foreignKey({
      name: "property_item_hospital_transfer_fk",
      columns: [t.tenantId, t.personId, t.hospitalTransferId],
      foreignColumns: [hospitalTransfer.tenantId, hospitalTransfer.personId, hospitalTransfer.id],
    }),
    check("property_item_category", sql`category IN (${PROPERTY_CATEGORY_SQL})`),
    check("property_item_quantity", sql`quantity >= 1`),
    check("property_item_status", sql`status IN (${PROPERTY_STATUS_SQL})`),
    check("property_item_description", sql`length(trim(description)) > 0`),
    check(
      "property_item_acknowledgement",
      sql`ack_signer IN (${SIGNER_SQL}) AND CASE WHEN ack_signer = 'unable_to_sign'
        THEN ack_unable_reason IS NOT NULL ELSE ack_name IS NOT NULL END`,
    ),
    check("property_item_witness", sql`witnessed_by IS NULL OR witnessed_by <> recorded_by`),
    check(
      "property_item_returned",
      sql`status <> 'returned' OR (returned_on IS NOT NULL AND return_recipient_name IS NOT NULL
        AND return_recipient_capacity IN (${RECIPIENT_CAPACITY_SQL}) AND returned_by IS NOT NULL
        AND return_signer IN (${SIGNER_SQL}))`,
    ),
    check(
      "property_item_disposed",
      sql`status <> 'disposed' OR (disposed_on IS NOT NULL AND disposal_reason IS NOT NULL
        AND disposed_by IS NOT NULL AND disposal_witnessed_by IS NOT NULL
        AND disposal_witnessed_by <> disposed_by)`,
    ),
    check(
      "property_item_lost",
      sql`status <> 'lost' OR (lost_on IS NOT NULL AND loss_incident_id IS NOT NULL)`,
    ),
    check(
      "property_item_away",
      sql`(status = 'sent_with_person') = (hospital_transfer_id IS NOT NULL)`,
    ),
    index("property_item_person_idx").on(t.tenantId, t.personId, t.status),
  ],
);

/** Room or locker keys and fobs: issued, then returned or reported lost (they block the exit). */
export const keyIssue = pgTable(
  "key_issue",
  {
    id: id(),
    tenantId: tenantId(),
    personId: uuid("person_id").notNull(),
    label: text("label").notNull(),
    issuedOn: date("issued_on").notNull(),
    /** `person` or `representative`. */
    issuedTo: text("issued_to").notNull(),
    returnedOn: date("returned_on"),
    reportedLostOn: date("reported_lost_on"),
    ...mutableColumns(),
  },
  (t) => [
    personRef("key_issue_person_fk", t),
    check("key_issue_issued_to", sql`issued_to IN ('person', 'representative')`),
    check("key_issue_label", sql`length(trim(label)) > 0`),
    check("key_issue_returned", sql`returned_on IS NULL OR returned_on >= issued_on`),
    check("key_issue_lost", sql`reported_lost_on IS NULL OR reported_lost_on >= issued_on`),
    check("key_issue_once", sql`returned_on IS NULL OR reported_lost_on IS NULL`),
    index("key_issue_person_idx").on(t.tenantId, t.personId),
  ],
);

// ------------------------------------------------------------------------------------------------
// Reviews (rule 8)
// ------------------------------------------------------------------------------------------------

/** A review record: append-only; a correction supersedes it with a reason. */
export const reviewRecord = pgTable(
  "review_record",
  {
    id: id(),
    tenantId: tenantId(),
    personId: uuid("person_id").notNull(),
    /** `care_plan`, `la_review`, `family_involvement` or `trial_review`. */
    kind: text("kind").notNull(),
    heldOn: date("held_on").notNull(),
    /** [{ role, name, contactId }]. */
    participants: jsonb("participants").notNull().default(sql`'[]'::jsonb`),
    familyInvolvementKind: text("family_involvement_kind"),
    laReference: text("la_reference"),
    /** The care plan changes this review dealt with (HZ-008). */
    changesCovered: uuid("changes_covered").array().notNull().default(sql`'{}'::uuid[]`),
    outcome: text("outcome"),
    documentId: uuid("document_id"),
    supersedesId: uuid("supersedes_id"),
    correctionReason: text("correction_reason"),
    ...createdColumns(),
  },
  (t) => [
    unique("review_record_tenant_person_id_key").on(t.tenantId, t.personId, t.id),
    personRef("review_record_person_fk", t),
    foreignKey({
      name: "review_record_document_fk",
      columns: [t.tenantId, t.documentId],
      foreignColumns: [document.tenantId, document.id],
    }),
    foreignKey({
      name: "review_record_supersedes_fk",
      columns: [t.tenantId, t.personId, t.supersedesId],
      foreignColumns: [t.tenantId, t.personId, t.id],
    }),
    check("review_record_kind", sql`kind IN (${REVIEW_RECORD_KIND_SQL})`),
    check(
      "review_record_family",
      sql`(kind = 'family_involvement') = (family_involvement_kind IS NOT NULL)
        AND (family_involvement_kind IS NULL OR family_involvement_kind IN (${FAMILY_INVOLVEMENT_KIND_SQL}))`,
    ),
    check("review_record_participants", sql`jsonb_typeof(participants) = 'array'`),
    check(
      "review_record_correction_reason",
      sql`supersedes_id IS NULL OR correction_reason IS NOT NULL`,
    ),
    index("review_record_person_idx").on(t.tenantId, t.personId, t.kind, t.heldOn),
  ],
);

/**
 * A change that needs the care plan reviewed (a return from hospital, a fall, a change in needs).
 * Unreviewed changes raise one review on change between them (HZ-008).
 */
export const carePlanChange = pgTable(
  "care_plan_change",
  {
    id: id(),
    tenantId: tenantId(),
    personId: uuid("person_id").notNull(),
    kind: text("kind").notNull(),
    occurredOn: date("occurred_on").notNull(),
    /** `incident`, `hospital_transfer`, `care_note`, `assessment` or `other`, with its id. */
    sourceType: text("source_type"),
    sourceId: uuid("source_id"),
    reviewedOn: date("reviewed_on"),
    reviewRecordId: uuid("review_record_id"),
    ...mutableColumns(),
  },
  (t) => [
    personRef("care_plan_change_person_fk", t),
    foreignKey({
      name: "care_plan_change_review_fk",
      columns: [t.tenantId, t.personId, t.reviewRecordId],
      foreignColumns: [reviewRecord.tenantId, reviewRecord.personId, reviewRecord.id],
    }),
    uniqueIndex("care_plan_change_source_once")
      .on(t.tenantId, t.sourceType, t.sourceId, t.kind)
      .where(sql`source_id IS NOT NULL AND deleted_at IS NULL`),
    check("care_plan_change_kind", sql`kind IN (${CARE_PLAN_CHANGE_KIND_SQL})`),
    check(
      "care_plan_change_source",
      sql`(source_type IS NULL) = (source_id IS NULL) AND (source_type IS NULL
        OR source_type IN ('incident', 'hospital_transfer', 'care_note', 'assessment', 'other'))`,
    ),
    check("care_plan_change_reviewed", sql`review_record_id IS NULL OR reviewed_on IS NOT NULL`),
    index("care_plan_change_person_idx").on(t.tenantId, t.personId, t.occurredOn),
  ],
);

// ------------------------------------------------------------------------------------------------
// Hospital transfer (rule 10) and exits (rules 11 and 12)
// ------------------------------------------------------------------------------------------------

/**
 * A hospital transfer with the pack as assembled from the record (HZ-023): the snapshot is what was
 * printed, the missing sections are what the first page flagged, and a hand-over of an incomplete
 * pack carries a named acknowledgement and reason.
 */
export const hospitalTransfer = pgTable(
  "hospital_transfer",
  {
    id: id(),
    tenantId: tenantId(),
    personId: uuid("person_id").notNull(),
    locationId: uuid("location_id").notNull(),
    leftAt: timestamp("left_at", { withTimezone: true }).notNull(),
    hospitalName: text("hospital_name").notNull(),
    hospitalOdsCode: text("hospital_ods_code"),
    reason: text("reason"),
    /** `assembleHospitalTransferPack` output, as JSON. */
    pack: jsonb("pack").notNull(),
    missingCritical: text("missing_critical").array().notNull().default(sql`'{}'::text[]`),
    missingExpected: text("missing_expected").array().notNull().default(sql`'{}'::text[]`),
    itemsSent: uuid("items_sent").array().notNull().default(sql`'{}'::uuid[]`),
    handedOverAt: timestamp("handed_over_at", { withTimezone: true }),
    handedOverBy: uuid("handed_over_by"),
    ackBy: uuid("ack_by"),
    ackAt: timestamp("ack_at", { withTimezone: true }),
    ackReason: text("ack_reason"),
    returnedAt: timestamp("returned_at", { withTimezone: true }),
    /** { [checkKey]: { title, hazardIds, doneBy, doneAt } } from `returnFromHospitalChecks`. */
    returnChecks: jsonb("return_checks").notNull().default(sql`'{}'::jsonb`),
    ...mutableColumns(),
  },
  (t) => [
    unique("hospital_transfer_tenant_person_id_key").on(t.tenantId, t.personId, t.id),
    uniqueIndex("hospital_transfer_one_open")
      .on(t.tenantId, t.personId)
      .where(sql`returned_at IS NULL AND deleted_at IS NULL`),
    personRef("hospital_transfer_person_fk", t),
    foreignKey({
      name: "hospital_transfer_location_fk",
      columns: [t.tenantId, t.locationId],
      foreignColumns: [location.tenantId, location.id],
    }),
    userRef("hospital_transfer_handed_over_by_fk", t, t.handedOverBy),
    userRef("hospital_transfer_ack_by_fk", t, t.ackBy),
    check("hospital_transfer_hospital", sql`length(trim(hospital_name)) > 0`),
    check("hospital_transfer_returned", sql`returned_at IS NULL OR returned_at >= left_at`),
    check(
      "hospital_transfer_handed_over",
      sql`(handed_over_at IS NULL) = (handed_over_by IS NULL)`,
    ),
    check(
      "hospital_transfer_acknowledgement",
      sql`(ack_by IS NULL) = (ack_at IS NULL) AND (ack_by IS NULL) = (ack_reason IS NULL)`,
    ),
    check("hospital_transfer_pack", sql`jsonb_typeof(pack) = 'object'`),
    check("hospital_transfer_return_checks", sql`jsonb_typeof(return_checks) = 'object'`),
  ],
);

/**
 * A discharge, transfer or death, run on its exit workflow. The `ExitContext` flags decide the
 * checklist and the notifications; the return deadlines come from the rate table.
 */
export const exitRecord = pgTable(
  "exit_record",
  {
    id: id(),
    tenantId: tenantId(),
    personId: uuid("person_id").notNull(),
    locationId: uuid("location_id").notNull(),
    /** `discharge`, `transfer` or `death`. */
    kind: text("kind").notNull(),
    /** Mirrors the exit workflow's state. */
    state: text("state").notNull(),
    workflowInstanceId: uuid("workflow_instance_id"),
    /** When the person left or died; null while a discharge is only planned. */
    leftAt: timestamp("left_at", { withTimezone: true }),
    regulator: text("regulator").notNull(),
    localAuthorityFunded: boolean("local_authority_funded").notNull().default(false),
    nhsFunded: boolean("nhs_funded").notNull().default(false),
    placeOfDeath: text("place_of_death"),
    deathExpected: boolean("death_expected"),
    learningDisabilityOrAutism: boolean("learning_disability_or_autism").notNull().default(false),
    dolsInPlace: boolean("dols_in_place").notNull().default(false),
    homeIsDwpAppointee: boolean("home_is_dwp_appointee").notNull().default(false),
    holdsResidentsMoney: boolean("holds_residents_money").notNull().default(false),
    holdsDeposit: boolean("holds_deposit").notNull().default(false),
    hasLoanEquipment: boolean("has_loan_equipment").notNull().default(false),
    destinationType: text("destination_type"),
    receivingProviderName: text("receiving_provider_name"),
    receivingProviderCqcLocationId: text("receiving_provider_cqc_location_id"),
    receivingProviderOdsCode: text("receiving_provider_ods_code"),
    reason: text("reason"),
    verifiedByName: text("verified_by_name"),
    verifiedByRole: text("verified_by_role"),
    verifiedAt: timestamp("verified_at", { withTimezone: true }),
    presentAtDeath: text("present_at_death"),
    funeralDirector: text("funeral_director"),
    collectionAt: timestamp("collection_at", { withTimezone: true }),
    coronerReferredBy: text("coroner_referred_by"),
    coronerReference: text("coroner_reference"),
    moneyAndPropertyDueAt: timestamp("money_and_property_due_at", { withTimezone: true }),
    depositDueAt: timestamp("deposit_due_at", { withTimezone: true }),
    closedAt: timestamp("closed_at", { withTimezone: true }),
    cancelledReason: text("cancelled_reason"),
    ...mutableColumns(),
  },
  (t) => [
    unique("exit_record_tenant_person_id_key").on(t.tenantId, t.personId, t.id),
    uniqueIndex("exit_record_one_open")
      .on(t.tenantId, t.personId)
      .where(sql`state NOT IN ('closed', 'cancelled') AND deleted_at IS NULL`),
    personRef("exit_record_person_fk", t),
    foreignKey({
      name: "exit_record_location_fk",
      columns: [t.tenantId, t.locationId],
      foreignColumns: [location.tenantId, location.id],
    }),
    foreignKey({
      name: "exit_record_workflow_fk",
      columns: [t.tenantId, t.workflowInstanceId],
      foreignColumns: [workflowInstance.tenantId, workflowInstance.id],
    }),
    check("exit_record_kind", sql`kind IN ('discharge', 'transfer', 'death')`),
    check(
      "exit_record_state",
      sql`state IN (${EXIT_STATE_SQL}) AND CASE WHEN kind = 'death'
        THEN state NOT IN ('planned', 'left') ELSE state <> 'recorded' END`,
    ),
    check("exit_record_regulator", sql`regulator IN ('cqc', 'ciw', 'care_inspectorate', 'rqia')`),
    check(
      "exit_record_death",
      sql`CASE WHEN kind = 'death'
        THEN place_of_death IN ('care_home', 'hospital', 'elsewhere') AND left_at IS NOT NULL
        ELSE place_of_death IS NULL AND death_expected IS NULL END`,
    ),
    check(
      "exit_record_destination",
      sql`destination_type IS NULL OR destination_type IN ('own_home', 'family_home', 'care_home',
        'hospital', 'hospice', 'supported_living', 'other')`,
    ),
    check("exit_record_left", sql`state IN ('planned', 'cancelled') OR left_at IS NOT NULL`),
    check("exit_record_cancelled", sql`state <> 'cancelled' OR cancelled_reason IS NOT NULL`),
    check("exit_record_closed", sql`state <> 'closed' OR closed_at IS NOT NULL`),
    index("exit_record_person_idx").on(t.tenantId, t.personId),
  ],
);

/** One item of an exit checklist (`exitChecklist`), with its owner and evidence. */
export const exitChecklistItem = pgTable(
  "exit_checklist_item",
  {
    id: id(),
    tenantId: tenantId(),
    personId: uuid("person_id").notNull(),
    exitRecordId: uuid("exit_record_id").notNull(),
    itemKey: text("item_key").notNull(),
    title: text("title").notNull(),
    /** `people`, `care`, `medicines`, `safety` or `finance`. */
    owner: text("owner").notNull(),
    returnItem: boolean("return_item").notNull().default(false),
    allowNotRequired: boolean("allow_not_required").notNull().default(false),
    position: integer("position").notNull().default(0),
    /** `pending`, `done` or `not_required` (with a reason, where the item allows it). */
    status: text("status").notNull().default("pending"),
    reason: text("reason"),
    doneBy: uuid("done_by"),
    doneAt: timestamp("done_at", { withTimezone: true }),
    /** A notification, document or ledger entry that shows it was done. */
    evidenceType: text("evidence_type"),
    evidenceId: uuid("evidence_id"),
    ...mutableColumns(),
  },
  (t) => [
    unique("exit_checklist_item_key").on(t.tenantId, t.exitRecordId, t.itemKey),
    personRef("exit_checklist_item_person_fk", t),
    foreignKey({
      name: "exit_checklist_item_exit_fk",
      columns: [t.tenantId, t.personId, t.exitRecordId],
      foreignColumns: [exitRecord.tenantId, exitRecord.personId, exitRecord.id],
    }),
    userRef("exit_checklist_item_done_by_fk", t, t.doneBy),
    check(
      "exit_checklist_item_owner",
      sql`owner IN ('people', 'care', 'medicines', 'safety', 'finance')`,
    ),
    check("exit_checklist_item_status", sql`status IN ('pending', 'done', 'not_required')`),
    check(
      "exit_checklist_item_done",
      sql`status = 'pending' OR (done_by IS NOT NULL AND done_at IS NOT NULL)`,
    ),
    check(
      "exit_checklist_item_not_required",
      sql`status <> 'not_required' OR (allow_not_required AND reason IS NOT NULL)`,
    ),
    check(
      "exit_checklist_item_evidence",
      sql`(evidence_type IS NULL) = (evidence_id IS NULL) AND (evidence_type IS NULL
        OR evidence_type IN ('statutory_notification', 'document', 'ledger_entry', 'note'))`,
    ),
  ],
);

// ------------------------------------------------------------------------------------------------
// Sharing (rule 13, HZ-022) and About Me share links (rule 9)
// ------------------------------------------------------------------------------------------------

/**
 * A recorded decision to share sections of a person's record with one recipient: a family member
 * or representative (a contact), a professional (a tenant user) or an About Me share link. Closed
 * by default: nothing is shared without a decision in force, and every decision expires.
 */
export const sharingDecision = pgTable(
  "sharing_decision",
  {
    id: id(),
    tenantId: tenantId(),
    personId: uuid("person_id").notNull(),
    /** `family`, `professional` or `link`. */
    recipientKind: text("recipient_kind").notNull(),
    recipientContactId: uuid("recipient_contact_id"),
    recipientTenantUserId: uuid("recipient_tenant_user_id"),
    sections: text("sections").array().notNull(),
    /** Care plan domains shared when `care_plan` is a section; null means every domain. */
    carePlanDomains: text("care_plan_domains").array(),
    basis: text("basis").notNull(),
    /** For consent: `person` or `authority_holder`. */
    consentGivenBy: text("consent_given_by"),
    /** `presumed`, `assessed_has_capacity` or `assessed_lacks_capacity`. */
    capacity: text("capacity").notNull().default("presumed"),
    capacityAssessmentId: uuid("capacity_assessment_id"),
    bestInterestsDecisionId: uuid("best_interests_decision_id"),
    authorityRole: text("authority_role"),
    authorityContactId: uuid("authority_contact_id"),
    authorityReference: text("authority_reference"),
    authorityEvidenceDocumentId: uuid("authority_evidence_document_id"),
    authorityValidUntil: date("authority_valid_until"),
    validFrom: timestamp("valid_from", { withTimezone: true }).notNull(),
    /** Every decision expires (people.md rule 13). */
    validTo: timestamp("valid_to", { withTimezone: true }).notNull(),
    withdrawnAt: timestamp("withdrawn_at", { withTimezone: true }),
    withdrawnReason: text("withdrawn_reason"),
    suspendedAt: timestamp("suspended_at", { withTimezone: true }),
    suspendedReason: text("suspended_reason"),
    ...mutableColumns(),
  },
  (t) => [
    unique("sharing_decision_tenant_person_id_key").on(t.tenantId, t.personId, t.id),
    personRef("sharing_decision_person_fk", t),
    foreignKey({
      name: "sharing_decision_recipient_contact_fk",
      columns: [t.tenantId, t.personId, t.recipientContactId],
      foreignColumns: [contact.tenantId, contact.personId, contact.id],
    }),
    userRef("sharing_decision_recipient_user_fk", t, t.recipientTenantUserId),
    foreignKey({
      name: "sharing_decision_authority_contact_fk",
      columns: [t.tenantId, t.personId, t.authorityContactId],
      foreignColumns: [contact.tenantId, contact.personId, contact.id],
    }),
    foreignKey({
      name: "sharing_decision_capacity_fk",
      columns: [t.tenantId, t.personId, t.capacityAssessmentId],
      foreignColumns: [
        capacityAssessment.tenantId,
        capacityAssessment.personId,
        capacityAssessment.id,
      ],
    }),
    foreignKey({
      name: "sharing_decision_best_interests_fk",
      columns: [t.tenantId, t.personId, t.bestInterestsDecisionId],
      foreignColumns: [
        bestInterestsDecision.tenantId,
        bestInterestsDecision.personId,
        bestInterestsDecision.id,
      ],
    }),
    foreignKey({
      name: "sharing_decision_evidence_fk",
      columns: [t.tenantId, t.authorityEvidenceDocumentId],
      foreignColumns: [document.tenantId, document.id],
    }),
    check(
      "sharing_decision_recipient",
      sql`CASE recipient_kind
        WHEN 'family' THEN recipient_contact_id IS NOT NULL AND recipient_tenant_user_id IS NULL
        WHEN 'professional' THEN recipient_tenant_user_id IS NOT NULL AND recipient_contact_id IS NULL
        WHEN 'link' THEN recipient_contact_id IS NULL AND recipient_tenant_user_id IS NULL
        ELSE false END`,
    ),
    check(
      "sharing_decision_sections",
      sql`cardinality(sections) > 0 AND sections <@ ARRAY[${SHARING_SECTION_SQL}]::text[]`,
    ),
    check("sharing_decision_basis", sql`basis IN (${SHARING_BASIS_SQL})`),
    check(
      "sharing_decision_capacity_value",
      sql`capacity IN ('presumed', 'assessed_has_capacity', 'assessed_lacks_capacity')`,
    ),
    check(
      "sharing_decision_consent_given_by",
      sql`consent_given_by IS NULL OR consent_given_by IN ('person', 'authority_holder')`,
    ),
    check(
      "sharing_decision_authority_role",
      sql`authority_role IS NULL OR authority_role IN (${AUTHORITY_ROLE_SQL})`,
    ),
    check("sharing_decision_period", sql`valid_to > valid_from`),
    check("sharing_decision_withdrawn", sql`withdrawn_at IS NULL OR withdrawn_reason IS NOT NULL`),
    check("sharing_decision_suspended", sql`suspended_at IS NULL OR suspended_reason IS NOT NULL`),
    index("sharing_decision_person_idx").on(t.tenantId, t.personId, t.validTo),
  ],
);

/**
 * An expiring link to the person's About Me. Only the SHA-256 hash of the token is stored; the
 * token itself is shown once, when the link is made, and never outlives its sharing decision.
 */
export const aboutMeShareLink = pgTable(
  "about_me_share_link",
  {
    id: id(),
    tenantId: tenantId(),
    personId: uuid("person_id").notNull(),
    sharingDecisionId: uuid("sharing_decision_id").notNull(),
    tokenHash: text("token_hash").notNull(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    revokedAt: timestamp("revoked_at", { withTimezone: true }),
    revokedReason: text("revoked_reason"),
    lastOpenedAt: timestamp("last_opened_at", { withTimezone: true }),
    ...mutableColumns(),
  },
  (t) => [
    unique("about_me_share_link_token_hash_key").on(t.tokenHash),
    personRef("about_me_share_link_person_fk", t),
    foreignKey({
      name: "about_me_share_link_decision_fk",
      columns: [t.tenantId, t.personId, t.sharingDecisionId],
      foreignColumns: [sharingDecision.tenantId, sharingDecision.personId, sharingDecision.id],
    }),
    check("about_me_share_link_token_hash", sql`token_hash ~ '^[0-9a-f]{64}$'`),
    check("about_me_share_link_revoked", sql`revoked_at IS NULL OR revoked_reason IS NOT NULL`),
    index("about_me_share_link_person_idx").on(t.tenantId, t.personId),
  ],
);

// ------------------------------------------------------------------------------------------------
// Weekly break-glass report (rule 14, PLAT-006, HZ-011)
// ------------------------------------------------------------------------------------------------

/**
 * The Monday report of the week before, one per location: counts and opaque ids only. Append-only:
 * the Registered Manager's review is a new row that supersedes the report and says what was done.
 */
export const breakGlassWeeklyReport = pgTable(
  "break_glass_weekly_report",
  {
    id: id(),
    tenantId: tenantId(),
    locationId: uuid("location_id").notNull(),
    weekStart: timestamp("week_start", { withTimezone: true }).notNull(),
    weekEnd: timestamp("week_end", { withTimezone: true }).notNull(),
    generatedAt: timestamp("generated_at", { withTimezone: true }).notNull().defaultNow(),
    repeatThreshold: integer("repeat_threshold").notNull(),
    /** `breakGlassWeeklyReport` output: totals, lines by user, person and reason, flags. */
    summary: jsonb("summary").notNull(),
    reviewedBy: uuid("reviewed_by"),
    reviewedAt: timestamp("reviewed_at", { withTimezone: true }),
    actionsTaken: text("actions_taken"),
    supersedesId: uuid("supersedes_id"),
    ...createdColumns(),
  },
  (t) => [
    unique("break_glass_weekly_report_tenant_id_id_key").on(t.tenantId, t.id),
    uniqueIndex("break_glass_weekly_report_once")
      .on(t.tenantId, t.locationId, t.weekStart)
      .where(sql`supersedes_id IS NULL`),
    uniqueIndex("break_glass_weekly_report_reviewed_once")
      .on(t.tenantId, t.supersedesId)
      .where(sql`supersedes_id IS NOT NULL`),
    foreignKey({
      name: "break_glass_weekly_report_location_fk",
      columns: [t.tenantId, t.locationId],
      foreignColumns: [location.tenantId, location.id],
    }),
    foreignKey({
      name: "break_glass_weekly_report_supersedes_fk",
      columns: [t.tenantId, t.supersedesId],
      foreignColumns: [t.tenantId, t.id],
    }),
    userRef("break_glass_weekly_report_reviewed_by_fk", t, t.reviewedBy),
    check("break_glass_weekly_report_week", sql`week_end > week_start`),
    check("break_glass_weekly_report_threshold", sql`repeat_threshold >= 2`),
    check("break_glass_weekly_report_summary", sql`jsonb_typeof(summary) = 'object'`),
    check(
      "break_glass_weekly_report_review",
      sql`(reviewed_by IS NULL) = (reviewed_at IS NULL)
        AND (supersedes_id IS NULL) = (reviewed_by IS NULL)`,
    ),
  ],
);

export const PEOPLE_LIFECYCLE_MUTABLE_TABLES = [
  "pre_admission_assessment",
  "admission_condition",
  "bed_occupancy",
  "welcome_checklist_template",
  "welcome_checklist_item",
  "property_item",
  "key_issue",
  "care_plan_change",
  "hospital_transfer",
  "exit_record",
  "exit_checklist_item",
  "sharing_decision",
  "about_me_share_link",
] as const;
export const PEOPLE_LIFECYCLE_APPEND_ONLY_TABLES = [
  "admission_decision",
  "review_record",
  "break_glass_weekly_report",
] as const;

export type PreAdmissionAssessmentRow = typeof preAdmissionAssessment.$inferSelect;
export type AdmissionDecisionRow = typeof admissionDecision.$inferSelect;
export type AdmissionConditionRow = typeof admissionCondition.$inferSelect;
export type BedOccupancyRow = typeof bedOccupancy.$inferSelect;
export type WelcomeChecklistItemRow = typeof welcomeChecklistItem.$inferSelect;
export type PropertyItemRow = typeof propertyItem.$inferSelect;
export type KeyIssueRow = typeof keyIssue.$inferSelect;
export type ReviewRecordRow = typeof reviewRecord.$inferSelect;
export type CarePlanChangeRow = typeof carePlanChange.$inferSelect;
export type HospitalTransferRow = typeof hospitalTransfer.$inferSelect;
export type ExitRecordRow = typeof exitRecord.$inferSelect;
export type ExitChecklistItemRow = typeof exitChecklistItem.$inferSelect;
export type SharingDecisionRow = typeof sharingDecision.$inferSelect;
export type AboutMeShareLinkRow = typeof aboutMeShareLink.$inferSelect;
export type BreakGlassWeeklyReportRow = typeof breakGlassWeeklyReport.$inferSelect;
