import { validateNhsNumber } from "../people/nhs-number";

/**
 * Import validation (PLAT-014; platform.md, Phase 2 rules 11 to 14; ADR-0092 in slice 26). Pure:
 * rows arrive as text keyed by column, are checked against data-standards.md (NHS number modulus
 * 11, dd/mm/yyyy dates that exist, coded fields), and come out as stored values. Errors name the row
 * and column with a code and plain words, never the value (it may be personal data). Nothing is
 * committed by a dry run; a batch commits only when every row is valid, and is undone only within
 * the window while nothing has changed since.
 */

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
    }
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

/** People, as data-standards.md defines their columns. */
export const PERSON_IMPORT_FIELDS: ImportFields = {
  given_name: { kind: "text", label: "Given name", required: true, max: 100 },
  family_name: { kind: "text", label: "Family name", required: true, max: 100 },
  preferred_name: { kind: "text", label: "Preferred name", required: false, max: 100 },
  date_of_birth: { kind: "date", label: "Date of birth", required: true, notFuture: true },
  nhs_number: { kind: "nhs_number", label: "NHS number", required: false },
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
  postcode: { kind: "text", label: "Postcode", required: false, max: 8 },
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

export type ImportErrorCode =
  | "unknown_column"
  | "required"
  | "too_long"
  | "invalid_nhs_number"
  | "invalid_date"
  | "date_in_future"
  | "invalid_code"
  | "duplicate";

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
    case "invalid_code":
      return `${label} is not one of the values Harbour accepts.`;
    case "duplicate":
      return `${label} appears on more than one row.`;
  }
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
      return { ok: true, value: iso };
    }
    case "code":
      return field.codes.includes(text)
        ? { ok: true, value: text }
        : { ok: false, code: "invalid_code" };
  }
}

/**
 * Checks every row against the fields and returns the stored values with every error found
 * (rules 11 and 12). `uniqueBy` names a column whose value may appear on one row only.
 */
export function validateImportRows(
  rows: readonly Readonly<Record<string, string>>[],
  fields: ImportFields,
  options: { readonly today: string; readonly uniqueBy?: string },
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
  const out: Record<string, string>[] = [];
  const seen = new Map<string, number[]>();
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
    const key = options.uniqueBy ? stored[options.uniqueBy] : undefined;
    if (key) seen.set(key, [...(seen.get(key) ?? []), index + 1]);
    out.push(stored);
  });
  const uniqueBy = options.uniqueBy;
  if (uniqueBy) {
    const label = fields[uniqueBy]?.label ?? uniqueBy;
    for (const rowsWithKey of seen.values()) {
      if (rowsWithKey.length < 2) continue;
      for (const row of rowsWithKey) {
        errors.push({
          row,
          column: uniqueBy,
          code: "duplicate",
          message: message("duplicate", label),
        });
      }
    }
  }
  errors.sort((a, b) => a.row - b.row || a.column.localeCompare(b.column));
  return { rows: out, errors, rowCount: rows.length };
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

export interface ImportBatchState {
  readonly committedAt: Date;
  readonly undoneAt: Date | null;
  /** Any imported record edited since the commit. */
  readonly changedSinceCommit: boolean;
  /** Any record made about an imported one since the commit (a note, a task, a document). */
  readonly referencedSinceCommit: boolean;
}

export type UndoProblem = "already_undone" | "window_passed" | "changed_since" | "referenced_since";

const UNDO_MESSAGES: Record<UndoProblem, string> = {
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
  const closes = batch.committedAt.getTime() + rates.undoWindowDays * 86_400_000;
  if (now.getTime() > closes) return refuse("window_passed");
  if (batch.changedSinceCommit) return refuse("changed_since");
  if (batch.referencedSinceCommit) return refuse("referenced_since");
  return { ok: true };
}
