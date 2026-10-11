import { authorise, type EffectiveAccess } from "./access";
import type { BoundedContext } from "./permissions";
import type { PlatformRates } from "./rates";

/**
 * Free full tenant export (master prompt sections 5.1 and 9.1; DPA clause 9.1; data-standards.md
 * "Export and import conventions"; platform-completions.md rules 10 to 16; hazards HZ-070 and
 * HZ-071). A tenant can take all of its data, at any time, free, in a documented schema: one CSV
 * and one JSON Lines file per table, the documents, a schema description and a manifest with row
 * counts and SHA-256 checksums. These pure rules decide what goes in, describe it, check that what
 * was written is complete, and gate the request and the download.
 */

export const EXPORT_FORMAT = "harbour-tenant-export";
/** Bumped on any change to a mapped field, a code list or the export shape (data-standards.md). */
export const EXPORT_SCHEMA_VERSION = "1.0.0";
export const EXPORT_SCHEMA_FILE = "schema.json";
export const EXPORT_MANIFEST_FILE = "manifest.json";
export const EXPORT_DESTROYED_FILE = "destroyed.csv";
export const EXPORT_DOCUMENTS_FOLDER = "documents/";

export const EXPORT_COLUMN_TYPES = [
  "uuid",
  "text",
  "integer",
  "number",
  "boolean",
  "date",
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

/**
 * `tenant_rows`: every row of the tenant. `tenant_overrides_only`: global reference tables, where
 * only the tenant's own rows (overrides and templates) are its data. `not_exported`: not tenant
 * data, with the reason.
 */
export type ExportTreatment = "tenant_rows" | "tenant_overrides_only" | "not_exported";

/**
 * How long rows are kept: a record class from retention.md, or `tenant_configuration` (kept while
 * the tenant is a customer), `as_subject` (the class of the record it concerns), `by_category`
 * (documents) or `permanent` (proof of records management).
 */
export type ExportRetention =
  | "care_record"
  | "audit_event"
  | "serious_incident"
  | "tenant_configuration"
  | "as_subject"
  | "by_category"
  | "permanent"
  | "operational";

export interface ExportTableDefinition {
  readonly context: BoundedContext;
  readonly description: string;
  readonly treatment: ExportTreatment;
  readonly retention: ExportRetention;
  /** Holds personal data (records of processing). */
  readonly personal: boolean;
  /** Columns never exported: internal keys and secret references, never the tenant's records. */
  readonly omitColumns?: readonly string[];
  readonly reasonNotExported?: string;
}

/**
 * The typed table list the schema description is generated from. A table in the database but not
 * here is still exported, in full, and flagged as undocumented (completeness wins); the schema
 * step's test fails the build until it is added here (platform-completions.md rule 16).
 */
export const EXPORT_TABLES = {
  // platform
  tenant_group: {
    context: "platform",
    description: "The group the organisation belongs to, if any (name only).",
    treatment: "tenant_rows",
    retention: "tenant_configuration",
    personal: false,
  },
  tenant: {
    context: "platform",
    description:
      "The organisation: legal name, CQC provider ID, terminology, data protection officer, Caldicott Guardian and SIRO.",
    treatment: "tenant_rows",
    retention: "tenant_configuration",
    personal: true,
  },
  location: {
    context: "platform",
    description: "Locations with their regulator location ID, ODS code, nation and address.",
    treatment: "tenant_rows",
    retention: "tenant_configuration",
    personal: false,
  },
  service: {
    context: "platform",
    description: "Services run at each location, with their service type.",
    treatment: "tenant_rows",
    retention: "tenant_configuration",
    personal: false,
  },
  tenant_user: {
    context: "platform",
    description: "Staff and other users of the organisation: name, work email, job title, status.",
    treatment: "tenant_rows",
    retention: "tenant_configuration",
    personal: true,
    omitColumns: ["auth_user_id"],
  },
  role: {
    context: "platform",
    description: "The organisation's roles and the permissions in each version.",
    treatment: "tenant_rows",
    retention: "tenant_configuration",
    personal: false,
  },
  role_assignment: {
    context: "platform",
    description: "Who holds which role, where and for how long.",
    treatment: "tenant_rows",
    retention: "audit_event",
    personal: true,
  },
  access_grant: {
    context: "platform",
    description: "Time-boxed delegation and acting-up grants.",
    treatment: "tenant_rows",
    retention: "audit_event",
    personal: true,
  },
  feature_flag: {
    context: "platform",
    description: "Modules switched on or off for the organisation and its locations.",
    treatment: "tenant_rows",
    retention: "tenant_configuration",
    personal: false,
  },
  audit_event: {
    context: "platform",
    description:
      "The append-only, hash-chained audit trail: who did what, when, from where, with opaque record ids.",
    treatment: "tenant_rows",
    retention: "audit_event",
    personal: true,
  },
  outbox_event: {
    context: "platform",
    description: "Events passed between modules (opaque ids and kinds).",
    treatment: "tenant_rows",
    retention: "operational",
    personal: false,
  },
  escalation_chain: {
    context: "platform",
    description: "Notification escalation chains by role or user.",
    treatment: "tenant_rows",
    retention: "tenant_configuration",
    personal: false,
  },
  notification: {
    context: "platform",
    description: "In-app notifications with generic titles, read and acknowledged times.",
    treatment: "tenant_rows",
    retention: "as_subject",
    personal: true,
  },
  notification_preference: {
    context: "platform",
    description: "Users' quiet hours and channel choices.",
    treatment: "tenant_rows",
    retention: "tenant_configuration",
    personal: true,
  },
  form_template: {
    context: "platform",
    description:
      "The organisation's own form templates (Harbour's locked templates are cited by key and version).",
    treatment: "tenant_overrides_only",
    retention: "tenant_configuration",
    personal: false,
  },
  form_submission: {
    context: "platform",
    description: "Completed forms, pinned to the template version, with results and workings.",
    treatment: "tenant_rows",
    retention: "as_subject",
    personal: true,
  },
  rate_table: {
    context: "platform",
    description:
      "The organisation's own settings over Harbour's rate table (global rows are in rates.md).",
    treatment: "tenant_overrides_only",
    retention: "tenant_configuration",
    personal: false,
  },
  retention_class: {
    context: "platform",
    description: "The organisation's retention overrides (the defaults are in retention.md).",
    treatment: "tenant_overrides_only",
    retention: "tenant_configuration",
    personal: false,
  },
  bank_holiday: {
    context: "platform",
    description: "UK bank holidays.",
    treatment: "not_exported",
    retention: "operational",
    personal: false,
    reasonNotExported:
      "Global reference data with no organisation rows (published in calendar.md).",
  },
  document: {
    context: "platform",
    description:
      "Documents and their versions: category, title, display file name, type, size, SHA-256, scan result, status. The files are in documents/.",
    treatment: "tenant_rows",
    retention: "by_category",
    personal: true,
    omitColumns: ["storage_key"],
  },
  record_version: {
    context: "platform",
    description: "Every earlier version of every changed record.",
    treatment: "tenant_rows",
    retention: "as_subject",
    personal: true,
  },
  document_signature: {
    context: "platform",
    description: "Typed-name signatures bound to the SHA-256 of the version signed.",
    treatment: "tenant_rows",
    retention: "as_subject",
    personal: true,
  },
  legal_hold: {
    context: "platform",
    description: "Legal holds on people and records, with reasons, placed and released.",
    treatment: "tenant_rows",
    retention: "permanent",
    personal: true,
  },
  destruction_certificate: {
    context: "platform",
    description: "Certificates for records destroyed past retention (ids, class, rule, method).",
    treatment: "tenant_rows",
    retention: "permanent",
    personal: false,
  },
  task_series: {
    context: "platform",
    description: "Recurring task definitions.",
    treatment: "tenant_rows",
    retention: "as_subject",
    personal: true,
  },
  task: {
    context: "platform",
    description: "Tasks with owner, due window, status, reasons and evidence.",
    treatment: "tenant_rows",
    retention: "as_subject",
    personal: true,
  },
  workflow_instance: {
    context: "platform",
    description: "Workflow state of records such as incidents and exits.",
    treatment: "tenant_rows",
    retention: "as_subject",
    personal: true,
  },
  workflow_transition: {
    context: "platform",
    description: "Every workflow move, who made it and why (append-only).",
    treatment: "tenant_rows",
    retention: "as_subject",
    personal: true,
  },
  // people
  room: {
    context: "people",
    description: "Rooms and beds at each location.",
    treatment: "tenant_rows",
    retention: "tenant_configuration",
    personal: false,
  },
  person: {
    context: "people",
    description:
      "People receiving care: MODS-aligned demographics, NHS number, status, communication needs, national data opt-out.",
    treatment: "tenant_rows",
    retention: "care_record",
    personal: true,
  },
  contact: {
    context: "people",
    description: "Family, representatives and legal authorities for each person.",
    treatment: "tenant_rows",
    retention: "care_record",
    personal: true,
  },
  allergy: {
    context: "people",
    description: "Allergies and the allergy status.",
    treatment: "tenant_rows",
    retention: "care_record",
    personal: true,
  },
  placement: {
    context: "people",
    description: "Placements and their dates.",
    treatment: "tenant_rows",
    retention: "care_record",
    personal: true,
  },
  about_me: {
    context: "people",
    description: "About Me (PRSB About Me v2.01 sections).",
    treatment: "tenant_rows",
    retention: "care_record",
    personal: true,
  },
  person_assignment: {
    context: "people",
    description: "Which staff are assigned to which people, and when.",
    treatment: "tenant_rows",
    retention: "care_record",
    personal: true,
  },
  break_glass_event: {
    context: "people",
    description: "Records opened outside scope, with the typed justification and review.",
    treatment: "tenant_rows",
    retention: "audit_event",
    personal: true,
  },
  // care
  person_care_profile: {
    context: "care",
    description: "IDDSI levels, fluid target, SpO2 scale and skin risk for each person.",
    treatment: "tenant_rows",
    retention: "care_record",
    personal: true,
  },
  care_note: {
    context: "care",
    description: "Daily notes (append-only; corrections reference the original).",
    treatment: "tenant_rows",
    retention: "care_record",
    personal: true,
  },
  observation: {
    context: "care",
    description: "Charts and vital signs, with device and server times.",
    treatment: "tenant_rows",
    retention: "care_record",
    personal: true,
  },
  body_map_mark: {
    context: "care",
    description: "Body-map marks with side and site.",
    treatment: "tenant_rows",
    retention: "care_record",
    personal: true,
  },
  care_plan: {
    context: "care",
    description: "Care plans (PRSB personalised care and support plan) and their versions.",
    treatment: "tenant_rows",
    retention: "care_record",
    personal: true,
  },
  care_plan_section: {
    context: "care",
    description: "Care plan sections by need domain.",
    treatment: "tenant_rows",
    retention: "care_record",
    personal: true,
  },
  risk_assessment: {
    context: "care",
    description: "Risk assessments with controls and residual risk.",
    treatment: "tenant_rows",
    retention: "care_record",
    personal: true,
  },
  care_plan_action: {
    context: "care",
    description: "Care plan actions and the tasks they generate.",
    treatment: "tenant_rows",
    retention: "care_record",
    personal: true,
  },
  assessment: {
    context: "care",
    description:
      "Validated tool results (MUST, Waterlow, Braden, falls) with answers and workings.",
    treatment: "tenant_rows",
    retention: "care_record",
    personal: true,
  },
  activity_record: {
    context: "care",
    description: "Activities and attendance.",
    treatment: "tenant_rows",
    retention: "care_record",
    personal: true,
  },
  visit_log: {
    context: "care",
    description: "Visits, visits out and accompaniments.",
    treatment: "tenant_rows",
    retention: "care_record",
    personal: true,
  },
  advance_care_record: {
    context: "care",
    description: "ReSPECT, DNACPR, ADRT and advance care plans.",
    treatment: "tenant_rows",
    retention: "care_record",
    personal: true,
  },
  // integrations
  integration_connection: {
    context: "integrations",
    description: "Which provider each integration uses (credentials stay in the secret store).",
    treatment: "tenant_rows",
    retention: "tenant_configuration",
    personal: false,
    omitColumns: ["secret_ref"],
  },
  integration_inbound: {
    context: "integrations",
    description: "Data received from partners, with validation problems and resolutions.",
    treatment: "tenant_rows",
    retention: "as_subject",
    personal: true,
  },
  notification_delivery: {
    context: "integrations",
    description: "Email, SMS and push deliveries of notifications.",
    treatment: "tenant_rows",
    retention: "as_subject",
    personal: true,
  },
  // operator
  operator_user: {
    context: "platform",
    description: "Thapsus support staff.",
    treatment: "not_exported",
    retention: "operational",
    personal: true,
    reasonNotExported:
      "Thapsus's own staff records (Thapsus is their controller), not organisation data.",
  },
  support_access_request: {
    context: "platform",
    description: "Thapsus support access requests and the organisation's decisions.",
    treatment: "tenant_rows",
    retention: "audit_event",
    personal: true,
  },
} as const satisfies Record<string, ExportTableDefinition>;

export type ExportTableName = keyof typeof EXPORT_TABLES;

/** Schemas whose tables are never exported, with the reason. */
export const EXPORT_EXCLUDED_SCHEMAS: Readonly<Record<string, string>> = {
  auth: "Passwords, sessions, passkeys and authenticator secrets are never exported; staff identities are in tenant_user.",
};

function definitionOf(name: string): ExportTableDefinition | undefined {
  return Object.hasOwn(EXPORT_TABLES, name)
    ? (EXPORT_TABLES as Record<string, ExportTableDefinition>)[name]
    : undefined;
}

export type ExportCatalogueProblem =
  | { readonly table: string; readonly problem: "not_in_catalogue" | "not_in_database" }
  | { readonly table: string; readonly problem: "omitted_column_missing"; readonly column: string };

/**
 * Compares the catalogue with the database's tables. The schema step runs this in a test against
 * the live schema so a new table cannot ship undescribed, and an omitted column that was renamed
 * cannot slip back into the export.
 */
export function checkExportCatalogue(tables: readonly DatabaseTable[]): ExportCatalogueProblem[] {
  const problems: ExportCatalogueProblem[] = [];
  const publicTables = tables.filter((t) => !(t.schema in EXPORT_EXCLUDED_SCHEMAS));
  for (const table of publicTables) {
    const definition = definitionOf(table.name);
    if (!definition) {
      problems.push({ table: table.name, problem: "not_in_catalogue" });
      continue;
    }
    for (const column of definition.omitColumns ?? []) {
      if (!table.columns.some((c) => c.name === column)) {
        problems.push({ table: table.name, problem: "omitted_column_missing", column });
      }
    }
  }
  for (const name of Object.keys(EXPORT_TABLES)) {
    if (!publicTables.some((t) => t.name === name)) {
      problems.push({ table: name, problem: "not_in_database" });
    }
  }
  return problems;
}

export interface PlannedExportTable {
  readonly name: string;
  readonly context: BoundedContext | null;
  readonly description: string;
  readonly selection: "tenant_rows" | "tenant_overrides_only";
  readonly retention: ExportRetention | null;
  readonly personal: boolean;
  readonly columns: readonly ExportColumn[];
  readonly omittedColumns: readonly string[];
  /** False for a table missing from the catalogue: exported in full, flagged in the manifest. */
  readonly documented: boolean;
  readonly files: { readonly csv: string; readonly jsonl: string };
}

export interface ExportPlan {
  readonly schemaVersion: string;
  readonly tables: readonly PlannedExportTable[];
  readonly notExported: readonly { readonly name: string; readonly reason: string }[];
}

/** Which tables go in, with which columns and files, from the database's own table list. */
export function planExport(tables: readonly DatabaseTable[]): ExportPlan {
  const planned: PlannedExportTable[] = [];
  const notExported: { name: string; reason: string }[] = [];
  const sorted = [...tables].sort(
    (a, b) => a.schema.localeCompare(b.schema) || a.name.localeCompare(b.name),
  );
  for (const table of sorted) {
    const excludedSchema = EXPORT_EXCLUDED_SCHEMAS[table.schema];
    if (excludedSchema !== undefined) {
      notExported.push({ name: `${table.schema}.${table.name}`, reason: excludedSchema });
      continue;
    }
    const definition = definitionOf(table.name);
    if (definition?.treatment === "not_exported") {
      notExported.push({ name: table.name, reason: definition.reasonNotExported ?? "" });
      continue;
    }
    if (!definition && !table.hasTenantId) {
      notExported.push({
        name: table.name,
        reason: "No organisation column, so no organisation rows.",
      });
      continue;
    }
    const omit = definition?.omitColumns ?? [];
    planned.push({
      name: table.name,
      context: definition?.context ?? null,
      description: definition?.description ?? "Not yet described in the export catalogue.",
      selection:
        definition?.treatment === "tenant_overrides_only" ? "tenant_overrides_only" : "tenant_rows",
      retention: definition?.retention ?? null,
      personal: definition?.personal ?? true,
      columns: table.columns.filter((c) => !omit.includes(c.name)),
      omittedColumns: omit.filter((c) => table.columns.some((col) => col.name === c)),
      documented: definition !== undefined,
      files: { csv: `tables/${table.name}.csv`, jsonl: `tables/${table.name}.jsonl` },
    });
  }
  return { schemaVersion: EXPORT_SCHEMA_VERSION, tables: planned, notExported };
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
  if (row.destroyed)
    return { action: "list_as_destroyed", certificateId: row.destroyed.certificateId };
  if (row.sample) return { action: "exclude", reason: "sample" };
  if (row.legalHold) return { action: "include", reason: "legal_hold" };
  if (row.deletedAt) return { action: "exclude", reason: "soft_deleted" };
  return { action: "include", reason: "live" };
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
  const row = exportRowDecision(
    doc.status === "destroyed" && doc.destroyed === null
      ? { ...doc, destroyed: { at: doc.deletedAt ?? new Date(0), certificateId: null } }
      : doc,
  );
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
// Schema description
// ------------------------------------------------------------------------------------------------

type JsonSchema = Readonly<Record<string, unknown>>;

function columnSchema(column: ExportColumn): JsonSchema {
  const base: Record<ExportColumnType, JsonSchema> = {
    uuid: { type: "string", format: "uuid" },
    text: { type: "string" },
    integer: { type: "integer" },
    number: { type: "number" },
    boolean: { type: "boolean" },
    date: { type: "string", format: "date" },
    timestamp: { type: "string", format: "date-time" },
    json: { type: ["object", "array"] },
    uuid_array: { type: "array", items: { type: "string", format: "uuid" } },
    text_array: { type: "array", items: { type: "string" } },
    enum: { type: "string", enum: column.enumValues ?? [] },
  };
  const schema = base[column.type];
  if (!column.nullable) return schema;
  if (column.type === "enum")
    return { ...schema, type: ["string", "null"], enum: [...(column.enumValues ?? []), null] };
  const type = schema.type;
  return { ...schema, type: Array.isArray(type) ? [...type, "null"] : [type, "null"] };
}

/**
 * The documented schema shipped as schema.json in every export: each table's purpose, context,
 * retention and a JSON Schema (2020-12) for its rows, generated from the plan, so the description
 * can never drift from what was exported.
 */
export function describeExportSchema(plan: ExportPlan): JsonSchema {
  return {
    $schema: "https://json-schema.org/draft/2020-12/schema",
    title: "Harbour full organisation export",
    format: EXPORT_FORMAT,
    schemaVersion: plan.schemaVersion,
    conventions: {
      files:
        "One CSV (RFC 4180, UTF-8, header row) and one JSON Lines file per table, under tables/.",
      timestamps: "ISO 8601 in UTC with Z.",
      dates: "YYYY-MM-DD.",
      empty: "An empty CSV cell and JSON null both mean not recorded.",
      documents: "documents/<document id>.<extension>, checksums in manifest.json.",
      destroyed: `${EXPORT_DESTROYED_FILE} lists records destroyed past retention with their certificate id.`,
      mapping: "Field meanings and code lists: Harbour data-standards.md for this schema version.",
    },
    tables: Object.fromEntries(
      plan.tables.map((t) => [
        t.name,
        {
          description: t.description,
          context: t.context,
          retention: t.retention,
          personalData: t.personal,
          documented: t.documented,
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
  readonly plan: ExportPlan;
  readonly schemaFile: { readonly sha256: string; readonly bytes: number };
  readonly tables: readonly WrittenTable[];
  readonly documents: readonly WrittenDocument[];
  readonly destroyed: readonly DestroyedRecord[];
  readonly auditChain: { readonly verified: boolean; readonly firstBrokenPosition: number | null };
}

/** A problem makes the export incomplete: it is never offered for download (HZ-071). */
export type ExportManifestProblem =
  | { readonly kind: "table_missing"; readonly table: string }
  | { readonly kind: "unexpected_table"; readonly table: string }
  | { readonly kind: "file_missing"; readonly table: string; readonly format: "csv" | "jsonl" }
  | {
      readonly kind: "row_count_mismatch";
      readonly table: string;
      readonly format: "csv" | "jsonl";
    }
  | { readonly kind: "document_not_written"; readonly id: string }
  | { readonly kind: "document_checksum_mismatch"; readonly id: string };

/** A warning is shown in the manifest and on the download page, and does not block it. */
export type ExportManifestWarning =
  | { readonly kind: "undocumented_table"; readonly table: string }
  | { readonly kind: "audit_chain_broken"; readonly position: number | null }
  | { readonly kind: "destroyed_without_certificate"; readonly table: string; readonly id: string };

export interface ExportManifest {
  readonly format: string;
  readonly schemaVersion: string;
  readonly exportId: string;
  readonly tenantId: string;
  readonly requestedBy: string;
  readonly generatedAt: string;
  readonly schema: { readonly path: string; readonly sha256: string; readonly bytes: number };
  readonly tables: readonly {
    readonly name: string;
    readonly documented: boolean;
    readonly rows: number;
    readonly legalHoldRows: number;
    readonly excluded: { readonly softDeleted: number; readonly sample: number };
    readonly files: readonly WrittenFile[];
  }[];
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
 * has both files with the counted rows, and every document's bytes match the checksum recorded at
 * upload. An incomplete export is marked failed and retried, never delivered as if whole.
 */
export function buildExportManifest(input: ExportManifestInput): ExportManifest {
  const problems: ExportManifestProblem[] = [];
  const warnings: ExportManifestWarning[] = [];

  for (const planned of input.plan.tables) {
    const written = input.tables.find((t) => t.name === planned.name);
    if (!planned.documented) warnings.push({ kind: "undocumented_table", table: planned.name });
    if (!written) {
      problems.push({ kind: "table_missing", table: planned.name });
      continue;
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
    exportId: input.exportId,
    tenantId: input.tenantId,
    requestedBy: input.requestedBy,
    generatedAt: input.generatedAt.toISOString(),
    schema: { path: EXPORT_SCHEMA_FILE, ...input.schemaFile },
    tables: input.plan.tables.map((planned) => {
      const written = input.tables.find((t) => t.name === planned.name);
      return {
        name: planned.name,
        documented: planned.documented,
        rows: written?.included ?? 0,
        legalHoldRows: written?.legalHoldRows ?? 0,
        excluded: written?.excluded ?? { softDeleted: 0, sample: 0 },
        files: written?.files ?? [],
      };
    }),
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
  | "data_purged";

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
  step_up_required: "Sign in again to export the organisation's data.",
  export_in_progress: "An export is already being prepared. You will be told when it is ready.",
  data_purged: "This organisation's data has been deleted at the end of its contract.",
};

export interface ExportRequestContext {
  readonly access: EffectiveAccess;
  readonly lastStrongAuthAt: Date | null;
  readonly now: Date;
  readonly stepUpWindowSeconds: number;
  /** Any status, including suspended or closed: the export is free and never withheld. */
  readonly tenant: { readonly status: string; readonly dataPurgedAt: Date | null };
  readonly exports: readonly { readonly id: string; readonly status: ExportStatus }[];
}

/**
 * Whether an export may start (platform-completions.md rules 13 and 15): `platform.export.create`
 * with a fresh sign-in. It is free, so nothing about the plan, payments or a suspended or ended
 * contract stops it until the data is deleted (DPA clause 9). The only limit is abuse protection:
 * one export at a time per organisation; asking again returns the one being prepared.
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
    context.lastStrongAuthAt,
    context.now,
    context.stepUpWindowSeconds,
  );
  if (!decision.allowed)
    return fail(decision.reason === "step_up_required" ? "step_up_required" : "missing_permission");
  if (context.tenant.dataPurgedAt !== null) return fail("data_purged");
  const running = context.exports.find((e) => e.status === "queued" || e.status === "running");
  if (running) return fail("export_in_progress", running.id);
  return { ok: true };
}

/** When a ready export stops being downloadable and its file is deleted (elapsed hours). */
export function exportExpiresAt(
  readyAt: Date,
  rates: Pick<PlatformRates, "exportLinkExpiryHours">,
): Date {
  return new Date(readyAt.getTime() + rates.exportLinkExpiryHours * 3_600_000);
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
  | { readonly ok: true }
  | { readonly ok: false; readonly problem: ExportDownloadProblem; readonly message: string };

const DOWNLOAD_MESSAGES: Record<ExportDownloadProblem, string> = {
  missing_permission: "Only people who can export the organisation's data can download it.",
  step_up_required: "Sign in again to download the export.",
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
  readonly lastStrongAuthAt: Date | null;
  readonly now: Date;
  readonly stepUpWindowSeconds: number;
}

/**
 * Whether the export file may be handed over now (platform-completions.md rule 12; HZ-070): the
 * requester only, still holding `platform.export.create`, signed in again within the step-up
 * window, while the export is ready and unexpired. The link in the notification is only a pointer
 * to this check; the API then streams the file or mints a storage URL that lasts minutes.
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
    context.lastStrongAuthAt,
    context.now,
    context.stepUpWindowSeconds,
  );
  if (!decision.allowed)
    return fail(decision.reason === "step_up_required" ? "step_up_required" : "missing_permission");
  if (context.export.requestedBy !== context.actorTenantUserId) return fail("not_requester");
  const state = exportStateAt(context.export, context.now);
  if (state === "queued" || state === "running") return fail("not_ready");
  if (state !== "ready") return fail(state);
  return { ok: true };
}
