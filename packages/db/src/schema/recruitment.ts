import { sql } from "drizzle-orm";
import {
  type AnyPgColumn,
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
  uuid,
} from "drizzle-orm/pg-core";
import { sqlList } from "./_codes";
import { createdColumns, id, mutableColumns, tenantId } from "./_columns";
import { location } from "./platform";
import { REGISTRATION_BODIES, staffProfile } from "./workforce";

/**
 * Applicant tracking (workforce.md section 2c; WORK-001; plan slice 23, migration 0085): job
 * templates by Care Workforce Pathway role, vacancies, applicants and their applications, the
 * stage history, values-based interviews, conditional offers and equality monitoring. Read and
 * written only by holders of `workforce.recruitment.manage` (organisation-wide, as the staff file
 * permissions); equality monitoring is insert only and read by nobody row by row, only counted
 * (`app.equality_monitoring_counts`). The codes mirror packages/domain (`workforce/recruitment.ts`),
 * kept in step by test/applicant-tracking.test.ts.
 */

export const PATHWAY_CATEGORIES = [
  "new_to_care",
  "care_worker",
  "senior_care_worker",
  "lead_practitioner",
  "deputy_manager",
  "registered_manager",
  "registered_nurse",
] as const;
export const VACANCY_STATUSES = ["draft", "open", "closed", "filled", "withdrawn"] as const;
export const APPLICATION_STAGES = [
  "applied",
  "shortlisted",
  "interviewed",
  "offered",
  "accepted",
  "rejected",
  "withdrawn",
  "declined",
] as const;
export const CLOSING_REASONS = [
  "criteria_not_met",
  "not_selected_after_interview",
  "position_filled",
  "vacancy_withdrawn",
  "applicant_withdrew",
  "offer_declined",
  "offer_withdrawn",
  "pre_employment_checks_failed",
] as const;
export const OFFER_STATUSES = ["made", "accepted", "declined", "withdrawn"] as const;

const ref = (
  name: string,
  t: { tenantId: AnyPgColumn },
  column: AnyPgColumn,
  target: { tenantId: AnyPgColumn; id: AnyPgColumn },
) =>
  foreignKey({ name, columns: [t.tenantId, column], foreignColumns: [target.tenantId, target.id] });

export const jobTemplate = pgTable(
  "job_template",
  {
    id: id(),
    tenantId: tenantId(),
    title: text("title").notNull(),
    pathwayCategory: text("pathway_category").notNull(),
    registrationBody: text("registration_body"),
    /** Short statements, each assessed at shortlisting (JSON array of strings). */
    essentialCriteria: jsonb("essential_criteria").notNull(),
    /** `[{ key, value, question }]`: the values each interview question explores. */
    valuesQuestions: jsonb("values_questions").notNull(),
    archivedAt: timestamp("archived_at", { withTimezone: true }),
    ...mutableColumns(),
  },
  (t) => [
    unique("job_template_tenant_id_id_key").on(t.tenantId, t.id),
    check("job_template_title", sql`length(btrim(title)) BETWEEN 2 AND 120`),
    check("job_template_pathway", sql`pathway_category IN (${sqlList(PATHWAY_CATEGORIES)})`),
    check(
      "job_template_registration_body",
      sql`registration_body IS NULL OR registration_body IN (${sqlList(REGISTRATION_BODIES)})`,
    ),
    check(
      "job_template_criteria",
      sql`jsonb_typeof(essential_criteria) = 'array' AND jsonb_array_length(essential_criteria) BETWEEN 2 AND 20`,
    ),
    check(
      "job_template_questions",
      sql`jsonb_typeof(values_questions) = 'array' AND jsonb_array_length(values_questions) BETWEEN 2 AND 12`,
    ),
  ],
);

export const vacancy = pgTable(
  "vacancy",
  {
    id: id(),
    tenantId: tenantId(),
    jobTemplateId: uuid("job_template_id").notNull(),
    /** Where the job is; null for an organisation-wide role. */
    locationId: uuid("location_id"),
    title: text("title").notNull(),
    positions: integer("positions").notNull().default(1),
    opensOn: date("opens_on").notNull(),
    closesOn: date("closes_on"),
    status: text("status").notNull().default("draft"),
    /**
     * When the equality monitoring counts were first released (rule 12): no form is added after
     * it, so counts read before and after a form can never be compared.
     */
    equalitySummarisedAt: timestamp("equality_summarised_at", { withTimezone: true }),
    ...mutableColumns(),
  },
  (t) => [
    unique("vacancy_tenant_id_id_key").on(t.tenantId, t.id),
    ref("vacancy_template_fk", t, t.jobTemplateId, jobTemplate),
    ref("vacancy_location_fk", t, t.locationId, location),
    check("vacancy_title", sql`length(btrim(title)) BETWEEN 2 AND 120`),
    check("vacancy_positions", sql`positions BETWEEN 1 AND 50`),
    check("vacancy_dates", sql`closes_on IS NULL OR closes_on >= opens_on`),
    check("vacancy_status", sql`status IN (${sqlList(VACANCY_STATUSES)})`),
  ],
);

export const applicant = pgTable(
  "applicant",
  {
    id: id(),
    tenantId: tenantId(),
    /** Cleared (with the contact details) when `redacted_at` is set by the retention engine. */
    givenName: text("given_name"),
    familyName: text("family_name"),
    email: text("email"),
    phone: text("phone"),
    /** The talent pool: only with the applicant's consent, until this UK date. */
    talentPoolUntil: date("talent_pool_until"),
    talentPoolConsentedAt: timestamp("talent_pool_consented_at", { withTimezone: true }),
    /** Set when the last application closes unsuccessfully (`applicantRetainUntil`). */
    retainUntil: date("retain_until"),
    redactedAt: timestamp("redacted_at", { withTimezone: true }),
    ...mutableColumns(),
  },
  (t) => [
    unique("applicant_tenant_id_id_key").on(t.tenantId, t.id),
    index("applicant_email_idx").on(t.tenantId, t.email),
    check(
      "applicant_talent_pool",
      sql`(talent_pool_until IS NULL) = (talent_pool_consented_at IS NULL)`,
    ),
    check(
      "applicant_named",
      sql`redacted_at IS NOT NULL OR (length(btrim(given_name)) BETWEEN 1 AND 100
        AND length(btrim(family_name)) BETWEEN 1 AND 100)`,
    ),
    check(
      "applicant_redacted",
      sql`redacted_at IS NULL OR (given_name IS NULL AND family_name IS NULL AND email IS NULL
        AND phone IS NULL AND talent_pool_until IS NULL)`,
    ),
  ],
);

export const application = pgTable(
  "application",
  {
    id: id(),
    tenantId: tenantId(),
    vacancyId: uuid("vacancy_id").notNull(),
    applicantId: uuid("applicant_id").notNull(),
    stage: text("stage").notNull().default("applied"),
    /** Why it closed (`CLOSING_REASONS`), for a closed stage. */
    stageReason: text("stage_reason"),
    /** `{ criteria: boolean[], decidedBy, decidedAt }`: each essential criterion met or not. */
    shortlist: jsonb("shortlist"),
    closedOn: date("closed_on"),
    ...mutableColumns(),
  },
  (t) => [
    unique("application_tenant_id_id_key").on(t.tenantId, t.id),
    unique("application_once_key").on(t.tenantId, t.vacancyId, t.applicantId),
    ref("application_vacancy_fk", t, t.vacancyId, vacancy),
    ref("application_applicant_fk", t, t.applicantId, applicant),
    check("application_stage", sql`stage IN (${sqlList(APPLICATION_STAGES)})`),
    check(
      "application_reason",
      sql`stage_reason IS NULL OR stage_reason IN (${sqlList(CLOSING_REASONS)})`,
    ),
    check(
      "application_closed",
      sql`(closed_on IS NULL) = (stage NOT IN ('accepted', 'rejected', 'withdrawn', 'declined'))`,
    ),
  ],
);

export const applicationEvent = pgTable(
  "application_event",
  {
    id: id(),
    tenantId: tenantId(),
    applicationId: uuid("application_id").notNull(),
    fromStage: text("from_stage"),
    toStage: text("to_stage").notNull(),
    reason: text("reason"),
    occurredAt: timestamp("occurred_at", { withTimezone: true }).notNull().defaultNow(),
    ...createdColumns(),
  },
  (t) => [
    ref("application_event_application_fk", t, t.applicationId, application),
    index("application_event_application_idx").on(t.tenantId, t.applicationId, t.occurredAt),
    check("application_event_stage", sql`to_stage IN (${sqlList(APPLICATION_STAGES)})`),
  ],
);

export const interview = pgTable(
  "interview",
  {
    id: id(),
    tenantId: tenantId(),
    applicationId: uuid("application_id").notNull(),
    heldOn: date("held_on").notNull(),
    /** The panel: 1 to 5 members of staff. */
    panel: uuid("panel").array().notNull(),
    /** `{ questionKey: 1 to 4 }`, for the template's values questions. */
    scores: jsonb("scores").notNull(),
    notes: text("notes"),
    recommendation: text("recommendation").notNull(),
    ...createdColumns(),
  },
  (t) => [
    ref("interview_application_fk", t, t.applicationId, application),
    check("interview_panel", sql`cardinality(panel) BETWEEN 1 AND 5`),
    check("interview_scores", sql`jsonb_typeof(scores) = 'object'`),
    check("interview_recommendation", sql`recommendation IN ('proceed', 'do_not_proceed')`),
    check("interview_notes", sql`notes IS NULL OR length(notes) <= 4000`),
  ],
);

export const jobOffer = pgTable(
  "job_offer",
  {
    id: id(),
    tenantId: tenantId(),
    applicationId: uuid("application_id").notNull(),
    madeOn: date("made_on").notNull(),
    proposedStartOn: date("proposed_start_on"),
    /** The Schedule 3 items the role needs (`requiredItems`), as a JSON array of kinds. */
    conditions: jsonb("conditions").notNull(),
    status: text("status").notNull().default("made"),
    respondedOn: date("responded_on"),
    /** The staff profile an accepted offer created. */
    staffProfileId: uuid("staff_profile_id"),
    ...mutableColumns(),
  },
  (t) => [
    unique("job_offer_tenant_id_id_key").on(t.tenantId, t.id),
    unique("job_offer_once_key").on(t.tenantId, t.applicationId),
    ref("job_offer_application_fk", t, t.applicationId, application),
    ref("job_offer_staff_profile_fk", t, t.staffProfileId, staffProfile),
    check("job_offer_status", sql`status IN (${sqlList(OFFER_STATUSES)})`),
    check("job_offer_conditions", sql`jsonb_typeof(conditions) = 'array'`),
    check(
      "job_offer_responded",
      sql`(responded_on IS NULL) = (status = 'made')
        AND ((staff_profile_id IS NOT NULL) = (status = 'accepted'))`,
    ),
  ],
);

export const equalityMonitoring = pgTable(
  "equality_monitoring",
  {
    /** Random, never a UUIDv7: a time-ordered id would date the form to the moment it came in. */
    id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
    tenantId: tenantId(),
    vacancyId: uuid("vacancy_id").notNull(),
    /** `{ question: answer }`, every answer optional; never linked to an applicant. */
    answers: jsonb("answers").notNull(),
    // No date or time: forms are added after the vacancy closes, and a date would only help match
    // a form to an application (rule 12).
  },
  (t) => [
    ref("equality_monitoring_vacancy_fk", t, t.vacancyId, vacancy),
    index("equality_monitoring_vacancy_idx").on(t.tenantId, t.vacancyId),
    check("equality_monitoring_answers", sql`jsonb_typeof(answers) = 'object'`),
  ],
);
