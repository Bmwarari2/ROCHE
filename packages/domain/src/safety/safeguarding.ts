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
    {
      from: "concern",
      to: "no_referral",
      permission: "safety.safeguarding.manage",
      requiresReason: true,
    },
    { from: "referred", to: "enquiry", permission: "safety.safeguarding.manage" },
    // The local authority may decide no s.42 enquiry is needed: the outcome records that.
    { from: ["referred", "enquiry"], to: "outcome", permission: "safety.safeguarding.manage" },
    {
      from: "outcome",
      to: "closed",
      permission: "safety.safeguarding.manage",
      requiresReason: true,
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
