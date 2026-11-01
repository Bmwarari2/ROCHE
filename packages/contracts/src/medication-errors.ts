import { z } from "zod";

/**
 * Medication errors on incidents, medication reviews and the medicines reports (Phase 2 slice 45;
 * medicines.md section 14; MEDS-012, MEDS-013). Enumerations mirror packages/domain; the API tests
 * keep them in step. Prompts are shown, never sent; nothing here scores or recommends.
 */

const uuid = z.uuid();
const isoDate = z.iso.date();
const isoDateTime = z.iso.datetime({ offset: true });
const version = z.number().int().min(1);
const words = (max: number) => z.string().trim().min(1).max(max);

export const MedicationErrorKind = z
  .enum([
    "omitted_dose",
    "wrong_dose",
    "wrong_medicine",
    "wrong_person",
    "wrong_time",
    "wrong_route",
    "given_after_stopped",
    "other",
    "wrong_frequency",
    "wrong_formulation",
    "wrong_quantity",
    "allergy_or_contraindication",
    "expired_medicine",
    "wrong_storage",
    "monitoring_not_done",
    "record_unclear_or_missing",
  ])
  .meta({ id: "MedicationErrorKind" });
export const MedicationErrorStage = z
  .enum([
    "prescribing",
    "transcribing",
    "dispensing",
    "administration",
    "monitoring",
    "storage",
    "other",
  ])
  .meta({ id: "MedicationErrorStage" });
export const MedicationErrorAnswer = z
  .enum(["yes", "no", "unsure"])
  .meta({ id: "MedicationErrorAnswer" });
export const MedicationErrorPromptKind = z
  .enum([
    "clinical_advice",
    "controlled_drug_report",
    "safeguarding_consideration",
    "cqc_through_classifier",
  ])
  .meta({ id: "MedicationErrorPromptKind" });

const errorFields = {
  /** A version of one of the person's medicines entries, when known. */
  medicationId: uuid.nullable(),
  /** The person's administration record it concerns, when there is one. */
  administrationId: uuid.nullable(),
  kinds: z.array(MedicationErrorKind).max(16),
  stage: MedicationErrorStage.nullable(),
  reachedPerson: MedicationErrorAnswer.nullable(),
  controlledDrug: MedicationErrorAnswer.nullable(),
  deliberateOrRepeated: MedicationErrorAnswer.nullable(),
  immediateActions: words(2000).nullable(),
  clinicianToldAt: isoDateTime.nullable(),
  /** Who was told, as written (for example "Out-of-hours GP"). */
  clinicianTold: words(2000).nullable(),
  adviceGiven: words(2000).nullable(),
  rootCause: words(2000).nullable(),
  cdReportedOn: isoDate.nullable(),
  cdReportReference: words(120).nullable(),
};

export const NewMedicationError = z
  .object({ personId: uuid, ...errorFields })
  .meta({ id: "NewMedicationError" });

export const EditMedicationError = z
  .object({ ...errorFields, version })
  .meta({ id: "EditMedicationError" });

export const MedicationErrorPrompt = z
  .object({ prompt: MedicationErrorPromptKind, reason: z.string() })
  .meta({ id: "MedicationErrorPrompt" });

export const MedicationErrorOut = z
  .object({
    id: uuid,
    incidentId: uuid,
    personId: uuid,
    ...errorFields,
    /** The medicine's name, when one is linked and visible. */
    medicineName: z.string().nullable(),
    /** True when "controlled drug" is presumed from the medicine's schedule, not answered. */
    controlledDrugPresumed: z.boolean(),
    /** Null until it is known whether it reached the person. */
    nearMiss: z.boolean().nullable(),
    kindWords: z.array(z.string()),
    stageWords: z.string().nullable(),
    /** Where the error categories come from (NRLS). */
    source: z.string(),
    /** What to do next, in words; Harbour sends nothing itself. */
    prompts: z.array(MedicationErrorPrompt),
    createdBy: uuid.nullable(),
    createdAt: isoDateTime,
    version,
  })
  .meta({ id: "MedicationErrorOut" });

export const MedicationErrorRead = z
  .object({ error: MedicationErrorOut.nullable() })
  .meta({ id: "MedicationErrorRead" });

export const ReviewerRole = z
  .enum(["gp", "pharmacist", "prescriber", "consultant", "other"])
  .meta({ id: "ReviewerRole" });
export const ReviewStatus = z
  .enum(["overdue", "due_soon", "scheduled", "not_scheduled"])
  .meta({ id: "ReviewStatus" });

export const MedicationReviewOut = z
  .object({
    id: uuid,
    personId: uuid,
    dueOn: isoDate,
    doneOn: isoDate.nullable(),
    clinicianName: z.string().nullable(),
    clinicianRole: ReviewerRole.nullable(),
    outcome: z.string().nullable(),
    correctionReason: z.string().nullable(),
    version,
  })
  .meta({ id: "MedicationReviewOut" });

export const ReviewTrackerLine = z
  .object({
    personId: uuid,
    /** The person's name as recorded, for the tracker list. */
    name: z.string(),
    lastDoneOn: isoDate.nullable(),
    nextDueOn: isoDate.nullable(),
    nextFrom: z.enum(["scheduled", "interval"]).nullable(),
    status: ReviewStatus,
    statusWords: z.string(),
  })
  .meta({ id: "ReviewTrackerLine" });

export const PersonMedicationReviews = z
  .object({ reviews: z.array(MedicationReviewOut), tracker: ReviewTrackerLine })
  .meta({ id: "PersonMedicationReviews" });

export const ScheduleMedicationReview = z
  .object({ dueOn: isoDate })
  .meta({ id: "ScheduleMedicationReview" });

export const RecordMedicationReview = z
  .object({
    doneOn: isoDate,
    clinicianName: words(200),
    clinicianRole: ReviewerRole,
    outcome: words(4000),
    /** Required when changing a review already recorded as done. */
    correctionReason: words(500).nullable().optional(),
    version,
  })
  .meta({ id: "RecordMedicationReview" });

export const ReviewTracker = z
  .object({ items: z.array(ReviewTrackerLine) })
  .meta({ id: "ReviewTracker" });

export const ReportPeriod = z.object({ from: isoDate, to: isoDate });

export const OverrideReport = z
  .object({
    from: isoDate,
    to: isoDate,
    items: z.array(
      z.object({
        memberId: uuid,
        name: z.string().nullable(),
        competenceOverride: z.number().int(),
        givenBeforeRecorded: z.number().int(),
      }),
    ),
  })
  .meta({ id: "OverrideReport" });

export const UsageReport = z
  .object({
    from: isoDate,
    to: isoDate,
    /** Always shown with the counts: a count for a clinician, never a judgement. */
    note: z.string(),
    items: z.array(
      z.object({
        personId: uuid,
        name: z.string(),
        prnGiven: z.number().int(),
        psychotropicGiven: z.number().int(),
        psychotropicPrnGiven: z.number().int(),
        byMedicine: z.array(
          z.object({
            medicineId: uuid,
            name: z.string(),
            prn: z.boolean(),
            psychotropic: z.boolean(),
            given: z.number().int(),
          }),
        ),
      }),
    ),
  })
  .meta({ id: "UsageReport" });

export const MedicationErrorTrend = z
  .object({
    from: isoDate,
    to: isoDate,
    source: z.string(),
    months: z.array(
      z.object({
        month: z.string(),
        errors: z.number().int(),
        nearMisses: z.number().int(),
        byKind: z.record(z.string(), z.number().int()),
        byStage: z.record(z.string(), z.number().int()),
      }),
    ),
  })
  .meta({ id: "MedicationErrorTrend" });

export type MedicationErrorKind = z.infer<typeof MedicationErrorKind>;
export type MedicationErrorStage = z.infer<typeof MedicationErrorStage>;
export type MedicationErrorAnswer = z.infer<typeof MedicationErrorAnswer>;
export type NewMedicationError = z.infer<typeof NewMedicationError>;
export type EditMedicationError = z.infer<typeof EditMedicationError>;
export type MedicationErrorOut = z.infer<typeof MedicationErrorOut>;
export type MedicationErrorRead = z.infer<typeof MedicationErrorRead>;
export type ReviewerRole = z.infer<typeof ReviewerRole>;
export type ReviewStatus = z.infer<typeof ReviewStatus>;
export type MedicationReviewOut = z.infer<typeof MedicationReviewOut>;
export type ReviewTrackerLine = z.infer<typeof ReviewTrackerLine>;
export type PersonMedicationReviews = z.infer<typeof PersonMedicationReviews>;
export type ScheduleMedicationReview = z.infer<typeof ScheduleMedicationReview>;
export type RecordMedicationReview = z.infer<typeof RecordMedicationReview>;
export type ReviewTracker = z.infer<typeof ReviewTracker>;
export type OverrideReport = z.infer<typeof OverrideReport>;
export type UsageReport = z.infer<typeof UsageReport>;
export type MedicationErrorTrend = z.infer<typeof MedicationErrorTrend>;
