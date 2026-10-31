/**
 * The safeguarding log (safety.md Phase 2 rule 1; SAFE-006; Care Act 2014 s.42 and the statutory
 * guidance, chapter 14; Making Safeguarding Personal; the DBS referral duty under the Safeguarding
 * Vulnerable Groups Act 2006 s.35). A concern is never dropped silently: deciding not to refer needs
 * a reason. Closing needs the person's own outcomes and, where a member of staff was removed or would
 * have been for harm or risk of harm, the DBS referral decision.
 */

import { defineWorkflow } from "../platform/workflow";
import type { SafetyPhase2Rates } from "./phase2-rates";

export type SafeguardingState =
  | "concern"
  | "no_referral"
  | "referred"
  | "enquiry"
  | "outcome"
  | "closed";

export const SAFEGUARDING_WORKFLOW = defineWorkflow<SafeguardingState>({
  key: "safety.safeguarding",
  version: 1,
  states: ["concern", "no_referral", "referred", "enquiry", "outcome", "closed"],
  initial: "concern",
  terminal: ["no_referral", "closed"],
  transitions: [
    { from: "concern", to: "referred", permission: "safety.safeguarding.manage" },
    // Whoever raised the concern cannot decide alone that it is not referred, or close it
    // (HZ-126; separation of duties as for incidents; review round 1).
    {
      from: "concern",
      to: "no_referral",
      permission: "safety.safeguarding.manage",
      requiresReason: true,
      distinctFromCreator: true,
    },
    { from: "referred", to: "enquiry", permission: "safety.safeguarding.manage" },
    // The local authority may decide no s.42 enquiry is needed: the outcome records that.
    { from: ["referred", "enquiry"], to: "outcome", permission: "safety.safeguarding.manage" },
    {
      from: "outcome",
      to: "closed",
      permission: "safety.safeguarding.manage",
      requiresReason: true,
      distinctFromCreator: true,
    },
  ],
});

export const ENQUIRY_FINDINGS = [
  "substantiated",
  "partly_substantiated",
  "not_substantiated",
  "inconclusive",
  "no_s42_enquiry",
] as const;

export type EnquiryFinding = (typeof ENQUIRY_FINDINGS)[number];

export interface SafeguardingRecordView {
  readonly referral: {
    readonly localAuthority: string;
    readonly method: "phone" | "online_form" | "email" | "in_person";
    readonly referredAt: Date;
    readonly reference: string | null;
  } | null;
  readonly enquiry: {
    readonly kind: "s42_local_authority" | "s42_caused_to_provider";
    readonly openedAt: Date;
  } | null;
  readonly finding: EnquiryFinding | null;
  /** Making Safeguarding Personal. */
  readonly personalOutcomes: {
    readonly asked: boolean;
    readonly notAskedReason: string | null;
    readonly desiredOutcomes: string | null;
    readonly achieved: "fully" | "partly" | "not" | null;
  } | null;
  /** A member of staff removed from regulated activity, or who would have been, for harm or risk. */
  readonly staffRemovedForHarm: boolean;
  readonly dbsReferral: {
    readonly decision: "referred" | "not_required";
    readonly reason: string | null;
    readonly at: Date;
  } | null;
}

/** The DBS referral duty (SVGA 2006 s.35) applies however the concern ends (clinical review). */
function dbsProblems(record: SafeguardingRecordView, problems: string[]): void {
  if (!record.staffRemovedForHarm) return;
  const dbs = record.dbsReferral;
  if (!dbs) {
    problems.push(
      "Record the DBS referral decision: a member of staff was removed, or would have been, for harm or risk of harm.",
    );
  } else if (dbs.decision === "not_required" && !dbs.reason?.trim()) {
    problems.push("Say why a DBS referral is not required.");
  }
}

/** What a step needs before it can be taken. */
export function safeguardingStepProblems(
  to: SafeguardingState,
  record: SafeguardingRecordView,
): string[] {
  const problems: string[] = [];
  switch (to) {
    case "referred":
      if (!record.referral)
        problems.push("Record the referral: the local authority, how and when.");
      else if (!record.referral.localAuthority.trim())
        problems.push("Name the local authority referred to.");
      break;
    case "enquiry":
      if (!record.enquiry)
        problems.push(
          "Record the enquiry: by the local authority, or caused to the provider, and when it opened.",
        );
      break;
    case "outcome":
      if (!record.finding)
        problems.push(
          "Record the enquiry's finding, or that the local authority made no s.42 enquiry.",
        );
      break;
    case "no_referral":
      dbsProblems(record, problems);
      break;
    case "closed": {
      const mine = record.personalOutcomes;
      if (!mine) {
        problems.push(
          "Record what the person wanted from the enquiry and whether it was achieved (Making Safeguarding Personal).",
        );
      } else if (mine.asked) {
        if (!mine.desiredOutcomes?.trim()) problems.push("Record what the person wanted.");
        if (!mine.achieved)
          problems.push("Record whether what they wanted was achieved fully, partly or not.");
      } else if (!mine.notAskedReason?.trim()) {
        problems.push(
          "Say why the person, or an advocate for them, was not asked what they wanted.",
        );
      }
      dbsProblems(record, problems);
      break;
    }
    default:
      break;
  }
  return problems;
}

/** The referral target (a tenant target; the law says without delay). */
export function safeguardingReferralTarget(
  raisedAt: Date,
  rates: Pick<SafetyPhase2Rates, "safeguardingReferralHours">,
): {
  readonly dueAt: Date;
  readonly wording: string;
} {
  const hours = rates.safeguardingReferralHours;
  return {
    dueAt: new Date(raisedAt.getTime() + hours * 3_600_000),
    wording: `Target: refer within ${hours} hours. The law says refer without delay.`,
  };
}

/** States in which the concern is still open: the clock runs, and the protective measures apply. */
export const OPEN_SAFEGUARDING_STATES: readonly SafeguardingState[] = [
  "concern",
  "referred",
  "enquiry",
  "outcome",
];

export type SafeguardingClockStatus = "due" | "overdue" | "referred" | "not_referred";

export interface SafeguardingClock {
  readonly status: SafeguardingClockStatus;
  readonly dueAt: Date;
  /** Shown beside the clock: the target, and that the law says without delay. */
  readonly wording: string;
}

/**
 * The referral clock (HZ-126, HZ-013): due until the target passes, then overdue, until the concern
 * is referred or a reason is recorded for not referring. Past the target it stays overdue: it is
 * never closed by the clock itself.
 */
export function safeguardingClock(
  state: SafeguardingState,
  referralDueAt: Date,
  now: Date,
  rates: Pick<SafetyPhase2Rates, "safeguardingReferralHours">,
): SafeguardingClock {
  const wording = `Target: refer within ${rates.safeguardingReferralHours} hours. The law says refer without delay.`;
  if (state === "no_referral") return { status: "not_referred", dueAt: referralDueAt, wording };
  if (state !== "concern") return { status: "referred", dueAt: referralDueAt, wording };
  return {
    status: now.getTime() >= referralDueAt.getTime() ? "overdue" : "due",
    dueAt: referralDueAt,
    wording,
  };
}

export interface SafeguardingMeasuresSource {
  readonly state: SafeguardingState;
  readonly protectiveMeasures: string | null;
  readonly protectiveMeasuresUpdatedAt: Date | null;
}

export interface SafeguardingMeasure {
  readonly text: string;
  readonly updatedAt: Date;
}

/**
 * What staff caring for the person see (HZ-126): the protective measures of every open concern,
 * newest change first, and nothing about the allegation itself. An open concern with no measures
 * recorded is counted, so the screen can say measures are not recorded rather than show nothing.
 */
export function protectiveMeasuresFor(concerns: readonly SafeguardingMeasuresSource[]): {
  readonly measures: readonly SafeguardingMeasure[];
  readonly openWithoutMeasures: number;
} {
  const open = concerns.filter((c) => OPEN_SAFEGUARDING_STATES.includes(c.state));
  const measures = open
    .filter((c) => c.protectiveMeasures?.trim() && c.protectiveMeasuresUpdatedAt)
    .map((c) => ({
      text: (c.protectiveMeasures ?? "").trim(),
      updatedAt: c.protectiveMeasuresUpdatedAt as Date,
    }))
    .sort((x, y) => y.updatedAt.getTime() - x.updatedAt.getTime());
  return { measures, openWithoutMeasures: open.length - measures.length };
}

/**
 * Whether a member of staff was involved and removed from regulated activity for harm or risk of
 * harm (SVGA 2006 s.35, which also covers someone who left before they could be removed).
 */
export const STAFF_HARM_ANSWERS = [
  "removed",
  "would_have_removed",
  "not_removed",
  "no_staff_involved",
] as const;

export type StaffHarmAnswer = (typeof STAFF_HARM_ANSWERS)[number];

/** The DBS referral question applies (removed, or would have been). */
export function staffRemovedForHarm(answer: StaffHarmAnswer | null): boolean {
  return answer === "removed" || answer === "would_have_removed";
}

/** Where the protective measures go when a concern ends. */
export const MEASURES_OUTCOMES = ["carried_into_care_plan", "no_longer_needed"] as const;

export type MeasuresOutcome = (typeof MEASURES_OUTCOMES)[number];

export interface SafeguardingLogFacts {
  readonly staffHarm: StaffHarmAnswer | null;
  readonly mspAsked: boolean | null;
  readonly mspNotAskedReason: string | null;
  readonly mspDesiredOutcomes: string | null;
  readonly protectiveMeasures: string | null;
  readonly measuresOutcome: MeasuresOutcome | null;
}

/**
 * The safeguarding log's own step rules (slice 13 clinical review round 1; HZ-126), checked with
 * `safeguardingStepProblems`:
 * - Making Safeguarding Personal starts at the beginning: before the referral decision (referred or
 *   not referred), the person or an advocate was asked what they want, and it is recorded, or why
 *   they were not asked.
 * - The staff question is answered before the outcome and before the concern ends, so the DBS
 *   referral duty is never skipped by a default.
 * - Protective measures never vanish when a concern ends: someone decides whether they were carried
 *   into the care plan or risk assessment, or are no longer needed.
 */
export function safeguardingLogProblems(
  to: SafeguardingState,
  facts: SafeguardingLogFacts,
): string[] {
  const problems: string[] = [];
  if (to === "referred" || to === "no_referral") {
    if (facts.mspAsked === null) {
      problems.push(
        "Record whether the person, or an advocate for them, was asked what they want (Making Safeguarding Personal).",
      );
    } else if (facts.mspAsked && !facts.mspDesiredOutcomes?.trim()) {
      problems.push("Record what the person wants.");
    } else if (!facts.mspAsked && !facts.mspNotAskedReason?.trim()) {
      problems.push("Say why the person, or an advocate for them, was not asked what they want.");
    }
  }
  if ((to === "outcome" || to === "no_referral" || to === "closed") && facts.staffHarm === null) {
    problems.push(
      "Say whether a member of staff was involved and removed from their work with people, or would have been, because of harm or a risk of harm.",
    );
  }
  if (
    (to === "no_referral" || to === "closed") &&
    facts.protectiveMeasures?.trim() &&
    facts.measuresOutcome === null
  ) {
    problems.push(
      "Say whether the protective measures were carried into the care plan or risk assessment, or are no longer needed.",
    );
  }
  return problems;
}
