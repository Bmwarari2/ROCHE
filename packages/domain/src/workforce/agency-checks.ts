import type { DbsClearance } from "./dbs";
import type { RightToWorkStatus } from "./right-to-work";
import { type Membership, memberActiveOn, type RosterChecks } from "./roster-checks";
import type { RoleRegistration } from "./schedule3";

/**
 * The rostering rule's facts for an agency worker (scheduling.md section 15; HZ-124; master prompt
 * section 12). The agency employs them and makes the checks; the organisation relies on the
 * agency's written confirmation, recorded by a member of staff who is not the worker. A confirmed
 * enhanced DBS with the adults' barred list clears; anything less, or nothing confirmed by the day,
 * does not. A right to work is confirmed with its expiry, if any (the day after it, none). A role on
 * a register needs the registration confirmed on that register through the day. Bank workers are
 * the organisation's own staff: their checks come from the staff file (`rosterChecks`).
 */
export interface AgencyConfirmation {
  readonly dbsConfirmedOn: string | null;
  /** The confirmed check is an enhanced DBS with the adults' barred list. */
  readonly dbsEnhancedBarred: boolean;
  readonly rightToWorkConfirmedOn: string | null;
  /** The last day of a time-limited right to work; null for an unlimited one. */
  readonly rightToWorkExpiresOn: string | null;
  /** The register the role needs (an agency nurse: `nmc`), or null. */
  readonly registrationBody: RoleRegistration;
  /** The last day the confirmed registration is valid, or null when none was confirmed. */
  readonly registrationValidUntil: string | null;
}

export function agencyRosterChecks(
  confirmation: AgencyConfirmation | null,
  day: string,
  membership: Membership,
): RosterChecks {
  const memberActive = memberActiveOn(membership, day);
  if (!confirmation) {
    return {
      dbs: { kind: "not_clear", reason: "no_certificate" },
      rightToWork: { kind: "none" },
      registrationCurrent: null,
      memberActive,
    };
  }
  const dbsConfirmed = confirmation.dbsConfirmedOn !== null && confirmation.dbsConfirmedOn <= day;
  const dbs: DbsClearance = !dbsConfirmed
    ? { kind: "not_clear", reason: "no_certificate" }
    : confirmation.dbsEnhancedBarred
      ? { kind: "clear", updateServiceCheckDueOn: null }
      : { kind: "not_clear", reason: "wrong_level" };
  const rtwConfirmed =
    confirmation.rightToWorkConfirmedOn !== null && confirmation.rightToWorkConfirmedOn <= day;
  const rightToWork: RightToWorkStatus = !rtwConfirmed
    ? { kind: "none" }
    : confirmation.rightToWorkExpiresOn === null
      ? { kind: "valid", followUpDueOn: null }
      : confirmation.rightToWorkExpiresOn >= day
        ? { kind: "valid", followUpDueOn: confirmation.rightToWorkExpiresOn }
        : { kind: "lapsed", lapsedOn: confirmation.rightToWorkExpiresOn };
  const registrationCurrent =
    confirmation.registrationBody === null
      ? null
      : confirmation.registrationValidUntil !== null && confirmation.registrationValidUntil >= day;
  return { dbs, rightToWork, registrationCurrent, memberActive };
}
