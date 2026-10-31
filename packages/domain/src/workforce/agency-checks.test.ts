import { describe, expect, it } from "vitest";
import { type AgencyConfirmation, agencyRosterChecks } from "./agency-checks";
import type { Membership } from "./roster-checks";
import { rosterDecision } from "./rostering";

const DAY = "2026-11-02";
const ACTIVE: Membership = { status: "active", leftOn: null, startsOn: null };
const confirmed: AgencyConfirmation = {
  dbsConfirmedOn: "2026-10-01",
  dbsEnhancedBarred: true,
  rightToWorkConfirmedOn: "2026-10-01",
  rightToWorkExpiresOn: null,
  registrationBody: null,
  registrationValidUntil: null,
};

describe("hazard HZ-124 an agency worker's checks come from the agency's confirmation", () => {
  it.each([
    ["confirmed in full", confirmed, "clear", "valid", null],
    ["nothing confirmed", null, "not_clear", "none", null],
    [
      "a DBS not at the enhanced barred level",
      { ...confirmed, dbsEnhancedBarred: false },
      "not_clear",
      "valid",
      null,
    ],
    [
      "checks confirmed only after the day",
      { ...confirmed, dbsConfirmedOn: "2026-11-03", rightToWorkConfirmedOn: "2026-11-03" },
      "not_clear",
      "none",
      null,
    ],
    [
      "a right to work ending the day before",
      { ...confirmed, rightToWorkExpiresOn: "2026-11-01" },
      "clear",
      "lapsed",
      null,
    ],
    [
      "a right to work ending on the day",
      { ...confirmed, rightToWorkExpiresOn: DAY },
      "clear",
      "valid",
      null,
    ],
    [
      "a nurse with a registration confirmed through the day",
      { ...confirmed, registrationBody: "nmc", registrationValidUntil: DAY },
      "clear",
      "valid",
      true,
    ],
    [
      "a nurse with no registration confirmed",
      { ...confirmed, registrationBody: "nmc" },
      "clear",
      "valid",
      false,
    ],
  ] as const)("hazard HZ-124 %s", (_, confirmation, dbs, rtw, registered) => {
    const checks = agencyRosterChecks(confirmation, DAY, ACTIVE);
    expect(checks.dbs.kind).toBe(dbs);
    expect(checks.rightToWork.kind).toBe(rtw);
    expect(checks.registrationCurrent).toBe(registered);
  });

  it("hazard HZ-124 never rosters an agency worker with no confirmation, override or not", () => {
    const decision = rosterDecision(
      { ...agencyRosterChecks(null, DAY, ACTIVE), competences: [], shiftSupervised: false },
      { justification: "Short-staffed tonight", byTenantUserId: "m" },
    );
    expect(decision).toMatchObject({ allowed: false, overrideRefused: "right_to_work" });
  });

  it("hazard HZ-124 blocks an agency worker who is no longer active", () => {
    const checks = agencyRosterChecks(confirmed, DAY, { ...ACTIVE, status: "left" });
    expect(checks.memberActive).toBe(false);
  });
});
