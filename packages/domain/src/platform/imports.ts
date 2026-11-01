import { PCSP_DOMAINS } from "../care/care-plan";
import { MAR_SOURCE_KINDS } from "../medicines/mar-entry";
import { validateNhsNumber } from "../people/nhs-number";
import { IDENTITY_DOCUMENTS, RIGHT_TO_WORK_METHODS } from "../workforce/staff-file";

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

/**
 * Record types an import takes: people (slice 26); medicines, care plans and staff files (slice
 * 51, platform.md rules 27 to 31). Contacts and allergies follow.
 */
export const IMPORT_RECORD_TYPES = ["people", "medicines", "care_plans", "staff_files"] as const;
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

/**
 * Medicines (slice 51, rule 28; medicines.md rule 1), matched to their person by NHS number only.
 * The medicine is the dm+d product its code names, with dm+d's own name: the file has no name
 * column, so a typed name can never become a medicine (HZ-005). Each arrives not yet checked.
 */
export const MEDICINE_IMPORT_FIELDS: ImportFields = {
  person_nhs_number: { kind: "nhs_number", label: "Person's NHS number", required: true },
  vmp_id: { kind: "text", label: "dm+d VMP code", required: true, max: 18 },
  amp_id: { kind: "text", label: "dm+d AMP code", required: false, max: 18 },
  route_code: { kind: "text", label: "Route code", required: true, max: 18 },
  directions: {
    kind: "code",
    label: "Directions",
    required: true,
    codes: ["regular", "when_required"],
  },
  dose_quantity: { kind: "text", label: "Dose", required: true, max: 12 },
  dose_unit_code: { kind: "text", label: "Dose unit code", required: true, max: 18 },
  times: { kind: "text", label: "Times", required: false, max: 120 },
  indication: { kind: "text", label: "Indication", required: false, max: 500 },
  special_instructions: {
    kind: "text",
    label: "Special instructions",
    required: false,
    max: 500,
  },
  prescriber: { kind: "text", label: "Prescriber", required: true, max: 200 },
  starts_on: { kind: "date", label: "Start date", required: true, notFuture: false },
  stops_on: { kind: "date", label: "Stop date", required: false, notFuture: false },
  source_kind: { kind: "code", label: "Source", required: true, codes: MAR_SOURCE_KINDS },
  source_reference: { kind: "text", label: "Source reference", required: true, max: 200 },
};

/** Care plans (slice 51, rule 29): one row per need domain, matched by NHS number, as a draft. */
export const CARE_PLAN_IMPORT_FIELDS: ImportFields = {
  person_nhs_number: { kind: "nhs_number", label: "Person's NHS number", required: true },
  domain: { kind: "code", label: "Domain", required: true, codes: PCSP_DOMAINS },
  need: { kind: "text", label: "Need", required: true, max: 4000 },
  outcome: { kind: "text", label: "Outcome", required: true, max: 4000 },
  strengths: { kind: "text", label: "Strengths", required: false, max: 4000 },
  contingency: { kind: "text", label: "Contingency", required: false, max: 4000 },
};

/** The staff file checks an import takes (rule 30); the others are recorded by hand. */
export const STAFF_FILE_IMPORT_KINDS = [
  "identity_with_photo",
  "dbs_certificate",
  "right_to_work",
  "professional_registration",
  "references",
  "relevant_qualifications",
] as const;

/**
 * Staff files (slice 51, rule 30): one check per row, matched to a staff file by the member's
 * work email, never verified by the import. Never a DBS certificate's contents, a share code or
 * health details (data-standards.md).
 */
export const STAFF_FILE_IMPORT_FIELDS: ImportFields = {
  member_email: { kind: "text", label: "Work email", required: true, max: 254 },
  kind: { kind: "code", label: "Check", required: true, codes: STAFF_FILE_IMPORT_KINDS },
  identity_document: {
    kind: "code",
    label: "Identity document",
    required: false,
    codes: IDENTITY_DOCUMENTS,
  },
  dbs_level: {
    kind: "code",
    label: "DBS level",
    required: false,
    codes: ["enhanced_adults_barred", "enhanced", "standard", "basic"],
  },
  dbs_issued_on: { kind: "date", label: "DBS issue date", required: false, notFuture: true },
  dbs_certificate_number: {
    kind: "text",
    label: "DBS certificate number",
    required: false,
    max: 12,
  },
  dbs_result: {
    kind: "code",
    label: "DBS result",
    required: false,
    codes: ["clear", "information_disclosed"],
  },
  dbs_update_service: {
    kind: "code",
    label: "On the Update Service",
    required: false,
    codes: ["yes", "no"],
  },
  barred_list_clear_on: {
    kind: "date",
    label: "Barred list check date",
    required: false,
    notFuture: true,
  },
  right_to_work_method: {
    kind: "code",
    label: "Right to work method",
    required: false,
    codes: RIGHT_TO_WORK_METHODS,
  },
  right_to_work_checked_on: {
    kind: "date",
    label: "Right to work check date",
    required: false,
    notFuture: true,
  },
  right_to_work_permission: {
    kind: "code",
    label: "Right to work permission",
    required: false,
    codes: ["unlimited", "time_limited"],
  },
  right_to_work_expires_on: {
    kind: "date",
    label: "Right to work expiry",
    required: false,
    notFuture: false,
  },
  registration_body: {
    kind: "code",
    label: "Register",
    required: false,
    codes: ["nmc", "hcpc", "swe", "gmc"],
  },
  registration_pin: { kind: "text", label: "PIN", required: false, max: 12 },
  registration_renewal_due_on: {
    kind: "date",
    label: "Renewal date",
    required: false,
    notFuture: false,
  },
  revalidation_due_on: {
    kind: "date",
    label: "Revalidation date",
    required: false,
    notFuture: false,
  },
  references_received: { kind: "text", label: "References received", required: false, max: 3 },
  qualifications: { kind: "text", label: "Qualifications", required: false, max: 1000 },
};

/** The fields each record type takes. */
export const IMPORT_FIELDS: Readonly<Record<ImportRecordType, ImportFields>> = {
  people: PERSON_IMPORT_FIELDS,
  medicines: MEDICINE_IMPORT_FIELDS,
  care_plans: CARE_PLAN_IMPORT_FIELDS,
  staff_files: STAFF_FILE_IMPORT_FIELDS,
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
  | "test_nhs_number"
  | "duplicate"
  | "already_in_harbour"
  | "too_many_same_birth_date"
  | "too_many_possible_duplicates"
  // Slice 51 (rules 27 to 31)
  | "person_not_found"
  | "invalid_dmd_code"
  | "dmd_unknown"
  | "medicine_refused"
  | "invalid_dose"
  | "invalid_times"
  | "times_required"
  | "times_not_taken"
  | "indication_required"
  | "stops_before_start"
  | "care_plan_draft_exists"
  | "invalid_email"
  | "staff_file_not_found"
  | "own_staff_file"
  | "check_already_recorded"
  | "detail_required"
  | "detail_not_for_check"
  | "invalid_number";

export interface ImportError {
  /** The 1-based data row; 0 for a problem with the file itself (a column). */
  readonly row: number;
  readonly column: string;
  readonly code: ImportErrorCode;
  /** Plain words naming the column, never the value. */
  readonly message: string;
  /**
   * For `already_in_harbour`: the record that already has the identifier. The importer can see
   * everyone in the organisation (rule 18), so this tells them nothing they cannot already see.
   */
  readonly personId?: string;
}

export interface ImportValidation {
  readonly rows: readonly Readonly<Record<string, string>>[];
  readonly errors: readonly ImportError[];
  readonly rowCount: number;
}

/** The plain words for an error code about a column labelled `label` (never the value). */
export function importErrorMessage(code: ImportErrorCode, label: string): string {
  return message(code, label);
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
    case "test_nhs_number":
      return `${label} is a test number (999 range, or all zeros), which no real person has. Check it against their records.`;
    case "duplicate":
      return `${label} appears on more than one row.`;
    case "already_in_harbour":
      return `${label} is already on someone's record in Harbour. Remove the row and make any change on that record.`;
    case "too_many_same_birth_date":
      return `More than ${label} rows share one date of birth. Check the date of birth column is the right one and holds each person's own date, then upload the file again.`;
    case "person_not_found":
      return `No one in Harbour has this ${label.toLowerCase()}. Import or add the person first; a row is never matched by name.`;
    case "invalid_dmd_code":
      return `${label} is not a dm+d code: it must be the code's digits, with a valid check digit.`;
    case "dmd_unknown":
      return `${label} is not in the dm+d reference data Harbour holds, so the medicine cannot be imported. Check the code; a medicine is never imported by its name.`;
    case "medicine_refused":
      return `${label}: the medicine cannot be recorded like this.`;
    case "invalid_dose":
      return `${label} must be a number above zero, with at most three decimal places.`;
    case "invalid_times":
      return `${label} must be 24-hour times such as 08:00 20:00, each once.`;
    case "times_required":
      return `Give the ${label.toLowerCase()} for a regular medicine.`;
    case "times_not_taken":
      return `A when-required medicine has no ${label.toLowerCase()}: leave the column blank.`;
    case "indication_required":
      return `Give the ${label.toLowerCase()} for a when-required medicine.`;
    case "stops_before_start":
      return `${label} must be on or after the start date.`;
    case "care_plan_draft_exists":
      return `This person already has a draft care plan. Finish or discard it before importing another.`;
    case "invalid_email":
      return `${label} must be an email address.`;
    case "staff_file_not_found":
      return `No staff file in Harbour belongs to the member with this ${label.toLowerCase()}. Create the staff file first; a row is never matched by name.`;
    case "own_staff_file":
      return "This row is for your own staff file. Someone else imports or records your checks.";
    case "check_already_recorded":
      return `This check is already on the member's staff file. Change it on the staff file instead.`;
    case "detail_required":
      return `Fill in ${label.toLowerCase()} for this check.`;
    case "detail_not_for_check":
      return `${label} is not used for this check. Leave it blank.`;
    case "invalid_number":
      return `${label} must be a whole number.`;
    case "too_many_possible_duplicates":
      return `More than ${label} rows may be people already in Harbour or each other. The file may repeat people, or a name column may be mapped wrongly: check it and upload it again, a home at a time.`;
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

/**
 * True when text holds half of a UTF-16 surrogate pair on its own: not a character, and refused
 * by Postgres when it reaches a JSON value (#150 security review H1).
 */
export function hasLoneSurrogate(value: string): boolean {
  for (let i = 0; i < value.length; i += 1) {
    const code = value.charCodeAt(i);
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = value.charCodeAt(i + 1);
      if (next >= 0xdc00 && next <= 0xdfff) {
        i += 1;
        continue;
      }
      return true;
    }
    if (code >= 0xdc00 && code <= 0xdfff) return true;
  }
  return false;
}

/** True when text could not be stored as written: a control character or a lone surrogate. */
export function unstorableText(value: string): boolean {
  return hasControlCharacter(value) || hasLoneSurrogate(value);
}

export interface UploadCellProblem {
  /** The 1-based data row. */
  readonly row: number;
  /** The Harbour field key, never the file's heading. */
  readonly column: string;
  readonly message: string;
}

/**
 * The first staged cell that could not be stored (rule 19; #150 security review H1): checked at
 * upload, before anything is written, so a value Postgres would refuse never reaches a query
 * whose failure could carry it. Names the row and the field, never the value.
 */
export function uploadCellProblem(
  rows: readonly Readonly<Record<string, string>>[],
  fields: ImportFields,
): UploadCellProblem | null {
  for (const [index, row] of rows.entries()) {
    for (const [column, value] of Object.entries(row)) {
      if (!unstorableText(value)) continue;
      const label = Object.hasOwn(fields, column) ? (fields[column]?.label ?? column) : column;
      return {
        row: index + 1,
        column,
        message: `Row ${index + 1}: ${label} holds a character that cannot be stored (a control character or a broken one). Remove it and upload the file again.`,
      };
    }
  }
  return null;
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
  if (unstorableText(text)) return { ok: false, code: "control_character" };
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
    for (const column of Object.keys(row)) if (!Object.hasOwn(fields, column)) unknown.add(column);
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
 * identifier only when both cells are blank. Outside demonstration and test environments a
 * 999-range test number or 0000000000 (which passes the check digit) is refused: no real person
 * has one (#150 clinical review, low).
 */
export function validatePersonImport(
  rows: readonly Readonly<Record<string, string>>[],
  options: { readonly today: string; readonly allowTestNhsNumbers: boolean },
): ImportValidation {
  const validation = validateImportRows(rows, PERSON_IMPORT_FIELDS, {
    today: options.today,
    uniqueBy: ["nhs_number", "local_identifier"],
  });
  const errors = [...validation.errors];
  const rowsOut = validation.rows.map((r) => ({ ...r }));
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
    const nhs = validation.rows[index]?.nhs_number;
    if (nhs && !options.allowTestNhsNumbers && (nhs.startsWith("999") || nhs === "0000000000")) {
      errors.push({
        row: index + 1,
        column: "nhs_number",
        code: "test_nhs_number",
        message: message("test_nhs_number", "This NHS number"),
      });
      delete rowsOut[index]?.nhs_number;
    }
  });
  errors.sort(byRowThenColumn);
  return { ...validation, rows: rowsOut, errors };
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
 * refused. The limits are enforced while reading, so the scan stops at the first cell, row or
 * column too many and never holds more than the limits allow (#150 security review M2). Problems
 * name a row number, never a cell.
 */
export function parseImportCsv(
  text: string,
  limits: ImportLimits = IMPORT_LIMITS,
): ParsedImportFile {
  const source = text.startsWith("﻿") ? text.slice(1) : text;
  let header: string[] | null = null;
  const rows: string[][] = [];
  let record: string[] = [];
  let cell = "";
  let quoted = false;
  let cellWasQuoted = false;
  let recordHasQuote = false;
  let failure: ParsedImportFile | null = null;
  /** The record being read: the header (0) or the next data row. */
  const rowNumber = () => (header === null ? 0 : rows.length + 1);
  const endCell = () => {
    record.push(cell);
    cell = "";
    cellWasQuoted = false;
    const most = header === null ? limits.columns : header.length;
    if (record.length > most) {
      failure = csvFailure(
        header === null ? "too_many_columns" : "too_many_cells",
        rowNumber(),
        limits,
      );
    }
  };
  const endRecord = () => {
    endCell();
    if (failure) return;
    // A blank line (one empty, unquoted cell) is not a row.
    const blank = record.length === 1 && record[0] === "" && !recordHasQuote;
    if (!blank) {
      if (header === null) {
        header = record;
      } else {
        if (rows.length >= limits.rows) {
          failure = csvFailure("too_many_rows", 0, limits);
          return;
        }
        rows.push([...record, ...Array<string>(header.length - record.length).fill("")]);
      }
    }
    record = [];
    recordHasQuote = false;
  };
  let i = 0;
  while (i < source.length && !failure) {
    const char = source[i] as string;
    if (quoted) {
      if (char === '"' && source[i + 1] === '"') {
        cell += '"';
        i += 2;
      } else if (char === '"') {
        quoted = false;
        i += 1;
      } else {
        cell += char;
        i += 1;
      }
    } else if (char === '"' && cell === "" && !cellWasQuoted) {
      quoted = true;
      cellWasQuoted = true;
      recordHasQuote = true;
      i += 1;
    } else if (char === ",") {
      endCell();
      i += 1;
    } else if (char === "\r" || char === "\n") {
      endRecord();
      i += char === "\r" && source[i + 1] === "\n" ? 2 : 1;
    } else {
      cell += char;
      i += 1;
    }
    if (!failure && cell.length > limits.cellCharacters) {
      failure = csvFailure("cell_too_long", rowNumber(), limits);
    }
  }
  if (failure) return failure;
  if (quoted) return csvFailure("unclosed_quote", rowNumber(), limits);
  if (cell !== "" || record.length > 0 || recordHasQuote) endRecord();
  if (failure) return failure;
  if (header === null) return csvFailure("empty", 0, limits);
  return { ok: true, header, rows };
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
    // Own keys only: "constructor" or "__proto__" is no field (#150 security review L4).
    if (mapped !== undefined && !Object.hasOwn(fields, mapped)) {
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
  readonly id: string;
  readonly nhsNumber: string | null;
  readonly localIdentifier: string | null;
  readonly givenName: string;
  readonly familyName: string;
  /** yyyy-mm-dd */
  readonly dateOfBirth: string | null;
}

export type ImportWarningCode = "possible_duplicate";

/** How two people's names agree, with the same date of birth (rule 21). */
export type NameMatch = "same_name" | "names_swapped" | "same_family_name" | "same_given_name";

export interface ImportWarning {
  readonly row: number;
  readonly column: string;
  readonly code: ImportWarningCode;
  readonly match: NameMatch;
  /** The other row of the file it may be the same person as, or null. */
  readonly otherRow: number | null;
  /**
   * The existing record it may be the same person as, or null. The importer can see everyone in
   * the organisation (rule 18), so naming the record tells them nothing they cannot already see.
   */
  readonly personId: string | null;
  /** Identifies this warning, for the acknowledgement (rule 23). */
  readonly key: string;
  readonly message: string;
}

export interface PeopleMatches {
  readonly errors: readonly ImportError[];
  /** At most `IMPORT_WARNING_LIMITS.total`; past it the file is refused instead. */
  readonly warnings: readonly ImportWarning[];
  /** True when a row matched more existing records than are named (`recordsPerRow`). */
  readonly recordMatchesCapped: boolean;
}

/**
 * How many possible duplicates are worked out and shown (#150 security review round 2). Product
 * limits that keep a dry run and a commit bounded, not statutory figures. Each row names at most
 * one other row (the earliest it matches: rows that may be one person form a cluster around their
 * first row) and at most `recordsPerRow` existing records; a file with more than `total` warnings,
 * or more than `sameBirthDate` rows sharing one date of birth (a sign the date column is mapped
 * wrongly or filled with a placeholder), is refused rather than checked pair by pair.
 */
export const IMPORT_WARNING_LIMITS = {
  total: IMPORT_REPORT_MAX_ITEMS,
  recordsPerRow: 3,
  sameBirthDate: 50,
} as const;

const MATCH_WORDS: Readonly<Record<NameMatch, string>> = {
  same_name: "the same name and date of birth",
  names_swapped: "the same date of birth, with the given and family names the other way round",
  same_family_name: "the same family name and date of birth",
  same_given_name: "the same given name and date of birth, perhaps with a changed family name",
};

/** A name for comparing: accents, case, apostrophes, hyphens, spaces and punctuation dropped. */
const letters = (value: string) =>
  value
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z]/g, "");

interface Comparable {
  /** The whole given name, compared as letters ("Mary-Ann", "Mary Ann", "Maryann" alike). */
  readonly given: string;
  /** The first given name alone, so a middle name does not hide a match. */
  readonly firstGiven: string;
  readonly family: string;
}

function comparableName(given: string, family: string): Comparable {
  return {
    given: letters(given),
    firstGiven: letters(given.trim().split(/\s+/)[0] ?? ""),
    family: letters(family),
  };
}

const givenAgrees = (a: Comparable, b: Comparable) =>
  (a.given !== "" && a.given === b.given) || (a.firstGiven !== "" && a.firstGiven === b.firstGiven);

function matchComparable(x: Comparable, y: Comparable): NameMatch | null {
  const sameFamily = x.family !== "" && x.family === y.family;
  if (sameFamily && givenAgrees(x, y)) return "same_name";
  const swapped =
    x.family !== "" &&
    (x.family === y.given || x.family === y.firstGiven) &&
    (y.family === x.given || y.family === x.firstGiven);
  if (swapped) return "names_swapped";
  if (sameFamily) return "same_family_name";
  if (givenAgrees(x, y)) return "same_given_name";
  return null;
}

/** How two names with the same date of birth agree, or null when they do not. */
export function nameMatch(
  a: { readonly given: string; readonly family: string },
  b: { readonly given: string; readonly family: string },
): NameMatch | null {
  return matchComparable(comparableName(a.given, a.family), comparableName(b.given, b.family));
}

/**
 * Matches validated rows against the people already in the organisation (the caller passes only
 * the people the importer can see, which rule 18 makes everyone in the organisation, and never
 * another organisation's). A row whose NHS number or local identifier is already on a record is an
 * error naming the record: an import never updates, merges or attaches to an existing person. A
 * row with the same date of birth as an existing person or an earlier row, and a name that agrees
 * (the same, swapped, the same family name, or the same given name), where either has no NHS
 * number, is a warning naming that record or row; two different NHS numbers are two people. The
 * work and the warnings are bounded (`IMPORT_WARNING_LIMITS`): a file past them is refused.
 */
export function matchExistingPeople(
  validation: ImportValidation,
  existing: readonly ExistingPerson[],
  limits: {
    readonly total: number;
    readonly recordsPerRow: number;
    readonly sameBirthDate: number;
  } = IMPORT_WARNING_LIMITS,
): PeopleMatches {
  const byNhs = new Map(
    existing.flatMap((p) => (p.nhsNumber ? [[p.nhsNumber, p.id] as const] : [])),
  );
  const byLocal = new Map(
    existing.flatMap((p) => (p.localIdentifier ? [[p.localIdentifier, p.id] as const] : [])),
  );
  type Known = { readonly id: string; readonly nhs: string | null; readonly name: Comparable };
  const existingByBirth = new Map<string, Known[]>();
  for (const p of existing) {
    if (!p.dateOfBirth) continue;
    const list = existingByBirth.get(p.dateOfBirth) ?? [];
    list.push({ id: p.id, nhs: p.nhsNumber, name: comparableName(p.givenName, p.familyName) });
    existingByBirth.set(p.dateOfBirth, list);
  }
  const rowsPerBirth = new Map<string, number>();
  for (const stored of validation.rows) {
    if (stored.date_of_birth) {
      rowsPerBirth.set(stored.date_of_birth, (rowsPerBirth.get(stored.date_of_birth) ?? 0) + 1);
    }
  }
  const crowded = new Set(
    [...rowsPerBirth].filter(([, n]) => n > limits.sameBirthDate).map(([birth]) => birth),
  );
  const errors: ImportError[] = [];
  if (crowded.size > 0) {
    errors.push({
      row: 0,
      column: "date_of_birth",
      code: "too_many_same_birth_date",
      message: message("too_many_same_birth_date", String(limits.sameBirthDate)),
    });
  }
  const warnings: ImportWarning[] = [];
  let tooMany = false;
  let recordMatchesCapped = false;
  const warn = (row: number, match: NameMatch, other: { row: number } | { personId: string }) => {
    if (warnings.length >= limits.total) {
      tooMany = true;
      return;
    }
    const otherRow = "row" in other ? other.row : null;
    const personId = "personId" in other ? other.personId : null;
    warnings.push({
      row,
      column: "date_of_birth",
      code: "possible_duplicate",
      match,
      otherRow,
      personId,
      key: `${row}:${match}:${otherRow !== null ? `row-${otherRow}` : `person-${personId}`}`,
      message:
        otherRow !== null
          ? `This row and row ${otherRow} have ${MATCH_WORDS[match]}, and one of them has no NHS number. Check they are not the same person.`
          : `Someone already in Harbour has ${MATCH_WORDS[match]}, and one of them has no NHS number. Open that record and check it is not the same person.`,
    });
  };
  const rowsByBirth = new Map<string, { row: number; nhs: string | null; name: Comparable }[]>();
  validation.rows.forEach((stored, index) => {
    const row = index + 1;
    const nhsHolder = stored.nhs_number ? byNhs.get(stored.nhs_number) : undefined;
    if (nhsHolder) {
      errors.push({
        row,
        column: "nhs_number",
        code: "already_in_harbour",
        message: message("already_in_harbour", "This NHS number"),
        personId: nhsHolder,
      });
    }
    const localHolder = stored.local_identifier ? byLocal.get(stored.local_identifier) : undefined;
    if (localHolder) {
      errors.push({
        row,
        column: "local_identifier",
        code: "already_in_harbour",
        message: message("already_in_harbour", "This local identifier"),
        personId: localHolder,
      });
    }
    const birth = stored.date_of_birth;
    if (tooMany || !birth || crowded.has(birth) || !stored.given_name || !stored.family_name) {
      return;
    }
    const name = comparableName(stored.given_name, stored.family_name);
    const mine = stored.nhs_number ?? null;
    let named = 0;
    for (const p of existingByBirth.get(birth) ?? []) {
      // Two NHS numbers: the same is an error above; different ones are two people.
      if (mine !== null && p.nhs !== null) continue;
      const match = matchComparable(name, p.name);
      if (!match) continue;
      if (named >= limits.recordsPerRow) {
        recordMatchesCapped = true;
        break;
      }
      warn(row, match, { personId: p.id });
      named += 1;
    }
    // The earliest row this one may be: rows that may be one person cluster around their first.
    const earlierRows = rowsByBirth.get(birth) ?? [];
    for (const earlier of earlierRows) {
      if (mine !== null && earlier.nhs !== null) continue;
      const match = matchComparable(name, earlier.name);
      if (!match) continue;
      warn(row, match, { row: earlier.row });
      break;
    }
    earlierRows.push({ row, nhs: mine, name });
    rowsByBirth.set(birth, earlierRows);
  });
  if (tooMany) {
    errors.push({
      row: 0,
      column: "date_of_birth",
      code: "too_many_possible_duplicates",
      message: message("too_many_possible_duplicates", String(limits.total)),
    });
  }
  errors.sort(byRowThenColumn);
  warnings.sort((a, b) => a.row - b.row || a.key.localeCompare(b.key));
  return { errors, warnings, recordMatchesCapped };
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

/** A people import's dry run (rule 22): the report, its findings by row, and what will happen. */
export interface PeopleDryRun extends DryRunReport {
  readonly warningCount: number;
  /**
   * True when there are no errors but possible duplicates still need acknowledging: `mayCommit`
   * stays false until the commit lists every warning's key (#150 clinical M3).
   */
  readonly needsAcknowledgement: boolean;
  /** The first `IMPORT_REPORT_MAX_ITEMS` errors, and every warning (never more than the limit). */
  readonly errors: readonly ImportError[];
  readonly warnings: readonly ImportWarning[];
  /**
   * The keys of exactly the warnings listed: what the commit's acknowledgement must list. Warnings
   * are never cut off (a file with more is refused), so nobody acknowledges one they never saw.
   */
  readonly warningKeys: readonly string[];
  /** True when more errors were found than are listed (the counts by code cover them all). */
  readonly truncated: boolean;
  /** True when a row matched more existing records than its warnings name. */
  readonly recordMatchesCapped: boolean;
  /**
   * HZ-007: every person's allergy status is imported as unknown ("not recorded") whatever the
   * file says, until a member of staff checks it on the record. These say what the file stated,
   * so the ones it claimed are checked first.
   */
  readonly allergyStatusNotStatedRows: readonly number[];
  readonly noKnownAllergiesStatedRows: readonly number[];
  readonly hasAllergiesStatedRows: readonly number[];
  /**
   * Phones are in use in the organisation (a sync token carrying people within the offline
   * window), so a commit cannot be undone and must be accepted as such (#150 clinical M-B).
   */
  readonly phonesInUse: boolean;
  /** What committing does, in plain words (#150 clinical M3). */
  readonly whatHappens: readonly string[];
}

/** The plain words a dry run says about what committing will do (rule 22; HZ-007, HZ-001). */
export function importOutcomeWords(report: {
  readonly validRows: number;
  readonly errorCount: number;
  readonly warningCount: number;
  readonly noKnownAllergiesStatedRows: readonly number[];
  readonly hasAllergiesStatedRows: readonly number[];
  readonly phonesInUse: boolean;
  readonly recordMatchesCapped?: boolean;
}): string[] {
  const people = (n: number) => (n === 1 ? "1 person" : `${n} people`);
  const words: string[] = [];
  if (report.errorCount > 0) {
    words.push(
      `Nothing can be committed until every error is corrected (${report.errorCount} found). Correct the file and upload it again.`,
    );
  }
  words.push(
    `Committing creates ${people(report.validRows)} at the chosen home as current residents. Nobody already in Harbour is changed.`,
    "They appear for staff at once: on the web straight away, and on phones at their next sync.",
    report.phonesInUse
      ? "Phones are in use in this organisation, so treat this import as one that cannot be undone once it is committed: phones can receive the people within minutes, and then it cannot be undone. A person imported by mistake can then only have their details corrected on their record: they cannot be removed. Confirm you accept this before committing."
      : "It can be undone until a phone may have received the people, and within the undo window; after that a person imported by mistake can only have their details corrected on their record.",
    `Every person's allergy status is imported as not recorded, whatever the file says, until a member of staff checks it and records it on the person's record. The file said no known allergies for ${people(report.noKnownAllergiesStatedRows.length)} and that ${people(report.hasAllergiesStatedRows.length)} ${report.hasAllergiesStatedRows.length === 1 ? "has" : "have"} allergies: each gets a task to check it.`,
    "Allergies themselves are not imported. Record each allergy on the person's record.",
    "Imported people have no photo, room or placement. Add them before staff rely on the record at the point of care.",
  );
  if (report.warningCount > 0) {
    words.push(
      `Check each possible duplicate (${report.warningCount}) and confirm you have checked them before committing.`,
    );
  }
  if (report.recordMatchesCapped) {
    words.push(
      "Some rows match more people already in Harbour than are listed: check everyone with that date of birth.",
    );
  }
  return words;
}

/** Options for a people import's checks. */
export interface PeopleImportOptions {
  /** Today's UK date, yyyy-mm-dd. */
  readonly today: string;
  /**
   * Whether 999-range test NHS numbers and 0000000000 are taken: in demonstration and test
   * environments only, never for a real organisation's records (#150 clinical L).
   */
  readonly allowTestNhsNumbers: boolean;
  /** Phones are in use in the organisation (see `PeopleDryRun.phonesInUse`); false if omitted. */
  readonly phonesInUse?: boolean;
}

/** Validation and matching together: what the dry run reports and the commit checks again. */
export function peopleDryRun(
  rows: readonly Readonly<Record<string, string>>[],
  existing: readonly ExistingPerson[],
  options: PeopleImportOptions,
): { readonly validation: ImportValidation; readonly report: PeopleDryRun } {
  const checked = validatePersonImport(rows, options);
  const matches = matchExistingPeople(checked, existing);
  const validation: ImportValidation = {
    ...checked,
    errors: [...checked.errors, ...matches.errors].sort(byRowThenColumn),
  };
  const stated = (status: string) =>
    validation.rows.flatMap((r, i) => ((r.allergy_status ?? "unknown") === status ? [i + 1] : []));
  const base = dryRunReport(validation);
  const phonesInUse = options.phonesInUse ?? false;
  const counts = {
    validRows: base.validRows,
    errorCount: base.errorCount,
    warningCount: matches.warnings.length,
    noKnownAllergiesStatedRows: stated("no_known_allergies"),
    hasAllergiesStatedRows: stated("has_allergies"),
    phonesInUse,
    recordMatchesCapped: matches.recordMatchesCapped,
  };
  return {
    validation,
    report: {
      ...base,
      mayCommit: base.mayCommit && matches.warnings.length === 0,
      needsAcknowledgement: base.mayCommit && matches.warnings.length > 0,
      warningCount: matches.warnings.length,
      errors: validation.errors.slice(0, IMPORT_REPORT_MAX_ITEMS),
      warnings: matches.warnings,
      warningKeys: matches.warnings.map((w) => w.key),
      truncated: validation.errors.length > IMPORT_REPORT_MAX_ITEMS,
      recordMatchesCapped: matches.recordMatchesCapped,
      allergyStatusNotStatedRows: stated("unknown"),
      noKnownAllergiesStatedRows: counts.noKnownAllergiesStatedRows,
      hasAllergiesStatedRows: counts.hasAllergiesStatedRows,
      phonesInUse,
      whatHappens: importOutcomeWords(counts),
    },
  };
}

export type CommitProblem =
  | "not_staged"
  | "expired"
  | "dry_run_first"
  | "empty"
  | "has_errors"
  | "possible_duplicates_unacknowledged"
  | "no_undo_not_accepted";

const COMMIT_MESSAGES: Readonly<Record<CommitProblem, string>> = {
  not_staged: "This import can no longer be committed: it was committed, discarded or expired.",
  expired:
    "The time to commit this import has passed and its rows are being deleted. Upload the file again.",
  dry_run_first: "Run the dry run and read its report before committing.",
  empty: "The file has no rows to import.",
  has_errors:
    "Correct every error in the file first: nothing is imported until all rows are valid.",
  possible_duplicates_unacknowledged:
    "Some rows may be people already in Harbour or each other. Check each one the dry run lists, then confirm exactly those before committing. Run the dry run again if anything has changed.",
  no_undo_not_accepted:
    "Phones are in use in this organisation, so this import cannot be undone once committed. Confirm you accept that before committing.",
};

/**
 * Whether a batch may commit now (rules 13, 21 and 23): staged and not past its expiry, with a dry
 * run behind it, every row valid when checked again, the acknowledgement listing exactly the
 * possible duplicates found now (one more, one fewer or a different one is refused, so nobody
 * confirms warnings they never saw; #150 clinical M2, security L3), and, where phones are in use
 * so that the import cannot be undone, the importer's acceptance of that (#150 clinical M-B).
 */
export function checkPeopleCommit(input: {
  readonly status: ImportBatchStatus;
  readonly expiresAt: Date;
  readonly now: Date;
  readonly dryRunAt: Date | null;
  readonly report: PeopleDryRun;
  readonly acknowledgedWarnings: readonly string[];
  /** The importer accepts that the import cannot be undone (needed while phones are in use). */
  readonly acceptNoUndo?: boolean;
}):
  | { readonly ok: true }
  | { readonly ok: false; readonly problem: CommitProblem; readonly message: string } {
  const refuse = (problem: CommitProblem) =>
    ({ ok: false, problem, message: COMMIT_MESSAGES[problem] }) as const;
  if (input.status !== "staged") return refuse("not_staged");
  if (input.now.getTime() >= input.expiresAt.getTime()) return refuse("expired");
  if (!input.dryRunAt) return refuse("dry_run_first");
  if (input.report.rows === 0) return refuse("empty");
  if (input.report.errorCount > 0) return refuse("has_errors");
  const found = new Set(input.report.warningKeys);
  const acknowledged = new Set(input.acknowledgedWarnings);
  const same =
    found.size === acknowledged.size &&
    input.acknowledgedWarnings.length === acknowledged.size &&
    [...found].every((key) => acknowledged.has(key));
  if (!same) return refuse("possible_duplicates_unacknowledged");
  if (input.report.phonesInUse && !input.acceptNoUndo) return refuse("no_undo_not_accepted");
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
  /**
   * A phone may hold the imported people (a sync token for people was issued in the organisation
   * from a token's lifetime before the commit): it may have recorded care for them offline, which
   * an undo would strand (#150 clinical H2). Omitted is taken as false.
   */
  readonly sentToDevices?: boolean;
}

export type UndoProblem =
  | "already_undone"
  | "window_passed"
  | "sent_to_devices"
  | "changed_since"
  | "referenced_since";

export const UNDO_MESSAGES: Readonly<Record<UndoProblem, string>> = {
  already_undone: "This import has already been undone.",
  window_passed: "The time to undo this import has passed. Correct records one by one.",
  sent_to_devices:
    "People from this import may already be on staff phones, which can record care for them without a signal. Correct records one by one.",
  changed_since: "Records from this import have been changed since. Correct records one by one.",
  referenced_since:
    "Records have been made about people from this import since. Correct records one by one.",
};

/**
 * Whether a batch may be undone (rules 14 and 24): once, within the window, before any phone may
 * hold its people, with nothing changed or made about them since.
 */
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
  if (batch.sentToDevices) return refuse("sent_to_devices");
  if (batch.changedSinceCommit) return refuse("changed_since");
  if (batch.referencedSinceCommit) return refuse("referenced_since");
  return { ok: true };
}
