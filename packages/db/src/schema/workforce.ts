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
  unique,
  uuid,
} from "drizzle-orm/pg-core";
import { sqlList } from "./_codes";
import { createdColumns, id, mutableColumns, tenantId } from "./_columns";
import { location, tenantUser } from "./platform";

/**
 * The staff profile and pre-employment file (workforce.md section 2a; WORK-002, WORK-011; plan
 * slice 11, migration 0073). One profile per member of staff, and one compliance item per Schedule
 * 3 requirement. Whether an item is satisfied is never stored: `staffFileState` in packages/domain
 * works it out from the details on the day asked about. Read by holders of
 * `workforce.staff_file.read` (or the worker themselves with `workforce.self.read`), written by
 * holders of `workforce.staff_file.manage`, never by the worker; the DBS risk assessment is signed
 * only by a holder of `workforce.dbs_risk_assessment.sign`. The database enforces the same.
 */

/** `SCHEDULE3_ITEMS` in packages/domain, kept in step by test/staff-file.test.ts. */
export const COMPLIANCE_ITEM_KINDS = [
  "identity_with_photo",
  "dbs_certificate",
  "conduct_in_care_work",
  "references",
  "relevant_qualifications",
  "employment_history",
  "health_fitness",
  "right_to_work",
  "professional_registration",
] as const;

/** Professional registers a role may need (`RoleRegistration` in packages/domain). */
export const REGISTRATION_BODIES = ["nmc", "hcpc", "swe", "gmc"] as const;

const staffRef = (name: string, t: { tenantId: AnyPgColumn }, column: AnyPgColumn) =>
  foreignKey({
    name,
    columns: [t.tenantId, column],
    foreignColumns: [tenantUser.tenantId, tenantUser.id],
  });

export const staffProfile = pgTable(
  "staff_profile",
  {
    id: id(),
    tenantId: tenantId(),
    /** The member of staff the file is about. */
    tenantUserId: uuid("tenant_user_id").notNull(),
    /** Where they mainly work; null for organisation-wide roles. */
    locationId: uuid("location_id"),
    jobTitle: text("job_title").notNull(),
    /** Care Workforce Pathway role category, as the organisation names it. */
    pathwayCategory: text("pathway_category"),
    /** The register the role needs (`REGISTRATION_BODIES`), adding professional registration. */
    registrationBody: text("registration_body"),
    /** Has worked in health or social care before (adds conduct evidence; Schedule 3 para 4). */
    previousCareWork: boolean("previous_care_work").notNull().default(false),
    /** For the `staff_file.to_75th_birthday` retention row and the under-18 working time rules. */
    dateOfBirth: date("date_of_birth"),
    startsOn: date("starts_on"),
    leftOn: date("left_on"),
    ...mutableColumns(),
  },
  (t) => [
    unique("staff_profile_tenant_id_id_key").on(t.tenantId, t.id),
    unique("staff_profile_member_key").on(t.tenantId, t.tenantUserId),
    staffRef("staff_profile_tenant_user_fk", t, t.tenantUserId),
    foreignKey({
      name: "staff_profile_location_fk",
      columns: [t.tenantId, t.locationId],
      foreignColumns: [location.tenantId, location.id],
    }),
    check(
      "staff_profile_registration_body",
      sql`registration_body IS NULL OR registration_body IN (${sqlList(REGISTRATION_BODIES)})`,
    ),
    check("staff_profile_job_title", sql`length(btrim(job_title)) BETWEEN 2 AND 120`),
    check(
      "staff_profile_left_after_start",
      sql`left_on IS NULL OR starts_on IS NULL OR left_on >= starts_on`,
    ),
  ],
);

export const complianceItem = pgTable(
  "compliance_item",
  {
    id: id(),
    tenantId: tenantId(),
    staffProfileId: uuid("staff_profile_id").notNull(),
    /** One of `COMPLIANCE_ITEM_KINDS`. */
    kind: text("kind").notNull(),
    /** `ComplianceDetail` for the kind, as JSON (checked by the API with the kind's schema). */
    detail: jsonb("detail").notNull(),
    /** The UK date the evidence was seen, and who saw it (never the worker). */
    verifiedOn: date("verified_on"),
    verifiedBy: uuid("verified_by"),
    /** DBS only: the risk assessment, signed by a holder of the sign permission (not the worker). */
    riskAssessmentSignedOn: date("risk_assessment_signed_on"),
    riskAssessmentSignedBy: uuid("risk_assessment_signed_by"),
    /** Worked out from the details by the API when the item is saved, for the reminder sweep. */
    expiresOn: date("expires_on"),
    recheckDueOn: date("recheck_due_on"),
    ...mutableColumns(),
  },
  (t) => [
    unique("compliance_item_tenant_id_id_key").on(t.tenantId, t.id),
    unique("compliance_item_kind_key").on(t.tenantId, t.staffProfileId, t.kind),
    foreignKey({
      name: "compliance_item_profile_fk",
      columns: [t.tenantId, t.staffProfileId],
      foreignColumns: [staffProfile.tenantId, staffProfile.id],
    }),
    staffRef("compliance_item_verified_by_fk", t, t.verifiedBy),
    staffRef("compliance_item_risk_assessment_signed_by_fk", t, t.riskAssessmentSignedBy),
    index("compliance_item_reminder_idx").on(t.tenantId, t.expiresOn, t.recheckDueOn),
    check("compliance_item_kind", sql`kind IN (${sqlList(COMPLIANCE_ITEM_KINDS)})`),
    check(
      "compliance_item_detail",
      sql`jsonb_typeof(detail) = 'object' AND detail->>'kind' = kind`,
    ),
    check("compliance_item_verified", sql`(verified_on IS NULL) = (verified_by IS NULL)`),
    check(
      "compliance_item_risk_assessment",
      sql`(risk_assessment_signed_on IS NULL) = (risk_assessment_signed_by IS NULL)
        AND (risk_assessment_signed_on IS NULL OR kind = 'dbs_certificate')`,
    ),
  ],
);

/**
 * Training, observed competence, supervision and revalidation (workforce.md section 2b; WORK-005,
 * WORK-008, WORK-009, WORK-012; plan slice 17, migration 0079). Keyed by the member of staff
 * (`worker_id`), so training and supervision leads need not read the pre-employment file. Medicines
 * and scheduling never read these tables: they ask the competence port (ADR-0085).
 */

/** `TRAINING_TOPICS` in packages/domain, kept in step by test/training-competence.test.ts. */
export const TRAINING_TOPIC_CODES = [
  "care_certificate",
  "safeguarding_adults",
  "safeguarding_children",
  "moving_and_handling",
  "infection_prevention_and_control",
  "fire_safety",
  "health_and_safety",
  "basic_life_support",
  "food_hygiene",
  "medicines",
  "mental_capacity_and_dols",
  "equality_diversity_and_human_rights",
  "information_governance",
  "dementia_awareness",
  "fluids_and_nutrition",
  "oliver_mcgowan",
] as const;

/** `COMPETENCES` in packages/domain, kept in step by test/training-competence.test.ts. */
export const COMPETENCE_CODES = [
  "medicines_administration",
  "controlled_drugs",
  "insulin_administration",
  "epilepsy_rescue_medication",
  "moving_and_handling_hoist",
  "catheter_care",
  "enteral_feeding",
  "oxygen_therapy",
] as const;

export const SUPERVISION_KINDS = ["supervision", "appraisal", "spot_check"] as const;

const workerRef = staffRef;

export const trainingRequirement = pgTable(
  "training_requirement",
  {
    id: id(),
    tenantId: tenantId(),
    roleKey: text("role_key").notNull(),
    topic: text("topic").notNull(),
    refreshYears: integer("refresh_years"),
    tier: integer("tier"),
    active: boolean("active").notNull().default(true),
    ...mutableColumns(),
  },
  (t) => [
    unique("training_requirement_tenant_id_id_key").on(t.tenantId, t.id),
    unique("training_requirement_role_topic_key").on(t.tenantId, t.roleKey, t.topic),
    check("training_requirement_topic", sql`topic IN (${sqlList(TRAINING_TOPIC_CODES)})`),
    check("training_requirement_role_key", sql`role_key ~ '^[a-z][a-z0-9_]{1,63}$'`),
    check(
      "training_requirement_refresh",
      sql`refresh_years IS NULL OR refresh_years BETWEEN 1 AND 10`,
    ),
    check(
      "training_requirement_tier",
      sql`(tier IS NULL) = (topic <> 'oliver_mcgowan') AND (tier IS NULL OR tier IN (1, 2))`,
    ),
  ],
);

export const trainingRecord = pgTable(
  "training_record",
  {
    id: id(),
    tenantId: tenantId(),
    workerId: uuid("worker_id").notNull(),
    topic: text("topic").notNull(),
    tier: integer("tier"),
    completedOn: date("completed_on").notNull(),
    expiresOn: date("expires_on"),
    provider: text("provider"),
    ...mutableColumns(),
  },
  (t) => [
    unique("training_record_tenant_id_id_key").on(t.tenantId, t.id),
    workerRef("training_record_worker_fk", t, t.workerId),
    index("training_record_worker_idx").on(t.tenantId, t.workerId),
    check("training_record_topic", sql`topic IN (${sqlList(TRAINING_TOPIC_CODES)})`),
    check(
      "training_record_tier",
      sql`(tier IS NULL) = (topic <> 'oliver_mcgowan') AND (tier IS NULL OR tier IN (1, 2))`,
    ),
    check("training_record_expiry", sql`expires_on IS NULL OR expires_on >= completed_on`),
    check(
      "training_record_provider",
      sql`provider IS NULL OR length(btrim(provider)) BETWEEN 2 AND 160`,
    ),
  ],
);

export const competenceSignOff = pgTable(
  "competence_sign_off",
  {
    id: id(),
    tenantId: tenantId(),
    workerId: uuid("worker_id").notNull(),
    competence: text("competence").notNull(),
    observedOn: date("observed_on").notNull(),
    observerId: uuid("observer_id").notNull().default(sql`app.current_user_id()`),
    validUntil: date("valid_until").notNull(),
    ...createdColumns(),
  },
  (t) => [
    unique("competence_sign_off_tenant_id_id_key").on(t.tenantId, t.id),
    workerRef("competence_sign_off_worker_fk", t, t.workerId),
    workerRef("competence_sign_off_observer_fk", t, t.observerId),
    index("competence_sign_off_worker_idx").on(t.tenantId, t.workerId, t.competence),
    check("competence_sign_off_competence", sql`competence IN (${sqlList(COMPETENCE_CODES)})`),
    check("competence_sign_off_valid_until", sql`valid_until > observed_on`),
    check("competence_sign_off_not_self", sql`observer_id <> worker_id`),
  ],
);

export const competenceWithdrawal = pgTable(
  "competence_withdrawal",
  {
    id: id(),
    tenantId: tenantId(),
    signOffId: uuid("sign_off_id").notNull(),
    reason: text("reason").notNull(),
    withdrawnBy: uuid("withdrawn_by").notNull().default(sql`app.current_user_id()`),
    ...createdColumns(),
  },
  (t) => [
    unique("competence_withdrawal_tenant_id_id_key").on(t.tenantId, t.id),
    unique("competence_withdrawal_sign_off_key").on(t.tenantId, t.signOffId),
    foreignKey({
      name: "competence_withdrawal_sign_off_fk",
      columns: [t.tenantId, t.signOffId],
      foreignColumns: [competenceSignOff.tenantId, competenceSignOff.id],
    }),
    staffRef("competence_withdrawal_by_fk", t, t.withdrawnBy),
    check("competence_withdrawal_reason", sql`length(btrim(reason)) BETWEEN 10 AND 500`),
  ],
);

export const supervisionRecord = pgTable(
  "supervision_record",
  {
    id: id(),
    tenantId: tenantId(),
    workerId: uuid("worker_id").notNull(),
    kind: text("kind").notNull(),
    heldOn: date("held_on").notNull(),
    heldBy: uuid("held_by").notNull().default(sql`app.current_user_id()`),
    ...mutableColumns(),
  },
  (t) => [
    unique("supervision_record_tenant_id_id_key").on(t.tenantId, t.id),
    workerRef("supervision_record_worker_fk", t, t.workerId),
    workerRef("supervision_record_held_by_fk", t, t.heldBy),
    index("supervision_record_worker_idx").on(t.tenantId, t.workerId),
    check("supervision_record_kind", sql`kind IN (${sqlList(SUPERVISION_KINDS)})`),
    check("supervision_record_not_self", sql`held_by <> worker_id`),
  ],
);

export const revalidationEvidence = pgTable(
  "revalidation_evidence",
  {
    id: id(),
    tenantId: tenantId(),
    workerId: uuid("worker_id").notNull(),
    cycleDueOn: date("cycle_due_on").notNull(),
    practiceHours: integer("practice_hours").notNull().default(0),
    cpdHours: integer("cpd_hours").notNull().default(0),
    participatoryCpdHours: integer("participatory_cpd_hours").notNull().default(0),
    feedbackPieces: integer("feedback_pieces").notNull().default(0),
    reflectiveAccounts: integer("reflective_accounts").notNull().default(0),
    reflectiveDiscussion: boolean("reflective_discussion").notNull().default(false),
    healthAndCharacter: boolean("health_and_character").notNull().default(false),
    professionalIndemnity: boolean("professional_indemnity").notNull().default(false),
    confirmation: boolean("confirmation").notNull().default(false),
    ...mutableColumns(),
  },
  (t) => [
    unique("revalidation_evidence_tenant_id_id_key").on(t.tenantId, t.id),
    unique("revalidation_evidence_cycle_key").on(t.tenantId, t.workerId, t.cycleDueOn),
    workerRef("revalidation_evidence_worker_fk", t, t.workerId),
    check(
      "revalidation_evidence_counts",
      sql`practice_hours BETWEEN 0 AND 10000 AND cpd_hours BETWEEN 0 AND 1000
        AND participatory_cpd_hours BETWEEN 0 AND cpd_hours
        AND feedback_pieces BETWEEN 0 AND 100 AND reflective_accounts BETWEEN 0 AND 100`,
    ),
  ],
);
