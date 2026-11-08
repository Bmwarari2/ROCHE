import { describe, expect, it } from "vitest";
import type { RetentionTrigger } from "./retention";
import {
  type ClassDue,
  dueDate,
  holdCovers,
  longestWins,
  OPEN_CASE_KINDS,
  type OpenCaseView,
  type ResolvedRule,
  type RetentionClassRow,
  type RetentionHoldView,
  type RetentionTenant,
  resolveRule,
  type SweepRecord,
  type SweepRules,
  sweepDecision,
  type TriggerFacts,
  triggerDate,
} from "./retention-sweep";

/*
 * Fixtures only: the schedule rows of docs/specs/retention.md as revised by slice 0 of the
 * retention sweeps plan (08/11/2026; classes marked provisional there). The code under test holds
 * no period; these rows stand in for the seeded `retention_class` table.
 */
type Trigger = RetentionTrigger;
const SCHEDULE: readonly (readonly [string, number, "years" | "months", Trigger])[] = [
  ["care_record", 8, "years", "care_ended"],
  ["mar_chart", 8, "years", "care_ended"],
  ["controlled_drugs_register", 2, "years", "last_entry"],
  ["complaint", 10, "years", "record_closed"],
  ["serious_incident", 20, "years", "record_closed"],
  ["riddor_report", 3, "years", "created"],
  ["staff_file.after_leaving", 6, "years", "employment_ended_or_75th_birthday"],
  ["staff_file.to_75th_birthday", 0, "years", "employment_ended_or_75th_birthday"],
  ["casework_no_sanction", 6, "years", "record_closed"],
  ["right_to_work_copy", 2, "years", "record_closed"],
  ["sickness_absence", 6, "years", "record_closed"],
  ["applicant.unsuccessful", 6, "months", "record_closed"],
  ["applicant.talent_pool", 12, "months", "created"],
  ["sponsor_record", 2, "years", "record_closed"],
  ["training_record", 10, "years", "created"],
  ["staff_wellbeing", 2, "years", "created"],
  ["rota_and_timesheet", 6, "years", "created"],
  ["working_time_record", 2, "years", "created"],
  ["working_time_opt_out", 2, "years", "record_closed"],
  ["financial_record", 6, "years", "created"],
  ["water_hygiene_record", 5, "years", "created"],
  ["organisation_document", 0, "years", "tenant_policy"],
  ["downtime_pack", 1, "months", "created"],
  ["downtime_record", 8, "years", "record_closed"],
  ["evidence_pack", 6, "years", "created"],
  ["cctv", 0, "months", "tenant_policy"],
  ["audit_event", 8, "years", "created"],
  ["audit_event.care_record", 8, "years", "care_ended"],
  ["security_log", 6, "months", "created"],
  ["ai_interaction_log", 12, "months", "created"],
  ["dpia", 8, "years", "record_closed"],
  ["invitation", 12, "months", "created"],
  ["lone_worker", 3, "years", "record_closed"],
  ["speak_up_concern", 6, "years", "record_closed"],
  ["outbreak_staff_case", 3, "years", "record_closed"],
  ["data_rights_case", 3, "years", "record_closed"],
  ["enquiry_not_assessed", 12, "months", "record_closed"],
  ["pre_admission_not_admitted", 3, "years", "record_closed"],
  ["family_notification_delivery", 12, "months", "created"],
  ["dp_breach", 6, "years", "record_closed"],
  ["whistleblowing", 6, "years", "record_closed"],
  ["medicines_stock_log", 2, "years", "created"],
  ["medicines_disposal_log", 3, "years", "created"],
  ["temperature_log", 2, "years", "created"],
  ["quality_audit", 5, "years", "record_closed"],
  ["staff_survey_response", 12, "months", "record_closed"],
  ["lone_worker_check_in", 3, "months", "created"],
  ["payroll_export", 6, "years", "created"],
];

const TENANT_A = "00000000-0000-4000-8000-00000000000a";
const TENANT_B = "00000000-0000-4000-8000-00000000000b";
const ROWS: readonly RetentionClassRow[] = SCHEDULE.map(([recordClass, period, unit, trigger]) => ({
  tenantId: null,
  recordClass,
  period,
  unit,
  trigger,
}));
const tenant: RetentionTenant = { tenantId: TENANT_A, staffFileOption: null };
/** Stands in for `retention.staff_file.birthday_age` from the rate table. */
const BIRTHDAY_AGE = 75;
const rules: SweepRules = { rows: ROWS, tenant, staffFileBirthdayAge: BIRTHDAY_AGE };
const noHolds = { legalHolds: [], openCases: [] };

const d = (s: string) => new Date(`${s}T00:00:00Z`);
const day = (x: Date | null) => (x === null ? null : x.toISOString().slice(0, 10));
const dayBefore = (s: string) => new Date(d(s).getTime() - 86_400_000);

const T = d("2027-03-15");
/** Facts that fire each trigger on T. */
const FACTS: Record<Trigger, TriggerFacts> = {
  care_ended: { dischargedAt: T },
  last_entry: { entryDates: [d("2026-01-02"), T, d("2026-11-30")] },
  record_closed: { closedAt: T },
  employment_ended_or_75th_birthday: { employmentEndedAt: T },
  created: { createdAt: T },
  tenant_policy: { createdAt: T },
};
/** Classes that count from the end of the pay reference period or financial year. */
const PERIOD_END = new Set(["rota_and_timesheet", "financial_record", "payroll_export"]);

const record = (
  recordClasses: readonly string[],
  extra: Partial<SweepRecord> = {},
): SweepRecord => ({
  subjectType: "test_record",
  subjectId: "rec-1",
  recordClasses,
  facts: {},
  ...extra,
});

describe("one case per class in retention.md", () => {
  const expected: Record<string, string | null> = {
    care_record: "2035-03-15",
    mar_chart: "2035-03-15",
    controlled_drugs_register: "2029-03-15",
    complaint: "2037-03-15",
    serious_incident: "2047-03-15",
    riddor_report: "2030-03-15",
    "staff_file.after_leaving": "2033-03-15",
    "staff_file.to_75th_birthday": "2035-06-01",
    casework_no_sanction: "2033-03-15",
    right_to_work_copy: "2029-03-15",
    sickness_absence: "2033-03-15",
    "applicant.unsuccessful": "2027-09-15",
    "applicant.talent_pool": "2028-03-15",
    sponsor_record: "2029-03-15",
    training_record: "2037-03-15",
    staff_wellbeing: "2029-03-15",
    rota_and_timesheet: "2033-03-15",
    working_time_record: "2029-03-15",
    working_time_opt_out: "2029-03-15",
    financial_record: "2033-03-15",
    water_hygiene_record: "2032-03-15",
    organisation_document: null,
    downtime_pack: "2027-04-15",
    downtime_record: "2035-03-15",
    evidence_pack: "2033-03-15",
    cctv: null,
    audit_event: "2035-03-15",
    "audit_event.care_record": "2035-03-15",
    security_log: "2027-09-15",
    ai_interaction_log: "2028-03-15",
    dpia: "2035-03-15",
    invitation: "2028-03-15",
    lone_worker: "2030-03-15",
    speak_up_concern: "2033-03-15",
    outbreak_staff_case: "2030-03-15",
    data_rights_case: "2030-03-15",
    enquiry_not_assessed: "2028-03-15",
    pre_admission_not_admitted: "2030-03-15",
    family_notification_delivery: "2028-03-15",
    dp_breach: "2033-03-15",
    whistleblowing: "2033-03-15",
    medicines_stock_log: "2029-03-15",
    medicines_disposal_log: "2030-03-15",
    temperature_log: "2029-03-15",
    quality_audit: "2032-03-15",
    staff_survey_response: "2028-03-15",
    lone_worker_check_in: "2027-06-15",
    payroll_export: "2033-03-15",
  };

  it("covers every class row", () => {
    expect(Object.keys(expected).sort()).toEqual(SCHEDULE.map(([c]) => c).sort());
  });

  it.each(SCHEDULE)("%s: %i %s from %s", (recordClass, period, unit, trigger) => {
    const rule = resolveRule(recordClass, ROWS, tenant);
    expect(rule).toMatchObject({ recordClass, period, unit, trigger, origin: "global" });

    const facts: TriggerFacts = PERIOD_END.has(recordClass)
      ? { createdAt: d("2027-03-01"), periodEndsAt: T, countsFromPeriodEnd: true }
      : FACTS[trigger];
    const r = record([recordClass], { facts, dateOfBirth: d("1960-06-01") });
    const want = expected[recordClass] ?? null;

    if (want === null) {
      expect(trigger).toBe("tenant_policy");
      expect(sweepDecision(r, rules, noHolds, d("2099-01-01"))).toEqual({
        status: "tenant_policy",
        rule,
      });
      return;
    }
    const fired = triggerDate(rule.trigger, facts);
    expect(day(fired)).toBe("2027-03-15");
    expect(
      day(dueDate(rule, fired as Date, { dateOfBirth: d("1960-06-01"), birthdayAge: 75 })),
    ).toBe(want);
    expect(sweepDecision(r, rules, noHolds, dayBefore(want))).toEqual({
      status: "retain",
      until: d(want),
      rule,
    });
    expect(sweepDecision(r, rules, noHolds, d(want))).toEqual({
      status: "due",
      since: d(want),
      rule,
    });
  });
});

describe("resolveRule", () => {
  const withTenantRow = (row: Partial<RetentionClassRow>): readonly RetentionClassRow[] => [
    ...ROWS,
    {
      tenantId: TENANT_A,
      recordClass: "care_record",
      period: 10,
      unit: "years",
      trigger: "care_ended",
      ...row,
    },
  ];

  it("takes the organisation's row when it is longer than the default", () => {
    expect(resolveRule("care_record", withTenantRow({}), tenant)).toMatchObject({
      period: 10,
      origin: "tenant",
    });
    const r = record(["care_record"], { facts: { dischargedAt: T } });
    const longer = { ...rules, rows: withTenantRow({}) };
    expect(sweepDecision(r, longer, noHolds, d("2036-01-01"))).toMatchObject({
      status: "retain",
      until: d("2037-03-15"),
    });
  });

  it("ignores an organisation's row shorter than the default", () => {
    expect(resolveRule("care_record", withTenantRow({ period: 7 }), tenant)).toMatchObject({
      period: 8,
      origin: "global",
    });
  });

  it("ignores another organisation's row", () => {
    expect(resolveRule("care_record", withTenantRow({ tenantId: TENANT_B }), tenant)).toMatchObject(
      {
        period: 8,
        origin: "global",
      },
    );
  });

  it("lets an organisation set a period for a tenant_policy class", () => {
    const rows = [
      ...ROWS,
      { tenantId: TENANT_A, recordClass: "cctv", period: 1, unit: "months", trigger: "created" },
    ];
    expect(resolveRule("cctv", rows, tenant)).toMatchObject({
      period: 1,
      unit: "months",
      trigger: "created",
      origin: "tenant",
    });
  });

  it("uses an organisation's own class when the schedule has none", () => {
    const rows = [
      {
        tenantId: TENANT_A,
        recordClass: "local_class",
        period: 1,
        unit: "years",
        trigger: "created",
      },
    ];
    expect(resolveRule("local_class", rows, tenant)).toMatchObject({ origin: "tenant", period: 1 });
  });

  it.each([
    ["unknown class", "no_such_class", ROWS, "unknown_class"],
    [
      "bad unit",
      "x",
      [{ tenantId: null, recordClass: "x", period: 1, unit: "days", trigger: "created" }],
      "invalid_row",
    ],
    [
      "bad trigger",
      "x",
      [{ tenantId: null, recordClass: "x", period: 1, unit: "years", trigger: "admitted" }],
      "invalid_row",
    ],
    [
      "negative period",
      "x",
      [{ tenantId: null, recordClass: "x", period: -1, unit: "years", trigger: "created" }],
      "invalid_row",
    ],
    [
      "unreadable organisation row and no schedule row",
      "x",
      [{ tenantId: TENANT_A, recordClass: "x", period: 1.5, unit: "years", trigger: "created" }],
      "invalid_row",
    ],
  ] as const)("%s is never destroyed (provisional, H-1585)", (_name, recordClass, rows, origin) => {
    const rule = resolveRule(recordClass, rows, tenant);
    expect(rule).toEqual({
      recordClass,
      requestedClass: recordClass,
      period: 0,
      unit: "years",
      trigger: "tenant_policy",
      origin,
    });
    const r = record([recordClass], { facts: { createdAt: d("2000-01-01") } });
    expect(sweepDecision(r, { ...rules, rows }, noHolds, d("2099-01-01")).status).toBe(
      "tenant_policy",
    );
  });

  it("falls back to the schedule when the organisation's row cannot be read", () => {
    const rows = withTenantRow({ unit: "weeks" });
    expect(resolveRule("care_record", rows, tenant)).toMatchObject({ period: 8, origin: "global" });
  });

  it.each([
    [null, "staff_file.to_75th_birthday"],
    ["staff_file.to_75th_birthday", "staff_file.to_75th_birthday"],
    ["staff_file.after_leaving", "staff_file.after_leaving"],
  ] as const)("staff_file with option %s resolves to %s (provisional, H-1583)", (option, row) => {
    expect(resolveRule("staff_file", ROWS, { ...tenant, staffFileOption: option })).toMatchObject({
      recordClass: row,
      requestedClass: "staff_file",
    });
  });
});

describe("triggerDate", () => {
  it.each([
    [
      "care ended by death",
      "care_ended",
      { diedAt: d("2027-02-01"), dischargedAt: T },
      "2027-02-01",
    ],
    ["care ended by discharge", "care_ended", { dischargedAt: T }, "2027-03-15"],
    ["person still in care", "care_ended", { receivingCare: true, dischargedAt: T }, null],
    ["person never discharged", "care_ended", {}, null],
    ["latest entry on the page", "last_entry", FACTS.last_entry, "2027-03-15"],
    ["page with no entries", "last_entry", { entryDates: [] }, null],
    ["no entries given", "last_entry", {}, null],
    ["closed record", "record_closed", { closedAt: T }, "2027-03-15"],
    ["open record", "record_closed", { closedAt: null }, null],
    ["leaver", "employment_ended_or_75th_birthday", { employmentEndedAt: T }, "2027-03-15"],
    ["still employed", "employment_ended_or_75th_birthday", { employmentEndedAt: null }, null],
    ["created", "created", { createdAt: T }, "2027-03-15"],
    ["not created", "created", {}, null],
    [
      "pay period end",
      "created",
      { createdAt: d("2027-03-01"), periodEndsAt: T, countsFromPeriodEnd: true },
      "2027-03-15",
    ],
    [
      "made after the period ended counts from the later date",
      "created",
      { createdAt: d("2027-04-02"), periodEndsAt: T, countsFromPeriodEnd: true },
      "2027-04-02",
    ],
    ["period end not known yet", "created", { createdAt: T, countsFromPeriodEnd: true }, null],
    ["tenant policy", "tenant_policy", { createdAt: T }, null],
  ] as const)("%s", (_name, trigger, facts, expected) => {
    expect(day(triggerDate(trigger, facts))).toBe(expected);
  });
});

describe("dueDate: leap days, month ends and the staff file", () => {
  const rule = (recordClass: string) => resolveRule(recordClass, ROWS, tenant);
  const staff = (dob: string | null) => ({
    dateOfBirth: dob ? d(dob) : null,
    birthdayAge: BIRTHDAY_AGE,
  });

  it.each([
    ["29 February plus 8 years lands on a leap day", "care_record", "2024-02-29", "2032-02-29"],
    [
      "29 February plus 2 years rolls back",
      "controlled_drugs_register",
      "2024-02-29",
      "2026-02-28",
    ],
    ["31 August plus 6 months", "applicant.unsuccessful", "2026-08-31", "2027-02-28"],
    [
      "31 August plus 6 months into a leap year",
      "applicant.unsuccessful",
      "2027-08-31",
      "2028-02-29",
    ],
    ["31 January plus 1 month", "downtime_pack", "2027-01-31", "2027-02-28"],
    ["30 November plus 3 months", "lone_worker_check_in", "2026-11-30", "2027-02-28"],
    ["29 February plus 12 months", "invitation", "2028-02-29", "2029-02-28"],
  ])("%s", (_name, recordClass, from, expected) => {
    expect(day(dueDate(rule(recordClass), d(from)))).toBe(expected);
  });

  it.each([
    ["75th birthday after leaving", "1960-06-01", "2035-06-01"],
    ["75th birthday before leaving: due on leaving", "1950-01-01", "2027-03-15"],
    ["born on 29 February", "1960-02-29", "2035-02-28"],
    ["no date of birth: kept for a person to decide", null, null],
  ])("to the 75th birthday, %s", (_name, dob, expected) => {
    expect(day(dueDate(rule("staff_file.to_75th_birthday"), T, staff(dob)))).toBe(expected);
  });

  it("to the 75th birthday needs the staff facts", () => {
    expect(dueDate(rule("staff_file.to_75th_birthday"), T)).toBeNull();
  });

  it("an organisation that lengthens the birthday row keeps the later date", () => {
    const rows = [
      ...ROWS,
      {
        tenantId: TENANT_A,
        recordClass: "staff_file.to_75th_birthday",
        period: 10,
        unit: "years",
        trigger: "employment_ended_or_75th_birthday",
      },
    ];
    const lengthened = resolveRule("staff_file", rows, tenant);
    expect(day(dueDate(lengthened, T, staff("1950-01-01")))).toBe("2037-03-15");
    expect(day(dueDate(lengthened, T, staff("1970-01-01")))).toBe("2045-01-01");
  });

  it("six years after leaving needs no date of birth", () => {
    expect(day(dueDate(rule("staff_file.after_leaving"), T, staff(null)))).toBe("2033-03-15");
  });

  it("a tenant_policy class has no due date", () => {
    expect(dueDate(rule("cctv"), T)).toBeNull();
  });
});

describe("staff file through sweepDecision", () => {
  const staffRecord = (facts: TriggerFacts, dob: string | null) =>
    record(["staff_file"], { staffId: "staff-1", facts, dateOfBirth: dob ? d(dob) : null });

  it("a member of staff still employed has no trigger, even past their 75th birthday", () => {
    expect(
      sweepDecision(
        staffRecord({ employmentEndedAt: null }, "1940-01-01"),
        rules,
        noHolds,
        d("2030-01-01"),
      ),
    ).toMatchObject({ status: "no_trigger_yet" });
  });

  it("75th birthday before leaving: due from the leaving date", () => {
    expect(
      sweepDecision(staffRecord({ employmentEndedAt: T }, "1950-01-01"), rules, noHolds, T),
    ).toMatchObject({ status: "due", since: T });
  });

  it("75th birthday after leaving: kept until the birthday", () => {
    expect(
      sweepDecision(staffRecord({ employmentEndedAt: T }, "1960-06-01"), rules, noHolds, T),
    ).toMatchObject({ status: "retain", until: d("2035-06-01") });
  });

  it("no date of birth: no due date yet", () => {
    expect(
      sweepDecision(staffRecord({ employmentEndedAt: T }, null), rules, noHolds, d("2099-01-01")),
    ).toMatchObject({ status: "no_trigger_yet" });
  });

  it("the after-leaving option counts six years from leaving", () => {
    const after = {
      ...rules,
      tenant: { ...tenant, staffFileOption: "staff_file.after_leaving" as const },
    };
    expect(
      sweepDecision(staffRecord({ employmentEndedAt: T }, "1960-06-01"), after, noHolds, T),
    ).toMatchObject({ status: "retain", until: d("2033-03-15") });
  });
});

describe("longestWins", () => {
  const rule = (recordClass: string): ResolvedRule => resolveRule(recordClass, ROWS, tenant);
  const cd: ClassDue = { rule: rule("controlled_drugs_register"), due: d("2029-03-15") };
  const mar: ClassDue = { rule: rule("mar_chart"), due: d("2035-03-15") };

  it.each([
    ["the later class wins", [cd, mar], { kind: "due", due: d("2035-03-15"), rule: mar.rule }],
    ["order does not matter", [mar, cd], { kind: "due", due: d("2035-03-15"), rule: mar.rule }],
    ["one class", [cd], { kind: "due", due: d("2029-03-15"), rule: cd.rule }],
    [
      "a class not yet triggered keeps the record",
      [cd, { ...mar, due: null }],
      { kind: "no_trigger_yet", rule: mar.rule },
    ],
    [
      "a tenant_policy class keeps it indefinitely",
      [{ rule: rule("cctv"), due: null }, cd, { ...mar, due: null }],
      { kind: "tenant_policy", rule: rule("cctv") },
    ],
    ["no class: never destroyed", [], { kind: "tenant_policy", rule: null }],
  ] as const)("%s", (_name, decisions, expected) => {
    expect(longestWins(decisions)).toEqual(expected);
  });

  it("a controlled drug administration is kept for the mar_chart period", () => {
    const administration = record(["controlled_drugs_register", "mar_chart"], {
      personId: "person-1",
      facts: { entryDates: [d("2027-01-10")], dischargedAt: T },
    });
    // The register page's two years have passed; the person's MAR keeps it.
    expect(sweepDecision(administration, rules, noHolds, d("2030-01-01"))).toEqual({
      status: "retain",
      until: d("2035-03-15"),
      rule: rule("mar_chart"),
    });
    expect(sweepDecision(administration, rules, noHolds, d("2035-03-15"))).toEqual({
      status: "due",
      since: d("2035-03-15"),
      rule: rule("mar_chart"),
    });
    // While the person is in care the MAR has no trigger, so the register entry stays too.
    const inCare = { ...administration, facts: { ...administration.facts, receivingCare: true } };
    expect(sweepDecision(inCare, rules, noHolds, d("2040-01-01"))).toEqual({
      status: "no_trigger_yet",
      rule: rule("mar_chart"),
    });
  });
});

describe("holdCovers", () => {
  const hold = (h: Partial<RetentionHoldView>): RetentionHoldView => ({
    personId: null,
    subjectType: null,
    subjectId: null,
    releasedAt: null,
    ...h,
  });
  const rec = record(["care_record"], {
    personId: "person-1",
    staffId: "staff-1",
    applicantId: "applicant-1",
    locationId: "location-1",
    occurredAt: d("2027-03-15"),
  });

  it.each([
    ["a hold on the person", hold({ personId: "person-1" }), true],
    ["a hold on another person", hold({ personId: "person-2" }), false],
    ["a hold on the member of staff", hold({ staffId: "staff-1" }), true],
    ["a hold on another member of staff", hold({ staffId: "staff-2" }), false],
    ["a hold on the applicant", hold({ applicantId: "applicant-1" }), true],
    ["a hold on the record", hold({ subjectType: "test_record", subjectId: "rec-1" }), true],
    ["a hold on another record", hold({ subjectType: "test_record", subjectId: "rec-2" }), false],
    ["a hold on the class", hold({ recordClass: "care_record" }), true],
    ["a hold on another class", hold({ recordClass: "complaint" }), false],
    ["a hold on the location", hold({ locationId: "location-1" }), true],
    ["a hold on another location", hold({ locationId: "location-2" }), false],
    ["a date range around the record", hold({ from: d("2027-01-01"), to: d("2027-12-31") }), true],
    ["a range ending on the record's date", hold({ to: d("2027-03-15") }), true],
    ["a range starting on the record's date", hold({ from: d("2027-03-15") }), true],
    ["a range before the record", hold({ from: d("2026-01-01"), to: d("2026-12-31") }), false],
    ["a range after the record", hold({ from: d("2027-04-01") }), false],
    [
      "a location in a range, both matching",
      hold({ locationId: "location-1", from: d("2027-01-01"), to: d("2027-06-30") }),
      true,
    ],
    [
      "a location in a range, outside the range",
      hold({ locationId: "location-1", from: d("2028-01-01") }),
      false,
    ],
    [
      "a person's records of one class",
      hold({ personId: "person-1", recordClass: "care_record" }),
      true,
    ],
    [
      "a person's records of another class",
      hold({ personId: "person-1", recordClass: "complaint" }),
      false,
    ],
    ["a released hold on the person", hold({ personId: "person-1", releasedAt: T }), false],
    ["a released hold on the class", hold({ recordClass: "care_record", releasedAt: T }), false],
    ["a hold naming nothing", hold({}), false],
  ])("%s: %s", (_name, h, expected) => {
    expect(holdCovers(rec, [h])).toBe(expected);
  });

  it("a hold on staff_file covers the chosen staff file class, and the reverse", () => {
    const file = record(["staff_file.to_75th_birthday"]);
    expect(holdCovers(file, [hold({ recordClass: "staff_file" })])).toBe(true);
    expect(
      holdCovers(record(["staff_file"]), [hold({ recordClass: "staff_file.after_leaving" })]),
    ).toBe(true);
    expect(holdCovers(record(["staff_wellbeing"]), [hold({ recordClass: "staff_file" })])).toBe(
      false,
    );
  });

  it("a record with no location or date stays under a hold that names one", () => {
    const bare = record(["care_record"]);
    expect(holdCovers(bare, [hold({ locationId: "location-1" })])).toBe(true);
    expect(holdCovers(bare, [hold({ from: d("2027-01-01"), to: d("2027-12-31") })])).toBe(true);
  });

  it("behaves as isUnderLegalHold for a hold on a person or a record", () => {
    const both = hold({ personId: "person-2", subjectType: "test_record", subjectId: "rec-1" });
    expect(holdCovers(rec, [both])).toBe(true);
  });

  const openCase = (kind: OpenCaseView["kind"], about: Partial<OpenCaseView>): OpenCaseView => ({
    kind,
    closedAt: null,
    ...about,
  });

  it.each(
    OPEN_CASE_KINDS.flatMap(
      (kind) =>
        [
          [kind, "about the person", openCase(kind, { personId: "person-1" }), true],
          [kind, "about the member of staff", openCase(kind, { staffId: "staff-1" }), true],
          [kind, "about the applicant", openCase(kind, { applicantId: "applicant-1" }), true],
          [kind, "about someone else", openCase(kind, { personId: "person-2" }), false],
          [kind, "closed", openCase(kind, { personId: "person-1", closedAt: T }), false],
        ] as const,
    ),
  )("an open %s %s holds: %s (provisional, H-1586)", (_kind, _about, c, expected) => {
    expect(holdCovers(rec, [], [c])).toBe(expected);
  });

  it("a case with no subject holds nothing", () => {
    expect(holdCovers(record(["care_record"]), [], [openCase("complaint", {})])).toBe(false);
  });
});

describe("sweepDecision outcomes", () => {
  const closed = record(["complaint"], {
    personId: "person-1",
    facts: { closedAt: d("2020-01-01") },
  });

  it.each([
    [
      "held by a legal hold, even when long past due",
      closed,
      {
        legalHolds: [
          { personId: "person-1", subjectType: null, subjectId: null, releasedAt: null },
        ],
        openCases: [],
      },
      { status: "held" },
    ],
    [
      "held by an open complaint about the person",
      closed,
      { legalHolds: [], openCases: [{ kind: "complaint", personId: "person-1", closedAt: null }] },
      { status: "held" },
    ],
    [
      "due once the hold is released",
      closed,
      {
        legalHolds: [{ personId: "person-1", subjectType: null, subjectId: null, releasedAt: T }],
        openCases: [],
      },
      { status: "due", since: d("2030-01-01"), rule: resolveRule("complaint", ROWS, tenant) },
    ],
    [
      "no trigger yet for an open record",
      record(["complaint"], { facts: { closedAt: null } }),
      noHolds,
      { status: "no_trigger_yet", rule: resolveRule("complaint", ROWS, tenant) },
    ],
    [
      "tenant policy for an organisation document",
      record(["organisation_document"], { facts: { createdAt: d("2000-01-01") } }),
      noHolds,
      { status: "tenant_policy", rule: resolveRule("organisation_document", ROWS, tenant) },
    ],
    [
      "tenant policy for a record in no class",
      record([]),
      noHolds,
      { status: "tenant_policy", rule: null },
    ],
    [
      "retain until the due date",
      record(["complaint"], { facts: { closedAt: d("2030-01-01") } }),
      noHolds,
      { status: "retain", until: d("2040-01-01"), rule: resolveRule("complaint", ROWS, tenant) },
    ],
  ] as const)("%s", (_name, r, holds, expected) => {
    expect(sweepDecision(r, rules, holds, d("2031-06-01"))).toEqual(expected);
  });
});
