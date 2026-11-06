import { z } from "zod";
import { Citation } from "./mca";

/**
 * Incidents, the notification classifier, statutory notifications, duty of candour and
 * investigations (master prompt 11.1, docs/specs/safety.md slice 7). Enumerations mirror
 * packages/domain (`safety/*`); the API tests keep them in step. Numbers use inclusive bounds only.
 */

const uuid = z.uuid();
const isoDateTime = z.iso.datetime({ offset: true });
const isoDate = z.iso.date();
const version = z.number().int().min(1);
/** 0 when the record does not exist yet (candour, investigation). */
const upsertVersion = z.number().int().min(0);
const text = (max: number) => z.string().trim().max(max);

export const IncidentType = z
  .enum([
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
  ])
  .meta({ id: "IncidentType" });
export type IncidentType = z.infer<typeof IncidentType>;

export const IncidentStatus = z
  .enum(["open", "under_review", "closed"])
  .meta({ id: "IncidentStatus" });
export const IncidentSeverity = z
  .enum(["negligible", "minor", "moderate", "major", "catastrophic"])
  .meta({ id: "IncidentSeverity", description: "NPSA consequence scale, as staff judge it" });
export const HarmGrade = z
  .enum(["none", "low", "moderate", "severe", "fatal"])
  .meta({ id: "HarmGrade", description: "LFPSE physical harm, as staff judge it" });

export const ClassifierQuestionKey = z
  .enum([
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
  ])
  .meta({ id: "ClassifierQuestionKey" });
export type ClassifierQuestionKey = z.infer<typeof ClassifierQuestionKey>;

export const StatutoryNotificationKind = z
  .enum([
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
  ])
  .meta({ id: "StatutoryNotificationKind" });
export type StatutoryNotificationKind = z.infer<typeof StatutoryNotificationKind>;

export const StatutoryNotificationStatus = z
  .enum(["draft", "ready", "submitted", "not_required"])
  .meta({ id: "StatutoryNotificationStatus" });
export const NotificationClock = z
  .enum(["due", "overdue", "done"])
  .meta({ id: "NotificationClock" });

/** "unsure" is always allowed; otherwise yes or no, a whole number, or option values. */
export const ClassifierAnswerValue = z
  .union([
    z.enum(["yes", "no", "unsure"]),
    z.number().int().min(0).max(100_000),
    z.string().max(80),
    z.array(z.string().max(80)).max(20),
  ])
  .meta({ id: "ClassifierAnswerValue" });
export type ClassifierAnswerValue = z.infer<typeof ClassifierAnswerValue>;

export const ClassifierAnswerInput = z
  .object({ key: ClassifierQuestionKey, value: ClassifierAnswerValue })
  .meta({ id: "ClassifierAnswerInput" });

export const InfectionCase = z
  .object({
    syndrome: z.enum(["acute_respiratory", "diarrhoea_vomiting"]),
    /** When the symptoms started (or were first noticed). */
    onsetAt: isoDateTime,
    /** Acute respiratory infection: false only when it could not have spread in the setting. */
    couldBeLinkedWithinSetting: z.boolean().nullable(),
    fluConfirmedAt: isoDateTime.nullable().optional(),
    /** Diarrhoea and vomiting: the group staff linked it to, or not linked; null until reviewed. */
    link: z
      .union([z.object({ group: text(60).min(1) }), z.literal("not_linked")])
      .nullable()
      .optional(),
  })
  .meta({ id: "InfectionCase" });
export type InfectionCase = z.infer<typeof InfectionCase>;

export const IncidentPersonInput = z
  .object({
    /** An existing row, when updating. */
    id: uuid.optional(),
    kind: z.enum(["service_user", "worker", "other_not_at_work"]),
    role: z.enum(["affected", "witness", "involved"]),
    personId: uuid.optional(),
    tenantUserId: uuid.optional(),
    otherName: text(200).optional(),
    injuryDetails: text(2000).optional(),
    died: z.boolean().default(false),
    learningDisability: z.boolean().optional(),
    autistic: z.boolean().optional(),
    subjectToMentalHealthAct: z.boolean().optional(),
    /** Marks already recorded on the person's body map (HZ-019 checks applied there). */
    bodyMapMarkIds: z.array(uuid).max(50).default([]),
    infection: InfectionCase.optional(),
    /** Update only: take this person off the incident. */
    removed: z.boolean().optional(),
  })
  .meta({ id: "IncidentPersonInput" });
export type IncidentPersonInput = z.infer<typeof IncidentPersonInput>;

export const FamilyInformed = z
  .object({ who: text(200).min(2), at: isoDateTime })
  .meta({ id: "FamilyInformed" });

export const CreateIncident = z
  .object({
    /** Device-generated UUIDv7: a replayed upload with the same id is ignored. */
    id: uuid.optional(),
    locationId: uuid,
    type: IncidentType,
    /** When it happened: every clock starts here, however late the device syncs. */
    occurredAt: isoDateTime,
    deviceTime: isoDateTime.optional(),
    foundAt: isoDateTime.optional(),
    severity: IncidentSeverity.optional(),
    harmGrade: HarmGrade.optional(),
    description: text(4000).min(3),
    immediateActions: text(4000).optional(),
    /**
     * Null for "Not known yet" (H-264, HZ-090): the question stays open with a task for the
     * person in charge, so a reporter is never pushed to guess yes or no.
     */
    emergencyServicesCalled: z.boolean().nullable().default(false),
    gpContacted: z.boolean().nullable().default(false),
    contactNotes: text(2000).optional(),
    familyInformed: FamilyInformed.optional(),
    people: z.array(IncidentPersonInput).max(50).default([]),
    /**
     * Answers given at the point of care. Without `safety.incident.manage`, only the falls
     * questions (head injury, anticoagulants) may be answered here.
     */
    answers: z.array(ClassifierAnswerInput).max(40).default([]),
  })
  .meta({ id: "CreateIncident" });
export type CreateIncident = z.infer<typeof CreateIncident>;

export const UpdateIncident = z
  .object({
    severity: IncidentSeverity.nullable().optional(),
    harmGrade: HarmGrade.nullable().optional(),
    description: text(4000).min(3).optional(),
    immediateActions: text(4000).nullable().optional(),
    foundAt: isoDateTime.nullable().optional(),
    emergencyServicesCalled: z.boolean().nullable().optional(),
    gpContacted: z.boolean().nullable().optional(),
    contactNotes: text(2000).nullable().optional(),
    familyInformed: FamilyInformed.nullable().optional(),
    /** Rows with an id are changed (or removed); rows without are added. */
    people: z.array(IncidentPersonInput).max(50).optional(),
    /**
     * Why someone affected is no longer affected (removed, or their kind or role changed),
     * whether or not a duty of candour decision is recorded: at least 20 characters, from a holder
     * of safety.incident.manage, audited with the person (HZ-013; #120 review round 3, M1).
     */
    candourReason: text(1000).optional(),
    version,
  })
  .meta({ id: "UpdateIncident" });
export type UpdateIncident = z.infer<typeof UpdateIncident>;

export const CloseIncident = z
  .object({ reason: text(1000).min(3), version })
  .meta({ id: "CloseIncident" });
export type CloseIncident = z.infer<typeof CloseIncident>;

export const ReviewIncident = z
  .object({ to: z.enum(["under_review", "open"]), reason: text(1000).optional(), version })
  .meta({ id: "ReviewIncident" });
export type ReviewIncident = z.infer<typeof ReviewIncident>;

export const IncidentPersonItem = z
  .object({
    id: uuid,
    kind: z.enum(["service_user", "worker", "other_not_at_work"]),
    role: z.enum(["affected", "witness", "involved"]),
    personId: uuid.nullable(),
    tenantUserId: uuid.nullable(),
    otherName: z.string().nullable(),
    injuryDetails: z.string().nullable(),
    died: z.boolean(),
    learningDisability: z.boolean().nullable(),
    autistic: z.boolean().nullable(),
    subjectToMentalHealthAct: z.boolean().nullable(),
    bodyMapMarkIds: z.array(uuid),
    infection: InfectionCase.nullable(),
    version,
  })
  .meta({ id: "IncidentPersonItem" });
export type IncidentPersonItem = z.infer<typeof IncidentPersonItem>;

export const OutputDeadline = z
  .object({
    key: z.enum([
      "without_delay",
      "notify_without_delay",
      "report_received",
      "report",
      "verbal_notification",
      "written_notification_target",
    ]),
    dueAt: isoDateTime,
    wording: z.string(),
    /** False for a Harbour or tenant target (the candour written target). */
    statutory: z.boolean(),
  })
  .meta({ id: "OutputDeadline" });

export const StatutoryNotificationSummary = z
  .object({
    id: uuid,
    kind: StatutoryNotificationKind,
    label: z.string(),
    recipient: z.string(),
    /** False where Harbour sets the time and the law does not. */
    statutory: z.boolean(),
    status: StatutoryNotificationStatus,
    provisional: z.boolean(),
    noLongerIndicated: z.boolean(),
    noLongerIndicatedReason: z.string().nullable(),
    dueAt: isoDateTime,
    clock: NotificationClock,
    locationId: uuid,
    incidentId: uuid.nullable(),
    personId: uuid.nullable(),
    dolsAuthorisationId: uuid.nullable(),
    version,
  })
  .meta({ id: "StatutoryNotificationSummary" });
export type StatutoryNotificationSummary = z.infer<typeof StatutoryNotificationSummary>;

export const StatutoryNotificationDetail = StatutoryNotificationSummary.extend({
  deadlines: z.array(OutputDeadline),
  reasons: z.array(z.string()),
  requiredContent: z.array(z.string()),
  sources: z.array(Citation),
  /** The regulation 18(4B) statement for a DoLS outcome. */
  statement: z.record(z.string(), z.unknown()).nullable(),
  content: z.record(z.string(), z.string()),
  notRequiredReason: z.string().nullable(),
  submittedAt: isoDateTime.nullable(),
  submittedBy: uuid.nullable(),
  externalReference: z.string().nullable(),
  evidenceDocumentId: uuid.nullable(),
  classifierVersion: z.string().nullable(),
  retentionClass: z.enum(["serious_incident", "riddor_report"]),
}).meta({ id: "StatutoryNotificationDetail" });
export type StatutoryNotificationDetail = z.infer<typeof StatutoryNotificationDetail>;

export const StatutoryNotificationList = z
  .object({ items: z.array(StatutoryNotificationSummary) })
  .meta({ id: "StatutoryNotificationList" });
export type StatutoryNotificationList = z.infer<typeof StatutoryNotificationList>;

export const PrepareNotification = z
  .object({
    /** The fields of the regulator's form, as the manager fills them in. */
    content: z.record(z.string().max(80), z.string().max(8000)).default({}),
    /** True moves a draft to ready; false moves a ready notification back to draft. */
    ready: z.boolean(),
    version,
  })
  .meta({ id: "PrepareNotification" });
export type PrepareNotification = z.infer<typeof PrepareNotification>;

export const SubmitNotification = z
  .object({
    submittedAt: isoDateTime,
    externalReference: text(120).optional(),
    evidenceDocumentId: uuid.optional(),
    version,
  })
  .meta({ id: "SubmitNotification" });
export type SubmitNotification = z.infer<typeof SubmitNotification>;

export const NotRequiredNotification = z
  .object({ reason: text(1000).min(3), version })
  .meta({ id: "NotRequiredNotification" });
export type NotRequiredNotification = z.infer<typeof NotRequiredNotification>;

export const ClassifierQuestionItem = z
  .object({
    key: ClassifierQuestionKey,
    kind: z.enum(["yes_no_unsure", "days", "hours", "choice", "choices"]),
    text: z.string(),
    help: z.string().nullable(),
    options: z.array(z.object({ value: z.string(), label: z.string() })),
    sources: z.array(Citation),
  })
  .meta({ id: "ClassifierQuestionItem" });

export const ClassifierView = z
  .object({
    classifierVersion: z.string(),
    classifiedAt: isoDateTime,
    /** False outside England: notifications are not checked (no partial answer). */
    nationSupported: z.boolean(),
    outputs: z.array(
      z.object({
        kind: StatutoryNotificationKind,
        dueAt: isoDateTime,
        deadlines: z.array(OutputDeadline),
        reasons: z.array(z.string()),
        provisional: z.boolean(),
        requiredContent: z.array(z.string()),
      }),
    ),
    exclusions: z.array(z.object({ kind: StatutoryNotificationKind, reason: z.string() })),
    pending: z.array(
      z.object({ kind: StatutoryNotificationKind, waitingFor: z.array(ClassifierQuestionKey) }),
    ),
    openQuestions: z.array(ClassifierQuestionItem),
    tasks: z.array(
      z.object({
        task: z.string(),
        reason: z.string(),
        dueAt: isoDateTime.nullable(),
        until: isoDateTime.nullable(),
      }),
    ),
    /** One line per output kind, for the audit trail. */
    reasoning: z.array(z.string()),
    notifications: z.array(StatutoryNotificationSummary),
  })
  .meta({ id: "ClassifierView" });
export type ClassifierView = z.infer<typeof ClassifierView>;

export const IncidentSummary = z
  .object({
    id: uuid,
    locationId: uuid,
    type: IncidentType,
    occurredAt: isoDateTime,
    recordedAt: isoDateTime,
    deviceTime: isoDateTime.nullable(),
    lateEntry: z.boolean(),
    clockDrift: z.boolean(),
    status: IncidentStatus,
    raisedBy: uuid,
    /**
     * True when the incident involves people outside your scope: you see the header and your
     * people only (safety.md section 2).
     */
    restricted: z.boolean(),
    severity: IncidentSeverity.nullable(),
    harmGrade: HarmGrade.nullable(),
    classifiedAt: isoDateTime.nullable(),
    openQuestionCount: z.number().int(),
    version,
  })
  .meta({ id: "IncidentSummary" });
export type IncidentSummary = z.infer<typeof IncidentSummary>;

export const IncidentDetail = IncidentSummary.extend({
  description: z.string().nullable(),
  immediateActions: z.string().nullable(),
  foundAt: isoDateTime.nullable(),
  emergencyServicesCalled: z.boolean().nullable(),
  gpContacted: z.boolean().nullable(),
  contactNotes: z.string().nullable(),
  familyInformed: FamilyInformed.nullable(),
  closedBy: uuid.nullable(),
  closedAt: isoDateTime.nullable(),
  closedReason: z.string().nullable(),
  retentionClass: z.enum(["care_record", "serious_incident"]),
  people: z.array(IncidentPersonItem),
  /** Null when restricted. */
  classifier: ClassifierView.nullable(),
}).meta({ id: "IncidentDetail" });
export type IncidentDetail = z.infer<typeof IncidentDetail>;

export const IncidentList = z
  .object({ items: z.array(IncidentSummary) })
  .meta({ id: "IncidentList" });
export type IncidentList = z.infer<typeof IncidentList>;

export const AnswerClassifier = z
  .object({ answers: z.array(ClassifierAnswerInput).min(1).max(40) })
  .meta({ id: "AnswerClassifier" });
export type AnswerClassifier = z.infer<typeof AnswerClassifier>;

export const ClassifierAnswerItem = z
  .object({
    id: uuid,
    key: ClassifierQuestionKey,
    value: ClassifierAnswerValue,
    answeredAt: isoDateTime,
    answeredBy: uuid.nullable(),
  })
  .meta({ id: "ClassifierAnswerItem" });

export const ClassifierState = z
  .object({
    answers: z.array(ClassifierAnswerItem),
    result: ClassifierView.nullable(),
  })
  .meta({ id: "ClassifierState" });
export type ClassifierState = z.infer<typeof ClassifierState>;

// ------------------------------------------------------------------------------------------------
// Duty of candour
// ------------------------------------------------------------------------------------------------

export const CandourState = z
  .enum([
    "threshold_assessment",
    "not_notifiable",
    "verbal_due",
    "no_contact",
    "written_due",
    "enquiries_open",
    "closed",
  ])
  .meta({ id: "CandourState" });

export const CandourThreshold = z
  .object({
    notifiable: z.boolean(),
    decidedAt: isoDateTime,
    /** The health care professional whose opinion the decision records. */
    decidedBy: text(200).min(2),
  })
  .meta({ id: "CandourThreshold" });

export const CandourVerbal = z
  .object({
    at: isoDateTime,
    byRepresentatives: z.array(text(200)).max(10),
    inPerson: z.boolean(),
    accountGiven: z.boolean(),
    enquiriesAdvised: z.boolean(),
    apologyGiven: z.boolean(),
    writtenRecordId: uuid.nullable(),
  })
  .meta({ id: "CandourVerbal" });

export const CandourWritten = z
  .object({
    sentAt: isoDateTime,
    documentId: uuid.nullable(),
    includesAccount: z.boolean(),
    includesEnquiries: z.boolean(),
    includesApology: z.boolean(),
  })
  .meta({ id: "CandourWritten" });

export const UpdateCandour = z
  .object({
    personId: uuid.nullable().optional(),
    threshold: CandourThreshold.nullable().optional(),
    verbal: CandourVerbal.nullable().optional(),
    contactAttempts: z
      .array(z.object({ at: isoDateTime, note: text(1000).min(3) }))
      .max(50)
      .optional(),
    written: CandourWritten.nullable().optional(),
    enquiryResultsSharedAt: isoDateTime.nullable().optional(),
    correspondenceDocumentIds: z.array(uuid).max(100).optional(),
    outcome: text(2000).nullable().optional(),
    /**
     * Why, when the threshold decision differs from Harbour's finding or changes a recorded one:
     * at least 20 characters, with `thresholdConfirmed` (candourReasonProblems; HZ-091).
     */
    thresholdReason: text(1000).optional(),
    thresholdConfirmed: z.boolean().optional(),
    version: upsertVersion,
  })
  .meta({ id: "UpdateCandour" });
export type UpdateCandour = z.infer<typeof UpdateCandour>;

export const CandourStep = z
  .object({
    to: CandourState,
    reason: text(1000).optional(),
    /** "Not notifiable" after Harbour drafted a candour notification is confirmed (HZ-091). */
    confirmed: z.boolean().optional(),
    version,
  })
  .meta({ id: "CandourStep" });
export type CandourStep = z.infer<typeof CandourStep>;

/**
 * Reopens a record finished as not notifiable or no contact (#120 review round 3, H1): a reason
 * of at least 20 characters, audited (`candourReopenProblems`).
 */
export const ReopenCandour = z
  .object({
    reason: text(1000),
    version,
  })
  .meta({ id: "ReopenCandour" });
export type ReopenCandour = z.infer<typeof ReopenCandour>;

export const CandourItem = z
  .object({
    id: uuid,
    incidentId: uuid,
    personId: uuid.nullable(),
    state: CandourState,
    threshold: CandourThreshold.nullable(),
    verbal: CandourVerbal.nullable(),
    contactAttempts: z.array(z.object({ at: isoDateTime, note: z.string() })),
    written: CandourWritten.nullable(),
    enquiryResultsSharedAt: isoDateTime.nullable(),
    correspondenceDocumentIds: z.array(uuid),
    outcome: z.string().nullable(),
    clocks: z.object({
      verbalDueAt: isoDateTime,
      writtenTargetAt: isoDateTime,
      writtenTargetWording: z.string(),
      provisional: z.boolean(),
    }),
    version,
  })
  .meta({ id: "CandourItem" });
export type CandourItem = z.infer<typeof CandourItem>;

export const CandourView = z.object({ record: CandourItem.nullable() }).meta({ id: "CandourView" });
export type CandourView = z.infer<typeof CandourView>;

// ------------------------------------------------------------------------------------------------
// Investigation
// ------------------------------------------------------------------------------------------------

export const InvestigationMethod = z
  .enum([
    "root_cause_analysis",
    "five_whys",
    "fishbone",
    "after_action_review",
    "swarm_huddle",
    "other",
  ])
  .meta({ id: "InvestigationMethod" });

export const InvestigationAction = z
  .object({
    id: uuid.optional(),
    action: text(1000).min(3),
    ownerTenantUserId: uuid.nullable(),
    dueOn: isoDate.nullable(),
    status: z.enum(["open", "done", "cancelled"]).default("open"),
  })
  .meta({ id: "InvestigationAction" });

export const UpdateInvestigation = z
  .object({
    leadTenantUserId: uuid.nullable().optional(),
    method: InvestigationMethod.nullable().optional(),
    findings: text(8000).nullable().optional(),
    contributingFactors: z.array(text(500)).max(30).optional(),
    actions: z.array(InvestigationAction).max(50).optional(),
    lessons: text(8000).nullable().optional(),
    bulletinPublished: z.boolean().optional(),
    status: z.enum(["open", "completed"]).optional(),
    version: upsertVersion,
  })
  .meta({ id: "UpdateInvestigation" });
export type UpdateInvestigation = z.infer<typeof UpdateInvestigation>;

export const InvestigationItem = z
  .object({
    id: uuid,
    incidentId: uuid,
    leadTenantUserId: uuid.nullable(),
    method: InvestigationMethod.nullable(),
    findings: z.string().nullable(),
    contributingFactors: z.array(z.string()),
    actions: z.array(
      z.object({
        id: uuid,
        action: z.string(),
        ownerTenantUserId: uuid.nullable(),
        dueOn: isoDate.nullable(),
        status: z.enum(["open", "done", "cancelled"]),
        taskId: uuid.nullable(),
      }),
    ),
    lessons: z.string().nullable(),
    bulletinPublishedAt: isoDateTime.nullable(),
    status: z.enum(["open", "completed"]),
    completedAt: isoDateTime.nullable(),
    version,
  })
  .meta({ id: "InvestigationItem" });
export type InvestigationItem = z.infer<typeof InvestigationItem>;

export const InvestigationView = z
  .object({ record: InvestigationItem.nullable() })
  .meta({ id: "InvestigationView" });
export type InvestigationView = z.infer<typeof InvestigationView>;
