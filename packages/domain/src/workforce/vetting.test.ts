import { describe, expect, it } from "vitest";
import type { ComplianceDetail } from "./staff-file";
import {
  CONSENT_FOR_CHECK,
  consentActive,
  EVIDENCE_SOURCES,
  ITEM_OF_CHECK,
  PORT_OF_CHECK,
  VETTING_CHECK_KINDS,
  VETTING_PORTS,
  type VettingCheckKind,
  type VettingConsent,
  type VettingRequestFacts,
  type VettingRequestProblem,
  type VettingResultMap,
  vettingApplication,
  vettingCheckStillMatches,
  vettingRequestProblem,
} from "./vetting";

const TODAY = "2026-10-31";

type Dbs = Extract<ComplianceDetail, { kind: "dbs_certificate" }>;
const subscribed: Dbs = {
  kind: "dbs_certificate",
  certificate: {
    level: "enhanced_adults_barred",
    issuedOn: "2026-01-15",
    number: "009999999999",
    result: "clear",
  },
  updateService: { subscribed: true, lastCheckedOn: null, lastResult: null },
  barredListClearOn: "2026-01-02",
};
const registration: ComplianceDetail = {
  kind: "professional_registration",
  body: "nmc",
  pin: "99A9999E",
  renewalDueOn: "2026-11-30",
  revalidationDueOn: "2027-11-30",
};
const consent = (
  purpose: VettingConsent["purpose"],
  givenOn = "2026-10-01",
  withdrawnOn: string | null = null,
): VettingConsent => ({ purpose, givenOn, withdrawnOn });

const base: VettingRequestFacts = {
  kind: "nmc_register_check",
  ownFile: false,
  adapterOn: true,
  consents: [],
  idspDocument: null,
  dbs: null,
  dateOfBirth: null,
  registrationBody: "nmc",
  pin: "99A9999E",
  openCheck: false,
};

describe("the ports and checks line up (ADR-0094)", () => {
  it("every check has one port, one item and one evidence source, and every port a check", () => {
    for (const kind of VETTING_CHECK_KINDS) {
      expect(VETTING_PORTS).toContain(PORT_OF_CHECK[kind]);
      expect(ITEM_OF_CHECK[kind]).toBeTruthy();
      expect(EVIDENCE_SOURCES).toContain(kind);
    }
    expect(new Set(Object.values(PORT_OF_CHECK))).toEqual(new Set(VETTING_PORTS));
    expect(EVIDENCE_SOURCES[0]).toBe("manual");
  });
  it("only the DBS checks need the worker's consent", () => {
    expect(CONSENT_FOR_CHECK).toEqual({
      idsp_right_to_work: null,
      dbs_application: "dbs_application",
      dbs_status_check: "dbs_update_service",
      nmc_register_check: null,
    });
  });
});

describe("consent (workforce.md rule 24)", () => {
  it.each<[string, VettingConsent, boolean]>([
    ["given before today", consent("dbs_update_service"), true],
    ["given today", consent("dbs_update_service", TODAY), true],
    ["given tomorrow", consent("dbs_update_service", "2026-11-01"), false],
    ["withdrawn tomorrow", consent("dbs_update_service", "2026-10-01", "2026-11-01"), true],
    ["withdrawn today", consent("dbs_update_service", "2026-10-01", TODAY), false],
    ["withdrawn before today", consent("dbs_update_service", "2026-10-01", "2026-10-15"), false],
  ])("%s", (_name, c, active) => {
    expect(consentActive(c, TODAY)).toBe(active);
  });
});

describe("starting a check (workforce.md rule 24)", () => {
  it.each<[string, Partial<VettingRequestFacts>, VettingRequestProblem | null]>([
    // Any check
    ["one's own file", { ownFile: true }, "own_file"],
    ["the port is off (the default)", { adapterOn: false }, "adapter_off"],
    ["a check of that kind is pending", { openCheck: true }, "check_open"],
    // IDSP: British and Irish passports only
    [
      "IDSP with a British passport",
      { kind: "idsp_right_to_work", idspDocument: "british_passport" },
      null,
    ],
    [
      "IDSP with an Irish passport card",
      { kind: "idsp_right_to_work", idspDocument: "irish_passport_card" },
      null,
    ],
    [
      "IDSP with a biometric residence permit (share code instead)",
      { kind: "idsp_right_to_work", idspDocument: "biometric_residence_permit" },
      "idsp_document_not_eligible",
    ],
    [
      "IDSP with no document named",
      { kind: "idsp_right_to_work", idspDocument: null },
      "idsp_document_not_eligible",
    ],
    // DBS application: consent
    ["DBS application without consent", { kind: "dbs_application" }, "consent_missing"],
    [
      "DBS application with consent",
      { kind: "dbs_application", consents: [consent("dbs_application")] },
      null,
    ],
    [
      "DBS application with only the Update Service consent",
      { kind: "dbs_application", consents: [consent("dbs_update_service")] },
      "consent_missing",
    ],
    [
      "DBS application with withdrawn consent",
      {
        kind: "dbs_application",
        consents: [consent("dbs_application", "2026-09-01", "2026-10-30")],
      },
      "consent_missing",
    ],
    // Update Service: consent, a subscribed certificate and the date of birth
    [
      "status check without consent",
      { kind: "dbs_status_check", dbs: subscribed, dateOfBirth: "1990-04-01" },
      "consent_missing",
    ],
    [
      "status check with consent",
      {
        kind: "dbs_status_check",
        consents: [consent("dbs_update_service")],
        dbs: subscribed,
        dateOfBirth: "1990-04-01",
      },
      null,
    ],
    [
      "status check with no certificate",
      {
        kind: "dbs_status_check",
        consents: [consent("dbs_update_service")],
        dbs: null,
        dateOfBirth: "1990-04-01",
      },
      "no_certificate_number",
    ],
    [
      "status check of a certificate not subscribed",
      {
        kind: "dbs_status_check",
        consents: [consent("dbs_update_service")],
        dbs: { ...subscribed, updateService: null },
        dateOfBirth: "1990-04-01",
      },
      "not_subscribed",
    ],
    [
      "status check with no date of birth",
      { kind: "dbs_status_check", consents: [consent("dbs_update_service")], dbs: subscribed },
      "no_date_of_birth",
    ],
    // NMC: a nurse's PIN
    ["NMC check of a nurse with a PIN", {}, null],
    ["NMC check of a social worker", { registrationBody: "swe" }, "registration_not_nmc"],
    ["NMC check of a role with no register", { registrationBody: null }, "registration_not_nmc"],
    ["NMC check with no PIN recorded", { pin: null }, "no_pin"],
  ])("%s", (_name, facts, problem) => {
    expect(vettingRequestProblem({ ...base, ...facts }, TODAY)).toBe(problem);
  });
});

describe("applying a result (workforce.md rule 24)", () => {
  type Row = [string, VettingCheckKind, unknown, ComplianceDetail | null, unknown];
  it.each<Row>([
    [
      "IDSP verified adds an unlimited IDSP check to the right to work",
      "idsp_right_to_work",
      { outcome: "identity_verified", checkedOn: "2026-10-30", document: "british_passport" },
      {
        kind: "right_to_work",
        checks: [
          {
            method: "manual_document",
            checkedOn: "2026-01-01",
            permission: "time_limited",
            expiresOn: "2026-12-31",
          },
        ],
      },
      {
        ok: true,
        verifiedOn: "2026-10-30",
        detail: {
          kind: "right_to_work",
          checks: [
            {
              method: "manual_document",
              checkedOn: "2026-01-01",
              permission: "time_limited",
              expiresOn: "2026-12-31",
            },
            { method: "idsp", checkedOn: "2026-10-30", permission: "unlimited", expiresOn: null },
          ],
        },
      },
    ],
    [
      "IDSP not verified is never applied",
      "idsp_right_to_work",
      { outcome: "not_verified", checkedOn: "2026-10-30" },
      null,
      { ok: false, problem: "not_verified" },
    ],
    [
      "a DBS certificate issued is recorded with level, number, date and result only",
      "dbs_application",
      {
        outcome: "certificate_issued",
        checkedOn: "2026-10-30",
        issuedOn: "2026-10-29",
        certificateNumber: "009999999998",
        level: "enhanced_adults_barred",
        result: "information_disclosed",
      },
      subscribed,
      {
        ok: true,
        verifiedOn: "2026-10-30",
        detail: {
          kind: "dbs_certificate",
          certificate: {
            level: "enhanced_adults_barred",
            issuedOn: "2026-10-29",
            number: "009999999998",
            result: "information_disclosed",
          },
          updateService: null,
          barredListClearOn: "2026-01-02",
        },
      },
    ],
    [
      "a withdrawn application is never applied",
      "dbs_application",
      { outcome: "withdrawn", checkedOn: "2026-10-30" },
      null,
      { ok: false, problem: "application_withdrawn" },
    ],
    [
      "no new information is recorded as the last status check",
      "dbs_status_check",
      { outcome: "no_new_information", checkedOn: "2026-10-31" },
      subscribed,
      {
        ok: true,
        verifiedOn: "2026-10-31",
        detail: {
          ...subscribed,
          updateService: {
            subscribed: true,
            lastCheckedOn: "2026-10-31",
            lastResult: "no_new_information",
          },
        },
      },
    ],
    [
      "new information is recorded too (the DBS rule then blocks)",
      "dbs_status_check",
      { outcome: "new_information", checkedOn: "2026-10-31" },
      subscribed,
      {
        ok: true,
        verifiedOn: "2026-10-31",
        detail: {
          ...subscribed,
          updateService: {
            subscribed: true,
            lastCheckedOn: "2026-10-31",
            lastResult: "new_information",
          },
        },
      },
    ],
    [
      "details not matched are never applied",
      "dbs_status_check",
      { outcome: "details_not_matched", checkedOn: "2026-10-31" },
      subscribed,
      { ok: false, problem: "details_not_matched" },
    ],
    [
      "a status check once the certificate is gone",
      "dbs_status_check",
      { outcome: "no_new_information", checkedOn: "2026-10-31" },
      null,
      { ok: false, problem: "item_changed" },
    ],
    [
      "NMC registered moves the renewal date",
      "nmc_register_check",
      { outcome: "registered", checkedOn: "2026-10-31", renewalDueOn: "2027-11-30" },
      registration,
      {
        ok: true,
        verifiedOn: "2026-10-31",
        detail: { ...registration, renewalDueOn: "2027-11-30" },
      },
    ],
    [
      "NMC registered with conditions is recorded by hand",
      "nmc_register_check",
      {
        outcome: "registered_with_conditions",
        checkedOn: "2026-10-31",
        renewalDueOn: "2027-11-30",
      },
      registration,
      { ok: false, problem: "registration_has_conditions" },
    ],
    [
      "NMC not registered is never applied",
      "nmc_register_check",
      { outcome: "not_registered", checkedOn: "2026-10-31", renewalDueOn: null },
      registration,
      { ok: false, problem: "not_registered" },
    ],
    [
      "a result dated after today",
      "nmc_register_check",
      { outcome: "registered", checkedOn: "2026-11-01", renewalDueOn: "2027-11-30" },
      registration,
      { ok: false, problem: "checked_in_future" },
    ],
  ])("%s", (_name, kind, result, existing, expected) => {
    expect(
      vettingApplication(kind, result as VettingResultMap[typeof kind], existing, TODAY),
    ).toEqual(expected);
  });
});

describe("a result applies only to what was checked", () => {
  it.each<[string, VettingCheckKind, object, ComplianceDetail | null, boolean]>([
    [
      "the same certificate",
      "dbs_status_check",
      { certificateNumber: "009999999999" },
      subscribed,
      true,
    ],
    [
      "a certificate replaced since",
      "dbs_status_check",
      { certificateNumber: "009999999990" },
      subscribed,
      false,
    ],
    ["the same PIN", "nmc_register_check", { pin: "99A9999E" }, registration, true],
    ["a PIN changed since", "nmc_register_check", { pin: "99A0000E" }, registration, false],
    ["the registration removed", "nmc_register_check", { pin: "99A9999E" }, null, false],
    ["an IDSP check", "idsp_right_to_work", {}, null, true],
  ])("%s", (_name, kind, checked, existing, matches) => {
    expect(vettingCheckStillMatches(kind, checked, existing)).toBe(matches);
  });
});
