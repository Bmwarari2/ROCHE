/**
 * Duty of candour (safety.md section 4 rule 5; SAFE-007; ADR-0021). Regulation 20 of the Health and
 * Social Care Act 2008 (Regulated Activities) Regulations 2014 (legislation.gov.uk, read 11 October
 * 2026). An adult social care provider is "any other registered person", so the notifiable safety
 * incident is defined by reg 20(9), not reg 20(8) (which is for health service bodies).
 *
 * - 20(2) "As soon as reasonably practicable after becoming aware that a notifiable safety incident
 *   has occurred": notify the relevant person and give reasonable support.
 * - 20(3) the notification is given in person, gives a true account of the facts known, advises
 *   what further enquiries are appropriate, includes an apology and is recorded in writing.
 * - 20(4) it is followed by a written notification with that account, the enquiries, their results
 *   and an apology. The regulation sets no number of days: Harbour shows a tenant target
 *   (`candour.written_notification.working_days`, ADR-0021), never "statutory deadline".
 * - 20(5) if the relevant person cannot be contacted in person or declines to speak, (2) to (4) do
 *   not apply and a written record of the attempts is kept. 20(6) copies of all correspondence.
 */

import { defineWorkflow } from "../platform/workflow";
import { type BankHolidays, workingDaysDeadline } from "../shared/working-days";
import type { SafetyRates } from "./rates";

export type CandourState =
  | "threshold_assessment"
  | "not_notifiable"
  | "verbal_due"
  | "no_contact"
  | "written_due"
  | "enquiries_open"
  | "closed";

/** The steps of the candour record (master prompt 11.1 candour log). */
export const CANDOUR_WORKFLOW = defineWorkflow<CandourState>({
  key: "safety.candour",
  version: 1,
  states: [
    "threshold_assessment",
    "not_notifiable",
    "verbal_due",
    "no_contact",
    "written_due",
    "enquiries_open",
    "closed",
  ],
  initial: "threshold_assessment",
  terminal: ["not_notifiable", "no_contact", "closed"],
  transitions: [
    { from: "threshold_assessment", to: "verbal_due", permission: "safety.incident.manage" },
    {
      from: "threshold_assessment",
      to: "not_notifiable",
      permission: "safety.incident.manage",
      requiresReason: true,
    },
    { from: "verbal_due", to: "written_due", permission: "safety.incident.manage" },
    {
      from: "verbal_due",
      to: "no_contact",
      permission: "safety.incident.manage",
      requiresReason: true,
    },
    { from: "written_due", to: "enquiries_open", permission: "safety.incident.manage" },
    {
      from: ["written_due", "enquiries_open"],
      to: "closed",
      permission: "safety.incident.manage",
      requiresReason: true,
    },
  ],
});

export interface CandourRecordView {
  readonly threshold: {
    readonly notifiable: boolean;
    readonly decidedAt: Date;
    /** The health care professional whose opinion the decision records. */
    readonly decidedBy: string;
  } | null;
  /** 20(3). */
  readonly verbal: {
    readonly at: Date;
    readonly byRepresentatives: readonly string[];
    readonly inPerson: boolean;
    readonly accountGiven: boolean;
    readonly enquiriesAdvised: boolean;
    readonly apologyGiven: boolean;
    readonly writtenRecordId: string | null;
  } | null;
  /** 20(5)(b). */
  readonly contactAttempts: readonly { readonly at: Date; readonly note: string }[];
  /** 20(4). */
  readonly written: {
    readonly sentAt: Date;
    readonly documentId: string | null;
    readonly includesAccount: boolean;
    readonly includesEnquiries: boolean;
    readonly includesApology: boolean;
  } | null;
  /** 20(4)(c): the results of further enquiries, shared with the relevant person. */
  readonly enquiryResultsSharedAt: Date | null;
  /** 20(6). */
  readonly correspondenceDocumentIds: readonly string[];
}

/** What a candour step needs before it can be taken, in the regulation's terms. */
export function candourStepProblems(to: CandourState, record: CandourRecordView): string[] {
  const problems: string[] = [];
  switch (to) {
    case "verbal_due":
    case "not_notifiable":
      if (!record.threshold) problems.push("Record the threshold decision and who made it.");
      else if (record.threshold.notifiable !== (to === "verbal_due")) {
        problems.push("The threshold decision does not match this step.");
      }
      break;
    case "written_due": {
      const v = record.verbal;
      if (!v) {
        problems.push("Record the notification given in person.");
        break;
      }
      if (!v.inPerson) problems.push("The notification must be given in person (reg 20(3)(a)).");
      if (v.byRepresentatives.length === 0)
        problems.push("Record who gave the notification (reg 20(3)(a)).");
      if (!v.accountGiven) problems.push("Give an account of all the facts known (reg 20(3)(b)).");
      if (!v.enquiriesAdvised)
        problems.push("Advise what further enquiries are appropriate (reg 20(3)(c)).");
      if (!v.apologyGiven) problems.push("Include an apology (reg 20(3)(d)).");
      if (!v.writtenRecordId)
        problems.push("Keep a written record of the notification (reg 20(3)(e)).");
      break;
    }
    case "no_contact":
      if (record.contactAttempts.length === 0) {
        problems.push(
          "Keep a written record of the attempts to contact or speak to the person (reg 20(5)(b)).",
        );
      }
      break;
    case "enquiries_open":
    case "closed": {
      const w = record.written;
      if (!w) {
        problems.push("Record the written notification (reg 20(4)).");
        break;
      }
      if (!w.documentId) problems.push("Keep a copy of the written notification (reg 20(6)).");
      if (!w.includesAccount)
        problems.push(
          "The written notification must include the account of the facts (reg 20(4)(a)).",
        );
      if (!w.includesEnquiries)
        problems.push(
          "The written notification must give details of the enquiries (reg 20(4)(b)).",
        );
      if (!w.includesApology)
        problems.push("The written notification must include an apology (reg 20(4)(d)).");
      if (to === "closed" && !record.enquiryResultsSharedAt) {
        problems.push("Share the results of any further enquiries (reg 20(4)(c)).");
      }
      if (to === "closed" && record.correspondenceDocumentIds.length === 0) {
        problems.push("Keep a copy of all correspondence (reg 20(6)).");
      }
      break;
    }
    default:
      break;
  }
  return problems;
}

/** The shortest reason for a threshold decision that differs from Harbour's finding (HZ-091). */
export const CANDOUR_REASON_MIN = 20;

/** What Harbour found about the duty of candour on the answers recorded, before any decision. */
export type CandourFinding = "notifiable" | "notNotifiable" | "waiting";

/**
 * Harbour's finding from a classification made before any threshold decision: a candour output
 * (it may be notifiable), waiting for answers, or excluded (not notifiable). Null otherwise. Once
 * a decision is recorded the classifier follows it, so the finding is read only before one.
 */
export function candourFindingOf(
  result: {
    readonly outputs: readonly { readonly kind: string }[];
    readonly pending: readonly { readonly kind: string }[];
    readonly exclusions: readonly { readonly kind: string }[];
  } | null,
): CandourFinding | null {
  if (!result) return null;
  if (result.outputs.some((o) => o.kind === "candour")) return "notifiable";
  if (result.pending.some((p) => p.kind === "candour")) return "waiting";
  if (result.exclusions.some((e) => e.kind === "candour")) return "notNotifiable";
  return null;
}

/**
 * Whether a threshold decision needs a confirmation and a reason (#120 review M4, round 2 M3): it
 * changes a decision already recorded, or it differs from Harbour's finding.
 */
export function candourDecisionNeedsReason(
  notifiable: boolean,
  finding: CandourFinding | null,
  previous: boolean | null,
): boolean {
  if (previous !== null) return previous !== notifiable;
  return (finding === "notifiable" && !notifiable) || (finding === "notNotifiable" && notifiable);
}

/** What a decision that needs a reason still lacks: the reason, and the confirmation. */
export function candourReasonProblems(
  reason: string | null | undefined,
  confirmed: boolean | null | undefined,
): string[] {
  const problems: string[] = [];
  if ((reason?.trim().length ?? 0) < CANDOUR_REASON_MIN) {
    problems.push(
      `Say why in at least ${CANDOUR_REASON_MIN} characters: the decision differs from Harbour's finding or changes the one recorded.`,
    );
  }
  if (confirmed !== true) problems.push("Confirm the decision.");
  return problems;
}

export interface CandourClocks {
  /** "As soon as reasonably practicable": shown as due from the moment the clock starts. */
  readonly verbalDueAt: Date;
  /** The tenant's target, in working days with the nation's bank holidays (ADR-0021). */
  readonly writtenTargetAt: Date;
  readonly writtenTargetWording: string;
  /** True until a threshold decision is recorded: the clock runs from the incident so it is never late. */
  readonly provisional: boolean;
}

/**
 * The candour clocks. ADR-0021: the clock starts when the incident is assessed as a notifiable
 * safety incident; before that decision it runs from `occurred_at`, which is never later.
 */
export function candourClocks(
  occurredAt: Date,
  thresholdDecidedAt: Date | null,
  rates: Pick<SafetyRates, "candourWrittenWorkingDays">,
  holidays: BankHolidays,
): CandourClocks {
  const start = thresholdDecidedAt ?? occurredAt;
  const days = rates.candourWrittenWorkingDays;
  return {
    verbalDueAt: start,
    writtenTargetAt: workingDaysDeadline(start, days, holidays),
    writtenTargetWording: `Target: written notification within ${days} working days. The law requires notification as soon as reasonably practicable.`,
    provisional: thresholdDecidedAt === null,
  };
}
