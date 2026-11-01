import { describe, expect, it } from "vitest";
import { t } from "./i18n";
import {
  acknowledgementKeys,
  checkImportUploadRequest,
  checkMapping,
  commitReadiness,
  findingPlace,
  IMPORT_UPLOAD_MAX_BYTES,
  importChip,
  importShown,
  LEAVE_OUT,
  previewWords,
  readImportHeader,
  suggestMapping,
  undoWords,
  warningLabel,
} from "./imports";

/** The import wizard's screens (PLAT-014; platform.md rules 18 to 26; HZ-130). Invented data. */

const HEADER = ["Given name", "Family name", "DOB", "NHS number", "Ward"];

describe("who sees the import wizard (rule 18)", () => {
  it.each([
    [["platform.import.run", "people.person.create", "people.person.read"], true],
    [["platform.import.run", "people.person.read"], false],
    [["people.person.create", "people.person.read"], false],
    [[], false],
  ])("%j -> %s", (permissions, shown) => {
    expect(importShown(permissions)).toBe(shown);
  });
});

describe("reading the file and matching columns (rule 19)", () => {
  it("reads the headings and counts the rows, as the API will", () => {
    const read = readImportHeader("Given name,Family name\r\nAda,Example\r\n\r\nBen,Sample\r\n");
    expect(read).toEqual({
      ok: true,
      header: ["Given name", "Family name"],
      rows: 2,
      preview: [
        ["Ada", "Ben"],
        ["Example", "Sample"],
      ],
    });
  });

  it("hazard HZ-130 keeps the first three rows of each column to show beside its field", () => {
    const read = readImportHeader("DOB,Name\n01/02/1940,Ada\n,Ben\n03/04/1941,Cy\n05/06/1942,Di\n");
    if (!read.ok) throw new Error("expected the file to read");
    expect(read.preview[0]).toEqual(["01/02/1940", "", "03/04/1941"]);
    expect(previewWords(read.preview[0] ?? [], t)).toBe(
      "First rows: 01/02/1940, (blank), 03/04/1941",
    );
    expect(previewWords([], t)).toBe("The file has no rows under its header.");
  });

  it("names a problem by row, never by what a cell holds", () => {
    const read = readImportHeader('Given name\n"Ada');
    expect(read.ok).toBe(false);
    if (!read.ok) expect(read.message).toMatch(/^Row 1 opens a quotation mark/);
  });

  it("suggests the field each heading names, and leaves unknown or repeated ones out", () => {
    expect(suggestMapping([...HEADER, "given_name"], "people")).toEqual([
      "given_name",
      "family_name",
      LEAVE_OUT,
      "nhs_number",
      LEAVE_OUT,
      LEAVE_OUT,
    ]);
  });

  it("builds the API's mapping and says what is missing or repeated", () => {
    const ok = checkMapping(
      HEADER,
      ["given_name", "family_name", "date_of_birth", "nhs_number", LEAVE_OUT],
      "people",
      t,
    );
    expect(ok.problems).toEqual([]);
    expect(ok.missing).toEqual([]);
    expect(ok.mapping).toEqual({
      "Given name": "given_name",
      "Family name": "family_name",
      DOB: "date_of_birth",
      "NHS number": "nhs_number",
      Ward: null,
    });

    const bad = checkMapping(
      HEADER,
      ["given_name", "given_name", LEAVE_OUT, LEAVE_OUT, "constructor"],
      "people",
      t,
    );
    expect(bad.problems).toEqual([
      { column: 2, message: "Columns 1 and 2 are both matched to Given name. Keep one." },
    ]);
    expect(bad.missing).toEqual(["Family name", "Date of birth"]);
    // A key that is not a field of its own ("constructor") is left out, never sent as a field.
    expect(bad.mapping.Ward).toBeNull();
  });

  it("refuses two columns with the same heading, which the mapping cannot tell apart", () => {
    const check = checkMapping(
      ["NHS number", "NHS number"],
      ["nhs_number", LEAVE_OUT],
      "people",
      t,
    );
    expect(check.problems.map((p) => p.column)).toEqual([2]);
  });
});

describe("the upload route's checks", () => {
  const ok = { sameOrigin: true, contentType: "application/json", contentLength: "100" };
  it.each([
    [ok, null],
    [{ ...ok, sameOrigin: false }, 403],
    [{ ...ok, contentType: "text/csv" }, 415],
    [{ ...ok, contentType: "application/json; charset=utf-8" }, null],
    [{ ...ok, contentLength: null }, 411],
    [{ ...ok, contentLength: "0" }, 411],
    [{ ...ok, contentLength: String(IMPORT_UPLOAD_MAX_BYTES + 1) }, 413],
  ])("%j -> %s", (request, status) => {
    expect(checkImportUploadRequest(request, t)?.status ?? null).toBe(status);
  });
});

describe("where an import stands, as an icon and a word", () => {
  it.each([
    ["staged", "due", "Waiting to be checked"],
    ["committed", "done", "People added"],
    ["undone", "notApplicable", "Undone"],
    ["discarded", "notApplicable", "Discarded"],
    ["expired", "notApplicable", "Expired"],
    ["something_new", "overdue", "Unknown: check with Harbour support"],
  ])("%s", (status, chip, label) => {
    expect(importChip(status, t)).toMatchObject({ status: chip, label });
    expect(importChip(status, t).icon).toBeTruthy();
  });
});

describe("findings name the row and field, and the other row or record (HZ-130)", () => {
  it("says where an error is by row and field label", () => {
    expect(findingPlace({ row: 4, column: "nhs_number" }, "people", t)).toBe("Row 4, NHS number");
  });

  it.each([
    [
      { row: 3, column: "date_of_birth", otherRow: 7, match: "same_name" },
      "Row 3 (Date of birth) may be the same person as row 7: same name and date of birth. I have checked it",
    ],
    [
      {
        row: 5,
        column: "date_of_birth",
        personId: "0194d000-0000-7000-8000-000000000401",
        match: "names_swapped",
      },
      "Row 5 (Date of birth) may be someone already in Harbour: names swapped, same date of birth. I have checked it",
    ],
    [
      { row: 6, column: "date_of_birth" },
      "Row 6 (Date of birth) may be a duplicate: same date of birth. I have checked it",
    ],
  ])("%j", (finding, words) => {
    expect(warningLabel(finding, "people", t)).toBe(words);
  });
});

describe("the commit needs exactly the warnings shown, ticked, and the no-undo acceptance", () => {
  const report = {
    errorCount: 0,
    validRows: 3,
    phonesInUse: false,
    warnings: [
      { row: 1, column: "date_of_birth", code: "possible_duplicate", message: "m", key: "a" },
      { row: 2, column: "date_of_birth", code: "possible_duplicate", message: "m", key: "b" },
    ],
    warningKeys: ["a", "b"],
  };

  it.each([
    ["all ticked", report, ["a", "b"], false, true, []],
    ["one unticked", report, ["a"], false, false, ["unchecked"]],
    ["errors", { ...report, errorCount: 1 }, ["a", "b"], false, false, ["errors"]],
    ["nothing valid", { ...report, validRows: 0 }, ["a", "b"], false, false, ["errors"]],
    [
      "phones, not accepted",
      { ...report, phonesInUse: true },
      ["a", "b"],
      false,
      false,
      ["noUndo"],
    ],
    ["phones, accepted", { ...report, phonesInUse: true }, ["a", "b"], true, true, []],
    [
      "a key the page does not show",
      { ...report, warningKeys: ["a", "b", "c"] },
      ["a", "b"],
      false,
      false,
      ["notListed"],
    ],
    [
      "a warning with no key",
      {
        ...report,
        warnings: [...report.warnings, { row: 3, column: "x", code: "c", message: "m" }],
      },
      ["a", "b"],
      false,
      false,
      ["notListed"],
    ],
  ])("%s", (_name, r, ticked, accept, ready, reasons) => {
    const out = commitReadiness(r, new Set(ticked), accept);
    expect(out.ready).toBe(ready);
    expect(out.reasons).toEqual(reasons);
    if (ready) expect(out.acknowledged).toEqual(acknowledgementKeys(r));
  });
});

describe("undo, while available, else a plain statement", () => {
  const when = (iso: string | null) => (iso ? "01/11/2026 09:00" : "");
  it.each([
    [
      {
        status: "committed",
        undoAvailable: true,
        undoClosesAt: "2026-11-01T09:00:00Z",
        undoneAt: null,
      },
      /can be undone until 01\/11\/2026 09:00/,
    ],
    [
      { status: "committed", undoAvailable: false, undoClosesAt: null, undoneAt: null },
      /can no longer be undone/,
    ],
    [
      {
        status: "undone",
        undoAvailable: false,
        undoClosesAt: null,
        undoneAt: "2026-11-01T09:00:00Z",
      },
      /was undone at/,
    ],
  ] as const)("%j", (batch, words) => {
    expect(undoWords(batch, t, when)).toMatch(words);
  });

  it("says nothing about undo before a commit", () => {
    expect(
      undoWords(
        { status: "staged", undoAvailable: false, undoClosesAt: null, undoneAt: null },
        t,
        when,
      ),
    ).toBeNull();
  });
});
