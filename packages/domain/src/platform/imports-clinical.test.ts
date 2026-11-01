import { describe, expect, it } from "vitest";
import { IMPORT_FIELDS, IMPORT_RECORD_TYPES } from "./imports";
import {
  carePlanDrafts,
  clinicalDryRun,
  importRowError,
  importTimes,
  medicineRowDraft,
  staffFileRowDetail,
  validateCarePlanImport,
  validateMedicineImport,
  validateStaffFileImport,
} from "./imports-clinical";

/**
 * Importing medicines, care plans and staff files (platform.md rules 27 to 31; slice 51): the
 * field and type rules for each, table-driven; what a valid row becomes; and the dry run's
 * outcome for every row.
 */

const TODAY = "2026-11-01";
const OPTS = { today: TODAY, allowTestNhsNumbers: true };
const NHS = "9990000018";
const VMP = "90000011000001104";

const medicine = (over: Record<string, string> = {}) => ({
  person_nhs_number: NHS,
  vmp_id: VMP,
  route_code: "26643006",
  directions: "regular",
  dose_quantity: "1",
  dose_unit_code: "428673006",
  times: "08:00 20:00",
  prescriber: "Dr Example",
  starts_on: "01/11/2026",
  source_kind: "pharmacy_mar",
  source_reference: "Pharmacy MAR, October 2026",
  ...over,
});
const codes = (v: { errors: readonly { row: number; column: string; code: string }[] }) =>
  v.errors.map((e) => `${e.row}:${e.column}:${e.code}`);

describe("the record types (rule 27)", () => {
  it("takes people, medicines, care plans and staff files, each with its fields", () => {
    expect(IMPORT_RECORD_TYPES).toEqual(["people", "medicines", "care_plans", "staff_files"]);
    for (const t of IMPORT_RECORD_TYPES)
      expect(Object.keys(IMPORT_FIELDS[t]).length).toBeGreaterThan(0);
  });
  it("hazard HZ-005 a medicine has no name column: a typed name never becomes a medicine", () => {
    const fields = Object.keys(IMPORT_FIELDS.medicines);
    expect(fields).not.toContain("name");
    expect(fields).not.toContain("medicine_name");
    expect(fields).not.toContain("product_name");
    const v = validateMedicineImport([medicine({ medicine_name: "Paracetamol" })], OPTS);
    expect(codes(v)).toContain("0:medicine_name:unknown_column");
  });
});

describe("hazard HZ-005 imported medicines (rule 28)", () => {
  it.each<[string, Record<string, string>, string[]]>([
    ["a valid regular medicine", {}, []],
    [
      "a valid when-required medicine",
      { directions: "when_required", times: "", indication: "Pain" },
      [],
    ],
    ["no dm+d code", { vmp_id: "" }, ["1:vmp_id:required"]],
    [
      "a dm+d code with a wrong check digit",
      { vmp_id: "90000011000001105" },
      ["1:vmp_id:invalid_dmd_code"],
    ],
    ["a name where the code should be", { vmp_id: "Paracetamol" }, ["1:vmp_id:invalid_dmd_code"]],
    ["an AMP code that is not dm+d", { amp_id: "12" }, ["1:amp_id:invalid_dmd_code"]],
    ["no NHS number", { person_nhs_number: "" }, ["1:person_nhs_number:required"]],
    [
      "an invalid NHS number",
      { person_nhs_number: "1234567890" },
      ["1:person_nhs_number:invalid_nhs_number"],
    ],
    ["a zero dose", { dose_quantity: "0" }, ["1:dose_quantity:invalid_dose"]],
    ["a dose with four decimals", { dose_quantity: "0.1255" }, ["1:dose_quantity:invalid_dose"]],
    ["a dose with a trailing point", { dose_quantity: "1." }, ["1:dose_quantity:invalid_dose"]],
    ["a dose in words", { dose_quantity: "one" }, ["1:dose_quantity:invalid_dose"]],
    ["a regular medicine with no times", { times: "" }, ["1:times:times_required"]],
    ["a twelve-hour time", { times: "8am" }, ["1:times:invalid_times"]],
    ["a time twice", { times: "08:00 08:00" }, ["1:times:invalid_times"]],
    [
      "a when-required medicine with times",
      { directions: "when_required", indication: "Pain" },
      ["1:times:times_not_taken"],
    ],
    [
      "a when-required medicine with no indication",
      { directions: "when_required", times: "" },
      ["1:indication:indication_required"],
    ],
    ["a stop before the start", { stops_on: "31/10/2026" }, ["1:stops_on:stops_before_start"]],
    ["an unknown source", { source_kind: "email" }, ["1:source_kind:invalid_code"]],
    ["no prescriber", { prescriber: "" }, ["1:prescriber:required"]],
  ])("%s", (_name, over, expected) => {
    expect(codes(validateMedicineImport([medicine(over)], OPTS))).toEqual(expected);
  });

  it("refuses a 999-range NHS number outside test environments", () => {
    expect(
      codes(validateMedicineImport([medicine()], { today: TODAY, allowTestNhsNumbers: false })),
    ).toEqual(["1:person_nhs_number:test_nhs_number"]);
  });

  it.each<[string | undefined, string[] | null]>([
    ["08:00 20:00", ["08:00", "20:00"]],
    ["20:00;08:00", ["08:00", "20:00"]],
    ["13:30, 07:05", ["07:05", "13:30"]],
    ["24:00", null],
    ["", null],
    [undefined, null],
  ])("reads times %s", (cell, times) => {
    expect(importTimes(cell)).toEqual(times);
  });

  it("builds the MAR entry draft with dm+d's names, never the file's, from the start of the day", () => {
    const row = validateMedicineImport([medicine({ stops_on: "30/11/2026" })], OPTS).rows[0] ?? {};
    const draft = medicineRowDraft(row, "person-1", {
      name: "Paracetamol 500mg tablets",
      routeName: "Oral",
      unitName: "tablet",
    });
    expect(draft).toMatchObject({
      personId: "person-1",
      product: { vmpId: VMP, ampId: null, name: "Paracetamol 500mg tablets" },
      route: { code: "26643006", name: "Oral" },
      directions: {
        kind: "regular",
        schedule: {
          pattern: { kind: "every_day" },
          times: [
            { time: "08:00", dose: { kind: "amount", quantity: 1, unit: { name: "tablet" } } },
            { time: "20:00", dose: { kind: "amount", quantity: 1 } },
          ],
        },
      },
      source: { kind: "pharmacy_mar", reference: "Pharmacy MAR, October 2026", documentId: null },
    });
    // UK midnight: GMT on 1 November.
    expect(draft.startsAt.toISOString()).toBe("2026-11-01T00:00:00.000Z");
    expect(draft.stopsAt?.toISOString()).toBe("2026-11-30T00:00:00.000Z");
  });
});

describe("hazard HZ-024 imported care plans arrive as drafts (rule 29)", () => {
  const plan = (over: Record<string, string> = {}) => ({
    person_nhs_number: NHS,
    domain: "mobility",
    need: "Needs one carer to walk to the dining room.",
    outcome: "Walks safely to meals.",
    ...over,
  });
  it.each<[string, Record<string, string>[], string[]]>([
    ["one section", [plan()], []],
    ["two domains for one person", [plan(), plan({ domain: "nutrition_and_hydration" })], []],
    ["the same domain twice", [plan(), plan()], ["1:domain:duplicate", "2:domain:duplicate"]],
    ["an unknown domain", [plan({ domain: "walking" })], ["1:domain:invalid_code"]],
    ["no need", [plan({ need: "" })], ["1:need:required"]],
    ["no outcome", [plan({ outcome: "" })], ["1:outcome:required"]],
  ])("%s", (_name, rows, expected) => {
    expect(codes(validateCarePlanImport(rows, OPTS))).toEqual(expected);
  });

  it("groups rows into one draft per person", () => {
    const other = "9990000026";
    const v = validateCarePlanImport(
      [plan(), plan({ person_nhs_number: other }), plan({ domain: "nutrition_and_hydration" })],
      OPTS,
    );
    expect(v.errors).toEqual([]);
    const drafts = carePlanDrafts(v.rows);
    expect(drafts.map((d) => [d.nhsNumber, d.rows, d.sections.map((s) => s.domain)])).toEqual([
      [NHS, [1, 3], ["mobility", "nutrition_and_hydration"]],
      [other, [2], ["mobility"]],
    ]);
  });
});

describe("hazard HZ-124 imported staff file checks are never verified (rule 30)", () => {
  const check = (over: Record<string, string>) => ({
    member_email: "ada.import@example.invalid",
    ...over,
  });
  const dbs = {
    kind: "dbs_certificate",
    dbs_level: "enhanced_adults_barred",
    dbs_issued_on: "01/02/2026",
    dbs_certificate_number: "009999999999",
    dbs_result: "clear",
  };
  it.each<[string, Record<string, string>, string[]]>([
    ["an identity document", { kind: "identity_with_photo", identity_document: "passport" }, []],
    [
      "an identity check with no document",
      { kind: "identity_with_photo" },
      ["1:identity_document:detail_required"],
    ],
    ["a DBS certificate", dbs, []],
    [
      "a DBS barred list check only",
      { kind: "dbs_certificate", barred_list_clear_on: "01/02/2026" },
      [],
    ],
    [
      "a DBS certificate missing its result",
      { ...dbs, dbs_result: "" },
      ["1:dbs_result:detail_required"],
    ],
    [
      "an 11-digit certificate number",
      { ...dbs, dbs_certificate_number: "09999999999" },
      ["1:dbs_certificate_number:invalid_number"],
    ],
    [
      "the Update Service with no certificate",
      { kind: "dbs_certificate", dbs_update_service: "yes" },
      ["1:dbs_update_service:detail_not_for_check"],
    ],
    [
      "a DBS issue date in the future",
      { ...dbs, dbs_issued_on: "02/11/2026" },
      ["1:dbs_issued_on:date_in_future"],
    ],
    [
      "a right to work check",
      {
        kind: "right_to_work",
        right_to_work_method: "online_share_code",
        right_to_work_checked_on: "01/09/2026",
        right_to_work_permission: "time_limited",
        right_to_work_expires_on: "01/09/2027",
      },
      [],
    ],
    [
      "a time-limited right to work with no expiry",
      {
        kind: "right_to_work",
        right_to_work_method: "manual_document",
        right_to_work_checked_on: "01/09/2026",
        right_to_work_permission: "time_limited",
      },
      ["1:right_to_work_expires_on:detail_required"],
    ],
    [
      "a registration",
      {
        kind: "professional_registration",
        registration_body: "nmc",
        registration_pin: "99a9999e",
        registration_renewal_due_on: "30/11/2027",
      },
      [],
    ],
    ["references", { kind: "references", references_received: "2" }, []],
    [
      "references in words",
      { kind: "references", references_received: "two" },
      ["1:references_received:invalid_number"],
    ],
    ["qualifications", { kind: "relevant_qualifications", qualifications: "Level 3 Diploma" }, []],
    [
      "a detail column for another check",
      { kind: "references", references_received: "1", registration_pin: "99A9999E" },
      ["1:registration_pin:detail_not_for_check"],
    ],
    ["health is never imported", { kind: "health_fitness" }, ["1:kind:invalid_code"]],
    [
      "employment history is never imported",
      { kind: "employment_history" },
      ["1:kind:invalid_code"],
    ],
    [
      "not an email",
      { member_email: "Ada Example", kind: "references", references_received: "1" },
      ["1:member_email:invalid_email"],
    ],
  ])("%s", (_name, over, expected) => {
    expect(codes(validateStaffFileImport([check(over)], OPTS))).toEqual(expected);
  });

  it("takes each member's check on one row only, whatever the email's case", () => {
    const v = validateStaffFileImport(
      [
        check({ kind: "references", references_received: "1" }),
        check({
          member_email: "ADA.import@example.invalid",
          kind: "references",
          references_received: "2",
        }),
      ],
      OPTS,
    );
    expect(codes(v)).toEqual(["1:kind:duplicate", "2:kind:duplicate"]);
  });

  it.each<[string, Record<string, string>, object]>([
    [
      "identity",
      { kind: "identity_with_photo", identity_document: "passport" },
      { kind: "identity_with_photo", document: "passport" },
    ],
    [
      "a DBS certificate on the Update Service",
      { ...dbs, dbs_update_service: "yes", barred_list_clear_on: "20/01/2026" },
      {
        kind: "dbs_certificate",
        certificate: {
          level: "enhanced_adults_barred",
          issuedOn: "2026-02-01",
          number: "009999999999",
          result: "clear",
        },
        updateService: { subscribed: true, lastCheckedOn: null, lastResult: null },
        barredListClearOn: "2026-01-20",
      },
    ],
    [
      "a registration, the PIN in capitals",
      {
        kind: "professional_registration",
        registration_body: "nmc",
        registration_pin: "99a9999e",
        registration_renewal_due_on: "30/11/2027",
      },
      {
        kind: "professional_registration",
        body: "nmc",
        pin: "99A9999E",
        renewalDueOn: "2027-11-30",
        revalidationDueOn: null,
      },
    ],
    [
      "qualifications, split on semicolons",
      { kind: "relevant_qualifications", qualifications: "Level 3 Diploma; First aid" },
      { kind: "relevant_qualifications", qualifications: ["Level 3 Diploma", "First aid"] },
    ],
  ])("stores %s as the staff file does", (_name, over, detail) => {
    const v = validateStaffFileImport([check(over)], OPTS);
    expect(v.errors).toEqual([]);
    expect(staffFileRowDetail(v.rows[0] ?? {})).toEqual(detail);
  });
});

describe("the dry run lists every row's outcome (rule 31)", () => {
  it("creates every row when nothing is refused", () => {
    const v = validateMedicineImport([medicine(), medicine({ vmp_id: "90000041000001103" })], OPTS);
    const { report } = clinicalDryRun("medicines", v, [], 2);
    expect(report).toMatchObject({
      recordType: "medicines",
      rows: 2,
      validRows: 2,
      mayCommit: true,
      createsCount: 2,
      warnings: [],
      phonesInUse: false,
      rowOutcomes: [
        { row: 1, outcome: "creates" },
        { row: 2, outcome: "creates" },
      ],
    });
    expect(report.whatHappens.join(" ")).toContain("Imported, not yet checked");
    expect(report.whatHappens.join(" ")).toContain("second person competent in medicines");
  });

  it("refuses the rows the records refuse, and commits nothing", () => {
    const v = validateMedicineImport([medicine(), medicine()], OPTS);
    const { report } = clinicalDryRun(
      "medicines",
      v,
      [importRowError(2, "person_nhs_number", "person_not_found", "NHS number")],
      2,
    );
    expect(report).toMatchObject({
      mayCommit: false,
      createsCount: 0,
      rowOutcomes: [
        { row: 1, outcome: "creates" },
        { row: 2, outcome: "refused" },
      ],
    });
    expect(report.errors[0]?.message).toContain("never matched by name");
  });

  it("refuses every row for a problem with the file itself", () => {
    const v = validateCarePlanImport(
      [{ person_nhs_number: NHS, domain: "mobility", need: "x", outcome: "y", extra: "z" }],
      OPTS,
    );
    const { report } = clinicalDryRun("care_plans", v, [], 1);
    expect(report.rowOutcomes).toEqual([{ row: 1, outcome: "refused" }]);
    expect(report.validRows).toBe(0);
  });

  it.each<["care_plans" | "staff_files", string]>([
    ["care_plans", "Staff do not follow a draft"],
    ["staff_files", "each unverified"],
  ])("says what committing %s does", (type, words) => {
    const { report } = clinicalDryRun(type, { rows: [{}], errors: [], rowCount: 1 }, [], 1);
    expect(report.whatHappens.join(" ")).toContain(words);
  });
});
