/**
 * Whistleblowing and speaking up (safety.md Phase 2 rule 3; SAFE-012; ADR-0089 for the silo). A
 * concern is named, confidential (the Freedom to Speak Up lead knows who) or anonymous (no identity
 * kept, a reply token instead). The outcome is shared with whoever raised it before the concern
 * closes, unless they are anonymous and left no way to reply.
 */

import { defineWorkflow } from "../platform/workflow";
import { type BankHolidays, workingDaysDeadline } from "../shared/working-days";
import type { SafetyPhase2Rates } from "./phase2-rates";

export type SpeakUpState =
  | "received"
  | "acknowledged"
  | "under_review"
  | "outcome_shared"
  | "closed";

/**
 * `safety.whistleblowing.read` is the catalogue's only speak-up permission today; slice 24 adds the
 * Freedom to Speak Up lead's own permission and RLS silo (ADR-0089) and this definition moves to it.
 */
export const SPEAK_UP_WORKFLOW = defineWorkflow<SpeakUpState>({
  key: "safety.speak_up",
  version: 1,
  states: ["received", "acknowledged", "under_review", "outcome_shared", "closed"],
  initial: "received",
  terminal: ["closed"],
  transitions: [
    { from: "received", to: "acknowledged", permission: "safety.whistleblowing.read" },
    { from: "acknowledged", to: "under_review", permission: "safety.whistleblowing.read" },
    { from: "under_review", to: "outcome_shared", permission: "safety.whistleblowing.read" },
    {
      from: ["under_review", "outcome_shared"],
      to: "closed",
      permission: "safety.whistleblowing.read",
      requiresReason: true,
    },
  ],
});

export type SpeakUpIdentity =
  | { readonly kind: "named"; readonly tenantUserId: string }
  | { readonly kind: "confidential"; readonly tenantUserId: string }
  | { readonly kind: "anonymous"; readonly replyTokenHash: string | null };

/**
 * What is stored about who raised it: nothing at all for an anonymous concern, whatever the form
 * sent. The caller stores the result, never the raw input.
 */
export function storedIdentity(identity: SpeakUpIdentity): SpeakUpIdentity {
  return identity.kind === "anonymous"
    ? { kind: "anonymous", replyTokenHash: identity.replyTokenHash }
    : identity;
}

/** Whether the outcome can be shared with whoever raised the concern. */
export function canReply(identity: SpeakUpIdentity): boolean {
  return identity.kind !== "anonymous" || identity.replyTokenHash !== null;
}

export function speakUpCloseProblems(
  identity: SpeakUpIdentity,
  outcomeSharedAt: Date | null,
): string[] {
  if (canReply(identity) && !outcomeSharedAt) {
    return ["Tell the person who raised the concern what happened before closing it."];
  }
  return [];
}

export function speakUpAcknowledgeTarget(
  receivedAt: Date,
  rates: Pick<SafetyPhase2Rates, "whistleblowingAcknowledgeWorkingDays">,
  holidays: BankHolidays,
): Date {
  return workingDaysDeadline(receivedAt, rates.whistleblowingAcknowledgeWorkingDays, holidays);
}
