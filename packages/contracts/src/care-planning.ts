import { z } from "zod";
import { entryInput, entryOutput } from "./entries";
import { Recurrence } from "./tasks";

/**
 * Care planning contracts (master prompt 10.1, docs/specs/care.md slice 4b): the personalised care
 * and support plan, positive risk assessments, stored results of the validated tools, activities,
 * the Regulation 9A visiting log and advance care records. Enumerations mirror packages/domain;
 * the API tests keep them in step. Numbers use inclusive bounds only (the breaking-change check
 * cannot read exclusive ones).
 */

const uuid = z.uuid();
const isoDateTime = z.iso.datetime({ offset: true });
const isoDate = z.iso.date();
const version = z.number().int().min(1);
const text = (max: number) => z.string().trim().max(max);
const roleKey = z.string().regex(/^[a-z_]{2,40}$/);

// ------------------------------------------------------------------------------------------------
// Care plans
// ------------------------------------------------------------------------------------------------

export const PcspDomain = z
  .enum([
    "mobility",
    "skin",
    "nutrition_and_hydration",
    "continence",
    "communication",
    "cognition",
    "mood",
    "behaviour",
    "sleep",
    "pain",
    "breathing",
    "medicines",
    "personal_care",
    "social_and_spiritual",
    "sexuality_and_relationships",
    "end_of_life",
  ])
  .meta({ id: "PcspDomain", description: "The 16 need domains of the care and support plan" });
export type PcspDomain = z.infer<typeof PcspDomain>;

export const CarePlanStatus = z
  .enum(["draft", "active", "superseded"])
  .meta({ id: "CarePlanStatus" });

export const SignOffAuthority = z
  .enum(["lpa_health_welfare", "deputy", "imca", "advocate", "next_of_kin", "other"])
  .meta({ id: "SignOffAuthority" });

export const CarePlanSignOff = z
  .object({
    agreedBy: z.enum(["person", "representative", "unable"]),
    representativeName: z.string().nullable(),
    authority: SignOffAuthority.nullable(),
    contactId: uuid.nullable(),
    unableReason: z.string().nullable(),
    signedOffAt: isoDateTime,
    recordedBy: uuid.nullable(),
  })
  .meta({ id: "CarePlanSignOff" });
export type CarePlanSignOff = z.infer<typeof CarePlanSignOff>;

export const CarePlanSummary = z
  .object({
    id: uuid,
    personId: uuid,
    locationId: uuid,
    status: CarePlanStatus,
    publishedVersion: z.number().int().nullable(),
    basedOnPlanId: uuid.nullable(),
    summary: z.string().nullable(),
    reviewDueOn: isoDate.nullable(),
    reviewReason: z.string().nullable(),
    publishedAt: isoDateTime.nullable(),
    publishedBy: uuid.nullable(),
    supersededAt: isoDateTime.nullable(),
    signOff: CarePlanSignOff.nullable(),
    version: z.number().int(),
  })
  .meta({ id: "CarePlanSummary" });
export type CarePlanSummary = z.infer<typeof CarePlanSummary>;

export const CarePlanDue = z
  .object({
    kind: z.enum(["first_plan", "review"]),
    /** Null when no first-plan deadline applies (no admission date or no figure for the nation). */
    dueOn: isoDate.nullable(),
    overdue: z.boolean(),
  })
  .meta({ id: "CarePlanDue", description: "What is due next: the first plan, then its review" });
export type CarePlanDue = z.infer<typeof CarePlanDue>;

export const CarePlanList = z
  .object({
    items: z.array(CarePlanSummary),
    /** Null for people whose record is closed. */
    due: CarePlanDue.nullable(),
  })
  .meta({ id: "CarePlanList" });
export type CarePlanList = z.infer<typeof CarePlanList>;

export const CarePlanActionItem = z
  .object({
    id: uuid,
    sectionId: uuid,
    action: z.string(),
    roleKey: z.string().nullable(),
    recurrence: Recurrence.nullable(),
    whenText: z.string().nullable(),
    generatesTasks: z.boolean(),
    evidenceRequired: z.boolean(),
    riskAssessmentId: uuid.nullable(),
    taskSeriesId: uuid.nullable(),
    version: z.number().int(),
  })
  .meta({ id: "CarePlanActionItem" });
export type CarePlanActionItem = z.infer<typeof CarePlanActionItem>;

export const CarePlanSectionItem = z
  .object({
    id: uuid,
    domain: PcspDomain,
    need: z.string().nullable(),
    outcome: z.string().nullable().meta({ description: "The outcome in the person's words" }),
    strengths: z.string().nullable(),
    contingency: z.string().nullable(),
    actions: z.array(CarePlanActionItem),
    version: z.number().int(),
  })
  .meta({ id: "CarePlanSectionItem" });
export type CarePlanSectionItem = z.infer<typeof CarePlanSectionItem>;

export const CarePlanDetail = CarePlanSummary.extend({
  sections: z.array(CarePlanSectionItem),
}).meta({ id: "CarePlanDetail" });
export type CarePlanDetail = z.infer<typeof CarePlanDetail>;

export const CreateCarePlan = z
  .object({
    /** Start the draft from the active plan's sections and actions (the usual way to revise). */
    copyFromActive: z.boolean().default(true),
    summary: text(2000).optional(),
  })
  .meta({ id: "CreateCarePlan" });
export type CreateCarePlan = z.infer<typeof CreateCarePlan>;

export const UpdateCarePlanSection = z
  .object({
    need: text(4000).nullable().optional(),
    outcome: text(4000).nullable().optional(),
    strengths: text(4000).nullable().optional(),
    contingency: text(4000).nullable().optional(),
    /** The version read; 0 when the section does not exist yet. */
    version: z.number().int().min(0),
  })
  .meta({ id: "UpdateCarePlanSection" });
export type UpdateCarePlanSection = z.infer<typeof UpdateCarePlanSection>;

export const CreateCarePlanAction = z
  .object({
    action: z.string().trim().min(3).max(1000),
    roleKey: roleKey.optional(),
    recurrence: Recurrence.optional(),
    whenText: text(200).optional(),
    generatesTasks: z.boolean().default(false),
    evidenceRequired: z.boolean().default(false),
    riskAssessmentId: uuid.optional(),
  })
  .meta({ id: "CreateCarePlanAction" });
export type CreateCarePlanAction = z.infer<typeof CreateCarePlanAction>;

export const UpdateCarePlanAction = z
  .object({
    action: z.string().trim().min(3).max(1000).optional(),
    roleKey: roleKey.nullable().optional(),
    recurrence: Recurrence.nullable().optional(),
    whenText: text(200).nullable().optional(),
    generatesTasks: z.boolean().optional(),
    evidenceRequired: z.boolean().optional(),
    riskAssessmentId: uuid.nullable().optional(),
    /** Removes the action from the draft. */
    removed: z.boolean().optional(),
    version,
  })
  .meta({ id: "UpdateCarePlanAction" });
export type UpdateCarePlanAction = z.infer<typeof UpdateCarePlanAction>;

export const PublishCarePlan = z
  .object({
    version,
    /** An earlier review than the review interval, when the clinician asks for one. */
    reviewDueOn: isoDate.optional(),
  })
  .meta({ id: "PublishCarePlan" });
export type PublishCarePlan = z.infer<typeof PublishCarePlan>;

export const SignOffCarePlan = z
  .object({
    agreedBy: z.enum(["person", "representative", "unable"]),
    representativeName: text(200).optional(),
    authority: SignOffAuthority.optional(),
    /** The representative from the person's contacts, when they are recorded there. */
    contactId: uuid.optional(),
    unableReason: text(1000).optional(),
    version,
  })
  .meta({ id: "SignOffCarePlan" });
export type SignOffCarePlan = z.infer<typeof SignOffCarePlan>;

// ------------------------------------------------------------------------------------------------
// Risk assessments
// ------------------------------------------------------------------------------------------------

export const RiskTemplateKey = z
  .enum([
    "moving_and_handling",
    "falls",
    "choking",
    "skin",
    "bed_rails",
    "smoking",
    "going_out_alone",
    "financial",
    "environmental",
    "self_harm_and_suicide",
    "sexual_safety",
    "fire_setting",
    "absconding",
    "substance_and_alcohol_use",
    "general",
  ])
  .meta({ id: "RiskTemplateKey" });
export type RiskTemplateKey = z.infer<typeof RiskTemplateKey>;

export const RiskBand = z.enum(["low", "moderate", "high", "extreme"]).meta({ id: "RiskBand" });

export const RiskQuestion = z
  .object({
    key: z.string(),
    text: z.string(),
    kind: z.enum(["yes_no", "text", "measurement_mm"]),
    /** Measurements: the figure from the rate table and how the answer is compared with it. */
    limit: z
      .object({
        rateKey: z.string(),
        valueMm: z.number(),
        rule: z.enum(["under", "at_least"]),
        whenYes: z
          .object({ questionKey: z.string(), rateKey: z.string(), valueMm: z.number() })
          .nullable(),
      })
      .nullable(),
  })
  .meta({ id: "RiskQuestion" });

export const RiskTemplate = z
  .object({
    key: RiskTemplateKey,
    title: z.string(),
    version: z.string(),
    source: z.string(),
    /** False for falls, which is never rated (NICE NG249 1.1.1). */
    rated: z.boolean(),
    questions: z.array(RiskQuestion),
    suggestedControls: z.array(z.string()),
  })
  .meta({ id: "RiskTemplate" });

export const RiskTemplateList = z
  .object({
    items: z.array(RiskTemplate),
    matrix: z.object({
      source: z.string(),
      likelihood: z.array(z.string()),
      severity: z.array(z.string()),
    }),
  })
  .meta({ id: "RiskTemplateList" });
export type RiskTemplateList = z.infer<typeof RiskTemplateList>;

const scale = z.number().int().min(1).max(5).nullable().default(null);

const riskAssessmentFields = {
  hazard: z.string().trim().min(3).max(500),
  whoAtRisk: z.string().trim().min(2).max(300),
  answers: z
    .record(
      z.string().regex(/^[a-z_]{2,60}$/),
      z.union([z.boolean(), z.number(), z.string().max(1000), z.null()]),
    )
    .default({}),
  likelihood: scale,
  severity: scale,
  residualLikelihood: scale,
  residualSeverity: scale,
  controls: z.array(z.string().trim().min(2).max(300)).max(30),
  positiveRiskStatement: text(2000).nullable().default(null),
  personViews: text(2000).nullable().default(null),
  assessedOn: isoDate,
  /** Defaults to the care plan review interval; never later than it. */
  reviewDueOn: isoDate.optional(),
};

export const CreateRiskAssessment = z
  .object({ templateKey: RiskTemplateKey, ...riskAssessmentFields })
  .meta({ id: "CreateRiskAssessment" });
export type CreateRiskAssessment = z.infer<typeof CreateRiskAssessment>;

export const UpdateRiskAssessment = z.object({ ...riskAssessmentFields, version }).meta({
  id: "UpdateRiskAssessment",
  description: "A review: the whole assessment as it now stands",
});
export type UpdateRiskAssessment = z.infer<typeof UpdateRiskAssessment>;

export const CloseRiskAssessment = z
  .object({ reason: z.string().trim().min(3).max(500), version })
  .meta({ id: "CloseRiskAssessment" });
export type CloseRiskAssessment = z.infer<typeof CloseRiskAssessment>;

export const RiskFinding = z
  .object({
    questionKey: z.string(),
    valueMm: z.number(),
    rateKey: z.string(),
    limitMm: z.number(),
    rule: z.enum(["under", "at_least"]),
    withinLimit: z.boolean(),
  })
  .meta({ id: "RiskFinding" });

export const RiskAssessmentItem = z
  .object({
    id: uuid,
    personId: uuid,
    templateKey: RiskTemplateKey,
    templateVersion: z.string(),
    hazard: z.string(),
    whoAtRisk: z.string(),
    answers: z.record(z.string(), z.unknown()),
    findings: z.array(RiskFinding),
    /** A measurement is outside the MHRA figure from the rate table. */
    outsideLimits: z.boolean(),
    likelihood: z.number().int().nullable(),
    severity: z.number().int().nullable(),
    riskRating: z.number().int().nullable(),
    riskBand: RiskBand.nullable(),
    residualLikelihood: z.number().int().nullable(),
    residualSeverity: z.number().int().nullable(),
    residualRating: z.number().int().nullable(),
    residualBand: RiskBand.nullable(),
    controls: z.array(z.string()),
    positiveRiskStatement: z.string().nullable(),
    personViews: z.string().nullable(),
    assessedOn: isoDate,
    reviewDueOn: isoDate,
    status: z.enum(["active", "closed"]),
    closedReason: z.string().nullable(),
    version: z.number().int(),
  })
  .meta({ id: "RiskAssessmentItem" });
export type RiskAssessmentItem = z.infer<typeof RiskAssessmentItem>;

export const RiskAssessmentList = z
  .object({ items: z.array(RiskAssessmentItem) })
  .meta({ id: "RiskAssessmentList" });
export type RiskAssessmentList = z.infer<typeof RiskAssessmentList>;

// ------------------------------------------------------------------------------------------------
// Stored results of the validated tools
// ------------------------------------------------------------------------------------------------

export const AssessmentToolKey = z
  .enum(["must", "waterlow", "braden", "ng249_falls"])
  .meta({ id: "AssessmentToolKey" });
export type AssessmentToolKey = z.infer<typeof AssessmentToolKey>;

const kg = z.number().min(0).max(1000);
const metres = z.number().min(0).max(5);

export const MustAnswers = z
  .object({
    bmi: z.discriminatedUnion("kind", [
      z.object({
        kind: z.literal("calculated"),
        weightKg: kg,
        heightM: metres,
        weightMethod: z.enum(["measured", "documented_or_reported"]),
        heightMethod: z.enum([
          "measured",
          "documented_or_reported",
          "ulna_length",
          "knee_height",
          "demispan",
        ]),
      }),
      z.object({
        kind: z.literal("assessor_category"),
        category: z.enum(["over_20", "18_5_to_20", "under_18_5"]),
        method: z.enum(["mid_upper_arm_circumference", "subjective_criteria"]),
      }),
    ]),
    weightLoss: z.discriminatedUnion("kind", [
      z.object({ kind: z.literal("calculated"), previousWeightKg: kg, currentWeightKg: kg }),
      z.object({
        kind: z.literal("assessor_category"),
        category: z.enum(["under_5", "5_to_10", "over_10"]),
        method: z.enum(["reported_weight_loss", "subjective_criteria"]),
      }),
    ]),
    acuteDiseaseEffect: z.boolean(),
  })
  .meta({ id: "MustAnswers", description: "BAPEN 'MUST' steps 1 to 3" });

export const WaterlowAnswers = z
  .object({
    build: z.discriminatedUnion("kind", [
      z.object({ kind: z.literal("calculated"), weightKg: kg, heightM: metres }),
      z.object({
        kind: z.literal("assessor_category"),
        category: z.enum(["average", "above_average", "obese", "below_average"]),
      }),
    ]),
    skin: z
      .array(
        z.enum([
          "healthy",
          "tissue_paper",
          "dry",
          "oedematous",
          "clammy_or_pyrexia",
          "discoloured_grade_1",
          "broken_or_spots_grade_2_to_4",
        ]),
      )
      .max(7),
    sex: z.enum(["male", "female"]),
    ageYears: z.number().int().min(0).max(130),
    malnutrition: z.object({
      recentWeightLoss: z.enum(["yes", "no", "unsure"]),
      weightLossAmount: z
        .enum(["0.5_to_5_kg", "5_to_10_kg", "10_to_15_kg", "over_15_kg", "unsure"])
        .nullable()
        .optional(),
      eatingPoorlyOrLackOfAppetite: z.boolean(),
    }),
    continence: z.enum([
      "complete_or_catheterised",
      "urinary_incontinence",
      "faecal_incontinence",
      "urinary_and_faecal_incontinence",
    ]),
    mobility: z.enum([
      "fully",
      "restless_or_fidgety",
      "apathetic",
      "restricted",
      "bedbound",
      "chairbound",
    ]),
    tissueMalnutrition: z
      .array(
        z.enum([
          "terminal_cachexia",
          "multiple_organ_failure",
          "single_organ_failure",
          "peripheral_vascular_disease",
          "anaemia",
          "smoking",
        ]),
      )
      .max(6),
    neurologicalDeficit: z
      .array(
        z.object({
          condition: z.enum(["diabetes_ms_or_cva", "motor_or_sensory", "paraplegia"]),
          points: z.number().int().min(0).max(10),
        }),
      )
      .max(3),
    majorSurgeryOrTrauma: z.object({
      orthopaedicOrSpinal: z.boolean(),
      timeOnTable: z.enum(["not_applicable", "over_2_hours", "over_6_hours"]),
    }),
    medication: z
      .array(z.enum(["cytotoxics", "long_term_or_high_dose_steroids", "anti_inflammatory"]))
      .max(3),
  })
  .meta({ id: "WaterlowAnswers", description: "Waterlow score card (2005 revision)" });

const bradenScore = z.number().int().min(0).max(10);
export const BradenAnswers = z
  .object({
    sensoryPerception: bradenScore,
    moisture: bradenScore,
    activity: bradenScore,
    mobility: bradenScore,
    nutrition: bradenScore,
    frictionAndShear: bradenScore,
  })
  .meta({ id: "BradenAnswers", description: "Braden Scale subscale scores" });

export const FallsAnswers = z
  .discriminatedUnion("setting", [
    z.object({
      setting: z.literal("residential"),
      occasion: z.enum(["admission", "review", "after_fall"]),
      fallenInLastYear: z.boolean().nullable().optional(),
      presentingAfterFall: z.boolean().nullable().optional(),
    }),
    z.object({
      setting: z.literal("community"),
      fallenInLastYear: z.boolean().nullable().optional(),
      presentingAfterFall: z.boolean().nullable().optional(),
      criteria: z
        .object({
          livingWithFrailty: z.boolean().nullable().optional(),
          injuredAndNeededMedicalTreatment: z.boolean().nullable().optional(),
          lostConsciousness: z.boolean().nullable().optional(),
          unableToGetUpIndependently: z.boolean().nullable().optional(),
          twoOrMoreFallsInLastYear: z.boolean().nullable().optional(),
        })
        .nullable()
        .optional(),
    }),
  ])
  .meta({ id: "FallsAnswers", description: "NICE NG249 falls questions (no score)" });

export const CreateAssessment = z
  .discriminatedUnion("toolKey", [
    z.object({ ...entryInput, toolKey: z.literal("must"), answers: MustAnswers }),
    z.object({ ...entryInput, toolKey: z.literal("waterlow"), answers: WaterlowAnswers }),
    z.object({ ...entryInput, toolKey: z.literal("braden"), answers: BradenAnswers }),
    z.object({ ...entryInput, toolKey: z.literal("ng249_falls"), answers: FallsAnswers }),
  ])
  .meta({
    id: "CreateAssessment",
    description:
      "Answers to a locked validated tool; the server calculates and stores the result. A correction names the result it supersedes and why.",
  });
export type CreateAssessment = z.infer<typeof CreateAssessment>;

export const ScoreWorking = z
  .object({ item: z.string(), value: z.string(), points: z.number() })
  .meta({ id: "ScoreWorking" });

export const AssessmentItem = z
  .object({
    ...entryOutput,
    toolKey: AssessmentToolKey,
    toolVersion: z.string(),
    answers: z.record(z.string(), z.unknown()),
    /** Null for the NG249 falls pathway, which never scores. */
    score: z.number().int().nullable(),
    band: z.string().nullable(),
    workings: z.array(ScoreWorking),
    /** The follow-ups the result raised (tasks, alerts, the next screening). */
    triggers: z.array(z.record(z.string(), z.unknown())),
    details: z.record(z.string(), z.unknown()),
    nextDueOn: isoDate.nullable(),
  })
  .meta({ id: "AssessmentItem" });
export type AssessmentItem = z.infer<typeof AssessmentItem>;

export const AssessmentList = z
  .object({ items: z.array(AssessmentItem) })
  .meta({ id: "AssessmentList" });
export type AssessmentList = z.infer<typeof AssessmentList>;

// ------------------------------------------------------------------------------------------------
// Activities and visits
// ------------------------------------------------------------------------------------------------

export const ActivityAttendance = z
  .enum(["attended", "partly_attended", "declined", "not_able"])
  .meta({ id: "ActivityAttendance" });
export const ActivityEngagement = z
  .enum(["engaged_throughout", "engaged_some_of_the_time", "engaged_briefly", "did_not_engage"])
  .meta({ id: "ActivityEngagement" });

export const CreateActivityRecord = z
  .object({
    ...entryInput,
    activity: z.string().trim().min(2).max(120),
    format: z.enum(["group", "one_to_one"]),
    /** Shared by every person's record of the same group session. */
    groupSessionId: uuid.optional(),
    attendance: ActivityAttendance,
    engagement: ActivityEngagement.optional(),
    durationMinutes: z.number().int().min(1).max(720).optional(),
    notes: text(2000).optional(),
  })
  .meta({ id: "CreateActivityRecord" });
export type CreateActivityRecord = z.infer<typeof CreateActivityRecord>;

export const ActivityRecordItem = z
  .object({
    ...entryOutput,
    activity: z.string(),
    format: z.enum(["group", "one_to_one"]),
    groupSessionId: uuid.nullable(),
    attendance: ActivityAttendance,
    engagement: ActivityEngagement.nullable(),
    durationMinutes: z.number().int().nullable(),
    notes: z.string().nullable(),
  })
  .meta({ id: "ActivityRecordItem" });
export type ActivityRecordItem = z.infer<typeof ActivityRecordItem>;

export const ActivityRecordList = z
  .object({ items: z.array(ActivityRecordItem) })
  .meta({ id: "ActivityRecordList" });
export type ActivityRecordList = z.infer<typeof ActivityRecordList>;

export const VisitKind = z
  .enum(["facilitated_visit", "visit_out", "accompaniment"])
  .meta({ id: "VisitKind", description: "Regulation 9A: visiting, visits out and accompaniment" });

export const CreateVisit = z
  .object({
    ...entryInput,
    /** `occurredAt` is when the visit started. */
    kind: VisitKind,
    contactId: uuid.optional(),
    visitorName: text(200).optional(),
    visitorRelationship: text(120).optional(),
    endedAt: isoDateTime.optional(),
    restrictionsApplied: z.boolean().default(false),
    restrictionReason: text(1000).optional(),
    notes: text(2000).optional(),
  })
  .meta({ id: "CreateVisit" });
export type CreateVisit = z.infer<typeof CreateVisit>;

export const VisitItem = z
  .object({
    ...entryOutput,
    kind: VisitKind,
    contactId: uuid.nullable(),
    visitorName: z.string().nullable(),
    visitorRelationship: z.string().nullable(),
    endedAt: isoDateTime.nullable(),
    restrictionsApplied: z.boolean(),
    restrictionReason: z.string().nullable(),
    notes: z.string().nullable(),
  })
  .meta({ id: "VisitItem" });
export type VisitItem = z.infer<typeof VisitItem>;

export const VisitList = z.object({ items: z.array(VisitItem) }).meta({ id: "VisitList" });
export type VisitList = z.infer<typeof VisitList>;

// ------------------------------------------------------------------------------------------------
// Advance care records and the resuscitation status
// ------------------------------------------------------------------------------------------------

export const AdvanceCareKind = z
  .enum(["respect", "dnacpr", "adrt", "advance_care_plan"])
  .meta({ id: "AdvanceCareKind" });
export const CprDecision = z
  .enum(["attempt_cpr", "do_not_attempt_cpr"])
  .meta({ id: "CprDecision" });

/** What the point-of-care header shows (hazard HZ-015). */
export const ResuscitationStatus = z
  .object({
    status: z.enum(["not_recorded", "attempt_cpr", "do_not_attempt_cpr"]),
    /** Records in force disagree: check the documents. */
    conflicting: z.boolean(),
    recordId: uuid.nullable(),
    kind: z.enum(["respect", "dnacpr"]).nullable(),
    completedOn: isoDate.nullable(),
    clinicianName: z.string().nullable(),
    clinicianRole: z.string().nullable(),
    reviewDueOn: isoDate.nullable(),
    reviewOverdue: z.boolean(),
  })
  .meta({
    id: "ResuscitationStatus",
    description:
      "The CPR decision in force from a DNACPR or ReSPECT record; 'not_recorded' when there is none, never blank",
  });
export type ResuscitationStatus = z.infer<typeof ResuscitationStatus>;

export const CreateAdvanceCareRecord = z
  .object({
    kind: AdvanceCareKind,
    /** ReSPECT section 4; a DNACPR record is always do not attempt CPR. */
    cprDecision: CprDecision.optional(),
    clinicianName: text(200).optional(),
    clinicianRole: text(120).optional(),
    completedOn: isoDate,
    reviewDueOn: isoDate.optional(),
    /** The scanned form in the document store. */
    documentId: uuid.optional(),
    details: text(4000).optional(),
  })
  .meta({ id: "CreateAdvanceCareRecord" });
export type CreateAdvanceCareRecord = z.infer<typeof CreateAdvanceCareRecord>;

export const UpdateAdvanceCareRecord = z
  .object({
    clinicianName: text(200).optional(),
    clinicianRole: text(120).optional(),
    reviewDueOn: isoDate.nullable().optional(),
    documentId: uuid.nullable().optional(),
    details: text(4000).nullable().optional(),
    /** Withdraws the record, with the reason. */
    withdrawnReason: text(1000).optional(),
    version,
  })
  .meta({
    id: "UpdateAdvanceCareRecord",
    description: "A changed CPR decision is a new record, which supersedes this one",
  });
export type UpdateAdvanceCareRecord = z.infer<typeof UpdateAdvanceCareRecord>;

export const AdvanceCareItem = z
  .object({
    id: uuid,
    personId: uuid,
    kind: AdvanceCareKind,
    status: z.enum(["active", "withdrawn", "superseded"]),
    cprDecision: CprDecision.nullable(),
    clinicianName: z.string().nullable(),
    clinicianRole: z.string().nullable(),
    completedOn: isoDate,
    reviewDueOn: isoDate.nullable(),
    reviewOverdue: z.boolean(),
    documentId: uuid.nullable(),
    details: z.string().nullable(),
    withdrawnAt: isoDateTime.nullable(),
    withdrawnReason: z.string().nullable(),
    supersededByRecordId: uuid.nullable(),
    version: z.number().int(),
  })
  .meta({ id: "AdvanceCareItem" });
export type AdvanceCareItem = z.infer<typeof AdvanceCareItem>;

export const AdvanceCareList = z
  .object({ items: z.array(AdvanceCareItem), resuscitation: ResuscitationStatus })
  .meta({ id: "AdvanceCareList" });
export type AdvanceCareList = z.infer<typeof AdvanceCareList>;
