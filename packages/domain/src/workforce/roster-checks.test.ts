import { describe, expect, it } from "vitest";
import { readRateTable } from "../../test/rate-table";
import { resolveWorkforceRates } from "./rates";
import { blockerKey, overrideCovers, rosterChecks } from "./roster-checks";
import { type RosterBlocker, rosterDecision } from "./rostering";
import type { ComplianceDetail, StaffProfileFacts, StoredComplianceItem } from "./staff-file";

const DAY = "2026-11-02";
const rates = resolveWorkforceRates(readRateTable(), "england", DAY, null);
const WORKER = "0194d000-0000-7000-8000-00000000b001";
const HR = "0194d000-0000-7000-8000-00000000b002";
const carer: StaffProfileFacts = {
  workerId: WORKER,
  registration: null,
  previousCareWork: false,
  startsOn: "2026-09-01",
};
const nurse: StaffProfileFacts = { ...carer, registration: "nmc" };

const item = (
  detail: ComplianceDetail,
  over: Partial<StoredComplianceItem> = {},
): StoredComplianceItem => ({
  detail,
  verifiedOn: "2026-08-20",
  verifiedBy: HR,
  riskAssessmentSignedOn: null,
  riskAssessmentSignedBy: null,
  remindersSent: [],
  ...over,
});
const dbs: ComplianceDetail = {
  kind: "dbs_certificate",
  certificate: {
    level: "enhanced_adults_barred",
    issuedOn: "2026-08-15",
    number: "001234567890",
    result: "clear",
  },
  updateService: null,
  barredListClearOn: null,
};
const rtw = (expiresOn: string | null): ComplianceDetail => ({
  kind: "right_to_work",
  checks: [
    {
      checkedOn: "2026-08-10",
      permission: expiresOn ? "time_limited" : "unlimited",
      expiresOn,
      method: "online_share_code",
    },
  ],
});
const registration = (renewalDueOn: string): ComplianceDetail => ({
  kind: "professional_registration",
  body: "nmc",
  pin: "99A9999E",
  renewalDueOn,
  revalidationDueOn: null,
});

describe("hazard HZ-124 the rota reads the staff file's checks for the shift's day", () => {
  it.each([
    ["no staff file", null, [], "not_clear", "none", null],
    [
      "a verified DBS and right to work",
      carer,
      [item(dbs), item(rtw(null))],
      "clear",
      "valid",
      null,
    ],
    [
      "items verified by the worker themselves do not count",
      carer,
      [item(dbs, { verifiedBy: WORKER }), item(rtw(null), { verifiedBy: WORKER })],
      "not_clear",
      "none",
      null,
    ],
    [
      "items not yet verified do not count",
      carer,
      [item(dbs, { verifiedOn: null, verifiedBy: null }), item(rtw(null), { verifiedOn: null })],
      "not_clear",
      "none",
      null,
    ],
    [
      "a time-limited right to work that lapses before the shift",
      carer,
      [item(dbs), item(rtw("2026-11-01"))],
      "clear",
      "lapsed",
      null,
    ],
    [
      "a nurse with a current registration",
      nurse,
      [item(dbs), item(rtw(null)), item(registration("2027-03-31"))],
      "clear",
      "valid",
      true,
    ],
    [
      "a nurse whose registration lapses before the shift",
      nurse,
      [item(dbs), item(rtw(null)), item(registration("2026-11-01"))],
      "clear",
      "valid",
      false,
    ],
    [
      "a nurse with no registration on file",
      nurse,
      [item(dbs), item(rtw(null))],
      "clear",
      "valid",
      false,
    ],
  ] as const)("hazard HZ-124 %s", (_, profile, items, dbsKind, rtwKind, registered) => {
    const checks = rosterChecks(profile, items, DAY, rates);
    expect(checks.dbs.kind).toBe(dbsKind);
    expect(checks.rightToWork.kind).toBe(rtwKind);
    expect(checks.registrationCurrent).toBe(registered);
  });

  it("hazard HZ-124 a rota with no staff file blocks and cannot be overridden", () => {
    const checks = rosterChecks(null, [], DAY, rates);
    const decision = rosterDecision(
      { ...checks, competences: [], shiftSupervised: false },
      { justification: "Covering sickness tonight", byTenantUserId: HR },
    );
    expect(decision).toMatchObject({ allowed: false, overrideRefused: "right_to_work" });
  });

  it("hazard HZ-124 takes the competence port's decision as the gate", () => {
    const decision = rosterDecision({
      dbs: { kind: "clear", updateServiceCheckDueOn: null },
      rightToWork: { kind: "valid", followUpDueOn: null },
      registrationCurrent: null,
      competences: [
        {
          competence: "medicines_administration",
          gate: { allowed: false, reason: "withdrawn", validUntil: null },
        },
      ],
      shiftSupervised: false,
    });
    expect(decision).toEqual({
      allowed: false,
      blockers: [
        { kind: "competence", competence: "medicines_administration", reason: "withdrawn" },
      ],
      overridable: true,
    });
  });
});

describe("hazard HZ-124 an override covers only what it overrode", () => {
  const competence: RosterBlocker = {
    kind: "competence",
    competence: "moving_and_handling_hoist",
    reason: "expired",
  };
  const dbsBlock: RosterBlocker = { kind: "dbs", reason: "no_certificate" };
  const rtwBlock: RosterBlocker = { kind: "right_to_work", reason: "lapsed" };
  it.each([
    ["nothing stands now", [blockerKey(competence)], [], true],
    ["the same blocker stands", [blockerKey(competence)], [competence], true],
    ["a new blocker appeared", [blockerKey(competence)], [competence, dbsBlock], false],
    [
      "a right to work blocker appeared",
      [blockerKey(competence), "right_to_work"],
      [rtwBlock],
      false,
    ],
    ["no override was given", [], [competence], false],
  ] as const)("hazard HZ-124 %s", (_, overridden, now, covers) => {
    expect(overrideCovers(overridden, now)).toBe(covers);
  });

  it("keys a competence blocker by its competence", () => {
    expect(blockerKey(competence)).toBe("competence:moving_and_handling_hoist");
    expect(blockerKey(dbsBlock)).toBe("dbs");
  });
});
