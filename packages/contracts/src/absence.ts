import { z } from "zod";

/**
 * Absence and leave (scheduling.md section 15; SCHED-010; hazards HZ-123, HZ-124): leave asked
 * for and decided, sickness recorded with self-certification and fit notes, return to work, the
 * Bradford factor with its working, SSP working for payroll, and the cover an absence needs on
 * the rota. Never a diagnosis: the condition stays on the fit note document itself.
 */

const uuid = z.uuid();
const isoDate = z.iso.date();
const isoDateTime = z.iso.datetime({ offset: true });
const version = z.number().int().min(1);
const reason = z.string().trim().min(3).max(500);

export const AbsenceKind = z
  .enum([
    "annual_leave",
    "sickness",
    "compassionate",
    "carers_leave",
    "parental_leave",
    "maternity",
    "paternity",
    "adoption",
    "parental_bereavement",
    "unpaid",
    "other",
  ])
  .meta({ id: "AbsenceKind" });
export type AbsenceKind = z.infer<typeof AbsenceKind>;

export const AbsenceState = z
  .enum(["requested", "approved", "declined", "postponed", "cancelled", "recorded"])
  .meta({ id: "AbsenceState" });

export const AbsenceItem = z
  .object({
    id: uuid,
    version,
    member: z.object({ id: uuid, displayName: z.string() }),
    locationId: uuid,
    kind: AbsenceKind,
    startsOn: isoDate,
    endsOn: isoDate.nullable(),
    state: AbsenceState,
    decidedBy: uuid.nullable(),
    decidedAt: isoDateTime.nullable(),
    decisionReason: z.string().nullable(),
    selfCertifiedAt: isoDateTime.nullable(),
    /** Whether a manager has left it out of the Bradford factor (the reason is HR's only). */
    bradfordExcluded: z.boolean(),
    /** Shifts on the rota the absence leaves needing cover (HZ-123), open now. */
    coverNeeded: z.number().int().min(0),
    /**
     * For holders of workforce.hr_document.read only (null otherwise): the sickness days after the
     * self-certification days that no fit note covers.
     */
    fitNoteUncoveredDays: z.array(isoDate).nullable(),
  })
  .meta({ id: "AbsenceItem" });
export type AbsenceItem = z.infer<typeof AbsenceItem>;

export const AbsenceList = z
  .object({ items: z.array(AbsenceItem), truncated: z.boolean() })
  .meta({ id: "AbsenceList" });

export const AbsenceListQuery = z.object({
  locationId: uuid.optional(),
  memberId: uuid.optional(),
  from: isoDate.optional(),
  to: isoDate.optional(),
});

/**
 * Ask for one's own leave (no `memberId`, or one's own), or record a sickness or leave for a
 * member (`memberId` someone else's).
 */
export const NewAbsence = z
  .object({
    memberId: uuid.optional(),
    locationId: uuid,
    kind: AbsenceKind,
    startsOn: isoDate,
    endsOn: isoDate.nullable(),
    /** For a sickness recorded with the member's own statement for its first days. */
    selfCertified: z.boolean().default(false),
  })
  .meta({ id: "NewAbsence" });

export const DecideAbsence = z
  .object({
    version,
    /**
     * `decline` is refused for statutory leave (H-970); `postpone` is for carer's and unpaid
     * parental leave only, with a reason (the member asks again for the later dates).
     */
    decision: z.enum(["approve", "decline", "postpone"]),
    reason: reason.optional(),
  })
  .meta({ id: "DecideAbsence" });

export const CancelAbsence = z
  .object({ version, reason: reason.optional() })
  .meta({ id: "CancelAbsence" });

export const EndAbsence = z.object({ version, endsOn: isoDate }).meta({ id: "EndAbsence" });

export const ExcludeFromBradford = z
  .object({ version, reason: reason.nullable() })
  .meta({ id: "ExcludeFromBradford", description: "A reason leaves it out; null puts it back" });

const Adjustments = {
  phasedReturn: z.boolean().default(false),
  amendedDuties: z.boolean().default(false),
  alteredHours: z.boolean().default(false),
  workplaceAdaptations: z.boolean().default(false),
};

/** The query of a fit note upload; the body is the file. */
export const FitNoteQuery = z
  .object({
    issuedOn: isoDate,
    coversFrom: isoDate,
    coversTo: isoDate,
    fitness: z.enum(["not_fit", "may_be_fit"]),
    phasedReturn: z.enum(["true", "false"]).default("false"),
    amendedDuties: z.enum(["true", "false"]).default("false"),
    alteredHours: z.enum(["true", "false"]).default("false"),
    workplaceAdaptations: z.enum(["true", "false"]).default("false"),
  })
  .meta({ id: "FitNoteQuery" });

export const FitNoteItem = z
  .object({
    id: uuid,
    absenceId: uuid,
    documentId: uuid,
    issuedOn: isoDate,
    coversFrom: isoDate,
    coversTo: isoDate,
    fitness: z.enum(["not_fit", "may_be_fit"]),
    phasedReturn: z.boolean(),
    amendedDuties: z.boolean(),
    alteredHours: z.boolean(),
    workplaceAdaptations: z.boolean(),
    createdAt: isoDateTime,
  })
  .meta({ id: "FitNoteItem" });

export const NewReturnToWork = z
  .object({
    heldOn: isoDate,
    fitForUsualDuties: z.boolean(),
    ...Adjustments,
    notes: z.string().trim().min(1).max(4000).optional(),
  })
  .meta({ id: "NewReturnToWork" });

export const ReturnToWorkItem = z
  .object({
    id: uuid,
    absenceId: uuid,
    heldOn: isoDate,
    heldBy: uuid,
    fitForUsualDuties: z.boolean(),
    phasedReturn: z.boolean(),
    amendedDuties: z.boolean(),
    alteredHours: z.boolean(),
    workplaceAdaptations: z.boolean(),
    notes: z.string().nullable(),
    createdAt: isoDateTime,
  })
  .meta({ id: "ReturnToWorkItem" });

/** An absence with its health records, for holders of workforce.hr_document.read. */
export const AbsenceDetail = AbsenceItem.extend({
  /**
   * For carer's leave: the days approved or recorded in the last 12 months against the rate
   * table's allowance (H-970). Advisory for the approver; never a refusal.
   */
  carersLeave: z
    .object({
      takenDays: z.number().int(),
      allowanceDays: z.number().int().nullable(),
      overAllowance: z.boolean(),
    })
    .nullable(),
  fitNotes: z.array(FitNoteItem).nullable(),
  returnToWork: ReturnToWorkItem.nullable(),
  bradfordExcludedReason: z.string().nullable(),
}).meta({ id: "AbsenceDetail" });

export const BradfordResult = z
  .object({
    memberId: uuid,
    spells: z.number().int(),
    days: z.number().int(),
    /** Spells times spells times days. Shown with its working; never acted on by Harbour. */
    score: z.number().int(),
    windowStart: isoDate,
    windowEnd: isoDate,
    windowWeeks: z.number().int(),
    excludedAbsences: z.number().int(),
    working: z.array(z.string()),
    notice: z.string(),
  })
  .meta({ id: "BradfordResult" });

export const SspQuery = z
  .object({
    /** From payroll: the member's average weekly earnings, in pence. Never stored or audited. */
    averageWeeklyEarningsPence: z.number().int().min(0).max(100_000_000),
    /** The days of the week the member normally works, 1 Monday to 7 Sunday, each once. */
    qualifyingWeekdays: z
      .array(z.number().int().min(1).max(7))
      .min(1)
      .max(7)
      .refine((d) => new Set(d).size === d.length, "Each day once"),
  })
  .meta({ id: "SspQuery" });

export const SspResultItem = z
  .object({
    absenceId: uuid,
    /** False where no SSP applies: no rate for the nation, or no period of incapacity. */
    applies: z.boolean(),
    reason: z.enum(["no_rate_for_nation", "not_a_period_of_incapacity"]).nullable(),
    periodOfIncapacity: z
      .object({ startsOn: isoDate, endsOn: isoDate, linkedAbsences: z.number().int() })
      .nullable(),
    weeklyPence: z.number().int().nullable(),
    daysPaid: z.number().int().nullable(),
    payPence: z.number().int().nullable(),
    daysLeft: z.number().int().nullable(),
    working: z.array(z.object({ step: z.string(), pence: z.number().int().nullable() })),
    inputHash: z.string().nullable(),
    notice: z.string(),
  })
  .meta({ id: "SspResultItem" });

export type AbsenceDetail = z.infer<typeof AbsenceDetail>;
export type FitNoteItem = z.infer<typeof FitNoteItem>;
export type ReturnToWorkItem = z.infer<typeof ReturnToWorkItem>;
export type BradfordResult = z.infer<typeof BradfordResult>;
export type SspResultItem = z.infer<typeof SspResultItem>;
