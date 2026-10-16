/// <reference types="node" />
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { readRateTable, tablePlatformRates } from "../../test/rate-table";
import type { AdvanceCareRecordState } from "../care/advance-care";
import type { AllergyStatement, CommunicationStatement } from "../people/transfer-pack";
import { type EffectiveAccess, resolveAccess } from "./access";
import {
  buildExportManifest,
  CLINICAL_EXPORT_TABLES,
  CURRENT_SUMMARY_COLUMNS,
  checkExportCatalogue,
  checkExportDownload,
  checkExportRequest,
  columnTypeFromSql,
  csvCell,
  csvRow,
  csvTextValue,
  currentSummaryRow,
  type DatabaseTable,
  describeExportSchema,
  documentChecksumMatches,
  documentExportPath,
  EXPORT_CONVENTIONS,
  EXPORT_DOWNLOAD_URL_SECONDS,
  EXPORT_SCHEMA_VERSION,
  EXPORT_TABLES,
  type ExportColumn,
  type ExportDocumentRow,
  type ExportManifestInput,
  type ExportRequestContext,
  type ExportRowState,
  type ExportStatus,
  exportDocumentDecision,
  exportExpiresAt,
  exportRowChangedSince,
  exportRowDecision,
  exportStateAt,
  exportStoragePrefix,
  OBSERVATION_VALUES_SCHEMA,
  planExport,
  resolveColumnDoc,
  ukDateOfInstant,
  ukLocalTimestamp,
  type WrittenDocument,
  type WrittenFile,
  type WrittenTable,
} from "./export";
import { resolvePlatformRates } from "./rates";
import { builtinRole } from "./roles";

const NOW = new Date("2026-10-11T10:00:00Z");
const PAST = new Date("2026-01-01T00:00:00Z");
const STEP_UP_SECONDS = 600;
const RATES = tablePlatformRates();
const SHA_A = "a".repeat(64);
const SHA_B = "b".repeat(64);
const DOC_ID = "0193a000-0000-7000-8000-0000000000d1";
const TENANT = "0193a000-0000-7000-8000-0000000000a1";
const EXPORT = "0193a000-0000-7000-8000-0000000000e1";

function accessFor(roleKey: string): EffectiveAccess {
  const role = builtinRole(roleKey);
  if (!role) throw new Error(roleKey);
  return resolveAccess(
    [
      {
        roleKey,
        scopeKind: role.scopeKind,
        permissions: role.permissions,
        locationId: null,
        organisationWide: true,
        validFrom: PAST,
        validTo: null,
      },
    ],
    [],
    NOW,
  );
}

const ID: ExportColumn = { name: "id", type: "uuid", nullable: false };
const TENANT_ID: ExportColumn = { name: "tenant_id", type: "uuid", nullable: false };

/** The database as the catalogue describes it, every column text unless the test needs a type. */
function catalogueDatabase(): DatabaseTable[] {
  const tables: DatabaseTable[] = Object.entries(EXPORT_TABLES).map(([key, def]) => ({
    schema: "public",
    name: key.slice("public.".length),
    hasTenantId: def.treatment !== "not_exported",
    columns: Object.keys(def.columns).map(
      (name): ExportColumn => ({
        name,
        type: key === "public.person" && name === "deceased_at" ? "timestamp" : "text",
        nullable: true,
      }),
    ),
  }));
  tables.push({ schema: "auth", name: "user", hasTenantId: false, columns: [ID] });
  tables.push({ schema: "pgboss", name: "job", hasTenantId: false, columns: [ID] });
  return tables;
}

describe("hazard HZ-071 the export catalogue describes every table and column", () => {
  it("keys every table by schema and table, all in the public schema", () => {
    for (const key of Object.keys(EXPORT_TABLES)) expect(key).toMatch(/^public\.[a-z][a-z0-9_]*$/);
  });

  it("describes every table, with a reason and no columns for each one it leaves out", () => {
    for (const [key, def] of Object.entries(EXPORT_TABLES)) {
      expect(def.description.length, key).toBeGreaterThan(10);
      if (def.treatment === "not_exported") {
        expect(def.reasonNotExported?.length ?? 0, key).toBeGreaterThan(10);
        expect(Object.keys(def.columns), key).toEqual([]);
      } else {
        expect(Object.keys(def.columns), key).toEqual(expect.arrayContaining(["id"]));
      }
    }
  });

  it("gives every classified column a description", () => {
    for (const [key, def] of Object.entries(EXPORT_TABLES)) {
      for (const column of Object.keys(def.columns)) {
        expect(
          resolveColumnDoc(def, column)?.description.length ?? 0,
          `${key}.${column}`,
        ).toBeGreaterThan(5);
      }
    }
  });

  it("describes every column of a care-record table explicitly, never by a name pattern alone", () => {
    for (const key of CLINICAL_EXPORT_TABLES) {
      const def = EXPORT_TABLES[key];
      expect(def, key).toBeDefined();
      if (!def) continue;
      for (const column of Object.keys(def.columns)) {
        expect(resolveColumnDoc(def, column)?.source, `${key}.${column}`).not.toBe("suffix");
      }
    }
  });

  it("documents what each allergy status means, so unknown is never read as none", () => {
    const doc = resolveColumnDoc(EXPORT_TABLES["public.person"] as never, "allergy_status");
    expect(Object.keys(doc?.codes ?? {}).sort()).toEqual([
      "has_allergies",
      "no_known_allergies",
      "unknown",
    ]);
    expect(doc?.codes?.unknown).toContain("Never read as no allergies");
  });

  it.each<[string, string, string]>([
    ["public.document", "storage_key", "internal"],
    ["public.tenant_user", "auth_user_id", "internal"],
    ["public.integration_connection", "secret_ref", "secret"],
    ["public.person", "nhs_number", "exported"],
  ])("classifies %s.%s as %s", (table, column, cls) => {
    expect(resolveColumnDoc(EXPORT_TABLES[table] as never, column)?.class).toBe(cls);
  });

  it("returns nothing for a column the catalogue does not classify", () => {
    expect(resolveColumnDoc(EXPORT_TABLES["public.person"] as never, "api_token")).toBeNull();
  });

  it("finds nothing wrong when the database matches the catalogue", () => {
    expect(checkExportCatalogue(catalogueDatabase())).toEqual([]);
  });

  it("reports a new table, a new column, a missing table and a missing column", () => {
    const db = catalogueDatabase()
      .filter((t) => t.name !== "allergy")
      .map((t) => {
        if (t.name === "tenant_user")
          return {
            ...t,
            columns: [...t.columns, { name: "api_token", type: "text" as const, nullable: true }],
          };
        if (t.name === "document")
          return { ...t, columns: t.columns.filter((c) => c.name !== "storage_key") };
        return t;
      });
    db.push({
      schema: "public",
      name: "new_register",
      hasTenantId: true,
      columns: [ID, TENANT_ID],
    });
    expect(checkExportCatalogue(db)).toEqual(
      expect.arrayContaining([
        { table: "public.new_register", problem: "not_in_catalogue" },
        { table: "public.allergy", problem: "not_in_database" },
        { table: "public.tenant_user", problem: "column_not_classified", column: "api_token" },
        { table: "public.document", problem: "classified_column_missing", column: "storage_key" },
      ]),
    );
  });
});

describe("column types from the database", () => {
  it.each<[string, string[] | null, string]>([
    ["uuid", null, "uuid"],
    ["uuid[]", null, "uuid_array"],
    ["text[]", null, "text_array"],
    ["integer", null, "integer"],
    ["bigint", null, "integer"],
    ["numeric(6, 1)", null, "number"],
    ["boolean", null, "boolean"],
    ["date", null, "date"],
    ["time", null, "time"],
    ["timestamp with time zone", null, "timestamp"],
    ["jsonb", null, "json"],
    ["inet", null, "text"],
    ["text", null, "text"],
    ["allergy_status", ["unknown", "no_known_allergies", "has_allergies"], "enum"],
  ])("%s is %s", (sql, values, expected) => {
    expect(columnTypeFromSql(sql, values)).toBe(expected);
  });
});

describe("hazard HZ-070 export plan reads only what may leave", () => {
  const plan = planExport(catalogueDatabase());
  const table = (name: string) => plan.tables.find((t) => t.name === name);

  it.each([
    ["auth.user", "Passwords"],
    ["pgboss.job", "Only the public schema"],
    ["public.bank_holiday", "Global reference data"],
    ["public.operator_user", "Thapsus's own staff"],
  ])("leaves %s out with the reason", (name, reason) => {
    expect(plan.notExported.find((n) => n.name === name)?.reason).toContain(reason);
  });

  it.each([
    ["rate_table", "tenant_overrides_only"],
    ["retention_class", "tenant_overrides_only"],
    ["form_template", "tenant_overrides_only"],
    ["person", "tenant_rows"],
    ["audit_event", "tenant_rows"],
  ])("selects %s as %s", (name, selection) => {
    expect(table(name)?.selection).toBe(selection);
  });

  it.each([
    ["document", "storage_key", ["storage_key", "search_title"]],
    ["integration_connection", "secret_ref", ["secret_ref"]],
    ["tenant_user", "auth_user_id", ["auth_user_id", "search_name"]],
    // Search vectors (migration 0065) are rebuilt from the exported columns.
    ["person", "search_names", ["search_names", "search_room"]],
    ["care_note", "search_body", ["search_body"]],
  ])("never exports %s.%s", (name, column, omitted) => {
    expect(table(name)?.columns.map((c) => c.name)).not.toContain(column);
    expect(table(name)?.omittedColumns).toEqual(omitted);
  });

  it("adds the UK date of the date of death beside the instant (HZ-071)", () => {
    const columns = table("person")?.columns.map((c) => c.name) ?? [];
    expect(columns).toEqual(expect.arrayContaining(["deceased_at", "deceased_at_uk_date"]));
    expect(table("person")?.columns.find((c) => c.name === "deceased_at_uk_date")).toMatchObject({
      type: "date",
      derivedFrom: "deceased_at",
    });
  });

  it("names one CSV and one JSON Lines file per table and is a full export by default", () => {
    expect(table("person")?.files).toEqual({
      csv: "tables/person.csv",
      jsonl: "tables/person.jsonl",
    });
    expect(plan).toMatchObject({
      schemaVersion: EXPORT_SCHEMA_VERSION,
      kind: "full",
      since: null,
      unclassified: [],
    });
  });

  it("is a changes-since export when given the earlier snapshot", () => {
    expect(planExport(catalogueDatabase(), { since: PAST })).toMatchObject({
      kind: "changes_since",
      since: PAST,
    });
  });

  it("never writes an unclassified table or column, and records them so the export is incomplete", () => {
    const db = catalogueDatabase().map((t) =>
      t.name === "tenant_user"
        ? {
            ...t,
            columns: [...t.columns, { name: "api_token", type: "text" as const, nullable: true }],
          }
        : t,
    );
    db.push({
      schema: "public",
      name: "new_register",
      hasTenantId: true,
      columns: [ID, TENANT_ID],
    });
    const extra = planExport(db);
    expect(extra.tables.find((t) => t.name === "new_register")).toBeUndefined();
    expect(
      extra.tables.find((t) => t.name === "tenant_user")?.columns.map((c) => c.name),
    ).not.toContain("api_token");
    expect(extra.unclassified).toEqual(
      expect.arrayContaining([
        { table: "public.new_register", columns: ["id", "tenant_id"] },
        { table: "public.tenant_user", columns: ["api_token"] },
      ]),
    );
  });
});

describe("hazard HZ-071 which rows go into the export", () => {
  const live: ExportRowState = {
    deletedAt: null,
    legalHold: false,
    destroyed: null,
    sample: false,
  };
  const destroyed = { at: PAST, certificateId: "cert-1" };

  it.each<[string, Partial<ExportRowState>, ReturnType<typeof exportRowDecision>]>([
    ["a live record", {}, { action: "include", reason: "live" }],
    ["a record under legal hold", { legalHold: true }, { action: "include", reason: "legal_hold" }],
    ["a soft-deleted record", { deletedAt: PAST }, { action: "exclude", reason: "soft_deleted" }],
    [
      "a soft-deleted record under legal hold",
      { deletedAt: PAST, legalHold: true },
      { action: "include", reason: "legal_hold" },
    ],
    ["a destroyed record", { destroyed }, { action: "list_as_destroyed", certificateId: "cert-1" }],
    [
      "a destroyed record still flagged as held",
      { destroyed, legalHold: true },
      { action: "list_as_destroyed", certificateId: "cert-1" },
    ],
    ["sample data", { sample: true }, { action: "exclude", reason: "sample" }],
    [
      "deleted sample data",
      { sample: true, deletedAt: PAST },
      { action: "exclude", reason: "sample" },
    ],
  ])("%s", (_label, extra, expected) => {
    expect(exportRowDecision({ ...live, ...extra })).toEqual(expected);
  });

  const since = new Date("2026-10-01T00:00:00Z");
  const before = new Date("2026-09-01T00:00:00Z");
  const after = new Date("2026-10-05T00:00:00Z");
  it.each<[string, Parameters<typeof exportRowChangedSince>[0], boolean]>([
    ["created before and untouched", { createdAt: before }, false],
    ["created after", { createdAt: after }, true],
    ["created at the snapshot", { createdAt: since }, true],
    ["changed after", { createdAt: before, updatedAt: after }, true],
    ["recorded after", { createdAt: before, recordedAt: after }, true],
    ["deleted after", { createdAt: before, deletedAt: after }, true],
    ["destroyed after", { createdAt: before, destroyedAt: after }, true],
    ["no dates", { createdAt: null }, false],
  ])("changes since the snapshot: %s", (_label, row, expected) => {
    expect(exportRowChangedSince(row, since)).toBe(expected);
  });
});

describe("documents and storage in the export", () => {
  it.each([
    ["application/pdf", "pdf"],
    ["image/jpeg", "jpg"],
    ["image/png", "png"],
    ["image/webp", "webp"],
    ["application/octet-stream", "bin"],
  ])("names a %s file by its id only", (type, ext) => {
    expect(documentExportPath(DOC_ID.toUpperCase(), type)).toBe(`documents/${DOC_ID}.${ext}`);
  });

  it.each([
    "../../etc/passwd",
    "Ada Example letter.pdf",
    "",
    `${DOC_ID}x`,
    "0193a000-0000-7000-8000-0000000000g1",
  ])("refuses a path built from anything but a UUID: %s", (id) => {
    expect(() => documentExportPath(id, "application/pdf")).toThrow(RangeError);
  });

  it("stores each export under the organisation's own prefix (HZ-070)", () => {
    expect(exportStoragePrefix(TENANT, EXPORT)).toBe(`tenants/${TENANT}/exports/${EXPORT}/`);
    expect(() => exportStoragePrefix("../other", EXPORT)).toThrow(RangeError);
    expect(() => exportStoragePrefix(TENANT, "x")).toThrow(RangeError);
  });

  const doc = (extra: Partial<ExportDocumentRow> = {}): ExportDocumentRow => ({
    id: DOC_ID,
    contentType: "application/pdf",
    sha256: SHA_A.toUpperCase(),
    sizeBytes: 2048,
    status: "available",
    deletedAt: null,
    legalHold: false,
    destroyed: null,
    sample: false,
    ...extra,
  });

  it.each<[string, Partial<ExportDocumentRow>, ReturnType<typeof exportDocumentDecision>]>([
    [
      "an available file",
      {},
      { action: "include_bytes", path: `documents/${DOC_ID}.pdf`, sha256: SHA_A, bytes: 2048 },
    ],
    [
      "a quarantined file keeps its row but not its bytes",
      { status: "quarantined" },
      { action: "omit_bytes", reason: "quarantined" },
    ],
    [
      "a quarantined file under legal hold",
      { status: "quarantined", legalHold: true },
      { action: "omit_bytes", reason: "quarantined" },
    ],
    [
      "a destroyed file with its certificate",
      { status: "destroyed", destroyed: { at: PAST, certificateId: "cert-9" } },
      { action: "list_as_destroyed", certificateId: "cert-9" },
    ],
    [
      "a destroyed file without a tombstone",
      { status: "destroyed" },
      { action: "list_as_destroyed", certificateId: null },
    ],
    [
      "a destroyed file deleted earlier",
      { status: "destroyed", deletedAt: PAST },
      { action: "list_as_destroyed", certificateId: null },
    ],
    ["a soft-deleted file", { deletedAt: PAST }, { action: "exclude", reason: "soft_deleted" }],
    ["a sample file", { sample: true }, { action: "exclude", reason: "sample" }],
  ])("%s", (_label, extra, expected) => {
    expect(exportDocumentDecision(doc(extra))).toEqual(expected);
  });

  it.each<[string, string, string | null, boolean]>([
    ["the same checksum", SHA_A, SHA_A, true],
    ["the same checksum in capitals", SHA_A, SHA_A.toUpperCase(), true],
    ["a different checksum", SHA_A, SHA_B, false],
    ["nothing written", SHA_A, null, false],
    ["a malformed recorded checksum", "abc", "abc", false],
  ])("checksum check: %s", (_label, expected, actual, ok) => {
    expect(documentChecksumMatches(expected, actual)).toBe(ok);
  });
});

describe("hazard HZ-070 CSV cells cannot run as spreadsheet formulas", () => {
  it.each<[string, unknown, string]>([
    ["empty", null, ""],
    ["undefined", undefined, ""],
    ["a negative number stays a number", -5, "-5"],
    ["a big integer", 12n, "12"],
    ["a boolean", true, "true"],
    ["an instant", new Date("2026-10-11T10:00:00Z"), "2026-10-11T10:00:00.000Z"],
    ["plain text", "Ada Example", "Ada Example"],
    ["a formula", "=SUM(A1:A9)", "'=SUM(A1:A9)"],
    ["a plus sign", "+447700900123", "'+447700900123"],
    ["a minus sign in text", "-5", "'-5"],
    ["an at sign", "@cmd", "'@cmd"],
    ["a leading tab", "\tx", "'\tx"],
    ["a leading carriage return", "\rx", '"\'\rx"'],
    ["text that already starts with an apostrophe", "'quoted", "''quoted"],
    ["a comma", "a, b", '"a, b"'],
    ["a quote", 'say "hi"', '"say ""hi"""'],
    ["a new line", "line one\nline two", '"line one\nline two"'],
    ["an object", { ml: 200 }, '"{""ml"":200}"'],
  ])("%s", (_label, value, expected) => {
    expect(csvCell(value)).toBe(expected);
  });

  it.each(["=SUM(A1)", "+44", "-5", "@x", "\tx", "'quoted", "''double", "plain", "", "'a"])(
    "undoes the guard exactly for %j",
    (text) => {
      const cell = csvCell(text);
      const unquoted = cell.startsWith('"') ? cell.slice(1, -1).replaceAll('""', '"') : cell;
      expect(csvTextValue(unquoted)).toBe(text);
    },
  );

  it("joins cells into a row", () => {
    expect(csvRow(["p-1", "=1+1", 3, null])).toBe("p-1,'=1+1,3,");
  });

  it("says so in schema.json", () => {
    expect(EXPORT_CONVENTIONS.csvFormulas).toContain("JSON Lines files hold the exact values");
  });
});

describe("hazard HZ-071 UK dates and times in the export", () => {
  it.each<[string, Date | null, string | null]>([
    [
      "a summer death late in the evening is the next UK day",
      new Date("2026-07-01T23:30:00Z"),
      "2026-07-02",
    ],
    [
      "a winter death late in the evening is the same day",
      new Date("2026-01-15T23:30:00Z"),
      "2026-01-15",
    ],
    ["nothing recorded", null, null],
  ])("%s", (_label, instant, expected) => {
    expect(ukDateOfInstant(instant)).toBe(expected);
  });

  it.each<[string, Date, string, "BST" | "GMT"]>([
    ["summer", new Date("2026-07-01T09:05:07Z"), "2026-07-01T10:05:07+01:00", "BST"],
    ["winter", new Date("2026-01-15T09:05:00Z"), "2026-01-15T09:05:00+00:00", "GMT"],
    [
      "the first 01:30 on the autumn clock change",
      new Date("2026-10-25T00:30:00Z"),
      "2026-10-25T01:30:00+01:00",
      "BST",
    ],
    [
      "the second 01:30 on the autumn clock change",
      new Date("2026-10-25T01:30:00Z"),
      "2026-10-25T01:30:00+00:00",
      "GMT",
    ],
  ])("shows %s with its offset and zone", (_label, instant, local, zone) => {
    expect(ukLocalTimestamp(instant)).toEqual({ local, zone });
  });
});

describe("hazard HZ-071 observation values carry their units and a schema per chart", () => {
  it("covers exactly the charts the API accepts", () => {
    const contracts = readFileSync(
      fileURLToPath(new URL("../../../contracts/src/care.ts", import.meta.url)),
      "utf8",
    );
    const charts = [...contracts.matchAll(/chart: z\.literal\("([a-z_]+)"\)/g)]
      .map((m) => m[1])
      .sort();
    expect(Object.keys(OBSERVATION_VALUES_SCHEMA).sort()).toEqual(charts);
  });

  it("gives every number a unit", () => {
    for (const [chart, schema] of Object.entries(OBSERVATION_VALUES_SCHEMA)) {
      const properties = schema.properties as Record<string, Record<string, unknown>>;
      for (const [name, property] of Object.entries(properties)) {
        const type = property.type;
        const numeric =
          type === "integer" ||
          type === "number" ||
          (Array.isArray(type) && type.includes("integer"));
        if (numeric) expect(property["x-unit"], `${chart}.${name}`).toBeTruthy();
      }
    }
  });
});

describe("hazard HZ-071 the current summary is worked out as Harbour shows it", () => {
  const unknown: AllergyStatement = { status: "unknown" };
  const none: CommunicationStatement = { status: "not_recorded" };
  const record = (extra: Partial<AdvanceCareRecordState>): AdvanceCareRecordState => ({
    id: "acr-1",
    kind: "dnacpr",
    status: "active",
    cprDecision: "do_not_attempt_cpr",
    completedOn: "2026-05-01",
    clinicianName: "Dr Cal Example",
    clinicianRole: "GP",
    reviewDueOn: null,
    ...extra,
  });
  const row = (extra: Partial<Parameters<typeof currentSummaryRow>[0]> = {}) =>
    currentSummaryRow({
      personId: "p-1",
      allergies: unknown,
      advanceCare: [],
      iddsi: { food: null, drink: null },
      communication: none,
      snapshotAt: new Date("2026-07-01T09:00:00Z"),
      ...extra,
    });

  it("has exactly the documented columns", () => {
    expect(Object.keys(row())).toEqual(CURRENT_SUMMARY_COLUMNS.map((c) => c.name));
  });

  it.each<[string, AllergyStatement, string, string]>([
    ["unknown is never none", unknown, "unknown", ""],
    [
      "no known allergies",
      { status: "no_known_allergies", recordedBy: "u-1", recordedAt: PAST },
      "no_known_allergies",
      "",
    ],
    [
      "allergies, most severe first",
      {
        status: "has_allergies",
        allergies: [
          { substance: "Latex", reaction: null, severity: "mild" },
          { substance: "Penicillin", reaction: "Rash", severity: "severe" },
        ],
      },
      "has_allergies",
      "Penicillin (severe); Latex (mild)",
    ],
    [
      "an empty allergy list reads as unknown",
      { status: "has_allergies", allergies: [] },
      "unknown",
      "",
    ],
  ])("allergies: %s", (_label, allergies, status, text) => {
    expect(row({ allergies })).toMatchObject({ allergy_status: status, allergies: text });
  });

  it.each<[string, AdvanceCareRecordState[], string, string, string]>([
    ["no record", [], "not_recorded", "", "false"],
    ["one DNACPR in force", [record({})], "do_not_attempt_cpr", "acr-1", "false"],
    [
      "a withdrawn record is ignored",
      [record({ status: "withdrawn" })],
      "not_recorded",
      "",
      "false",
    ],
    [
      "records in force that disagree are conflicting, with both",
      [
        record({}),
        record({
          id: "acr-2",
          kind: "respect",
          cprDecision: "attempt_cpr",
          completedOn: "2026-06-01",
        }),
      ],
      "conflicting",
      "acr-2; acr-1",
      "false",
    ],
    [
      "a review date passed",
      [record({ reviewDueOn: "2026-06-01" })],
      "do_not_attempt_cpr",
      "acr-1",
      "true",
    ],
  ])("CPR decision: %s", (_label, advanceCare, decision, ids, overdue) => {
    expect(row({ advanceCare })).toMatchObject({
      cpr_decision: decision,
      cpr_record_ids: ids,
      cpr_review_overdue: overdue,
    });
  });

  it.each<[string | null, string | null, string, string]>([
    ["4", "2", "Level 4 Pureed (green)", "Level 2 Mildly thick (pink)"],
    [null, null, "not recorded", "not recorded"],
    ["9", "x", "not recorded", "not recorded"],
  ])("IDDSI %s and %s", (food, drink, foodText, drinkText) => {
    expect(row({ iddsi: { food, drink } })).toMatchObject({
      iddsi_food: foodText,
      iddsi_drink: drinkText,
    });
  });

  it.each<[string, CommunicationStatement, string, string]>([
    ["not recorded is never none", none, "not_recorded", ""],
    [
      "none identified",
      { status: "none_identified", confirmedBy: "u-1", confirmedAt: PAST },
      "none_identified",
      "",
    ],
    [
      "needs recorded",
      {
        status: "recorded",
        needs: [{ code: "x", display: "Needs large print", preferredFormat: "large print" }],
      },
      "recorded",
      "Needs large print (large print)",
    ],
    ["an empty list reads as not recorded", { status: "recorded", needs: [] }, "not_recorded", ""],
  ])("communication: %s", (_label, communication, status, text) => {
    expect(row({ communication })).toMatchObject({
      communication_needs_status: status,
      communication_needs: text,
    });
  });

  it("states the snapshot in UTC and UK time", () => {
    expect(row()).toMatchObject({
      as_of: "2026-07-01T09:00:00.000Z",
      as_of_uk: "2026-07-01T10:00:00+01:00 BST",
    });
  });
});

describe("hazard HZ-071 schema.json gives every column its meaning", () => {
  const db: DatabaseTable[] = [
    {
      schema: "public",
      name: "person",
      hasTenantId: true,
      columns: [
        ID,
        { name: "status", type: "enum", nullable: false, enumValues: ["active", "discharged"] },
        { name: "sex_code", type: "text", nullable: true },
        {
          name: "allergy_status",
          type: "enum",
          nullable: false,
          enumValues: ["unknown", "no_known_allergies", "has_allergies"],
        },
        { name: "date_of_birth", type: "date", nullable: true },
        { name: "deceased_at", type: "timestamp", nullable: true },
        { name: "national_data_opt_out", type: "boolean", nullable: false },
        { name: "communication_needs", type: "json", nullable: true },
      ],
    },
    {
      schema: "public",
      name: "person_care_profile",
      hasTenantId: true,
      columns: [ID, { name: "fluid_target_ml", type: "integer", nullable: true }],
    },
    {
      schema: "public",
      name: "observation",
      hasTenantId: true,
      columns: [ID, { name: "values", type: "json", nullable: false }],
    },
    {
      schema: "public",
      name: "notification_preference",
      hasTenantId: true,
      columns: [ID, { name: "quiet_hours_start", type: "time", nullable: true }],
    },
    {
      schema: "public",
      name: "care_note",
      hasTenantId: true,
      columns: [
        ID,
        { name: "tags", type: "text_array", nullable: false },
        { name: "attachment_document_ids", type: "uuid_array", nullable: true },
      ],
    },
    {
      schema: "public",
      name: "document",
      hasTenantId: true,
      columns: [ID, { name: "storage_key", type: "text", nullable: false }],
    },
  ];
  const schema = describeExportSchema(planExport(db)) as {
    tables: Record<
      string,
      {
        rows: { required: string[]; properties: Record<string, Record<string, unknown>> };
        omittedColumns: string[];
      }
    >;
    schemaVersion: string;
    $schema: string;
    conventions: Record<string, string>;
    observationValues: { oneOf: unknown[] };
    currentSummary: { file: string; columns: Record<string, string> };
  };
  const prop = (table: string, column: string) => schema.tables[table]?.rows.properties[column];

  it("is JSON Schema 2020-12 with the export's version", () => {
    expect(schema.$schema).toBe("https://json-schema.org/draft/2020-12/schema");
    expect(schema.schemaVersion).toBe(EXPORT_SCHEMA_VERSION);
    expect(JSON.parse(JSON.stringify(schema))).toEqual(schema);
  });

  it.each<[string, string, Record<string, unknown>]>([
    ["person", "id", { type: "string", format: "uuid" }],
    ["person", "status", { type: "string", enum: ["active", "discharged"] }],
    ["person", "date_of_birth", { type: ["string", "null"], format: "date" }],
    ["person", "deceased_at", { type: ["string", "null"], format: "date-time" }],
    [
      "person",
      "deceased_at_uk_date",
      { type: ["string", "null"], format: "date", "x-derived-from": "deceased_at" },
    ],
    ["person", "national_data_opt_out", { type: "boolean" }],
    ["person", "communication_needs", { type: ["object", "array", "null"] }],
    [
      "person_care_profile",
      "fluid_target_ml",
      { type: ["integer", "null"], "x-unit": "ml per day" },
    ],
    ["observation", "values", { "x-schema": "#/observationValues" }],
    ["notification_preference", "quiet_hours_start", { type: ["string", "null"], format: "time" }],
    ["care_note", "tags", { type: "array", items: { type: "string" } }],
    [
      "care_note",
      "attachment_document_ids",
      { type: ["array", "null"], items: { type: "string", format: "uuid" } },
    ],
  ])("describes %s.%s", (table, column, expected) => {
    expect(prop(table, column)).toMatchObject(expected);
    expect(String(prop(table, column)?.description ?? "").length).toBeGreaterThan(5);
    expect(schema.tables[table]?.rows.required).toContain(column);
  });

  it("documents the allergy status codes and nullable enums", () => {
    expect(prop("person", "allergy_status")?.["x-codes"]).toMatchObject({
      unknown: expect.stringContaining("Never"),
    });
    const nullableEnum = describeExportSchema(
      planExport([
        {
          schema: "public",
          name: "person",
          hasTenantId: true,
          columns: [{ name: "status", type: "enum", nullable: true, enumValues: ["active"] }],
        },
      ]),
    ) as typeof schema;
    expect(nullableEnum.tables.person?.rows.properties.status).toMatchObject({
      type: ["string", "null"],
      enum: ["active", null],
    });
  });

  it("leaves omitted columns out and says so", () => {
    expect(schema.tables.document?.rows.properties).not.toHaveProperty("storage_key");
    expect(schema.tables.document?.omittedColumns).toEqual(["storage_key"]);
  });

  it.each([
    "corrections",
    "instants",
    "ukDates",
    "wallClock",
    "snapshot",
    "csvFormulas",
    "currentSummary",
  ])("states the %s convention", (key) => {
    expect(schema.conventions[key]?.length ?? 0).toBeGreaterThan(40);
  });

  it("explains corrections so the original and its correction are not read as two facts", () => {
    expect(schema.conventions.corrections).toContain("supersedes_id");
    expect(schema.conventions.corrections).toContain("not a second live fact");
    expect(schema.conventions.wallClock).toContain("Europe/London");
  });

  it("includes the observation chart schemas and the current summary's columns", () => {
    expect(schema.observationValues.oneOf).toHaveLength(
      Object.keys(OBSERVATION_VALUES_SCHEMA).length,
    );
    expect(Object.keys(schema.currentSummary.columns)).toEqual(
      CURRENT_SUMMARY_COLUMNS.map((c) => c.name),
    );
  });
});

describe("hazard HZ-071 an incomplete export is never offered", () => {
  const plan = planExport([
    { schema: "public", name: "person", hasTenantId: true, columns: [ID, TENANT_ID] },
    {
      schema: "public",
      name: "document",
      hasTenantId: true,
      columns: [ID, TENANT_ID, { name: "storage_key", type: "text", nullable: false }],
    },
  ]);
  const written = (name: string, rows = 3, extra: Partial<WrittenTable> = {}): WrittenTable => ({
    name,
    included: rows,
    legalHoldRows: name === "person" ? 1 : 0,
    excluded: { softDeleted: name === "person" ? 2 : 0, sample: 0 },
    otherTenantRows: 0,
    files: [
      { path: `tables/${name}.csv`, format: "csv", sha256: SHA_A, bytes: 100, rows },
      { path: `tables/${name}.jsonl`, format: "jsonl", sha256: SHA_B, bytes: 120, rows },
    ],
    ...extra,
  });
  const summary = (rows = 3): WrittenFile => ({
    path: "current_summary.csv",
    format: "csv",
    sha256: SHA_A,
    bytes: 80,
    rows,
  });
  const included: WrittenDocument = {
    id: DOC_ID,
    decision: {
      action: "include_bytes",
      path: `documents/${DOC_ID}.pdf`,
      sha256: SHA_A,
      bytes: 2048,
    },
    writtenSha256: SHA_A,
  };
  const input = (extra: Partial<ExportManifestInput> = {}): ExportManifestInput => ({
    exportId: "export-1",
    tenantId: "tenant-1",
    requestedBy: "user-1",
    generatedAt: NOW,
    snapshotAt: new Date("2026-10-11T09:59:00Z"),
    plan,
    schemaFile: { sha256: SHA_B, bytes: 4000 },
    tables: [written("person"), written("document", 1)],
    currentSummary: summary(),
    documents: [
      included,
      { id: "q", decision: { action: "omit_bytes", reason: "quarantined" }, writtenSha256: null },
      { id: "s", decision: { action: "exclude", reason: "sample" }, writtenSha256: null },
      {
        id: "d",
        decision: { action: "list_as_destroyed", certificateId: "cert-2" },
        writtenSha256: null,
      },
    ],
    destroyed: [
      { table: "document", id: "d", destroyedAt: PAST, certificateId: "cert-2" },
      { table: "care_note", id: "n1", destroyedAt: PAST, certificateId: "cert-1" },
      { table: "care_note", id: "n2", destroyedAt: PAST, certificateId: "cert-1" },
    ],
    auditChain: { verified: true, firstBrokenPosition: null },
    ...extra,
  });

  it("is complete when every planned file, summary row and document is written as counted", () => {
    const manifest = buildExportManifest(input());
    expect(manifest).toMatchObject({
      format: "harbour-tenant-export",
      schemaVersion: EXPORT_SCHEMA_VERSION,
      kind: "full",
      since: null,
      generatedAt: "2026-10-11T10:00:00.000Z",
      snapshotAt: "2026-10-11T09:59:00.000Z",
      snapshotAtUk: { local: "2026-10-11T10:59:00+01:00", zone: "BST" },
      schema: { path: "schema.json", sha256: SHA_B, bytes: 4000 },
      complete: true,
      problems: [],
      warnings: [],
      currentSummary: { path: "current_summary.csv", rows: 3 },
      documents: { included: 1, bytes: 2048, quarantined: 1, excluded: 1, destroyed: 1 },
      destroyed: {
        path: "destroyed.csv",
        count: 3,
        byTable: { document: 1, care_note: 2 },
        certificateIds: ["cert-1", "cert-2"],
      },
    });
    expect(manifest.tables.find((t) => t.name === "person")).toMatchObject({
      rows: 3,
      legalHoldRows: 1,
      excluded: { softDeleted: 2, sample: 0 },
    });
  });

  it.each<[string, Partial<ExportManifestInput>, unknown]>([
    [
      "a planned table not written",
      { tables: [written("person")] },
      { kind: "table_missing", table: "document" },
    ],
    [
      "a table nobody planned",
      { tables: [written("person"), written("document", 1), written("stray")] },
      { kind: "unexpected_table", table: "stray" },
    ],
    [
      "a missing JSON Lines file",
      {
        tables: [
          written("person", 3, { files: written("person").files.slice(0, 1) }),
          written("document", 1),
        ],
      },
      { kind: "file_missing", table: "person", format: "jsonl" },
    ],
    [
      "a CSV with fewer rows than counted",
      { tables: [written("person", 3, { included: 4 }), written("document", 1)] },
      { kind: "row_count_mismatch", table: "person", format: "csv" },
    ],
    [
      "another organisation's rows (HZ-070)",
      { tables: [written("person", 3, { otherTenantRows: 1 }), written("document", 1)] },
      { kind: "foreign_tenant_rows", table: "person", rows: 1 },
    ],
    ["no current summary", { currentSummary: null }, { kind: "summary_missing" }],
    [
      "a summary short of a person",
      { currentSummary: summary(2) },
      { kind: "summary_row_count_mismatch", people: 3, rows: 2 },
    ],
    [
      "a document whose bytes changed",
      { documents: [{ ...included, writtenSha256: SHA_B }] },
      { kind: "document_checksum_mismatch", id: DOC_ID },
    ],
    [
      "a document that was not written",
      { documents: [{ ...included, writtenSha256: null }] },
      { kind: "document_not_written", id: DOC_ID },
    ],
    [
      "an unclassified table or column",
      { plan: { ...plan, unclassified: [{ table: "public.new_register", columns: ["id"] }] } },
      { kind: "unclassified", table: "public.new_register", columns: ["id"] },
    ],
  ])("is incomplete with %s", (_label, extra, problem) => {
    const manifest = buildExportManifest(input(extra));
    expect(manifest.complete).toBe(false);
    expect(manifest.problems).toContainEqual(problem);
  });

  it("checks the summary against the people only for a full export", () => {
    const changes = { ...plan, kind: "changes_since" as const, since: PAST };
    const manifest = buildExportManifest(input({ plan: changes, currentSummary: summary(1) }));
    expect(manifest).toMatchObject({
      complete: true,
      kind: "changes_since",
      since: PAST.toISOString(),
    });
  });

  it("warns, without blocking, about a broken audit chain and a destruction with no certificate", () => {
    const manifest = buildExportManifest(
      input({
        auditChain: { verified: false, firstBrokenPosition: 41 },
        destroyed: [{ table: "care_note", id: "n3", destroyedAt: PAST, certificateId: null }],
      }),
    );
    expect(manifest.complete).toBe(true);
    expect(manifest.warnings).toEqual(
      expect.arrayContaining([
        { kind: "audit_chain_broken", position: 41 },
        { kind: "destroyed_without_certificate", table: "care_note", id: "n3" },
      ]),
    );
    expect(manifest.destroyed.certificateIds).toEqual([]);
  });

  it("reports nothing written as zero rows", () => {
    const manifest = buildExportManifest(input({ tables: [] }));
    expect(manifest.tables.every((t) => t.rows === 0 && t.files.length === 0)).toBe(true);
  });
});

describe("hazard HZ-070 export request: free, MFA step-up, one at a time", () => {
  const fresh = new Date(NOW.getTime() - 60_000);
  const stale = new Date(NOW.getTime() - (STEP_UP_SECONDS + 1) * 1000);
  const context = (extra: Partial<ExportRequestContext> = {}): ExportRequestContext => ({
    access: accessFor("owner"),
    stepUpAt: fresh,
    now: NOW,
    stepUpWindowSeconds: STEP_UP_SECONDS,
    tenant: { status: "active", dataPurgedAt: null },
    exports: [],
    ...extra,
  });

  it.each<[string, Partial<ExportRequestContext>, string | null]>([
    ["the owner, just signed in with MFA", {}, null],
    [
      "an organisation that is still onboarding",
      { tenant: { status: "onboarding", dataPurgedAt: null } },
      null,
    ],
    [
      "a suspended organisation (unpaid bills never withhold the data)",
      { tenant: { status: "suspended", dataPurgedAt: null } },
      null,
    ],
    [
      "an organisation whose contract has ended, before deletion",
      { tenant: { status: "closed", dataPurgedAt: null } },
      null,
    ],
    [
      "after an earlier export finished",
      {
        exports: [
          { id: "e0", status: "ready" },
          { id: "e1", status: "expired" },
        ],
      },
      null,
    ],
    ["changes since an earlier snapshot", { since: PAST }, null],
    ["a stale MFA sign-in", { stepUpAt: stale }, "step_up_required"],
    ["no MFA sign-in", { stepUpAt: null }, "step_up_required"],
    ["a Registered Manager", { access: accessFor("registered_manager") }, "missing_permission"],
    ["the quality lead", { access: accessFor("quality_lead") }, "missing_permission"],
    [
      "after the data was deleted",
      { tenant: { status: "closed", dataPurgedAt: PAST } },
      "data_purged",
    ],
    [
      "changes since a time in the future",
      { since: new Date(NOW.getTime() + 60_000) },
      "since_in_future",
    ],
  ])("%s", (_label, extra, problem) => {
    const result = checkExportRequest(context(extra));
    if (problem === null) expect(result).toEqual({ ok: true });
    else expect(result).toMatchObject({ ok: false, problem });
  });

  it.each<ExportStatus>(["queued", "running"])("returns the export already %s", (status) => {
    expect(checkExportRequest(context({ exports: [{ id: "e9", status }] }))).toMatchObject({
      ok: false,
      problem: "export_in_progress",
      existingExportId: "e9",
    });
  });
});

describe("hazard HZ-070 the export link expires and works only for the requester", () => {
  const readyAt = new Date("2026-10-11T09:00:00Z");
  const expiresAt = exportExpiresAt(readyAt, RATES);
  const fresh = new Date(NOW.getTime() - 60_000);

  it("expires the rate-table number of hours after it is ready", () => {
    expect((expiresAt.getTime() - readyAt.getTime()) / 3_600_000).toBe(RATES.exportLinkExpiryHours);
  });

  it("never keeps an export beyond the Harbour ceiling, whatever the organisation sets", () => {
    const override = {
      key: "export.link_expiry_hours",
      value: "1000",
      unit: "hours",
      nation: "all",
      validFrom: "2000-01-01",
      validTo: null,
      tenantId: TENANT,
      verificationStatus: "tenant",
      source: "tenant setting",
    };
    const rates = resolvePlatformRates(
      [...readRateTable(), override],
      "england",
      "2026-10-11",
      TENANT,
    );
    expect(rates.exportLinkExpiryHours).toBe(1000);
    const capped = exportExpiresAt(readyAt, rates);
    expect((capped.getTime() - readyAt.getTime()) / 3_600_000).toBe(rates.exportLinkExpiryHoursMax);
  });

  it.each<[string, ExportStatus, Date | null, Date, ExportStatus]>([
    ["ready before expiry", "ready", expiresAt, NOW, "ready"],
    ["ready at the expiry time", "ready", expiresAt, expiresAt, "expired"],
    ["ready with no expiry recorded", "ready", null, NOW, "expired"],
    ["queued", "queued", null, NOW, "queued"],
    ["revoked", "revoked", expiresAt, NOW, "revoked"],
  ])("state when %s", (_label, status, expiry, at, expected) => {
    expect(exportStateAt({ id: "e1", status, requestedBy: "u1", expiresAt: expiry }, at)).toBe(
      expected,
    );
  });

  const check = (
    extra: Partial<Parameters<typeof checkExportDownload>[0]> = {},
    status: ExportStatus = "ready",
  ) =>
    checkExportDownload({
      export: { id: "e1", status, requestedBy: "u1", expiresAt },
      actorTenantUserId: "u1",
      access: accessFor("owner"),
      stepUpAt: fresh,
      now: NOW,
      stepUpWindowSeconds: STEP_UP_SECONDS,
      ...extra,
    });

  it.each<
    [string, Partial<Parameters<typeof checkExportDownload>[0]>, ExportStatus, string | null]
  >([
    ["the requester, just signed in with MFA", {}, "ready", null],
    ["another owner", { actorTenantUserId: "u2" }, "ready", "not_requester"],
    [
      "the requester with an old MFA sign-in",
      { stepUpAt: new Date(NOW.getTime() - 3_600_000) },
      "ready",
      "step_up_required",
    ],
    [
      "the requester after losing the permission",
      { access: accessFor("registered_manager") },
      "ready",
      "missing_permission",
    ],
    [
      "after expiry",
      { now: expiresAt, stepUpAt: new Date(expiresAt.getTime() - 60_000) },
      "ready",
      "expired",
    ],
    ["while it is being prepared", {}, "running", "not_ready"],
    ["while it is queued", {}, "queued", "not_ready"],
    ["after it failed", {}, "failed", "failed"],
    ["after it was cancelled", {}, "revoked", "revoked"],
    ["after the expiry job ran", {}, "expired", "expired"],
  ])("%s", (_label, extra, status, problem) => {
    const result = check(extra, status);
    if (problem === null)
      expect(result).toEqual({ ok: true, urlLifetimeSeconds: EXPORT_DOWNLOAD_URL_SECONDS });
    else {
      expect(result).toMatchObject({ ok: false, problem });
      if (!result.ok) expect(result.message.length).toBeGreaterThan(10);
    }
  });
});
