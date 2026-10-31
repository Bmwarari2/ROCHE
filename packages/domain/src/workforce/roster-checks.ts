import { type DbsClearance, dbsClearance } from "./dbs";
import type { WorkforceRates } from "./rates";
import { type RightToWorkStatus, rightToWorkStatus } from "./right-to-work";
import type { RosterBlocker } from "./rostering";
import {
  type ComplianceDetail,
  complianceItemView,
  dbsRecordOf,
  type StaffProfileFacts,
  type StoredComplianceItem,
} from "./staff-file";

/**
 * The staff-file facts the rostering rule reads for one member on one UK date (workforce.md rule 10;
 * scheduling.md section 14; HZ-124). The rota (slice 21) reads them through the workforce port with
 * the system's rights and never shows the file itself: only the answer. An item counts only when it
 * was verified on or before the date by someone other than the member. With no staff file at all, the
 * member has no DBS and no right to work on record: blocked, and the right to work is never
 * overridable.
 */
export interface RosterChecks {
  readonly dbs: DbsClearance;
  readonly rightToWork: RightToWorkStatus;
  /** Null when the role needs no registration. */
  readonly registrationCurrent: boolean | null;
}

const verifiedBy = (item: StoredComplianceItem, workerId: string, day: string) =>
  item.verifiedOn !== null &&
  item.verifiedOn <= day &&
  item.verifiedBy !== null &&
  item.verifiedBy !== workerId;

const DBS_RANK: Readonly<Record<DbsClearance["kind"], number>> = {
  not_clear: 0,
  supervised_only: 1,
  clear: 2,
};

export function rosterChecks(
  profile: StaffProfileFacts | null,
  items: readonly StoredComplianceItem[],
  day: string,
  rates: WorkforceRates,
): RosterChecks {
  if (!profile) {
    return {
      dbs: { kind: "not_clear", reason: "no_certificate" },
      rightToWork: { kind: "none" },
      registrationCurrent: null,
    };
  }
  const verified = items.filter((i) => verifiedBy(i, profile.workerId, day));
  const of = <K extends ComplianceDetail["kind"]>(kind: K) =>
    verified.filter(
      (i): i is StoredComplianceItem & { detail: Extract<ComplianceDetail, { kind: K }> } =>
        i.detail.kind === kind,
    );

  let dbs: DbsClearance = { kind: "not_clear", reason: "no_certificate" };
  for (const item of of("dbs_certificate")) {
    const clearance = dbsClearance(
      dbsRecordOf(item.detail, item.riskAssessmentSignedOn),
      day,
      rates.dbsUpdateServiceCheckMonths,
    );
    if (DBS_RANK[clearance.kind] > DBS_RANK[dbs.kind]) dbs = clearance;
  }

  // The newest verified right to work item's checks decide; a follow-up window is not needed here
  // (a follow-up due still allows work).
  const rtwItems = of("right_to_work").sort((a, b) =>
    (a.verifiedOn ?? "") < (b.verifiedOn ?? "") ? -1 : 1,
  );
  const latestRtw = rtwItems.at(-1);
  const rightToWork: RightToWorkStatus = latestRtw
    ? rightToWorkStatus(latestRtw.detail.checks, day, 0)
    : { kind: "none" };

  const registrationCurrent =
    profile.registration === null
      ? null
      : of("professional_registration").some(
          (item) => complianceItemView(item, profile, day, rates).satisfied,
        );

  return { dbs, rightToWork, registrationCurrent };
}

/** A stable key for a blocker, to compare what an override covered with what stands now. */
export function blockerKey(blocker: RosterBlocker): string {
  switch (blocker.kind) {
    case "competence":
      return `competence:${blocker.competence}`;
    default:
      return blocker.kind;
  }
}

/**
 * Whether a stored override still covers the blockers that stand now (HZ-124): every blocker now
 * must have been one the manager overrode, with the justification, and none may be a right to work.
 * A new blocker (a DBS that lapsed after a competence was overridden) needs a new override.
 */
export function overrideCovers(
  overridden: readonly string[],
  now: readonly RosterBlocker[],
): boolean {
  if (now.some((b) => b.kind === "right_to_work")) return false;
  const covered = new Set(overridden);
  return now.every((b) => covered.has(blockerKey(b)));
}
