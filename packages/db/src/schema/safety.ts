import { sql } from "drizzle-orm";
import {
  boolean,
  check,
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
import { dolsAuthorisation } from "./mca";
import { person } from "./people";
import { document, location, tenantUser } from "./platform";

/**
 * Incidents, statutory notifications, duty of candour and investigations (slice 7; master prompt
 * 11.1; docs/specs/safety.md section 2). The classifier in packages/domain decides which
 * notifications an incident needs; the API stores its inputs (the incident, its people and the
 * answers) and its outputs (the drafts with their clocks, the classifier version and reasoning).
 *
 * Scope (ADR-0033): an incident is visible to anyone who can see one of its people, to its
 * reporter, and, when it involves nobody using the service, to the people working at its
 * location. `person_ids` holds the people using the service on the incident so the policy never
 * has to read `incident_person` (which would make the two policies recurse). Each person's row,
 * and each notification about one person, follows that person's own scope.
 *
 * Code lists mirror the domain constants; packages/db/test/mca-and-incidents.test.ts keeps them
 * in step.
 */

const list = (values: readonly string[]) => sql.raw(values.map((v) => `'${v}'`).join(", "));

export const INCIDENT_TYPE_SQL = list([
  "fall",
  "medication",
  "skin",
  "behaviour",
  "missing_person",
  "safeguarding_concern",
  "injury",
  "near_miss",
  "environmental",
  "ipc",
  "staff_injury",
  "violence_to_staff",
  "self_harm",
  "sexual_safety",
  "absconding",
  "fire_setting",
  "substance_use",
  "data_breach",
]);

export const CLASSIFIER_QUESTION_SQL = list([
  "harm.impairment_days",
  "harm.body_structure_changed",
  "harm.pain_days",
  "harm.psychological_harm_days",
  "harm.life_expectancy_shortened",
  "harm.treatment_to_prevent",
  "candour.unintended_or_unexpected",
  "candour.death_related_to_incident",
  "safeguarding.concern",
  "safeguarding.types",
  "pressure_ulcer.neglect_concern",
  "pressure_ulcer.severe_impact",
  "police.involved",
  "service.threatens_safe_running",
  "service.insufficient_staff",
  "service.utility_interruption_hours",
  "service.premises_damage",
  "service.safety_device_failure_hours",
  "riddor.work_connected",
  "riddor.excluded_cause",
  "riddor.worker_specified_injury",
  "riddor.worker_incapacity_days",
  "riddor.non_worker_to_hospital",
  "riddor.dangerous_occurrence",
  "falls.head_injury",
  "falls.anticoagulant",
]);

export const STATUTORY_NOTIFICATION_KIND_SQL = list([
  "cqc_reg16_death",
  "cqc_reg18_serious_injury",
  "cqc_reg18_abuse",
  "cqc_reg18_police",
  "cqc_reg18_service_disruption",
  "cqc_reg18_dols_outcome",
  "riddor_death",
  "riddor_specified_injury",
  "riddor_non_worker_hospital",
  "riddor_over_7_day",
  "riddor_dangerous_occurrence",
  "safeguarding_s42",
  "candour",
  "leder",
  "ukhsa_outbreak",
  "medical_examiner",
  "police_missing_person",
]);

const CANDOUR_STATE_SQL = list([
  "threshold_assessment",
  "not_notifiable",
  "verbal_due",
  "no_contact",
  "written_due",
  "enquiries_open",
  "closed",
]);

/** An incident or near miss (SAFE-001). Mutable and versioned; clocks start at `occurred_at`. */
export const incident = pgTable(
  "incident",
  {
    id: id(),
    tenantId: tenantId(),
    locationId: uuid("location_id").notNull(),
    /** One of INCIDENT_TYPES (master prompt 11.1). */
    type: text("type").notNull(),
    /** When it happened: every statutory clock starts here, never at sync time (safety.md 6). */
    occurredAt: timestamp("occurred_at", { withTimezone: true }).notNull(),
    /** The device clock when the incident was written (offline capture). */
    deviceTime: timestamp("device_time", { withTimezone: true }),
    recordedAt: timestamp("recorded_at", { withTimezone: true }).notNull().defaultNow(),
    deviceId: text("device_id"),
    lateEntry: boolean("late_entry").notNull().default(false),
    clockDrift: boolean("clock_drift").notNull().default(false),
    /** When the person was found, if later than the event (post-fall observations count from here). */
    foundAt: timestamp("found_at", { withTimezone: true }),
    /** NPSA consequence scale: negligible, minor, moderate, major, catastrophic. */
    severity: text("severity"),
    /** LFPSE physical harm: none, low, moderate, severe, fatal. Recorded by staff, never computed. */
    harmGrade: text("harm_grade"),
    description: text("description").notNull(),
    immediateActions: text("immediate_actions"),
    /**
     * Null when the reporter answered "Not known yet" (H-264, HZ-090): the question stays open
     * with a task for the person in charge. Expand-only from migration 0118.
     */
    emergencyServicesCalled: boolean("emergency_services_called").default(false),
    gpContacted: boolean("gp_contacted").default(false),
    contactNotes: text("contact_notes"),
    familyInformedWho: text("family_informed_who"),
    familyInformedAt: timestamp("family_informed_at", { withTimezone: true }),
    /** `open`, `under_review` or `closed`, mirroring the `safety.incident` workflow. */
    status: text("status").notNull().default("open"),
    raisedBy: uuid("raised_by").notNull().default(sql`app.current_user_id()`),
    closedBy: uuid("closed_by"),
    closedAt: timestamp("closed_at", { withTimezone: true }),
    closedReason: text("closed_reason"),
    /** The people using the service on the incident (kept in step with incident_person). */
    personIds: uuid("person_ids").array().notNull().default(sql`'{}'::uuid[]`),
    /** The last classification: CLASSIFIER_VERSION, when, and the result with its reasoning. */
    classifierVersion: text("classifier_version"),
    classifiedAt: timestamp("classified_at", { withTimezone: true }),
    nationSupported: boolean("nation_supported"),
    classifierResult: jsonb("classifier_result"),
    openQuestions: text("open_questions").array().notNull().default(sql`'{}'::text[]`),
    /** `serious_incident` once any notification applies, otherwise `care_record`. */
    retentionClass: text("retention_class").notNull().default("care_record"),
    ...mutableColumns(),
  },
  (t) => [
    unique("incident_tenant_id_id_key").on(t.tenantId, t.id),
    foreignKey({
      name: "incident_location_fk",
      columns: [t.tenantId, t.locationId],
      foreignColumns: [location.tenantId, location.id],
    }),
    foreignKey({
      name: "incident_raised_by_fk",
      columns: [t.tenantId, t.raisedBy],
      foreignColumns: [tenantUser.tenantId, tenantUser.id],
    }),
    foreignKey({
      name: "incident_closed_by_fk",
      columns: [t.tenantId, t.closedBy],
      foreignColumns: [tenantUser.tenantId, tenantUser.id],
    }),
    check("incident_type", sql`type IN (${INCIDENT_TYPE_SQL})`),
    check(
      "incident_severity",
      sql`severity IS NULL OR severity IN ('negligible', 'minor', 'moderate', 'major', 'catastrophic')`,
    ),
    check(
      "incident_harm_grade",
      sql`harm_grade IS NULL OR harm_grade IN ('none', 'low', 'moderate', 'severe', 'fatal')`,
    ),
    check("incident_status", sql`status IN ('open', 'under_review', 'closed')`),
    check(
      "incident_closed",
      sql`(status = 'closed') = (closed_at IS NOT NULL AND closed_by IS NOT NULL AND closed_reason IS NOT NULL)`,
    ),
    // Separation of duties (safety.md rule 11): whoever raised it cannot close it.
    check("incident_closed_by_other", sql`closed_by IS NULL OR closed_by <> raised_by`),
    check("incident_retention_class", sql`retention_class IN ('care_record', 'serious_incident')`),
    check(
      "incident_family_informed",
      sql`(family_informed_at IS NULL) = (family_informed_who IS NULL)`,
    ),
    check("incident_found_at", sql`found_at IS NULL OR found_at >= occurred_at`),
    index("incident_location_idx").on(t.tenantId, t.locationId, t.occurredAt),
    index("incident_status_idx").on(t.tenantId, t.status),
    index("incident_person_ids_idx").using("gin", t.personIds),
  ],
);

/**
 * Someone on an incident: a person using the service, a worker (a member of staff, or an agency
 * worker named in words) or someone not at work (a visitor). Body-map marks recorded through the
 * body map (HZ-019 checks) are linked by id or carry the incident id themselves.
 */
export const incidentPerson = pgTable(
  "incident_person",
  {
    id: id(),
    tenantId: tenantId(),
    incidentId: uuid("incident_id").notNull(),
    /** `service_user`, `worker` or `other_not_at_work` (RIDDOR reg 4 and 5). */
    kind: text("kind").notNull(),
    /** `affected`, `witness` or `involved`. */
    role: text("role").notNull(),
    personId: uuid("person_id"),
    tenantUserId: uuid("tenant_user_id"),
    /** A worker who is not a Harbour user, or a visitor, in words. */
    otherName: text("other_name"),
    injuryDetails: text("injury_details"),
    died: boolean("died").notNull().default(false),
    /** Recorded with a death for the LeDeR prompt until the person record holds them. */
    learningDisability: boolean("learning_disability"),
    autistic: boolean("autistic"),
    subjectToMentalHealthAct: boolean("subject_to_mental_health_act"),
    bodyMapMarkIds: uuid("body_map_mark_ids").array().notNull().default(sql`'{}'::uuid[]`),
    /**
     * Infection incidents: { syndrome, onsetAt, couldBeLinkedWithinSetting, fluConfirmedAt, link },
     * one case for outbreak detection (`detectOutbreaks`).
     */
    infection: jsonb("infection"),
    ...mutableColumns(),
  },
  (t) => [
    unique("incident_person_tenant_id_id_key").on(t.tenantId, t.id),
    foreignKey({
      name: "incident_person_incident_fk",
      columns: [t.tenantId, t.incidentId],
      foreignColumns: [incident.tenantId, incident.id],
    }),
    foreignKey({
      name: "incident_person_person_fk",
      columns: [t.tenantId, t.personId],
      foreignColumns: [person.tenantId, person.id],
    }),
    foreignKey({
      name: "incident_person_tenant_user_fk",
      columns: [t.tenantId, t.tenantUserId],
      foreignColumns: [tenantUser.tenantId, tenantUser.id],
    }),
    check(
      "incident_person_kind",
      sql`kind IN ('service_user', 'worker', 'other_not_at_work')
        AND (kind = 'service_user') = (person_id IS NOT NULL)
        AND (kind <> 'worker' OR tenant_user_id IS NOT NULL OR other_name IS NOT NULL)
        AND (kind <> 'other_not_at_work' OR other_name IS NOT NULL)
        AND (kind = 'worker' OR tenant_user_id IS NULL)`,
    ),
    check("incident_person_role", sql`role IN ('affected', 'witness', 'involved')`),
    check(
      "incident_person_infection",
      sql`infection IS NULL OR jsonb_typeof(infection) = 'object'`,
    ),
    uniqueIndex("incident_person_one_person")
      .on(t.tenantId, t.incidentId, t.personId)
      .where(sql`person_id IS NOT NULL AND deleted_at IS NULL`),
    uniqueIndex("incident_person_one_user")
      .on(t.tenantId, t.incidentId, t.tenantUserId)
      .where(sql`tenant_user_id IS NOT NULL AND deleted_at IS NULL`),
    index("incident_person_incident_idx").on(t.tenantId, t.incidentId),
    index("incident_person_person_idx").on(t.tenantId, t.personId),
  ],
);

/** An answer to a classifier question (append-only; the latest answer per key counts). */
export const classifierAnswer = pgTable(
  "classifier_answer",
  {
    id: id(),
    tenantId: tenantId(),
    incidentId: uuid("incident_id").notNull(),
    /** One of CLASSIFIER_QUESTION_KEYS. */
    questionKey: text("question_key").notNull(),
    /** "yes", "no", "unsure", a whole number of days or hours, or option values. */
    value: jsonb("value").notNull(),
    answeredAt: timestamp("answered_at", { withTimezone: true }).notNull().defaultNow(),
    answeredBy: uuid("answered_by").default(sql`app.current_user_id()`),
    deviceId: text("device_id"),
    ...createdColumns(),
  },
  (t) => [
    unique("classifier_answer_tenant_id_id_key").on(t.tenantId, t.id),
    foreignKey({
      name: "classifier_answer_incident_fk",
      columns: [t.tenantId, t.incidentId],
      foreignColumns: [incident.tenantId, incident.id],
    }),
    foreignKey({
      name: "classifier_answer_answered_by_fk",
      columns: [t.tenantId, t.answeredBy],
      foreignColumns: [tenantUser.tenantId, tenantUser.id],
    }),
    check("classifier_answer_question_key", sql`question_key IN (${CLASSIFIER_QUESTION_SQL})`),
    index("classifier_answer_incident_idx").on(t.tenantId, t.incidentId, t.answeredAt),
  ],
);

/**
 * A statutory notification draft with its clock (SAFE-002 to SAFE-005, SAFE-007, SAFE-008; HZ-013).
 * About an incident, or about a person (a DoLS outcome), or a location (an outbreak found across
 * its cases). `source_key` makes every writer idempotent: one draft per incident, kind and person.
 */
export const statutoryNotification = pgTable(
  "statutory_notification",
  {
    id: id(),
    tenantId: tenantId(),
    locationId: uuid("location_id").notNull(),
    incidentId: uuid("incident_id"),
    personId: uuid("person_id"),
    dolsAuthorisationId: uuid("dols_authorisation_id"),
    sourceKey: text("source_key").notNull(),
    /** One of STATUTORY_NOTIFICATION_KINDS. */
    kind: text("kind").notNull(),
    /** `draft`, `ready`, `submitted` or `not_required`, mirroring the notification workflow. */
    status: text("status").notNull().default("draft"),
    /** The earliest deadline (computed by the domain from `occurred_at` or the outcome time). */
    dueAt: timestamp("due_at", { withTimezone: true }).notNull(),
    /** [{ key, dueAt, wording, statutory }]. */
    deadlines: jsonb("deadlines").notNull().default(sql`'[]'::jsonb`),
    /** Rests on an "unsure" answer: drafted so the clock shows, to be confirmed. */
    provisional: boolean("provisional").notNull().default(false),
    reasons: text("reasons").array().notNull().default(sql`'{}'::text[]`),
    requiredContent: text("required_content").array().notNull().default(sql`'{}'::text[]`),
    /** [{ title, provision, url }]. */
    sources: jsonb("sources").notNull().default(sql`'[]'::jsonb`),
    /** The regulation 18(4B) statement for a DoLS outcome. */
    statement: jsonb("statement"),
    /** What the manager prepares for the regulator's form. */
    content: jsonb("content").notNull().default(sql`'{}'::jsonb`),
    /** A later classification no longer finds it required; a person must still decide. */
    noLongerIndicated: boolean("no_longer_indicated").notNull().default(false),
    noLongerIndicatedReason: text("no_longer_indicated_reason"),
    notRequiredReason: text("not_required_reason"),
    submittedBy: uuid("submitted_by"),
    submittedAt: timestamp("submitted_at", { withTimezone: true }),
    externalReference: text("external_reference"),
    evidenceDocumentId: uuid("evidence_document_id"),
    classifierVersion: text("classifier_version"),
    /** `serious_incident`, or `riddor_report` for the RIDDOR kinds. */
    retentionClass: text("retention_class").notNull(),
    /** When the overdue alert went out (once; the escalation chain takes it from there). */
    overdueNotifiedAt: timestamp("overdue_notified_at", { withTimezone: true }),
    ...mutableColumns(),
  },
  (t) => [
    unique("statutory_notification_tenant_id_id_key").on(t.tenantId, t.id),
    unique("statutory_notification_source_key").on(t.tenantId, t.sourceKey),
    foreignKey({
      name: "statutory_notification_location_fk",
      columns: [t.tenantId, t.locationId],
      foreignColumns: [location.tenantId, location.id],
    }),
    foreignKey({
      name: "statutory_notification_incident_fk",
      columns: [t.tenantId, t.incidentId],
      foreignColumns: [incident.tenantId, incident.id],
    }),
    foreignKey({
      name: "statutory_notification_person_fk",
      columns: [t.tenantId, t.personId],
      foreignColumns: [person.tenantId, person.id],
    }),
    foreignKey({
      name: "statutory_notification_dols_fk",
      columns: [t.tenantId, t.personId, t.dolsAuthorisationId],
      foreignColumns: [
        dolsAuthorisation.tenantId,
        dolsAuthorisation.personId,
        dolsAuthorisation.id,
      ],
    }),
    foreignKey({
      name: "statutory_notification_submitted_by_fk",
      columns: [t.tenantId, t.submittedBy],
      foreignColumns: [tenantUser.tenantId, tenantUser.id],
    }),
    foreignKey({
      name: "statutory_notification_evidence_document_fk",
      columns: [t.tenantId, t.evidenceDocumentId],
      foreignColumns: [document.tenantId, document.id],
    }),
    check("statutory_notification_kind", sql`kind IN (${STATUTORY_NOTIFICATION_KIND_SQL})`),
    check(
      "statutory_notification_status",
      sql`status IN ('draft', 'ready', 'submitted', 'not_required')`,
    ),
    check(
      "statutory_notification_not_required",
      sql`status <> 'not_required' OR not_required_reason IS NOT NULL`,
    ),
    check(
      "statutory_notification_submitted",
      sql`status <> 'submitted' OR (submitted_at IS NOT NULL AND submitted_by IS NOT NULL
        AND (external_reference IS NOT NULL OR evidence_document_id IS NOT NULL))`,
    ),
    check(
      "statutory_notification_dols",
      sql`(kind = 'cqc_reg18_dols_outcome') = (dols_authorisation_id IS NOT NULL)
        AND (dols_authorisation_id IS NULL OR person_id IS NOT NULL)`,
    ),
    check(
      "statutory_notification_retention_class",
      sql`retention_class IN ('serious_incident', 'riddor_report')`,
    ),
    index("statutory_notification_clock_idx").on(t.tenantId, t.status, t.dueAt),
    index("statutory_notification_incident_idx").on(t.tenantId, t.incidentId),
    index("statutory_notification_person_idx").on(t.tenantId, t.personId),
  ],
);

/** The duty of candour record for an incident (regulation 20; SAFE-007; CANDOUR_WORKFLOW). */
export const candourRecord = pgTable(
  "candour_record",
  {
    id: id(),
    tenantId: tenantId(),
    incidentId: uuid("incident_id").notNull(),
    /** The relevant person, when the incident is about one person using the service. */
    personId: uuid("person_id"),
    state: text("state").notNull().default("threshold_assessment"),
    thresholdNotifiable: boolean("threshold_notifiable"),
    thresholdDecidedAt: timestamp("threshold_decided_at", { withTimezone: true }),
    /** The health care professional whose opinion the threshold decision records. */
    thresholdDecidedBy: text("threshold_decided_by"),
    /** { at, byRepresentatives, inPerson, accountGiven, enquiriesAdvised, apologyGiven, writtenRecordId } (reg 20(3)). */
    verbal: jsonb("verbal"),
    /** [{ at, note }] (reg 20(5)(b)). */
    contactAttempts: jsonb("contact_attempts").notNull().default(sql`'[]'::jsonb`),
    /** { sentAt, documentId, includesAccount, includesEnquiries, includesApology } (reg 20(4)). */
    written: jsonb("written"),
    enquiryResultsSharedAt: timestamp("enquiry_results_shared_at", { withTimezone: true }),
    correspondenceDocumentIds: uuid("correspondence_document_ids")
      .array()
      .notNull()
      .default(sql`'{}'::uuid[]`),
    outcome: text("outcome"),
    ...mutableColumns(),
  },
  (t) => [
    unique("candour_record_tenant_id_id_key").on(t.tenantId, t.id),
    unique("candour_record_incident_key").on(t.tenantId, t.incidentId),
    foreignKey({
      name: "candour_record_incident_fk",
      columns: [t.tenantId, t.incidentId],
      foreignColumns: [incident.tenantId, incident.id],
    }),
    foreignKey({
      name: "candour_record_person_fk",
      columns: [t.tenantId, t.personId],
      foreignColumns: [person.tenantId, person.id],
    }),
    check("candour_record_state", sql`state IN (${CANDOUR_STATE_SQL})`),
    check(
      "candour_record_threshold",
      sql`(threshold_notifiable IS NULL) = (threshold_decided_at IS NULL)
        AND (threshold_notifiable IS NULL OR threshold_decided_by IS NOT NULL)`,
    ),
    check("candour_record_attempts", sql`jsonb_typeof(contact_attempts) = 'array'`),
  ],
);

/** The investigation of an incident: method, findings, actions and lessons (SAFE-010). */
export const investigation = pgTable(
  "investigation",
  {
    id: id(),
    tenantId: tenantId(),
    incidentId: uuid("incident_id").notNull(),
    leadTenantUserId: uuid("lead_tenant_user_id"),
    /** The root-cause template used. */
    method: text("method"),
    findings: text("findings"),
    contributingFactors: text("contributing_factors").array().notNull().default(sql`'{}'::text[]`),
    /** [{ id, action, ownerTenantUserId, dueOn, status, taskId }]. */
    actions: jsonb("actions").notNull().default(sql`'[]'::jsonb`),
    lessons: text("lessons"),
    bulletinPublishedAt: timestamp("bulletin_published_at", { withTimezone: true }),
    /** `open` or `completed`. */
    status: text("status").notNull().default("open"),
    completedAt: timestamp("completed_at", { withTimezone: true }),
    ...mutableColumns(),
  },
  (t) => [
    unique("investigation_tenant_id_id_key").on(t.tenantId, t.id),
    unique("investigation_incident_key").on(t.tenantId, t.incidentId),
    foreignKey({
      name: "investigation_incident_fk",
      columns: [t.tenantId, t.incidentId],
      foreignColumns: [incident.tenantId, incident.id],
    }),
    foreignKey({
      name: "investigation_lead_fk",
      columns: [t.tenantId, t.leadTenantUserId],
      foreignColumns: [tenantUser.tenantId, tenantUser.id],
    }),
    check(
      "investigation_method",
      sql`method IS NULL OR method IN ('root_cause_analysis', 'five_whys', 'fishbone',
        'after_action_review', 'swarm_huddle', 'other')`,
    ),
    check("investigation_status", sql`status IN ('open', 'completed')`),
    check(
      "investigation_completed",
      sql`(status = 'completed') = (completed_at IS NOT NULL)
        AND (status = 'open' OR (findings IS NOT NULL AND lessons IS NOT NULL))`,
    ),
    check("investigation_actions", sql`jsonb_typeof(actions) = 'array'`),
  ],
);

export const SAFETY_MUTABLE_TABLES = [
  "incident",
  "incident_person",
  "statutory_notification",
  "candour_record",
  "investigation",
] as const;
export const SAFETY_APPEND_ONLY_TABLES = ["classifier_answer"] as const;

export type IncidentRow = typeof incident.$inferSelect;
export type IncidentPersonRow = typeof incidentPerson.$inferSelect;
export type ClassifierAnswerRow = typeof classifierAnswer.$inferSelect;
export type StatutoryNotificationRow = typeof statutoryNotification.$inferSelect;
export type CandourRecordRow = typeof candourRecord.$inferSelect;
export type InvestigationRow = typeof investigation.$inferSelect;
