import { sql } from "drizzle-orm";
import {
  type AnyPgColumn,
  boolean,
  check,
  foreignKey,
  index,
  integer,
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
export const PAYROLL_EXPORT_OUTCOME_CODES = ["generated", "sent", "failed"] as const;

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
    /** The name of the secret holding the OAuth tokens, in the managed secret store. */
    secretRef: text("secret_ref").notNull(),
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
    // A secret's name only: lower case, digits and dashes, never a token's shape.
    check("payroll_connection_secret_ref", sql`secret_ref ~ '^[a-z][a-z0-9-]{2,99}$'`),
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
    /** The provider's batch id for an API export. */
    externalRef: text("external_ref"),
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
    check(
      "payroll_export_external_ref",
      sql`external_ref IS NULL OR external_ref ~ '^[A-Za-z0-9-]{1,64}$'`,
    ),
  ],
);
