import { describe, expect, it } from "vitest";
import {
  ALLERGY_IMPORT_FIELDS,
  checkImportCommit,
  dryRunReport,
  importUndoEligibility,
  PERSON_IMPORT_FIELDS,
  validateImportRows,
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
});
