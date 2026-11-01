import { z } from "zod";
import { ComplianceItemKind, RegistrationBody } from "./workforce";

/**
 * Applicant tracking (workforce.md section 2b, rules 11 to 13 and section 5; WORK-001; plan
 * slice 23). Dates are UK dates (yyyy-mm-dd). Codes mirror packages/domain
 * (`workforce/recruitment.ts`).
 */

const uuid = z.uuid();
const isoDate = z.iso.date();
const isoDateTime = z.iso.datetime({ offset: true });
/** The version the change is based on; a stale one is refused with 409. */
const version = z.number().int().min(1);
const text = (min: number, max: number) => z.string().trim().min(min).max(max);

export const PathwayCategory = z
  .enum([
    "new_to_care",
    "care_worker",
    "senior_care_worker",
    "lead_practitioner",
    "deputy_manager",
    "registered_manager",
    "registered_nurse",
  ])
  .meta({ id: "PathwayCategory", description: "Care Workforce Pathway role category" });

export const RecruitmentValue = z
  .enum(["care", "compassion", "competence", "communication", "courage", "commitment"])
  .meta({ id: "RecruitmentValue" });

export const ApplicationStage = z
  .enum([
    "applied",
    "shortlisted",
    "interviewed",
    "offered",
    "accepted",
    "rejected",
    "withdrawn",
    "declined",
  ])
  .meta({ id: "ApplicationStage" });

export const ClosingReason = z
  .enum([
    "criteria_not_met",
    "not_selected_after_interview",
    "position_filled",
    "vacancy_withdrawn",
    "applicant_withdrew",
    "offer_declined",
    "offer_withdrawn",
    "pre_employment_checks_failed",
  ])
  .meta({ id: "ClosingReason" });

export const VacancyStatus = z
  .enum(["draft", "open", "closed", "filled", "withdrawn"])
  .meta({ id: "VacancyStatus" });

export const ValuesQuestion = z
  .object({
    key: z.string().regex(/^[a-z0-9_]{1,40}$/, "A short key: lower case, digits and _"),
    value: RecruitmentValue,
    question: text(5, 500),
  })
  .meta({ id: "ValuesQuestion" });

const templateFields = {
  title: text(2, 120),
  pathwayCategory: PathwayCategory,
  registrationBody: RegistrationBody.nullable(),
  essentialCriteria: z.array(text(2, 200)).min(2).max(20),
  valuesQuestions: z
    .array(ValuesQuestion)
    .min(2)
    .max(12)
    .refine((qs) => new Set(qs.map((q) => q.key)).size === qs.length, "Each question key once"),
};

export const CreateJobTemplate = z.object(templateFields).meta({ id: "CreateJobTemplate" });
export type CreateJobTemplate = z.infer<typeof CreateJobTemplate>;

export const UpdateJobTemplate = z
  .object({ ...templateFields, archived: z.boolean(), expectedVersion: version })
  .partial({
    title: true,
    pathwayCategory: true,
    registrationBody: true,
    essentialCriteria: true,
    valuesQuestions: true,
    archived: true,
  })
  .meta({ id: "UpdateJobTemplate" });
export type UpdateJobTemplate = z.infer<typeof UpdateJobTemplate>;

export const JobTemplateItem = z
  .object({
    id: uuid,
    title: z.string(),
    pathwayCategory: PathwayCategory,
    registrationBody: RegistrationBody.nullable(),
    essentialCriteria: z.array(z.string()),
    valuesQuestions: z.array(ValuesQuestion),
    archived: z.boolean(),
    version: z.number().int(),
  })
  .meta({ id: "JobTemplateItem" });
export type JobTemplateItem = z.infer<typeof JobTemplateItem>;

export const JobTemplateList = z
  .object({ items: z.array(JobTemplateItem) })
  .meta({ id: "JobTemplateList" });

export const CreateVacancy = z
  .object({
    jobTemplateId: uuid,
    locationId: uuid.nullable(),
    title: text(2, 120),
    positions: z.number().int().min(1).max(50).default(1),
    opensOn: isoDate,
    closesOn: isoDate.nullable(),
    status: z.enum(["draft", "open"]).default("draft"),
  })
  .meta({ id: "CreateVacancy" });
export type CreateVacancy = z.infer<typeof CreateVacancy>;

export const UpdateVacancy = z
  .object({
    title: text(2, 120).optional(),
    positions: z.number().int().min(1).max(50).optional(),
    closesOn: isoDate.nullable().optional(),
    status: VacancyStatus.optional(),
    expectedVersion: version,
  })
  .meta({ id: "UpdateVacancy" });
export type UpdateVacancy = z.infer<typeof UpdateVacancy>;

export const VacancyItem = z
  .object({
    id: uuid,
    jobTemplateId: uuid,
    locationId: uuid.nullable(),
    title: z.string(),
    positions: z.number().int(),
    opensOn: isoDate,
    closesOn: isoDate.nullable(),
    status: VacancyStatus,
    /** Open applications at each stage, and how many closed. */
    counts: z.record(z.string(), z.number().int()),
    version: z.number().int(),
  })
  .meta({ id: "VacancyItem" });
export type VacancyItem = z.infer<typeof VacancyItem>;

export const VacancyList = z.object({ items: z.array(VacancyItem) }).meta({ id: "VacancyList" });

export const CreateApplication = z
  .object({
    givenName: text(1, 100),
    familyName: text(1, 100),
    /** An applicant already recorded with this email is used again (the talent pool). */
    email: z.email().max(254).nullable(),
    phone: z.string().trim().max(40).nullable(),
  })
  .meta({ id: "CreateApplication" });
export type CreateApplication = z.infer<typeof CreateApplication>;

export const ApplicationSummary = z
  .object({
    id: uuid,
    vacancyId: uuid,
    applicantId: uuid,
    applicantName: z.string().nullable(),
    stage: ApplicationStage,
    stageReason: ClosingReason.nullable(),
    closedOn: isoDate.nullable(),
    version: z.number().int(),
  })
  .meta({ id: "ApplicationSummary" });
export type ApplicationSummary = z.infer<typeof ApplicationSummary>;

export const ApplicationList = z
  .object({ items: z.array(ApplicationSummary) })
  .meta({ id: "ApplicationList" });

export const InterviewItem = z
  .object({
    id: uuid,
    heldOn: isoDate,
    panel: z.array(uuid),
    scores: z.record(z.string(), z.number().int()),
    /** The panel's total, out of the most possible: shown with the scores, never a decision. */
    total: z.number().int(),
    outOf: z.number().int(),
    notes: z.string().nullable(),
    recommendation: z.enum(["proceed", "do_not_proceed"]),
  })
  .meta({ id: "InterviewItem" });

export const OfferItem = z
  .object({
    id: uuid,
    madeOn: isoDate,
    proposedStartOn: isoDate.nullable(),
    conditions: z.array(ComplianceItemKind),
    status: z.enum(["made", "accepted", "declined", "withdrawn"]),
    respondedOn: isoDate.nullable(),
    staffProfileId: uuid.nullable(),
    version: z.number().int(),
  })
  .meta({ id: "OfferItem" });

export const ApplicationDetail = z
  .object({
    application: ApplicationSummary,
    applicant: z.object({
      id: uuid,
      givenName: z.string().nullable(),
      familyName: z.string().nullable(),
      email: z.string().nullable(),
      phone: z.string().nullable(),
      talentPoolUntil: isoDate.nullable(),
      retainUntil: isoDate.nullable(),
      redacted: z.boolean(),
      version: z.number().int(),
    }),
    shortlist: z
      .object({ criteria: z.array(z.boolean()), decidedBy: uuid, decidedAt: isoDateTime })
      .nullable(),
    history: z.array(
      z.object({
        fromStage: ApplicationStage.nullable(),
        toStage: ApplicationStage,
        reason: z.string().nullable(),
        occurredAt: isoDateTime,
      }),
    ),
    interviews: z.array(InterviewItem),
    offer: OfferItem.nullable(),
  })
  .meta({ id: "ApplicationDetail" });
export type ApplicationDetail = z.infer<typeof ApplicationDetail>;

export const ShortlistDecision = z
  .object({
    /** Each essential criterion of the template, in order: met or not. */
    criteria: z.array(z.boolean()).min(1).max(20),
    /** Shortlist, or reject (needs a reason). */
    decision: z.enum(["shortlist", "reject"]),
    reason: ClosingReason.optional(),
    expectedVersion: version,
  })
  .meta({ id: "ShortlistDecision" });

export const CloseApplication = z
  .object({
    to: z.enum(["rejected", "withdrawn"]),
    reason: ClosingReason,
    expectedVersion: version,
  })
  .meta({ id: "CloseApplication" });

export const RecordInterview = z
  .object({
    heldOn: isoDate,
    panel: z.array(uuid).min(1).max(5),
    scores: z.record(z.string(), z.number().int()),
    notes: z.string().trim().max(4000).nullable(),
    recommendation: z.enum(["proceed", "do_not_proceed"]),
    expectedVersion: version,
  })
  .meta({ id: "RecordInterview" });

export const MakeOffer = z
  .object({
    proposedStartOn: isoDate.nullable(),
    /** Has worked in health or social care before: adds conduct evidence to the conditions. */
    previousCareWork: z.boolean(),
    expectedVersion: version,
  })
  .meta({ id: "MakeOffer" });

export const RespondToOffer = z
  .discriminatedUnion("response", [
    z.object({
      response: z.literal("accepted"),
      /** The member of staff the applicant now is (invited first). */
      tenantUserId: uuid,
      expectedVersion: version,
    }),
    z.object({ response: z.literal("declined"), expectedVersion: version }),
    z.object({ response: z.literal("withdrawn"), expectedVersion: version }),
  ])
  .meta({ id: "RespondToOffer" });

export const TalentPoolConsent = z
  .object({ consent: z.boolean(), expectedVersion: version })
  .meta({ id: "TalentPoolConsent" });

export const EqualityMonitoringForm = z
  .object({
    /** Every answer optional; each question offers prefer_not_to_say. */
    answers: z.record(z.string(), z.string()),
  })
  .meta({ id: "EqualityMonitoringForm" });

const SuppressedCount = z.union([z.number().int(), z.literal("fewer_than_min")]);

export const EqualityMonitoringSummary = z
  .object({
    vacancyId: uuid,
    /** Counts below this are shown only as "fewer_than_min". */
    minimumShown: z.number().int(),
    forms: SuppressedCount,
    questions: z.array(
      z.object({
        question: z.string(),
        /** Null when fewer than the minimum answered: nothing about the question is shown. */
        counts: z.record(z.string(), SuppressedCount).nullable(),
      }),
    ),
  })
  .meta({ id: "EqualityMonitoringSummary" });
