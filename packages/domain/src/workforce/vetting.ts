import type { HealthResult } from "../integrations/ports";
import type { ComplianceDetail } from "./staff-file";

/**
 * Identity and vetting adapters (workforce.md section 2e and rule 24; WORK-002; ADR-0094; plan
 * slice 77). Four ports give the staff file's checks an electronic route:
 *
 * - a certified identity service provider (IDSP) for right to work checks;
 * - a DBS e-bulk route (a registered or umbrella body) for applications;
 * - the DBS Update Service for status checks of a subscribed certificate;
 * - the NMC register, for the PIN of a registered nurse.
 *
 * Manual entry with uploaded evidence stays the default. Each port is off until the organisation
 * configures a provider for it, and no provider is chosen yet (H-521 to H-523), so the only
 * adapter is the contract-tested mock, which never runs in production. An adapter's result
 * changes nothing by itself: a holder of `workforce.staff_file.manage` applies it to the staff
 * file, which verifies the item in their name on the check's date and records the check as the
 * item's source. A DBS result carries the certificate's level, number, issue date and whether it
 * is clear, never anything the certificate disclosed (criminal offence data, Article 10 UK GDPR).
 */

/** The ports, named as `integration_connection.port`. */
export const VETTING_PORTS = [
  "workforce.idsp",
  "workforce.dbs_ebulk",
  "workforce.dbs_update_service",
  "workforce.nmc_register",
] as const;
export type VettingPort = (typeof VETTING_PORTS)[number];

/** The checks an adapter makes. */
export const VETTING_CHECK_KINDS = [
  "idsp_right_to_work",
  "dbs_application",
  "dbs_status_check",
  "nmc_register_check",
] as const;
export type VettingCheckKind = (typeof VETTING_CHECK_KINDS)[number];

export const PORT_OF_CHECK: Readonly<Record<VettingCheckKind, VettingPort>> = {
  idsp_right_to_work: "workforce.idsp",
  dbs_application: "workforce.dbs_ebulk",
  dbs_status_check: "workforce.dbs_update_service",
  nmc_register_check: "workforce.nmc_register",
};

/** The staff file item each check is evidence for. */
export const ITEM_OF_CHECK = {
  idsp_right_to_work: "right_to_work",
  dbs_application: "dbs_certificate",
  dbs_status_check: "dbs_certificate",
  nmc_register_check: "professional_registration",
} as const satisfies Record<VettingCheckKind, ComplianceDetail["kind"]>;

/** Where a compliance item's evidence came from: seen by hand (the default) or a check. */
export const EVIDENCE_SOURCES = ["manual", ...VETTING_CHECK_KINDS] as const;
export type EvidenceSource = (typeof EVIDENCE_SOURCES)[number];

/** What the worker consents to (recorded by HR, with its date; withdrawable). */
export const VETTING_CONSENT_PURPOSES = ["dbs_application", "dbs_update_service"] as const;
export type VettingConsentPurpose = (typeof VETTING_CONSENT_PURPOSES)[number];

/** The consent a check needs, if any. */
export const CONSENT_FOR_CHECK: Readonly<Record<VettingCheckKind, VettingConsentPurpose | null>> = {
  idsp_right_to_work: null,
  dbs_application: "dbs_application",
  dbs_status_check: "dbs_update_service",
  nmc_register_check: null,
};

/**
 * The documents an IDSP may check for right to work (Home Office employer's guide): a valid
 * British or Irish passport, or an Irish passport card. Everyone else is checked with the Home
 * Office online share code, or by hand.
 */
export const IDSP_DOCUMENTS = [
  "british_passport",
  "irish_passport",
  "irish_passport_card",
] as const;
export type IdspDocument = (typeof IDSP_DOCUMENTS)[number];

// ---------------------------------------------------------------------------------------------
// The ports. Each request carries an opaque reference (the check's id), so a retry is the same
// request; each answer is pending, completed with a result, or failed.

export type VettingAnswer<R> =
  | { readonly state: "pending"; readonly externalReference: string }
  | { readonly state: "completed"; readonly externalReference: string; readonly result: R }
  | { readonly state: "failed"; readonly retryable: boolean; readonly error: string };

export interface VettingAdapter<Q, R> {
  readonly provider: string;
  /** Starts the check; the same `reference` twice is the same check. */
  start(request: Q): Promise<VettingAnswer<R>>;
  /** Asks again about a pending check. */
  status(externalReference: string): Promise<VettingAnswer<R>>;
  health(): Promise<HealthResult>;
}

/** The IDSP invites the worker to prove their identity with their document in its app. */
export interface IdspRequest {
  readonly reference: string;
  /** The name the organisation knows the worker by, for the invitation; they give the rest. */
  readonly name: string;
  readonly email: string;
  readonly document: IdspDocument;
}
export type IdspResult =
  | {
      readonly outcome: "identity_verified";
      readonly checkedOn: string;
      readonly document: IdspDocument;
    }
  | { readonly outcome: "not_verified"; readonly checkedOn: string };

/** The e-bulk body invites the worker to complete their application; the employer countersigns. */
export interface DbsApplicationRequest {
  readonly reference: string;
  /** For the invitation; the worker completes the application themselves. */
  readonly name: string;
  readonly email: string;
  readonly level: "enhanced_adults_barred";
  readonly workforce: "adult";
  readonly jobTitle: string;
}
export type DbsApplicationResult =
  | {
      readonly outcome: "certificate_issued";
      readonly checkedOn: string;
      readonly issuedOn: string;
      readonly certificateNumber: string;
      readonly level: "enhanced_adults_barred";
      /** Whether the certificate holds information; never what. */
      readonly result: "clear" | "information_disclosed";
    }
  | { readonly outcome: "withdrawn"; readonly checkedOn: string };

/**
 * An Update Service status check: the certificate number, the surname as the certificate gives it
 * (typed by the checker, not stored) and the date of birth.
 */
export interface UpdateServiceRequest {
  readonly reference: string;
  readonly certificateNumber: string;
  readonly familyName: string;
  readonly dateOfBirth: string;
}
export interface UpdateServiceResult {
  readonly outcome: "no_new_information" | "new_information" | "details_not_matched";
  readonly checkedOn: string;
}

/** An NMC register check, by PIN. */
export interface NmcRegisterRequest {
  readonly reference: string;
  readonly pin: string;
}
export interface NmcRegisterResult {
  readonly outcome: "registered" | "registered_with_conditions" | "not_registered";
  readonly checkedOn: string;
  /** The day the registration runs to, when registered. */
  readonly renewalDueOn: string | null;
}

export interface VettingRequestMap {
  readonly idsp_right_to_work: IdspRequest;
  readonly dbs_application: DbsApplicationRequest;
  readonly dbs_status_check: UpdateServiceRequest;
  readonly nmc_register_check: NmcRegisterRequest;
}
export interface VettingResultMap {
  readonly idsp_right_to_work: IdspResult;
  readonly dbs_application: DbsApplicationResult;
  readonly dbs_status_check: UpdateServiceResult;
  readonly nmc_register_check: NmcRegisterResult;
}

/**
 * The only fields each port is sent (data minimisation, Article 5(1)(c)); the contract tests
 * prove the requests carry nothing else.
 */
export const VETTING_REQUEST_FIELDS: {
  readonly [K in VettingCheckKind]: readonly (keyof VettingRequestMap[K])[];
} = {
  idsp_right_to_work: ["reference", "name", "email", "document"],
  dbs_application: ["reference", "name", "email", "level", "workforce", "jobTitle"],
  dbs_status_check: ["reference", "certificateNumber", "familyName", "dateOfBirth"],
  nmc_register_check: ["reference", "pin"],
};

// ---------------------------------------------------------------------------------------------
// Rules

export interface VettingConsent {
  readonly purpose: VettingConsentPurpose;
  readonly givenOn: string;
  readonly withdrawnOn: string | null;
}

/** A consent counts from the day it was given until the day it is withdrawn. */
export function consentActive(consent: VettingConsent, today: string): boolean {
  return consent.givenOn <= today && (consent.withdrawnOn === null || consent.withdrawnOn > today);
}

export type VettingRequestProblem =
  | "own_file"
  | "adapter_off"
  | "consent_missing"
  | "idsp_document_not_eligible"
  | "no_certificate_number"
  | "not_subscribed"
  | "no_date_of_birth"
  | "registration_not_nmc"
  | "no_pin"
  | "check_open";

export interface VettingRequestFacts {
  readonly kind: VettingCheckKind;
  /** The caller is the worker. */
  readonly ownFile: boolean;
  /** The organisation has configured a provider for the check's port. */
  readonly adapterOn: boolean;
  readonly consents: readonly VettingConsent[];
  /** IDSP: the document the worker will use. */
  readonly idspDocument: string | null;
  /** The staff file's DBS item, if any. */
  readonly dbs: Extract<ComplianceDetail, { kind: "dbs_certificate" }> | null;
  readonly dateOfBirth: string | null;
  readonly registrationBody: string | null;
  /** The PIN on the file's registration item, if any. */
  readonly pin: string | null;
  /** A check of the same kind is already pending for this file. */
  readonly openCheck: boolean;
}

/** Why a check may not start today, or null (workforce.md rule 24). */
export function vettingRequestProblem(
  facts: VettingRequestFacts,
  today: string,
): VettingRequestProblem | null {
  if (facts.ownFile) return "own_file";
  if (!facts.adapterOn) return "adapter_off";
  if (facts.openCheck) return "check_open";
  const purpose = CONSENT_FOR_CHECK[facts.kind];
  if (
    purpose !== null &&
    !facts.consents.some((c) => c.purpose === purpose && consentActive(c, today))
  ) {
    return "consent_missing";
  }
  switch (facts.kind) {
    case "idsp_right_to_work":
      return IDSP_DOCUMENTS.includes(facts.idspDocument as IdspDocument)
        ? null
        : "idsp_document_not_eligible";
    case "dbs_status_check":
      if (!facts.dbs?.certificate?.number) return "no_certificate_number";
      if (!facts.dbs.updateService?.subscribed) return "not_subscribed";
      return facts.dateOfBirth ? null : "no_date_of_birth";
    case "nmc_register_check":
      if (facts.registrationBody !== "nmc") return "registration_not_nmc";
      return facts.pin ? null : "no_pin";
    default:
      return null;
  }
}

export type VettingApplyProblem =
  | "not_verified"
  | "application_withdrawn"
  | "details_not_matched"
  | "registration_has_conditions"
  | "not_registered"
  | "item_changed"
  | "checked_in_future";

export type VettingApplication =
  | { readonly ok: true; readonly detail: ComplianceDetail; readonly verifiedOn: string }
  | { readonly ok: false; readonly problem: VettingApplyProblem };

/**
 * What applying a completed check's result does to its staff file item (workforce.md rule 24).
 * The item is verified on the check's date; a result that is not evidence of the requirement
 * (not verified, withdrawn, details not matched, not registered) is never applied and the item
 * stays as it was, to be dealt with by hand. A registration with conditions is read on the
 * register and recorded by hand. `existing` is the item's current detail, if any.
 */
export function vettingApplication<K extends VettingCheckKind>(
  kind: K,
  result: VettingResultMap[K],
  existing: ComplianceDetail | null,
  today: string,
): VettingApplication {
  if (result.checkedOn > today) return { ok: false, problem: "checked_in_future" };
  const on = result.checkedOn;
  switch (kind) {
    case "idsp_right_to_work": {
      const r = result as IdspResult;
      if (r.outcome !== "identity_verified") return { ok: false, problem: "not_verified" };
      const checks = existing?.kind === "right_to_work" ? existing.checks : [];
      // A British or Irish citizen's permission to work is unlimited.
      return {
        ok: true,
        verifiedOn: on,
        detail: {
          kind: "right_to_work",
          checks: [
            ...checks,
            { method: "idsp", checkedOn: on, permission: "unlimited", expiresOn: null },
          ],
        },
      };
    }
    case "dbs_application": {
      const r = result as DbsApplicationResult;
      if (r.outcome !== "certificate_issued") {
        return { ok: false, problem: "application_withdrawn" };
      }
      const prior = existing?.kind === "dbs_certificate" ? existing : null;
      return {
        ok: true,
        verifiedOn: on,
        detail: {
          kind: "dbs_certificate",
          certificate: {
            level: r.level,
            issuedOn: r.issuedOn,
            number: r.certificateNumber,
            result: r.result,
          },
          // A new certificate is subscribed to the Update Service by the worker, separately.
          updateService: null,
          barredListClearOn: prior?.barredListClearOn ?? null,
        },
      };
    }
    case "dbs_status_check": {
      const r = result as UpdateServiceResult;
      if (r.outcome === "details_not_matched") {
        return { ok: false, problem: "details_not_matched" };
      }
      if (existing?.kind !== "dbs_certificate" || !existing.certificate) {
        return { ok: false, problem: "item_changed" };
      }
      return {
        ok: true,
        verifiedOn: on,
        detail: {
          ...existing,
          updateService: { subscribed: true, lastCheckedOn: on, lastResult: r.outcome },
        },
      };
    }
    case "nmc_register_check": {
      const r = result as NmcRegisterResult;
      if (r.outcome === "not_registered") return { ok: false, problem: "not_registered" };
      if (r.outcome === "registered_with_conditions" || r.renewalDueOn === null) {
        return { ok: false, problem: "registration_has_conditions" };
      }
      const prior = existing?.kind === "professional_registration" ? existing : null;
      if (!prior) return { ok: false, problem: "item_changed" };
      return {
        ok: true,
        verifiedOn: on,
        detail: { ...prior, body: "nmc", renewalDueOn: r.renewalDueOn },
      };
    }
    default:
      return { ok: false, problem: "not_verified" };
  }
}

/**
 * Whether a status check's certificate is still the file's: a result for a certificate number the
 * file no longer holds, or a PIN it no longer holds, is not applied.
 */
export function vettingCheckStillMatches(
  kind: VettingCheckKind,
  checked: { readonly certificateNumber?: string | null; readonly pin?: string | null },
  existing: ComplianceDetail | null,
): boolean {
  if (kind === "dbs_status_check") {
    return (
      existing?.kind === "dbs_certificate" &&
      existing.certificate?.number === checked.certificateNumber
    );
  }
  if (kind === "nmc_register_check") {
    return existing?.kind === "professional_registration" && existing.pin === checked.pin;
  }
  return true;
}
