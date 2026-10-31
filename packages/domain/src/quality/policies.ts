/**
 * The policy library and read-and-sign (quality.md section 17, rules 25 to 28; QUAL-008; Reg 17):
 * versions with review dates, publication with a second reviewer where the tenant asks, who must
 * read each version by role, which signatures still count after a minor or major change, reminders
 * and review status. Pure functions; figures from the rate table.
 */

import { defineWorkflow } from "../platform/workflow";
import { addDays, addMonths, daysBetween, isIsoDate } from "./quality-dates";
import type { QualityPhase2Rates } from "./quality-rates";

export type PolicyState = "draft" | "published" | "superseded" | "retired";
export type PolicyChange = "minor" | "major";

/** Rule 25: draft to published to superseded (by the next version) or retired. */
export const POLICY_WORKFLOW = defineWorkflow<PolicyState>({
  key: "quality.policy_version",
  version: 1,
  states: ["draft", "published", "superseded", "retired"],
  initial: "draft",
  terminal: ["superseded", "retired"],
  transitions: [
    { from: "draft", to: "published", permission: "quality.policy.manage" },
    { from: "published", to: "superseded", permission: "quality.policy.manage" },
    { from: "published", to: "retired", permission: "quality.policy.manage", requiresReason: true },
  ],
});

export interface PolicyVersion {
  readonly policyKey: string;
  readonly version: number;
  readonly state: PolicyState;
  readonly change: PolicyChange;
  readonly authorId: string;
  /** UK dates. */
  readonly publishedOn: string | null;
  readonly reviewDueOn: string | null;
  /** Roles whose holders must read and sign it. */
  readonly roles: readonly string[];
}

export type PolicyPublicationProblem =
  | "missing_permission"
  | "not_draft"
  | "no_roles"
  | "review_date_missing"
  | "review_date_not_after_publication"
  | "review_date_too_far"
  | "second_reviewer_required";

export const POLICY_PUBLICATION_MESSAGES: Readonly<Record<PolicyPublicationProblem, string>> = {
  missing_permission: "Only someone who manages policies can publish one.",
  not_draft: "Only a draft can be published.",
  no_roles: "Choose at least one role that must read it.",
  review_date_missing: "Set a review date.",
  review_date_not_after_publication: "The review date must be after the publication date.",
  review_date_too_far: "The review date is further away than your organisation allows.",
  second_reviewer_required: "Someone other than its author must publish this policy.",
};

/** Rule 25: why a draft cannot be published on a UK date, in order; empty when it can. */
export function checkPolicyPublication(
  draft: PolicyVersion,
  publication: {
    readonly publisherId: string;
    readonly publishedOn: string;
    readonly permissions: readonly string[];
    readonly requireSecondReviewer: boolean;
  },
  rates: Pick<QualityPhase2Rates, "policyReviewIntervalMonthsMax">,
): PolicyPublicationProblem[] {
  const problems: PolicyPublicationProblem[] = [];
  if (!publication.permissions.includes("quality.policy.manage"))
    problems.push("missing_permission");
  if (draft.state !== "draft") problems.push("not_draft");
  if (draft.roles.length === 0) problems.push("no_roles");
  if (draft.reviewDueOn === null || !isIsoDate(draft.reviewDueOn)) {
    problems.push("review_date_missing");
  } else if (draft.reviewDueOn <= publication.publishedOn) {
    problems.push("review_date_not_after_publication");
  } else if (
    draft.reviewDueOn > addMonths(publication.publishedOn, rates.policyReviewIntervalMonthsMax)
  ) {
    problems.push("review_date_too_far");
  }
  if (publication.requireSecondReviewer && publication.publisherId === draft.authorId) {
    problems.push("second_reviewer_required");
  }
  return problems;
}

export interface StaffMember {
  readonly id: string;
  readonly roles: readonly string[];
  /** UK date they started holding their roles, and left (null while in post). */
  readonly startedOn: string;
  readonly leftOn: string | null;
}

export interface PolicySignature {
  readonly staffId: string;
  readonly policyKey: string;
  readonly version: number;
  readonly signedOn: string;
}

export interface Outstanding {
  readonly staffId: string;
  /** UK date they had to sign from: publication, or when they started if later. */
  readonly dueFrom: string;
}

export interface ReadAndSignStatus {
  readonly required: readonly string[];
  readonly signed: readonly string[];
  readonly outstanding: readonly Outstanding[];
}

/**
 * Rule 26: who must read and sign the published version, who has, and who is outstanding since
 * when. A signature on this version counts; after a minor change a signature on the version it
 * superseded still counts; after a major change it does not. People who have left are not counted.
 */
export function readAndSignStatus(
  current: PolicyVersion,
  previous: PolicyVersion | null,
  staff: readonly StaffMember[],
  signatures: readonly PolicySignature[],
  on: string,
): ReadAndSignStatus {
  if (current.state !== "published" || current.publishedOn === null) {
    return { required: [], signed: [], outstanding: [] };
  }
  const publishedOn = current.publishedOn;
  const counting = new Set([current.version]);
  if (current.change === "minor" && previous !== null) counting.add(previous.version);
  const roles = new Set(current.roles);
  const required = staff.filter(
    (s) =>
      s.roles.some((r) => roles.has(r)) &&
      s.startedOn <= on &&
      (s.leftOn === null || s.leftOn > on),
  );
  const signedIds = new Set(
    signatures
      .filter((sig) => sig.policyKey === current.policyKey && counting.has(sig.version))
      .map((sig) => sig.staffId),
  );
  return {
    required: required.map((s) => s.id),
    signed: required.filter((s) => signedIds.has(s.id)).map((s) => s.id),
    outstanding: required
      .filter((s) => !signedIds.has(s.id))
      .map((s) => ({
        staffId: s.id,
        dueFrom: s.startedOn > publishedOn ? s.startedOn : publishedOn,
      })),
  };
}

/**
 * Rule 27: the outstanding people due a reminder on a UK date: `policy.read_and_sign.reminder_days`
 * or more since their last reminder, or since they became due when never reminded.
 */
export function readAndSignRemindersDue(
  outstanding: readonly Outstanding[],
  lastReminded: Readonly<Record<string, string | undefined>>,
  on: string,
  rates: Pick<QualityPhase2Rates, "readAndSignReminderDays">,
): string[] {
  return outstanding
    .filter(
      (o) => daysBetween(lastReminded[o.staffId] ?? o.dueFrom, on) >= rates.readAndSignReminderDays,
    )
    .map((o) => o.staffId);
}

export type PolicyReviewStatus = "current" | "due_soon" | "overdue" | "no_review_date";

/** Rule 28: where a policy stands against its review date on a UK date. */
export function policyReviewStatus(
  version: Pick<PolicyVersion, "reviewDueOn">,
  on: string,
  rates: Pick<QualityPhase2Rates, "policyReviewDueSoonDays">,
): PolicyReviewStatus {
  if (version.reviewDueOn === null) return "no_review_date";
  if (on > version.reviewDueOn) return "overdue";
  if (on >= addDays(version.reviewDueOn, -rates.policyReviewDueSoonDays)) return "due_soon";
  return "current";
}
