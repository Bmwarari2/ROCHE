import { z } from "zod";
import { StaffName } from "./staff";

/**
 * The staff profile and pre-employment file (workforce.md sections 2a and 5; WORK-002,
 * WORK-011). Dates are UK dates (yyyy-mm-dd), months yyyy-mm. Details hold only what each rule
 * needs: never a DBS certificate's contents, a share code or health details.
 */

const uuid = z.uuid();
const isoDate = z.iso.date();
const yearMonth = z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/, "A month as yyyy-mm");
/** The version the change is based on; a stale one is refused with 409. */
const version = z.number().int().min(1);

export const ComplianceItemKind = z
  .enum([
    "identity_with_photo",
    "dbs_certificate",
    "conduct_in_care_work",
    "references",
    "relevant_qualifications",
    "employment_history",
    "health_fitness",
    "right_to_work",
    "professional_registration",
  ])
  .meta({ id: "ComplianceItemKind", description: "A Schedule 3 pre-employment requirement" });
export type ComplianceItemKind = z.infer<typeof ComplianceItemKind>;

export const RegistrationBody = z
  .enum(["nmc", "hcpc", "swe", "gmc"])
  .meta({ id: "RegistrationBody" });

const IdentityDetail = z.object({
  kind: z.literal("identity_with_photo"),
  document: z.enum([
    "passport",
    "photocard_driving_licence",
    "national_identity_card",
    "biometric_residence_permit",
    "other_photo_document",
  ]),
});
const DbsDetail = z.object({
  kind: z.literal("dbs_certificate"),
  certificate: z
    .object({
      level: z.enum(["enhanced_adults_barred", "enhanced", "standard", "basic"]),
      issuedOn: isoDate,
      number: z.string().regex(/^\d{12}$/, "The 12-digit certificate number"),
      result: z.enum(["clear", "information_disclosed"]),
    })
    .nullable(),
  updateService: z
    .object({
      subscribed: z.boolean(),
      lastCheckedOn: isoDate.nullable(),
      lastResult: z.enum(["no_new_information", "new_information"]).nullable(),
    })
    .nullable(),
  barredListClearOn: isoDate.nullable(),
});
const ConductDetail = z.object({
  kind: z.literal("conduct_in_care_work"),
  employersContacted: z.number().int().min(0).max(50),
});
const ReferencesDetail = z.object({
  kind: z.literal("references"),
  received: z.number().int().min(0).max(20),
});
const QualificationsDetail = z.object({
  kind: z.literal("relevant_qualifications"),
  qualifications: z.array(z.string().trim().min(2).max(160)).max(30),
});
const HistoryDetail = z.object({
  kind: z.literal("employment_history"),
  historyStart: yearMonth,
  applicationMonth: yearMonth,
  periods: z
    .array(
      z.object({
        from: yearMonth,
        to: yearMonth.nullable(),
        kind: z.enum(["employment", "education", "explained_gap"]),
        /** Required for an explained gap; plain words, kept with the HR-only file. */
        explanation: z.string().trim().min(2).max(500).optional(),
      }),
    )
    .max(80),
});
const HealthDetail = z.object({
  kind: z.literal("health_fitness"),
  declaredFit: z.boolean(),
  adjustmentsAgreed: z.boolean(),
});
const RightToWorkDetail = z.object({
  kind: z.literal("right_to_work"),
  checks: z
    .array(
      z.object({
        checkedOn: isoDate,
        method: z.enum(["manual_document", "online_share_code", "idsp"]),
        permission: z.enum(["unlimited", "time_limited"]),
        expiresOn: isoDate.nullable(),
      }),
    )
    .max(40),
});
const RegistrationDetail = z.object({
  kind: z.literal("professional_registration"),
  body: RegistrationBody,
  pin: z.string().regex(/^[0-9A-Z]{4,12}$/, "The PIN in capitals and digits"),
  renewalDueOn: isoDate,
  revalidationDueOn: isoDate.nullable(),
});

export const ComplianceDetail = z
  .discriminatedUnion("kind", [
    IdentityDetail,
    DbsDetail,
    ConductDetail,
    ReferencesDetail,
    QualificationsDetail,
    HistoryDetail,
    HealthDetail,
    RightToWorkDetail,
    RegistrationDetail,
  ])
  .meta({ id: "ComplianceDetail", description: "What a compliance item keeps, by its kind" });
export type ComplianceDetail = z.infer<typeof ComplianceDetail>;

export const ComplianceNote = z
  .object({
    code: z.enum([
      "not_verified",
      "self_verified",
      "dbs_supervised_only",
      "dbs_not_clear",
      "dbs_update_service_check_due",
      "right_to_work_none",
      "right_to_work_lapsed",
      "right_to_work_checked_late",
      "employment_gaps",
      "registration_lapsed",
      "health_not_declared_fit",
      "references_none",
    ]),
    reason: z.string().optional(),
    dueOn: isoDate.optional(),
    lapsedOn: isoDate.optional(),
    checkedOn: isoDate.optional(),
    gaps: z
      .array(z.object({ from: yearMonth, to: yearMonth, months: z.number().int() }))
      .optional(),
  })
  .meta({ id: "ComplianceNote", description: "Why an item is not satisfied, or what it must say" });

/** Where an item stands, as a word (screens add an icon; never colour alone). */
export const ComplianceStatus = z
  .enum(["satisfied", "due_soon", "expired", "missing", "not_required"])
  .meta({ id: "ComplianceStatus" });

export const ComplianceItemView = z
  .object({
    kind: ComplianceItemKind,
    required: z.boolean(),
    status: ComplianceStatus,
    id: uuid.nullable(),
    version: z.number().int().nullable(),
    detail: ComplianceDetail.nullable(),
    verifiedOn: isoDate.nullable(),
    verifiedBy: StaffName.nullable(),
    riskAssessmentSignedOn: isoDate.nullable(),
    riskAssessmentSignedBy: StaffName.nullable(),
    expiresOn: isoDate.nullable(),
    recheckDueOn: isoDate.nullable(),
    notes: z.array(ComplianceNote),
  })
  .meta({ id: "ComplianceItemView" });

export const StaffHrDocument = z
  .object({
    id: uuid,
    itemKind: ComplianceItemKind,
    title: z.string(),
    contentType: z.string(),
    sizeBytes: z.number().int(),
    createdAt: z.iso.datetime({ offset: true }),
    status: z.string(),
  })
  .meta({ id: "StaffHrDocument", description: "An HR-only document's details (not its contents)" });
export type StaffHrDocument = z.infer<typeof StaffHrDocument>;

const profileFields = {
  locationId: uuid.nullable(),
  jobTitle: z.string().trim().min(2).max(120),
  pathwayCategory: z.string().trim().min(2).max(80).nullable(),
  registrationBody: RegistrationBody.nullable(),
  previousCareWork: z.boolean(),
  dateOfBirth: isoDate.nullable(),
  startsOn: isoDate.nullable(),
  leftOn: isoDate.nullable(),
};

export const CreateStaffFile = z
  .object({ tenantUserId: uuid, ...profileFields })
  .meta({ id: "CreateStaffFile" });
export type CreateStaffFile = z.infer<typeof CreateStaffFile>;

export const UpdateStaffFile = z
  .object({ expectedVersion: version, ...profileFields })
  .meta({ id: "UpdateStaffFile" });
export type UpdateStaffFile = z.infer<typeof UpdateStaffFile>;

export const RecordComplianceItem = z
  .object({
    /** Required when the item already exists. */
    expectedVersion: version.optional(),
    detail: ComplianceDetail,
    /** Verify it now, in the caller's name, on this UK date (today or earlier); null leaves it unverified. */
    verifiedOn: isoDate.nullable(),
  })
  .meta({ id: "RecordComplianceItem" });
export type RecordComplianceItem = z.infer<typeof RecordComplianceItem>;

export const SignDbsRiskAssessment = z
  .object({ expectedVersion: version, signedOn: isoDate })
  .meta({ id: "SignDbsRiskAssessment" });
export type SignDbsRiskAssessment = z.infer<typeof SignDbsRiskAssessment>;

export const StaffFileSummary = z
  .object({
    id: uuid,
    version: z.number().int(),
    member: StaffName,
    locationId: uuid.nullable(),
    jobTitle: z.string(),
    startsOn: isoDate.nullable(),
    leftOn: isoDate.nullable(),
    complete: z.boolean(),
    outstanding: z.array(ComplianceItemKind),
    dueSoon: z.array(ComplianceItemKind),
  })
  .meta({ id: "StaffFileSummary" });
export type StaffFileSummary = z.infer<typeof StaffFileSummary>;

export const StaffFileList = z
  .object({ items: z.array(StaffFileSummary), asOf: isoDate })
  .meta({ id: "StaffFileList" });

export const StaffFileItem = z
  .object({
    id: uuid,
    version: z.number().int(),
    member: StaffName,
    ...profileFields,
    complete: z.boolean(),
    outstanding: z.array(ComplianceItemKind),
    items: z.array(ComplianceItemView),
    /** HR-only documents, listed only to holders of workforce.hr_document.read. */
    documents: z.array(StaffHrDocument).nullable(),
    asOf: isoDate,
  })
  .meta({ id: "StaffFileItem" });
export type StaffFileItem = z.infer<typeof StaffFileItem>;

// ------------------------------------------------------------------------------------------------
// Training, competence, supervision and revalidation (workforce.md sections 2b and 5; slice 17)
// ------------------------------------------------------------------------------------------------

export const TrainingTopic = z
  .enum([
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
  ])
  .meta({ id: "TrainingTopic" });

export const Competence = z
  .enum([
    "medicines_administration",
    "controlled_drugs",
    "insulin_administration",
    "epilepsy_rescue_medication",
    "moving_and_handling_hoist",
    "catheter_care",
    "enteral_feeding",
    "oxygen_therapy",
  ])
  .meta({ id: "Competence" });

const tier = z.union([z.literal(1), z.literal(2)]);
const roleKey = z.string().regex(/^[a-z][a-z0-9_]{1,63}$/, "A role's key");

export const TrainingRequirementItem = z
  .object({
    id: uuid,
    version: z.number().int(),
    roleKey,
    topic: TrainingTopic,
    refreshYears: z.number().int().nullable(),
    tier: tier.nullable(),
    active: z.boolean(),
  })
  .meta({ id: "TrainingRequirementItem" });
export type TrainingRequirementItem = z.infer<typeof TrainingRequirementItem>;

export const TrainingRequirementList = z
  .object({ items: z.array(TrainingRequirementItem) })
  .meta({ id: "TrainingRequirementList" });

export const PutTrainingRequirement = z
  .object({
    expectedVersion: version.optional(),
    roleKey,
    topic: TrainingTopic,
    refreshYears: z.number().int().min(1).max(10).nullable(),
    tier: tier.nullable(),
    active: z.boolean(),
  })
  .meta({ id: "PutTrainingRequirement" });
export type PutTrainingRequirement = z.infer<typeof PutTrainingRequirement>;

const trainingFields = {
  topic: TrainingTopic,
  tier: tier.nullable(),
  completedOn: isoDate,
  expiresOn: isoDate.nullable(),
  provider: z.string().trim().min(2).max(160).nullable(),
};

export const CreateTrainingRecord = z.object(trainingFields).meta({ id: "CreateTrainingRecord" });
export type CreateTrainingRecord = z.infer<typeof CreateTrainingRecord>;

export const UpdateTrainingRecord = z
  .object({ expectedVersion: version, ...trainingFields })
  .meta({ id: "UpdateTrainingRecord" });
export type UpdateTrainingRecord = z.infer<typeof UpdateTrainingRecord>;

export const TrainingRecordItem = z
  .object({ id: uuid, version: z.number().int(), ...trainingFields })
  .meta({ id: "TrainingRecordItem" });

export const TrainingMatrixRow = z
  .object({
    topic: TrainingTopic,
    tier: tier.nullable(),
    /** As a word; screens add an icon (never colour alone). */
    status: z.enum(["valid", "due_soon", "expired", "missing"]),
    validUntil: isoDate.nullable(),
  })
  .meta({ id: "TrainingMatrixRow" });

export const CreateCompetenceSignOff = z
  .object({ competence: Competence, observedOn: isoDate })
  .meta({ id: "CreateCompetenceSignOff" });
export type CreateCompetenceSignOff = z.infer<typeof CreateCompetenceSignOff>;

export const WithdrawCompetenceSignOff = z
  .object({ reason: z.string().trim().min(10).max(500) })
  .meta({ id: "WithdrawCompetenceSignOff" });

export const CompetenceSignOffItem = z
  .object({
    id: uuid,
    competence: Competence,
    observedOn: isoDate,
    observer: StaffName.nullable(),
    validUntil: isoDate,
    withdrawn: z.object({ on: isoDate, by: StaffName.nullable(), reason: z.string() }).nullable(),
  })
  .meta({ id: "CompetenceSignOffItem" });

export const CompetenceStateItem = z
  .object({
    competence: Competence,
    allowed: z.boolean(),
    reason: z.enum(["missing", "expired", "withdrawn"]).nullable(),
    validUntil: isoDate.nullable(),
  })
  .meta({ id: "CompetenceStateItem" });

export const SupervisionKind = z
  .enum(["supervision", "appraisal", "spot_check"])
  .meta({ id: "SupervisionKind" });

export const CreateSupervisionRecord = z
  .object({ kind: SupervisionKind, heldOn: isoDate })
  .meta({ id: "CreateSupervisionRecord" });
export type CreateSupervisionRecord = z.infer<typeof CreateSupervisionRecord>;

export const SupervisionRecordItem = z
  .object({
    id: uuid,
    kind: SupervisionKind,
    heldOn: isoDate,
    heldBy: StaffName.nullable(),
  })
  .meta({ id: "SupervisionRecordItem" });

export const NextMeetingItem = z
  .object({
    kind: z.enum(["supervision", "appraisal"]),
    dueOn: isoDate,
    state: z.enum(["upcoming", "due", "overdue"]),
  })
  .meta({ id: "NextMeetingItem" });

const revalidationFields = {
  cycleDueOn: isoDate,
  practiceHours: z.number().int().min(0).max(10000),
  cpdHours: z.number().int().min(0).max(1000),
  participatoryCpdHours: z.number().int().min(0).max(1000),
  feedbackPieces: z.number().int().min(0).max(100),
  reflectiveAccounts: z.number().int().min(0).max(100),
  reflectiveDiscussion: z.boolean(),
  healthAndCharacter: z.boolean(),
  professionalIndemnity: z.boolean(),
  confirmation: z.boolean(),
};

export const PutRevalidationEvidence = z
  .object({ expectedVersion: version.optional(), ...revalidationFields })
  .meta({ id: "PutRevalidationEvidence" });
export type PutRevalidationEvidence = z.infer<typeof PutRevalidationEvidence>;

export const RevalidationView = z
  .object({
    id: uuid,
    version: z.number().int(),
    ...revalidationFields,
    daysLeft: z.number().int(),
    outstanding: z.array(z.string()),
    ready: z.boolean(),
  })
  .meta({ id: "RevalidationView" });

export const DevelopmentRecord = z
  .object({
    member: StaffName,
    asOf: isoDate,
    matrix: z.array(TrainingMatrixRow),
    trainingRecords: z.array(TrainingRecordItem),
    competences: z.array(CompetenceStateItem),
    signOffs: z.array(CompetenceSignOffItem),
    supervisions: z.array(SupervisionRecordItem),
    /** Null until the member's start date is known to the organisation. */
    nextSupervision: NextMeetingItem.nullable(),
    nextAppraisal: NextMeetingItem.nullable(),
    /** The latest cycle's plan, or null when none is recorded. */
    revalidation: RevalidationView.nullable(),
  })
  .meta({ id: "DevelopmentRecord" });
export type DevelopmentRecord = z.infer<typeof DevelopmentRecord>;
