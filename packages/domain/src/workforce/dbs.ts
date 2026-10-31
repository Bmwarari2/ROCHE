import { addMonths } from "./dates";

/**
 * DBS (workforce.md rule 3). Regulated activity with adults needs an enhanced certificate with the
 * adults' barred list. A worker is clear once that certificate has been seen and recorded, or a
 * subscribed certificate's Update Service status check says no new information. Before the
 * certificate, a worker may start supervised only, with a clear adults' barred list check (DBS
 * Adult First) and a risk assessment signed by a Registered Manager. Update Service status checks
 * fall due every `dbs.update_service.check_interval_months` (a tenant default, no statutory figure).
 */

export interface DbsRecord {
  /** The certificate seen and recorded: its level and issue date. */
  readonly certificate: {
    readonly level: "enhanced_adults_barred" | "enhanced" | "standard" | "basic";
    readonly issuedOn: string;
    readonly result: "clear" | "information_disclosed";
    /** A disclosure considered and accepted by the manager after a risk assessment. */
    readonly disclosureAccepted?: boolean;
  } | null;
  readonly updateService: {
    readonly subscribed: boolean;
    /** The last status check and its result. */
    readonly lastCheckedOn: string | null;
    readonly lastResult: "no_new_information" | "new_information" | null;
  } | null;
  /** Before the certificate: a clear barred list check and a signed risk assessment. */
  readonly preClearance: {
    readonly barredListClearOn: string | null;
    readonly riskAssessmentSignedOn: string | null;
  } | null;
}

export type DbsClearance =
  | { readonly kind: "clear"; readonly updateServiceCheckDueOn: string | null }
  | { readonly kind: "supervised_only" }
  | { readonly kind: "not_clear"; readonly reason: DbsBlock };

export type DbsBlock =
  | "no_certificate"
  | "wrong_level"
  | "disclosure_not_assessed"
  | "update_service_new_information";

export function dbsClearance(
  record: DbsRecord,
  today: string,
  checkIntervalMonths: number,
): DbsClearance {
  const certificate = record.certificate;
  if (certificate && certificate.issuedOn <= today) {
    if (certificate.level !== "enhanced_adults_barred") {
      return { kind: "not_clear", reason: "wrong_level" };
    }
    if (certificate.result === "information_disclosed" && !certificate.disclosureAccepted) {
      return { kind: "not_clear", reason: "disclosure_not_assessed" };
    }
    const service = record.updateService;
    if (service?.subscribed && service.lastResult === "new_information") {
      return { kind: "not_clear", reason: "update_service_new_information" };
    }
    const last = service?.subscribed ? (service.lastCheckedOn ?? certificate.issuedOn) : null;
    return {
      kind: "clear",
      updateServiceCheckDueOn: last ? addMonths(last, checkIntervalMonths) : null,
    };
  }
  const pre = record.preClearance;
  if (
    pre?.barredListClearOn &&
    pre.riskAssessmentSignedOn &&
    pre.barredListClearOn <= today &&
    pre.riskAssessmentSignedOn <= today
  ) {
    return { kind: "supervised_only" };
  }
  return { kind: "not_clear", reason: "no_certificate" };
}

/** An Update Service status check is due (not blocking: the certificate still stands). */
export function updateServiceCheckDue(clearance: DbsClearance, today: string): boolean {
  return (
    clearance.kind === "clear" &&
    clearance.updateServiceCheckDueOn !== null &&
    clearance.updateServiceCheckDueOn <= today
  );
}
