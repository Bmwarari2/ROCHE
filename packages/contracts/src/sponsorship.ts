import { z } from "zod";
import { StaffName } from "./staff";

/**
 * Sponsored workers, staff data protection and LDSS claims (workforce.md section 12; slice 35;
 * WORK-003, WORK-007, WORK-011). Dates are UK dates (yyyy-mm-dd). Sponsor records hold only what
 * the sponsor duties need: never a passport number, a share code or a visa's contents.
 */

const uuid = z.uuid();
const isoDate = z.iso.date();
/** The version the change is based on; a stale one is refused with 409. */
const version = z.number().int().min(1);

export const SponsorRoute = z
  .enum(["skilled_worker", "health_and_care_worker", "other"])
  .meta({ id: "SponsorRoute" });
export const EnglishEvidence = z
  .enum([
    "not_recorded",
    "majority_english_speaking_country",
    "degree_taught_in_english",
    "secure_english_language_test",
    "previous_grant",
  ])
  .meta({ id: "EnglishEvidence" });
export const AppendixDItem = z
  .enum([
    "passport_or_travel_document",
    "right_to_work_check",
    "contact_details",
    "certificate_of_sponsorship",
    "recruitment_evidence",
    "english_language_evidence",
    "registration_or_qualification",
    "absence_records",
  ])
  .meta({ id: "AppendixDItem" });
export const SponsorReportKind = z
  .enum([
    "did_not_start",
    "unauthorised_absence",
    "employment_ended",
    "change_of_job",
    "change_of_salary",
    "change_of_work_location",
    "change_of_hours",
    "other",
  ])
  .meta({ id: "SponsorReportKind" });

const sponsorFields = {
  cosReference: z
    .string()
    .trim()
    .regex(/^[A-Z0-9]{6,20}$/, "Letters and numbers as on the certificate"),
  cosAssignedOn: isoDate,
  socCode: z.string().regex(/^\d{4}$/, "A four-digit SOC 2020 code"),
  route: SponsorRoute,
  visaExpiresOn: isoDate,
  /** Hours a week, up to two decimal places. */
  contractedWeeklyHours: z.number().min(0.01).max(168),
  /** Guaranteed basic gross pay a year, in pounds. */
  guaranteedYearlyPay: z.number().min(0).max(10_000_000),
  englishEvidence: EnglishEvidence,
  switchingEvidenceOn: isoDate.nullable(),
  appendixDHeld: z.array(AppendixDItem).max(8),
};

export const CreateSponsoredWorker = z
  .object({ tenantUserId: uuid, ...sponsorFields })
  .meta({ id: "CreateSponsoredWorker" });
export type CreateSponsoredWorker = z.infer<typeof CreateSponsoredWorker>;

export const UpdateSponsoredWorker = z
  .object({ expectedVersion: version, ...sponsorFields, endedOn: isoDate.nullable() })
  .meta({ id: "UpdateSponsoredWorker" });
export type UpdateSponsoredWorker = z.infer<typeof UpdateSponsoredWorker>;

export const SponsorReport = z
  .object({
    id: uuid,
    version: z.number().int(),
    kind: SponsorReportKind,
    happenedOn: isoDate,
    reportedOn: isoDate.nullable(),
    smsReference: z.string().nullable(),
    dueOn: isoDate,
    state: z.enum(["reported", "reported_late", "open", "overdue"]),
  })
  .meta({ id: "SponsorReport" });

export const SponsorAbsence = z
  .object({ id: uuid, fromOn: isoDate, toOn: isoDate, authorised: z.boolean() })
  .meta({ id: "SponsorAbsence" });

export const SponsoredWorker = z
  .object({
    id: uuid,
    version: z.number().int(),
    tenantUserId: uuid,
    member: StaffName,
    ...sponsorFields,
    status: z.enum(["active", "ended"]),
    endedOn: isoDate.nullable(),
    visa: z.enum(["valid", "due_soon", "expired"]),
    salary: z.object({
      passes: z.boolean(),
      meetsYearly: z.boolean(),
      meetsHourly: z.boolean(),
      hourlyPay: z.number(),
      countedWeeklyHours: z.number(),
    }),
    appendixDGaps: z.array(AppendixDItem),
    /** Unauthorised absence past the limit with no unauthorised-absence report recorded for it. */
    absenceToReport: z.object({ happenedOn: isoDate, dueOn: isoDate }).nullable(),
    absences: z.array(SponsorAbsence),
    reports: z.array(SponsorReport),
    asOf: isoDate,
  })
  .meta({ id: "SponsoredWorker" });
export type SponsoredWorker = z.infer<typeof SponsoredWorker>;

export const SponsoredWorkerList = z
  .object({ items: z.array(SponsoredWorker), asOf: isoDate })
  .meta({ id: "SponsoredWorkerList" });

export const RecordSponsorAbsence = z
  .object({ fromOn: isoDate, toOn: isoDate, authorised: z.boolean() })
  .refine((v) => v.toOn >= v.fromOn, { message: "The last day cannot be before the first." })
  .meta({ id: "RecordSponsorAbsence" });

export const RecordSponsorReport = z
  .object({ kind: SponsorReportKind, happenedOn: isoDate })
  .meta({ id: "RecordSponsorReport" });

export const MarkSponsorReportReported = z
  .object({
    expectedVersion: version,
    reportedOn: isoDate,
    smsReference: z.string().trim().min(1).max(40),
  })
  .meta({ id: "MarkSponsorReportReported" });

// Staff privacy notice and image consent

export const ImagePurpose = z
  .enum(["newsletter", "website", "social_media", "family_feed"])
  .meta({ id: "ImagePurpose" });

export const SetStaffPrivacyNotice = z
  .object({ version: z.string().trim().min(1).max(40) })
  .meta({ id: "SetStaffPrivacyNotice" });

export const AcknowledgeStaffPrivacyNotice = z
  .object({ noticeVersion: z.string().trim().min(1).max(40) })
  .meta({ id: "AcknowledgeStaffPrivacyNotice" });

export const DecideStaffImageConsent = z
  .object({ purpose: ImagePurpose, decision: z.enum(["given", "refused", "withdrawn"]) })
  .meta({ id: "DecideStaffImageConsent" });

export const StaffPrivacy = z
  .object({
    tenantUserId: uuid,
    currentNoticeVersion: z.string().nullable(),
    acknowledged: z.boolean(),
    acknowledgedVersions: z.array(z.string()),
    imageConsent: z.array(
      z.object({
        purpose: ImagePurpose,
        decision: z.enum(["given", "refused", "withdrawn", "none"]),
        mayUse: z.boolean(),
      }),
    ),
  })
  .meta({ id: "StaffPrivacy" });
export type StaffPrivacy = z.infer<typeof StaffPrivacy>;

// LDSS claims

export const LdssStatus = z
  .enum(["planned", "submitted", "paid", "rejected", "withdrawn"])
  .meta({ id: "LdssStatus" });

export const CreateLdssClaim = z
  .object({
    tenantUserId: uuid,
    courseTitle: z.string().trim().min(2).max(200),
    completedOn: isoDate.nullable(),
    /** As the claim states it, in pounds; Harbour holds no LDSS funding figure. */
    claimedAmount: z.number().min(0).max(100_000).nullable(),
  })
  .meta({ id: "CreateLdssClaim" });

export const ChangeLdssClaimStatus = z
  .object({
    expectedVersion: version,
    status: LdssStatus,
    reference: z.string().trim().min(1).max(60).nullable(),
    on: isoDate.nullable(),
    reason: z.string().trim().min(1).max(500).nullable(),
  })
  .meta({ id: "ChangeLdssClaimStatus" });

export const LdssClaim = z
  .object({
    id: uuid,
    version: z.number().int(),
    tenantUserId: uuid,
    member: StaffName,
    courseTitle: z.string(),
    completedOn: isoDate.nullable(),
    claimedAmount: z.number().nullable(),
    status: LdssStatus,
    reference: z.string().nullable(),
    submittedOn: isoDate.nullable(),
    paidOn: isoDate.nullable(),
    reason: z.string().nullable(),
  })
  .meta({ id: "LdssClaim" });

export const LdssClaimList = z.object({ items: z.array(LdssClaim) }).meta({ id: "LdssClaimList" });
