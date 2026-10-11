import {
  type AdvanceCareRecordState,
  cprRecordsInForce,
  resuscitationStatus,
} from "../care/advance-care";
import { describeIddsiLevel, iddsiLevel } from "../care/iddsi";
import {
  type AllergyStatement,
  type CommunicationStatement,
  normaliseAllergies,
  normaliseCommunication,
} from "../people/transfer-pack";
import { toUkWallClock, ukOffsetMinutes, ukZoneAbbreviation } from "../shared/time";
import { ukIsoDate } from "../shared/working-days";
import { authorise, type EffectiveAccess } from "./access";
import {
  EXPORT_SCHEMA_NAME,
  EXPORT_TABLES,
  type ExportRetention,
  type ExportTableDefinition,
  resolveColumnDoc,
} from "./export-catalogue";
import type { BoundedContext } from "./permissions";
import type { PlatformRates } from "./rates";

export * from "./export-catalogue";

/**
 * Free full tenant export (master prompt sections 5.1 and 9.1; DPA clause 9.1; data-standards.md
 * "Export and import conventions"; platform-completions.md rules 10 to 16; hazards HZ-070 and
 * HZ-071). A tenant can take all of its data, at any time, free, in a documented schema: one CSV
 * and one JSON Lines file per table, the documents, a per-person current summary of the
 * safety-critical facts, a schema description and a manifest with row counts and SHA-256
 * checksums. Everything is read in one database snapshot. These pure rules decide what goes in,
 * describe it, check that what was written is complete and the organisation's own, and gate the
 * request and the download.
 */

export const EXPORT_FORMAT = "harbour-tenant-export";
/** Bumped on any change to a mapped field, a code list or the export shape (data-standards.md). */
export const EXPORT_SCHEMA_VERSION = "1.1.0";
export const EXPORT_SCHEMA_FILE = "schema.json";
export const EXPORT_MANIFEST_FILE = "manifest.json";
export const EXPORT_DESTROYED_FILE = "destroyed.csv";
export const EXPORT_CURRENT_SUMMARY_FILE = "current_summary.csv";
export const EXPORT_DOCUMENTS_FOLDER = "documents/";
/**
 * How long a storage URL minted for one download lasts: a technical constant, not a policy
 * figure. The URL is minted only after `checkExportDownload` passes (HZ-070).
 */
export const EXPORT_DOWNLOAD_URL_SECONDS = 300;

export const EXPORT_COLUMN_TYPES = [
  "uuid",
  "text",
  "integer",
  "number",
  "boolean",
  "date",
  "time",
  "timestamp",
  "json",
  "uuid_array",
  "text_array",
  "enum",
] as const;
export type ExportColumnType = (typeof EXPORT_COLUMN_TYPES)[number];

/** A column as the database describes it (the schema step reads these from Drizzle). */
export interface ExportColumn {
  readonly name: string;
  readonly type: ExportColumnType;
  readonly nullable: boolean;
  readonly enumValues?: readonly string[];
}

/** A table as it exists in the database. */
export interface DatabaseTable {
  readonly schema: string;
  readonly name: string;
  readonly hasTenantId: boolean;
  readonly columns: readonly ExportColumn[];
}

/** The export type for a Postgres column type, as Drizzle reports it (`getSQLType`). */
export function columnTypeFromSql(
  sqlType: string,
  enumValues: readonly string[] | null = null,
): ExportColumnType {
  if (enumValues && enumValues.length > 0) return "enum";
  if (sqlType === "uuid") return "uuid";
  if (sqlType === "uuid[]") return "uuid_array";
  if (sqlType.endsWith("[]")) return "text_array";
  if (sqlType === "integer" || sqlType === "bigint" || sqlType === "smallint") return "integer";
  if (sqlType.startsWith("numeric") || sqlType === "real" || sqlType.startsWith("double")) {
    return "number";
  }
  if (sqlType === "boolean") return "boolean";
  if (sqlType === "date") return "date";
  if (sqlType.startsWith("time") && !sqlType.startsWith("timestamp")) return "time";
  if (sqlType.startsWith("timestamp")) return "timestamp";
  if (sqlType === "jsonb" || sqlType === "json") return "json";
  return "text";
}

export const qualifiedTableName = (table: Pick<DatabaseTable, "schema" | "name">): string =>
  `${table.schema}.${table.name}`;

function definitionOf(key: string): ExportTableDefinition | undefined {
  return Object.hasOwn(EXPORT_TABLES, key) ? EXPORT_TABLES[key] : undefined;
}

export type ExportCatalogueProblem =
  | { readonly table: string; readonly problem: "not_in_catalogue" | "not_in_database" }
  | {
      readonly table: string;
      readonly problem: "column_not_classified" | "classified_column_missing";
      readonly column: string;
    };

/**
 * Compares the catalogue with the database's `public` tables and columns
 * (`packages/db/src/export-catalogue.test.ts` runs it against the Drizzle schema): every table and
 * every column of an exported table must be classified, so a new column (a token, a key) can
 * never reach an export by default, and nothing classified may have disappeared.
 */
export function checkExportCatalogue(tables: readonly DatabaseTable[]): ExportCatalogueProblem[] {
  const problems: ExportCatalogueProblem[] = [];
  const publicTables = tables.filter((t) => t.schema === EXPORT_SCHEMA_NAME);
  for (const table of publicTables) {
    const key = qualifiedTableName(table);
    const definition = definitionOf(key);
    if (!definition) {
      problems.push({ table: key, problem: "not_in_catalogue" });
      continue;
    }
    if (definition.treatment === "not_exported") continue;
    for (const column of table.columns) {
      if (!resolveColumnDoc(definition, column.name)) {
        problems.push({ table: key, problem: "column_not_classified", column: column.name });
      }
    }
    for (const column of Object.keys(definition.columns)) {
      if (!table.columns.some((c) => c.name === column)) {
        problems.push({ table: key, problem: "classified_column_missing", column });
      }
    }
  }
  for (const key of Object.keys(EXPORT_TABLES)) {
    if (!publicTables.some((t) => qualifiedTableName(t) === key)) {
      problems.push({ table: key, problem: "not_in_database" });
    }
  }
  return problems;
}

export interface PlannedColumn extends ExportColumn {
  readonly description: string;
  readonly unit: string | null;
  readonly codes: Readonly<Record<string, string>> | null;
  /** For a derived column: the column it is computed from (`deceased_at_uk_date` from `deceased_at`). */
  readonly derivedFrom: string | null;
  readonly schema: "observation_values" | null;
}

export interface PlannedExportTable {
  /** `public.<table>`. */
  readonly key: string;
  readonly name: string;
  readonly context: BoundedContext;
  readonly description: string;
  readonly selection: "tenant_rows" | "tenant_overrides_only";
  readonly retention: ExportRetention;
  readonly personal: boolean;
  readonly columns: readonly PlannedColumn[];
  /** Internal and secret columns left out. */
  readonly omittedColumns: readonly string[];
  readonly files: { readonly csv: string; readonly jsonl: string };
}

export interface ExportPlan {
  readonly schemaVersion: string;
  /** A full export, or the changes since an earlier export's snapshot. */
  readonly kind: "full" | "changes_since";
  readonly since: Date | null;
  readonly tables: readonly PlannedExportTable[];
  readonly notExported: readonly { readonly name: string; readonly reason: string }[];
  /** Tables or columns nobody classified: never exported, and they make the export incomplete. */
  readonly unclassified: readonly { readonly table: string; readonly columns: readonly string[] }[];
}

const SCHEMA_REASONS: Readonly<Record<string, string>> = {
  auth: "Passwords, sessions, passkeys and authenticator secrets are never exported; staff identities are in tenant_user.",
};

/**
 * Which tables go in, with which columns and files, from the database's own table list. Only the
 * `public` schema is read; only columns classified `exported` are written; an unclassified table
 * or column is never written and makes the export incomplete (`buildExportManifest`).
 */
export function planExport(
  tables: readonly DatabaseTable[],
  options: { readonly since?: Date | null } = {},
): ExportPlan {
  const planned: PlannedExportTable[] = [];
  const notExported: { name: string; reason: string }[] = [];
  const unclassified: { table: string; columns: string[] }[] = [];
  const sorted = [...tables].sort((a, b) =>
    qualifiedTableName(a).localeCompare(qualifiedTableName(b)),
  );
  for (const table of sorted) {
    const key = qualifiedTableName(table);
    if (table.schema !== EXPORT_SCHEMA_NAME) {
      notExported.push({
        name: key,
        reason: SCHEMA_REASONS[table.schema] ?? "Only the public schema is exported.",
      });
      continue;
    }
    const definition = definitionOf(key);
    if (!definition) {
      unclassified.push({ table: key, columns: table.columns.map((c) => c.name) });
      continue;
    }
    if (definition.treatment === "not_exported") {
      notExported.push({ name: key, reason: definition.reasonNotExported ?? "" });
      continue;
    }
    const columns: PlannedColumn[] = [];
    const omitted: string[] = [];
    const missing: string[] = [];
    for (const column of table.columns) {
      const doc = resolveColumnDoc(definition, column.name);
      if (!doc) {
        missing.push(column.name);
        continue;
      }
      if (doc.class !== "exported") {
        omitted.push(column.name);
        continue;
      }
      columns.push({
        ...column,
        description: doc.description,
        unit: doc.unit,
        codes: doc.codes,
        derivedFrom: null,
        schema: doc.schema,
      });
      if (doc.ukDate) {
        columns.push({
          name: `${column.name}_uk_date`,
          type: "date",
          nullable: true,
          description: `The UK calendar date (Europe/London) of ${column.name}.`,
          unit: null,
          codes: null,
          derivedFrom: column.name,
          schema: null,
        });
      }
    }
    if (missing.length > 0) unclassified.push({ table: key, columns: missing });
    planned.push({
      key,
      name: table.name,
      context: definition.context,
      description: definition.description,
      selection:
        definition.treatment === "tenant_overrides_only" ? "tenant_overrides_only" : "tenant_rows",
      retention: definition.retention,
      personal: definition.personal,
      columns,
      omittedColumns: omitted,
      files: { csv: `tables/${table.name}.csv`, jsonl: `tables/${table.name}.jsonl` },
    });
  }
  const since = options.since ?? null;
  return {
    schemaVersion: EXPORT_SCHEMA_VERSION,
    kind: since ? "changes_since" : "full",
    since,
    tables: planned,
    notExported,
    unclassified,
  };
}

// ------------------------------------------------------------------------------------------------
// Rows and documents
// ------------------------------------------------------------------------------------------------

export interface ExportRowState {
  readonly deletedAt: Date | null;
  readonly legalHold: boolean;
  /** Set once the record was destroyed past retention (a tombstone with its certificate). */
  readonly destroyed: { readonly at: Date; readonly certificateId: string | null } | null;
  /** Sample data (onboarding), never the organisation's real records. */
  readonly sample: boolean;
}

export type ExportRowDecision =
  | { readonly action: "include"; readonly reason: "live" | "legal_hold" }
  | { readonly action: "exclude"; readonly reason: "soft_deleted" | "sample" }
  | { readonly action: "list_as_destroyed"; readonly certificateId: string | null };

/**
 * What happens to one row (platform-completions.md rule 11):
 * 1. destroyed past retention: not in its table file; listed in destroyed.csv with the
 *    destruction certificate id, so the export says the record existed and was destroyed;
 * 2. sample data: left out (it is not the organisation's data) and counted;
 * 3. under a legal hold: always in, even if it was soft-deleted, because the hold preserves it;
 * 4. soft-deleted (deleted and awaiting destruction): left out and counted, as retention-and-
 *    deletion.md says soft-deleted records leave every export;
 * 5. everything else: in.
 */
export function exportRowDecision(row: ExportRowState): ExportRowDecision {
  if (row.destroyed) {
    return { action: "list_as_destroyed", certificateId: row.destroyed.certificateId };
  }
  if (row.sample) return { action: "exclude", reason: "sample" };
  if (row.legalHold) return { action: "include", reason: "legal_hold" };
  if (row.deletedAt) return { action: "exclude", reason: "soft_deleted" };
  return { action: "include", reason: "live" };
}

/**
 * For a changes-since export: a row belongs when it was created, changed, recorded, deleted or
 * destroyed at or after the earlier export's snapshot.
 */
export function exportRowChangedSince(
  row: {
    readonly createdAt: Date | null;
    readonly updatedAt?: Date | null;
    readonly recordedAt?: Date | null;
    readonly deletedAt?: Date | null;
    readonly destroyedAt?: Date | null;
  },
  since: Date,
): boolean {
  return [row.createdAt, row.updatedAt, row.recordedAt, row.deletedAt, row.destroyedAt].some(
    (d) => d instanceof Date && d.getTime() >= since.getTime(),
  );
}

const EXTENSIONS: Readonly<Record<string, string>> = {
  "application/pdf": "pdf",
  "image/jpeg": "jpg",
  "image/png": "png",
  "image/webp": "webp",
};

function isUuidShaped(id: string): boolean {
  if (id.length !== 36) return false;
  for (const ch of id) {
    const hex = (ch >= "0" && ch <= "9") || (ch >= "a" && ch <= "f") || (ch >= "A" && ch <= "F");
    if (!hex && ch !== "-") return false;
  }
  return true;
}

/** documents/<id>.<ext>: the opaque id only, never the title or file name (they can name people). */
export function documentExportPath(id: string, contentType: string): string {
  if (!isUuidShaped(id)) throw new RangeError("Document ids in an export must be UUIDs.");
  return `${EXPORT_DOCUMENTS_FOLDER}${id.toLowerCase()}.${EXTENSIONS[contentType] ?? "bin"}`;
}

/**
 * Where an export's files are stored: under the organisation's own prefix in the eu-west-2 export
 * bucket (SSE-KMS), so a storage policy can confine every object to its tenant.
 */
export function exportStoragePrefix(tenantId: string, exportId: string): string {
  if (!isUuidShaped(tenantId) || !isUuidShaped(exportId)) {
    throw new RangeError("Export storage keys are built from UUIDs only.");
  }
  return `tenants/${tenantId.toLowerCase()}/exports/${exportId.toLowerCase()}/`;
}

export interface ExportDocumentRow extends ExportRowState {
  readonly id: string;
  readonly contentType: string;
  readonly sha256: string;
  readonly sizeBytes: number;
  /** `available`, `quarantined` (failed or missed the malware scan) or `destroyed`. */
  readonly status: string;
}

export type ExportDocumentDecision =
  | {
      readonly action: "include_bytes";
      readonly path: string;
      readonly sha256: string;
      readonly bytes: number;
    }
  | { readonly action: "omit_bytes"; readonly reason: "quarantined" }
  | { readonly action: "exclude"; readonly reason: "soft_deleted" | "sample" }
  | { readonly action: "list_as_destroyed"; readonly certificateId: string | null };

/**
 * A document follows the row rules; a kept document's bytes go in documents/ unless it is
 * quarantined, because a file that failed or missed the malware scan is never handed out (ADR-0031).
 * Its row stays in document.csv either way, so the export says it exists.
 */
export function exportDocumentDecision(doc: ExportDocumentRow): ExportDocumentDecision {
  const destroyed =
    doc.destroyed ??
    (doc.status === "destroyed" ? { at: doc.deletedAt ?? new Date(0), certificateId: null } : null);
  const row = exportRowDecision({ ...doc, destroyed });
  if (row.action !== "include") return row;
  if (doc.status !== "available") return { action: "omit_bytes", reason: "quarantined" };
  return {
    action: "include_bytes",
    path: documentExportPath(doc.id, doc.contentType),
    sha256: doc.sha256.toLowerCase(),
    bytes: doc.sizeBytes,
  };
}

/** True when the bytes written match the SHA-256 recorded at upload. */
export function documentChecksumMatches(expected: string, actual: string | null): boolean {
  return (
    actual !== null && expected.length === 64 && expected.toLowerCase() === actual.toLowerCase()
  );
}

// ------------------------------------------------------------------------------------------------
// Values: UK dates and times, CSV cells
// ------------------------------------------------------------------------------------------------

/** The UK calendar date (Europe/London) of an instant: a date of death, not the UTC date. */
export function ukDateOfInstant(instant: Date | null): string | null {
  return instant ? ukIsoDate(instant) : null;
}

/**
 * An instant as UK local time with its offset and zone, for people reading the manifest and the
 * current summary: `2026-10-25T01:30:00+01:00` and `BST`. Files keep UTC; this is alongside it.
 */
export function ukLocalTimestamp(instant: Date): {
  readonly local: string;
  readonly zone: "BST" | "GMT";
} {
  const w = toUkWallClock(instant);
  const offset = ukOffsetMinutes(instant);
  const pad = (n: number) => String(n).padStart(2, "0");
  const sign = offset < 0 ? "-" : "+";
  const abs = Math.abs(offset);
  const local = `${w.year}-${pad(w.month)}-${pad(w.day)}T${pad(w.hour)}:${pad(w.minute)}:${pad(
    instant.getUTCSeconds(),
  )}${sign}${pad(Math.floor(abs / 60))}:${pad(abs % 60)}`;
  return { local, zone: ukZoneAbbreviation(instant) };
}

/** First characters a spreadsheet may run as a formula, plus the apostrophe that escapes them. */
const CSV_GUARDED_FIRST = new Set(["=", "+", "-", "@", "\t", "\r", "'"]);

/**
 * One CSV cell (RFC 4180). Text that a spreadsheet could run as a formula (starting with =, +, -,
 * @, a tab or a carriage return) is written with a leading apostrophe, and so is text that already
 * starts with one, so the guard can always be undone (`csvTextValue`). Numbers, booleans and dates
 * are written as values and never guarded. JSON Lines files hold the exact values (security review).
 */
export function csvCell(value: unknown): string {
  let text: string;
  if (value === null || value === undefined) return "";
  if (typeof value === "number" || typeof value === "bigint") text = String(value);
  else if (typeof value === "boolean") text = value ? "true" : "false";
  else if (value instanceof Date) text = value.toISOString();
  else if (typeof value === "string") {
    text = CSV_GUARDED_FIRST.has(value.charAt(0)) ? `'${value}` : value;
  } else text = JSON.stringify(value);
  const needsQuotes = /[",\r\n]/.test(text);
  return needsQuotes ? `"${text.replaceAll('"', '""')}"` : text;
}

/** One CSV line from values in column order. */
export function csvRow(values: readonly unknown[]): string {
  return values.map(csvCell).join(",");
}

/** Undoes the formula guard on a text cell read back from the CSV (the import wizard uses it). */
export function csvTextValue(cell: string): string {
  return cell.startsWith("'") && CSV_GUARDED_FIRST.has(cell.charAt(1)) ? cell.slice(1) : cell;
}

// ------------------------------------------------------------------------------------------------
// Observation values and the current summary
// ------------------------------------------------------------------------------------------------

type JsonSchema = Readonly<Record<string, unknown>>;

const IDDSI_FOOD_CODES = ["3", "4", "5", "6", "7EC", "7"] as const;
const IDDSI_DRINK_CODES = ["0", "1", "2", "3", "4"] as const;

/**
 * The schema of `observation.values`, one object per chart, with the unit of every number
 * (`x-unit`). Mirrors `ObservationValues` in packages/contracts (a test keeps the charts in step).
 */
export const OBSERVATION_VALUES_SCHEMA: Readonly<Record<string, JsonSchema>> = {
  fluid_intake: {
    type: "object",
    required: ["chart", "ml"],
    properties: {
      chart: { const: "fluid_intake" },
      ml: { type: "integer", "x-unit": "ml", minimum: 0, maximum: 5000 },
      drink: { type: "string" },
      iddsiLevel: { type: "string", enum: IDDSI_DRINK_CODES },
      overrideReason: { type: "string" },
      refused: { type: "boolean" },
    },
  },
  fluid_output: {
    type: "object",
    required: ["chart", "ml", "kind"],
    properties: {
      chart: { const: "fluid_output" },
      ml: { type: "integer", "x-unit": "ml", minimum: 0, maximum: 5000 },
      kind: { type: "string", enum: ["urine", "vomit", "drain", "other"] },
    },
  },
  food: {
    type: "object",
    required: ["chart", "meal", "portion", "iddsiLevel"],
    properties: {
      chart: { const: "food" },
      meal: { type: "string", enum: ["breakfast", "lunch", "dinner", "supper", "snack"] },
      portion: { type: "string", enum: ["none", "quarter", "half", "three_quarters", "all"] },
      iddsiLevel: { type: "string", enum: IDDSI_FOOD_CODES },
      overrideReason: { type: "string" },
      description: { type: "string" },
      refused: { type: "boolean" },
    },
  },
  repositioning: {
    type: "object",
    required: ["chart", "position", "skinChecked"],
    properties: {
      chart: { const: "repositioning" },
      position: { type: "string", enum: ["left", "right", "back", "front", "sitting"] },
      skinChecked: { type: "boolean" },
      declined: { type: "boolean" },
    },
  },
  bowel: {
    type: "object",
    required: ["chart"],
    properties: {
      chart: { const: "bowel" },
      bristolType: { type: ["integer", "null"], "x-unit": "Bristol stool scale type (1 to 7)" },
      noMovement: { type: "boolean" },
      amount: { type: "string", enum: ["small", "medium", "large"] },
    },
  },
  weight: {
    type: "object",
    required: ["chart", "kg", "method"],
    properties: {
      chart: { const: "weight" },
      kg: { type: "number", "x-unit": "kg", minimum: 20, maximum: 300 },
      method: { type: "string", enum: ["standing", "chair", "hoist", "bed"] },
    },
  },
  vitals: {
    type: "object",
    required: [
      "chart",
      "respirationRate",
      "spo2",
      "onOxygen",
      "systolic",
      "pulse",
      "consciousness",
      "temperature",
    ],
    properties: {
      chart: { const: "vitals" },
      respirationRate: { type: "integer", "x-unit": "breaths per minute" },
      spo2: { type: "integer", "x-unit": "% oxygen saturation" },
      onOxygen: { type: "boolean" },
      systolic: { type: "integer", "x-unit": "mmHg (systolic blood pressure)" },
      pulse: { type: "integer", "x-unit": "beats per minute" },
      consciousness: {
        type: "string",
        enum: ["alert", "new_confusion", "voice", "pain", "unresponsive"],
      },
      temperature: { type: "number", "x-unit": "degrees Celsius" },
    },
  },
};

export const CURRENT_SUMMARY_COLUMNS = [
  { name: "person_id", description: "The person (person.id)." },
  {
    name: "allergy_status",
    description: "unknown, no_known_allergies or has_allergies; unknown never means none.",
  },
  {
    name: "allergies",
    description:
      "Active allergies, most severe first: substance (severity), separated by semicolons.",
  },
  {
    name: "cpr_decision",
    description:
      "The CPR decision in force: attempt_cpr, do_not_attempt_cpr, not_recorded, or conflicting when records in force disagree.",
  },
  {
    name: "cpr_record_ids",
    description:
      "The advance care records behind the decision; both or all of them when conflicting.",
  },
  {
    name: "cpr_review_overdue",
    description: "True when the record in force is past its review date.",
  },
  { name: "iddsi_food", description: "IDDSI food level with name and colour, or not recorded." },
  { name: "iddsi_drink", description: "IDDSI drink level with name and colour, or not recorded." },
  {
    name: "communication_needs_status",
    description: "not_recorded, none_identified or recorded; not_recorded never means none.",
  },
  {
    name: "communication_needs",
    description:
      "Accessible Information Standard needs with the preferred format, separated by semicolons.",
  },
  { name: "as_of", description: "The snapshot instant the summary describes (UTC)." },
  { name: "as_of_uk", description: "The same instant in UK local time with its offset and zone." },
] as const;

export type CurrentSummaryRow = Readonly<
  Record<(typeof CURRENT_SUMMARY_COLUMNS)[number]["name"], string>
>;

export interface CurrentSummaryInput {
  readonly personId: string;
  readonly allergies: AllergyStatement;
  readonly advanceCare: readonly AdvanceCareRecordState[];
  readonly iddsi: { readonly food: string | null; readonly drink: string | null };
  readonly communication: CommunicationStatement;
  readonly snapshotAt: Date;
}

function iddsiText(kind: "food" | "drink", code: string | null): string {
  return code !== null && iddsiLevel(kind, code) ? describeIddsiLevel(kind, code) : "not recorded";
}

/**
 * One row of current_summary.csv: the safety-critical facts a receiving provider must not
 * misread, worked out by the same domain functions the point-of-care header and the transfer pack
 * use (`normaliseAllergies`, `resuscitationStatus`, `cprRecordsInForce`, `describeIddsiLevel`,
 * `normaliseCommunication`), never re-derived from the tables (HZ-071, HZ-007, HZ-015, HZ-016).
 */
export function currentSummaryRow(input: CurrentSummaryInput): CurrentSummaryRow {
  const today = ukIsoDate(input.snapshotAt);
  const allergies = normaliseAllergies(input.allergies);
  const cpr = resuscitationStatus(input.advanceCare, today);
  const inForce = cprRecordsInForce(input.advanceCare);
  const communication = normaliseCommunication(input.communication);
  const uk = ukLocalTimestamp(input.snapshotAt);
  return {
    person_id: input.personId,
    allergy_status: allergies.status,
    allergies:
      allergies.status === "has_allergies"
        ? allergies.allergies.map((a) => `${a.substance} (${a.severity})`).join("; ")
        : "",
    cpr_decision: cpr.conflicting ? "conflicting" : cpr.status,
    cpr_record_ids: cpr.conflicting ? inForce.map((r) => r.id).join("; ") : (cpr.recordId ?? ""),
    cpr_review_overdue: cpr.reviewOverdue ? "true" : "false",
    iddsi_food: iddsiText("food", input.iddsi.food),
    iddsi_drink: iddsiText("drink", input.iddsi.drink),
    communication_needs_status: communication.status,
    communication_needs:
      communication.status === "recorded"
        ? communication.needs.map((n) => `${n.display} (${n.preferredFormat})`).join("; ")
        : "",
    as_of: input.snapshotAt.toISOString(),
    as_of_uk: `${uk.local} ${uk.zone}`,
  };
}

// ------------------------------------------------------------------------------------------------
// Schema description
// ------------------------------------------------------------------------------------------------

/** Conventions every reader of the export needs, written into schema.json. */
export const EXPORT_CONVENTIONS = {
  files:
    "One CSV (RFC 4180, UTF-8, header row) and one JSON Lines file per table under tables/; both hold the same rows.",
  snapshot:
    "Every file was read in one database snapshot, taken at manifest.snapshotAt; nothing changed between files. A changes-since export holds rows created, changed, recorded, deleted or destroyed at or after manifest.since.",
  instants:
    "Columns ending _at and other timestamps are instants in UTC with Z. UK local time is that instant in Europe/London: +00:00 (GMT) in winter, +01:00 (BST) in summer. During the autumn clock change the same local time happens twice, so always convert from the UTC value, never back from local time.",
  ukDates:
    "Dates (YYYY-MM-DD, columns ending _on or _date) are UK calendar dates, not instants. Where an instant stands for a date, such as a date of death, the export adds <column>_uk_date with the UK date; use it rather than the UTC date, which is a day early for times after 23:00 in summer.",
  wallClock:
    "Times of day in recurrence rules and quiet hours are wall-clock times in Europe/London, not UTC; a daily 08:00 stays 08:00 across clock changes.",
  corrections:
    "Notes, observations and other entries are never edited. A correction is a new row whose supersedes_id names the row it corrects; the original stays for the record and is not a second live fact. The current value is the row that no other row supersedes; show the original struck through with the correction.",
  versions:
    "Mutable records hold their current state; earlier versions are in record_version. Only one care plan per person is published at a time (status published).",
  destroyed: `${EXPORT_DESTROYED_FILE} lists records destroyed past retention with their certificate id; they are not in the table files.`,
  currentSummary: `${EXPORT_CURRENT_SUMMARY_FILE} has one row per person with the allergy status, the CPR decision in force (or conflicting, with every record), IDDSI levels and communication needs, worked out as Harbour shows them. Check these first when moving a person to another system.`,
  empty:
    "An empty CSV cell and JSON null both mean not recorded; unknown and not_recorded codes never mean none.",
  csvFormulas:
    "In CSV files only, a text cell starting with =, +, -, @, a tab, a carriage return or an apostrophe has an apostrophe added in front, so spreadsheets do not run it as a formula. Remove one leading apostrophe from such a cell to get the value. JSON Lines files hold the exact values.",
  documents:
    "documents/<document id>.<extension>, with checksums in manifest.json; quarantined files are listed but not included.",
  mapping: "Field meanings and code lists: Harbour data-standards.md for this schema version.",
} as const;

function columnSchema(column: PlannedColumn): JsonSchema {
  const base: Record<ExportColumnType, JsonSchema> = {
    uuid: { type: "string", format: "uuid" },
    text: { type: "string" },
    integer: { type: "integer" },
    number: { type: "number" },
    boolean: { type: "boolean" },
    date: { type: "string", format: "date" },
    time: { type: "string", format: "time" },
    timestamp: { type: "string", format: "date-time" },
    json: { type: ["object", "array"] },
    uuid_array: { type: "array", items: { type: "string", format: "uuid" } },
    text_array: { type: "array", items: { type: "string" } },
    enum: { type: "string", enum: column.enumValues ?? [] },
  };
  let schema = base[column.type];
  if (column.nullable) {
    const type = schema.type;
    schema =
      column.type === "enum"
        ? { ...schema, type: ["string", "null"], enum: [...(column.enumValues ?? []), null] }
        : { ...schema, type: Array.isArray(type) ? [...type, "null"] : [type, "null"] };
  }
  return {
    ...schema,
    description: column.description,
    ...(column.unit ? { "x-unit": column.unit } : {}),
    ...(column.codes ? { "x-codes": column.codes } : {}),
    ...(column.derivedFrom ? { "x-derived-from": column.derivedFrom } : {}),
    ...(column.schema === "observation_values" ? { "x-schema": "#/observationValues" } : {}),
  };
}

/**
 * The documented schema shipped as schema.json in every export: the conventions, each table's
 * purpose, context and retention, a JSON Schema (2020-12) for its rows with a description and
 * unit for every column, the observation values per chart, and the current summary's columns.
 */
export function describeExportSchema(plan: ExportPlan): JsonSchema {
  return {
    $schema: "https://json-schema.org/draft/2020-12/schema",
    title: "Harbour full organisation export",
    format: EXPORT_FORMAT,
    schemaVersion: plan.schemaVersion,
    conventions: EXPORT_CONVENTIONS,
    tables: Object.fromEntries(
      plan.tables.map((t) => [
        t.name,
        {
          description: t.description,
          context: t.context,
          retention: t.retention,
          personalData: t.personal,
          files: t.files,
          omittedColumns: t.omittedColumns,
          rows: {
            type: "object",
            additionalProperties: false,
            required: t.columns.map((c) => c.name),
            properties: Object.fromEntries(t.columns.map((c) => [c.name, columnSchema(c)])),
          },
        },
      ]),
    ),
    observationValues: { oneOf: Object.values(OBSERVATION_VALUES_SCHEMA) },
    currentSummary: {
      file: EXPORT_CURRENT_SUMMARY_FILE,
      columns: Object.fromEntries(CURRENT_SUMMARY_COLUMNS.map((c) => [c.name, c.description])),
    },
    notExported: plan.notExported,
  };
}

// ------------------------------------------------------------------------------------------------
// Manifest
// ------------------------------------------------------------------------------------------------

export interface WrittenFile {
  readonly path: string;
  readonly format: "csv" | "jsonl";
  readonly sha256: string;
  readonly bytes: number;
  readonly rows: number;
}

export interface WrittenTable {
  readonly name: string;
  readonly files: readonly WrittenFile[];
  readonly included: number;
  readonly legalHoldRows: number;
  readonly excluded: { readonly softDeleted: number; readonly sample: number };
  /** Rows whose tenant_id is not the exporting organisation's: must always be zero (HZ-070). */
  readonly otherTenantRows: number;
}

export interface WrittenDocument {
  readonly id: string;
  readonly decision: ExportDocumentDecision;
  /** SHA-256 of the bytes actually written; null when none were. */
  readonly writtenSha256: string | null;
}

export interface DestroyedRecord {
  readonly table: string;
  readonly id: string;
  readonly destroyedAt: Date;
  readonly certificateId: string | null;
}

export interface ExportManifestInput {
  readonly exportId: string;
  readonly tenantId: string;
  readonly requestedBy: string;
  readonly generatedAt: Date;
  /** When the single read-only snapshot every file was read from was taken. */
  readonly snapshotAt: Date;
  readonly plan: ExportPlan;
  readonly schemaFile: { readonly sha256: string; readonly bytes: number };
  readonly tables: readonly WrittenTable[];
  readonly currentSummary: WrittenFile | null;
  readonly documents: readonly WrittenDocument[];
  readonly destroyed: readonly DestroyedRecord[];
  readonly auditChain: { readonly verified: boolean; readonly firstBrokenPosition: number | null };
}

/** A problem makes the export incomplete: it is never offered for download (HZ-070, HZ-071). */
export type ExportManifestProblem =
  | { readonly kind: "table_missing"; readonly table: string }
  | { readonly kind: "unexpected_table"; readonly table: string }
  | { readonly kind: "unclassified"; readonly table: string; readonly columns: readonly string[] }
  | { readonly kind: "file_missing"; readonly table: string; readonly format: "csv" | "jsonl" }
  | {
      readonly kind: "row_count_mismatch";
      readonly table: string;
      readonly format: "csv" | "jsonl";
    }
  | { readonly kind: "foreign_tenant_rows"; readonly table: string; readonly rows: number }
  | { readonly kind: "summary_missing" }
  | { readonly kind: "summary_row_count_mismatch"; readonly people: number; readonly rows: number }
  | { readonly kind: "document_not_written"; readonly id: string }
  | { readonly kind: "document_checksum_mismatch"; readonly id: string };

/** A warning is shown in the manifest and on the download page, and does not block it. */
export type ExportManifestWarning =
  | { readonly kind: "audit_chain_broken"; readonly position: number | null }
  | {
      readonly kind: "destroyed_without_certificate";
      readonly table: string;
      readonly id: string;
    };

export interface ExportManifest {
  readonly format: string;
  readonly schemaVersion: string;
  readonly kind: ExportPlan["kind"];
  readonly since: string | null;
  readonly exportId: string;
  readonly tenantId: string;
  readonly requestedBy: string;
  readonly generatedAt: string;
  readonly snapshotAt: string;
  readonly snapshotAtUk: { readonly local: string; readonly zone: "BST" | "GMT" };
  readonly schema: { readonly path: string; readonly sha256: string; readonly bytes: number };
  readonly tables: readonly {
    readonly name: string;
    readonly rows: number;
    readonly legalHoldRows: number;
    readonly excluded: { readonly softDeleted: number; readonly sample: number };
    readonly files: readonly WrittenFile[];
  }[];
  readonly currentSummary: WrittenFile | null;
  readonly notExported: ExportPlan["notExported"];
  readonly documents: {
    readonly included: number;
    readonly bytes: number;
    readonly quarantined: number;
    readonly excluded: number;
    readonly destroyed: number;
    readonly files: readonly {
      readonly id: string;
      readonly path: string;
      readonly sha256: string;
      readonly bytes: number;
    }[];
  };
  readonly destroyed: {
    readonly path: string;
    readonly count: number;
    readonly byTable: Readonly<Record<string, number>>;
    readonly certificateIds: readonly string[];
  };
  readonly auditChain: ExportManifestInput["auditChain"];
  readonly complete: boolean;
  readonly problems: readonly ExportManifestProblem[];
  readonly warnings: readonly ExportManifestWarning[];
}

/**
 * Builds manifest.json from what was written, and checks it against the plan: every planned table
 * has both files with the counted rows and no other organisation's rows; nothing unclassified was
 * met; the current summary has one row per exported person; every document's bytes match the
 * checksum recorded at upload. An incomplete export is marked failed and retried, never delivered
 * as if whole.
 */
export function buildExportManifest(input: ExportManifestInput): ExportManifest {
  const problems: ExportManifestProblem[] = [];
  const warnings: ExportManifestWarning[] = [];

  for (const u of input.plan.unclassified) {
    problems.push({ kind: "unclassified", table: u.table, columns: u.columns });
  }
  for (const planned of input.plan.tables) {
    const written = input.tables.find((t) => t.name === planned.name);
    if (!written) {
      problems.push({ kind: "table_missing", table: planned.name });
      continue;
    }
    if (written.otherTenantRows > 0) {
      problems.push({
        kind: "foreign_tenant_rows",
        table: planned.name,
        rows: written.otherTenantRows,
      });
    }
    for (const format of ["csv", "jsonl"] as const) {
      const file = written.files.find((f) => f.format === format);
      if (!file) problems.push({ kind: "file_missing", table: planned.name, format });
      else if (file.rows !== written.included) {
        problems.push({ kind: "row_count_mismatch", table: planned.name, format });
      }
    }
  }
  for (const written of input.tables) {
    if (!input.plan.tables.some((t) => t.name === written.name)) {
      problems.push({ kind: "unexpected_table", table: written.name });
    }
  }
  const people = input.tables.find((t) => t.name === "person")?.included ?? 0;
  if (!input.currentSummary) problems.push({ kind: "summary_missing" });
  else if (input.plan.kind === "full" && input.currentSummary.rows !== people) {
    problems.push({ kind: "summary_row_count_mismatch", people, rows: input.currentSummary.rows });
  }

  const files: { id: string; path: string; sha256: string; bytes: number }[] = [];
  let quarantined = 0;
  let excluded = 0;
  let destroyedDocuments = 0;
  for (const doc of input.documents) {
    const d = doc.decision;
    if (d.action === "include_bytes") {
      if (doc.writtenSha256 === null) problems.push({ kind: "document_not_written", id: doc.id });
      else if (!documentChecksumMatches(d.sha256, doc.writtenSha256)) {
        problems.push({ kind: "document_checksum_mismatch", id: doc.id });
      } else files.push({ id: doc.id, path: d.path, sha256: d.sha256, bytes: d.bytes });
    } else if (d.action === "omit_bytes") quarantined += 1;
    else if (d.action === "exclude") excluded += 1;
    else destroyedDocuments += 1;
  }

  const byTable: Record<string, number> = {};
  const certificates = new Set<string>();
  for (const record of input.destroyed) {
    byTable[record.table] = (byTable[record.table] ?? 0) + 1;
    if (record.certificateId) certificates.add(record.certificateId);
    else
      warnings.push({ kind: "destroyed_without_certificate", table: record.table, id: record.id });
  }
  if (!input.auditChain.verified) {
    warnings.push({ kind: "audit_chain_broken", position: input.auditChain.firstBrokenPosition });
  }

  return {
    format: EXPORT_FORMAT,
    schemaVersion: input.plan.schemaVersion,
    kind: input.plan.kind,
    since: input.plan.since ? input.plan.since.toISOString() : null,
    exportId: input.exportId,
    tenantId: input.tenantId,
    requestedBy: input.requestedBy,
    generatedAt: input.generatedAt.toISOString(),
    snapshotAt: input.snapshotAt.toISOString(),
    snapshotAtUk: ukLocalTimestamp(input.snapshotAt),
    schema: { path: EXPORT_SCHEMA_FILE, ...input.schemaFile },
    tables: input.plan.tables.map((planned) => {
      const written = input.tables.find((t) => t.name === planned.name);
      return {
        name: planned.name,
        rows: written?.included ?? 0,
        legalHoldRows: written?.legalHoldRows ?? 0,
        excluded: written?.excluded ?? { softDeleted: 0, sample: 0 },
        files: written?.files ?? [],
      };
    }),
    currentSummary: input.currentSummary,
    notExported: input.plan.notExported,
    documents: {
      included: files.length,
      bytes: files.reduce((sum, f) => sum + f.bytes, 0),
      quarantined,
      excluded,
      destroyed: destroyedDocuments,
      files,
    },
    destroyed: {
      path: EXPORT_DESTROYED_FILE,
      count: input.destroyed.length,
      byTable,
      certificateIds: [...certificates].sort(),
    },
    auditChain: input.auditChain,
    complete: problems.length === 0,
    problems,
    warnings,
  };
}

// ------------------------------------------------------------------------------------------------
// Request and download
// ------------------------------------------------------------------------------------------------

export const EXPORT_STATUSES = [
  "queued",
  "running",
  "ready",
  "failed",
  "expired",
  "revoked",
] as const;
export type ExportStatus = (typeof EXPORT_STATUSES)[number];

export type ExportRequestProblem =
  | "missing_permission"
  | "step_up_required"
  | "export_in_progress"
  | "data_purged"
  | "since_in_future";

export type ExportRequestCheck =
  | { readonly ok: true }
  | {
      readonly ok: false;
      readonly problem: ExportRequestProblem;
      readonly message: string;
      readonly existingExportId?: string;
    };

const REQUEST_MESSAGES: Record<ExportRequestProblem, string> = {
  missing_permission: "Only people who can export the organisation's data can do this.",
  step_up_required: "Sign in again with your second step to export the organisation's data.",
  export_in_progress: "An export is already being prepared. You will be told when it is ready.",
  data_purged: "This organisation's data has been deleted at the end of its contract.",
  since_in_future: "Choose an earlier export to take the changes since.",
};

export interface ExportRequestContext {
  readonly access: EffectiveAccess;
  /** The last sign-in completed with the second step (TOTP or passkey): step-up needs one. */
  readonly lastMfaSignInAt: Date | null;
  readonly now: Date;
  readonly stepUpWindowSeconds: number;
  /** Any status, including suspended or closed: the export is free and never withheld. */
  readonly tenant: { readonly status: string; readonly dataPurgedAt: Date | null };
  readonly exports: readonly { readonly id: string; readonly status: ExportStatus }[];
  /** For a changes-since export: the earlier export's snapshot instant. */
  readonly since?: Date | null;
}

/**
 * Whether an export may start (platform-completions.md rules 13 and 15): `platform.export.create`,
 * which needs MFA, with an MFA sign-in within the step-up window. It is free, so nothing about the
 * plan, payments or a suspended or ended contract stops it until the data is deleted (DPA clause
 * 9). The only limit is abuse protection: one export at a time per organisation (a partial unique
 * index in the schema step); asking again returns the one being prepared.
 */
export function checkExportRequest(context: ExportRequestContext): ExportRequestCheck {
  const fail = (problem: ExportRequestProblem, existingExportId?: string): ExportRequestCheck => ({
    ok: false,
    problem,
    message: REQUEST_MESSAGES[problem],
    ...(existingExportId ? { existingExportId } : {}),
  });
  const decision = authorise(
    context.access,
    "platform.export.create",
    context.lastMfaSignInAt,
    context.now,
    context.stepUpWindowSeconds,
  );
  if (!decision.allowed) {
    return fail(decision.reason === "step_up_required" ? "step_up_required" : "missing_permission");
  }
  if (context.tenant.dataPurgedAt !== null) return fail("data_purged");
  if (context.since && context.since.getTime() > context.now.getTime())
    return fail("since_in_future");
  const running = context.exports.find((e) => e.status === "queued" || e.status === "running");
  if (running) return fail("export_in_progress", running.id);
  return { ok: true };
}

/**
 * When a ready export stops being downloadable and its file is deleted (elapsed hours): the
 * tenant's setting, never beyond the Harbour ceiling `export.link_expiry_hours_max`.
 */
export function exportExpiresAt(
  readyAt: Date,
  rates: Pick<PlatformRates, "exportLinkExpiryHours" | "exportLinkExpiryHoursMax">,
): Date {
  const hours = Math.min(rates.exportLinkExpiryHours, rates.exportLinkExpiryHoursMax);
  return new Date(readyAt.getTime() + hours * 3_600_000);
}

export interface ExportView {
  readonly id: string;
  readonly status: ExportStatus;
  readonly requestedBy: string;
  readonly expiresAt: Date | null;
}

/** The status as of now: a ready export past its expiry is expired even before the job runs. */
export function exportStateAt(view: ExportView, now: Date): ExportStatus {
  if (
    view.status === "ready" &&
    (view.expiresAt === null || now.getTime() >= view.expiresAt.getTime())
  ) {
    return "expired";
  }
  return view.status;
}

export type ExportDownloadProblem =
  | "missing_permission"
  | "step_up_required"
  | "not_requester"
  | "not_ready"
  | "failed"
  | "expired"
  | "revoked";

export type ExportDownloadCheck =
  | { readonly ok: true; readonly urlLifetimeSeconds: number }
  | { readonly ok: false; readonly problem: ExportDownloadProblem; readonly message: string };

const DOWNLOAD_MESSAGES: Record<ExportDownloadProblem, string> = {
  missing_permission: "Only people who can export the organisation's data can download it.",
  step_up_required: "Sign in again with your second step to download the export.",
  not_requester:
    "Only the person who asked for this export can download it. Ask for your own: it is free.",
  not_ready: "The export is still being prepared.",
  failed: "This export could not be completed. Ask for a new one.",
  expired: "This export has expired and its file has been deleted. Ask for a new one: it is free.",
  revoked: "This export was cancelled. Ask for a new one if you need it.",
};

export interface ExportDownloadContext {
  readonly export: ExportView;
  readonly actorTenantUserId: string;
  readonly access: EffectiveAccess;
  readonly lastMfaSignInAt: Date | null;
  readonly now: Date;
  readonly stepUpWindowSeconds: number;
}

/**
 * Whether the export file may be handed over now (platform-completions.md rule 12; HZ-070): the
 * requester only, still holding `platform.export.create`, after an MFA sign-in within the step-up
 * window, while the export is ready and unexpired. The link in the notification is only a pointer
 * to this check; the API then streams the file or mints a storage URL lasting
 * `EXPORT_DOWNLOAD_URL_SECONDS`.
 */
export function checkExportDownload(context: ExportDownloadContext): ExportDownloadCheck {
  const fail = (problem: ExportDownloadProblem): ExportDownloadCheck => ({
    ok: false,
    problem,
    message: DOWNLOAD_MESSAGES[problem],
  });
  const decision = authorise(
    context.access,
    "platform.export.create",
    context.lastMfaSignInAt,
    context.now,
    context.stepUpWindowSeconds,
  );
  if (!decision.allowed) {
    return fail(decision.reason === "step_up_required" ? "step_up_required" : "missing_permission");
  }
  if (context.export.requestedBy !== context.actorTenantUserId) return fail("not_requester");
  const state = exportStateAt(context.export, context.now);
  if (state === "queued" || state === "running") return fail("not_ready");
  if (state !== "ready") return fail(state);
  return { ok: true, urlLifetimeSeconds: EXPORT_DOWNLOAD_URL_SECONDS };
}
