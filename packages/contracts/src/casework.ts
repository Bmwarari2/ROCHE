import { z } from "zod";

/**
 * Employee relations casework (workforce.md section 2c, rules 15 to 18 and section 5; WORK-010;
 * plan slice 39). Read only by the members named on a case (ADR-0089). Dates are UK dates
 * (yyyy-mm-dd). Codes mirror packages/domain (`workforce/casework.ts`).
 */

const uuid = z.uuid();
const isoDate = z.iso.date();
const isoDateTime = z.iso.datetime({ offset: true });
/** The version the change is based on; a stale one is refused with 409. */
const version = z.number().int().min(1);
const text = (min: number, max: number) => z.string().trim().min(min).max(max);

export const CaseType = z
  .enum(["grievance", "disciplinary", "capability", "sickness_absence", "probation"])
  .meta({ id: "CaseType" });
export const CaseStage = z
  .enum(["open", "investigation", "hearing", "outcome", "appeal", "closed"])
  .meta({ id: "CaseStage" });
export const CaseMemberRole = z
  .enum([
    "case_manager",
    "investigator",
    "hearing_chair",
    "appeal_chair",
    "note_taker",
    "hr_adviser",
  ])
  .meta({ id: "CaseMemberRole" });
export const CaseOutcome = z
  .enum([
    "upheld",
    "partly_upheld",
    "not_upheld",
    "no_action",
    "first_written_warning",
    "final_written_warning",
    "action_short_of_dismissal",
    "dismissal",
    "improvement_plan",
    "redeployment",
    "support_plan",
    "reasonable_adjustments",
    "passed",
    "extended",
    "not_passed",
  ])
  .meta({ id: "CaseOutcome", description: "Which apply depends on the case type (rule 15)" });
export const AppealOutcome = z
  .enum(["upheld", "partly_upheld", "not_upheld"])
  .meta({ id: "AppealOutcome" });
export const CaseClosingReason = z
  .enum([
    "outcome_accepted",
    "appeal_decided",
    "resolved_informally",
    "no_case_to_answer",
    "withdrawn",
    "left_employment",
  ])
  .meta({ id: "CaseClosingReason" });
export const ReferralDecision = z
  .enum(["referred", "not_required"])
  .meta({ id: "ReferralDecision" });
export const ReferralNotRequiredReason = z
  .enum([
    "harm_test_not_met",
    "not_regulated_activity",
    "referred_by_another_body",
    "other_recorded_in_case",
  ])
  .meta({ id: "ReferralNotRequiredReason" });
export const HearingKind = z
  .enum(["investigation_meeting", "hearing", "appeal_hearing"])
  .meta({ id: "HearingKind" });
export const HearingState = z
  .enum(["scheduled", "held", "not_attended", "postponed", "cancelled"])
  .meta({ id: "HearingState" });
export const PostponementReason = z
  .enum(["companion_unavailable", "employee_unwell", "employer_request", "other"])
  .meta({ id: "PostponementReason" });

export const OpenCase = z
  .object({
    caseType: CaseType,
    /** The member of staff the case is about (never the caller). */
    subjectTenantUserId: uuid,
    summary: text(3, 10000),
    openedOn: isoDate,
  })
  .meta({ id: "OpenCase" });

export const CaseSummary = z
  .object({
    id: uuid,
    caseType: CaseType,
    subjectTenantUserId: uuid,
    stage: CaseStage,
    stageSince: isoDate,
    openedOn: isoDate,
    /** The caller's own parts on the case. */
    myRoles: z.array(CaseMemberRole),
    suspended: z.boolean(),
    version,
  })
  .meta({ id: "CaseSummary" });
export type CaseSummary = z.infer<typeof CaseSummary>;
export const CaseList = z.object({ items: z.array(CaseSummary) }).meta({ id: "CaseList" });
export type CaseList = z.infer<typeof CaseList>;

export const CaseMember = z
  .object({
    id: uuid,
    tenantUserId: uuid,
    role: CaseMemberRole,
    independenceException: z.enum(["no_other_manager_available"]).nullable(),
    addedBy: uuid,
    removedAt: isoDateTime.nullable(),
    version,
  })
  .meta({ id: "CaseMember" });
export type CaseMember = z.infer<typeof CaseMember>;

export const CaseHearing = z
  .object({
    id: uuid,
    kind: HearingKind,
    ledBy: uuid,
    invitedOn: isoDate,
    scheduledAt: isoDateTime,
    issueSetOut: z.boolean(),
    evidenceShared: z.boolean(),
    companionRightGiven: z.boolean(),
    state: HearingState,
    heldOn: isoDate.nullable(),
    accompanied: z.boolean().nullable(),
    postponedReason: PostponementReason.nullable(),
    version,
  })
  .meta({ id: "CaseHearing" });
export type CaseHearing = z.infer<typeof CaseHearing>;

export const CaseEvent = z
  .object({
    id: uuid,
    kind: z.string(),
    fromStage: CaseStage.nullable(),
    toStage: CaseStage.nullable(),
    occurredOn: isoDate,
    body: z.string().nullable(),
    recordedBy: uuid,
    recordedAt: isoDateTime,
  })
  .meta({ id: "CaseEvent" });
export type CaseEvent = z.infer<typeof CaseEvent>;

const referralView = z.object({
  /** Whether a decision must be recorded before the case closes (rule 17). */
  due: z.boolean(),
  decision: ReferralDecision.nullable(),
  referredOn: isoDate.nullable(),
  reason: ReferralNotRequiredReason.nullable(),
});

export const CaseDetail = z
  .object({
    case: CaseSummary.extend({
      summary: z.string(),
      subjectRegistered: z.boolean(),
      outcome: CaseOutcome.nullable(),
      outcomeDecidedOn: isoDate.nullable(),
      warningExpiresOn: isoDate.nullable(),
      appealOutcome: AppealOutcome.nullable(),
      appealDecidedOn: isoDate.nullable(),
      suspendedOn: isoDate.nullable(),
      suspensionReviewOn: isoDate.nullable(),
      /** The review date has passed (shown in words, never by colour alone). */
      suspensionReviewOverdue: z.boolean(),
      closedReason: CaseClosingReason.nullable(),
      closedOn: isoDate.nullable(),
      safeguardingIncidentId: uuid.nullable(),
    }),
    referrals: z.object({ dbs: referralView, regulator: referralView }),
    members: z.array(CaseMember),
    hearings: z.array(CaseHearing),
    timeline: z.array(CaseEvent),
    /** Calendar days at the current stage (no target applied; Acas: without unreasonable delay). */
    daysAtStage: z.number().int().nullable(),
  })
  .meta({ id: "CaseDetail" });
export type CaseDetail = z.infer<typeof CaseDetail>;

export const NameCaseMember = z
  .object({
    tenantUserId: uuid,
    role: CaseMemberRole,
    independenceException: z.enum(["no_other_manager_available"]).nullable().default(null),
  })
  .meta({ id: "NameCaseMember" });

export const RemoveCaseMember = z
  .object({ expectedVersion: version })
  .meta({ id: "RemoveCaseMember" });

export const MoveCase = z
  .object({ expectedVersion: version, on: isoDate })
  .and(
    z.discriminatedUnion("to", [
      z.object({ to: z.literal("investigation") }),
      z.object({ to: z.literal("hearing") }),
      z.object({
        to: z.literal("outcome"),
        outcome: CaseOutcome,
        warningExpiresOn: isoDate.nullable().default(null),
        appealRightGiven: z.boolean(),
        noHearingReason: z.enum(["employee_repeatedly_did_not_attend"]).nullable().default(null),
      }),
      z.object({ to: z.literal("appeal"), grounds: text(3, 10000) }),
      z.object({
        to: z.literal("closed"),
        reason: CaseClosingReason,
        appealOutcome: AppealOutcome.nullable().default(null),
      }),
    ]),
  )
  .meta({ id: "MoveCase" });

export const ArrangeHearing = z
  .object({
    kind: HearingKind,
    ledBy: uuid,
    invitedOn: isoDate,
    scheduledAt: isoDateTime,
    issueSetOut: z.boolean(),
    evidenceShared: z.boolean(),
    companionRightGiven: z.boolean(),
  })
  .meta({ id: "ArrangeHearing" });

export const UpdateHearing = z
  .object({
    expectedVersion: version,
    state: z.enum(["held", "not_attended", "postponed", "cancelled", "scheduled"]),
    heldOn: isoDate.nullable().default(null),
    accompanied: z.boolean().nullable().default(null),
    postponedReason: PostponementReason.nullable().default(null),
    /** A new date for a postponed hearing (state back to scheduled). */
    scheduledAt: isoDateTime.optional(),
  })
  .meta({ id: "UpdateHearing" });

export const ChangeSuspension = z
  .object({
    expectedVersion: version,
    kind: z.enum(["start", "review", "end"]),
    on: isoDate,
    /** The next review date (start and review). */
    reviewOn: isoDate.nullable().default(null),
  })
  .meta({ id: "ChangeSuspension" });

export const RecordReferral = z
  .object({
    expectedVersion: version,
    body: z.enum(["dbs", "regulator"]),
    decision: ReferralDecision,
    referredOn: isoDate.nullable().default(null),
    reason: ReferralNotRequiredReason.nullable().default(null),
  })
  .meta({ id: "RecordReferral" });

export const LinkSafeguarding = z
  .object({ expectedVersion: version, incidentId: uuid })
  .meta({ id: "LinkSafeguarding" });

export const AddCaseNote = z
  .object({ body: text(1, 10000), occurredOn: isoDate })
  .meta({ id: "AddCaseNote" });
