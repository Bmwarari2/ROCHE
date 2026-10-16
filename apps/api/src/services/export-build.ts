import { createHash } from "node:crypto";
import { advanceCareRecord, allergy, person, personCareProfile } from "@harbour/db";
import {
  type AdvanceCareRecordState,
  buildExportManifest,
  CURRENT_SUMMARY_COLUMNS,
  type CurrentSummaryRow,
  columnTypeFromSql,
  csvRow,
  currentSummaryRow,
  type DatabaseTable,
  type DestroyedRecord,
  type DocumentStoragePort,
  describeExportSchema,
  EXPORT_CURRENT_SUMMARY_FILE,
  EXPORT_DESTROYED_FILE,
  EXPORT_MANIFEST_FILE,
  EXPORT_SCHEMA_FILE,
  type ExportManifest,
  type ExportPlan,
  exportDocumentDecision,
  exportRowChangedSince,
  exportRowDecision,
  type PlannedExportTable,
  planExport,
  ukDateOfInstant,
  type WrittenDocument,
  type WrittenTable,
} from "@harbour/domain";
import { isNull } from "drizzle-orm";
import { drizzle } from "drizzle-orm/node-postgres";
import type pg from "pg";
import { allergyStatementOf, communicationStatementOf } from "./transfer-pack";
import { ZipWriter } from "./zip-writer";

/**
 * Builds one organisation's full export (PLAT-015; platform-completions.md rules 10 to 14; HZ-070,
 * HZ-071) as `harbour_app` in the organisation's own context, so forced row-level security applies
 * to every read, inside one `REPEATABLE READ` read-only transaction: every file is read from the
 * same snapshot. The tables come from the database's own catalogue and are planned with the export
 * catalogue; rows are read through cursors and every file is written straight into a streamed ZIP
 * that the storage port uploads as it is made, so neither a table nor the archive is held in
 * memory. The manifest checks what was written; a problem fails the export.
 */

const BATCH = 1_000;

export interface BuiltExport {
  readonly manifest: ExportManifest;
  readonly manifestSha256: string;
  readonly bytes: number;
  readonly snapshotAt: Date;
}

interface Snapshot {
  readonly client: pg.PoolClient;
  readonly tenantId: string;
}

const ident = (name: string) => `"${name.replaceAll('"', '""')}"`;

/** The public tables and their columns, from the database itself (rule 16). */
async function databaseTables(client: pg.PoolClient): Promise<DatabaseTable[]> {
  const { rows } = await client.query<{
    table: string;
    column: string;
    type: string;
    not_null: boolean;
    labels: string[] | null;
  }>(
    `SELECT c.relname AS table, a.attname AS column, format_type(a.atttypid, a.atttypmod) AS type,
            a.attnotnull AS not_null,
            (SELECT array_agg(e.enumlabel ORDER BY e.enumsortorder) FROM pg_enum e
              WHERE e.enumtypid = a.atttypid) AS labels
       FROM pg_class c
       JOIN pg_namespace n ON n.oid = c.relnamespace AND n.nspname = 'public'
       JOIN pg_attribute a ON a.attrelid = c.oid AND a.attnum > 0 AND NOT a.attisdropped
      WHERE c.relkind IN ('r', 'p')
      ORDER BY c.relname, a.attnum`,
  );
  const tables = new Map<string, DatabaseTable & { columns: DatabaseTable["columns"][number][] }>();
  for (const r of rows) {
    const table = tables.get(r.table) ?? {
      schema: "public",
      name: r.table,
      hasTenantId: false,
      columns: [],
    };
    table.columns.push({
      name: r.column,
      type: columnTypeFromSql(r.type, r.labels),
      nullable: !r.not_null,
    });
    tables.set(r.table, { ...table, hasTenantId: table.hasTenantId || r.column === "tenant_id" });
  }
  return [...tables.values()];
}

/** Rows of one table through a cursor, `BATCH` at a time. */
async function* cursorRows(
  s: Snapshot,
  sql: string,
  params: unknown[] = [],
): AsyncGenerator<Record<string, unknown>> {
  const name = `export_${createHash("sha1").update(sql).digest("hex").slice(0, 12)}`;
  await s.client.query(`DECLARE ${name} NO SCROLL CURSOR FOR ${sql}`, params);
  try {
    for (;;) {
      const { rows } = await s.client.query(`FETCH ${BATCH} FROM ${name}`);
      if (rows.length === 0) return;
      yield* rows;
    }
  } finally {
    await s.client.query(`CLOSE ${name}`);
  }
}

interface Holds {
  readonly people: ReadonlySet<string>;
  readonly subjects: ReadonlySet<string>;
}

/** Whether a row is under a legal hold: its own flag, a hold on it, or on its person. */
export function held(table: string, row: Record<string, unknown>, holds: Holds): boolean {
  if (row.legal_hold === true) return true;
  const id = String(row.id ?? "");
  if (holds.subjects.has(`${table}:${id}`)) return true;
  const personId = table === "person" ? id : row.person_id;
  return typeof personId === "string" && holds.people.has(personId);
}

const cell = (value: unknown) => (value instanceof Date ? value.toISOString() : value);

/** Reads a table once per file format; counts what went in and what was left out. */
async function writeTable(
  s: Snapshot,
  zip: ZipWriter,
  table: PlannedExportTable,
  plan: ExportPlan,
  holds: Holds,
  people: Set<string>,
): Promise<WrittenTable> {
  const stored = table.columns.filter((c) => c.derivedFrom === null).map((c) => c.name);
  const present = new Set(stored);
  const state = [
    "id",
    "tenant_id",
    "person_id",
    "deleted_at",
    "legal_hold",
    "created_at",
    "updated_at",
    "recorded_at",
  ].filter((c) => !present.has(c));
  const known = new Set(
    (
      await s.client.query(
        `SELECT attname FROM pg_attribute WHERE attrelid = $1::regclass AND attnum > 0 AND NOT attisdropped`,
        [`public.${table.name}`],
      )
    ).rows.map((r) => r.attname as string),
  );
  const select = [...stored, ...state.filter((c) => known.has(c))]
    .map((c) => {
      const type = table.columns.find((col) => col.name === c)?.type;
      // Dates as written (never through a local-time Date), times as text.
      return type === "date" || type === "time" ? `${ident(c)}::text AS ${ident(c)}` : ident(c);
    })
    .join(", ");
  const where =
    table.selection === "tenant_overrides_only" ? " WHERE tenant_id = app.current_tenant_id()" : "";
  const sql = `SELECT ${select} FROM public.${ident(table.name)}${where} ORDER BY 1`;
  const counts = { included: 0, legalHoldRows: 0, softDeleted: 0, sample: 0, otherTenantRows: 0 };
  const isPerson = table.name === "person";

  async function* rows(format: "csv" | "jsonl"): AsyncGenerator<string> {
    if (format === "csv") yield `${csvRow(table.columns.map((c) => c.name))}\n`;
    for await (const row of cursorRows(s, sql)) {
      if (
        plan.since &&
        !exportRowChangedSince(
          {
            createdAt: (row.created_at as Date | null) ?? null,
            updatedAt: (row.updated_at as Date | null) ?? null,
            recordedAt: (row.recorded_at as Date | null) ?? null,
            deletedAt: (row.deleted_at as Date | null) ?? null,
          },
          plan.since,
        )
      )
        continue;
      const decision = exportRowDecision({
        deletedAt: (row.deleted_at as Date | null) ?? null,
        legalHold: held(table.name, row, holds),
        destroyed: null,
        sample: false,
      });
      if (format === "csv") {
        if (decision.action !== "include") {
          if (decision.action === "exclude" && decision.reason === "soft_deleted")
            counts.softDeleted += 1;
          continue;
        }
        counts.included += 1;
        if (decision.reason === "legal_hold") counts.legalHoldRows += 1;
        if (row.tenant_id !== undefined && row.tenant_id !== s.tenantId)
          counts.otherTenantRows += 1;
        if (isPerson) people.add(String(row.id));
      } else if (decision.action !== "include") continue;
      const values = table.columns.map((c) =>
        c.derivedFrom
          ? ukDateOfInstant((row[c.derivedFrom] as Date | null) ?? null)
          : cell(row[c.name]),
      );
      yield format === "csv"
        ? `${csvRow(values)}\n`
        : `${JSON.stringify(Object.fromEntries(table.columns.map((c, i) => [c.name, values[i] ?? null])))}\n`;
    }
  }

  const csv = await zip.add(table.files.csv, rows("csv"));
  let jsonlRows = 0;
  const jsonl = await zip.add(
    table.files.jsonl,
    (async function* () {
      for await (const line of rows("jsonl")) {
        jsonlRows += 1;
        yield line;
      }
    })(),
  );
  return {
    name: table.name,
    files: [
      {
        path: csv.path,
        format: "csv",
        sha256: csv.sha256,
        bytes: csv.bytes,
        rows: counts.included,
      },
      {
        path: jsonl.path,
        format: "jsonl",
        sha256: jsonl.sha256,
        bytes: jsonl.bytes,
        rows: jsonlRows,
      },
    ],
    included: counts.included,
    legalHoldRows: counts.legalHoldRows,
    excluded: { softDeleted: counts.softDeleted, sample: counts.sample },
    otherTenantRows: counts.otherTenantRows,
  };
}

/** One row per exported person, from the same domain functions as the transfer pack (HZ-071). */
async function* summaryRows(
  s: Snapshot,
  people: ReadonlySet<string>,
  snapshotAt: Date,
): AsyncGenerator<string> {
  const db = drizzle(s.client);
  const [persons, allergies, advance, profiles] = await Promise.all([
    db.select().from(person),
    db.select().from(allergy).where(isNull(allergy.deletedAt)),
    db.select().from(advanceCareRecord).where(isNull(advanceCareRecord.deletedAt)),
    db.select().from(personCareProfile),
  ]);
  yield `${csvRow(CURRENT_SUMMARY_COLUMNS.map((c) => c.name))}\n`;
  for (const p of persons.filter((x) => people.has(x.id))) {
    const profile = profiles.find((x) => x.personId === p.id);
    const row: CurrentSummaryRow = currentSummaryRow({
      personId: p.id,
      allergies: allergyStatementOf(p, allergies),
      advanceCare: advance
        .filter((r) => r.personId === p.id)
        .map((r) => r as unknown as AdvanceCareRecordState),
      iddsi: { food: profile?.iddsiFoodLevel ?? null, drink: profile?.iddsiDrinkLevel ?? null },
      communication: communicationStatementOf(p),
      snapshotAt,
    });
    yield `${csvRow(CURRENT_SUMMARY_COLUMNS.map((c) => row[c.name]))}\n`;
  }
}

/**
 * Builds the export into `archiveKey` and answers its manifest. The archive is deleted again when
 * anything fails; the caller marks the export ready or failed.
 */
export async function buildExport(
  deps: {
    readonly appPool: pg.Pool;
    readonly storage: DocumentStoragePort;
    readonly exportStorage: DocumentStoragePort;
  },
  job: {
    readonly tenantId: string;
    readonly exportId: string;
    readonly requestedBy: string;
    readonly since: Date | null;
    readonly archiveKey: string;
  },
): Promise<BuiltExport> {
  const client = await deps.appPool.connect();
  const zip = new ZipWriter();
  const upload = deps.exportStorage.putStream(job.archiveKey, zip.output, "application/zip");
  upload.catch(() => undefined);
  try {
    await client.query("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY");
    await client.query(
      `SELECT set_config('app.tenant_id', $1, true), set_config('app.user_id', '', true),
              set_config('app.scope', 'tenant', true), set_config('app.location_ids', '', true)`,
      [job.tenantId],
    );
    const s: Snapshot = { client, tenantId: job.tenantId };
    const snapshotAt =
      (await client.query<{ at: Date }>("SELECT now() AS at")).rows[0]?.at ?? new Date();
    const plan = planExport(await databaseTables(client), { since: job.since });

    const holdRows = await client.query<{
      person_id: string | null;
      subject_type: string | null;
      subject_id: string | null;
    }>(
      "SELECT person_id, subject_type, subject_id FROM legal_hold WHERE released_at IS NULL AND deleted_at IS NULL",
    );
    const holds: Holds = {
      people: new Set(holdRows.rows.flatMap((h) => (h.person_id ? [h.person_id] : []))),
      subjects: new Set(
        holdRows.rows.flatMap((h) =>
          h.subject_type && h.subject_id ? [`${h.subject_type}:${h.subject_id}`] : [],
        ),
      ),
    };

    const schemaFile = await zip.add(
      EXPORT_SCHEMA_FILE,
      JSON.stringify(describeExportSchema(plan), null, 2),
    );
    const people = new Set<string>();
    const tables: WrittenTable[] = [];
    for (const table of plan.tables)
      tables.push(await writeTable(s, zip, table, plan, holds, people));

    const documents: WrittenDocument[] = [];
    for await (const d of cursorRows(
      s,
      `SELECT id, content_type, sha256, size_bytes, status, deleted_at,
        legal_hold, person_id, storage_key FROM document ORDER BY id`,
    )) {
      const decision = exportDocumentDecision({
        id: String(d.id),
        contentType: String(d.content_type),
        sha256: String(d.sha256),
        sizeBytes: Number(d.size_bytes),
        status: String(d.status),
        deletedAt: (d.deleted_at as Date | null) ?? null,
        legalHold: held("document", d, holds),
        destroyed: null,
        sample: false,
      });
      let writtenSha256: string | null = null;
      if (decision.action === "include_bytes") {
        const bytes = await deps.storage.getStream(String(d.storage_key));
        if (bytes) writtenSha256 = (await zip.add(decision.path, bytes)).sha256;
      }
      documents.push({ id: String(d.id), decision, writtenSha256 });
    }

    const destroyed: DestroyedRecord[] = [];
    for await (const c of cursorRows(
      s,
      "SELECT id, subject_type, subject_ids, executed_at FROM destruction_certificate ORDER BY executed_at",
    )) {
      if (job.since && (c.executed_at as Date) < job.since) continue;
      for (const id of c.subject_ids as string[]) {
        destroyed.push({
          table: String(c.subject_type),
          id,
          destroyedAt: c.executed_at as Date,
          certificateId: String(c.id),
        });
      }
    }
    await zip.add(
      EXPORT_DESTROYED_FILE,
      [
        `${csvRow(["table", "id", "destroyed_at", "certificate_id"])}\n`,
        ...destroyed.map(
          (r) => `${csvRow([r.table, r.id, r.destroyedAt.toISOString(), r.certificateId])}\n`,
        ),
      ].join(""),
    );

    let summaryCount = 0;
    const summary = await zip.add(
      EXPORT_CURRENT_SUMMARY_FILE,
      (async function* () {
        let first = true;
        for await (const line of summaryRows(s, people, snapshotAt)) {
          if (!first) summaryCount += 1;
          first = false;
          yield line;
        }
      })(),
    );

    const broken =
      (await client.query<{ at: string | null }>("SELECT app.verify_audit_chain()::text AS at"))
        .rows[0]?.at ?? null;
    const manifest = buildExportManifest({
      exportId: job.exportId,
      tenantId: job.tenantId,
      requestedBy: job.requestedBy,
      generatedAt: new Date(),
      snapshotAt,
      plan,
      schemaFile: { sha256: schemaFile.sha256, bytes: schemaFile.bytes },
      tables,
      currentSummary: {
        path: summary.path,
        format: "csv",
        sha256: summary.sha256,
        bytes: summary.bytes,
        rows: summaryCount,
      },
      documents,
      destroyed,
      auditChain: {
        verified: broken === null,
        firstBrokenPosition: broken === null ? null : Number(broken),
      },
    });
    const written = await zip.add(EXPORT_MANIFEST_FILE, JSON.stringify(manifest, null, 2));
    await zip.finish();
    await upload;
    await client.query("COMMIT");
    return { manifest, manifestSha256: written.sha256, bytes: zip.size, snapshotAt };
  } catch (error) {
    zip.output.destroy(error instanceof Error ? error : new Error("export failed"));
    await upload.catch(() => undefined);
    await deps.exportStorage.destroy(job.archiveKey).catch(() => undefined);
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}
