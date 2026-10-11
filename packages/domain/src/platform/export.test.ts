/// <reference types="node" />
import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { tablePlatformRates } from "../../test/rate-table";
import { type EffectiveAccess, resolveAccess } from "./access";
import {
  buildExportManifest,
  checkExportCatalogue,
  checkExportDownload,
  checkExportRequest,
  type DatabaseTable,
  describeExportSchema,
  documentChecksumMatches,
  documentExportPath,
  EXPORT_SCHEMA_VERSION,
  EXPORT_TABLES,
  type ExportColumn,
  type ExportDocumentRow,
  type ExportManifestInput,
  type ExportRowState,
  type ExportStatus,
  exportDocumentDecision,
  exportExpiresAt,
  exportRowDecision,
  exportStateAt,
  planExport,
  type WrittenDocument,
  type WrittenTable,
} from "./export";
import { builtinRole } from "./roles";

const NOW = new Date("2026-10-11T10:00:00Z");
const PAST = new Date("2026-01-01T00:00:00Z");
const STEP_UP_SECONDS = 600;
const RATES = tablePlatformRates();
const SHA_A = "a".repeat(64);
const SHA_B = "b".repeat(64);
const DOC_ID = "0193a000-0000-7000-8000-0000000000d1";

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
        validFrom: PAST,
        validTo: null,
      },
    ],
    [],
    NOW,
  );
}

const ID: ExportColumn = { name: "id", type: "uuid", nullable: false };
const TENANT: ExportColumn = { name: "tenant_id", type: "uuid", nullable: false };

/** The database as the catalogue describes it: every table, with the columns it omits. */
function catalogueDatabase(): DatabaseTable[] {
  const tables: DatabaseTable[] = Object.entries(EXPORT_TABLES).map(([name, def]) => ({
    schema: "public",
    name,
    hasTenantId: name !== "bank_holiday" && name !== "operator_user",
    columns: [
      ID,
      TENANT,
      ...("omitColumns" in def ? def.omitColumns : []).map(
        (c): ExportColumn => ({ name: c, type: "text", nullable: true }),
      ),
    ],
  }));
  tables.push({ schema: "auth", name: "user", hasTenantId: false, columns: [ID] });
  tables.push({ schema: "auth", name: "two_factor", hasTenantId: false, columns: [ID] });
  return tables;
}

describe("hazard HZ-071 the export catalogue names every table", () => {
  it("describes every table, with a reason for each one it leaves out", () => {
    for (const [name, def] of Object.entries(EXPORT_TABLES)) {
      expect(def.description.length, name).toBeGreaterThan(10);
      if (def.treatment === "not_exported") {
        expect("reasonNotExported" in def && def.reasonNotExported.length > 10, name).toBe(true);
      }
      const omitted: readonly string[] = "omitColumns" in def ? def.omitColumns : [];
      expect(omitted, name).not.toContain("id");
      expect(omitted, name).not.toContain("tenant_id");
    }
  });

  it("covers every table in the Drizzle schema, and only those", () => {
    // Static check until the schema step runs checkExportCatalogue against the live database.
    const dir = fileURLToPath(new URL("../../../db/src/schema/", import.meta.url));
    const names = readdirSync(dir)
      .filter((f) => f.endsWith(".ts") && f !== "auth.ts")
      .flatMap((f) =>
        [...readFileSync(`${dir}${f}`, "utf8").matchAll(/pgTable\(\s*"([a-z_]+)"/g)].map(
          (m) => m[1],
        ),
      )
      .sort();
    expect(
      names,
      "A table was added or removed: describe it in EXPORT_TABLES (packages/domain/src/platform/export.ts)",
    ).toEqual(Object.keys(EXPORT_TABLES).sort());
  });

  it("finds nothing wrong when the database matches the catalogue", () => {
    expect(checkExportCatalogue(catalogueDatabase())).toEqual([]);
  });

  it("reports a new table, a missing table and a renamed secret column", () => {
    const db = catalogueDatabase()
      .filter((t) => t.name !== "person")
      .map((t) => (t.name === "document" ? { ...t, columns: [ID, TENANT] } : t));
    db.push({ schema: "public", name: "new_register", hasTenantId: true, columns: [ID, TENANT] });
    expect(checkExportCatalogue(db)).toEqual(
      expect.arrayContaining([
        { table: "new_register", problem: "not_in_catalogue" },
        { table: "person", problem: "not_in_database" },
        { table: "document", problem: "omitted_column_missing", column: "storage_key" },
      ]),
    );
  });
});

describe("export plan", () => {
  const plan = planExport(catalogueDatabase());
  const table = (name: string) => plan.tables.find((t) => t.name === name);

  it.each([
    ["auth.user", "Passwords"],
    ["auth.two_factor", "Passwords"],
    ["bank_holiday", "Global reference data"],
    ["operator_user", "Thapsus's own staff"],
  ])("leaves %s out with the reason", (name, reason) => {
    expect(plan.notExported.find((n) => n.name === name)?.reason).toContain(reason);
    expect(table(name)).toBeUndefined();
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
    ["document", "storage_key"],
    ["integration_connection", "secret_ref"],
    ["tenant_user", "auth_user_id"],
  ])("never exports %s.%s", (name, column) => {
    expect(table(name)?.columns.map((c) => c.name)).not.toContain(column);
    expect(table(name)?.omittedColumns).toEqual([column]);
  });

  it("names one CSV and one JSON Lines file per table", () => {
    expect(table("person")?.files).toEqual({
      csv: "tables/person.csv",
      jsonl: "tables/person.jsonl",
    });
    expect(plan.schemaVersion).toBe(EXPORT_SCHEMA_VERSION);
  });

  it("still exports an undescribed organisation table in full, flagged, and skips a global one", () => {
    const extra = planExport([
      ...catalogueDatabase(),
      { schema: "public", name: "new_register", hasTenantId: true, columns: [ID, TENANT] },
      { schema: "public", name: "new_reference", hasTenantId: false, columns: [ID] },
    ]);
    expect(extra.tables.find((t) => t.name === "new_register")).toMatchObject({
      documented: false,
      personal: true,
      context: null,
      columns: [ID, TENANT],
    });
    expect(extra.notExported.find((n) => n.name === "new_reference")).toBeDefined();
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
});

describe("documents in the export", () => {
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

describe("schema description", () => {
  const db: DatabaseTable[] = [
    {
      schema: "public",
      name: "person",
      hasTenantId: true,
      columns: [
        ID,
        { name: "status", type: "enum", nullable: false, enumValues: ["active", "discharged"] },
        { name: "sex_code", type: "enum", nullable: true, enumValues: ["1", "2"] },
        { name: "date_of_birth", type: "date", nullable: true },
        { name: "deceased_at", type: "timestamp", nullable: true },
        { name: "national_data_opt_out", type: "boolean", nullable: false },
        { name: "communication_needs", type: "json", nullable: true },
        { name: "room_number", type: "integer", nullable: true },
        { name: "weight_kg", type: "number", nullable: true },
        { name: "tags", type: "text_array", nullable: false },
        { name: "linked_ids", type: "uuid_array", nullable: true },
        { name: "family_name", type: "text", nullable: false },
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
        rows: { required: string[]; properties: Record<string, unknown> };
        documented: boolean;
        omittedColumns: string[];
      }
    >;
    schemaVersion: string;
    $schema: string;
  };

  it("is JSON Schema 2020-12 with the export's version", () => {
    expect(schema.$schema).toBe("https://json-schema.org/draft/2020-12/schema");
    expect(schema.schemaVersion).toBe(EXPORT_SCHEMA_VERSION);
    expect(JSON.parse(JSON.stringify(schema))).toEqual(schema);
  });

  it.each<[string, unknown]>([
    ["id", { type: "string", format: "uuid" }],
    ["status", { type: "string", enum: ["active", "discharged"] }],
    ["sex_code", { type: ["string", "null"], enum: ["1", "2", null] }],
    ["date_of_birth", { type: ["string", "null"], format: "date" }],
    ["deceased_at", { type: ["string", "null"], format: "date-time" }],
    ["national_data_opt_out", { type: "boolean" }],
    ["communication_needs", { type: ["object", "array", "null"] }],
    ["room_number", { type: ["integer", "null"] }],
    ["weight_kg", { type: ["number", "null"] }],
    ["tags", { type: "array", items: { type: "string" } }],
    ["linked_ids", { type: ["array", "null"], items: { type: "string", format: "uuid" } }],
    ["family_name", { type: "string" }],
  ])("describes %s", (column, expected) => {
    expect(schema.tables.person?.rows.properties[column]).toEqual(expected);
    expect(schema.tables.person?.rows.required).toContain(column);
  });

  it("leaves omitted columns out and says so", () => {
    expect(schema.tables.document?.rows.properties).not.toHaveProperty("storage_key");
    expect(schema.tables.document?.omittedColumns).toEqual(["storage_key"]);
  });
});

describe("hazard HZ-071 an incomplete export is never offered", () => {
  const plan = planExport([
    { schema: "public", name: "person", hasTenantId: true, columns: [ID, TENANT] },
    {
      schema: "public",
      name: "document",
      hasTenantId: true,
      columns: [ID, TENANT, { name: "storage_key", type: "text", nullable: false }],
    },
    { schema: "public", name: "new_register", hasTenantId: true, columns: [ID, TENANT] },
  ]);
  const written = (name: string, rows = 3): WrittenTable => ({
    name,
    included: rows,
    legalHoldRows: name === "person" ? 1 : 0,
    excluded: { softDeleted: name === "person" ? 2 : 0, sample: 0 },
    files: [
      { path: `tables/${name}.csv`, format: "csv", sha256: SHA_A, bytes: 100, rows },
      { path: `tables/${name}.jsonl`, format: "jsonl", sha256: SHA_B, bytes: 120, rows },
    ],
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
    plan,
    schemaFile: { sha256: SHA_B, bytes: 4000 },
    tables: [written("person"), written("document", 1), written("new_register", 0)],
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

  it("is complete when every planned file and document is written as counted", () => {
    const manifest = buildExportManifest(input());
    expect(manifest).toMatchObject({
      format: "harbour-tenant-export",
      schemaVersion: EXPORT_SCHEMA_VERSION,
      generatedAt: "2026-10-11T10:00:00.000Z",
      schema: { path: "schema.json", sha256: SHA_B, bytes: 4000 },
      complete: true,
      problems: [],
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
    expect(manifest.warnings).toEqual([{ kind: "undocumented_table", table: "new_register" }]);
  });

  it.each<[string, Partial<ExportManifestInput>, unknown]>([
    [
      "a planned table not written",
      { tables: [written("person"), written("new_register", 0)] },
      { kind: "table_missing", table: "document" },
    ],
    [
      "a table nobody planned",
      {
        tables: [
          written("person"),
          written("document", 1),
          written("new_register", 0),
          written("stray"),
        ],
      },
      { kind: "unexpected_table", table: "stray" },
    ],
    [
      "a missing JSON Lines file",
      {
        tables: [
          { ...written("person"), files: written("person").files.slice(0, 1) },
          written("document", 1),
          written("new_register", 0),
        ],
      },
      { kind: "file_missing", table: "person", format: "jsonl" },
    ],
    [
      "a CSV with fewer rows than counted",
      {
        tables: [
          { ...written("person"), included: 4 },
          written("document", 1),
          written("new_register", 0),
        ],
      },
      { kind: "row_count_mismatch", table: "person", format: "csv" },
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
  ])("is incomplete with %s", (_label, extra, problem) => {
    const manifest = buildExportManifest(input(extra));
    expect(manifest.complete).toBe(false);
    expect(manifest.problems).toContainEqual(problem);
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
});

describe("export request: free, step-up, one at a time", () => {
  const fresh = new Date(NOW.getTime() - 60_000);
  const stale = new Date(NOW.getTime() - (STEP_UP_SECONDS + 1) * 1000);
  const context = (extra: Partial<Parameters<typeof checkExportRequest>[0]> = {}) => ({
    access: accessFor("owner"),
    lastStrongAuthAt: fresh,
    now: NOW,
    stepUpWindowSeconds: STEP_UP_SECONDS,
    tenant: { status: "active", dataPurgedAt: null },
    exports: [] as { id: string; status: ExportStatus }[],
    ...extra,
  });

  it.each<[string, Partial<Parameters<typeof checkExportRequest>[0]>, string | null]>([
    ["the owner, just signed in", {}, null],
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
    ["a stale sign-in", { lastStrongAuthAt: stale }, "step_up_required"],
    ["no strong sign-in", { lastStrongAuthAt: null }, "step_up_required"],
    ["a Registered Manager", { access: accessFor("registered_manager") }, "missing_permission"],
    ["the quality lead", { access: accessFor("quality_lead") }, "missing_permission"],
    [
      "after the data was deleted",
      { tenant: { status: "closed", dataPurgedAt: PAST } },
      "data_purged",
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
      lastStrongAuthAt: fresh,
      now: NOW,
      stepUpWindowSeconds: STEP_UP_SECONDS,
      ...extra,
    });

  it.each<
    [string, Partial<Parameters<typeof checkExportDownload>[0]>, ExportStatus, string | null]
  >([
    ["the requester, just signed in", {}, "ready", null],
    ["another owner", { actorTenantUserId: "u2" }, "ready", "not_requester"],
    [
      "the requester with an old sign-in",
      { lastStrongAuthAt: new Date(NOW.getTime() - 3_600_000) },
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
      { now: expiresAt, lastStrongAuthAt: new Date(expiresAt.getTime() - 60_000) },
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
    if (problem === null) expect(result).toEqual({ ok: true });
    else {
      expect(result).toMatchObject({ ok: false, problem });
      if (!result.ok) expect(result.message.length).toBeGreaterThan(10);
    }
  });
});
