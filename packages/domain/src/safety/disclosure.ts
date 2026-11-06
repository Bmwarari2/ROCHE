/**
 * Statutory review and disclosure requests (safety.md Phase 2 rule 6; SAFE-016). Each type carries
 * its legal basis; nothing is released until a holder of `safety.disclosure.approve` who is not the
 * requester approves it; every release is logged. Access to Health Records Act 1990 requests about a
 * person who has died have a statutory answer time.
 */

import { defineWorkflow } from "../platform/workflow";
import { addUkDays } from "../shared/time";
import type { SafetyPhase2Rates } from "./phase2-rates";

/**
 * The legal basis each type relies on, copied onto the request when it is logged. Each names the
 * UK GDPR Article 6 basis and the Article 9 condition beside the statute or exemption, because a
 * DPA 2018 Schedule 2 exemption is not a lawful basis in itself (H-821, recommended answer applied
 * 31/10/2026; ICO guidance). Only new requests copy a changed wording.
 */
export const DISCLOSURE_TYPES = {
  coroner:
    "Coroners and Justice Act 2009, Schedule 5 (a coroner's notice to provide evidence or documents): UK GDPR Article 6(1)(c) legal obligation, with Article 9(2)(g) and DPA 2018 Schedule 1 paragraph 6 (statutory purposes)",
  safeguarding_adults_review:
    "Care Act 2014, sections 44 and 45 (Safeguarding Adults Review and the duty to supply information): UK GDPR Article 6(1)(c) legal obligation, with Article 9(2)(g) and DPA 2018 Schedule 1 paragraph 6 (statutory purposes)",
  domestic_homicide_review:
    "Domestic Violence, Crime and Victims Act 2004, section 9 (Domestic Homicide Review): UK GDPR Article 6(1)(c) legal obligation, with Article 9(2)(g) and DPA 2018 Schedule 1 paragraph 6 (statutory purposes)",
  police:
    "UK GDPR Article 6(1)(f) legitimate interests (or 6(1)(c) under a court order or warrant), with Article 9(2)(g) and DPA 2018 Schedule 1 paragraph 10 (preventing or detecting unlawful acts), relying on the exemption in DPA 2018 Schedule 2 paragraph 2 (crime and taxation) for the stated purpose",
  solicitor:
    "UK GDPR Article 6(1)(f) legitimate interests or 6(1)(c) legal obligation, with Article 9(2)(f) (legal claims), relying on the exemption in DPA 2018 Schedule 2 paragraph 5 (legal proceedings, legal advice and legal rights)",
  access_to_health_records:
    "Access to Health Records Act 1990 (records of a person who has died; UK GDPR does not apply to the records of the dead, so no Article 6 basis is needed)",
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

/**
 * Access to Health Records Act 1990 s.3(5): when the answer is due. `latestRecordAddedAt` is the
 * latest record of any kind added to the person's record (care notes, observations, assessments,
 * incidents, documents and the rest), never care notes alone; when it cannot be established
 * (null), the shorter period applies, so the shorter time is never missed (H-827, recommended
 * answer applied 31/10/2026).
 */
export function ahraDueAt(
  receivedAt: Date,
  latestRecordAddedAt: Date | null,
  rates: Pick<
    SafetyPhase2Rates,
    "ahraResponseDays" | "ahraRecentRecordResponseDays" | "ahraRecentRecordDays"
  >,
): { readonly dueAt: Date; readonly recent: boolean } {
  const recentFrom = addUkDays(receivedAt, -rates.ahraRecentRecordDays);
  const recent =
    latestRecordAddedAt === null || latestRecordAddedAt.getTime() >= recentFrom.getTime();
  // The period runs "beginning with" the day of the application, so that day is day one.
  const days = recent ? rates.ahraRecentRecordResponseDays : rates.ahraResponseDays;
  return { dueAt: addUkDays(receivedAt, days - 1), recent };
}

const UUID_SHAPED = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Where an issued pack is kept (exports bucket): built from UUIDs only, never a name (rule 42). */
export function disclosurePackStorageKey(
  tenantId: string,
  requestId: string,
  packId: string,
): string {
  if (![tenantId, requestId, packId].every((id) => UUID_SHAPED.test(id))) {
    throw new RangeError("Disclosure pack keys are built from UUIDs only.");
  }
  return `tenants/${tenantId.toLowerCase()}/disclosures/${requestId.toLowerCase()}/${packId.toLowerCase()}.json`;
}
