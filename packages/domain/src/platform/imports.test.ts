import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  ALLERGY_IMPORT_FIELDS,
  checkImportCommit,
  checkPeopleCommit,
  dryRunReport,
  type ExistingPerson,
  hasControlCharacter,
  hasLoneSurrogate,
  IMPORT_FIELDS,
  IMPORT_LIMITS,
  IMPORT_RATE_KEYS,
  IMPORT_REPORT_MAX_ITEMS,
  IMPORT_WARNING_LIMITS,
  importOutcomeWords,
  importStagingExpiresAt,
  importUndoClosesAt,
  importUndoEligibility,
  mapImportColumns,
  matchExistingPeople,
  nameMatch,
  normaliseUkPostcode,
  PERSON_IMPORT_FIELDS,
  parseImportCsv,
  peopleDryRun,
  stagedCells,
  UNDO_MESSAGES,
  unstorableText,
  uploadCellProblem,
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
    ["a quote never closed in a row", 'a,b\nx,"Ada Ex\n', "unclosed_quote", 1],
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

  it("stops reading at the first row, cell or column past a limit, never building the rest", () => {
    const small = { rows: 2, columns: 3, cellCharacters: 10 };
    // A million rows, a five-million-character cell and a thousand columns are each refused as
    // soon as the limit is passed (the scan holds no more than the limits allow).
    expect(parseImportCsv(`a\n${"1\n".repeat(1_000_000)}`, small)).toMatchObject({
      ok: false,
      problem: "too_many_rows",
    });
    expect(parseImportCsv(`a\n${"x".repeat(5_000_000)}`, small)).toMatchObject({
      ok: false,
      problem: "cell_too_long",
      row: 1,
    });
    expect(parseImportCsv(`${"c,".repeat(1000)}c\n`, small)).toMatchObject({
      ok: false,
      problem: "too_many_columns",
      row: 0,
    });
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

  it("hazard HZ-130 refuses unknown columns, a mapping to no field and two columns for one field, by position", () => {
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

/** Tests use 999-range numbers (fixtures never hold real ones), as a demonstration would. */
const OPTIONS = { today: TODAY, allowTestNhsNumbers: true } as const;

describe("PLAT-014 person import rules", () => {
  const errorsFor = (rows: Record<string, string>[]) => validatePersonImport(rows, OPTIONS).errors;

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
      "a lone surrogate in a name",
      { family_name: "Ex\uD800ample" },
      "family_name",
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
      OPTIONS,
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

  it.each([
    ["a 999-range test number", "9990000018", false, ["test_nhs_number"]],
    ["0000000000, which passes the check digit", "0000000000", false, ["test_nhs_number"]],
    ["a test number in a demonstration", "9990000018", true, []],
  ])("for a real organisation, refuses %s", (_name, nhs, allowTestNhsNumbers, codes) => {
    const result = validatePersonImport([person({ nhs_number: nhs })], {
      today: TODAY,
      allowTestNhsNumbers,
    });
    expect(result.errors.map((e) => e.code)).toEqual(codes);
    if (codes.length > 0) expect(result.rows[0]?.nhs_number).toBeUndefined();
    expect(JSON.stringify(result.errors)).not.toContain(nhs);
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

  it("knows a control character from a tab or line break, and a lone surrogate from a pair", () => {
    expect(hasControlCharacter("Ada\tExample\r\n")).toBe(false);
    expect(hasControlCharacter("Ada\u0007")).toBe(true);
    expect(hasControlCharacter("Ada\u009b")).toBe(true);
    expect(hasLoneSurrogate("Ada \u{1F600}")).toBe(false);
    expect(hasLoneSurrogate("Ada \uD83D")).toBe(true);
    expect(hasLoneSurrogate("\uDE00 Ada")).toBe(true);
    expect(unstorableText("Zoë O'Brien-Smith")).toBe(false);
  });

  it("hazard HZ-130 finds a cell that cannot be stored before anything is written, by row and field only", () => {
    expect(uploadCellProblem([{ given_name: "Ada" }], PERSON_IMPORT_FIELDS)).toBeNull();
    const problem = uploadCellProblem(
      [{ given_name: "Ada" }, { given_name: "Bo", family_name: "Exa\u0000mple" }],
      PERSON_IMPORT_FIELDS,
    );
    expect(problem).toMatchObject({ row: 2, column: "family_name" });
    expect(problem?.message).toMatch(/Row 2: Family name/);
    expect(JSON.stringify(problem)).not.toMatch(/Exa|mple|Bo/);
    expect(uploadCellProblem([{ nhs_number: "\uDC00" }], PERSON_IMPORT_FIELDS)).toMatchObject({
      row: 1,
      column: "nhs_number",
    });
  });
});

describe("hazard HZ-130 matching rows against people already in Harbour", () => {
  const someone = (o: Partial<ExistingPerson> = {}): ExistingPerson => ({
    id: "0193a000-0000-7000-8000-000000000402",
    nhsNumber: "9990000026",
    localIdentifier: null,
    givenName: "Ben",
    familyName: "Sample",
    dateOfBirth: "1941-07-15",
    ...o,
  });
  const ada = (o: Partial<ExistingPerson> = {}) =>
    someone({
      nhsNumber: null,
      givenName: "Ada",
      familyName: "Example",
      dateOfBirth: "1930-05-06",
      ...o,
    });
  const match = (rows: Record<string, string>[], existing: ExistingPerson[]) =>
    matchExistingPeople(validatePersonImport(rows, OPTIONS), existing);

  it("hazard HZ-130 refuses a row whose NHS number is already on a record, naming the record, never merging", () => {
    const result = match(
      [person(), person({ nhs_number: "9990000026", given_name: "Bo" })],
      [someone()],
    );
    expect(result.errors).toEqual([
      expect.objectContaining({
        row: 2,
        column: "nhs_number",
        code: "already_in_harbour",
        personId: someone().id,
      }),
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
      "the same name, the row with no NHS number",
      { nhs_number: "", local_identifier: "R-1" },
      someone({ givenName: " ada ", familyName: "EXAMPLE", dateOfBirth: "1930-05-06" }),
      "same_name",
    ],
    ["the same name, the record with no NHS number", {}, ada(), "same_name"],
    [
      "an apostrophe and a hyphen",
      { family_name: "O'Brien-Smith" },
      ada({ familyName: "obrien smith" }),
      "same_name",
    ],
    ["a middle name", { given_name: "Ada Mary" }, ada(), "same_name"],
    ["an accent", { given_name: "Adà" }, ada(), "same_name"],
    ["the names swapped", { given_name: "Example", family_name: "Ada" }, ada(), "names_swapped"],
    ["the same family name only", { given_name: "Adeline" }, ada(), "same_family_name"],
    [
      "the same given name only (a changed family name)",
      { family_name: "Maiden" },
      ada(),
      "same_given_name",
    ],
    ["both with NHS numbers that differ", {}, ada({ nhsNumber: "9990000026" }), null],
    [
      "a different date of birth",
      { nhs_number: "", local_identifier: "R-1" },
      ada({ dateOfBirth: "1930-05-07" }),
      null,
    ],
    [
      "nothing in common but the date of birth",
      { given_name: "Cara", family_name: "Placeholder" },
      ada(),
      null,
    ],
  ])("hazard HZ-130 warns of a possible duplicate for %s", (_name, change, existing, expected) => {
    const result = match([person(change)], [existing]);
    expect(result.errors).toEqual([]);
    expect(result.warnings).toEqual(
      expected
        ? [
            expect.objectContaining({
              row: 1,
              code: "possible_duplicate",
              match: expected,
              personId: existing.id,
              otherRow: null,
            }),
          ]
        : [],
    );
  });

  it("hazard HZ-130 warns of rows that may be one person once, the later naming the earliest", () => {
    const result = match(
      [
        person({ nhs_number: "", local_identifier: "R-1" }),
        person({ nhs_number: "9990001502", local_identifier: "R-2" }),
        person({ nhs_number: "9990000034", given_name: "Cara", family_name: "Placeholder" }),
        person({ nhs_number: "", local_identifier: "R-4", given_name: "Ada Jane" }),
      ],
      [ada()],
    );
    // Rows 1, 2 and 4 may be one person: each later row names the first (a cluster), never all.
    expect(
      result.warnings.map((w) => [w.row, w.otherRow, w.personId === null ? null : "record"]),
    ).toEqual([
      [1, null, "record"],
      [2, null, "record"],
      [2, 1, null],
      [4, null, "record"],
      [4, 1, null],
    ]);
    expect(result.warnings.find((w) => w.row === 2 && w.otherRow === 1)?.message).toMatch(/row 1/);
    expect(new Set(result.warnings.map((w) => w.key)).size).toBe(5);
    expect(JSON.stringify(result.warnings)).not.toMatch(/Ada|Example|R-1/);
  });

  it("hazard HZ-130 bounds the warnings: a file with too many is refused, never half-listed", () => {
    const limits = { total: 3, recordsPerRow: 2, sameBirthDate: 10 };
    const rows = Array.from({ length: 6 }, (_, i) =>
      person({ nhs_number: "", local_identifier: `R-${i + 1}` }),
    );
    const result = matchExistingPeople(validatePersonImport(rows, OPTIONS), [], limits);
    expect(result.warnings).toHaveLength(3);
    expect(result.errors).toEqual([
      expect.objectContaining({ row: 0, code: "too_many_possible_duplicates" }),
    ]);
    // A row matching more records than it may name says so.
    const many = matchExistingPeople(
      validatePersonImport([person({ nhs_number: "", local_identifier: "R-1" })], OPTIONS),
      [1, 2, 3].map((n) => ada({ id: `0193a000-0000-7000-8000-00000000050${n}` })),
      limits,
    );
    expect(many.warnings).toHaveLength(2);
    expect(many.recordMatchesCapped).toBe(true);
  });

  it("hazard HZ-130 refuses a file where too many rows share a date of birth, without comparing them", () => {
    const rows = Array.from({ length: IMPORT_WARNING_LIMITS.sameBirthDate + 1 }, (_, i) =>
      person({ nhs_number: "", local_identifier: `R-${i + 1}`, given_name: `Name${i}` }),
    );
    const { report } = peopleDryRun(rows, [], OPTIONS);
    expect(report.byCode).toMatchObject({ too_many_same_birth_date: 1 });
    expect(report.warnings).toEqual([]);
    expect(report.mayCommit).toBe(false);
  });

  it("hazard HZ-130 stays bounded for 5000 rows that all share a date of birth and family name", () => {
    const rows = Array.from({ length: IMPORT_LIMITS.rows }, (_, i) =>
      person({ nhs_number: "", local_identifier: `R-${i + 1}` }),
    );
    const started = Date.now();
    const { report } = peopleDryRun(rows, [ada()], OPTIONS);
    expect(Date.now() - started).toBeLessThan(5000);
    expect(report.warnings.length).toBeLessThanOrEqual(IMPORT_WARNING_LIMITS.total);
    expect(report.warningKeys).toEqual(report.warnings.map((w) => w.key));
    expect(report.mayCommit).toBe(false);
  });

  it("hazard HZ-130 two rows with different NHS numbers are two people", () => {
    expect(match([person(), person({ nhs_number: "9990001502" })], []).warnings).toEqual([]);
  });

  it("hazard HZ-130 commits only a staged, unexpired, dry-run, clean batch with exactly the warnings seen acknowledged", () => {
    const clean = peopleDryRun([person()], [], OPTIONS).report;
    const warned = peopleDryRun(
      [person({ nhs_number: "", local_identifier: "R-1" })],
      [ada()],
      OPTIONS,
    ).report;
    const twoWarnings = peopleDryRun(
      [person({ nhs_number: "", local_identifier: "R-1" })],
      [ada(), ada({ id: "0193a000-0000-7000-8000-000000000499" })],
      OPTIONS,
    ).report;
    const failing = peopleDryRun([person({ given_name: "" })], [], OPTIONS).report;
    const empty = peopleDryRun([], [], OPTIONS).report;
    const ran = new Date("2026-10-31T10:00:00Z");
    const now = new Date("2026-10-31T11:00:00Z");
    const expiresAt = new Date("2026-11-07T10:00:00Z");
    const base = {
      status: "staged" as const,
      now,
      expiresAt,
      dryRunAt: ran,
      acknowledgedWarnings: [] as string[],
    };
    const seen = warned.warningKeys;
    const table: [string, Parameters<typeof checkPeopleCommit>[0], string | null][] = [
      ["clean", { ...base, report: clean }, null],
      ["already committed", { ...base, status: "committed", report: clean }, "not_staged"],
      ["discarded", { ...base, status: "discarded", report: clean }, "not_staged"],
      ["past its expiry", { ...base, now: expiresAt, report: clean }, "expired"],
      ["never dry-run", { ...base, dryRunAt: null, report: clean }, "dry_run_first"],
      ["empty", { ...base, report: empty }, "empty"],
      ["with errors", { ...base, report: failing }, "has_errors"],
      [
        "duplicates not acknowledged",
        { ...base, report: warned },
        "possible_duplicates_unacknowledged",
      ],
      ["duplicates acknowledged", { ...base, report: warned, acknowledgedWarnings: seen }, null],
      [
        "a warning that is not there acknowledged",
        { ...base, report: clean, acknowledgedWarnings: seen },
        "possible_duplicates_unacknowledged",
      ],
      [
        "a new warning since the dry run",
        { ...base, report: twoWarnings, acknowledgedWarnings: seen },
        "possible_duplicates_unacknowledged",
      ],
      [
        "the same warning counted twice",
        { ...base, report: warned, acknowledgedWarnings: [...seen, ...seen] },
        "possible_duplicates_unacknowledged",
      ],
    ];
    for (const [name, input, problem] of table) {
      const result = checkPeopleCommit(input);
      expect([name, result.ok ? null : result.problem]).toEqual([name, problem]);
      if (!result.ok) expect(result.message.length).toBeGreaterThan(20);
    }
    expect(warned).toMatchObject({ mayCommit: false, needsAcknowledgement: true });
    expect(clean).toMatchObject({ mayCommit: true, needsAcknowledgement: false });
  });

  it("names how two names agree, and when they do not", () => {
    expect(
      nameMatch({ given: "Ada", family: "Example" }, { given: "ADA", family: "example" }),
    ).toBe("same_name");
    expect(nameMatch({ given: "", family: "" }, { given: "", family: "" })).toBeNull();
  });
});

describe("PLAT-014 the people dry run report", () => {
  it("hazard HZ-007 the dry run says every allergy status is imported as not recorded, listing what the file stated", () => {
    const { report } = peopleDryRun(
      [
        person({ allergy_status: "" }),
        person({ nhs_number: "9990001502", allergy_status: "has_allergies" }),
        person({ nhs_number: "9990000034", allergy_status: "no_known_allergies" }),
        person({ nhs_number: "9990000042", allergy_status: "unknown" }),
      ],
      [],
      OPTIONS,
    );
    expect(report).toMatchObject({
      rows: 4,
      validRows: 4,
      errorCount: 0,
      warningCount: 0,
      mayCommit: true,
      allergyStatusNotStatedRows: [1, 4],
      noKnownAllergiesStatedRows: [3],
      hasAllergiesStatedRows: [2],
    });
    const words = report.whatHappens.join(" ");
    expect(words).toMatch(/creates 4 people/);
    expect(words).toMatch(/allergy status is imported as not recorded/);
    expect(words).toMatch(/no known allergies for 1 person/);
    expect(words).toMatch(/Allergies themselves are not imported/);
    expect(words).toMatch(/phones at their next sync/);
    expect(words).toMatch(/no photo, room or placement/);
  });

  it("says nothing can be committed while there are errors, and asks for duplicates to be checked", () => {
    expect(
      importOutcomeWords({
        validRows: 1,
        errorCount: 2,
        warningCount: 3,
        noKnownAllergiesStatedRows: [],
        hasAllergiesStatedRows: [1],
        phonesInUse: false,
        recordMatchesCapped: true,
      }).join(" "),
    ).toMatch(
      /Nothing can be committed .*2 found.*creates 1 person.*can be undone until a phone.*1 person has allergies.*possible duplicate \(3\).*more people already in Harbour/,
    );
  });

  it("hazard HZ-130 says, and the commit needs accepting, that an import cannot be undone once phones are in use", () => {
    const { report } = peopleDryRun([person()], [], { ...OPTIONS, phonesInUse: true });
    expect(report.phonesInUse).toBe(true);
    expect(report.whatHappens.join(" ")).toMatch(
      /cannot be undone once it is committed.*cannot be removed/,
    );
    const base = {
      status: "staged" as const,
      now: new Date("2026-10-31T11:00:00Z"),
      expiresAt: new Date("2026-11-07T10:00:00Z"),
      dryRunAt: new Date("2026-10-31T10:00:00Z"),
      report,
      acknowledgedWarnings: [],
    };
    expect(checkPeopleCommit(base)).toMatchObject({ ok: false, problem: "no_undo_not_accepted" });
    expect(checkPeopleCommit({ ...base, acceptNoUndo: false })).toMatchObject({ ok: false });
    expect(checkPeopleCommit({ ...base, acceptNoUndo: true })).toEqual({ ok: true });
    // Without phones in use nothing needs accepting.
    const quiet = peopleDryRun([person()], [], OPTIONS).report;
    expect(checkPeopleCommit({ ...base, report: quiet })).toEqual({ ok: true });
  });

  it("counts every error by code and lists at most the report's limit", () => {
    const rows = Array.from({ length: IMPORT_REPORT_MAX_ITEMS + 5 }, () =>
      person({ nhs_number: "", given_name: "" }),
    );
    const { report } = peopleDryRun(rows, [], OPTIONS);
    // Two errors a row, and one for the file: more rows share one date of birth than are compared.
    expect(report.errorCount).toBe(2 * rows.length + 1);
    expect(report.byCode).toEqual({
      required: rows.length,
      identifier_required: rows.length,
      too_many_same_birth_date: 1,
    });
    expect(report.errors).toHaveLength(IMPORT_REPORT_MAX_ITEMS);
    expect(report.truncated).toBe(true);
    expect(report.mayCommit).toBe(false);
  });

  it("counts matches with existing people among the errors that stop a commit", () => {
    const existing: ExistingPerson[] = [
      {
        id: "0193a000-0000-7000-8000-000000000401",
        nhsNumber: "9990000018",
        localIdentifier: null,
        givenName: "X",
        familyName: "Y",
        dateOfBirth: null,
      },
    ];
    const { report } = peopleDryRun([person()], existing, OPTIONS);
    expect(report).toMatchObject({
      validRows: 0,
      errorCount: 1,
      byCode: { already_in_harbour: 1 },
      mayCommit: false,
    });
  });
});

describe("PLAT-014 undoing: phones may hold the people", () => {
  it("hazard HZ-130 refuses an undo once a phone may hold the imported people", () => {
    const refused = importUndoEligibility(
      {
        committedAt: new Date("2026-10-20T10:00:00Z"),
        undoneAt: null,
        changedSinceCommit: false,
        referencedSinceCommit: false,
        sentToDevices: true,
      },
      { undoWindowDays: rateFromTable(IMPORT_RATE_KEYS.undoWindowDays) },
      new Date("2026-10-20T10:05:00Z"),
    );
    expect(refused).toEqual({
      ok: false,
      problem: "sent_to_devices",
      message: UNDO_MESSAGES.sent_to_devices,
    });
  });
});
