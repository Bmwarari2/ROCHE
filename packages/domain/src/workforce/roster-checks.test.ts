import { describe, expect, it } from "vitest";
import { readRateTable } from "../../test/rate-table";
import { resolveWorkforceRates } from "./rates";
import {
  blockerKey,
  combinedRosterDecision,
  type Membership,
  memberActiveOn,
  overrideCovers,
  rosterChecks,
  sameBlockers,
} from "./roster-checks";
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
const ACTIVE: Membership = { status: "active", leftOn: null, startsOn: "2026-09-01" };

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
    const checks = rosterChecks(profile, items, DAY, rates, ACTIVE);
    expect(checks.dbs.kind).toBe(dbsKind);
    expect(checks.rightToWork.kind).toBe(rtwKind);
    expect(checks.registrationCurrent).toBe(registered);
  });

  it("hazard HZ-124 a rota with no staff file blocks and cannot be overridden", () => {
    const checks = rosterChecks(null, [], DAY, rates, ACTIVE);
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
    expect(blockerKey(competence)).toBe("competence:moving_and_handling_hoist:expired");
    expect(blockerKey(dbsBlock)).toBe("dbs:no_certificate");
  });
});

describe("hazard HZ-124 a member not working for the organisation on the day is never rostered", () => {
  it.each([
    ["active", ACTIVE, true],
    ["suspended", { ...ACTIVE, status: "suspended" }, false],
    ["left", { ...ACTIVE, status: "left" }, false],
    ["only invited", { ...ACTIVE, status: "invited" }, false],
    ["leaving after the day", { ...ACTIVE, leftOn: DAY }, true],
    ["left before the day", { ...ACTIVE, leftOn: "2026-11-01" }, false],
    ["starting after the day", { ...ACTIVE, startsOn: "2026-11-03" }, false],
  ] as const)("hazard HZ-124 %s", (_, membership, active) => {
    expect(memberActiveOn(membership, DAY)).toBe(active);
  });

  it("hazard HZ-124 refuses any override for a suspended member", () => {
    const checks = rosterChecks(carer, [item(dbs), item(rtw(null))], DAY, rates, {
      ...ACTIVE,
      status: "suspended",
    });
    const decision = rosterDecision(
      { ...checks, competences: [], shiftSupervised: false },
      { justification: "Covering sickness tonight", byTenantUserId: HR },
    );
    expect(decision).toMatchObject({ allowed: false, overrideRefused: "not_active" });
  });
});

describe("hazard HZ-124 the newest DBS decides, and new information always blocks", () => {
  const older = item(dbs);
  const newer = (result: "clear" | "information_disclosed", issued = "2026-10-01") =>
    item({
      ...dbs,
      certificate: {
        level: "enhanced_adults_barred",
        issuedOn: issued,
        number: "009999999998",
        result,
      },
    } as ComplianceDetail);

  it("hazard HZ-124 an older clear certificate does not clear a newer unassessed disclosure", () => {
    const checks = rosterChecks(carer, [older, newer("information_disclosed")], DAY, rates, ACTIVE);
    expect(checks.dbs).toEqual({ kind: "not_clear", reason: "disclosure_not_assessed" });
  });

  it("hazard HZ-124 new information from the Update Service on any certificate blocks", () => {
    const flagged = item({
      ...dbs,
      updateService: {
        subscribed: true,
        lastCheckedOn: "2026-10-30",
        lastResult: "new_information",
      },
    } as ComplianceDetail);
    const checks = rosterChecks(carer, [flagged, newer("clear")], DAY, rates, ACTIVE);
    expect(checks.dbs).toEqual({ kind: "not_clear", reason: "update_service_new_information" });
  });

  it("hazard HZ-124 a registration on another register does not count", () => {
    const hcpc = item({ ...registration("2027-03-31"), body: "hcpc" } as ComplianceDetail);
    const checks = rosterChecks(nurse, [item(dbs), item(rtw(null)), hcpc], DAY, rates, ACTIVE);
    expect(checks.registrationCurrent).toBe(false);
  });

  it("compares blocker lists in any order", () => {
    expect(sameBlockers(["a", "b"], ["b", "a"])).toBe(true);
    expect(sameBlockers(["a"], ["a", "b"])).toBe(false);
  });
});

describe("hazard HZ-124 one decision across the dates a shift touches", () => {
  const rtwLapsed: RosterBlocker = { kind: "right_to_work", reason: "lapsed" };
  const comp: RosterBlocker = {
    kind: "competence",
    competence: "catheter_care",
    reason: "expired",
  };
  const ok = { justification: "Covering sickness tonight", blockerKeys: [blockerKey(comp)] };
  it.each([
    ["nothing on either date", [[], []], null, { allowed: true }],
    [
      "a right to work lapsing overnight",
      [[], [rtwLapsed]],
      null,
      { allowed: false, overridable: false },
    ],
    [
      "a right to work lapsing overnight, overridden",
      [[], [rtwLapsed]],
      ok,
      { overrideRefused: "right_to_work" },
    ],
    ["the blocker shown, overridden", [[comp], [comp]], ok, { allowed: true }],
    [
      "hazard HZ-124 a registration lapsing overnight is never overridden (H-830)",
      [[], [{ kind: "registration" } as RosterBlocker]],
      { ...ok, blockerKeys: ["registration"] },
      { allowed: false, overridable: false, overrideRefused: "registration" },
    ],
    [
      "hazard HZ-124 no DBS certificate is never overridden (H-830)",
      [[{ kind: "dbs", reason: "no_certificate" } as RosterBlocker]],
      { ...ok, blockerKeys: ["dbs:no_certificate"] },
      { allowed: false, overridable: false, overrideRefused: "no_dbs" },
    ],
    [
      "a blocker not shown when overriding",
      [[comp], [{ kind: "dbs_supervised_only" } as RosterBlocker]],
      ok,
      { overrideRefused: "blockers_changed" },
    ],
    [
      "a short justification",
      [[comp]],
      { ...ok, justification: "ok" },
      { overrideRefused: "justification_required" },
    ],
  ] as const)("hazard HZ-124 %s", (_, perDay, override, expected) => {
    expect(combinedRosterDecision(perDay, override, 10)).toMatchObject(expected);
  });
});

describe("hazard HZ-123 H-835 who counts as a registered nurse or a driver", () => {
  const part = (nmcPart: "nurse" | "midwife" | "nursing_associate" | null): ComplianceDetail => ({
    ...(registration("2027-03-31") as Extract<
      ComplianceDetail,
      { kind: "professional_registration" }
    >),
    nmcPart,
  });
  it.each<[string, ComplianceDetail, boolean]>([
    ["the nurse part of the register", part("nurse"), true],
    ["a nursing associate, never", part("nursing_associate"), false],
    ["a midwife", part("midwife"), false],
    ["an NMC entry recorded before the part was asked", part(null), false],
  ])("hazard HZ-123 %s", (_name, detail, expected) => {
    const checks = rosterChecks(
      nurse,
      [item(dbs), item(rtw(null)), item(detail)],
      DAY,
      rates,
      ACTIVE,
    );
    expect(checks.registeredNurse).toBe(expected);
  });

  const driving = (licenceCheckedOn: string, insuranceExpiresOn: string): ComplianceDetail => ({
    kind: "driving_for_work",
    licenceCheckedOn,
    categories: ["B"],
    insuranceExpiresOn,
  });
  it.each<[string, StoredComplianceItem[], boolean]>([
    ["a licence check and insurance in date", [item(driving("2026-06-01", "2027-01-31"))], true],
    ["the insurance expired", [item(driving("2026-06-01", "2026-11-01"))], false],
    ["the licence check too old", [item(driving("2025-10-01", "2027-01-31"))], false],
    ["checked after the day", [item(driving("2026-11-03", "2027-01-31"))], false],
    [
      "not verified by someone else",
      [item(driving("2026-06-01", "2027-01-31"), { verifiedBy: WORKER })],
      false,
    ],
    ["no check at all", [], false],
  ])("hazard HZ-123 a driver: %s", (_name, items, expected) => {
    expect(
      rosterChecks(carer, [item(dbs), item(rtw(null)), ...items], DAY, rates, ACTIVE).driver,
    ).toBe(expected);
  });
});
