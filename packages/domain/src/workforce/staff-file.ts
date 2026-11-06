import type { YearMonth } from "./dates";
import { type DbsBlock, type DbsRecord, dbsClearance } from "./dbs";
import { employmentGaps, type Gap, type HistoryPeriod } from "./employment-history";
import { expiryState } from "./expiry";
import { reminderDays, type WorkforceRates } from "./rates";
import { type Registration, registrationCurrent } from "./registration";
import { checkedLate, mayWork, type RightToWorkCheck, rightToWorkStatus } from "./right-to-work";
import {
  type ComplianceItemKindCode,
  type RoleRegistration,
  SCHEDULE3_ITEMS,
  type Schedule3Item,
  type Schedule3ItemKind,
  type Schedule3State,
  schedule3State,
} from "./schedule3";

/**
 * The stored staff file (workforce.md rules 1 to 4 and 8, section 2a; WORK-002, slice 11): what
 * one `compliance_item` row says once its kind's rule has read it. Whether an item is satisfied is
 * never stored: it is worked out here from the check's details, who verified it and when, on the
 * UK date asked about, so a lapsed right to work or registration is never shown as satisfied
 * because nobody changed the row.
 */

/** How identity was proved (Schedule 3 paragraph 1). The document itself is an HR-only file. */
export const IDENTITY_DOCUMENTS = [
  "passport",
  "photocard_driving_licence",
  "national_identity_card",
  "biometric_residence_permit",
  "other_photo_document",
] as const;
export type IdentityDocument = (typeof IDENTITY_DOCUMENTS)[number];

/** How a right to work check was made (Home Office employer's guide). */
export const RIGHT_TO_WORK_METHODS = ["manual_document", "online_share_code", "idsp"] as const;
export type RightToWorkMethod = (typeof RIGHT_TO_WORK_METHODS)[number];

export interface RightToWorkCheckRecord extends RightToWorkCheck {
  readonly method: RightToWorkMethod;
}

/**
 * The details each kind keeps. Only what the rule needs: never the contents of a DBS certificate
 * (what it disclosed stays on the certificate, which Harbour does not keep; retention.md), never
 * health details (only whether the worker declared themselves fit, with or without adjustments).
 */
export type ComplianceDetail =
  | { readonly kind: "identity_with_photo"; readonly document: IdentityDocument }
  | {
      readonly kind: "dbs_certificate";
      readonly certificate: {
        readonly level: "enhanced_adults_barred" | "enhanced" | "standard" | "basic";
        readonly issuedOn: string;
        /** The 12-digit certificate number, for Update Service status checks. */
        readonly number: string;
        readonly result: "clear" | "information_disclosed";
      } | null;
      readonly updateService: {
        readonly subscribed: boolean;
        readonly lastCheckedOn: string | null;
        readonly lastResult: "no_new_information" | "new_information" | null;
      } | null;
      /** A clear adults' barred list check made before the certificate (DBS Adult First). */
      readonly barredListClearOn: string | null;
    }
  | {
      readonly kind: "conduct_in_care_work";
      /** Evidence of conduct and of why the work ended, for each earlier care job. */
      readonly employersContacted: number;
    }
  | { readonly kind: "references"; readonly received: number }
  | { readonly kind: "relevant_qualifications"; readonly qualifications: readonly string[] }
  | {
      readonly kind: "employment_history";
      readonly historyStart: YearMonth;
      readonly applicationMonth: YearMonth;
      readonly periods: readonly HistoryPeriod[];
    }
  | {
      readonly kind: "health_fitness";
      /** The worker declared themselves able to do the work, after reasonable adjustments. */
      readonly declaredFit: boolean;
      readonly adjustmentsAgreed: boolean;
    }
  | { readonly kind: "right_to_work"; readonly checks: readonly RightToWorkCheckRecord[] }
  | {
      readonly kind: "professional_registration";
      readonly body: Exclude<RoleRegistration, null>;
      readonly pin: string;
      readonly renewalDueOn: string;
      readonly revalidationDueOn: string | null;
      /**
       * The part of the NMC register (H-835): only the nurse part counts as a registered nurse on
       * duty; a nursing associate never does. Null for other registers, and for an NMC entry
       * recorded before the part was asked (which then counts as no nurse).
       */
      readonly nmcPart?: NmcPart | null;
    }
  | {
      /**
       * Driving for work (H-835): the licence checked with the DVLA (the date and the categories,
       * never the licence number or the check code) and business-use insurance seen, with its
       * expiry. Counts as a driver only while both are current.
       */
      readonly kind: "driving_for_work";
      readonly licenceCheckedOn: string;
      readonly categories: readonly string[];
      readonly insuranceExpiresOn: string;
    };

export type NmcPart = "nurse" | "midwife" | "nursing_associate";

/**
 * Whether a driving-for-work check is current on a UK date (H-835): the DVLA licence check made
 * within `workforce.driving_licence_check_months` before it, and the insurance not yet expired.
 * `until` is the earlier of the two last days.
 */
export function drivingCurrent(
  detail: Extract<ComplianceDetail, { kind: "driving_for_work" }>,
  today: string,
  rates: Pick<WorkforceRates, "drivingLicenceCheckMonths">,
): { readonly current: boolean; readonly until: string } {
  const licenceUntil = addMonthsIso(detail.licenceCheckedOn, rates.drivingLicenceCheckMonths);
  const until = licenceUntil < detail.insuranceExpiresOn ? licenceUntil : detail.insuranceExpiresOn;
  return { current: detail.licenceCheckedOn <= today && today <= until, until };
}

/** The UK date `months` after another, the day before the same date (the last day covered). */
function addMonthsIso(isoDate: string, months: number): string {
  const d = new Date(`${isoDate}T12:00:00Z`);
  const day = d.getUTCDate();
  d.setUTCDate(1);
  d.setUTCMonth(d.getUTCMonth() + months);
  const last = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0)).getUTCDate();
  d.setUTCDate(Math.min(day, last));
  d.setUTCDate(d.getUTCDate() - 1);
  return d.toISOString().slice(0, 10);
}

export interface StoredComplianceItem {
  readonly detail: ComplianceDetail;
  /** The UK date the evidence was seen, and by whom (a `tenant_user` id). */
  readonly verifiedOn: string | null;
  readonly verifiedBy: string | null;
  /** The DBS risk assessment, signed by a holder of `workforce.dbs_risk_assessment.sign`. */
  readonly riskAssessmentSignedOn: string | null;
  readonly riskAssessmentSignedBy: string | null;
  /** Reminder offsets already raised for the item's current reminder date. */
  readonly remindersSent: readonly number[];
}

export interface StaffProfileFacts {
  /** The worker's own `tenant_user` id: nobody verifies their own checks. */
  readonly workerId: string;
  readonly registration: RoleRegistration;
  readonly previousCareWork: boolean;
  /** The first day of employment, once known. */
  readonly startsOn: string | null;
}

/** Why an item is not satisfied, or what the file must say about it (shown as words and an icon). */
export type ComplianceNote =
  | { readonly code: "not_verified" }
  | { readonly code: "self_verified" }
  | { readonly code: "dbs_supervised_only" }
  | { readonly code: "dbs_not_clear"; readonly reason: DbsBlock }
  | { readonly code: "dbs_update_service_check_due"; readonly dueOn: string }
  | { readonly code: "right_to_work_none" }
  | { readonly code: "right_to_work_lapsed"; readonly lapsedOn: string }
  | { readonly code: "right_to_work_checked_late"; readonly checkedOn: string }
  | { readonly code: "employment_gaps"; readonly gaps: readonly Gap[] }
  | { readonly code: "registration_lapsed" }
  /** An NMC registration without its register part: it does not count as a registered nurse. */
  | { readonly code: "nmc_part_missing" }
  | { readonly code: "health_not_declared_fit" }
  | { readonly code: "references_none" }
  | { readonly code: "driving_not_current" };

export interface ComplianceItemView {
  readonly kind: ComplianceItemKindCode;
  readonly satisfied: boolean;
  /** The last valid day of an item that expires (right to work, registration). */
  readonly expiresOn: string | null;
  /** When a check falls due again without the item expiring (a DBS Update Service status check). */
  readonly recheckDueOn: string | null;
  readonly notes: readonly ComplianceNote[];
}

/** The date expiry reminders count down to: the expiry, or else the re-check. */
export function reminderDateOf(view: ComplianceItemView): string | null {
  return view.expiresOn ?? view.recheckDueOn;
}

/** The DBS rule's view of the stored details: the signed risk assessment covers both its uses. */
export function dbsRecordOf(
  detail: Extract<ComplianceDetail, { kind: "dbs_certificate" }>,
  riskAssessmentSignedOn: string | null,
): DbsRecord {
  const certificate = detail.certificate;
  return {
    certificate: certificate
      ? {
          level: certificate.level,
          issuedOn: certificate.issuedOn,
          result: certificate.result,
          // A disclosure is accepted only by a risk assessment signed once it was seen.
          disclosureAccepted:
            riskAssessmentSignedOn !== null && riskAssessmentSignedOn >= certificate.issuedOn,
        }
      : null,
    updateService: detail.updateService,
    preClearance: {
      barredListClearOn: detail.barredListClearOn,
      riskAssessmentSignedOn,
    },
  };
}

/**
 * One item on `today` (a UK date). Verified by someone other than the worker on or before today,
 * and its kind's own rule met.
 */
export function complianceItemView(
  item: StoredComplianceItem,
  profile: StaffProfileFacts,
  today: string,
  rates: WorkforceRates,
): ComplianceItemView {
  const detail = item.detail;
  const notes: ComplianceNote[] = [];
  let ruleMet = true;
  let expiresOn: string | null = null;
  let recheckDueOn: string | null = null;
  switch (detail.kind) {
    case "dbs_certificate": {
      const clearance = dbsClearance(
        dbsRecordOf(detail, item.riskAssessmentSignedOn),
        today,
        rates.dbsUpdateServiceCheckMonths,
      );
      if (clearance.kind === "clear") {
        recheckDueOn = clearance.updateServiceCheckDueOn;
        if (recheckDueOn !== null && recheckDueOn <= today) {
          notes.push({ code: "dbs_update_service_check_due", dueOn: recheckDueOn });
        }
      } else if (clearance.kind === "supervised_only") {
        ruleMet = false;
        notes.push({ code: "dbs_supervised_only" });
      } else {
        ruleMet = false;
        notes.push({ code: "dbs_not_clear", reason: clearance.reason });
      }
      break;
    }
    case "right_to_work": {
      const status = rightToWorkStatus(detail.checks, today, Math.max(...reminderDays(rates)));
      const latest = [...detail.checks].sort((a, b) => (a.checkedOn < b.checkedOn ? -1 : 1));
      const timeLimited = latest.at(-1);
      if (timeLimited?.permission === "time_limited") expiresOn = timeLimited.expiresOn;
      if (!mayWork(status)) {
        ruleMet = false;
        notes.push(
          status.kind === "lapsed"
            ? { code: "right_to_work_lapsed", lapsedOn: status.lapsedOn }
            : { code: "right_to_work_none" },
        );
      }
      const first = latest[0];
      if (first && profile.startsOn && checkedLate(first.checkedOn, profile.startsOn)) {
        notes.push({ code: "right_to_work_checked_late", checkedOn: first.checkedOn });
      }
      break;
    }
    case "professional_registration": {
      const registration: Registration = {
        body: detail.body,
        pin: detail.pin,
        renewalDueOn: detail.renewalDueOn,
        revalidationDueOn: detail.revalidationDueOn,
      };
      expiresOn = detail.renewalDueOn;
      if (!registrationCurrent(registration, today)) {
        ruleMet = false;
        notes.push({ code: "registration_lapsed" });
      }
      // Fails safe, and says so (H-835; clinical safety review of the recommended answers).
      if (detail.body === "nmc" && !detail.nmcPart) notes.push({ code: "nmc_part_missing" });
      break;
    }
    case "driving_for_work": {
      const current = drivingCurrent(detail, today, rates);
      expiresOn = current.until;
      if (!current.current) {
        ruleMet = false;
        notes.push({ code: "driving_not_current" });
      }
      break;
    }
    case "employment_history": {
      const gaps = employmentGaps(detail.periods, detail.historyStart, detail.applicationMonth);
      if (gaps.length > 0) {
        ruleMet = false;
        notes.push({ code: "employment_gaps", gaps });
      }
      break;
    }
    case "health_fitness":
      if (!detail.declaredFit) {
        ruleMet = false;
        notes.push({ code: "health_not_declared_fit" });
      }
      break;
    case "references":
      if (detail.received < 1) {
        ruleMet = false;
        notes.push({ code: "references_none" });
      }
      break;
    default:
      break;
  }
  let verified = item.verifiedOn !== null && item.verifiedOn <= today;
  if (!verified) notes.unshift({ code: "not_verified" });
  if (verified && item.verifiedBy === profile.workerId) {
    verified = false;
    notes.unshift({ code: "self_verified" });
  }
  return { kind: detail.kind, satisfied: verified && ruleMet, expiresOn, recheckDueOn, notes };
}

const isSchedule3Kind = (kind: ComplianceItemKindCode): kind is Schedule3ItemKind =>
  (SCHEDULE3_ITEMS as readonly string[]).includes(kind);

export interface StaffFileState extends Schedule3State {
  readonly views: readonly ComplianceItemView[];
}

/**
 * The whole file on `today`: the Schedule 3 state of the items the role needs (with their
 * reminders), and each stored item's view, required or not.
 */
export function staffFileState(
  profile: StaffProfileFacts,
  items: readonly StoredComplianceItem[],
  today: string,
  rates: WorkforceRates,
): StaffFileState {
  const views = items.map((item) => complianceItemView(item, profile, today, rates));
  // Only Schedule 3 items make a complete file; a driving check is extra (H-835).
  const schedule3: Schedule3Item[] = views.flatMap((view, i) =>
    isSchedule3Kind(view.kind)
      ? [
          {
            kind: view.kind,
            satisfied: view.satisfied,
            expiresOn: view.expiresOn,
            remindersSent: items[i]?.remindersSent ?? [],
          },
        ]
      : [],
  );
  const state = schedule3State(
    { registration: profile.registration, previousCareWork: profile.previousCareWork },
    schedule3,
    today,
    reminderDays(rates),
  );
  return { ...state, views };
}

/**
 * The reminder to raise today for one item, counting down to its reminder date (the expiry or
 * the DBS re-check), at the document-expiry offsets, once each; null when none is due.
 */
export function complianceReminderDue(
  view: ComplianceItemView,
  remindersSent: readonly number[],
  today: string,
  rates: WorkforceRates,
): { readonly days: number; readonly dueOn: string } | null {
  const dueOn = reminderDateOf(view);
  if (dueOn === null) return null;
  const state = expiryState(dueOn, today, reminderDays(rates), remindersSent);
  return state.reminderDue === null ? null : { days: state.reminderDue, dueOn };
}
