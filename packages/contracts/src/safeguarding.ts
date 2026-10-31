import { z } from "zod";

/**
 * The safeguarding log (Phase 2 slice 13; SAFE-006; docs/specs/safety.md, "Safeguarding log").
 * Enumerations mirror packages/domain (`safety/safeguarding.ts`, `ABUSE_TYPES`); the API tests keep
 * them in step. The web screens are slice 62.
 */

const uuid = z.uuid();
const isoDateTime = z.iso.datetime({ offset: true });
const version = z.number().int().min(1);
const text = (max: number) => z.string().trim().max(max);

export const SafeguardingAbuseType = z
  .enum([
    "physical",
    "domestic",
    "sexual",
    "psychological",
    "financial_or_material",
    "modern_slavery",
    "discriminatory",
    "organisational",
    "neglect",
    "self_neglect",
  ])
  .meta({ id: "SafeguardingAbuseType" });

export const SafeguardingState = z
  .enum(["concern", "no_referral", "referred", "enquiry", "outcome", "closed"])
  .meta({ id: "SafeguardingState" });
export type SafeguardingState = z.infer<typeof SafeguardingState>;

export const SafeguardingFinding = z
  .enum([
    "substantiated",
    "partly_substantiated",
    "not_substantiated",
    "inconclusive",
    "no_s42_enquiry",
  ])
  .meta({ id: "SafeguardingFinding" });

export const SafeguardingStaffHarm = z
  .enum(["removed", "would_have_removed", "not_removed", "no_staff_involved"])
  .meta({ id: "SafeguardingStaffHarm" });

export const SafeguardingMeasuresOutcome = z
  .enum(["carried_into_care_plan", "no_longer_needed"])
  .meta({ id: "SafeguardingMeasuresOutcome" });

export const SafeguardingClockStatus = z
  .enum(["due", "overdue", "referred", "not_referred"])
  .meta({ id: "SafeguardingClockStatus" });

export const RaiseSafeguardingConcern = z
  .object({
    /** A client id: a replay of the same request returns the same concern. */
    id: uuid.optional(),
    personId: uuid,
    abuseTypes: z.array(SafeguardingAbuseType).min(1).max(10),
    description: text(4000).min(3),
    /** Defaults to now; never in the future. */
    raisedAt: isoDateTime.optional(),
    incidentId: uuid.optional(),
    /** A Phase 1 `safeguarding_s42` draft to open the concern from. */
    notificationId: uuid.optional(),
    /** The pressure-ulcer adult safeguarding decision guide task it came from. */
    decisionGuideTaskId: uuid.optional(),
    protectiveMeasures: text(2000).min(3).optional(),
  })
  .meta({ id: "RaiseSafeguardingConcern" });
export type RaiseSafeguardingConcern = z.infer<typeof RaiseSafeguardingConcern>;

export const SafeguardingRaised = z
  .object({
    id: uuid,
    state: SafeguardingState,
    referralDueAt: isoDateTime,
    version,
  })
  .meta({ id: "SafeguardingRaised" });

export const SafeguardingClock = z
  .object({ status: SafeguardingClockStatus, dueAt: isoDateTime, wording: z.string() })
  .meta({ id: "SafeguardingClock" });

const Referral = z.object({
  localAuthority: text(200).min(2),
  method: z.enum(["phone", "online_form", "email", "in_person"]),
  referredAt: isoDateTime,
  reference: text(120).nullable(),
});

const Enquiry = z.object({
  kind: z.enum(["s42_local_authority", "s42_caused_to_provider"]),
  openedAt: isoDateTime,
});

const PersonalOutcomes = z.object({
  asked: z.boolean(),
  notAskedReason: text(2000).nullable(),
  desiredOutcomes: text(2000).nullable(),
  achieved: z.enum(["fully", "partly", "not"]).nullable(),
});

const DbsReferral = z.object({
  decision: z.enum(["referred", "not_required"]),
  reason: text(2000).nullable(),
  at: isoDateTime,
});

export const UpdateSafeguardingConcern = z
  .object({
    version,
    /** The description stays in the raiser's words: it is not changed after the concern is raised. */
    abuseTypes: z.array(SafeguardingAbuseType).min(1).max(10).optional(),
    referral: Referral.nullable().optional(),
    enquiry: Enquiry.nullable().optional(),
    finding: SafeguardingFinding.nullable().optional(),
    personalOutcomes: PersonalOutcomes.nullable().optional(),
    staffHarm: SafeguardingStaffHarm.nullable().optional(),
    dbsReferral: DbsReferral.nullable().optional(),
    /** Empty or blank clears the measures. */
    protectiveMeasures: text(2000).nullable().optional(),
    measuresOutcome: SafeguardingMeasuresOutcome.nullable().optional(),
  })
  .meta({ id: "UpdateSafeguardingConcern" });
export type UpdateSafeguardingConcern = z.infer<typeof UpdateSafeguardingConcern>;

export const SafeguardingStep = z
  .object({ to: SafeguardingState, reason: text(2000).optional(), version })
  .meta({ id: "SafeguardingStep" });
export type SafeguardingStep = z.infer<typeof SafeguardingStep>;

export const SafeguardingSummary = z
  .object({
    id: uuid,
    personId: uuid,
    locationId: uuid,
    state: SafeguardingState,
    abuseTypes: z.array(SafeguardingAbuseType),
    raisedAt: isoDateTime,
    clock: SafeguardingClock,
    version,
  })
  .meta({ id: "SafeguardingSummary" });

export const SafeguardingList = z
  .object({ concerns: z.array(SafeguardingSummary), truncated: z.boolean() })
  .meta({ id: "SafeguardingList" });
export type SafeguardingList = z.infer<typeof SafeguardingList>;

export const SafeguardingDetail = z
  .object({
    id: uuid,
    personId: uuid,
    locationId: uuid,
    incidentId: uuid.nullable(),
    notification: z
      .object({
        id: uuid,
        status: z.enum(["draft", "ready", "submitted", "not_required"]),
        dueAt: isoDateTime,
      })
      .nullable(),
    decisionGuideTaskId: uuid.nullable(),
    state: SafeguardingState,
    abuseTypes: z.array(SafeguardingAbuseType),
    description: z.string(),
    raisedAt: isoDateTime,
    raisedByYou: z.boolean(),
    clock: SafeguardingClock,
    noReferralReason: z.string().nullable(),
    referral: Referral.nullable(),
    enquiry: Enquiry.nullable(),
    finding: SafeguardingFinding.nullable(),
    personalOutcomes: PersonalOutcomes.nullable(),
    staffHarm: SafeguardingStaffHarm.nullable(),
    dbsReferral: DbsReferral.nullable(),
    protectiveMeasures: z.string().nullable(),
    protectiveMeasuresUpdatedAt: isoDateTime.nullable(),
    measuresOutcome: SafeguardingMeasuresOutcome.nullable(),
    closedAt: isoDateTime.nullable(),
    closedReason: z.string().nullable(),
    /** What each next step still needs (`safeguardingStepProblems`), by the step's state. */
    nextSteps: z.array(z.object({ to: SafeguardingState, needs: z.array(z.string()) })),
    /** Plain warnings, for example a linked s.42 draft still open after the referral. */
    warnings: z.array(z.string()),
    version,
  })
  .meta({ id: "SafeguardingDetail" });
export type SafeguardingDetail = z.infer<typeof SafeguardingDetail>;

export const SafeguardingMeasures = z
  .object({
    measures: z.array(z.object({ text: z.string(), updatedAt: isoDateTime })),
    /** Open concerns with no measures recorded: the screen says so rather than show nothing. */
    openWithoutMeasures: z.number().int().min(0),
  })
  .meta({ id: "SafeguardingMeasures" });
export type SafeguardingMeasures = z.infer<typeof SafeguardingMeasures>;
