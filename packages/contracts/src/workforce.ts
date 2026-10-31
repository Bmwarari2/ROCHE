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

export const StaffMemberList = z.object({ items: z.array(StaffName) }).meta({
  id: "StaffMemberList",
  description: "The organisation's staff, by name and job title, to choose from on HR forms",
});
export type StaffMemberList = z.infer<typeof StaffMemberList>;
