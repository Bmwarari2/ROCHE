import { sql } from "drizzle-orm";
import {
  type AnyPgColumn,
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
import { createdColumns, id, mutableColumns, tenantId } from "./_columns";
import { bestInterestsDecision, capacityAssessment } from "./mca";
import { medication } from "./medicines";
import { person } from "./people";
import { location, tenantUser } from "./platform";

/**
 * Covert administration, self-administration and homely remedies (Phase 2 slice 38;
 * medicines.md section 15; MEDS-004, MEDS-006, MEDS-007; HZ-026, HZ-120). Migration 0142.
 */

const personRef = (name: string, t: { tenantId: AnyPgColumn; personId: AnyPgColumn }) =>
  foreignKey({
    name,
    columns: [t.tenantId, t.personId],
    foreignColumns: [person.tenantId, person.id],
  });

const memberRef = (name: string, tenant: AnyPgColumn, member: AnyPgColumn) =>
  foreignKey({
    name,
    columns: [tenant, member],
    foreignColumns: [tenantUser.tenantId, tenantUser.id],
  });

export const COVERT_ATTENDEE_ROLES_SQL =
  "'prescriber','pharmacist','registered_manager','nurse','care_staff','family_or_friend','representative','advocate','other'";

/** One medicine given covertly under a best-interests decision (mutable, history kept). */
export const covertMedicationRecord = pgTable(
  "covert_medication_record",
  {
    id: id(),
    tenantId: tenantId(),
    personId: uuid("person_id").notNull(),
    /** The entry version chosen; the guard copies its stable `medicine_id`. */
    medicationId: uuid("medication_id").notNull(),
    medicineId: uuid("medicine_id").notNull(),
    capacityAssessmentId: uuid("capacity_assessment_id").notNull(),
    bestInterestsDecisionId: uuid("best_interests_decision_id").notNull(),
    /** [{ role, name }]: who took part, including the prescriber and a pharmacist. */
    attendees: jsonb("attendees").notNull(),
    method: text("method").notNull(),
    pharmacistAdvice: text("pharmacist_advice").notNull(),
    startsOn: date("starts_on").notNull(),
    reviewOn: date("review_on").notNull(),
    /** The last review recorded (a change with the new review date). */
    reviewedOn: date("reviewed_on"),
    endedOn: date("ended_on"),
    endedReason: text("ended_reason"),
    /** Why it was last changed: required on every change (the guard). */
    changeReason: text("change_reason"),
    ...mutableColumns(),
  },
  (t) => [
    unique("covert_medication_record_tenant_id_id_key").on(t.tenantId, t.id),
    personRef("covert_medication_record_person_fk", t),
    foreignKey({
      name: "covert_medication_record_medication_fk",
      columns: [t.tenantId, t.personId, t.medicationId],
      foreignColumns: [medication.tenantId, medication.personId, medication.id],
    }),
    foreignKey({
      name: "covert_medication_record_capacity_fk",
      columns: [t.tenantId, t.personId, t.capacityAssessmentId],
      foreignColumns: [
        capacityAssessment.tenantId,
        capacityAssessment.personId,
        capacityAssessment.id,
      ],
    }),
    foreignKey({
      name: "covert_medication_record_best_interests_fk",
      columns: [t.tenantId, t.personId, t.bestInterestsDecisionId],
      foreignColumns: [
        bestInterestsDecision.tenantId,
        bestInterestsDecision.personId,
        bestInterestsDecision.id,
      ],
    }),
    // One open record per medicine.
    uniqueIndex("covert_medication_record_open_key")
      .on(t.tenantId, t.medicineId)
      .where(sql`ended_on IS NULL AND deleted_at IS NULL`),
    index("covert_medication_record_person_idx").on(t.tenantId, t.personId),
    check("covert_medication_record_attendees", sql`jsonb_typeof(attendees) = 'array'`),
    check(
      "covert_medication_record_words",
      sql`length(btrim(method)) > 0 AND length(btrim(pharmacist_advice)) > 0`,
    ),
    check("covert_medication_record_review", sql`review_on > starts_on`),
    check(
      "covert_medication_record_ended",
      sql`(ended_on IS NULL) = (ended_reason IS NULL)
        AND (ended_reason IS NULL OR length(btrim(ended_reason)) > 0)`,
    ),
  ],
);

/** A self-administration assessment of named medicines (append-only; a review is a new one). */
export const selfAdministrationAssessment = pgTable(
  "self_administration_assessment",
  {
    id: id(),
    tenantId: tenantId(),
    personId: uuid("person_id").notNull(),
    /** Stable medicine ids of the person's entries it covers. */
    medicineIds: uuid("medicine_ids").array().notNull(),
    choice: text("choice").notNull(),
    capacity: text("capacity").notNull(),
    capacityAssessmentId: uuid("capacity_assessment_id"),
    dexterity: text("dexterity").notNull(),
    storage: text("storage").notNull(),
    level: text("level").notNull(),
    /** What was found and agreed, in words. */
    notes: text("notes"),
    assessedOn: date("assessed_on").notNull(),
    reviewOn: date("review_on").notNull(),
    assessedBy: uuid("assessed_by").notNull(),
    recordedAt: timestamp("recorded_at", { withTimezone: true }).notNull().defaultNow(),
    ...createdColumns(),
  },
  (t) => [
    unique("self_administration_assessment_tenant_id_id_key").on(t.tenantId, t.id),
    personRef("self_administration_assessment_person_fk", t),
    memberRef("self_administration_assessment_assessed_by_fk", t.tenantId, t.assessedBy),
    foreignKey({
      name: "self_administration_assessment_capacity_fk",
      columns: [t.tenantId, t.personId, t.capacityAssessmentId],
      foreignColumns: [
        capacityAssessment.tenantId,
        capacityAssessment.personId,
        capacityAssessment.id,
      ],
    }),
    index("self_administration_assessment_person_idx").on(t.tenantId, t.personId, t.assessedOn),
    check("self_administration_assessment_choice", sql`choice IN ('wants_to', 'does_not_want_to')`),
    check(
      "self_administration_assessment_capacity",
      sql`capacity IN ('has_capacity', 'lacks_capacity', 'assumed')
        AND (capacity = 'assumed') = (capacity_assessment_id IS NULL)`,
    ),
    check(
      "self_administration_assessment_dexterity",
      sql`dexterity IN ('able', 'able_with_aids', 'unable')`,
    ),
    check(
      "self_administration_assessment_storage",
      sql`storage IN ('lockable_storage', 'no_lockable_storage')`,
    ),
    check(
      "self_administration_assessment_level",
      sql`level IN ('self_administers', 'self_administers_with_support', 'staff_administer')
        AND (level = 'staff_administer' OR (choice = 'wants_to' AND capacity <> 'lacks_capacity'
          AND dexterity <> 'unable' AND storage = 'lockable_storage'))`,
    ),
    check("self_administration_assessment_medicines", sql`cardinality(medicine_ids) > 0`),
    check("self_administration_assessment_review", sql`review_on > assessed_on`),
  ],
);

/** A home's homely remedy protocol, agreed with a GP or pharmacist (mutable, history kept). */
export const homelyRemedyProtocol = pgTable(
  "homely_remedy_protocol",
  {
    id: id(),
    tenantId: tenantId(),
    locationId: uuid("location_id").notNull(),
    productName: text("product_name").notNull(),
    /** dm+d product, when coded: an exact match with a prescribed entry is refused. */
    vmpId: text("vmp_id"),
    indication: text("indication").notNull(),
    doseQuantity: numeric("dose_quantity", { precision: 12, scale: 3 }).notNull(),
    unitName: text("unit_name").notNull(),
    minIntervalHours: numeric("min_interval_hours", { precision: 6, scale: 2 }).notNull(),
    maxDailyQuantity: numeric("max_daily_quantity", { precision: 12, scale: 3 }).notNull(),
    /** Days a course may last before the person's GP is asked. */
    maxDays: integer("max_days").notNull(),
    authorisedMemberIds: uuid("authorised_member_ids").array().notNull(),
    approvedByName: text("approved_by_name").notNull(),
    approvedByRole: text("approved_by_role").notNull(),
    approvedOn: date("approved_on").notNull(),
    reviewOn: date("review_on").notNull(),
    withdrawnAt: timestamp("withdrawn_at", { withTimezone: true }),
    withdrawnReason: text("withdrawn_reason"),
    changeReason: text("change_reason"),
    ...mutableColumns(),
  },
  (t) => [
    unique("homely_remedy_protocol_tenant_id_id_key").on(t.tenantId, t.id),
    foreignKey({
      name: "homely_remedy_protocol_location_fk",
      columns: [t.tenantId, t.locationId],
      foreignColumns: [location.tenantId, location.id],
    }),
    index("homely_remedy_protocol_location_idx").on(t.tenantId, t.locationId),
    check(
      "homely_remedy_protocol_figures",
      sql`dose_quantity > 0 AND max_daily_quantity >= dose_quantity AND min_interval_hours > 0
        AND max_days >= 1`,
    ),
    check("homely_remedy_protocol_vmp", sql`vmp_id IS NULL OR vmp_id ~ '^[0-9]{6,18}$'`),
    check("homely_remedy_protocol_role", sql`approved_by_role IN ('gp', 'pharmacist')`),
    check("homely_remedy_protocol_staff", sql`cardinality(authorised_member_ids) > 0`),
    check("homely_remedy_protocol_review", sql`review_on > approved_on`),
    check(
      "homely_remedy_protocol_withdrawn",
      sql`(withdrawn_at IS NULL) = (withdrawn_reason IS NULL)`,
    ),
  ],
);

/** A homely remedy dose (append-only; a record entered in error is marked by a new row). */
export const homelyRemedyAdministration = pgTable(
  "homely_remedy_administration",
  {
    /** The client's UUID: the same id twice is the same record. */
    id: uuid("id").primaryKey(),
    tenantId: tenantId(),
    personId: uuid("person_id").notNull(),
    protocolId: uuid("protocol_id").notNull(),
    /** The protocol's version the dose was checked against. */
    protocolVersion: integer("protocol_version").notNull(),
    outcome: text("outcome").notNull(),
    quantity: numeric("quantity", { precision: 12, scale: 3 }),
    /** Why it was given, in words (the symptom). */
    reason: text("reason"),
    givenAt: timestamp("given_at", { withTimezone: true }).notNull(),
    givenBy: uuid("given_by").notNull(),
    recordedAt: timestamp("recorded_at", { withTimezone: true }).notNull().defaultNow(),
    supersedesId: uuid("supersedes_id"),
    correctionReason: text("correction_reason"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    unique("homely_remedy_administration_tenant_id_id_key").on(t.tenantId, t.id),
    unique("homely_remedy_administration_tenant_person_id_key").on(t.tenantId, t.personId, t.id),
    personRef("homely_remedy_administration_person_fk", t),
    memberRef("homely_remedy_administration_given_by_fk", t.tenantId, t.givenBy),
    foreignKey({
      name: "homely_remedy_administration_protocol_fk",
      columns: [t.tenantId, t.protocolId],
      foreignColumns: [homelyRemedyProtocol.tenantId, homelyRemedyProtocol.id],
    }),
    foreignKey({
      name: "homely_remedy_administration_supersedes_fk",
      columns: [t.tenantId, t.personId, t.supersedesId],
      foreignColumns: [t.tenantId, t.personId, t.id],
    }),
    uniqueIndex("homely_remedy_administration_supersedes_key")
      .on(t.tenantId, t.supersedesId)
      .where(sql`supersedes_id IS NOT NULL`),
    index("homely_remedy_administration_person_idx").on(t.tenantId, t.personId, t.givenAt),
    check(
      "homely_remedy_administration_outcome",
      sql`(outcome = 'given' AND quantity > 0 AND supersedes_id IS NULL AND correction_reason IS NULL
           AND length(btrim(coalesce(reason, ''))) > 0)
       OR (outcome = 'entered_in_error' AND quantity IS NULL AND supersedes_id IS NOT NULL
           AND supersedes_id <> id AND length(btrim(coalesce(correction_reason, ''))) > 0)`,
    ),
  ],
);
