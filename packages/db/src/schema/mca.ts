import { sql } from "drizzle-orm";
import {
  type AnyPgColumn,
  boolean,
  check,
  date,
  foreignKey,
  index,
  jsonb,
  pgTable,
  text,
  timestamp,
  unique,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { createdColumns, id, mutableColumns, tenantId } from "./_columns";
import { contact, person } from "./people";
import { document, location, tenantUser } from "./platform";

/**
 * Consent, mental capacity, best interests and the DoLS register (slice 6; master prompt 10.4;
 * docs/specs/care.md section 2 and rules 9 to 11). The rules live in packages/domain
 * (`care/mca/*`): the API calls them before it writes, and these constraints are the backstop.
 * Capacity assessments and best-interests decisions are append-only: a correction supersedes the
 * original with a reason. Consents and DoLS authorisations are mutable and versioned; a refusal or
 * a withdrawal is recorded, never deleted.
 *
 * Code lists mirror the domain constants (`CONSENT_DECISION_KINDS` and the representative kinds);
 * packages/db/test/mca-and-incidents.test.ts keeps them in step.
 */

const list = (values: readonly string[]) => sql.raw(values.map((v) => `'${v}'`).join(", "));

export const CONSENT_DECISION_SQL = list([
  "care_plan",
  "photos",
  "social_media",
  "sharing",
  "marketing",
  "ai_processing",
  "bed_rails",
  "covert_medicines",
]);

const REPRESENTATIVE_KIND_SQL = list([
  "lpa_health_welfare",
  "lpa_property_financial",
  "deputy",
  "appointee",
  "imca",
  "advocate",
  "family_or_friend",
]);

const personRef = (name: string, t: { tenantId: AnyPgColumn; personId: AnyPgColumn }) =>
  foreignKey({
    name,
    columns: [t.tenantId, t.personId],
    foreignColumns: [person.tenantId, person.id],
  });

/** A capacity assessment: one decision at one time (MCA 2005 s.1 to s.3). Append-only. */
export const capacityAssessment = pgTable(
  "capacity_assessment",
  {
    id: id(),
    tenantId: tenantId(),
    personId: uuid("person_id").notNull(),
    /** The decision in words, for example "whether to have bed rails on their bed at night". */
    decision: text("decision").notNull(),
    /** Set when the decision is one of the consent decisions, so consent rules can find it. */
    decisionKind: text("decision_kind"),
    assessedAt: timestamp("assessed_at", { withTimezone: true }).notNull(),
    /** A member of staff, or a named professional (assessor_name and role) from outside. */
    assessorTenantUserId: uuid("assessor_tenant_user_id"),
    assessorName: text("assessor_name"),
    assessorRole: text("assessor_role"),
    /** [{ step, detail }] from PRACTICABLE_STEPS (s.1(3)). */
    practicableSteps: jsonb("practicable_steps").notNull().default(sql`'[]'::jsonb`),
    stage1Impairment: boolean("stage1_impairment").notNull(),
    stage1Description: text("stage1_description"),
    /** { understand, retain, useOrWeigh, communicate: { able, evidence } } (s.3(1)). */
    stage2: jsonb("stage2").notNull().default(sql`'{}'::jsonb`),
    inabilityBecauseOfImpairment: boolean("inability_because_of_impairment"),
    outcome: text("outcome").notNull(),
    unableTo: text("unable_to").array().notNull().default(sql`'{}'::text[]`),
    /** The domain's reason, in the Act's words. */
    reason: text("reason").notNull(),
    reviewOn: date("review_on"),
    recordedAt: timestamp("recorded_at", { withTimezone: true }).notNull().defaultNow(),
    supersedesId: uuid("supersedes_id"),
    correctionReason: text("correction_reason"),
    ...createdColumns(),
  },
  (t) => [
    unique("capacity_assessment_tenant_id_id_key").on(t.tenantId, t.id),
    unique("capacity_assessment_tenant_person_id_key").on(t.tenantId, t.personId, t.id),
    personRef("capacity_assessment_person_fk", t),
    foreignKey({
      name: "capacity_assessment_assessor_fk",
      columns: [t.tenantId, t.assessorTenantUserId],
      foreignColumns: [tenantUser.tenantId, tenantUser.id],
    }),
    foreignKey({
      name: "capacity_assessment_supersedes_fk",
      columns: [t.tenantId, t.personId, t.supersedesId],
      foreignColumns: [t.tenantId, t.personId, t.id],
    }),
    check("capacity_assessment_outcome", sql`outcome IN ('has_capacity', 'lacks_capacity')`),
    check(
      "capacity_assessment_decision_kind",
      sql`decision_kind IS NULL OR decision_kind IN (${CONSENT_DECISION_SQL})`,
    ),
    check(
      "capacity_assessment_assessor",
      sql`assessor_tenant_user_id IS NOT NULL OR assessor_name IS NOT NULL`,
    ),
    check(
      "capacity_assessment_lacks",
      sql`outcome = 'has_capacity' OR (stage1_impairment AND cardinality(unable_to) > 0
        AND inability_because_of_impairment IS TRUE)`,
    ),
    check(
      "capacity_assessment_correction_reason",
      sql`supersedes_id IS NULL OR correction_reason IS NOT NULL`,
    ),
    index("capacity_assessment_person_idx").on(t.tenantId, t.personId, t.assessedAt),
  ],
);

/** A best-interests decision after an assessment that found a lack of capacity (s.4). Append-only. */
export const bestInterestsDecision = pgTable(
  "best_interests_decision",
  {
    id: id(),
    tenantId: tenantId(),
    personId: uuid("person_id").notNull(),
    capacityAssessmentId: uuid("capacity_assessment_id").notNull(),
    decision: text("decision").notNull(),
    decidedAt: timestamp("decided_at", { withTimezone: true }).notNull(),
    /** Keyed by BEST_INTERESTS_ITEM_KEYS: { answer: considered | not_applicable, note | reason }. */
    checklist: jsonb("checklist").notNull(),
    /** [{ consultee, name, contactId, views, consultedAt }] (s.4(7)). */
    consultations: jsonb("consultations").notNull().default(sql`'[]'::jsonb`),
    noConsultationReason: text("no_consultation_reason"),
    seriousMedicalTreatment: boolean("serious_medical_treatment").notNull().default(false),
    accommodationChange: boolean("accommodation_change").notNull().default(false),
    /** The IMCA prompt shown when nobody appropriate could be consulted (s.37 to s.39). */
    imcaPrompt: text("imca_prompt"),
    reviewOn: date("review_on").notNull(),
    recordedAt: timestamp("recorded_at", { withTimezone: true }).notNull().defaultNow(),
    supersedesId: uuid("supersedes_id"),
    correctionReason: text("correction_reason"),
    ...createdColumns(),
  },
  (t) => [
    unique("best_interests_decision_tenant_id_id_key").on(t.tenantId, t.id),
    unique("best_interests_decision_tenant_person_id_key").on(t.tenantId, t.personId, t.id),
    personRef("best_interests_decision_person_fk", t),
    foreignKey({
      name: "best_interests_decision_assessment_fk",
      columns: [t.tenantId, t.personId, t.capacityAssessmentId],
      foreignColumns: [
        capacityAssessment.tenantId,
        capacityAssessment.personId,
        capacityAssessment.id,
      ],
    }),
    foreignKey({
      name: "best_interests_decision_supersedes_fk",
      columns: [t.tenantId, t.personId, t.supersedesId],
      foreignColumns: [t.tenantId, t.personId, t.id],
    }),
    check(
      "best_interests_decision_consultation",
      sql`jsonb_typeof(consultations) = 'array'
        AND (jsonb_array_length(consultations) > 0 OR no_consultation_reason IS NOT NULL)`,
    ),
    check(
      "best_interests_decision_correction_reason",
      sql`supersedes_id IS NULL OR correction_reason IS NOT NULL`,
    ),
    index("best_interests_decision_person_idx").on(t.tenantId, t.personId, t.decidedAt),
  ],
);

/**
 * Consent for one decision (care.md rule 9). The capacity status is the one the API found from
 * the assessments when the consent was recorded; a representative is stored with the authority
 * that `checkConsentRecord` checked. A withdrawal sets `withdrawn_at` and the reason.
 */
export const consentRecord = pgTable(
  "consent_record",
  {
    id: id(),
    tenantId: tenantId(),
    personId: uuid("person_id").notNull(),
    decision: text("decision").notNull(),
    /** `given` or `refused`. */
    outcome: text("outcome").notNull(),
    /** `person` or `representative`. */
    givenByKind: text("given_by_kind").notNull(),
    representativeKind: text("representative_kind"),
    representativeContactId: uuid("representative_contact_id"),
    representativeName: text("representative_name"),
    /** Lasting power of attorney: registered with the Office of the Public Guardian (s.9(2)(b)). */
    lpaRegistered: boolean("lpa_registered"),
    opgReference: text("opg_reference"),
    /** Decisions the instrument excludes or restricts (s.9(4)(b)). */
    excludedDecisions: text("excluded_decisions").array().notNull().default(sql`'{}'::text[]`),
    /** Deputy: `personal_welfare` or `property_and_affairs`, the decisions and the end of the order. */
    deputyScope: text("deputy_scope"),
    deputyDecisions: text("deputy_decisions").array().notNull().default(sql`'{}'::text[]`),
    deputyRestraintAuthorised: boolean("deputy_restraint_authorised"),
    deputyOrderEndsAt: timestamp("deputy_order_ends_at", { withTimezone: true }),
    courtReference: text("court_reference"),
    /** `assumed`, `has_capacity` or `lacks_capacity`, with the assessment that found it. */
    capacityStatus: text("capacity_status").notNull(),
    capacityAssessmentId: uuid("capacity_assessment_id"),
    givenAt: timestamp("given_at", { withTimezone: true }).notNull(),
    expiresAt: timestamp("expires_at", { withTimezone: true }),
    withdrawnAt: timestamp("withdrawn_at", { withTimezone: true }),
    withdrawnReason: text("withdrawn_reason"),
    /** How the decision was made, in words. */
    evidence: text("evidence").notNull(),
    evidenceDocumentId: uuid("evidence_document_id"),
    /** Bed rails by a representative: the s.11(3) and (4) or s.20(10) and (11) conditions. */
    restraintNecessary: boolean("restraint_necessary"),
    restraintProportionate: boolean("restraint_proportionate"),
    /** Covert medicines: the best-interests decision (NICE SC1 1.15.3). */
    bestInterestsDecisionId: uuid("best_interests_decision_id"),
    ...mutableColumns(),
  },
  (t) => [
    unique("consent_record_tenant_id_id_key").on(t.tenantId, t.id),
    personRef("consent_record_person_fk", t),
    foreignKey({
      name: "consent_record_contact_fk",
      columns: [t.tenantId, t.personId, t.representativeContactId],
      foreignColumns: [contact.tenantId, contact.personId, contact.id],
    }),
    foreignKey({
      name: "consent_record_assessment_fk",
      columns: [t.tenantId, t.personId, t.capacityAssessmentId],
      foreignColumns: [
        capacityAssessment.tenantId,
        capacityAssessment.personId,
        capacityAssessment.id,
      ],
    }),
    foreignKey({
      name: "consent_record_best_interests_fk",
      columns: [t.tenantId, t.personId, t.bestInterestsDecisionId],
      foreignColumns: [
        bestInterestsDecision.tenantId,
        bestInterestsDecision.personId,
        bestInterestsDecision.id,
      ],
    }),
    foreignKey({
      name: "consent_record_evidence_document_fk",
      columns: [t.tenantId, t.evidenceDocumentId],
      foreignColumns: [document.tenantId, document.id],
    }),
    check("consent_record_decision", sql`decision IN (${CONSENT_DECISION_SQL})`),
    check("consent_record_outcome", sql`outcome IN ('given', 'refused')`),
    check(
      "consent_record_given_by",
      sql`given_by_kind IN ('person', 'representative')
        AND (given_by_kind = 'representative') = (representative_kind IS NOT NULL)`,
    ),
    check(
      "consent_record_representative",
      sql`representative_kind IS NULL OR (representative_kind IN (${REPRESENTATIVE_KIND_SQL})
        AND (representative_contact_id IS NOT NULL OR representative_name IS NOT NULL))`,
    ),
    check(
      "consent_record_deputy_scope",
      sql`deputy_scope IS NULL OR deputy_scope IN ('personal_welfare', 'property_and_affairs')`,
    ),
    check(
      "consent_record_capacity",
      sql`capacity_status IN ('assumed', 'has_capacity', 'lacks_capacity')
        AND (capacity_status = 'assumed') = (capacity_assessment_id IS NULL)`,
    ),
    check("consent_record_evidence", sql`length(trim(evidence)) > 0`),
    check("consent_record_expiry", sql`expires_at IS NULL OR expires_at > given_at`),
    check(
      "consent_record_withdrawn",
      sql`withdrawn_at IS NULL OR (withdrawn_reason IS NOT NULL AND withdrawn_at >= given_at)`,
    ),
    index("consent_record_person_idx").on(t.tenantId, t.personId, t.decision, t.givenAt),
  ],
);

/**
 * The DoLS register (care.md rule 11; HZ-020): urgent and standard authorisations and court orders,
 * with the Schedule A1 dates the domain checks. England and Wales only.
 */
export const dolsAuthorisation = pgTable(
  "dols_authorisation",
  {
    id: id(),
    tenantId: tenantId(),
    personId: uuid("person_id").notNull(),
    /** The managing authority: the person's location when the request was made. */
    locationId: uuid("location_id").notNull(),
    /** `urgent`, `standard` or `court_order`. */
    type: text("type").notNull(),
    /** `england` or `wales` (Schedule A1). */
    nation: text("nation").notNull(),
    requestedAt: timestamp("requested_at", { withTimezone: true }).notNull(),
    /** `pending`, `granted`, `not_granted` or `withdrawn`. */
    outcome: text("outcome").notNull().default("pending"),
    outcomeAt: timestamp("outcome_at", { withTimezone: true }),
    grantedFrom: timestamp("granted_from", { withTimezone: true }),
    /** The first moment the authorisation is no longer in force; a court order may have none. */
    grantedTo: timestamp("granted_to", { withTimezone: true }),
    /** Urgent extensions: [{ requestedAt, outcome, extendedTo }] (para 77, para 85). */
    extensions: jsonb("extensions").notNull().default(sql`'[]'::jsonb`),
    precededByUrgent: boolean("preceded_by_urgent").notNull().default(false),
    precededByAuthorisationId: uuid("preceded_by_authorisation_id"),
    withdrawalReason: text("withdrawal_reason"),
    /** Ended early: terminated after a review (para 117), or the person left or died. */
    endedAt: timestamp("ended_at", { withTimezone: true }),
    endedReason: text("ended_reason"),
    conditions: text("conditions"),
    /** The relevant person's representative (RPR). */
    rprName: text("rpr_name"),
    rprContactId: uuid("rpr_contact_id"),
    supervisoryBody: text("supervisory_body"),
    supervisoryBodyReference: text("supervisory_body_reference"),
    /** How the person shows objection, where they do. */
    objectionEvidence: text("objection_evidence"),
    ...mutableColumns(),
  },
  (t) => [
    unique("dols_authorisation_tenant_id_id_key").on(t.tenantId, t.id),
    unique("dols_authorisation_tenant_person_id_key").on(t.tenantId, t.personId, t.id),
    personRef("dols_authorisation_person_fk", t),
    foreignKey({
      name: "dols_authorisation_location_fk",
      columns: [t.tenantId, t.locationId],
      foreignColumns: [location.tenantId, location.id],
    }),
    foreignKey({
      name: "dols_authorisation_rpr_fk",
      columns: [t.tenantId, t.personId, t.rprContactId],
      foreignColumns: [contact.tenantId, contact.personId, contact.id],
    }),
    foreignKey({
      name: "dols_authorisation_preceded_by_fk",
      columns: [t.tenantId, t.personId, t.precededByAuthorisationId],
      foreignColumns: [t.tenantId, t.personId, t.id],
    }),
    check("dols_authorisation_type", sql`type IN ('urgent', 'standard', 'court_order')`),
    check("dols_authorisation_nation", sql`nation IN ('england', 'wales')`),
    check(
      "dols_authorisation_outcome",
      sql`outcome IN ('pending', 'granted', 'not_granted', 'withdrawn')
        AND (outcome = 'pending' OR outcome_at IS NOT NULL)`,
    ),
    check(
      "dols_authorisation_withdrawn",
      sql`outcome <> 'withdrawn' OR withdrawal_reason IS NOT NULL`,
    ),
    check(
      "dols_authorisation_period",
      sql`granted_to IS NULL OR granted_from IS NULL OR granted_to > granted_from`,
    ),
    check("dols_authorisation_ended", sql`ended_at IS NULL OR ended_reason IS NOT NULL`),
    check("dols_authorisation_extensions", sql`jsonb_typeof(extensions) = 'array'`),
    index("dols_authorisation_person_idx").on(t.tenantId, t.personId),
    index("dols_authorisation_end_idx").on(t.tenantId, t.outcome, t.grantedTo),
  ],
);

/**
 * The review of an existing authorisation after the June 2026 judgment (care.md rule 11,
 * `DOLS_LEGAL_CHANGE_REVIEW_WORKFLOW`). The workflow engine records each step with who took it
 * and why; `state` mirrors the workflow so the register can filter on it.
 */
export const dolsLegalChangeReview = pgTable(
  "dols_legal_change_review",
  {
    id: id(),
    tenantId: tenantId(),
    personId: uuid("person_id").notNull(),
    dolsAuthorisationId: uuid("dols_authorisation_id").notNull(),
    /** `awaiting_review`, `reviewed`, `referred` or `closed`. */
    state: text("state").notNull().default("awaiting_review"),
    /** The DHSC multifactorial assessment, keyed by MULTIFACTORIAL_FACTORS. */
    factors: jsonb("factors").notNull().default(sql`'{}'::jsonb`),
    /** `objects`, `does_not_object`, `fluctuates` or `unclear`. */
    objection: text("objection"),
    objectionForms: text("objection_forms").array().notNull().default(sql`'{}'::text[]`),
    /** { consciousOfEnvironment, basicUnderstanding, expressesAcceptance, seriousDoubt }. */
    consentSigns: jsonb("consent_signs").notNull().default(sql`'{}'::jsonb`),
    /** `still_deprived`, `no_longer_deprived` or `in_doubt`. */
    decision: text("decision"),
    decidedAt: timestamp("decided_at", { withTimezone: true }),
    decidedBy: uuid("decided_by"),
    referralSentAt: timestamp("referral_sent_at", { withTimezone: true }),
    referralReference: text("referral_reference"),
    /** From `checkLegalChangeReview`: the local authority must be asked before closing. */
    referralRequired: boolean("referral_required").notNull().default(false),
    prompts: text("prompts").array().notNull().default(sql`'{}'::text[]`),
    closedReason: text("closed_reason"),
    ...mutableColumns(),
  },
  (t) => [
    unique("dols_legal_change_review_tenant_id_id_key").on(t.tenantId, t.id),
    uniqueIndex("dols_legal_change_review_one_per_authorisation").on(
      t.tenantId,
      t.dolsAuthorisationId,
    ),
    personRef("dols_legal_change_review_person_fk", t),
    foreignKey({
      name: "dols_legal_change_review_authorisation_fk",
      columns: [t.tenantId, t.personId, t.dolsAuthorisationId],
      foreignColumns: [
        dolsAuthorisation.tenantId,
        dolsAuthorisation.personId,
        dolsAuthorisation.id,
      ],
    }),
    foreignKey({
      name: "dols_legal_change_review_decided_by_fk",
      columns: [t.tenantId, t.decidedBy],
      foreignColumns: [tenantUser.tenantId, tenantUser.id],
    }),
    check(
      "dols_legal_change_review_state",
      sql`state IN ('awaiting_review', 'reviewed', 'referred', 'closed')`,
    ),
    check(
      "dols_legal_change_review_decision",
      sql`decision IS NULL OR decision IN ('still_deprived', 'no_longer_deprived', 'in_doubt')`,
    ),
    check(
      "dols_legal_change_review_objection",
      sql`objection IS NULL OR objection IN ('objects', 'does_not_object', 'fluctuates', 'unclear')`,
    ),
    check(
      "dols_legal_change_review_reviewed",
      sql`state NOT IN ('reviewed', 'referred') OR (decision IS NOT NULL AND decided_at IS NOT NULL)`,
    ),
    check(
      "dols_legal_change_review_referred",
      sql`state <> 'referred' OR referral_sent_at IS NOT NULL`,
    ),
    check("dols_legal_change_review_closed", sql`state <> 'closed' OR closed_reason IS NOT NULL`),
  ],
);

export const MCA_MUTABLE_TABLES = [
  "consent_record",
  "dols_authorisation",
  "dols_legal_change_review",
] as const;
export const MCA_APPEND_ONLY_TABLES = ["capacity_assessment", "best_interests_decision"] as const;

export type ConsentRecordRow = typeof consentRecord.$inferSelect;
export type CapacityAssessmentRow = typeof capacityAssessment.$inferSelect;
export type BestInterestsDecisionRow = typeof bestInterestsDecision.$inferSelect;
export type DolsAuthorisationRow = typeof dolsAuthorisation.$inferSelect;
export type DolsLegalChangeReviewRow = typeof dolsLegalChangeReview.$inferSelect;
