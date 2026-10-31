/**
 * Statutory review and disclosure requests (safety.md Phase 2 rule 6; SAFE-016). Each type carries
 * its legal basis; nothing is released until a holder of `safety.disclosure.approve` who is not the
 * requester approves it; every release is logged. Access to Health Records Act 1990 requests about a
 * person who has died have a statutory answer time.
 */

import { defineWorkflow } from "../platform/workflow";
import { addUkDays } from "../shared/time";
import type { SafetyPhase2Rates } from "./phase2-rates";

export const DISCLOSURE_TYPES = {
  coroner:
    "Coroners and Justice Act 2009, Schedule 5 (a coroner's notice to provide evidence or documents)",
  safeguarding_adults_review:
    "Care Act 2014, sections 44 and 45 (Safeguarding Adults Review and the duty to supply information)",
  domestic_homicide_review:
    "Domestic Violence, Crime and Victims Act 2004, section 9 (Domestic Homicide Review)",
  police:
    "Data Protection Act 2018, Schedule 2, paragraph 2 (crime and taxation: prevention or detection of crime)",
  solicitor:
    "Data Protection Act 2018, Schedule 2, paragraph 5 (legal proceedings, legal advice and legal rights)",
  access_to_health_records: "Access to Health Records Act 1990 (records of a person who has died)",
} as const;

export type DisclosureType = keyof typeof DISCLOSURE_TYPES;

export type DisclosureState =
  | "requested"
  | "prepared"
  | "approved"
  | "released"
  | "refused"
  | "withdrawn";

export const DISCLOSURE_WORKFLOW = defineWorkflow<DisclosureState>({
  key: "safety.disclosure",
  version: 1,
  states: ["requested", "prepared", "approved", "released", "refused", "withdrawn"],
  initial: "requested",
  terminal: ["released", "refused", "withdrawn"],
  transitions: [
    { from: "requested", to: "prepared", permission: "safety.incident.manage" },
    // The approver is never the person who made the request (separation of duties).
    {
      from: "prepared",
      to: "approved",
      permission: "safety.disclosure.approve",
      distinctFromCreator: true,
    },
    {
      from: ["requested", "prepared"],
      to: "refused",
      permission: "safety.disclosure.approve",
      distinctFromCreator: true,
      requiresReason: true,
    },
    { from: "approved", to: "released", permission: "safety.incident.manage" },
    {
      from: ["requested", "prepared", "approved"],
      to: "withdrawn",
      permission: "safety.incident.manage",
      requiresReason: true,
    },
  ],
});

export interface DisclosureRequestView {
  readonly type: DisclosureType;
  readonly requester: { readonly name: string; readonly organisation: string } | null;
  /** For police and solicitor requests: what the request says it is for. */
  readonly statedPurpose: string | null;
  readonly itemsDocumentIds: readonly string[];
}

export function disclosurePrepareProblems(request: DisclosureRequestView): string[] {
  const problems: string[] = [];
  if (!request.requester?.name.trim() || !request.requester.organisation.trim()) {
    problems.push("Record who asked and for which organisation.");
  }
  if (
    (request.type === "police" || request.type === "solicitor") &&
    !request.statedPurpose?.trim()
  ) {
    problems.push(
      "Record what the request says the information is for: the exemption depends on it.",
    );
  }
  if (request.itemsDocumentIds.length === 0) problems.push("Add what is to be disclosed.");
  return problems;
}

export function legalBasis(type: DisclosureType): string {
  return DISCLOSURE_TYPES[type];
}

/** Access to Health Records Act 1990 s.3(5): when the answer is due. */
export function ahraDueAt(
  receivedAt: Date,
  latestRecordAddedAt: Date,
  rates: Pick<
    SafetyPhase2Rates,
    "ahraResponseDays" | "ahraRecentRecordResponseDays" | "ahraRecentRecordDays"
  >,
): { readonly dueAt: Date; readonly recent: boolean } {
  const recentFrom = addUkDays(receivedAt, -rates.ahraRecentRecordDays);
  const recent = latestRecordAddedAt.getTime() >= recentFrom.getTime();
  return {
    dueAt: addUkDays(
      receivedAt,
      recent ? rates.ahraRecentRecordResponseDays : rates.ahraResponseDays,
    ),
    recent,
  };
}
