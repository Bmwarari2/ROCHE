import { type DbsClearance, dbsClearance } from "./dbs";
import type { WorkforceRates } from "./rates";
import { type RightToWorkStatus, rightToWorkStatus } from "./right-to-work";
import type { RosterBlocker } from "./rostering";
import {
  type ComplianceDetail,
  complianceItemView,
  dbsRecordOf,
  drivingCurrent,
  type StaffProfileFacts,
  type StoredComplianceItem,
} from "./staff-file";

/**
 * The staff-file facts the rostering rule reads for one member on one UK date (workforce.md rule 10;
 * scheduling.md section 14; HZ-124). The rota (slice 21) reads them through the workforce port with
 * the system's rights and never shows the file itself: only the answer. An item counts only when it
 * was verified on or before the date by someone other than the member. With no staff file at all, the
 * member has no DBS and no right to work on record: blocked, and the right to work is never
 * overridable. A member who is not active in the organisation on the day (suspended, left, not yet
 * started, or only invited) is blocked too, and that is never overridable either.
 */
export interface RosterChecks {
  readonly dbs: DbsClearance;
  readonly rightToWork: RightToWorkStatus;
  /** Null when the role needs no registration. */
  readonly registrationCurrent: boolean | null;
  /** The member works for the organisation on the day (security review round 1, H1). */
  readonly memberActive: boolean;
  /**
   * A current NMC registration on the nurse part of the register (H-835): a registered nurse for
   * the staffing scale. A nursing associate or a midwife is not.
   */
  readonly registeredNurse: boolean;
  /** A verified driving-for-work check, current on the day (H-835). */
  readonly driver: boolean;
}

/** The member's standing in the organisation, from `tenant_user` and the staff profile. */
export interface Membership {
  readonly status: "invited" | "active" | "suspended" | "left";
  /** The last day of employment, if they have left or are leaving. */
  readonly leftOn: string | null;
  readonly startsOn: string | null;
}

/** Active on a UK date: an active member, started by then and not yet left. */
export function memberActiveOn(membership: Membership, day: string): boolean {
  return (
    membership.status === "active" &&
    (membership.leftOn === null || membership.leftOn >= day) &&
    (membership.startsOn === null || membership.startsOn <= day)
  );
}

const verifiedBy = (item: StoredComplianceItem, workerId: string, day: string) =>
  item.verifiedOn !== null &&
  item.verifiedOn <= day &&
  item.verifiedBy !== null &&
  item.verifiedBy !== workerId;

const issuedOn = (item: StoredComplianceItem) =>
  item.detail.kind === "dbs_certificate" ? (item.detail.certificate?.issuedOn ?? "") : "";

export function rosterChecks(
  profile: StaffProfileFacts | null,
  items: readonly StoredComplianceItem[],
  day: string,
  rates: WorkforceRates,
  membership: Membership,
): RosterChecks {
  const memberActive = memberActiveOn(membership, day);
  if (!profile) {
    return {
      dbs: { kind: "not_clear", reason: "no_certificate" },
      rightToWork: { kind: "none" },
      registrationCurrent: null,
      memberActive,
      registeredNurse: false,
      driver: false,
    };
  }
  const verified = items.filter((i) => verifiedBy(i, profile.workerId, day));
  const of = <K extends ComplianceDetail["kind"]>(kind: K) =>
    verified.filter(
      (i): i is StoredComplianceItem & { detail: Extract<ComplianceDetail, { kind: K }> } =>
        i.detail.kind === kind,
    );

  // The newest certificate decides, never the best one on file; new information from the Update
  // Service on any item blocks (clinical safety review round 1, H2).
  const dbsItems = of("dbs_certificate").sort((a, b) => (issuedOn(a) < issuedOn(b) ? -1 : 1));
  const clearances = dbsItems.map((item) =>
    dbsClearance(
      dbsRecordOf(item.detail, item.riskAssessmentSignedOn),
      day,
      rates.dbsUpdateServiceCheckMonths,
    ),
  );
  const newInformation = clearances.find(
    (c) => c.kind === "not_clear" && c.reason === "update_service_new_information",
  );
  const dbs: DbsClearance = newInformation ??
    clearances.at(-1) ?? { kind: "not_clear", reason: "no_certificate" };

  // The newest verified right to work item's checks decide; a follow-up window is not needed here
  // (a follow-up due still allows work).
  const rtwItems = of("right_to_work").sort((a, b) =>
    (a.verifiedOn ?? "") < (b.verifiedOn ?? "") ? -1 : 1,
  );
  const latestRtw = rtwItems.at(-1);
  const rightToWork: RightToWorkStatus = latestRtw
    ? rightToWorkStatus(latestRtw.detail.checks, day, 0)
    : { kind: "none" };

  // A registration on the role's own register only (H2).
  const registrationCurrent =
    profile.registration === null
      ? null
      : of("professional_registration").some(
          (item) =>
            item.detail.body === profile.registration &&
            complianceItemView(item, profile, day, rates).satisfied,
        );

  const registeredNurse =
    profile.registration === "nmc" &&
    of("professional_registration").some(
      (item) =>
        item.detail.body === "nmc" &&
        item.detail.nmcPart === "nurse" &&
        complianceItemView(item, profile, day, rates).satisfied,
    );
  const driver = of("driving_for_work").some(
    (item) => drivingCurrent(item.detail, day, rates).current,
  );

  return { dbs, rightToWork, registrationCurrent, memberActive, registeredNurse, driver };
}

/**
 * A stable key for a blocker, with its reason, to compare what an override covered with what stands
 * now: a DBS overridden for an unassessed disclosure does not cover new information from the Update
 * Service, nor an expired competence a withdrawn one (clinical safety review round 1, C3).
 */
export function blockerKey(blocker: RosterBlocker): string {
  switch (blocker.kind) {
    case "competence":
      return `competence:${blocker.competence}:${blocker.reason}`;
    case "dbs":
      return `dbs:${blocker.reason}`;
    case "right_to_work":
      return `right_to_work:${blocker.reason}`;
    default:
      return blocker.kind;
  }
}

/**
 * Blockers no override ever covers: illegal working, a member not working for the organisation,
 * no DBS certificate at all (the lawful supervised start is an Adult First check with a signed risk
 * assessment, `dbs_supervised_only`), and a lapsed or missing registration (a lapsed registrant may
 * not work in the registered role). H-830; ADR-0099 records the departure from master prompt
 * section 12.
 */
export function neverOverridable(blocker: RosterBlocker): boolean {
  return (
    blocker.kind === "right_to_work" ||
    blocker.kind === "not_active" ||
    blocker.kind === "registration" ||
    (blocker.kind === "dbs" && blocker.reason === "no_certificate")
  );
}

/** Which refusal an override of never-overridable blockers gets, the most serious first. */
export function neverOverridableRefusal(
  blockers: readonly RosterBlocker[],
): "right_to_work" | "not_active" | "no_dbs" | "registration" {
  if (blockers.some((b) => b.kind === "right_to_work")) return "right_to_work";
  if (blockers.some((b) => b.kind === "not_active")) return "not_active";
  if (blockers.some((b) => b.kind === "dbs" && b.reason === "no_certificate")) return "no_dbs";
  return "registration";
}

/**
 * Whether a stored override still covers the blockers that stand now (HZ-124): every blocker now
 * must have been one the manager overrode, with the same reason, and none may be one no override
 * covers. A new blocker, or the same kind for a new reason, needs a new override.
 */
export function overrideCovers(
  overridden: readonly string[],
  now: readonly RosterBlocker[],
): boolean {
  if (now.some(neverOverridable)) return false;
  const covered = new Set(overridden);
  return now.every((b) => covered.has(blockerKey(b)));
}

/** Whether two lists of blocker keys are the same, in any order. */
export function sameBlockers(a: readonly string[], b: readonly string[]): boolean {
  const x = [...new Set(a)].sort();
  const y = [...new Set(b)].sort();
  return x.length === y.length && x.every((k, i) => k === y[i]);
}

/**
 * One decision from the blockers found on each UK date a shift touches (a night that crosses an
 * expiry is checked on both dates; clinical safety review round 1, H1), with a manager's override
 * that must name exactly the blockers it was shown (C3): otherwise `blockers_changed`.
 */
export function combinedRosterDecision(
  perDay: readonly (readonly RosterBlocker[])[],
  override: { readonly justification: string; readonly blockerKeys: readonly string[] } | null,
  minJustification: number,
):
  | { readonly allowed: true; readonly overridden: readonly RosterBlocker[] }
  | {
      readonly allowed: false;
      readonly blockers: readonly RosterBlocker[];
      readonly overridable: boolean;
      readonly overrideRefused?:
        | "justification_required"
        | "right_to_work"
        | "not_active"
        | "no_dbs"
        | "registration"
        | "blockers_changed";
    } {
  const byKey = new Map<string, RosterBlocker>();
  for (const list of perDay) for (const b of list) byKey.set(blockerKey(b), b);
  const blockers = [...byKey.values()];
  if (blockers.length === 0) return { allowed: true, overridden: [] };
  const overridable = !blockers.some(neverOverridable);
  if (!override) return { allowed: false, blockers, overridable };
  if (!overridable) {
    return {
      allowed: false,
      blockers,
      overridable,
      overrideRefused: neverOverridableRefusal(blockers),
    };
  }
  if (!sameBlockers(override.blockerKeys, [...byKey.keys()])) {
    return { allowed: false, blockers, overridable, overrideRefused: "blockers_changed" };
  }
  if (override.justification.trim().length < minJustification) {
    return { allowed: false, blockers, overridable, overrideRefused: "justification_required" };
  }
  return { allowed: true, overridden: blockers };
}
