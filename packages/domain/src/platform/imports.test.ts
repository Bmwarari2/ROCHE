import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  ALLERGY_IMPORT_FIELDS,
  checkImportCommit,
  checkPeopleCommit,
  dryRunReport,
  type ExistingPerson,
  hasControlCharacter,
  IMPORT_FIELDS,
  IMPORT_LIMITS,
  IMPORT_RATE_KEYS,
  IMPORT_REPORT_MAX_ITEMS,
  importStagingExpiresAt,
  importUndoClosesAt,
  importUndoEligibility,
  mapImportColumns,
  matchExistingPeople,
  normaliseUkPostcode,
  PERSON_IMPORT_FIELDS,
  parseImportCsv,
  peopleDryRun,
  stagedCells,
  UNDO_MESSAGES,
  validateImportRows,
  validatePersonImport,
} from "./imports";

/**
 * Import validation (platform.md, Phase 2 rules 11 to 14; PLAT-014; ADR-0092 in slice 26). Rows are
 * invented people: NHS numbers in the 999 range, "Example" family names.
 */

const TODAY = "2026-10-31";
const person = (o: Record<string, string> = {}) => ({
  given_name: "Ada",
  family_name: "Example",
  date_of_birth: "06/05/1930",
  nhs_number: "999 000 0018",
  ...o,
});
const errorsOf = (rows: Record<string, string>[], fields = PERSON_IMPORT_FIELDS) =>
  validateImportRows(rows, fields, { today: TODAY, uniqueBy: "nhs_number" }).errors;

describe("PLAT-014 import validation", () => {
  it("takes a valid person and stores values as data-standards.md says", () => {
    const result = validateImportRows([person({ sex_code: "2" })], PERSON_IMPORT_FIELDS, {
      today: TODAY,
      uniqueBy: "nhs_number",
    });
    expect(result.errors).toEqual([]);
    expect(result.rows[0]).toEqual({
      given_name: "Ada",
      family_name: "Example",
      date_of_birth: "1930-05-06",
      nhs_number: "9990000018",
      sex_code: "2",
      allergy_status: "unknown",
    });
  });

  it.each([
    ["a missing given name", { given_name: "" }, "given_name", "required"],
    ["a family name that is too long", { family_name: "E".repeat(101) }, "family_name", "too_long"],
    [
      "an NHS number with a wrong check digit",
      { nhs_number: "999 000 0019" },
      "nhs_number",
      "invalid_nhs_number",
    ],
    [
      "an NHS number that is not ten digits",
      { nhs_number: "99900001" },
      "nhs_number",
      "invalid_nhs_number",
    ],
    [
      "a date in the American order",
      { date_of_birth: "05/31/1930" },
      "date_of_birth",
      "invalid_date",
    ],
    [
      "an ISO date (dd/mm/yyyy only)",
      { date_of_birth: "1930-05-06" },
      "date_of_birth",
      "invalid_date",
    ],
    ["31 February", { date_of_birth: "31/02/1930" }, "date_of_birth", "invalid_date"],
    [
      "a date of birth in the future",
      { date_of_birth: "01/01/2027" },
      "date_of_birth",
      "date_in_future",
    ],
    ["a sex code not in the list", { sex_code: "M" }, "sex_code", "invalid_code"],
    [
      "an allergy status not in the list",
      { allergy_status: "none" },
      "allergy_status",
      "invalid_code",
    ],
  ])("refuses %s, at its row and column", (_name, change, column, code) => {
    expect(errorsOf([person(), person({ nhs_number: "9990001502", ...change })])).toEqual([
      expect.objectContaining({ row: 2, column, code }),
    ]);
  });

  it("never echoes a value in an error (it may be personal data)", () => {
    const [error] = errorsOf([person({ nhs_number: "999 000 0019" })]);
    expect(JSON.stringify(error)).not.toContain("0019");
    expect(error?.message).toMatch(/NHS number/);
  });

  it("refuses both rows that share an NHS number", () => {
    expect(errorsOf([person(), person({ given_name: "Ade" })])).toEqual([
      expect.objectContaining({ row: 1, column: "nhs_number", code: "duplicate" }),
      expect.objectContaining({ row: 2, column: "nhs_number", code: "duplicate" }),
    ]);
  });

  it("hazard HZ-007 imports a blank allergy status as unknown, never as no allergies", () => {
    const result = validateImportRows([person({ allergy_status: "  " })], PERSON_IMPORT_FIELDS, {
      today: TODAY,
      uniqueBy: "nhs_number",
    });
    expect(result.rows[0]?.allergy_status).toBe("unknown");
  });

  it("refuses a column the import does not know, once for the file", () => {
    const result = validateImportRows(
      [person({ religion: "x" }), person({ nhs_number: "9990001502", religion: "y" })],
      PERSON_IMPORT_FIELDS,
      {
        today: TODAY,
        uniqueBy: "nhs_number",
      },
    );
    expect(result.errors).toEqual([
      expect.objectContaining({ row: 0, column: "religion", code: "unknown_column" }),
    ]);
  });

  it("checks allergies with their own codes", () => {
    const rows = [
      { person_nhs_number: "9990000018", substance: "Penicillin", severity: "severe" },
      { person_nhs_number: "9990000018", substance: "Latex", severity: "awful" },
    ];
    expect(validateImportRows(rows, ALLERGY_IMPORT_FIELDS, { today: TODAY }).errors).toEqual([
      expect.objectContaining({ row: 2, column: "severity", code: "invalid_code" }),
    ]);
  });

  it("reports a dry run by code without committing, and commits only a clean batch", () => {
    const result = validateImportRows(
      [
        person(),
        person({ nhs_number: "999 000 0019" }),
        person({ nhs_number: "9990001502", given_name: "" }),
      ],
      PERSON_IMPORT_FIELDS,
      { today: TODAY, uniqueBy: "nhs_number" },
    );
    expect(dryRunReport(result)).toEqual({
      rows: 3,
      validRows: 1,
      errorCount: 2,
      byCode: { invalid_nhs_number: 1, required: 1 },
      mayCommit: false,
    });
    expect(checkImportCommit(result)).toMatchObject({ ok: false, problem: "has_errors" });
    const clean = validateImportRows([person()], PERSON_IMPORT_FIELDS, {
      today: TODAY,
      uniqueBy: "nhs_number",
    });
    expect(checkImportCommit(clean)).toEqual({ ok: true });
    expect(
      checkImportCommit(validateImportRows([], PERSON_IMPORT_FIELDS, { today: TODAY })),
    ).toMatchObject({
      ok: false,
      problem: "empty",
    });
  });
});

describe("PLAT-014 undoing an import batch", () => {
  const batch = {
    committedAt: new Date("2026-10-20T10:00:00Z"),
    undoneAt: null,
    changedSinceCommit: false,
    referencedSinceCommit: false,
  };
  const WINDOW = { undoWindowDays: 7 };

  it.each([
    ["within the window, untouched", batch, "2026-10-26T10:00:00Z", { ok: true }],
    ["at the window's end", batch, "2026-10-27T10:00:00Z", { ok: true }],
    ["after the window", batch, "2026-10-27T10:00:01Z", { ok: false, problem: "window_passed" }],
    [
      "once undone",
      { ...batch, undoneAt: new Date("2026-10-21T00:00:00Z") },
      "2026-10-22T00:00:00Z",
      { ok: false, problem: "already_undone" },
    ],
    [
      "after a record was changed",
      { ...batch, changedSinceCommit: true },
      "2026-10-21T00:00:00Z",
      { ok: false, problem: "changed_since" },
    ],
    [
      "after records were made about it",
      { ...batch, referencedSinceCommit: true },
      "2026-10-21T00:00:00Z",
      { ok: false, problem: "referenced_since" },
    ],
  ])("is %s", (_name, b, now, expected) => {
    expect(importUndoEligibility(b, WINDOW, new Date(now))).toMatchObject(expected);
  });

  it("says why in plain words", () => {
    const refused = importUndoEligibility(
      { ...batch, referencedSinceCommit: true },
      WINDOW,
      new Date("2026-10-21T00:00:00Z"),
    );
    expect(refused).toEqual({
      ok: false,
      problem: "referenced_since",
      message: UNDO_MESSAGES.referenced_since,
    });
  });
});

/** The import figures as rates.md holds them (tests read the table, never a literal). */
function rateFromTable(key: string): number {
  const rates = readFileSync(new URL("../../../../docs/specs/rates.md", import.meta.url), "utf8");
  const row = rates.split("\n").find((line) => line.startsWith(`| ${key} |`));
  if (!row) throw new Error(`${key} is not in rates.md`);
  return Number(row.split("|")[2]?.trim());
}

describe("PLAT-014 import figures come from the rate table", () => {
  it.each(Object.values(IMPORT_RATE_KEYS))("%s is a row of rates.md", (key) => {
    expect(rateFromTable(key)).toBeGreaterThan(0);
  });

  it("expires a staged batch and closes the undo window from the table's figures", () => {
    const at = new Date("2026-10-31T09:00:00Z");
    const stagingExpiryDays = rateFromTable(IMPORT_RATE_KEYS.stagingExpiryDays);
    const undoWindowDays = rateFromTable(IMPORT_RATE_KEYS.undoWindowDays);
    expect(importStagingExpiresAt(at, { stagingExpiryDays }).getTime() - at.getTime()).toBe(
      stagingExpiryDays * 86_400_000,
    );
    expect(importUndoClosesAt(at, { undoWindowDays }).getTime() - at.getTime()).toBe(
      undoWindowDays * 86_400_000,
    );
  });
});

describe("PLAT-014 reading an import file", () => {
  it("reads quoted cells with commas, doubled quotes and line breaks, CRLF and a byte order mark", () => {
    const csv =
      '﻿given_name,family_name,preferred_name\r\nAda,Example,"Ada, ""Addie"""\r\n"Bo\nB",Sample,\r\n';
    expect(parseImportCsv(csv)).toEqual({
      ok: true,
      header: ["given_name", "family_name", "preferred_name"],
      rows: [
        ["Ada", "Example", 'Ada, "Addie"'],
        ["Bo\nB", "Sample", ""],
      ],
    });
  });

  it("skips blank lines, pads short rows and keeps a final row with no line end", () => {
    expect(parseImportCsv("a,b\n\nx\n\ny,z")).toEqual({
      ok: true,
      header: ["a", "b"],
      rows: [
        ["x", ""],
        ["y", "z"],
      ],
    });
  });

  it("keeps a row of quoted blanks as a row", () => {
    expect(parseImportCsv('a\n""\n')).toEqual({ ok: true, header: ["a"], rows: [[""]] });
  });

  const small = { rows: 2, columns: 3, cellCharacters: 10 };
  it.each([
    ["an empty file", "", "empty", 0],
    ["only blank lines", "\n\n", "empty", 0],
    ["a quote never closed in a row", 'a,b\nx,"Ada Example\n', "unclosed_quote", 1],
    ["a quote never closed in the header", '"a,b\nx,y\n', "unclosed_quote", 0],
    ["a row with more cells than the header", "a,b\nx,y\n1,2,3\n", "too_many_cells", 2],
    ["too many rows", "a\n1\n2\n3\n", "too_many_rows", 0],
    ["too many columns", "a,b,c,d\n", "too_many_columns", 0],
    ["a cell too long", "a\nAda Example Longname\n", "cell_too_long", 1],
    ["a heading too long", "Ada Example Longname\n", "cell_too_long", 0],
  ])("refuses %s, by row number only", (_name, csv, problem, row) => {
    const parsed = parseImportCsv(csv, small);
    expect(parsed).toMatchObject({ ok: false, problem, row });
    if (!parsed.ok) {
      expect(parsed.message).not.toMatch(/Ada|Example/);
      expect(parsed.message.length).toBeGreaterThan(10);
    }
  });

  it("allows the product limits by default", () => {
    expect(IMPORT_LIMITS.rows).toBeGreaterThan(1000);
    const header = Array.from({ length: IMPORT_LIMITS.columns }, (_, i) => `c${i}`).join(",");
    expect(parseImportCsv(`${header}\n`)).toMatchObject({ ok: true });
  });
});

describe("PLAT-014 matching columns", () => {
  it("matches by field key or label, ignoring case, spaces, hyphens and underscores", () => {
    expect(
      mapImportColumns(
        ["Given name", "FAMILY_NAME", "date-of-birth", "NHS Number", "allergy status"],
        PERSON_IMPORT_FIELDS,
      ),
    ).toEqual({
      ok: true,
      fields: ["given_name", "family_name", "date_of_birth", "nhs_number", "allergy_status"],
    });
  });

  it("follows the mapping given, and leaves out a column mapped to nothing", () => {
    const mapped = mapImportColumns(["Forename", "Surname", "Room", "DOB"], PERSON_IMPORT_FIELDS, {
      Forename: "given_name",
      Surname: "family_name",
      Room: null,
      DOB: "date_of_birth",
    });
    expect(mapped).toEqual({
      ok: true,
      fields: ["given_name", "family_name", null, "date_of_birth"],
    });
    if (mapped.ok) {
      expect(stagedCells(["Ada", "Example", "12", "06/05/1930"], mapped.fields)).toEqual({
        given_name: "Ada",
        family_name: "Example",
        date_of_birth: "06/05/1930",
      });
    }
  });

  it("refuses unknown columns, a mapping to no field and two columns for one field, by position", () => {
    // A file without a header row: its first person's details become the headings.
    const result = mapImportColumns(
      ["Ada", "Example", "given_name", "Given name", "9990000018"],
      PERSON_IMPORT_FIELDS,
      { "9990000018": "nhs_numbr" },
    );
    expect(result).toEqual({
      ok: false,
      errors: [
        expect.objectContaining({ column: 1, code: "unknown_column" }),
        expect.objectContaining({ column: 2, code: "unknown_column" }),
        expect.objectContaining({ column: 4, code: "duplicate_column" }),
        expect.objectContaining({ column: 5, code: "unknown_field" }),
      ],
    });
    expect(JSON.stringify(result)).not.toMatch(/Ada|Example|9990000018|nhs_numbr/);
  });

  it("takes people as the one record type of this slice", () => {
    expect(Object.keys(IMPORT_FIELDS)).toEqual(["people"]);
    expect(IMPORT_FIELDS.people).toBe(PERSON_IMPORT_FIELDS);
  });
});

describe("PLAT-014 person import rules", () => {
  const errorsFor = (rows: Record<string, string>[]) => validatePersonImport(rows, TODAY).errors;

  it.each([
    [
      "a date of birth before 1900",
      { date_of_birth: "06/05/0193" },
      "date_of_birth",
      "date_too_early",
    ],
    ["a postcode that is not one", { postcode: "NOT A CODE" }, "postcode", "invalid_postcode"],
    [
      "a control character in a name",
      { given_name: "Ad\u0000a" },
      "given_name",
      "control_character",
    ],
    [
      "a local identifier too long",
      { local_identifier: "L".repeat(61) },
      "local_identifier",
      "too_long",
    ],
  ])("refuses %s", (_name, change, column, code) => {
    expect(errorsFor([person(change)])).toEqual([
      expect.objectContaining({ row: 1, column, code }),
    ]);
  });

  it("takes 1 January 1900 and stores a postcode upper case with one space", () => {
    const result = validatePersonImport(
      [person({ date_of_birth: "01/01/1900", postcode: " zz99 3zz " })],
      TODAY,
    );
    expect(result.errors).toEqual([]);
    expect(result.rows[0]).toMatchObject({ date_of_birth: "1900-01-01", postcode: "ZZ99 3ZZ" });
    expect(normaliseUkPostcode("zz993zz")).toBe("ZZ99 3ZZ");
    expect(normaliseUkPostcode("ZZ9")).toBeNull();
  });

  it("needs an NHS number or a local identifier, either one enough", () => {
    expect(errorsFor([person({ nhs_number: "", local_identifier: "R-12" })])).toEqual([]);
    expect(errorsFor([person({ nhs_number: "" })])).toEqual([
      expect.objectContaining({ row: 1, column: "nhs_number", code: "identifier_required" }),
    ]);
    // An invalid NHS number is its own error, not also a missing identifier.
    expect(errorsFor([person({ nhs_number: "999 000 0019" })])).toEqual([
      expect.objectContaining({ code: "invalid_nhs_number" }),
    ]);
  });

  it("refuses a local identifier on two rows", () => {
    expect(
      errorsFor([
        person({ nhs_number: "", local_identifier: "R-12" }),
        person({ nhs_number: "", local_identifier: "R-12", given_name: "Bo" }),
      ]),
    ).toEqual([
      expect.objectContaining({ row: 1, column: "local_identifier", code: "duplicate" }),
      expect.objectContaining({ row: 2, column: "local_identifier", code: "duplicate" }),
    ]);
  });

  it("knows a control character from a tab or line break", () => {
    expect(hasControlCharacter("Ada\tExample\r\n")).toBe(false);
    expect(hasControlCharacter("Ada\u0007")).toBe(true);
    expect(hasControlCharacter("Ada\u009b")).toBe(true);
  });
});

describe("hazard HZ-130 matching rows against people already in Harbour", () => {
  const someone = (o: Partial<ExistingPerson> = {}): ExistingPerson => ({
    nhsNumber: "9990000026",
    localIdentifier: null,
    givenName: "Ben",
    familyName: "Sample",
    dateOfBirth: "1941-07-15",
    ...o,
  });
  const match = (rows: Record<string, string>[], existing: ExistingPerson[]) =>
    matchExistingPeople(validatePersonImport(rows, TODAY), existing);

  it("hazard HZ-130 refuses a row whose NHS number is already on a record, never merging", () => {
    const result = match(
      [person(), person({ nhs_number: "9990000026", given_name: "Bo" })],
      [someone()],
    );
    expect(result.errors).toEqual([
      expect.objectContaining({ row: 2, column: "nhs_number", code: "already_in_harbour" }),
    ]);
    expect(JSON.stringify(result)).not.toMatch(/9990000026|Ben|Sample/);
  });

  it("hazard HZ-130 refuses a row whose local identifier is already on a record", () => {
    const result = match(
      [person({ nhs_number: "", local_identifier: "R-7" })],
      [someone({ nhsNumber: null, localIdentifier: "R-7" })],
    );
    expect(result.errors).toEqual([
      expect.objectContaining({ row: 1, column: "local_identifier", code: "already_in_harbour" }),
    ]);
  });

  it.each([
    [
      "the row has no NHS number",
      { nhs_number: "", local_identifier: "R-1" },
      someone({ givenName: " ada ", familyName: "EXAMPLE", dateOfBirth: "1930-05-06" }),
      true,
    ],
    [
      "the existing person has no NHS number",
      {},
      someone({
        nhsNumber: null,
        givenName: "Ada",
        familyName: "Example",
        dateOfBirth: "1930-05-06",
      }),
      true,
    ],
    [
      "both have NHS numbers, and they differ",
      {},
      someone({ givenName: "Ada", familyName: "Example", dateOfBirth: "1930-05-06" }),
      false,
    ],
    [
      "the date of birth differs",
      { nhs_number: "", local_identifier: "R-1" },
      someone({
        nhsNumber: null,
        givenName: "Ada",
        familyName: "Example",
        dateOfBirth: "1930-05-07",
      }),
      false,
    ],
  ])(
    "hazard HZ-130 warns of a possible duplicate when %s: %s",
    (_name, change, existing, warned) => {
      const result = match([person(change)], [existing]);
      expect(result.errors).toEqual([]);
      expect(result.warnings).toEqual(
        warned ? [expect.objectContaining({ row: 1, code: "possible_duplicate" })] : [],
      );
    },
  );

  it("hazard HZ-130 warns of two rows that may be one person, once each", () => {
    const result = match(
      [
        person({ nhs_number: "", local_identifier: "R-1" }),
        person({ nhs_number: "9990001502", local_identifier: "R-2" }),
        person({ nhs_number: "9990000034", given_name: "Cara" }),
      ],
      [
        someone({
          nhsNumber: null,
          givenName: "Ada",
          familyName: "Example",
          dateOfBirth: "1930-05-06",
        }),
      ],
    );
    expect(result.warnings.map((w) => w.row)).toEqual([1, 2]);
    expect(JSON.stringify(result.warnings)).not.toMatch(/Ada|Example|R-1/);
  });

  it("hazard HZ-130 two rows with different NHS numbers are two people", () => {
    expect(match([person(), person({ nhs_number: "9990001502" })], []).warnings).toEqual([]);
  });

  it("hazard HZ-130 commits only a staged, dry-run, clean batch with duplicates acknowledged", () => {
    const clean = peopleDryRun([person()], [], TODAY).report;
    const warned = peopleDryRun(
      [person({ nhs_number: "", local_identifier: "R-1" })],
      [
        someone({
          nhsNumber: null,
          givenName: "Ada",
          familyName: "Example",
          dateOfBirth: "1930-05-06",
        }),
      ],
      TODAY,
    ).report;
    const failing = peopleDryRun([person({ given_name: "" })], [], TODAY).report;
    const empty = peopleDryRun([], [], TODAY).report;
    const ran = new Date("2026-10-31T10:00:00Z");
    const table: [string, Parameters<typeof checkPeopleCommit>[0], string | null][] = [
      [
        "clean",
        { status: "staged", dryRunAt: ran, report: clean, acknowledgePossibleDuplicates: false },
        null,
      ],
      [
        "already committed",
        { status: "committed", dryRunAt: ran, report: clean, acknowledgePossibleDuplicates: false },
        "not_staged",
      ],
      [
        "expired",
        { status: "expired", dryRunAt: ran, report: clean, acknowledgePossibleDuplicates: false },
        "not_staged",
      ],
      [
        "never dry-run",
        { status: "staged", dryRunAt: null, report: clean, acknowledgePossibleDuplicates: false },
        "dry_run_first",
      ],
      [
        "empty",
        { status: "staged", dryRunAt: ran, report: empty, acknowledgePossibleDuplicates: false },
        "empty",
      ],
      [
        "with errors",
        { status: "staged", dryRunAt: ran, report: failing, acknowledgePossibleDuplicates: true },
        "has_errors",
      ],
      [
        "possible duplicates not acknowledged",
        { status: "staged", dryRunAt: ran, report: warned, acknowledgePossibleDuplicates: false },
        "possible_duplicates_unacknowledged",
      ],
      [
        "possible duplicates acknowledged",
        { status: "staged", dryRunAt: ran, report: warned, acknowledgePossibleDuplicates: true },
        null,
      ],
    ];
    for (const [name, input, problem] of table) {
      const result = checkPeopleCommit(input);
      expect([name, result.ok ? null : result.problem]).toEqual([name, problem]);
      if (!result.ok) expect(result.message.length).toBeGreaterThan(20);
    }
  });
});

describe("PLAT-014 the people dry run report", () => {
  it("hazard HZ-007 the dry run lists rows imported with allergy status unknown, and allergies to record", () => {
    const { report } = peopleDryRun(
      [
        person({ allergy_status: "" }),
        person({ nhs_number: "9990001502", allergy_status: "has_allergies" }),
        person({ nhs_number: "9990000034", allergy_status: "no_known_allergies" }),
        person({ nhs_number: "9990000042", allergy_status: "unknown" }),
      ],
      [],
      TODAY,
    );
    expect(report).toMatchObject({
      rows: 4,
      validRows: 4,
      errorCount: 0,
      warningCount: 0,
      mayCommit: true,
      allergyStatusUnknownRows: [1, 4],
      allergiesToRecordRows: [2],
    });
  });

  it("counts every error by code and lists at most the report's limit", () => {
    const rows = Array.from({ length: IMPORT_REPORT_MAX_ITEMS + 5 }, () =>
      person({ nhs_number: "", given_name: "" }),
    );
    const { report } = peopleDryRun(rows, [], TODAY);
    expect(report.errorCount).toBe(2 * rows.length);
    expect(report.byCode).toEqual({ required: rows.length, identifier_required: rows.length });
    expect(report.errors).toHaveLength(IMPORT_REPORT_MAX_ITEMS);
    expect(report.truncated).toBe(true);
    expect(report.mayCommit).toBe(false);
  });

  it("counts matches with existing people among the errors that stop a commit", () => {
    const existing: ExistingPerson[] = [
      {
        nhsNumber: "9990000018",
        localIdentifier: null,
        givenName: "X",
        familyName: "Y",
        dateOfBirth: null,
      },
    ];
    const { report } = peopleDryRun([person()], existing, TODAY);
    expect(report).toMatchObject({
      validRows: 0,
      errorCount: 1,
      byCode: { already_in_harbour: 1 },
      mayCommit: false,
    });
  });
});
