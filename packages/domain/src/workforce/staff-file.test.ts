import { describe, expect, it } from "vitest";
import { readRateTable } from "../../test/rate-table";
import { addDays, addMonths } from "./dates";
import { reminderDays, resolveWorkforceRates } from "./rates";
import {
  type ComplianceDetail,
  complianceItemView,
  complianceReminderDue,
  dbsRecordOf,
  reminderDateOf,
  type StaffProfileFacts,
  type StoredComplianceItem,
  staffFileState,
} from "./staff-file";

const TODAY = "2026-10-31";
const rates = resolveWorkforceRates(readRateTable(), "england", TODAY, null);
const offsets = reminderDays(rates);
const WORKER = "0194d000-0000-7000-8000-00000000a001";
const HR = "0194d000-0000-7000-8000-00000000a002";
const carer: StaffProfileFacts = {
  workerId: WORKER,
  registration: null,
  previousCareWork: false,
  startsOn: "2026-09-01",
};
const nurse: StaffProfileFacts = { ...carer, registration: "nmc", previousCareWork: true };

const item = (
  detail: ComplianceDetail,
  overrides: Partial<StoredComplianceItem> = {},
): StoredComplianceItem => ({
  detail,
  verifiedOn: "2026-08-20",
  verifiedBy: HR,
  riskAssessmentSignedOn: null,
  riskAssessmentSignedBy: null,
  remindersSent: [],
  ...overrides,
});

const certificate = {
  level: "enhanced_adults_barred" as const,
  issuedOn: "2026-08-15",
  number: "001234567890",
  result: "clear" as const,
};
const dbs = (
  over: Partial<Extract<ComplianceDetail, { kind: "dbs_certificate" }>> = {},
): ComplianceDetail => ({
  kind: "dbs_certificate",
  certificate,
  updateService: null,
  barredListClearOn: null,
  ...over,
});
const rtw = (
  checks: Extract<ComplianceDetail, { kind: "right_to_work" }>["checks"],
): ComplianceDetail => ({ kind: "right_to_work", checks });
const history = (
  periods: Extract<ComplianceDetail, { kind: "employment_history" }>["periods"],
): ComplianceDetail => ({
  kind: "employment_history",
  historyStart: "2020-01",
  applicationMonth: "2026-07",
  periods,
});
const registration = (renewalDueOn: string): ComplianceDetail => ({
  kind: "professional_registration",
  body: "nmc",
  pin: "12A3456E",
  renewalDueOn,
  revalidationDueOn: renewalDueOn,
  nmcPart: "nurse",
});

const view = (stored: StoredComplianceItem, profile = carer) =>
  complianceItemView(stored, profile, TODAY, rates);

describe("Staff file items (workforce.md section 2a)", () => {
  it.each<[string, StoredComplianceItem, boolean, string[]]>([
    ["identity seen by HR", item({ kind: "identity_with_photo", document: "passport" }), true, []],
    [
      "identity not yet verified",
      item(
        { kind: "identity_with_photo", document: "passport" },
        { verifiedOn: null, verifiedBy: null },
      ),
      false,
      ["not_verified"],
    ],
    [
      "identity verified with a future date",
      item({ kind: "identity_with_photo", document: "passport" }, { verifiedOn: "2026-11-01" }),
      false,
      ["not_verified"],
    ],
    [
      "identity verified by the worker themselves",
      item({ kind: "identity_with_photo", document: "passport" }, { verifiedBy: WORKER }),
      false,
      ["self_verified"],
    ],
    ["a clear enhanced DBS with the barred list", item(dbs()), true, []],
    [
      "a DBS at the wrong level",
      item(dbs({ certificate: { ...certificate, level: "enhanced" } })),
      false,
      ["dbs_not_clear"],
    ],
    [
      "a DBS disclosure with no risk assessment",
      item(dbs({ certificate: { ...certificate, result: "information_disclosed" } })),
      false,
      ["dbs_not_clear"],
    ],
    [
      "a DBS disclosure accepted by a risk assessment signed after the certificate",
      item(dbs({ certificate: { ...certificate, result: "information_disclosed" } }), {
        riskAssessmentSignedOn: "2026-08-18",
        riskAssessmentSignedBy: HR,
      }),
      true,
      [],
    ],
    [
      "a DBS disclosure with a risk assessment signed before the certificate",
      item(dbs({ certificate: { ...certificate, result: "information_disclosed" } }), {
        riskAssessmentSignedOn: "2026-08-01",
        riskAssessmentSignedBy: HR,
      }),
      false,
      ["dbs_not_clear"],
    ],
    [
      "no certificate, a clear barred list check and a signed risk assessment",
      item(dbs({ certificate: null, barredListClearOn: "2026-08-10" }), {
        riskAssessmentSignedOn: "2026-08-11",
        riskAssessmentSignedBy: HR,
      }),
      false,
      ["dbs_supervised_only"],
    ],
    [
      "no certificate and no risk assessment",
      item(dbs({ certificate: null, barredListClearOn: "2026-08-10" })),
      false,
      ["dbs_not_clear"],
    ],
    [
      "an Update Service check that found new information",
      item(
        dbs({
          updateService: {
            subscribed: true,
            lastCheckedOn: "2026-10-01",
            lastResult: "new_information",
          },
        }),
      ),
      false,
      ["dbs_not_clear"],
    ],
    [
      "an unlimited right to work checked before the start",
      item(
        rtw([
          {
            checkedOn: "2026-08-20",
            permission: "unlimited",
            expiresOn: null,
            method: "manual_document",
          },
        ]),
      ),
      true,
      [],
    ],
    [
      "a right to work checked after the start",
      item(
        rtw([
          {
            checkedOn: "2026-09-02",
            permission: "unlimited",
            expiresOn: null,
            method: "online_share_code",
          },
        ]),
      ),
      true,
      ["right_to_work_checked_late"],
    ],
    [
      "a lapsed time-limited right to work",
      item(
        rtw([
          {
            checkedOn: "2026-08-20",
            permission: "time_limited",
            expiresOn: "2026-10-30",
            method: "online_share_code",
          },
        ]),
      ),
      false,
      ["right_to_work_lapsed"],
    ],
    ["no right to work check", item(rtw([])), false, ["right_to_work_none"]],
    [
      "an employment history with no gaps",
      item(history([{ from: "2020-01", to: null, kind: "employment" }])),
      true,
      [],
    ],
    [
      "an employment history with a gap",
      item(
        history([
          { from: "2020-01", to: "2023-12", kind: "employment" },
          { from: "2024-03", to: null, kind: "employment" },
        ]),
      ),
      false,
      ["employment_gaps"],
    ],
    [
      "a health declaration of fitness with adjustments",
      item({ kind: "health_fitness", declaredFit: true, adjustmentsAgreed: true }),
      true,
      [],
    ],
    [
      "a health declaration not yet fit",
      item({ kind: "health_fitness", declaredFit: false, adjustmentsAgreed: false }),
      false,
      ["health_not_declared_fit"],
    ],
    ["references received", item({ kind: "references", received: 2 }), true, []],
    [
      "no references received",
      item({ kind: "references", received: 0 }),
      false,
      ["references_none"],
    ],
    ["a current registration", item(registration("2027-03-31")), true, []],
    [
      "hazard HZ-123 an NMC registration without its register part says so (H-835)",
      item({
        ...(registration("2027-03-31") as Extract<
          ComplianceDetail,
          { kind: "professional_registration" }
        >),
        nmcPart: null,
      }),
      true,
      ["nmc_part_missing"],
    ],
    [
      "a registration past its renewal",
      item(registration("2026-10-30")),
      false,
      ["registration_lapsed"],
    ],
  ])("%s", (_, stored, satisfied, codes) => {
    const result = view(stored, nurse);
    expect(result.satisfied).toBe(satisfied);
    expect(result.notes.map((n) => n.code)).toEqual(codes);
  });

  it("reports the employment gap months", () => {
    const result = view(
      item(
        history([
          { from: "2020-01", to: "2023-12", kind: "employment" },
          { from: "2024-03", to: null, kind: "employment" },
        ]),
      ),
    );
    expect(result.notes).toEqual([
      { code: "employment_gaps", gaps: [{ from: "2024-01", to: "2024-02", months: 2 }] },
    ]);
  });

  it("dates a time-limited right to work by its expiry and a registration by its renewal", () => {
    expect(
      view(
        item(
          rtw([
            {
              checkedOn: "2026-08-20",
              permission: "time_limited",
              expiresOn: "2027-02-28",
              method: "online_share_code",
            },
          ]),
        ),
      ).expiresOn,
    ).toBe("2027-02-28");
    expect(view(item(registration("2027-03-31")), nurse).expiresOn).toBe("2027-03-31");
  });

  it("uses the latest right to work check, wherever it is in the list", () => {
    const result = view(
      item(
        rtw([
          {
            checkedOn: "2026-10-20",
            permission: "time_limited",
            expiresOn: "2028-10-20",
            method: "online_share_code",
          },
          {
            checkedOn: "2026-08-20",
            permission: "time_limited",
            expiresOn: "2026-10-30",
            method: "online_share_code",
          },
        ]),
      ),
    );
    expect(result).toMatchObject({ satisfied: true, expiresOn: "2028-10-20" });
  });

  it("dates the next Update Service check from the last one, at the rate table's interval", () => {
    const result = view(
      item(
        dbs({
          updateService: {
            subscribed: true,
            lastCheckedOn: "2026-06-01",
            lastResult: "no_new_information",
          },
        }),
      ),
    );
    expect(result.recheckDueOn).toBe(addMonths("2026-06-01", rates.dbsUpdateServiceCheckMonths));
    expect(result.expiresOn).toBeNull();
  });

  it("notes an Update Service check due without blocking", () => {
    const last = addMonths(TODAY, -rates.dbsUpdateServiceCheckMonths);
    const result = view(
      item(
        dbs({
          updateService: {
            subscribed: true,
            lastCheckedOn: last,
            lastResult: "no_new_information",
          },
        }),
      ),
    );
    expect(result.satisfied).toBe(true);
    expect(result.notes).toEqual([{ code: "dbs_update_service_check_due", dueOn: TODAY }]);
  });

  it("accepts a disclosure only by a risk assessment signed on or after the certificate", () => {
    const detail = dbs({ certificate: { ...certificate, result: "information_disclosed" } });
    if (detail.kind !== "dbs_certificate") throw new Error("unreachable");
    expect(dbsRecordOf(detail, certificate.issuedOn).certificate?.disclosureAccepted).toBe(true);
    expect(dbsRecordOf(detail, null).certificate?.disclosureAccepted).toBe(false);
  });
});

describe("The whole staff file (workforce.md rule 1)", () => {
  const complete = (profile: StaffProfileFacts): StoredComplianceItem[] => [
    item({ kind: "identity_with_photo", document: "passport" }),
    item(dbs()),
    item({ kind: "references", received: 2 }),
    item({ kind: "relevant_qualifications", qualifications: ["Level 3 Diploma in Adult Care"] }),
    item(history([{ from: "2020-01", to: null, kind: "employment" }])),
    item({ kind: "health_fitness", declaredFit: true, adjustmentsAgreed: false }),
    item(
      rtw([
        {
          checkedOn: "2026-08-20",
          permission: "unlimited",
          expiresOn: null,
          method: "manual_document",
        },
      ]),
    ),
    ...(profile.previousCareWork
      ? [item({ kind: "conduct_in_care_work", employersContacted: 1 })]
      : []),
    ...(profile.registration ? [item(registration("2027-03-31"))] : []),
  ];

  it.each([
    ["a care worker", carer],
    ["a registered nurse", nurse],
  ])("is complete for %s with every item satisfied", (_, profile) => {
    expect(staffFileState(profile, complete(profile), TODAY, rates)).toMatchObject({
      complete: true,
      outstanding: [],
    });
  });

  it("lists the nurse's lapsed registration and missing conduct evidence as outstanding", () => {
    const items = complete(carer).concat(item(registration("2026-10-01")));
    const state = staffFileState(nurse, items, TODAY, rates);
    expect(state.complete).toBe(false);
    expect(state.outstanding).toEqual(["conduct_in_care_work", "professional_registration"]);
  });

  it("is incomplete while the DBS is supervised only", () => {
    const items = complete(carer).map((i) =>
      i.detail.kind === "dbs_certificate"
        ? item(dbs({ certificate: null, barredListClearOn: "2026-08-10" }), {
            riskAssessmentSignedOn: "2026-08-11",
            riskAssessmentSignedBy: HR,
          })
        : i,
    );
    expect(staffFileState(carer, items, TODAY, rates).outstanding).toEqual(["dbs_certificate"]);
  });

  it("keeps a view for an item the role does not need", () => {
    const state = staffFileState(
      carer,
      complete(carer).concat(item(registration("2027-03-31"))),
      TODAY,
      rates,
    );
    expect(state.views.map((v) => v.kind)).toContain("professional_registration");
    expect(state.items.map((i) => i.kind)).not.toContain("professional_registration");
  });
});

describe("Expiry reminders (workforce.md rule 1)", () => {
  const expiring = (expiresOn: string, remindersSent: number[] = []) =>
    item(
      rtw([
        {
          checkedOn: "2026-08-20",
          permission: "time_limited",
          expiresOn,
          method: "online_share_code",
        },
      ]),
      { remindersSent },
    );

  it.each(offsets.map((days) => [days]))("raises the %i-day reminder on its day", (days) => {
    const stored = expiring(addDays(TODAY, days));
    expect(complianceReminderDue(view(stored), [], TODAY, rates)).toEqual({
      days,
      dueOn: addDays(TODAY, days),
    });
  });

  it("raises each reminder once", () => {
    const days = offsets[0] ?? 0;
    const stored = expiring(addDays(TODAY, days), [days]);
    expect(complianceReminderDue(view(stored), [days], TODAY, rates)).toBeNull();
  });

  it("raises nothing before the first reminder day or for an item that does not expire", () => {
    const first = Math.max(...offsets);
    expect(
      complianceReminderDue(view(expiring(addDays(TODAY, first + 1))), [], TODAY, rates),
    ).toBeNull();
    expect(
      complianceReminderDue(
        view(item({ kind: "identity_with_photo", document: "passport" })),
        [],
        TODAY,
        rates,
      ),
    ).toBeNull();
  });

  it("counts a DBS down to its Update Service check", () => {
    const due = addDays(TODAY, Math.min(...offsets));
    const last = addMonths(due, -rates.dbsUpdateServiceCheckMonths);
    const stored = item(
      dbs({
        updateService: { subscribed: true, lastCheckedOn: last, lastResult: "no_new_information" },
      }),
    );
    const v = view(stored);
    expect(reminderDateOf(v)).toBe(v.recheckDueOn);
    expect(complianceReminderDue(v, [], TODAY, rates)?.dueOn).toBe(v.recheckDueOn);
  });
});
