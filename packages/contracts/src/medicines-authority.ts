import { z } from "zod";

/**
 * Covert administration, self-administration and homely remedies (Phase 2 slice 38;
 * medicines.md section 15; MEDS-004, MEDS-006, MEDS-007). Enumerations mirror packages/domain;
 * the API tests keep them in step. Harbour records and applies the organisation's decisions; it
 * never recommends covert administration, a level of self-administration or a remedy.
 */

const uuid = z.uuid();
const isoDate = z.iso.date();
const isoDateTime = z.iso.datetime({ offset: true });
const version = z.number().int().min(1);
const words = (max: number) => z.string().trim().min(1).max(max);
// Above zero, at most three decimals (inclusive bounds: the breaking-change check cannot read exclusive ones).
const quantity = z.number().min(0.001).max(100_000).multipleOf(0.001);

export const CovertAttendeeRole = z
  .enum([
    "prescriber",
    "pharmacist",
    "registered_manager",
    "nurse",
    "care_staff",
    "family_or_friend",
    "representative",
    "advocate",
    "other",
  ])
  .meta({ id: "CovertAttendeeRole" });
export const CovertStatus = z
  .enum(["not_started", "current", "review_overdue", "basis_changed", "ended"])
  .meta({ id: "CovertStatus" });

const Attendees = z
  .array(z.strictObject({ role: CovertAttendeeRole, name: words(200) }))
  .min(1)
  .max(20);

export const NewCovertRecord = z
  .strictObject({
    /** A version of the person's medicines entry. */
    medicationId: uuid,
    capacityAssessmentId: uuid,
    bestInterestsDecisionId: uuid,
    attendees: Attendees,
    method: words(1000),
    pharmacistAdvice: words(2000),
    startsOn: isoDate,
    reviewOn: isoDate,
  })
  .meta({ id: "NewCovertRecord" });

export const ReviewCovertRecord = z
  .strictObject({
    capacityAssessmentId: uuid,
    bestInterestsDecisionId: uuid,
    attendees: Attendees,
    method: words(1000),
    pharmacistAdvice: words(2000),
    reviewedOn: isoDate,
    reviewOn: isoDate,
    reason: words(500),
    version,
  })
  .meta({ id: "ReviewCovertRecord" });

export const EndCovertRecord = z
  .strictObject({ endedOn: isoDate, reason: words(500), version })
  .meta({ id: "EndCovertRecord" });

export const CovertRecordOut = z
  .object({
    id: uuid,
    personId: uuid,
    medicationId: uuid,
    medicineId: uuid,
    medicineName: z.string(),
    capacityAssessmentId: uuid,
    bestInterestsDecisionId: uuid,
    attendees: z.array(
      z.object({ role: CovertAttendeeRole, roleWords: z.string(), name: z.string() }),
    ),
    method: z.string(),
    pharmacistAdvice: z.string(),
    startsOn: isoDate,
    reviewOn: isoDate,
    reviewedOn: isoDate.nullable(),
    endedOn: isoDate.nullable(),
    endedReason: z.string().nullable(),
    changeReason: z.string().nullable(),
    status: CovertStatus,
    statusWords: z.string(),
    version,
  })
  .meta({ id: "CovertRecord" });

export const CovertRecordList = z
  .object({ items: z.array(CovertRecordOut) })
  .meta({ id: "CovertRecordList" });

export const SelfAdminLevel = z
  .enum(["self_administers", "self_administers_with_support", "staff_administer"])
  .meta({ id: "SelfAdminLevel" });

export const NewSelfAdminAssessment = z
  .strictObject({
    /** Stable medicine ids of the person's entries it covers. */
    medicineIds: z.array(uuid).min(1).max(100),
    choice: z.enum(["wants_to", "does_not_want_to"]),
    capacity: z.enum(["has_capacity", "lacks_capacity", "assumed"]),
    capacityAssessmentId: uuid.nullable(),
    dexterity: z.enum(["able", "able_with_aids", "unable"]),
    storage: z.enum(["lockable_storage", "no_lockable_storage"]),
    level: SelfAdminLevel,
    notes: words(4000).nullable(),
    assessedOn: isoDate,
    reviewOn: isoDate,
  })
  .meta({ id: "NewSelfAdminAssessment" });

export const SelfAdminAssessmentOut = NewSelfAdminAssessment.extend({
  id: uuid,
  personId: uuid,
  levelWords: z.string(),
  assessedBy: uuid,
  recordedAt: isoDateTime,
}).meta({ id: "SelfAdminAssessment" });

export const PersonSelfAdministration = z
  .object({
    assessments: z.array(SelfAdminAssessmentOut),
    /** For each of the person's medicines: where it stands today. */
    medicines: z.array(
      z.object({
        medicineId: uuid,
        name: z.string(),
        status: z.enum(["current", "review_overdue", "not_assessed"]),
        level: SelfAdminLevel.nullable(),
        statusWords: z.string(),
      }),
    ),
  })
  .meta({ id: "PersonSelfAdministration" });

const protocolFields = {
  productName: words(200),
  /** dm+d VMP id, when coded. */
  vmpId: z
    .string()
    .regex(/^[0-9]{6,18}$/)
    .nullable(),
  indication: words(500),
  doseQuantity: quantity,
  unitName: words(60),
  minIntervalHours: z.number().min(0.01).max(168).multipleOf(0.01),
  maxDailyQuantity: quantity,
  maxDays: z.number().int().min(1).max(365),
  authorisedMemberIds: z.array(uuid).min(1).max(500),
  approvedByName: words(200),
  approvedByRole: z.enum(["gp", "pharmacist"]),
  approvedOn: isoDate,
  reviewOn: isoDate,
};

export const NewHomelyProtocol = z.strictObject(protocolFields).meta({ id: "NewHomelyProtocol" });

export const ChangeHomelyProtocol = z
  .strictObject({ ...protocolFields, reason: words(500), version })
  .meta({ id: "ChangeHomelyProtocol" });

export const WithdrawHomelyProtocol = z
  .strictObject({ reason: words(500), version })
  .meta({ id: "WithdrawHomelyProtocol" });

export const HomelyProtocolOut = z
  .object({
    id: uuid,
    locationId: uuid,
    ...protocolFields,
    withdrawnAt: isoDateTime.nullable(),
    withdrawnReason: z.string().nullable(),
    changeReason: z.string().nullable(),
    status: z.enum(["in_use", "review_overdue", "withdrawn"]),
    statusWords: z.string(),
    version,
  })
  .meta({ id: "HomelyProtocol" });

export const HomelyProtocolList = z
  .object({ items: z.array(HomelyProtocolOut) })
  .meta({ id: "HomelyProtocolList" });

export const RecordHomelyDose = z
  .strictObject({
    /** The client's UUID: a resend with the same id is the same record. */
    id: uuid,
    protocolId: uuid,
    quantity,
    /** Why it is given, in words (the symptom). */
    reason: words(500),
    /** The giver checked the person's allergies against the remedy (HZ-007). */
    allergiesChecked: z.literal(true),
    /**
     * A dose already given, recorded afterwards: when it was given and why it is recorded only
     * now. Problems the check finds are then recorded as flags and escalated, never refused.
     */
    alreadyGiven: z
      .strictObject({ givenAt: isoDateTime, reason: words(500) })
      .nullable()
      .default(null),
  })
  .meta({ id: "RecordHomelyDose" });

export const CheckHomelyDose = z
  .strictObject({ protocolId: uuid, quantity })
  .meta({ id: "CheckHomelyDose" });

export const HomelyDoseCheck = z
  .object({
    /** Empty when the dose is within the protocol now. */
    problems: z.array(z.object({ problem: z.string(), message: z.string() })),
  })
  .meta({ id: "HomelyDoseCheck" });

export const HomelyDoseEnteredInError = z
  .strictObject({ id: uuid, reason: words(500) })
  .meta({ id: "HomelyDoseEnteredInError" });

export const HomelyDoseOut = z
  .object({
    id: uuid,
    personId: uuid,
    protocolId: uuid,
    protocolVersion: z.number().int(),
    productName: z.string(),
    outcome: z.enum(["given", "entered_in_error"]),
    quantity: z.number().nullable(),
    unitName: z.string(),
    reason: z.string().nullable(),
    givenAt: isoDateTime,
    givenBy: uuid,
    allergiesChecked: z.boolean(),
    alreadyGivenReason: z.string().nullable(),
    /** What the protocol check found, for a dose recorded after it was given. */
    flags: z.array(z.string()),
    recordedAt: isoDateTime,
    supersedesId: uuid.nullable(),
    correctionReason: z.string().nullable(),
    /** Set when a later record marks this one as entered in error: shown struck through. */
    enteredInErrorBy: uuid.nullable(),
  })
  .meta({ id: "HomelyDose" });

export const HomelyDoseList = z
  .object({ items: z.array(HomelyDoseOut) })
  .meta({ id: "HomelyDoseList" });

export type NewCovertRecord = z.infer<typeof NewCovertRecord>;
export type ReviewCovertRecord = z.infer<typeof ReviewCovertRecord>;
export type EndCovertRecord = z.infer<typeof EndCovertRecord>;
export type CovertRecordOut = z.infer<typeof CovertRecordOut>;
export type NewSelfAdminAssessment = z.infer<typeof NewSelfAdminAssessment>;
export type SelfAdminAssessmentOut = z.infer<typeof SelfAdminAssessmentOut>;
export type PersonSelfAdministration = z.infer<typeof PersonSelfAdministration>;
export type NewHomelyProtocol = z.infer<typeof NewHomelyProtocol>;
export type ChangeHomelyProtocol = z.infer<typeof ChangeHomelyProtocol>;
export type HomelyProtocolOut = z.infer<typeof HomelyProtocolOut>;
export type RecordHomelyDose = z.infer<typeof RecordHomelyDose>;
export type HomelyDoseOut = z.infer<typeof HomelyDoseOut>;
