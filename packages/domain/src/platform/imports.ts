import { validateNhsNumber } from "../people/nhs-number";

/**
 * Import validation (PLAT-014; platform.md, Phase 2 rules 11 to 26; ADR-0092). Pure: a file is read
 * (`parseImportCsv`), its columns are matched to Harbour fields (`mapImportColumns`), its rows are
 * checked against data-standards.md (NHS number modulus 11, dd/mm/yyyy dates that exist, coded
 * fields) and against the people already in the organisation (`matchExistingPeople`, HZ-130), and
 * they come out as stored values. Errors name the row and column with a code and plain words, never
 * the value (it may be personal data) and never a column heading (a file without a header row makes
 * its first person's details the headings). Nothing is committed by a dry run; a batch commits only
 * when every row is valid, and is undone only within the window while nothing has changed since.
 */

/** Record types an import takes (slice 26: people; contacts, allergies and staff follow). */
export const IMPORT_RECORD_TYPES = ["people"] as const;
export type ImportRecordType = (typeof IMPORT_RECORD_TYPES)[number];

/** Where a batch stands (platform.md rules 19 to 25): forward only. */
export const IMPORT_BATCH_STATUSES = [
  "staged",
  "committed",
  "undone",
  "discarded",
  "expired",
] as const;
export type ImportBatchStatus = (typeof IMPORT_BATCH_STATUSES)[number];

export interface ImportLimits {
  readonly rows: number;
  readonly columns: number;
  readonly cellCharacters: number;
}

/**
 * How much one upload may hold (rule 19). Product limits that keep a request and a transaction a
 * sensible size, not statutory figures: a care provider's people fit well within them, and a larger
 * organisation imports a home at a time.
 */
export const IMPORT_LIMITS: ImportLimits = { rows: 5000, columns: 60, cellCharacters: 2000 };

/** Most errors and warnings one dry-run report lists; the counts by code always cover them all. */
export const IMPORT_REPORT_MAX_ITEMS = 500;

/** The rate-table figures an import reads (rates.md), never literals. */
export const IMPORT_RATE_KEYS = {
  undoWindowDays: "import.undo_window_days",
  stagingExpiryDays: "import.staging_expiry_days",
} as const;

export type ImportField =
  | {
      readonly kind: "text";
      readonly label: string;
      readonly required: boolean;
      readonly max: number;
    }
  | { readonly kind: "nhs_number"; readonly label: string; readonly required: boolean }
  | {
      readonly kind: "date";
      readonly label: string;
      readonly required: boolean;
      /** A date that may not be after today (a date of birth). */
      readonly notFuture: boolean;
      /** The earliest date taken (yyyy-mm-dd). */
      readonly notBefore?: string;
    }
  | { readonly kind: "postcode"; readonly label: string; readonly required: boolean }
  | {
      readonly kind: "code";
      readonly label: string;
      readonly required: boolean;
      readonly codes: readonly string[];
      /** Stored when the cell is blank; never a value that claims something was checked. */
      readonly whenBlank?: string;
    };

export type ImportFields = Readonly<Record<string, ImportField>>;

/** NHS Data Dictionary PERSON PHENOTYPIC SEX and PERSON STATED GENDER CODE (data-standards.md). */
const SEX_AND_GENDER_CODES = ["1", "2", "9", "X"] as const;

/** The earliest date of birth taken, as for a person added by hand (people.md, PEOP-001). */
export const EARLIEST_DATE_OF_BIRTH = "1900-01-01";

/** People, as data-standards.md defines their columns. */
export const PERSON_IMPORT_FIELDS: ImportFields = {
  given_name: { kind: "text", label: "Given name", required: true, max: 100 },
  family_name: { kind: "text", label: "Family name", required: true, max: 100 },
  preferred_name: { kind: "text", label: "Preferred name", required: false, max: 100 },
  date_of_birth: {
    kind: "date",
    label: "Date of birth",
    required: true,
    notFuture: true,
    notBefore: EARLIEST_DATE_OF_BIRTH,
  },
  nhs_number: { kind: "nhs_number", label: "NHS number", required: false },
  // A person with no NHS number needs this instead (rule 20; people.md, as for one added by hand).
  local_identifier: { kind: "text", label: "Local identifier", required: false, max: 60 },
  sex_code: { kind: "code", label: "Sex", required: false, codes: SEX_AND_GENDER_CODES },
  gender_identity: { kind: "code", label: "Gender", required: false, codes: SEX_AND_GENDER_CODES },
  // A blank status is unknown, never "no known allergies" (HZ-007).
  allergy_status: {
    kind: "code",
    label: "Allergy status",
    required: false,
    codes: ["unknown", "no_known_allergies", "has_allergies"],
    whenBlank: "unknown",
  },
  postcode: { kind: "postcode", label: "Postcode", required: false },
};

/** Allergies, matched to their person by NHS number (HL7 FHIR UK Core reaction severity). */
export const ALLERGY_IMPORT_FIELDS: ImportFields = {
  person_nhs_number: { kind: "nhs_number", label: "Person's NHS number", required: true },
  substance: { kind: "text", label: "Substance", required: true, max: 200 },
  reaction: { kind: "text", label: "Reaction", required: false, max: 500 },
  severity: {
    kind: "code",
    label: "Severity",
    required: false,
    codes: ["mild", "moderate", "severe"],
  },
};

/** The fields each record type takes. */
export const IMPORT_FIELDS: Readonly<Record<ImportRecordType, ImportFields>> = {
  people: PERSON_IMPORT_FIELDS,
};

export type ImportErrorCode =
  | "unknown_column"
  | "required"
  | "too_long"
  | "invalid_nhs_number"
  | "invalid_date"
  | "date_in_future"
  | "date_too_early"
  | "invalid_code"
  | "invalid_postcode"
  | "control_character"
  | "identifier_required"
  | "duplicate"
  | "already_in_harbour";

export interface ImportError {
  /** The 1-based data row; 0 for a problem with the file itself (a column). */
  readonly row: number;
  readonly column: string;
  readonly code: ImportErrorCode;
  /** Plain words naming the column, never the value. */
  readonly message: string;
}

export interface ImportValidation {
  readonly rows: readonly Readonly<Record<string, string>>[];
  readonly errors: readonly ImportError[];
  readonly rowCount: number;
}

function message(code: ImportErrorCode, label: string): string {
  switch (code) {
    case "unknown_column":
      return `The column "${label}" is not one Harbour imports. Remove it or rename it.`;
    case "required":
      return `Fill in ${label.toLowerCase()}.`;
    case "too_long":
      return `${label} is too long.`;
    case "invalid_nhs_number":
      return `${label} is not a valid NHS number: it must be 10 digits that pass the check.`;
    case "invalid_date":
      return `${label} must be a real date written as dd/mm/yyyy.`;
    case "date_in_future":
      return `${label} cannot be in the future.`;
    case "date_too_early":
      return `${label} is too early: check the year has all four digits.`;
    case "invalid_code":
      return `${label} is not one of the values Harbour accepts.`;
    case "invalid_postcode":
      return `${label} must be a full UK postcode.`;
    case "control_character":
      return `${label} holds a character that cannot be stored. Remove it.`;
    case "identifier_required":
      return "Give each person an NHS number or a local identifier.";
    case "duplicate":
      return `${label} appears on more than one row.`;
    case "already_in_harbour":
      return `${label} is already on someone's record in Harbour. Remove the row and make any change on that record.`;
  }
}

/**
 * True when text holds a control character other than a tab, line feed or carriage return (C0,
 * DEL and C1), which no one types and Postgres cannot always store (people.md refuses them too).
 */
export function hasControlCharacter(value: string): boolean {
  for (const char of value) {
    const code = char.charCodeAt(0);
    if (code < 0x20 && code !== 0x09 && code !== 0x0a && code !== 0x0d) return true;
    if (code >= 0x7f && code <= 0x9f) return true;
  }
  return false;
}

const POSTCODE = /^[A-Z]{1,2}[0-9][A-Z0-9]? [0-9][A-Z]{2}$/;

/** "zz993zz" as "ZZ99 3ZZ" (data-standards.md: upper case, one space), or null if it is not one. */
export function normaliseUkPostcode(value: string): string | null {
  const compact = value.toUpperCase().replace(/\s+/g, "");
  if (compact.length < 5 || compact.length > 7) return null;
  const spaced = `${compact.slice(0, -3)} ${compact.slice(-3)}`;
  return POSTCODE.test(spaced) ? spaced : null;
}

const UK_DATE = /^(\d{2})\/(\d{2})\/(\d{4})$/;

/** dd/mm/yyyy to yyyy-mm-dd, or null when it is not a real date in that form. */
export function parseUkDate(value: string): string | null {
  const m = UK_DATE.exec(value);
  if (!m) return null;
  const [d, mo, y] = [Number(m[1]), Number(m[2]), Number(m[3])];
  const date = new Date(Date.UTC(y, mo - 1, d));
  if (date.getUTCFullYear() !== y || date.getUTCMonth() !== mo - 1 || date.getUTCDate() !== d) {
    return null;
  }
  return date.toISOString().slice(0, 10);
}

type Checked = { ok: true; value: string | null } | { ok: false; code: ImportErrorCode };

function checkValue(field: ImportField, raw: string | undefined, today: string): Checked {
  const text = (raw ?? "").trim();
  if (text === "") {
    if (field.required) return { ok: false, code: "required" };
    return { ok: true, value: field.kind === "code" ? (field.whenBlank ?? null) : null };
  }
  if (hasControlCharacter(text)) return { ok: false, code: "control_character" };
  switch (field.kind) {
    case "text":
      return text.length > field.max ? { ok: false, code: "too_long" } : { ok: true, value: text };
    case "nhs_number": {
      const checked = validateNhsNumber(text);
      return checked.valid
        ? { ok: true, value: checked.value }
        : { ok: false, code: "invalid_nhs_number" };
    }
    case "date": {
      const iso = parseUkDate(text);
      if (!iso) return { ok: false, code: "invalid_date" };
      if (field.notFuture && iso > today) return { ok: false, code: "date_in_future" };
      if (field.notBefore && iso < field.notBefore) return { ok: false, code: "date_too_early" };
      return { ok: true, value: iso };
    }
    case "postcode": {
      const postcode = normaliseUkPostcode(text);
      return postcode ? { ok: true, value: postcode } : { ok: false, code: "invalid_postcode" };
    }
    case "code":
      return field.codes.includes(text)
        ? { ok: true, value: text }
        : { ok: false, code: "invalid_code" };
  }
}

const byRowThenColumn = (a: ImportError, b: ImportError) =>
  a.row - b.row || a.column.localeCompare(b.column) || a.code.localeCompare(b.code);

/**
 * Checks every row against the fields and returns the stored values with every error found
 * (rules 11 and 12). `uniqueBy` names a column, or columns, whose value may appear on one row only.
 */
export function validateImportRows(
  rows: readonly Readonly<Record<string, string>>[],
  fields: ImportFields,
  options: { readonly today: string; readonly uniqueBy?: string | readonly string[] },
): ImportValidation {
  const errors: ImportError[] = [];
  const unknown = new Set<string>();
  for (const row of rows) {
    for (const column of Object.keys(row)) if (!(column in fields)) unknown.add(column);
  }
  for (const column of [...unknown].sort()) {
    errors.push({
      row: 0,
      column,
      code: "unknown_column",
      message: message("unknown_column", column),
    });
  }
  const uniqueColumns =
    options.uniqueBy === undefined
      ? []
      : typeof options.uniqueBy === "string"
        ? [options.uniqueBy]
        : [...options.uniqueBy];
  const seen = new Map(uniqueColumns.map((c) => [c, new Map<string, number[]>()]));
  const out: Record<string, string>[] = [];
  rows.forEach((row, index) => {
    const stored: Record<string, string> = {};
    for (const [column, field] of Object.entries(fields)) {
      const checked = checkValue(field, row[column], options.today);
      if (!checked.ok) {
        errors.push({
          row: index + 1,
          column,
          code: checked.code,
          message: message(checked.code, field.label),
        });
      } else if (checked.value !== null) {
        stored[column] = checked.value;
      }
    }
    for (const column of uniqueColumns) {
      const key = stored[column];
      const byValue = seen.get(column);
      if (key && byValue) byValue.set(key, [...(byValue.get(key) ?? []), index + 1]);
    }
    out.push(stored);
  });
  for (const column of uniqueColumns) {
    const label = fields[column]?.label ?? column;
    for (const rowsWithKey of seen.get(column)?.values() ?? []) {
      if (rowsWithKey.length < 2) continue;
      for (const row of rowsWithKey) {
        errors.push({ row, column, code: "duplicate", message: message("duplicate", label) });
      }
    }
  }
  errors.sort(byRowThenColumn);
  return { rows: out, errors, rowCount: rows.length };
}

/**
 * People (rules 12 and 20): the field rules, an NHS number and a local identifier each on one row
 * only, and every person identified by one or the other (a blank or invalid NHS number with no
 * local identifier). Invalid values are already errors of their own, so a row is told to add an
 * identifier only when both cells are blank.
 */
export function validatePersonImport(
  rows: readonly Readonly<Record<string, string>>[],
  today: string,
): ImportValidation {
  const validation = validateImportRows(rows, PERSON_IMPORT_FIELDS, {
    today,
    uniqueBy: ["nhs_number", "local_identifier"],
  });
  const errors = [...validation.errors];
  rows.forEach((row, index) => {
    const blank = (column: string) => (row[column] ?? "").trim() === "";
    if (blank("nhs_number") && blank("local_identifier")) {
      errors.push({
        row: index + 1,
        column: "nhs_number",
        code: "identifier_required",
        message: message("identifier_required", ""),
      });
    }
  });
  errors.sort(byRowThenColumn);
  return { ...validation, errors };
}

// ------------------------------------------------------------------------------------------------
// Reading a file (rule 19)
// ------------------------------------------------------------------------------------------------

export type CsvProblem =
  | "empty"
  | "unclosed_quote"
  | "too_many_cells"
  | "too_many_rows"
  | "too_many_columns"
  | "cell_too_long";

export type ParsedImportFile =
  | {
      readonly ok: true;
      readonly header: readonly string[];
      readonly rows: readonly (readonly string[])[];
    }
  | {
      readonly ok: false;
      readonly problem: CsvProblem;
      /** The 1-based data row the problem is on; 0 for the file or its header. */
      readonly row: number;
      readonly message: string;
    };

const CSV_MESSAGES: Readonly<Record<CsvProblem, (row: number, limits: ImportLimits) => string>> = {
  empty: () => "The file has no header row and no rows to import.",
  unclosed_quote: (row) =>
    `${row === 0 ? "The header row" : `Row ${row}`} opens a quotation mark that is never closed. Check the file was saved as CSV.`,
  too_many_cells: (row) => `Row ${row} has more cells than the header has columns.`,
  too_many_rows: (_row, limits) =>
    `The file has more than ${limits.rows} rows. Import it in smaller files, a home at a time.`,
  too_many_columns: (_row, limits) => `The file has more than ${limits.columns} columns.`,
  cell_too_long: (row, limits) =>
    row === 0
      ? `A column heading is longer than ${limits.cellCharacters} characters.`
      : `Row ${row} has a cell longer than ${limits.cellCharacters} characters.`,
};

function csvFailure(problem: CsvProblem, row: number, limits: ImportLimits): ParsedImportFile {
  return { ok: false, problem, row, message: CSV_MESSAGES[problem](row, limits) };
}

/**
 * Reads CSV text (RFC 4180): comma separated, CRLF or LF line ends, double-quoted cells that may
 * hold commas, line breaks and doubled quotes. A UTF-8 byte order mark is dropped; blank lines are
 * not rows; a row with fewer cells than the header is padded with blanks, one with more is
 * refused. Problems name a row number, never a cell.
 */
export function parseImportCsv(
  text: string,
  limits: ImportLimits = IMPORT_LIMITS,
): ParsedImportFile {
  const source = text.startsWith("﻿") ? text.slice(1) : text;
  const records: string[][] = [];
  let record: string[] = [];
  let cell = "";
  let quoted = false;
  let cellWasQuoted = false;
  let lastCellQuoted = false;
  let i = 0;
  const endCell = () => {
    record.push(cell);
    cell = "";
    cellWasQuoted = false;
  };
  const endRecord = () => {
    endCell();
    // A blank line (one empty, unquoted cell) is not a row.
    if (!(record.length === 1 && record[0] === "" && !lastCellQuoted)) records.push(record);
    record = [];
  };
  while (i < source.length) {
    const char = source[i] as string;
    if (quoted) {
      if (char === '"') {
        if (source[i + 1] === '"') {
          cell += '"';
          i += 2;
          continue;
        }
        quoted = false;
        i += 1;
        continue;
      }
      cell += char;
      i += 1;
      continue;
    }
    if (char === '"' && cell === "" && !cellWasQuoted) {
      quoted = true;
      cellWasQuoted = true;
      lastCellQuoted = true;
      i += 1;
      continue;
    }
    if (char === ",") {
      endCell();
      lastCellQuoted = false;
      i += 1;
      continue;
    }
    if (char === "\r" || char === "\n") {
      endRecord();
      lastCellQuoted = false;
      i += char === "\r" && source[i + 1] === "\n" ? 2 : 1;
      continue;
    }
    cell += char;
    i += 1;
  }
  // The open record is the header (0) or the data row after those already read.
  if (quoted) return csvFailure("unclosed_quote", records.length, limits);
  if (cell !== "" || record.length > 0 || lastCellQuoted) endRecord();
  const [header, ...rows] = records;
  if (!header) return csvFailure("empty", 0, limits);
  if (header.length > limits.columns) return csvFailure("too_many_columns", 0, limits);
  if (header.some((h) => h.length > limits.cellCharacters)) {
    return csvFailure("cell_too_long", 0, limits);
  }
  if (rows.length > limits.rows) return csvFailure("too_many_rows", 0, limits);
  const padded: string[][] = [];
  for (const [index, row] of rows.entries()) {
    if (row.length > header.length) return csvFailure("too_many_cells", index + 1, limits);
    if (row.some((c) => c.length > limits.cellCharacters)) {
      return csvFailure("cell_too_long", index + 1, limits);
    }
    padded.push([...row, ...Array<string>(header.length - row.length).fill("")]);
  }
  return { ok: true, header, rows: padded };
}

// ------------------------------------------------------------------------------------------------
// Matching columns to fields (rule 19)
// ------------------------------------------------------------------------------------------------

export type ColumnProblem = "unknown_column" | "unknown_field" | "duplicate_column";

export interface ColumnError {
  /** The column's 1-based position in the file; never its heading. */
  readonly column: number;
  readonly code: ColumnProblem;
  readonly message: string;
}

export type ColumnMapping =
  | { readonly ok: true; readonly fields: readonly (string | null)[] }
  | { readonly ok: false; readonly errors: readonly ColumnError[] };

const comparable = (value: string) =>
  value
    .trim()
    .toLowerCase()
    .replace(/[\s_-]+/g, "");

/**
 * Matches each column to a Harbour field (rule 19): by the mapping given (heading to field key, or
 * null to leave the column out), else by the field's key or label, ignoring case, spaces, hyphens
 * and underscores. `fields[i]` is the field for column i + 1, or null for a column left out. A
 * column that matches nothing, a mapping to no field, and two columns for one field are refused,
 * each by the column's position.
 */
export function mapImportColumns(
  header: readonly string[],
  fields: ImportFields,
  mapping: Readonly<Record<string, string | null>> = {},
): ColumnMapping {
  const byName = new Map<string, string>();
  for (const [key, field] of Object.entries(fields)) {
    byName.set(comparable(key), key);
    byName.set(comparable(field.label), key);
  }
  const errors: ColumnError[] = [];
  const chosen: (string | null)[] = [];
  const firstColumnFor = new Map<string, number>();
  header.forEach((heading, index) => {
    const column = index + 1;
    const mapped = Object.hasOwn(mapping, heading) ? mapping[heading] : undefined;
    if (mapped === null) {
      chosen.push(null);
      return;
    }
    if (mapped !== undefined && !(mapped in fields)) {
      errors.push({
        column,
        code: "unknown_field",
        message: `Column ${column} is mapped to a field Harbour does not import.`,
      });
      chosen.push(null);
      return;
    }
    const field = mapped ?? byName.get(comparable(heading));
    if (!field) {
      errors.push({
        column,
        code: "unknown_column",
        message: `Column ${column} is not one Harbour imports. Map it to a Harbour field, or leave it out.`,
      });
      chosen.push(null);
      return;
    }
    const first = firstColumnFor.get(field);
    if (first !== undefined) {
      errors.push({
        column,
        code: "duplicate_column",
        message: `Columns ${first} and ${column} are both ${fields[field]?.label ?? field}. Keep one.`,
      });
      chosen.push(null);
      return;
    }
    firstColumnFor.set(field, column);
    chosen.push(field);
  });
  return errors.length > 0 ? { ok: false, errors } : { ok: true, fields: chosen };
}

/** The staged cells of one row: the matched columns only, keyed by field, as given. */
export function stagedCells(
  row: readonly string[],
  fields: readonly (string | null)[],
): Record<string, string> {
  const cells: Record<string, string> = {};
  fields.forEach((field, index) => {
    if (field) cells[field] = row[index] ?? "";
  });
  return cells;
}

// ------------------------------------------------------------------------------------------------
// Matching people (rule 21; HZ-130)
// ------------------------------------------------------------------------------------------------

/** A person already in the organisation, as matching reads them (never more). */
export interface ExistingPerson {
  readonly nhsNumber: string | null;
  readonly localIdentifier: string | null;
  readonly givenName: string;
  readonly familyName: string;
  /** yyyy-mm-dd */
  readonly dateOfBirth: string | null;
}

export type ImportWarningCode = "possible_duplicate";

export interface ImportWarning {
  readonly row: number;
  readonly column: string;
  readonly code: ImportWarningCode;
  readonly message: string;
}

export interface PeopleMatches {
  readonly errors: readonly ImportError[];
  readonly warnings: readonly ImportWarning[];
}

const POSSIBLE_DUPLICATE =
  "Someone with the same name and date of birth is already in Harbour or on another row, and one of them has no NHS number. Check they are not the same person.";

const sameName = (value: string) => value.trim().toLowerCase().replace(/\s+/g, " ");

function nameAndBirth(given: string, family: string, birth: string | null | undefined) {
  return birth ? `${sameName(given)}|${sameName(family)}|${birth}` : null;
}

/**
 * Matches validated rows against the people already in the organisation (the caller passes only
 * the people the importer can see, which rule 18 makes everyone in the organisation, and never
 * another organisation's). A row whose NHS number or local identifier is already on a record is an
 * error: an import never updates, merges or attaches to an existing person. The same name and date
 * of birth as an existing person or another row, where either has no NHS number, is a warning; two
 * different NHS numbers are two people. Neither says whose record matched.
 */
export function matchExistingPeople(
  validation: ImportValidation,
  existing: readonly ExistingPerson[],
): PeopleMatches {
  const nhs = new Set(existing.flatMap((p) => (p.nhsNumber ? [p.nhsNumber] : [])));
  const local = new Set(existing.flatMap((p) => (p.localIdentifier ? [p.localIdentifier] : [])));
  const existingByName = new Map<string, (string | null)[]>();
  for (const p of existing) {
    const key = nameAndBirth(p.givenName, p.familyName, p.dateOfBirth);
    if (key) existingByName.set(key, [...(existingByName.get(key) ?? []), p.nhsNumber]);
  }
  const errors: ImportError[] = [];
  const warnings: ImportWarning[] = [];
  const rowsByName = new Map<string, { row: number; nhs: string | null }[]>();
  validation.rows.forEach((stored, index) => {
    const row = index + 1;
    if (stored.nhs_number && nhs.has(stored.nhs_number)) {
      errors.push({
        row,
        column: "nhs_number",
        code: "already_in_harbour",
        message: message("already_in_harbour", "This NHS number"),
      });
    }
    if (stored.local_identifier && local.has(stored.local_identifier)) {
      errors.push({
        row,
        column: "local_identifier",
        code: "already_in_harbour",
        message: message("already_in_harbour", "This local identifier"),
      });
    }
    const key = nameAndBirth(
      stored.given_name ?? "",
      stored.family_name ?? "",
      stored.date_of_birth,
    );
    if (!key || !stored.given_name || !stored.family_name) return;
    const mine = stored.nhs_number ?? null;
    const clash = (other: string | null) => mine === null || other === null;
    if ((existingByName.get(key) ?? []).some(clash)) {
      warnings.push({
        row,
        column: "date_of_birth",
        code: "possible_duplicate",
        message: POSSIBLE_DUPLICATE,
      });
    }
    rowsByName.set(key, [...(rowsByName.get(key) ?? []), { row, nhs: mine }]);
  });
  for (const group of rowsByName.values()) {
    for (const entry of group) {
      const others = group.filter((g) => g.row !== entry.row);
      if (!others.some((o) => entry.nhs === null || o.nhs === null)) continue;
      if (warnings.some((w) => w.row === entry.row)) continue;
      warnings.push({
        row: entry.row,
        column: "date_of_birth",
        code: "possible_duplicate",
        message: POSSIBLE_DUPLICATE,
      });
    }
  }
  errors.sort(byRowThenColumn);
  warnings.sort((a, b) => a.row - b.row);
  return { errors, warnings };
}

export interface DryRunReport {
  readonly rows: number;
  readonly validRows: number;
  readonly errorCount: number;
  readonly byCode: Readonly<Partial<Record<ImportErrorCode, number>>>;
  readonly mayCommit: boolean;
}

/** What a dry run says (rule 13): rows, valid rows, errors by code, and whether it may commit. */
export function dryRunReport(validation: ImportValidation): DryRunReport {
  const byCode: Partial<Record<ImportErrorCode, number>> = {};
  for (const e of validation.errors) byCode[e.code] = (byCode[e.code] ?? 0) + 1;
  const rowsWithErrors = new Set(validation.errors.filter((e) => e.row > 0).map((e) => e.row));
  const fileErrors = validation.errors.some((e) => e.row === 0);
  return {
    rows: validation.rowCount,
    validRows: fileErrors ? 0 : validation.rowCount - rowsWithErrors.size,
    errorCount: validation.errors.length,
    byCode,
    mayCommit: checkImportCommit(validation).ok,
  };
}

/** A batch commits whole or not at all: only with rows and no errors (rule 13). */
export function checkImportCommit(
  validation: ImportValidation,
):
  | { readonly ok: true }
  | { readonly ok: false; readonly problem: "empty" | "has_errors"; readonly message: string } {
  if (validation.rowCount === 0) {
    return { ok: false, problem: "empty", message: "The file has no rows to import." };
  }
  if (validation.errors.length > 0) {
    return {
      ok: false,
      problem: "has_errors",
      message:
        "Correct every error in the file first: nothing is imported until all rows are valid.",
    };
  }
  return { ok: true };
}

/** A people import's dry run (rule 22): the report, its findings by row, and HZ-007's lists. */
export interface PeopleDryRun extends DryRunReport {
  readonly warningCount: number;
  /** The first `IMPORT_REPORT_MAX_ITEMS` errors and warnings, by row. */
  readonly errors: readonly ImportError[];
  readonly warnings: readonly ImportWarning[];
  /** True when more errors or warnings were found than are listed. */
  readonly truncated: boolean;
  /** HZ-007: rows that will read "allergy status not recorded" until someone records it. */
  readonly allergyStatusUnknownRows: readonly number[];
  /** Rows marked as having allergies: each allergy is recorded on the person after the import. */
  readonly allergiesToRecordRows: readonly number[];
}

/** Validation and matching together: what the dry run reports and the commit checks again. */
export function peopleDryRun(
  rows: readonly Readonly<Record<string, string>>[],
  existing: readonly ExistingPerson[],
  today: string,
): { readonly validation: ImportValidation; readonly report: PeopleDryRun } {
  const checked = validatePersonImport(rows, today);
  const matches = matchExistingPeople(checked, existing);
  const validation: ImportValidation = {
    ...checked,
    errors: [...checked.errors, ...matches.errors].sort(byRowThenColumn),
  };
  const rowsWith = (status: string) =>
    validation.rows.flatMap((r, i) => (r.allergy_status === status ? [i + 1] : []));
  return {
    validation,
    report: {
      ...dryRunReport(validation),
      warningCount: matches.warnings.length,
      errors: validation.errors.slice(0, IMPORT_REPORT_MAX_ITEMS),
      warnings: matches.warnings.slice(0, IMPORT_REPORT_MAX_ITEMS),
      truncated:
        validation.errors.length > IMPORT_REPORT_MAX_ITEMS ||
        matches.warnings.length > IMPORT_REPORT_MAX_ITEMS,
      allergyStatusUnknownRows: rowsWith("unknown"),
      allergiesToRecordRows: rowsWith("has_allergies"),
    },
  };
}

export type CommitProblem =
  | "not_staged"
  | "dry_run_first"
  | "empty"
  | "has_errors"
  | "possible_duplicates_unacknowledged";

const COMMIT_MESSAGES: Readonly<Record<CommitProblem, string>> = {
  not_staged: "This import can no longer be committed: it was committed, discarded or expired.",
  dry_run_first: "Run the dry run and read its report before committing.",
  empty: "The file has no rows to import.",
  has_errors:
    "Correct every error in the file first: nothing is imported until all rows are valid.",
  possible_duplicates_unacknowledged:
    "Some rows may be people already in Harbour. Check each one, then confirm before committing.",
};

/**
 * Whether a batch may commit now (rules 13, 21 and 23): staged, with a dry run behind it, every row
 * valid when checked again, and any possible duplicates acknowledged by the person committing.
 */
export function checkPeopleCommit(input: {
  readonly status: ImportBatchStatus;
  readonly dryRunAt: Date | null;
  readonly report: PeopleDryRun;
  readonly acknowledgePossibleDuplicates: boolean;
}):
  | { readonly ok: true }
  | { readonly ok: false; readonly problem: CommitProblem; readonly message: string } {
  const refuse = (problem: CommitProblem) =>
    ({ ok: false, problem, message: COMMIT_MESSAGES[problem] }) as const;
  if (input.status !== "staged") return refuse("not_staged");
  if (!input.dryRunAt) return refuse("dry_run_first");
  if (input.report.rows === 0) return refuse("empty");
  if (input.report.errorCount > 0) return refuse("has_errors");
  if (input.report.warningCount > 0 && !input.acknowledgePossibleDuplicates) {
    return refuse("possible_duplicates_unacknowledged");
  }
  return { ok: true };
}

const DAY_MS = 86_400_000;

/** When an uploaded batch's staged rows are deleted unless committed first (rule 19). */
export function importStagingExpiresAt(
  uploadedAt: Date,
  rates: { readonly stagingExpiryDays: number },
): Date {
  return new Date(uploadedAt.getTime() + rates.stagingExpiryDays * DAY_MS);
}

/** The last moment a committed batch may be undone (rule 14). */
export function importUndoClosesAt(
  committedAt: Date,
  rates: { readonly undoWindowDays: number },
): Date {
  return new Date(committedAt.getTime() + rates.undoWindowDays * DAY_MS);
}

export interface ImportBatchState {
  readonly committedAt: Date;
  readonly undoneAt: Date | null;
  /** Any imported record edited since the commit. */
  readonly changedSinceCommit: boolean;
  /** Any record made about an imported one since the commit (a note, a task, a document). */
  readonly referencedSinceCommit: boolean;
}

export type UndoProblem = "already_undone" | "window_passed" | "changed_since" | "referenced_since";

export const UNDO_MESSAGES: Readonly<Record<UndoProblem, string>> = {
  already_undone: "This import has already been undone.",
  window_passed: "The time to undo this import has passed. Correct records one by one.",
  changed_since: "Records from this import have been changed since. Correct records one by one.",
  referenced_since:
    "Records have been made about people from this import since. Correct records one by one.",
};

/** Whether a batch may be undone (rule 14): once, within the window, with nothing changed since. */
export function importUndoEligibility(
  batch: ImportBatchState,
  rates: { readonly undoWindowDays: number },
  now: Date,
):
  | { readonly ok: true }
  | { readonly ok: false; readonly problem: UndoProblem; readonly message: string } {
  const refuse = (problem: UndoProblem) =>
    ({ ok: false, problem, message: UNDO_MESSAGES[problem] }) as const;
  if (batch.undoneAt) return refuse("already_undone");
  if (now.getTime() > importUndoClosesAt(batch.committedAt, rates).getTime()) {
    return refuse("window_passed");
  }
  if (batch.changedSinceCommit) return refuse("changed_since");
  if (batch.referencedSinceCommit) return refuse("referenced_since");
  return { ok: true };
}
