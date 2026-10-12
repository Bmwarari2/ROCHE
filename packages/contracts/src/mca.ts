import { z } from "zod";
import { StaffName } from "./staff";

/**
 * Consent, mental capacity, best interests and the DoLS register (master prompt 10.4,
 * docs/specs/care.md slice 6). Enumerations mirror packages/domain (`care/mca/*`); the API tests
 * keep them in step. The API runs the domain checks and answers 422 with their messages, so the
 * contracts stay lenient about completeness and leave the wording to the rules. Numbers use
 * inclusive bounds only.
 */

const uuid = z.uuid();
const isoDateTime = z.iso.datetime({ offset: true });
const isoDate = z.iso.date();
const version = z.number().int().min(1);
const text = (max: number) => z.string().trim().max(max);

export const Citation = z
  .object({ source: z.string(), provision: z.string(), url: z.string() })
  .meta({ id: "Citation", description: "Where a rule comes from" });
export type Citation = z.infer<typeof Citation>;

// ------------------------------------------------------------------------------------------------
// Consent
// ------------------------------------------------------------------------------------------------

export const ConsentDecisionKind = z
  .enum([
    "care_plan",
    "photos",
    "social_media",
    "sharing",
    "marketing",
    "ai_processing",
    "bed_rails",
    "covert_medicines",
  ])
  .meta({ id: "ConsentDecisionKind" });
export type ConsentDecisionKind = z.infer<typeof ConsentDecisionKind>;

export const RepresentativeKind = z
  .enum([
    "lpa_health_welfare",
    "lpa_property_financial",
    "deputy",
    "appointee",
    "imca",
    "advocate",
    "family_or_friend",
  ])
  .meta({ id: "RepresentativeKind" });
export type RepresentativeKind = z.infer<typeof RepresentativeKind>;

export const CapacityStatus = z
  .enum(["assumed", "has_capacity", "lacks_capacity"])
  .meta({ id: "CapacityStatus" });

export const ConsentRepresentative = z
  .object({
    kind: RepresentativeKind,
    /** One of the person's contacts, or the name in words. */
    contactId: uuid.optional(),
    name: text(200).optional(),
    /** Lasting power of attorney: registered with the Office of the Public Guardian. */
    registered: z.boolean().optional(),
    opgReference: text(60).optional(),
    excludedDecisions: z.array(ConsentDecisionKind).max(8).default([]),
    /** Deputy: the scope and decisions of the Court of Protection order, and when it ends. */
    deputyScope: z.enum(["personal_welfare", "property_and_affairs"]).optional(),
    deputyDecisions: z.array(ConsentDecisionKind).max(8).default([]),
    restraintExpresslyAuthorised: z.boolean().optional(),
    orderEndsAt: isoDateTime.optional(),
    courtReference: text(60).optional(),
  })
  .meta({ id: "ConsentRepresentative" });
export type ConsentRepresentative = z.infer<typeof ConsentRepresentative>;

export const RestraintConditions = z
  .object({ necessaryToPreventHarm: z.boolean(), proportionate: z.boolean() })
  .meta({ id: "RestraintConditions" });

export const CreateConsent = z
  .object({
    /**
     * A client UUIDv7 kept across retries of the same save: a replay returns the record it made
     * (HZ-029). `Idempotency-Key` may carry it instead.
     */
    id: uuid.optional(),
    decision: ConsentDecisionKind,
    outcome: z.enum(["given", "refused"]),
    givenBy: z.enum(["person", "representative"]),
    representative: ConsentRepresentative.optional(),
    givenAt: isoDateTime,
    expiresAt: isoDateTime.optional(),
    /** How the decision was made. */
    evidence: text(2000),
    evidenceDocumentId: uuid.optional(),
    restraintConditions: RestraintConditions.optional(),
    bestInterestsDecisionId: uuid.optional(),
  })
  .meta({
    id: "CreateConsent",
    description:
      "The person's capacity for the decision is found from their capacity assessments, never taken from the request.",
  });
export type CreateConsent = z.infer<typeof CreateConsent>;

export const WithdrawConsent = z
  .object({
    reason: text(500).min(3),
    withdrawnAt: isoDateTime.optional(),
    version,
  })
  .meta({ id: "WithdrawConsent" });
export type WithdrawConsent = z.infer<typeof WithdrawConsent>;

export const ConsentItem = z
  .object({
    id: uuid,
    personId: uuid,
    decision: ConsentDecisionKind,
    outcome: z.enum(["given", "refused"]),
    givenBy: z.enum(["person", "representative"]),
    representative: ConsentRepresentative.nullable(),
    capacityStatus: CapacityStatus,
    capacityAssessmentId: uuid.nullable(),
    givenAt: isoDateTime,
    expiresAt: isoDateTime.nullable(),
    withdrawnAt: isoDateTime.nullable(),
    withdrawnReason: z.string().nullable(),
    evidence: z.string(),
    evidenceDocumentId: uuid.nullable(),
    restraintConditions: RestraintConditions.nullable(),
    bestInterestsDecisionId: uuid.nullable(),
    recordedBy: uuid.nullable(),
    /** Who recorded it, by name and job title. */
    recordedByStaff: StaffName.nullable(),
    version,
  })
  .meta({ id: "ConsentItem" });
export type ConsentItem = z.infer<typeof ConsentItem>;

export const ConsentDecisionStatus = z
  .object({
    decision: ConsentDecisionKind,
    label: z.string(),
    /** `valid`, `refused`, or `none` with the reasons (care.md rule 9; HZ-026). */
    status: z.enum(["valid", "refused", "none"]),
    recordId: uuid.nullable(),
    message: z.string().nullable(),
    problems: z.array(z.string()),
    capacity: CapacityStatus,
    capacityReviewOverdue: z.boolean(),
  })
  .meta({ id: "ConsentDecisionStatus" });
export type ConsentDecisionStatus = z.infer<typeof ConsentDecisionStatus>;

export const ConsentList = z
  .object({ items: z.array(ConsentItem), decisions: z.array(ConsentDecisionStatus) })
  .meta({ id: "ConsentList" });
export type ConsentList = z.infer<typeof ConsentList>;

// ------------------------------------------------------------------------------------------------
// Capacity assessments
// ------------------------------------------------------------------------------------------------

export const PracticableStep = z
  .enum([
    "simple_language",
    "visual_aids",
    "best_time_or_place",
    "interpreter_or_communication_aid",
    "trusted_person_present",
    "information_repeated",
    "other",
  ])
  .meta({ id: "PracticableStep" });

export const FunctionalAnswer = z
  .object({ able: z.boolean().nullable(), evidence: text(2000).nullable().optional() })
  .meta({ id: "FunctionalAnswer" });

const correction = {
  supersedesId: uuid.optional(),
  correctionReason: text(500).min(3).optional(),
};

export const CreateCapacityAssessment = z
  .object({
    /** Client UUIDv7: a replayed upload with the same id is ignored. */
    id: uuid.optional(),
    decision: text(500),
    decisionKind: ConsentDecisionKind.optional(),
    assessedAt: isoDateTime,
    /** A member of staff, or a professional from outside named in words. */
    assessorTenantUserId: uuid.optional(),
    assessorName: text(200).optional(),
    assessorRole: text(120).optional(),
    practicableSteps: z
      .array(z.object({ step: PracticableStep, detail: text(1000) }))
      .max(20)
      .default([]),
    stage1: z.object({
      impairment: z.boolean().nullable(),
      description: text(2000).nullable().optional(),
    }),
    stage2: z
      .object({
        understand: FunctionalAnswer.optional(),
        retain: FunctionalAnswer.optional(),
        useOrWeigh: FunctionalAnswer.optional(),
        communicate: FunctionalAnswer.optional(),
      })
      .default({}),
    inabilityBecauseOfImpairment: z.boolean().nullable().optional(),
    outcome: z.enum(["has_capacity", "lacks_capacity"]).nullable(),
    reviewOn: isoDate.optional(),
    ...correction,
  })
  .meta({ id: "CreateCapacityAssessment" });
export type CreateCapacityAssessment = z.infer<typeof CreateCapacityAssessment>;

export const CapacityAssessmentItem = z
  .object({
    id: uuid,
    personId: uuid,
    decision: z.string(),
    decisionKind: ConsentDecisionKind.nullable(),
    assessedAt: isoDateTime,
    assessorTenantUserId: uuid.nullable(),
    assessorName: z.string().nullable(),
    assessorRole: z.string().nullable(),
    practicableSteps: z.array(z.object({ step: PracticableStep, detail: z.string() })),
    stage1: z.object({ impairment: z.boolean(), description: z.string().nullable() }),
    stage2: z.record(z.string(), FunctionalAnswer),
    inabilityBecauseOfImpairment: z.boolean().nullable(),
    outcome: z.enum(["has_capacity", "lacks_capacity"]),
    unableTo: z.array(z.string()),
    /** Why, in the Act's words. */
    reason: z.string(),
    reviewOn: isoDate.nullable(),
    recordedAt: isoDateTime,
    recordedBy: uuid.nullable(),
    /** Who recorded it, by name and job title. */
    recordedByStaff: StaffName.nullable(),
    supersedesId: uuid.nullable(),
    correctionReason: z.string().nullable(),
    superseded: z.boolean(),
  })
  .meta({ id: "CapacityAssessmentItem" });
export type CapacityAssessmentItem = z.infer<typeof CapacityAssessmentItem>;

export const CapacityAssessmentList = z
  .object({ items: z.array(CapacityAssessmentItem) })
  .meta({ id: "CapacityAssessmentList" });
export type CapacityAssessmentList = z.infer<typeof CapacityAssessmentList>;

// ------------------------------------------------------------------------------------------------
// Best interests
// ------------------------------------------------------------------------------------------------

export const BestInterestsItemKey = z
  .enum([
    "no_unjustified_assumptions",
    "relevant_circumstances",
    "regaining_capacity",
    "participation",
    "life_sustaining_treatment",
    "wishes_and_feelings",
    "beliefs_and_values",
    "other_factors",
    "views_of_others",
    "less_restrictive_option",
  ])
  .meta({ id: "BestInterestsItemKey" });

export const ConsulteeKind = z
  .enum([
    "named_by_person",
    "family_or_friend",
    "lpa_donee",
    "deputy",
    "paid_carer_or_professional",
    "imca",
  ])
  .meta({ id: "ConsulteeKind" });

export const ChecklistAnswer = z
  .discriminatedUnion("answer", [
    z.object({ answer: z.literal("considered"), note: text(2000) }),
    z.object({ answer: z.literal("not_applicable"), reason: text(2000) }),
  ])
  .meta({ id: "ChecklistAnswer" });

export const Consultation = z
  .object({
    consultee: ConsulteeKind,
    name: text(200).optional(),
    contactId: uuid.optional(),
    views: text(2000),
    consultedAt: isoDateTime,
  })
  .meta({ id: "Consultation" });

const checklistShape = Object.fromEntries(
  BestInterestsItemKey.options.map((key) => [key, ChecklistAnswer.optional()]),
) as Record<z.infer<typeof BestInterestsItemKey>, z.ZodOptional<typeof ChecklistAnswer>>;

export const BestInterestsChecklist = z
  .object(checklistShape)
  .meta({ id: "BestInterestsChecklist" });

export const CreateBestInterests = z
  .object({
    id: uuid.optional(),
    capacityAssessmentId: uuid,
    decision: text(2000),
    decidedAt: isoDateTime,
    checklist: BestInterestsChecklist,
    consultations: z.array(Consultation).max(30).default([]),
    noConsultationReason: text(1000).optional(),
    seriousMedicalTreatment: z.boolean().default(false),
    accommodationChange: z.boolean().default(false),
    reviewOn: isoDate.nullable(),
    ...correction,
  })
  .meta({ id: "CreateBestInterests" });
export type CreateBestInterests = z.infer<typeof CreateBestInterests>;

export const ImcaPrompt = z
  .object({ message: z.string(), sources: z.array(Citation) })
  .meta({ id: "ImcaPrompt" });

export const BestInterestsItem = z
  .object({
    id: uuid,
    personId: uuid,
    capacityAssessmentId: uuid,
    decision: z.string(),
    decidedAt: isoDateTime,
    checklist: BestInterestsChecklist,
    consultations: z.array(Consultation),
    noConsultationReason: z.string().nullable(),
    seriousMedicalTreatment: z.boolean(),
    accommodationChange: z.boolean(),
    imcaPrompt: z.string().nullable(),
    reviewOn: isoDate,
    recordedAt: isoDateTime,
    recordedBy: uuid.nullable(),
    /** Who recorded it, by name and job title. */
    recordedByStaff: StaffName.nullable(),
    supersedesId: uuid.nullable(),
    correctionReason: z.string().nullable(),
    superseded: z.boolean(),
  })
  .meta({ id: "BestInterestsItem" });
export type BestInterestsItem = z.infer<typeof BestInterestsItem>;

export const BestInterestsList = z
  .object({ items: z.array(BestInterestsItem) })
  .meta({ id: "BestInterestsList" });
export type BestInterestsList = z.infer<typeof BestInterestsList>;

// ------------------------------------------------------------------------------------------------
// DoLS register
// ------------------------------------------------------------------------------------------------

export const DolsType = z.enum(["urgent", "standard", "court_order"]).meta({ id: "DolsType" });
export const DolsOutcome = z
  .enum(["pending", "granted", "not_granted", "withdrawn"])
  .meta({ id: "DolsOutcome" });
export const DolsStatus = z
  .enum([
    "requested",
    "not_granted",
    "withdrawn",
    "not_started",
    "active",
    "expiring",
    "expired",
    "ended",
  ])
  .meta({ id: "DolsStatus" });

export const UrgentExtension = z
  .object({
    requestedAt: isoDateTime,
    outcome: z.enum(["pending", "granted", "refused"]),
    extendedTo: isoDateTime.nullable(),
  })
  .meta({ id: "UrgentExtension" });

export const DolsInput = z
  .object({
    type: DolsType,
    requestedAt: isoDateTime,
    outcome: DolsOutcome.default("pending"),
    outcomeAt: isoDateTime.nullable().optional(),
    grantedFrom: isoDateTime.nullable().optional(),
    grantedTo: isoDateTime.nullable().optional(),
    extensions: z.array(UrgentExtension).max(5).default([]),
    precededByUrgent: z.boolean().default(false),
    precededByAuthorisationId: uuid.nullable().optional(),
    withdrawalReason: text(1000).nullable().optional(),
    endedAt: isoDateTime.nullable().optional(),
    endedReason: text(1000).nullable().optional(),
    conditions: text(4000).nullable().optional(),
    rprName: text(200).nullable().optional(),
    rprContactId: uuid.nullable().optional(),
    supervisoryBody: text(200).nullable().optional(),
    supervisoryBodyReference: text(120).nullable().optional(),
    objectionEvidence: text(2000).nullable().optional(),
  })
  .meta({ id: "DolsInput" });
export type DolsInput = z.infer<typeof DolsInput>;

/**
 * A new DoLS register entry, with a client UUIDv7 kept across retries of the same save: a replay
 * returns the entry it made (HZ-029). `Idempotency-Key` may carry it instead.
 */
export const CreateDols = DolsInput.extend({ id: uuid.optional() }).meta({ id: "CreateDols" });
export type CreateDols = z.infer<typeof CreateDols>;

export const UpdateDols = DolsInput.extend({ version }).meta({ id: "UpdateDols" });
export type UpdateDols = z.infer<typeof UpdateDols>;

export const DolsCqcNotification = z
  .object({
    /** Whether regulation 18(4A) needs a notification, and why (dolsCqcNotification). */
    required: z.boolean(),
    reason: z.string(),
    notificationId: uuid.nullable(),
    status: z.enum(["draft", "ready", "submitted", "not_required"]).nullable(),
    dueAt: isoDateTime.nullable(),
  })
  .meta({ id: "DolsCqcNotification" });

export const LegalChangeReviewState = z
  .enum(["awaiting_review", "reviewed", "referred", "closed"])
  .meta({ id: "LegalChangeReviewState" });

export const DolsItem = z
  .object({
    id: uuid,
    personId: uuid,
    locationId: uuid,
    type: DolsType,
    nation: z.enum(["england", "wales"]),
    requestedAt: isoDateTime,
    outcome: DolsOutcome,
    outcomeAt: isoDateTime.nullable(),
    grantedFrom: isoDateTime.nullable(),
    grantedTo: isoDateTime.nullable(),
    extensions: z.array(UrgentExtension),
    precededByUrgent: z.boolean(),
    precededByAuthorisationId: uuid.nullable(),
    withdrawalReason: z.string().nullable(),
    endedAt: isoDateTime.nullable(),
    endedReason: z.string().nullable(),
    conditions: z.string().nullable(),
    rprName: z.string().nullable(),
    rprContactId: uuid.nullable(),
    supervisoryBody: z.string().nullable(),
    supervisoryBodyReference: z.string().nullable(),
    objectionEvidence: z.string().nullable(),
    /** Where it stands now (dolsStatus; HZ-020). */
    status: DolsStatus,
    endsAt: isoDateTime.nullable(),
    daysLeft: z.number().int().nullable(),
    reminders: z.array(
      z.object({
        key: z.enum(["first", "second"]),
        daysBefore: z.number().int(),
        dueAt: isoDateTime,
      }),
    ),
    cqcNotification: DolsCqcNotification,
    legalChangeReview: LegalChangeReviewState.nullable(),
    version,
  })
  .meta({ id: "DolsItem" });
export type DolsItem = z.infer<typeof DolsItem>;

export const DolsList = z.object({ items: z.array(DolsItem) }).meta({ id: "DolsList" });
export type DolsList = z.infer<typeof DolsList>;

// ------------------------------------------------------------------------------------------------
// The June 2026 legal change: review of existing authorisations
// ------------------------------------------------------------------------------------------------

export const MultifactorialFactor = z
  .enum(["type", "duration", "effects", "manner", "prison_cell_comparison", "normality", "purpose"])
  .meta({ id: "MultifactorialFactor" });
export const ObjectionForm = z
  .enum([
    "attempts_to_leave",
    "refusing_care_or_treatment",
    "restraint_or_one_to_one_care",
    "covert_medication",
    "sedating_medication",
  ])
  .meta({ id: "ObjectionForm" });

const factorsShape = Object.fromEntries(
  MultifactorialFactor.options.map((key) => [key, text(2000).optional()]),
) as Record<z.infer<typeof MultifactorialFactor>, z.ZodOptional<z.ZodString>>;

export const LegalChangeReviewInput = z
  .object({
    factors: z.object(factorsShape).default({}),
    objection: z.enum(["objects", "does_not_object", "fluctuates", "unclear"]).nullable(),
    objectionForms: z.array(ObjectionForm).max(5).default([]),
    consent: z.object({
      consciousOfEnvironment: z.boolean().nullable(),
      basicUnderstanding: z.boolean().nullable(),
      expressesAcceptance: z.boolean().nullable(),
      seriousDoubt: z.boolean().nullable(),
    }),
    decision: z.enum(["still_deprived", "no_longer_deprived", "in_doubt"]).nullable(),
    decidedAt: isoDateTime.nullable(),
    referral: z.object({ sentAt: isoDateTime, reference: text(120).nullable() }).nullable(),
  })
  .meta({ id: "LegalChangeReviewInput" });
export type LegalChangeReviewInput = z.infer<typeof LegalChangeReviewInput>;

export const LegalChangeReviewAction = z
  .object({
    to: z.enum(["reviewed", "referred", "closed"]),
    /** What the review found; the reviewer is the person signed in. */
    review: LegalChangeReviewInput.optional(),
    reason: text(1000).optional(),
    /** 0 when no review has been started for the authorisation yet. */
    version: z.number().int().min(0),
  })
  .meta({ id: "LegalChangeReviewAction" });
export type LegalChangeReviewAction = z.infer<typeof LegalChangeReviewAction>;

export const LegalChangeReviewItem = z
  .object({
    id: uuid.nullable(),
    authorisationId: uuid,
    personId: uuid,
    locationId: uuid,
    type: DolsType,
    grantedFrom: isoDateTime.nullable(),
    endsAt: isoDateTime.nullable(),
    state: LegalChangeReviewState,
    review: LegalChangeReviewInput.nullable(),
    decidedBy: uuid.nullable(),
    /** Who decided it, by name and job title. */
    decidedByStaff: StaffName.nullable(),
    referralRequired: z.boolean(),
    prompts: z.array(z.string()),
    closedReason: z.string().nullable(),
    /** 0 until the review is started. */
    version: z.number().int().min(0),
  })
  .meta({ id: "LegalChangeReviewItem" });
export type LegalChangeReviewItem = z.infer<typeof LegalChangeReviewItem>;

export const LegalChangeReviewList = z
  .object({
    judgment: z.object({ citation: z.string(), decidedOn: isoDate, url: z.string() }),
    guidance: z.object({ title: z.string(), lastUpdatedOn: isoDate, url: z.string() }),
    /** Granted before the judgment, still in force, not yet reviewed: soonest ending first. */
    awaiting: z.array(LegalChangeReviewItem),
    /** Reviews under way or finished. */
    reviews: z.array(LegalChangeReviewItem),
  })
  .meta({ id: "LegalChangeReviewList" });
export type LegalChangeReviewList = z.infer<typeof LegalChangeReviewList>;
