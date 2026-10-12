import { describe, expect, it } from "vitest";
import { readRateTable } from "../../test/rate-table";
import { type EffectiveAccess, resolveAccess } from "./access";
import {
  isCqcLocationId,
  isOdsCode,
  ONBOARDING_ITEMS,
  type OnboardingItemKey,
  type OnboardingState,
  onboardingChecklist,
  type PersonReadinessGap,
  type PersonReadinessInput,
  personReadinessGaps,
  tenantDefaultRateKeys,
} from "./onboarding";
import { builtinRole } from "./roles";
import {
  checkOutboundForSample,
  checkRealRecordCreation,
  checkSampleDataLoad,
  checkSampleDataRemoval,
  checkSamplePerson,
  forSurface,
  isOfcomDramaNumber,
  REAL_RECORD_CREATION_PATHS,
  SAMPLE_BADGE,
  SAMPLE_WATERMARK,
  type SampleDataSurface,
  sampleFlagForNewRecord,
  samplePersonBadge,
  samplePrintWatermark,
} from "./sample-data";

const SET_UP = new Date("2026-10-01T09:00:00Z");
const LATER = new Date("2026-10-05T09:00:00Z");
const PAST = new Date("2026-01-01T00:00:00Z");

function accessFor(roleKey: string): EffectiveAccess {
  const role = builtinRole(roleKey);
  if (!role) throw new Error(roleKey);
  return resolveAccess(
    [
      {
        roleKey,
        scopeKind: role.scopeKind,
        permissions: role.permissions,
        locationId: null,
        organisationWide: true,
        validFrom: PAST,
        validTo: null,
      },
    ],
    [],
    LATER,
  );
}

function person(extra: Partial<PersonReadinessInput> = {}): PersonReadinessInput {
  return {
    id: "p-1",
    status: "active",
    sample: false,
    hasPhoto: true,
    allergyStatus: "no_known_allergies",
    resuscitation: "recorded",
    communicationNeedsStatus: "none_identified",
    iddsiFoodLevel: "7",
    iddsiDrinkLevel: "0",
    ...extra,
  };
}

const CHAIN_STEPS = [
  { afterMinutes: 10, targetRoleKey: "registered_manager", channels: ["in_app", "push"] as const },
];

/** An organisation ready to go live. */
function ready(): OnboardingState {
  return {
    locations: [
      {
        id: "loc-1",
        regulator: "cqc",
        regulatorLocationId: "1-000000002",
        odsCode: "VX1A2",
        active: true,
        registeredManagerAssigned: true,
      },
      {
        id: "loc-2",
        regulator: "cqc",
        regulatorLocationId: null,
        odsCode: null,
        active: false,
        registeredManagerAssigned: false,
      },
    ],
    users: [
      { id: "u-owner", status: "active", owner: true, readsCareRecords: true, mfaEnrolled: true },
      { id: "u-rm", status: "active", owner: false, readsCareRecords: true, mfaEnrolled: true },
      { id: "u-cook", status: "active", owner: false, readsCareRecords: false, mfaEnrolled: false },
      { id: "u-new", status: "invited", owner: false, readsCareRecords: true, mfaEnrolled: false },
    ],
    tenantDefaults: [
      { key: "export.link_expiry_hours", changedAt: SET_UP },
      { key: "task.overdue_escalation_minutes", changedAt: SET_UP },
    ],
    rateDecisions: [
      { key: "export.link_expiry_hours", decidedAt: LATER },
      { key: "task.overdue_escalation_minutes", decidedAt: LATER },
    ],
    retentionClasses: [
      { recordClass: "care_record", trigger: "care_ended", changedAt: SET_UP },
      { recordClass: "cctv", trigger: "tenant_policy", changedAt: SET_UP },
      {
        recordClass: "staff_file.after_leaving",
        trigger: "employment_ended_or_75th_birthday",
        changedAt: SET_UP,
      },
      {
        recordClass: "staff_file.to_75th_birthday",
        trigger: "employment_ended_or_75th_birthday",
        changedAt: SET_UP,
      },
    ],
    retentionDecisions: [
      { recordClass: "care_record", kind: "accepted", decidedAt: LATER },
      { recordClass: "cctv", kind: "not_used", decidedAt: LATER },
    ],
    staffFileOption: "staff_file.to_75th_birthday",
    dpia: { state: "signed", triggers: [] },
    subProcessorsInUse: ["aws_hosting", "sentry"],
    subProcessorAcknowledgements: [
      { key: "aws_hosting", acknowledgedAt: LATER },
      { key: "sentry", acknowledgedAt: LATER },
    ],
    subProcessorChangedAt: { sentry: SET_UP },
    dataOptOut: { usesDataBeyondDirectCare: true, peopleNotChecked: 0 },
    sampleDataPresent: false,
    devices: [
      { id: "d-1", mode: "shared", active: true, mdmEnrolled: true },
      { id: "d-2", mode: "kiosk", active: false, mdmEnrolled: false },
    ],
    escalationChains: [
      "deterioration",
      "overdue_task",
      "statutory_notification",
      "post_fall_observation",
    ].map((key) => ({ key, steps: CHAIN_STEPS })),
    validatedTools: [
      { key: "news2", enabled: true, escalationPolicyDocumentId: "doc-policy-1" },
      { key: "waterlow", enabled: false, escalationPolicyDocumentId: null },
    ],
    people: [person()],
    dcb0160: { recordedAt: LATER, safetyCaseVersion: "0.1" },
    currentSafetyCaseVersion: "0.1",
  };
}

type Location = OnboardingState["locations"][number];
type RetentionDecision = OnboardingState["retentionDecisions"][number];
const loc = (s: OnboardingState): Location => s.locations[0] as Location;
const decision = (s: OnboardingState, i: number): RetentionDecision =>
  s.retentionDecisions[i] as RetentionDecision;

const itemOf = (state: OnboardingState, key: OnboardingItemKey) =>
  onboardingChecklist(state).items.find((i) => i.key === key);

describe("onboarding checklist from the organisation's state", () => {
  it("is complete and ready for go-live when the state says so", () => {
    const list = onboardingChecklist(ready());
    expect(list.items.map((i) => i.key)).toEqual(ONBOARDING_ITEMS.map((i) => i.key));
    expect(list.items.filter((i) => !i.done)).toEqual([]);
    expect(list).toMatchObject({
      done: ONBOARDING_ITEMS.length,
      total: ONBOARDING_ITEMS.length,
      readyForGoLive: true,
      blockers: [],
    });
    for (const item of list.items) expect(item.reason.length).toBeGreaterThan(10);
  });

  it.each<[string, (s: OnboardingState) => OnboardingState, OnboardingItemKey, string[], boolean]>([
    [
      "a location with no ODS code",
      (s) => ({ ...s, locations: [{ ...loc(s), odsCode: null }] }),
      "locations_identified",
      ["loc-1"],
      true,
    ],
    [
      "a CQC location ID in the wrong form",
      (s) => ({ ...s, locations: [{ ...loc(s), regulatorLocationId: "1-ABC" }] }),
      "locations_identified",
      ["loc-1"],
      true,
    ],
    ["no active location", (s) => ({ ...s, locations: [] }), "locations_identified", [], true],
    [
      "a location without a Registered Manager",
      (s) => ({ ...s, locations: [{ ...loc(s), registeredManagerAssigned: false }] }),
      "registered_managers",
      ["loc-1"],
      true,
    ],
    [
      "no location for a manager",
      (s) => ({ ...s, locations: [] }),
      "registered_managers",
      [],
      true,
    ],
    [
      "only the owner has joined",
      (s) => ({ ...s, users: s.users.filter((u) => u.owner) }),
      "first_users_with_mfa",
      [],
      true,
    ],
    [
      "a care reader without MFA",
      (s) => ({
        ...s,
        users: [
          ...s.users,
          {
            id: "u-carer",
            status: "active",
            owner: false,
            readsCareRecords: true,
            mfaEnrolled: false,
          },
        ],
      }),
      "first_users_with_mfa",
      ["u-carer"],
      true,
    ],
    [
      "a default changed by Harbour after it was reviewed",
      (s) => ({
        ...s,
        tenantDefaults: [
          { key: "export.link_expiry_hours", changedAt: new Date("2026-10-09T00:00:00Z") },
        ],
      }),
      "rates_reviewed",
      ["export.link_expiry_hours"],
      false,
    ],
    [
      "a default never reviewed",
      (s) => ({ ...s, rateDecisions: [] }),
      "rates_reviewed",
      ["export.link_expiry_hours", "task.overdue_escalation_minutes"],
      false,
    ],
    [
      "no staff file option chosen",
      (s) => ({ ...s, staffFileOption: null }),
      "retention_reviewed",
      ["staff_file"],
      true,
    ],
    [
      "a policy class only accepted, not set",
      (s) => ({
        ...s,
        retentionDecisions: [
          decision(s, 0),
          { recordClass: "cctv", kind: "accepted", decidedAt: LATER },
        ],
      }),
      "retention_reviewed",
      ["cctv"],
      true,
    ],
    [
      "a decision older than the schedule change",
      (s) => ({
        ...s,
        retentionDecisions: [
          { recordClass: "care_record", kind: "accepted", decidedAt: PAST },
          decision(s, 1),
        ],
      }),
      "retention_reviewed",
      ["care_record"],
      true,
    ],
    [
      "a DPIA not started",
      (s) => ({ ...s, dpia: { state: "not_started", triggers: [] } }),
      "dpia_signed",
      [],
      true,
    ],
    [
      "a DPIA in draft",
      (s) => ({ ...s, dpia: { state: "draft", triggers: [] } }),
      "dpia_signed",
      [],
      true,
    ],
    [
      "a DPIA awaiting sign-off",
      (s) => ({ ...s, dpia: { state: "prepared", triggers: [] } }),
      "dpia_signed",
      [],
      true,
    ],
    [
      "a DPIA due for review",
      (s) => ({
        ...s,
        dpia: {
          state: "review_due",
          triggers: [{ kind: "feature_enabled", items: ["module.finance"] }],
        },
      }),
      "dpia_signed",
      ["feature_enabled"],
      true,
    ],
    [
      "a sub-processor changed since it was acknowledged",
      (s) => ({ ...s, subProcessorChangedAt: { sentry: new Date("2026-10-09T00:00:00Z") } }),
      "sub_processors_acknowledged",
      ["sentry"],
      false,
    ],
    [
      "a sub-processor never acknowledged",
      (s) => ({ ...s, subProcessorsInUse: [...s.subProcessorsInUse, "uk_sms_gateway"] }),
      "sub_processors_acknowledged",
      ["uk_sms_gateway"],
      false,
    ],
    [
      "the opt-out question unanswered",
      (s) => ({ ...s, dataOptOut: { usesDataBeyondDirectCare: null, peopleNotChecked: 0 } }),
      "data_opt_out",
      [],
      false,
    ],
    [
      "people whose opt-out was not checked",
      (s) => ({ ...s, dataOptOut: { usesDataBeyondDirectCare: true, peopleNotChecked: 3 } }),
      "data_opt_out",
      [],
      false,
    ],
    [
      "sample data still present",
      (s) => ({ ...s, sampleDataPresent: true }),
      "sample_data_removed",
      [],
      true,
    ],
  ])("not done with %s", (_label, change, key, outstanding, blocks) => {
    const list = onboardingChecklist(change(ready()));
    const item = list.items.find((i) => i.key === key);
    expect(item?.done).toBe(false);
    expect(item?.outstanding).toEqual(outstanding);
    expect(list.readyForGoLive).toBe(!blocks);
    expect(list.blockers.includes(key)).toBe(blocks);
  });

  it("treats a location under another regulator as identified by any regulator ID", () => {
    const s = ready();
    const state = {
      ...s,
      locations: [{ ...loc(s), regulator: "ciw", regulatorLocationId: "SIN-00012345" }],
    };
    expect(itemOf(state, "locations_identified")?.done).toBe(true);
    const blank = {
      ...s,
      locations: [{ ...loc(s), regulator: "ciw", regulatorLocationId: "  " }],
    };
    expect(itemOf(blank, "locations_identified")?.done).toBe(false);
  });

  it("counts the opt-out as done when data is used for direct care only", () => {
    const s = ready();
    expect(
      itemOf(
        { ...s, dataOptOut: { usesDataBeyondDirectCare: false, peopleNotChecked: 7 } },
        "data_opt_out",
      )?.done,
    ).toBe(true);
  });

  it("says how many in plain English, from the state", () => {
    const s = ready();
    const one = { ...s, locations: [{ ...loc(s), odsCode: "bad" }] };
    expect(itemOf(one, "locations_identified")?.reason).toBe(
      "1 location needs a valid regulator location ID or ODS code.",
    );
    expect(
      itemOf(
        { ...s, dataOptOut: { usesDataBeyondDirectCare: true, peopleNotChecked: 1 } },
        "data_opt_out",
      )?.reason,
    ).toBe("1 person's opt-out status has not been checked.");
  });
});

describe("identifier checks", () => {
  it.each<[string | null, boolean]>([
    ["1-000000002", true],
    ["1-1", true],
    ["1-", false],
    ["2-000000002", false],
    ["1-12a", false],
    [`1-${"9".repeat(30)}`, false],
    [null, false],
  ])("CQC location ID %s: %s", (value, ok) => {
    expect(isCqcLocationId(value)).toBe(ok);
  });

  it.each<[string | null, boolean]>([
    ["VX1A2", true],
    ["ABC", true],
    ["AB", false],
    ["vx1a2", false],
    ["VX1-A2", false],
    ["ABCDEFGHIJK", false],
    [null, false],
  ])("ODS code %s: %s", (value, ok) => {
    expect(isOdsCode(value)).toBe(ok);
  });

  it("finds the tenant-default rows in the real rate table", () => {
    const keys = tenantDefaultRateKeys(readRateTable());
    expect(keys).toEqual(
      expect.arrayContaining([
        "export.link_expiry_hours",
        "dpia.review_interval_months",
        "sub_processor.notice_days",
      ]),
    );
    expect(keys).not.toContain("nmw.hourly.21_plus");
    expect(keys).toEqual([...new Set(keys)].sort());
  });
});

describe("go-live clinical items worked out from state", () => {
  it("lists the clinical go-live items as blocking", () => {
    const blocking = ONBOARDING_ITEMS.filter((i) => i.requiredForGoLive).map((i) => i.key);
    expect(blocking).toEqual(
      expect.arrayContaining([
        "shared_devices_enrolled",
        "escalation_chains_set",
        "escalation_policies_linked",
        "clinical_settings_reviewed",
        "people_ready",
        "dcb0160_recorded",
      ]),
    );
  });

  it.each<[string, (s: OnboardingState) => OnboardingState, OnboardingItemKey, string[]]>([
    [
      "an active shared device not enrolled",
      (s) => ({
        ...s,
        devices: [...s.devices, { id: "d-9", mode: "kiosk", active: true, mdmEnrolled: false }],
      }),
      "shared_devices_enrolled",
      ["d-9"],
    ],
    [
      "hazard HZ-014 a deterioration alert with no escalation chain",
      (s) => ({
        ...s,
        escalationChains: s.escalationChains.filter((c) => c.key !== "deterioration"),
      }),
      "escalation_chains_set",
      ["deterioration"],
    ],
    [
      "hazard HZ-027 a post-fall chain with no steps",
      (s) => ({
        ...s,
        escalationChains: s.escalationChains.map((c) =>
          c.key === "post_fall_observation" ? { ...c, steps: [] } : c,
        ),
      }),
      "escalation_chains_set",
      ["post_fall_observation"],
    ],
    [
      "an escalation chain that is not valid",
      (s) => ({
        ...s,
        escalationChains: s.escalationChains.map((c) =>
          c.key === "overdue_task"
            ? { ...c, steps: [{ afterMinutes: 10, channels: ["in_app"] }] }
            : c,
        ),
      }),
      "escalation_chains_set",
      ["overdue_task"],
    ],
    [
      "hazard HZ-014 NEWS2 switched on with no escalation policy linked",
      (s) => ({
        ...s,
        validatedTools: [{ key: "news2", enabled: true, escalationPolicyDocumentId: null }],
      }),
      "escalation_policies_linked",
      ["news2"],
    ],
    [
      "hazard HZ-014 MUST switched on with a policy document but bands the links do not cover",
      (s) => ({
        ...s,
        validatedTools: [
          {
            key: "must",
            enabled: true,
            escalationPolicyDocumentId: "0193a000-0000-7000-8000-00000000d001",
            escalationPolicyLinked: false,
          },
        ],
      }),
      "escalation_policies_linked",
      ["must"],
    ],
    [
      "hazard HZ-027 post-fall observation figures not reviewed by the clinical lead",
      (s) => ({
        ...s,
        tenantDefaults: [...s.tenantDefaults, { key: "falls.monitoring_hours", changedAt: SET_UP }],
      }),
      "clinical_settings_reviewed",
      ["falls.monitoring_hours"],
    ],
    [
      "the shared-device auto-lock not reviewed",
      (s) => ({
        ...s,
        tenantDefaults: [
          ...s.tenantDefaults,
          { key: "mobile.auto_lock_seconds.shared", changedAt: SET_UP },
        ],
      }),
      "clinical_settings_reviewed",
      ["mobile.auto_lock_seconds.shared"],
    ],
    [
      "no DCB0160 assessment",
      (s) => ({ ...s, dcb0160: { recordedAt: null, safetyCaseVersion: null } }),
      "dcb0160_recorded",
      [],
    ],
    [
      "a DCB0160 assessment for an earlier safety case",
      (s) => ({ ...s, dcb0160: { recordedAt: LATER, safetyCaseVersion: "0.0" } }),
      "dcb0160_recorded",
      ["0.1"],
    ],
  ])("not done with %s", (_label, change, key, outstanding) => {
    const list = onboardingChecklist(change(ready()));
    const item = list.items.find((i) => i.key === key);
    expect(item?.done).toBe(false);
    expect(item?.outstanding).toEqual(outstanding);
    expect(list.blockers).toContain(key);
  });

  it("is done with no shared devices registered, and with a disabled tool lacking a policy", () => {
    const s = ready();
    const state = {
      ...s,
      devices: [{ id: "d-1", mode: "personal" as const, active: true, mdmEnrolled: false }],
      validatedTools: [{ key: "waterlow", enabled: false, escalationPolicyDocumentId: null }],
    };
    expect(itemOf(state, "shared_devices_enrolled")?.done).toBe(true);
    expect(itemOf(state, "escalation_policies_linked")?.done).toBe(true);
    expect(itemOf({ ...s, devices: [] }, "shared_devices_enrolled")?.reason).toContain("No shared");
    // A tool whose links cover every result is linked, with or without a document uploaded.
    const linked = {
      ...s,
      validatedTools: [
        {
          key: "news2",
          enabled: true,
          escalationPolicyDocumentId: null,
          escalationPolicyLinked: true,
        },
      ],
    };
    expect(itemOf(linked, "escalation_policies_linked")?.done).toBe(true);
  });

  it("keeps clinical settings out of the non-blocking settings review", () => {
    const s = ready();
    const state = {
      ...s,
      tenantDefaults: [...s.tenantDefaults, { key: "falls.monitoring_hours", changedAt: SET_UP }],
    };
    expect(itemOf(state, "rates_reviewed")?.done).toBe(true);
    expect(itemOf(state, "clinical_settings_reviewed")?.done).toBe(false);
  });
});

describe("person readiness before go-live", () => {
  it.each<[string, Partial<PersonReadinessInput>, PersonReadinessGap[]]>([
    ["a person with everything recorded", {}, []],
    ["hazard HZ-001 no photo for identification", { hasPhoto: false }, ["photo"]],
    ["hazard HZ-007 allergy status unknown", { allergyStatus: "unknown" }, ["allergy_status"]],
    ["no known allergies is a recorded fact", { allergyStatus: "no_known_allergies" }, []],
    ["hazard HZ-015 no resuscitation status", { resuscitation: "not_recorded" }, ["resuscitation"]],
    [
      "hazard HZ-015 a recorded 'no decision in place' counts",
      { resuscitation: "no_decision_in_place" },
      [],
    ],
    [
      "hazard HZ-023 communication needs not recorded",
      { communicationNeedsStatus: "not_recorded" },
      ["communication_needs"],
    ],
    ["hazard HZ-016 no IDDSI drink level", { iddsiDrinkLevel: null }, ["iddsi_levels"]],
    ["hazard HZ-016 no IDDSI food level", { iddsiFoodLevel: null }, ["iddsi_levels"]],
    [
      "nothing recorded at all",
      {
        hasPhoto: false,
        allergyStatus: "unknown",
        resuscitation: "not_recorded",
        communicationNeedsStatus: "not_recorded",
        iddsiFoodLevel: null,
        iddsiDrinkLevel: null,
      },
      ["photo", "allergy_status", "resuscitation", "communication_needs", "iddsi_levels"],
    ],
  ])("%s", (_label, extra, gaps) => {
    expect(personReadinessGaps(person(extra))).toEqual(gaps);
  });

  it("blocks go-live while a current person lacks something, naming what", () => {
    const s = ready();
    const state = {
      ...s,
      people: [
        person({ id: "p-1" }),
        person({ id: "p-2", hasPhoto: false, resuscitation: "not_recorded" }),
        person({ id: "p-3", status: "discharged", hasPhoto: false }),
        person({ id: "p-4", sample: true, hasPhoto: false }),
      ],
    };
    const item = itemOf(state, "people_ready");
    expect(item).toMatchObject({
      done: false,
      outstanding: ["p-2"],
      people: [{ personId: "p-2", gaps: ["photo", "resuscitation"] }],
    });
    expect(onboardingChecklist(state).blockers).toContain("people_ready");
    expect(itemOf(ready(), "people_ready")).toMatchObject({ done: true, people: [] });
  });
});

describe("hazard HZ-072 sample data is flagged, never mixed with real people, and removable in one step", () => {
  const invented = {
    familyName: "Example",
    nhsNumber: "999 000 0018",
    emails: ["ada@example.invalid"],
    phones: ["07700 900123", "+44 20 7946 0123"],
    address: { line1: "1 Example Street", postcode: "ZZ99 3AA" },
  };

  it.each<[string, Partial<Parameters<typeof checkSamplePerson>[0]>, string[]]>([
    ["an invented person", {}, []],
    [
      "a person with no identifiers, phones or address",
      { familyName: " example ", nhsNumber: null, emails: [], phones: [], address: null },
      [],
    ],
    [
      "an invented address with no postcode",
      { address: { line1: "2 Example Road", postcode: null } },
      [],
    ],
    ["a realistic surname", { familyName: "Smith" }, ["family_name_not_example"]],
    [
      "an NHS number outside the test range",
      { nhsNumber: "123 456 7890" },
      ["nhs_number_not_valid_test_number"],
    ],
    [
      "a 999 NHS number with a wrong check digit",
      { nhsNumber: "999 000 0019" },
      ["nhs_number_not_valid_test_number"],
    ],
    [
      "a real email domain",
      { emails: ["ada@example.invalid", "ada@example.com"] },
      ["email_not_example_invalid"],
    ],
    [
      "a telephone number outside Ofcom's drama ranges",
      { phones: ["07700 123456"] },
      ["phone_not_drama_number"],
    ],
    ["a telephone number with letters", { phones: ["07700 9001AB"] }, ["phone_not_drama_number"]],
    [
      "a street that could be real",
      { address: { line1: "1 High Street", postcode: null } },
      ["address_not_invented"],
    ],
    [
      "a real-looking postcode",
      { address: { line1: "1 Example Street", postcode: "LS1 1AA" } },
      ["address_not_invented"],
    ],
  ])("checks %s", (_label, extra, problems) => {
    expect(checkSamplePerson({ ...invented, ...extra })).toEqual(problems);
  });

  it.each<[string, boolean]>([
    ["07700 900000", true],
    ["07700900999", true],
    ["+44 7700 900500", true],
    ["0113 496 0123", true],
    ["(01632) 960 001", true],
    ["028 9649 6123", true],
    ["07700 901000", false],
    ["0113 496 1000", false],
    ["07700 90012", false],
  ])("Ofcom drama number %s: %s", (phone, ok) => {
    expect(isOfcomDramaNumber(phone)).toBe(ok);
  });

  it.each<[string, boolean[], boolean | "refused"]>([
    ["a note about a sample person", [true], true],
    ["a note about a real person", [false], false],
    ["a record with no references", [], false],
    ["an incident involving a sample and a real person", [true, false], "refused"],
  ])("flags %s", (_label, refs, expected) => {
    const result = sampleFlagForNewRecord(refs.map((sample) => ({ sample })));
    if (expected === "refused")
      expect(result).toMatchObject({ ok: false, problem: "mixes_sample_and_real" });
    else expect(result).toEqual({ ok: true, sample: expected });
  });

  const items = [
    { id: "p-real", sample: false },
    { id: "p-sample", sample: true },
  ];
  it.each<[SampleDataSurface, string[]]>([
    ["in_app_alerts", ["p-real"]],
    ["escalation_chains", ["p-real"]],
    ["handover", ["p-real"]],
    ["downtime_pack", ["p-real"]],
    ["bulk_prints", ["p-real"]],
    ["statutory_notifications", ["p-real"]],
    ["full_export", ["p-real"]],
    ["reports_and_dashboards", ["p-real"]],
    ["billing_and_seats", ["p-real"]],
    ["outbound_messages", ["p-real"]],
    ["integrations", ["p-real"]],
    ["regulatory_returns", ["p-real"]],
    ["record_print", ["p-real", "p-sample"]],
    ["screens", ["p-real", "p-sample"]],
  ])("%s gets only %j", (surface, ids) => {
    expect(forSurface(surface, items).map((i) => i.id)).toEqual(ids);
  });

  it("badges a sample person on screen and watermarks any print that shows one", () => {
    expect(samplePersonBadge({ sample: true })).toEqual(SAMPLE_BADGE);
    expect(samplePersonBadge({ sample: false })).toBeNull();
    expect(samplePrintWatermark(items)).toBe(SAMPLE_WATERMARK);
    expect(samplePrintWatermark([{ sample: false }])).toBeNull();
  });

  it("stops anything about a sample record leaving Harbour", () => {
    expect(checkOutboundForSample(items)).toMatchObject({ ok: false, problem: "sample_data" });
    expect(checkOutboundForSample([{ sample: false }])).toEqual({ ok: true });
  });

  it.each<[string, Parameters<typeof checkSampleDataLoad>[0], string | null]>([
    [
      "the owner in a new organisation",
      { access: accessFor("owner"), realPeople: 0, samplePresent: false },
      null,
    ],
    [
      "a Registered Manager",
      { access: accessFor("registered_manager"), realPeople: 0, samplePresent: false },
      "missing_permission",
    ],
    [
      "once real people exist",
      { access: accessFor("owner"), realPeople: 1, samplePresent: false },
      "real_people_exist",
    ],
    ["twice", { access: accessFor("owner"), realPeople: 0, samplePresent: true }, "already_loaded"],
  ])("loading: %s", (_label, input, problem) => {
    const result = checkSampleDataLoad(input);
    if (problem === null) expect(result).toEqual({ ok: true });
    else expect(result).toMatchObject({ ok: false, problem });
  });

  it.each(REAL_RECORD_CREATION_PATHS)(
    "refuses real records by %s while sample data exists",
    (path) => {
      expect(checkRealRecordCreation({ path, samplePresent: true })).toMatchObject({
        ok: false,
        problem: "remove_sample_data_first",
      });
      expect(checkRealRecordCreation({ path, samplePresent: false })).toEqual({ ok: true });
    },
  );

  const rows = [
    { sample: true, legalHold: false },
    { sample: true, legalHold: false },
  ];
  it.each<[string, Parameters<typeof checkSampleDataRemoval>[0], string | null]>([
    [
      "the whole batch, by the owner",
      { access: accessFor("owner"), rows, realReferences: 0 },
      null,
    ],
    [
      "by a Registered Manager",
      { access: accessFor("registered_manager"), rows, realReferences: 0 },
      "missing_permission",
    ],
    [
      "an empty batch",
      { access: accessFor("owner"), rows: [], realReferences: 0 },
      "nothing_to_remove",
    ],
    [
      "a batch with a real row",
      {
        access: accessFor("owner"),
        rows: [...rows, { sample: false, legalHold: false }],
        realReferences: 0,
      },
      "not_sample",
    ],
    [
      "a held row",
      { access: accessFor("owner"), rows: [{ sample: true, legalHold: true }], realReferences: 0 },
      "held",
    ],
    [
      "rows real records refer to",
      { access: accessFor("owner"), rows, realReferences: 2 },
      "referenced_by_real_records",
    ],
  ])("removing %s", (_label, input, problem) => {
    const result = checkSampleDataRemoval(input);
    if (problem === null) expect(result).toEqual({ ok: true });
    else expect(result).toMatchObject({ ok: false, problem });
  });
});
