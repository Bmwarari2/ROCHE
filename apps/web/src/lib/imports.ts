import type { ImportBatch, ImportDryRunReport, ImportFinding } from "@harbour/contracts";
import {
  IMPORT_FIELDS,
  type ImportRecordType,
  mapImportColumns,
  parseImportCsv,
} from "@harbour/domain";
import type { Translator } from "@harbour/i18n";
import type { SafetyChip } from "./incidents";

/**
 * The import wizard's screens (PLAT-014; platform.md rules 18 to 26; ADR-0092; HZ-130). Pure and
 * unit tested. The file is read in the browser only to show its column headings for mapping; the
 * API checks every cell again and never sends a value back. Every state is the API's; the page
 * says it with an icon and a word, and a state it does not know warns rather than reading as calm.
 */

export const IMPORT_PAGE = "/settings/import";
export const IMPORT_UPLOAD_PATH = "/api/imports/upload";
export const importPage = (id: string) => `${IMPORT_PAGE}/${id}`;

/** The permissions the API needs, all across the organisation (rule 18). */
export const IMPORT_PERMISSIONS = [
  "platform.import.run",
  "people.person.create",
  "people.person.read",
] as const;

export function importShown(permissions: readonly string[]): boolean {
  return IMPORT_PERMISSIONS.every((p) => permissions.includes(p));
}

/** A field a column can be matched to, or "" to leave the column out. */
export const LEAVE_OUT = "";

export interface ImportFieldOption {
  readonly key: string;
  readonly label: string;
  readonly required: boolean;
}

export function importFieldOptions(recordType: ImportRecordType): ImportFieldOption[] {
  return Object.entries(IMPORT_FIELDS[recordType]).map(([key, field]) => ({
    key,
    label: field.label,
    required: field.required,
  }));
}

/** How many of the file's first rows the mapping shows beside each column (HZ-130). */
export const PREVIEW_ROWS = 3;

export type ReadHeader =
  | {
      readonly ok: true;
      readonly header: readonly string[];
      readonly rows: number;
      /** The first rows' cells, by column: shown in the browser only, never sent anywhere else. */
      readonly preview: readonly (readonly string[])[];
    }
  | { readonly ok: false; readonly message: string };

/**
 * The file's headings, row count and first rows, read as the API will read it; a problem names a
 * row only. The first rows are for the importer to check each column's field against what the
 * column holds before the dry run (HZ-130: a date read month first, names swapped).
 */
export function readImportHeader(text: string): ReadHeader {
  const parsed = parseImportCsv(text);
  if (!parsed.ok) return { ok: false, message: parsed.message };
  const first = parsed.rows.slice(0, PREVIEW_ROWS);
  return {
    ok: true,
    header: parsed.header,
    rows: parsed.rows.length,
    preview: parsed.header.map((_, column) => first.map((row) => row[column] ?? "")),
  };
}

/** A column's first rows in words: "First rows: 14/03/1938, 02/09/1941, (blank)". */
export function previewWords(cells: readonly string[], t: Translator): string {
  if (cells.length === 0) return t("import.mapping.noRows");
  const shown = cells.map((c) => (c.trim() === "" ? t("import.mapping.blank") : c.trim()));
  return t("import.mapping.preview", { values: shown.join(", ") });
}

/**
 * The field each column matches on its own (its heading is a field's key or label), as a first
 * suggestion the person changes; a column that matches nothing, or a second column for the same
 * field, starts as left out so the person chooses.
 */
export function suggestMapping(header: readonly string[], recordType: ImportRecordType): string[] {
  const fields = IMPORT_FIELDS[recordType];
  const taken = new Set<string>();
  return header.map((heading) => {
    const mapped = mapImportColumns([heading], fields);
    const field = mapped.ok ? mapped.fields[0] : null;
    if (!field || taken.has(field)) return LEAVE_OUT;
    taken.add(field);
    return field;
  });
}

export interface MappingCheck {
  /** The mapping the API takes: each heading to its field, or null to leave it out. */
  readonly mapping: Record<string, string | null>;
  /** Problems by column (1-based), in words naming the column number and field, never a heading. */
  readonly problems: readonly { readonly column: number; readonly message: string }[];
  /** Required fields no column is matched to. */
  readonly missing: readonly string[];
}

/** Checks the person's choices before upload: one column per field, every required field given. */
export function checkMapping(
  header: readonly string[],
  chosen: readonly string[],
  recordType: ImportRecordType,
  t: Translator,
): MappingCheck {
  const fields = IMPORT_FIELDS[recordType];
  const mapping: Record<string, string | null> = {};
  const problems: { column: number; message: string }[] = [];
  const firstColumn = new Map<string, number>();
  const seenHeadings = new Set<string>();
  header.forEach((heading, index) => {
    const column = index + 1;
    const field = chosen[index] ?? LEAVE_OUT;
    if (seenHeadings.has(heading)) {
      problems.push({ column, message: t("import.mapping.sameHeading", { column }) });
      return;
    }
    seenHeadings.add(heading);
    if (field === LEAVE_OUT || !Object.hasOwn(fields, field)) {
      mapping[heading] = null;
      return;
    }
    const first = firstColumn.get(field);
    if (first !== undefined) {
      problems.push({
        column,
        message: t("import.mapping.twice", {
          first,
          column,
          field: fields[field]?.label ?? field,
        }),
      });
      return;
    }
    firstColumn.set(field, column);
    mapping[heading] = field;
  });
  const missing = Object.entries(fields)
    .filter(([key, field]) => field.required && !firstColumn.has(key))
    .map(([, field]) => field.label);
  return { mapping, problems, missing };
}

export type ImportState = ImportBatch["status"] | "unknown";

const CHIPS: Record<ImportBatch["status"], Omit<SafetyChip, "label">> = {
  staged: { status: "due", icon: "clock" },
  committed: { status: "done", icon: "circle-check" },
  undone: { status: "notApplicable", icon: "circle-minus" },
  discarded: { status: "notApplicable", icon: "circle-minus" },
  expired: { status: "notApplicable", icon: "circle-minus" },
};

export function importChip(status: string, t: Translator): SafetyChip {
  const known = CHIPS[status as ImportBatch["status"]];
  return {
    ...(known ?? { status: "overdue", icon: "circle-alert" }),
    label: t("import.state", { state: known ? status : "unknown" }),
  };
}

/** A field's label by key, for findings (the API names a field by key, never by the heading). */
export function fieldLabel(recordType: ImportRecordType, key: string): string {
  return IMPORT_FIELDS[recordType][key]?.label ?? key;
}

/** Where a finding is, in words: "Row 4, NHS number". */
export function findingPlace(
  finding: Pick<ImportFinding, "row" | "column">,
  recordType: ImportRecordType,
  t: Translator,
): string {
  return t("import.finding.place", {
    row: finding.row,
    field: fieldLabel(recordType, finding.column),
  });
}

/**
 * What a possible duplicate is the same as, as the words of its tick box: the other row in the
 * file, or the record already in Harbour (linked beside it, so the person can compare), and how
 * the names agree.
 */
export function warningLabel(
  finding: Pick<ImportFinding, "row" | "column" | "otherRow" | "personId" | "match">,
  recordType: ImportRecordType,
  t: Translator,
): string {
  return t("import.report.checked", {
    row: finding.row,
    field: fieldLabel(recordType, finding.column),
    kind: finding.otherRow ? "row" : finding.personId ? "existing" : "other",
    otherRow: finding.otherRow ?? 0,
    match: finding.match ?? "other",
  });
}

/**
 * The warnings the person must tick, by key: exactly the warnings shown, which the dry run lists
 * in full (it never lists more than it can be committed with). A warning the page cannot show
 * (no key) leaves the commit closed.
 */
export function acknowledgementKeys(report: Pick<ImportDryRunReport, "warnings">): string[] {
  return report.warnings.flatMap((w) => (w.key ? [w.key] : []));
}

export interface CommitReadiness {
  readonly ready: boolean;
  /** The keys to send: exactly the warnings shown, once every one is ticked. */
  readonly acknowledged: readonly string[];
  readonly reasons: readonly ("errors" | "unchecked" | "noUndo" | "notListed")[];
}

/** Whether the commit may be sent: no errors, every shown warning ticked, no-undo accepted. */
export function commitReadiness(
  report: Pick<
    ImportDryRunReport,
    "errorCount" | "warnings" | "warningKeys" | "phonesInUse" | "validRows"
  >,
  ticked: ReadonlySet<string>,
  acceptNoUndo: boolean,
): CommitReadiness {
  const shown = acknowledgementKeys(report);
  const reasons: CommitReadiness["reasons"][number][] = [];
  if (report.errorCount > 0 || report.validRows === 0) reasons.push("errors");
  // Every key the commit must list is shown, and every one shown is a key the commit takes.
  const keys = new Set(report.warningKeys);
  if (shown.length !== report.warnings.length || shown.length !== keys.size) {
    reasons.push("notListed");
  } else if (shown.some((k) => !keys.has(k))) reasons.push("notListed");
  if (shown.some((k) => !ticked.has(k))) reasons.push("unchecked");
  if (report.phonesInUse && !acceptNoUndo) reasons.push("noUndo");
  return { ready: reasons.length === 0, acknowledged: shown, reasons };
}

/** Undo, in words: when it closes, or a plain statement that it is not available. */
export function undoWords(
  batch: Pick<ImportBatch, "status" | "undoAvailable" | "undoClosesAt" | "undoneAt">,
  t: Translator,
  when: (iso: string | null) => string,
): string | null {
  if (batch.status === "undone") return t("import.undo.done", { dateTime: when(batch.undoneAt) });
  if (batch.status !== "committed") return null;
  if (batch.undoAvailable && batch.undoClosesAt) {
    return t("import.undo.until", { dateTime: when(batch.undoClosesAt) });
  }
  return t("import.undo.unavailable");
}

/** The upload body the route takes, checked here as the API will check it again. */
export interface ImportUploadBody {
  readonly recordType: ImportRecordType;
  readonly locationId: string;
  readonly csv: string;
  readonly mapping: Record<string, string | null>;
}

/**
 * The upload route's own body cap, in bytes: the API's (12 MiB, `IMPORT_MAX_BODY_BYTES`), so a
 * file the API takes is never refused here first, and nothing larger is read.
 */
export const IMPORT_UPLOAD_MAX_BYTES = 12 * 1024 * 1024;

export interface ImportUploadRefusal {
  readonly status: number;
  readonly code: string;
  readonly message: string;
}

/**
 * Whether the upload route may read a request: posted from this site (the configured origin, never
 * request headers), JSON, with a length given and within the cap.
 */
export function checkImportUploadRequest(
  request: {
    readonly sameOrigin: boolean;
    readonly contentType: string | null;
    readonly contentLength: string | null;
  },
  t: Translator,
): ImportUploadRefusal | null {
  if (!request.sameOrigin)
    return { status: 403, code: "forbidden", message: t("errors.forbidden") };
  const type = (request.contentType ?? "").split(";")[0]?.trim().toLowerCase();
  if (type !== "application/json") {
    return { status: 415, code: "invalid", message: t("import.upload.notCsv") };
  }
  const length = request.contentLength === null ? Number.NaN : Number(request.contentLength);
  if (!Number.isInteger(length) || length <= 0) {
    return { status: 411, code: "invalid", message: t("import.upload.fileRequired") };
  }
  if (length > IMPORT_UPLOAD_MAX_BYTES) {
    return { status: 413, code: "too_large", message: t("import.upload.tooLarge") };
  }
  return null;
}
