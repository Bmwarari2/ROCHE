import { z } from "zod";

/**
 * Induction, the Care Certificate and leavers (workforce.md section 2d, rules 19 to 23 and
 * section 5; WORK-004, WORK-013; plan slice 29). Dates are UK dates (yyyy-mm-dd). Codes mirror
 * packages/domain (`workforce/induction.ts`).
 */

const uuid = z.uuid();
const isoDate = z.iso.date();
const isoDateTime = z.iso.datetime({ offset: true });
/** The version the change is based on; a stale one is refused with 409. */
const version = z.number().int().min(1);
const text = (min: number, max: number) => z.string().trim().min(min).max(max);

export const CareCertificateStandardId = z
  .enum([
    "cc01",
    "cc02",
    "cc03",
    "cc04",
    "cc05",
    "cc06",
    "cc07",
    "cc08",
    "cc09",
    "cc10",
    "cc11",
    "cc12",
    "cc13",
    "cc14",
    "cc15",
    "cc16",
  ])
  .meta({ id: "CareCertificateStandardId" });
export const InductionTickedItem = z
  .enum([
    "contract_issued",
    "system_access_set_up",
    "uniform_and_badge",
    "location_induction",
    "fire_safety_briefing",
    "shadowing_signed_off",
  ])
  .meta({ id: "InductionTickedItem" });
export const LeaverTickedItem = z
  .enum(["property_returned", "final_pay_notified"])
  .meta({ id: "LeaverTickedItem" });
export const ChecklistStatus = z
  .enum(["done", "outstanding", "overdue", "not_needed"])
  .meta({ id: "ChecklistStatus", description: "Shown as a word and an icon, never colour alone" });
export const ProbationOutcome = z
  .enum(["passed", "extended", "not_passed"])
  .meta({ id: "ProbationOutcome" });
export const LeavingReason = z
  .enum([
    "resignation",
    "end_of_fixed_term",
    "retirement",
    "dismissal",
    "redundancy",
    "tupe_transfer_out",
    "death_in_service",
    "other",
  ])
  .meta({ id: "LeavingReason" });
export const ExitInterviewState = z
  .enum(["not_offered", "offered", "declined", "held"])
  .meta({ id: "ExitInterviewState" });

export const InductionDetail = z
  .object({
    staffProfileId: uuid,
    startsOn: isoDate.nullable(),
    planVersion: version.nullable(),
    careCertificateHeld: z.boolean(),
    checklist: z.array(
      z.object({
        kind: z.string(),
        phase: z.string(),
        status: ChecklistStatus,
        doneOn: isoDate.nullable(),
      }),
    ),
    policies: z.object({ required: z.number().int(), signed: z.number().int() }),
    careCertificate: z.object({
      standards: z.array(
        z.object({
          id: CareCertificateStandardId,
          title: z.string(),
          status: z.enum(["not_started", "knowledge_assessed", "competent"]),
          knowledgeAssessedOn: isoDate.nullable(),
          knowledgeAssessedBy: uuid.nullable(),
          observedOn: isoDate.nullable(),
          observedBy: uuid.nullable(),
          version: version.nullable(),
        }),
      ),
      competent: z.number().int(),
      complete: z.boolean(),
      completedOn: isoDate.nullable(),
    }),
    shadowShifts: z.array(
      z.object({ id: uuid, shiftOn: isoDate, locationId: uuid.nullable(), shadowedId: uuid }),
    ),
    probation: z.object({
      endsOn: isoDate.nullable(),
      outcome: ProbationOutcome.nullable(),
      decidedOn: isoDate.nullable(),
      decidedBy: uuid.nullable(),
      reviews: z.array(
        z.object({
          id: uuid,
          reviewOn: isoDate,
          reviewerId: uuid,
          outcome: z.enum(["on_track", "concerns"]),
          notes: z.string().nullable(),
        }),
      ),
    }),
    asOf: isoDate,
  })
  .meta({ id: "InductionDetail" });
export type InductionDetail = z.infer<typeof InductionDetail>;

export const CareCertificateView = z
  .object({
    staffProfileId: uuid,
    careCertificate: InductionDetail.shape.careCertificate,
  })
  .meta({ id: "CareCertificateView" });
export type CareCertificateView = z.infer<typeof CareCertificateView>;

export const SetInductionPlan = z
  .object({
    /** The plan's version when it exists; omitted to create it. */
    expectedVersion: version.optional(),
    probationEndsOn: isoDate.nullable(),
    careCertificateHeld: z.boolean(),
  })
  .meta({ id: "SetInductionPlan" });
export const TickItem = z.object({ doneOn: isoDate }).meta({ id: "TickItem" });
export const RecordShadowShift = z
  .object({ shiftOn: isoDate, locationId: uuid.nullable().default(null), shadowedId: uuid })
  .meta({ id: "RecordShadowShift" });
export const RecordProbationReview = z
  .object({
    reviewOn: isoDate,
    outcome: z.enum(["on_track", "concerns"]),
    notes: text(1, 4000).nullable().default(null),
  })
  .meta({ id: "RecordProbationReview" });
export const DecideProbation = z
  .object({
    expectedVersion: version,
    outcome: ProbationOutcome,
    decidedOn: isoDate,
    newEndsOn: isoDate.nullable().default(null),
  })
  .meta({ id: "DecideProbation" });
export const RecordCareCertificateStep = z
  .object({ step: z.enum(["knowledge", "observation"]), on: isoDate })
  .meta({ id: "RecordCareCertificateStep" });

export const LeavingDetail = z
  .object({
    staffProfileId: uuid,
    leavingOn: isoDate,
    reason: LeavingReason,
    accessRemovedAt: isoDateTime.nullable(),
    exitInterview: ExitInterviewState,
    exitInterviewOn: isoDate.nullable(),
    exitInterviewSummary: z.string().nullable(),
    staffFileRetainUntil: isoDate.nullable(),
    checklist: z.array(
      z.object({ kind: z.string(), status: ChecklistStatus, doneOn: isoDate.nullable() }),
    ),
    references: z.array(
      z.object({
        id: uuid,
        requestedOn: isoDate,
        requester: z.string(),
        kind: z.enum(["factual", "conduct"]),
        state: z.enum(["requested", "sent", "declined"]),
        sentOn: isoDate.nullable(),
        declinedReason: z.string().nullable(),
        version,
      }),
    ),
    version,
    asOf: isoDate,
  })
  .meta({ id: "LeavingDetail" });
export type LeavingDetail = z.infer<typeof LeavingDetail>;

export const RecordLeaving = z
  .object({ leavingOn: isoDate, reason: LeavingReason })
  .meta({ id: "RecordLeaving" });
export const RecordExitInterview = z
  .object({
    expectedVersion: version,
    state: z.enum(["offered", "declined", "held"]),
    heldOn: isoDate.nullable().default(null),
    summary: text(1, 4000).nullable().default(null),
  })
  .meta({ id: "RecordExitInterview" });
export const RecordReferenceRequest = z
  .object({ requestedOn: isoDate, requester: text(2, 200), kind: z.enum(["factual", "conduct"]) })
  .meta({ id: "RecordReferenceRequest" });
export const AnswerReferenceRequest = z
  .object({
    expectedVersion: version,
    state: z.enum(["sent", "declined"]),
    sentOn: isoDate.nullable().default(null),
    declinedReason: z
      .enum(["no_consent_to_share", "not_employed_here", "duplicate_request"])
      .nullable()
      .default(null),
  })
  .meta({ id: "AnswerReferenceRequest" });
