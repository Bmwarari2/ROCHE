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
  tenantDefaultRateKeys,
} from "./onboarding";
import { builtinRole } from "./roles";
import {
  checkRealPersonCreation,
  checkSampleDataLoad,
  checkSampleDataRemoval,
  checkSamplePerson,
  SAMPLE_DATA_EXCLUSIONS,
  sampleFlagForNewRecord,
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
        validFrom: PAST,
        validTo: null,
      },
    ],
    [],
    LATER,
  );
}

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
    expect(list).toMatchObject({ done: 9, total: 9, readyForGoLive: true, blockers: [] });
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

describe("hazard HZ-072 sample data is flagged, never mixed with real people, and removable in one step", () => {
  it.each<[string, Parameters<typeof checkSamplePerson>[0], string[]]>([
    [
      "an invented person",
      { familyName: "Example", nhsNumber: "999 000 0018", emails: ["ada@example.invalid"] },
      [],
    ],
    [
      "a person with no NHS number or email",
      { familyName: " example ", nhsNumber: null, emails: [] },
      [],
    ],
    [
      "a realistic surname",
      { familyName: "Smith", nhsNumber: null, emails: [] },
      ["family_name_not_example"],
    ],
    [
      "an NHS number outside the test range",
      { familyName: "Example", nhsNumber: "401 023 2137", emails: [] },
      ["nhs_number_not_test_range"],
    ],
    [
      "an NHS number with a wrong check digit",
      { familyName: "Example", nhsNumber: "999 000 0019", emails: [] },
      ["nhs_number_invalid"],
    ],
    [
      "a real email domain",
      {
        familyName: "Example",
        nhsNumber: null,
        emails: ["ada@example.invalid", "ada@example.com"],
      },
      ["email_not_example_invalid"],
    ],
  ])("checks %s", (_label, person, problems) => {
    expect(checkSamplePerson(person)).toEqual(problems);
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

  it.each<[boolean, string | null]>([
    [true, "remove_sample_data_first"],
    [false, null],
  ])("adding a real person while sample data is present (%s)", (samplePresent, problem) => {
    const result = checkRealPersonCreation({ samplePresent });
    if (problem === null) expect(result).toEqual({ ok: true });
    else expect(result).toMatchObject({ ok: false, problem });
  });

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

  it("keeps sample data out of notifications, exports, reports and bills", () => {
    expect(SAMPLE_DATA_EXCLUSIONS).toEqual(
      expect.arrayContaining([
        "statutory_notifications",
        "full_export",
        "reports_and_dashboards",
        "billing_and_seats",
      ]),
    );
  });
});
