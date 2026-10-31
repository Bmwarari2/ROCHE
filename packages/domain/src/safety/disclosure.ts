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

/**
 * How a released pack reaches the recipient (H-958, recommended answer applied 31/10/2026): only
 * through a secure route, never ordinary email. The pack leaves Harbour once, as a PDF carrying
 * its fingerprint, downloaded with a fresh step-up; the hand-over is then recorded with its date
 * and route.
 */
export const DISCLOSURE_HAND_OVER_ROUTES = {
  secure_portal: "The recipient's secure portal or upload service",
  secure_email: "A secure email service the recipient names (for example NHSmail or CJSM)",
  encrypted_media: "Encrypted media, with the password sent separately",
  in_person: "By hand, to the recipient in person",
  recorded_delivery: "Recorded or special delivery post",
} as const;
export type DisclosureHandOverRoute = keyof typeof DISCLOSURE_HAND_OVER_ROUTES;

export type HandOverProblem =
  | "not_released"
  | "not_downloaded"
  | "already_handed_over"
  | "before_release"
  | "in_future"
  | "reference_too_long";

export const HAND_OVER_PROBLEM_MESSAGES: Record<HandOverProblem, string> = {
  not_released: "Only a released pack can be handed over.",
  not_downloaded: "Download the pack before recording how it was handed over.",
  already_handed_over: "The hand-over is already recorded.",
  before_release: "The hand-over cannot be before the pack was released.",
  in_future: "The hand-over cannot be in the future.",
  reference_too_long: "Keep the reference to 200 characters.",
};

/** The checks on recording a hand-over (the database holds the same rules again). */
export function handOverProblems(
  request: {
    readonly state: string;
    readonly releasedAt: Date | null;
    readonly packDownloadedAt: Date | null;
    readonly handedOverAt: Date | null;
  },
  input: { readonly at: Date; readonly reference: string | null },
  now: Date,
  clockDriftMs: number,
): HandOverProblem[] {
  const problems: HandOverProblem[] = [];
  if (request.state !== "released" || !request.releasedAt) return ["not_released"];
  if (request.handedOverAt) return ["already_handed_over"];
  if (!request.packDownloadedAt) problems.push("not_downloaded");
  if (input.at.getTime() < request.releasedAt.getTime()) problems.push("before_release");
  if (input.at.getTime() > now.getTime() + clockDriftMs) problems.push("in_future");
  if ((input.reference?.trim().length ?? 0) > 200) problems.push("reference_too_long");
  return problems;
}
