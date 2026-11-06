import { sql } from "drizzle-orm";
import {
  type AnyPgColumn,
  boolean,
  check,
  foreignKey,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  unique,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { sqlList } from "./_codes";
import { id, mutableColumns, tenantId } from "./_columns";
import { payRun } from "./pay";
import { tenantUser } from "./platform";

/**
 * Payroll and pension exports (scheduling.md section 19; SCHED-008; ADR-0013, ADR-0097): the
 * organisation's connection to its payroll provider (a Secret Manager reference, never a token)
 * and an append-only record of every export of a locked pay run. The file itself is never kept:
 * it is made again, identically, from the locked run. Row-level security and guards are in
 * migration 0127.
 */

/** `PAYROLL_FORMATS` in packages/domain; a test keeps the lists in step. */
export const PAYROLL_FORMAT_CODES = [
  "xero_payroll_uk",
  "staffology_csv",
  "sage_csv",
  "brightpay_csv",
] as const;
export const PAYROLL_PROVIDER_CODES = ["xero_payroll_uk"] as const;
/** A file is generated; an API export is pending until its result is recorded. */
export const PAYROLL_EXPORT_OUTCOME_CODES = ["generated", "pending"] as const;
/** An API export's result: `unknown` when the provider's answer never came (timeout). */
export const PAYROLL_EXPORT_RESULT_CODES = ["sent", "failed", "unknown"] as const;

const staffRef = (name: string, t: { tenantId: AnyPgColumn }, column: AnyPgColumn) =>
  foreignKey({
    name,
    columns: [t.tenantId, column],
    foreignColumns: [tenantUser.tenantId, tenantUser.id],
  });

/** An organisation's connection to a payroll provider's API (rule 8): off until connected. */
export const payrollConnection = pgTable(
  "payroll_connection",
  {
    id: id(),
    tenantId: tenantId(),
    provider: text("provider").notNull(),
    /** The provider's own id for the organisation (a Xero tenant id). */
    externalOrganisationId: text("external_organisation_id").notNull(),
    /**
     * The name of the secret holding the OAuth tokens, in the managed secret store. Made by the
     * database from the organisation, the provider and the connection, never from a request.
     */
    secretRef: text("secret_ref").notNull().default(""),
    status: text("status").notNull().default("connected"),
    connectedBy: uuid("connected_by").notNull(),
    connectedAt: timestamp("connected_at", { withTimezone: true }).notNull().defaultNow(),
    disconnectedAt: timestamp("disconnected_at", { withTimezone: true }),
    ...mutableColumns(),
  },
  (t) => [
    unique("payroll_connection_tenant_id_id_key").on(t.tenantId, t.id),
    staffRef("payroll_connection_connected_by_fk", t, t.connectedBy),
    uniqueIndex("payroll_connection_live_key")
      .on(t.tenantId, t.provider)
      .where(sql`status = 'connected' AND deleted_at IS NULL`),
    check("payroll_connection_provider", sql`provider IN (${sqlList(PAYROLL_PROVIDER_CODES)})`),
    check("payroll_connection_status", sql`status IN ('connected', 'disconnected')`),
    check(
      "payroll_connection_disconnected",
      sql`(status = 'disconnected') = (disconnected_at IS NOT NULL)`,
    ),
    check("payroll_connection_external_id", sql`external_organisation_id ~ '^[A-Za-z0-9-]{1,64}$'`),
    // The organisation's own secret only: never a name a caller chose.
    check(
      "payroll_connection_secret_ref",
      sql`secret_ref = 'payroll/' || tenant_id::text || '/' || provider || '/' || id::text`,
    ),
  ],
);

/** One export of a locked pay run's calculation (rules 1 to 6): append-only. */
export const payrollExport = pgTable(
  "payroll_export",
  {
    id: id(),
    tenantId: tenantId(),
    runId: uuid("run_id").notNull(),
    calculation: integer("calculation").notNull(),
    format: text("format").notNull(),
    formatVersion: integer("format_version").notNull(),
    lineCount: integer("line_count").notNull(),
    contentSha256: text("content_sha256").notNull(),
    reexport: boolean("reexport").notNull().default(false),
    outcome: text("outcome").notNull(),
    /**
     * Member id to payroll reference, as exported: a re-export reuses the first export's, so the
     * same calculation always gives the same content (rule 5).
     */
    payrollReferences: jsonb("payroll_references").notNull(),
    exportedBy: uuid("exported_by").notNull(),
    exportedAt: timestamp("exported_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    unique("payroll_export_tenant_id_id_key").on(t.tenantId, t.id),
    foreignKey({
      name: "payroll_export_run_fk",
      columns: [t.tenantId, t.runId],
      foreignColumns: [payRun.tenantId, payRun.id],
    }),
    staffRef("payroll_export_exported_by_fk", t, t.exportedBy),
    index("payroll_export_run_idx").on(t.tenantId, t.runId, t.exportedAt),
    check("payroll_export_format", sql`format IN (${sqlList(PAYROLL_FORMAT_CODES)})`),
    check("payroll_export_outcome", sql`outcome IN (${sqlList(PAYROLL_EXPORT_OUTCOME_CODES)})`),
    check("payroll_export_hash", sql`content_sha256 ~ '^[0-9a-f]{64}$'`),
    check(
      "payroll_export_counts",
      sql`line_count >= 0 AND format_version >= 1 AND calculation >= 1`,
    ),
    check("payroll_export_references", sql`jsonb_typeof(payroll_references) = 'object'`),
  ],
);

/**
 * The provider's result for an API export (rule 8), recorded after the call and outside the
 * export's transaction: append-only, at most one per export. An export with no result is treated
 * as sent until shown otherwise.
 */
export const payrollExportResult = pgTable(
  "payroll_export_result",
  {
    id: id(),
    tenantId: tenantId(),
    exportId: uuid("export_id").notNull(),
    outcome: text("outcome").notNull(),
    /** The provider's batch id, when it gave one. */
    externalRef: text("external_ref"),
    recordedBy: uuid("recorded_by").notNull(),
    recordedAt: timestamp("recorded_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    unique("payroll_export_result_tenant_id_id_key").on(t.tenantId, t.id),
    uniqueIndex("payroll_export_result_export_key").on(t.tenantId, t.exportId),
    foreignKey({
      name: "payroll_export_result_export_fk",
      columns: [t.tenantId, t.exportId],
      foreignColumns: [payrollExport.tenantId, payrollExport.id],
    }),
    staffRef("payroll_export_result_recorded_by_fk", t, t.recordedBy),
    check(
      "payroll_export_result_outcome",
      sql`outcome IN (${sqlList(PAYROLL_EXPORT_RESULT_CODES)})`,
    ),
    check(
      "payroll_export_result_external_ref",
      sql`(external_ref IS NULL OR external_ref ~ '^[A-Za-z0-9-]{1,64}$') AND (external_ref IS NULL OR outcome = 'sent')`,
    ),
  ],
);
