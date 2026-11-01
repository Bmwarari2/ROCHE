import type { PcspDomain } from "../care/care-plan";
import { isDmdId } from "../medicines/dmd";
import type { MarEntryDraft, MarSourceKind } from "../medicines/mar-entry";
import { ukStartOfDay } from "../shared/time";
import type {
  ComplianceDetail,
  IdentityDocument,
  RightToWorkMethod,
} from "../workforce/staff-file";
import {
  CARE_PLAN_IMPORT_FIELDS,
  dryRunReport,
  IMPORT_REPORT_MAX_ITEMS,
  type ImportError,
  type ImportErrorCode,
  type ImportRecordType,
  type ImportValidation,
  importErrorMessage,
  MEDICINE_IMPORT_FIELDS,
  type PeopleDryRun,
  STAFF_FILE_IMPORT_FIELDS,
  validateImportRows,
} from "./imports";

/**
 * Importing medicines, care plans and staff files (platform.md rules 27 to 31; PLAT-014,
 * WORK-013; plan slice 51). Every row names its person by NHS number, or its member of staff by
 * work email, never by name, and is refused when no one has it (HZ-130). What a row creates is
 * never in use until a person acts on it:
 *
 * - a medicine arrives not yet checked and is not on a round until a second person competent in
 *   medicines checks it against its source (H-548; medicines.md rule 4, HZ-005);
 * - a care plan arrives as a draft for a person to review and publish (HZ-024);
 * - a staff file check arrives unverified until someone verifies it on the staff file (HZ-124).
 *
 * The dry run reports every row's outcome; a batch commits whole or not at all, and is undone
 * within the window only while nothing it created has been checked, published or verified.
 */

export type ClinicalRecordType = Exclude<ImportRecordType, "people">;

export interface ClinicalImportOptions {
  /** Today's UK date, yyyy-mm-dd. */
  readonly today: string;
  /** 999-range NHS numbers are taken in demonstration and test environments only. */
  readonly allowTestNhsNumbers: boolean;
}

const sortErrors = (a: ImportError, b: ImportError) =>
  a.row - b.row || a.column.localeCompare(b.column) || a.code.localeCompare(b.code);

const err = (row: number, column: string, code: ImportErrorCode, label: string): ImportError => ({
  row,
  column,
  code,
  message: importErrorMessage(code, label),
});

/** A 999-range or all-zero NHS number, refused outside test environments (as for people). */
function testNumberErrors(
  validation: ImportValidation,
  options: ClinicalImportOptions,
): ImportError[] {
  if (options.allowTestNhsNumbers) return [];
  return validation.rows.flatMap((r, i) => {
    const nhs = r.person_nhs_number;
    return nhs && (nhs.startsWith("999") || nhs === "0000000000")
      ? [err(i + 1, "person_nhs_number", "test_nhs_number", "This NHS number")]
      : [];
  });
}

// ------------------------------------------------------------------------------------------------
// Medicines (rule 28)
// ------------------------------------------------------------------------------------------------

const TIME = /^([01]\d|2[0-3]):[0-5]\d$/;
const DOSE = /^(?:0|[1-9]\d{0,6})(?:\.\d{1,3})?$/;

/** The prescribed times in a cell ("08:00 20:00", or with commas or semicolons), or null. */
export function importTimes(cell: string | undefined): string[] | null {
  const parts = (cell ?? "")
    .split(/[\s,;]+/)
    .map((t) => t.trim())
    .filter(Boolean);
  if (parts.length === 0 || parts.some((t) => !TIME.test(t))) return null;
  if (new Set(parts).size !== parts.length) return null;
  return [...parts].sort();
}

/**
 * The field rules, then what a medicine needs (rule 28): dm+d codes of the right shape with a
 * valid check digit; a dose above zero with at most three decimals; a regular medicine's times,
 * each once; a when-required medicine's indication and no times; a stop on or after the start.
 * The dm+d product itself, its route and its units are checked against the reference data by
 * the dry run (`medicineRowDraft` then the medicines rules).
 */
export function validateMedicineImport(
  rows: readonly Readonly<Record<string, string>>[],
  options: ClinicalImportOptions,
): ImportValidation {
  const validation = validateImportRows(rows, MEDICINE_IMPORT_FIELDS, { today: options.today });
  const errors = [...validation.errors, ...testNumberErrors(validation, options)];
  validation.rows.forEach((r, i) => {
    const row = i + 1;
    const raw = rows[i] ?? {};
    for (const column of ["vmp_id", "amp_id"] as const) {
      const code = r[column];
      if (code && !isDmdId(code)) {
        errors.push(
          err(row, column, "invalid_dmd_code", MEDICINE_IMPORT_FIELDS[column]?.label ?? column),
        );
      }
    }
    if (r.dose_quantity && (!DOSE.test(r.dose_quantity) || Number(r.dose_quantity) <= 0)) {
      errors.push(err(row, "dose_quantity", "invalid_dose", "Dose"));
    }
    const timesBlank = (raw.times ?? "").trim() === "";
    if (r.directions === "regular") {
      if (timesBlank) errors.push(err(row, "times", "times_required", "Times"));
      else if (!importTimes(raw.times)) errors.push(err(row, "times", "invalid_times", "Times"));
    }
    if (r.directions === "when_required") {
      if (!timesBlank) errors.push(err(row, "times", "times_not_taken", "Times"));
      if (!r.indication) errors.push(err(row, "indication", "indication_required", "Indication"));
    }
    if (r.stops_on && r.starts_on && r.stops_on < r.starts_on) {
      errors.push(err(row, "stops_on", "stops_before_start", "Stop date"));
    }
  });
  errors.sort(sortErrors);
  return { ...validation, errors };
}

/**
 * A valid medicine row as a MAR entry draft for `personId`, with dm+d's name and units filled in
 * by the caller from the reference data (`dmd`): the product's name is never the file's. The
 * entry starts at the start of its start date (UK time) and stops at the start of its stop date.
 */
export function medicineRowDraft(
  row: Readonly<Record<string, string>>,
  personId: string,
  dmd: {
    readonly name: string;
    readonly routeName: string;
    readonly unitName: string;
  },
): MarEntryDraft {
  const unit = { code: row.dose_unit_code ?? "", name: dmd.unitName };
  const dose = { kind: "amount" as const, quantity: Number(row.dose_quantity), unit };
  return {
    personId,
    product: { vmpId: row.vmp_id ?? "", ampId: row.amp_id ?? null, name: dmd.name },
    route: { code: row.route_code ?? "", name: dmd.routeName },
    directions:
      row.directions === "when_required"
        ? { kind: "when_required", dose }
        : {
            kind: "regular",
            schedule: {
              pattern: { kind: "every_day" },
              times: (importTimes(row.times) ?? []).map((time) => ({ time, dose })),
            },
          },
    indication: row.indication ?? null,
    specialInstructions: row.special_instructions ?? null,
    prescriber: row.prescriber ?? "",
    startsAt: ukStartOfDay(row.starts_on ?? ""),
    stopsAt: row.stops_on ? ukStartOfDay(row.stops_on) : null,
    reviewOn: null,
    source: {
      kind: (row.source_kind ?? "prescription") as MarSourceKind,
      reference: row.source_reference ?? "",
      documentId: null,
    },
  };
}

// ------------------------------------------------------------------------------------------------
// Care plans (rule 29)
// ------------------------------------------------------------------------------------------------

/** The field rules, and each person's domain on one row only. */
export function validateCarePlanImport(
  rows: readonly Readonly<Record<string, string>>[],
  options: ClinicalImportOptions,
): ImportValidation {
  const validation = validateImportRows(rows, CARE_PLAN_IMPORT_FIELDS, { today: options.today });
  const errors = [...validation.errors, ...testNumberErrors(validation, options)];
  const seen = new Map<string, number[]>();
  validation.rows.forEach((r, i) => {
    if (!r.person_nhs_number || !r.domain) return;
    const key = `${r.person_nhs_number}:${r.domain}`;
    seen.set(key, [...(seen.get(key) ?? []), i + 1]);
  });
  for (const rowsWithKey of seen.values()) {
    if (rowsWithKey.length < 2) continue;
    for (const row of rowsWithKey) errors.push(err(row, "domain", "duplicate", "Domain"));
  }
  errors.sort(sortErrors);
  return { ...validation, errors };
}

export interface CarePlanImportDraft {
  readonly nhsNumber: string;
  /** The 1-based rows the plan comes from. */
  readonly rows: readonly number[];
  readonly sections: readonly {
    readonly domain: PcspDomain;
    readonly need: string;
    readonly outcome: string;
    readonly strengths: string | null;
    readonly contingency: string | null;
  }[];
}

/** One draft plan per person, with a section for each of their rows, in file order. */
export function carePlanDrafts(
  rows: readonly Readonly<Record<string, string>>[],
): CarePlanImportDraft[] {
  const plans = new Map<
    string,
    { rows: number[]; sections: CarePlanImportDraft["sections"][number][] }
  >();
  rows.forEach((r, i) => {
    const nhs = r.person_nhs_number ?? "";
    const plan = plans.get(nhs) ?? { rows: [], sections: [] };
    plan.rows.push(i + 1);
    plan.sections.push({
      domain: r.domain as PcspDomain,
      need: r.need ?? "",
      outcome: r.outcome ?? "",
      strengths: r.strengths ?? null,
      contingency: r.contingency ?? null,
    });
    plans.set(nhs, plan);
  });
  return [...plans].map(([nhsNumber, p]) => ({ nhsNumber, rows: p.rows, sections: p.sections }));
}

// ------------------------------------------------------------------------------------------------
// Staff files (rule 30)
// ------------------------------------------------------------------------------------------------

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/** The columns each check reads; the required ones first. Every other detail column stays blank. */
const STAFF_DETAIL_COLUMNS: Readonly<
  Record<string, { readonly required: readonly string[]; readonly optional: readonly string[] }>
> = {
  identity_with_photo: { required: ["identity_document"], optional: [] },
  dbs_certificate: {
    required: [],
    optional: [
      "dbs_level",
      "dbs_issued_on",
      "dbs_certificate_number",
      "dbs_result",
      "dbs_update_service",
      "barred_list_clear_on",
    ],
  },
  right_to_work: {
    required: ["right_to_work_method", "right_to_work_checked_on", "right_to_work_permission"],
    optional: ["right_to_work_expires_on"],
  },
  professional_registration: {
    required: ["registration_body", "registration_pin", "registration_renewal_due_on"],
    optional: ["revalidation_due_on"],
  },
  references: { required: ["references_received"], optional: [] },
  relevant_qualifications: { required: ["qualifications"], optional: [] },
};

const DETAIL_COLUMNS = Object.keys(STAFF_FILE_IMPORT_FIELDS).filter(
  (c) => c !== "member_email" && c !== "kind",
);
const CERTIFICATE_COLUMNS = ["dbs_level", "dbs_issued_on", "dbs_certificate_number", "dbs_result"];

/**
 * The field rules, then what each check needs (rule 30): an email address; the check's own
 * columns filled and every other detail column blank; a DBS certificate with its level, issue
 * date, 12-digit number and result together or not at all, and an Update Service answer only with
 * a certificate; a time-limited right to work with its expiry; whole numbers of references; each
 * member's check on one row only.
 */
export function validateStaffFileImport(
  rows: readonly Readonly<Record<string, string>>[],
  options: Pick<ClinicalImportOptions, "today">,
): ImportValidation {
  const validation = validateImportRows(rows, STAFF_FILE_IMPORT_FIELDS, { today: options.today });
  const errors = [...validation.errors];
  const label = (c: string) => STAFF_FILE_IMPORT_FIELDS[c]?.label ?? c;
  const seen = new Map<string, number[]>();
  validation.rows.forEach((r, i) => {
    const row = i + 1;
    if (r.member_email && !EMAIL.test(r.member_email)) {
      errors.push(err(row, "member_email", "invalid_email", label("member_email")));
    }
    const columns = r.kind ? STAFF_DETAIL_COLUMNS[r.kind] : undefined;
    if (!columns) return;
    if (r.member_email) {
      const key = `${r.member_email.toLowerCase()}:${r.kind}`;
      seen.set(key, [...(seen.get(key) ?? []), row]);
    }
    for (const c of columns.required) {
      if (!r[c] && !errors.some((e) => e.row === row && e.column === c)) {
        errors.push(err(row, c, "detail_required", label(c)));
      }
    }
    for (const c of DETAIL_COLUMNS) {
      if (!columns.required.includes(c) && !columns.optional.includes(c) && r[c]) {
        errors.push(err(row, c, "detail_not_for_check", label(c)));
      }
    }
    if (r.kind === "dbs_certificate") {
      const given = CERTIFICATE_COLUMNS.filter((c) => r[c]);
      if (given.length > 0 && given.length < CERTIFICATE_COLUMNS.length) {
        for (const c of CERTIFICATE_COLUMNS.filter(
          (x) => !r[x] && !errors.some((e) => e.row === row && e.column === x),
        )) {
          errors.push(err(row, c, "detail_required", label(c)));
        }
      }
      if (r.dbs_certificate_number && !/^\d{12}$/.test(r.dbs_certificate_number)) {
        errors.push(
          err(row, "dbs_certificate_number", "invalid_number", label("dbs_certificate_number")),
        );
      }
      if (r.dbs_update_service && given.length === 0) {
        errors.push(
          err(row, "dbs_update_service", "detail_not_for_check", label("dbs_update_service")),
        );
      }
    }
    if (
      r.kind === "right_to_work" &&
      r.right_to_work_permission === "time_limited" &&
      !r.right_to_work_expires_on
    ) {
      errors.push(
        err(row, "right_to_work_expires_on", "detail_required", label("right_to_work_expires_on")),
      );
    }
    if (
      r.kind === "references" &&
      r.references_received &&
      !/^\d{1,2}$/.test(r.references_received)
    ) {
      errors.push(err(row, "references_received", "invalid_number", label("references_received")));
    }
  });
  for (const rowsWithKey of seen.values()) {
    if (rowsWithKey.length < 2) continue;
    for (const row of rowsWithKey) errors.push(err(row, "kind", "duplicate", "Check"));
  }
  errors.sort(sortErrors);
  return { ...validation, errors };
}

/** A valid staff file row's check, as the staff file stores it (never verified by the import). */
export function staffFileRowDetail(row: Readonly<Record<string, string>>): ComplianceDetail {
  switch (row.kind) {
    case "identity_with_photo":
      return { kind: "identity_with_photo", document: row.identity_document as IdentityDocument };
    case "dbs_certificate":
      return {
        kind: "dbs_certificate",
        certificate: row.dbs_level
          ? {
              level: row.dbs_level as "enhanced_adults_barred",
              issuedOn: row.dbs_issued_on ?? "",
              number: row.dbs_certificate_number ?? "",
              result: row.dbs_result as "clear" | "information_disclosed",
            }
          : null,
        updateService: row.dbs_update_service
          ? { subscribed: row.dbs_update_service === "yes", lastCheckedOn: null, lastResult: null }
          : null,
        barredListClearOn: row.barred_list_clear_on ?? null,
      };
    case "right_to_work":
      return {
        kind: "right_to_work",
        checks: [
          {
            method: row.right_to_work_method as RightToWorkMethod,
            checkedOn: row.right_to_work_checked_on ?? "",
            permission: row.right_to_work_permission as "unlimited" | "time_limited",
            expiresOn: row.right_to_work_expires_on ?? null,
          },
        ],
      };
    case "professional_registration":
      return {
        kind: "professional_registration",
        body: row.registration_body as "nmc",
        pin: (row.registration_pin ?? "").toUpperCase(),
        renewalDueOn: row.registration_renewal_due_on ?? "",
        revalidationDueOn: row.revalidation_due_on ?? null,
      };
    case "references":
      return { kind: "references", received: Number(row.references_received) };
    default:
      return {
        kind: "relevant_qualifications",
        qualifications: (row.qualifications ?? "")
          .split(";")
          .map((q) => q.trim())
          .filter(Boolean),
      };
  }
}

// ------------------------------------------------------------------------------------------------
// The dry run (rule 31)
// ------------------------------------------------------------------------------------------------

/** What one row will do. */
export interface ImportRowOutcome {
  readonly row: number;
  readonly outcome: "creates" | "refused";
}

/** A medicines, care plans or staff files dry run: the people report's shape, with every row. */
export interface ClinicalDryRun extends PeopleDryRun {
  readonly recordType: ClinicalRecordType;
  /** Every row's outcome, in file order (rule 31). */
  readonly rowOutcomes: readonly ImportRowOutcome[];
  /** How many records committing creates: medicines, draft plans or checks. */
  readonly createsCount: number;
}

const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

/** The plain words a dry run says about what committing does (rules 28 to 31). */
export function clinicalOutcomeWords(
  recordType: ClinicalRecordType,
  report: { readonly errorCount: number; readonly createsCount: number },
): string[] {
  const words: string[] = [];
  if (report.errorCount > 0) {
    words.push(
      `Nothing can be committed until every error is corrected (${report.errorCount} found). Correct the file and upload it again.`,
    );
  }
  switch (recordType) {
    case "medicines":
      words.push(
        `Committing adds ${plural(report.createsCount, "medicine", "medicines")} to people's MAR as "Imported, not yet checked", with dm+d's own names.`,
        "None is given or on a round until a second person competent in medicines checks it against its source document. Plan who checks them before the first round.",
        "It can be undone within the undo window while none of them has been checked.",
      );
      break;
    case "care_plans":
      words.push(
        `Committing creates ${plural(report.createsCount, "draft care plan", "draft care plans")}. Staff do not follow a draft: a person reviews each one, adds anything missing and publishes it.`,
        "It can be undone within the undo window while every draft is unchanged and unpublished.",
      );
      break;
    case "staff_files":
      words.push(
        `Committing adds ${plural(report.createsCount, "check", "checks")} to staff files, each unverified. A check counts only once someone who has seen the evidence verifies it on the staff file.`,
        "It can be undone within the undo window while none of them has been verified or changed.",
      );
      break;
  }
  return words;
}

/**
 * The dry run of a medicines, care plans or staff files batch: the field and type rules
 * (`validation`), then what only the records can say (`recordErrors`: no such person or staff
 * file, a product dm+d does not hold, a medicine the medicines rules refuse, a draft or check that
 * already exists). Every row's outcome is listed; there are no warnings to acknowledge, because a
 * row is matched by identifier only and never by a guess.
 */
export function clinicalDryRun(
  recordType: ClinicalRecordType,
  validation: ImportValidation,
  recordErrors: readonly ImportError[],
  createsCount: number,
): { readonly validation: ImportValidation; readonly report: ClinicalDryRun } {
  const all: ImportValidation = {
    ...validation,
    errors: [...validation.errors, ...recordErrors].sort(sortErrors),
  };
  const base = dryRunReport(all);
  const refused = new Set(all.errors.map((e) => e.row));
  const fileRefused = refused.has(0);
  const creates = base.errorCount === 0 ? createsCount : 0;
  return {
    validation: all,
    report: {
      ...base,
      recordType,
      warningCount: 0,
      needsAcknowledgement: false,
      errors: all.errors.slice(0, IMPORT_REPORT_MAX_ITEMS),
      warnings: [],
      warningKeys: [],
      truncated: all.errors.length > IMPORT_REPORT_MAX_ITEMS,
      recordMatchesCapped: false,
      allergyStatusNotStatedRows: [],
      noKnownAllergiesStatedRows: [],
      hasAllergiesStatedRows: [],
      phonesInUse: false,
      rowOutcomes: Array.from({ length: validation.rowCount }, (_, i) => ({
        row: i + 1,
        outcome: fileRefused || refused.has(i + 1) ? ("refused" as const) : ("creates" as const),
      })),
      createsCount: creates,
      whatHappens: clinicalOutcomeWords(recordType, {
        errorCount: base.errorCount,
        createsCount: creates,
      }),
    },
  };
}

/** The per-type validation, so the API calls one function for any clinical type. */
export function validateClinicalImport(
  recordType: ClinicalRecordType,
  rows: readonly Readonly<Record<string, string>>[],
  options: ClinicalImportOptions,
): ImportValidation {
  switch (recordType) {
    case "medicines":
      return validateMedicineImport(rows, options);
    case "care_plans":
      return validateCarePlanImport(rows, options);
    case "staff_files":
      return validateStaffFileImport(rows, options);
  }
}

/** A record-level error for a row (the API's checks against the records). */
export function importRowError(
  row: number,
  column: string,
  code: ImportErrorCode,
  label: string,
): ImportError {
  return err(row, column, code, label);
}
