import { sql } from "drizzle-orm";
import {
  bigint,
  check,
  foreignKey,
  index,
  jsonb,
  pgTable,
  text,
  timestamp,
  unique,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { id, mutableColumns, tenantId } from "./_columns";
import { tenant, tenantUser } from "./platform";

/**
 * The organisation's free full export (PLAT-015; platform-completions.md rules 10 to 16): who asked,
 * where it stands, the one snapshot it was read from, the archive's place in storage and its
 * manifest checksum, and the single download with who made it. The archive itself is deleted at
 * expiry, after its download or when revoked; this record is kept (`audit_event` class).
 */
export const tenantExport = pgTable(
  "tenant_export",
  {
    id: id(),
    tenantId: tenantId().references(() => tenant.id),
    /** `full`, or `changes_since` an earlier export's snapshot. */
    kind: text("kind").notNull().default("full"),
    since: timestamp("since", { withTimezone: true }),
    /** `EXPORT_STATUSES` in packages/domain. */
    status: text("status").notNull().default("queued"),
    requestedBy: uuid("requested_by").notNull().default(sql`app.current_user_id()`),
    requestedAt: timestamp("requested_at", { withTimezone: true }).notNull().defaultNow(),
    startedAt: timestamp("started_at", { withTimezone: true }),
    snapshotAt: timestamp("snapshot_at", { withTimezone: true }),
    readyAt: timestamp("ready_at", { withTimezone: true }),
    expiresAt: timestamp("expires_at", { withTimezone: true }),
    failedAt: timestamp("failed_at", { withTimezone: true }),
    revokedAt: timestamp("revoked_at", { withTimezone: true }),
    revokedBy: uuid("revoked_by"),
    schemaVersion: text("schema_version"),
    /** `tenants/<tenant>/exports/<export>/export.zip`; never exported. */
    storageKey: text("storage_key"),
    bytes: bigint("bytes", { mode: "number" }),
    manifestSha256: text("manifest_sha256"),
    problems: jsonb("problems").notNull().default(sql`'[]'::jsonb`),
    warnings: jsonb("warnings").notNull().default(sql`'[]'::jsonb`),
    /** The one download: when, and by whom (always the requester). */
    downloadedAt: timestamp("downloaded_at", { withTimezone: true }),
    downloadedBy: uuid("downloaded_by"),
    ...mutableColumns(),
  },
  (t) => [
    unique("tenant_export_tenant_id_id_key").on(t.tenantId, t.id),
    // One export at a time per organisation (rule 15): asking again returns the one in hand.
    uniqueIndex("tenant_export_one_running_key")
      .on(t.tenantId)
      .where(sql`status IN ('queued', 'running')`),
    index("tenant_export_requested_idx").on(t.tenantId, t.requestedAt),
    foreignKey({
      name: "tenant_export_requested_by_fk",
      columns: [t.tenantId, t.requestedBy],
      foreignColumns: [tenantUser.tenantId, tenantUser.id],
    }),
    foreignKey({
      name: "tenant_export_revoked_by_fk",
      columns: [t.tenantId, t.revokedBy],
      foreignColumns: [tenantUser.tenantId, tenantUser.id],
    }),
    foreignKey({
      name: "tenant_export_downloaded_by_fk",
      columns: [t.tenantId, t.downloadedBy],
      foreignColumns: [tenantUser.tenantId, tenantUser.id],
    }),
    check("tenant_export_kind", sql`kind IN ('full', 'changes_since')`),
    check("tenant_export_since", sql`(kind = 'changes_since') = (since IS NOT NULL)`),
    check(
      "tenant_export_status",
      sql`status IN ('queued', 'running', 'ready', 'failed', 'expired', 'revoked')`,
    ),
    check(
      "tenant_export_ready",
      sql`status <> 'ready' OR (ready_at IS NOT NULL AND expires_at IS NOT NULL
        AND storage_key IS NOT NULL AND manifest_sha256 IS NOT NULL AND snapshot_at IS NOT NULL)`,
    ),
    check(
      "tenant_export_revoked",
      sql`(status = 'revoked') = (revoked_at IS NOT NULL AND revoked_by IS NOT NULL)`,
    ),
    check("tenant_export_failed", sql`(status = 'failed') = (failed_at IS NOT NULL)`),
    check(
      "tenant_export_downloaded",
      sql`(downloaded_at IS NULL) = (downloaded_by IS NULL)
        AND (downloaded_by IS NULL OR downloaded_by = requested_by)`,
    ),
    check(
      "tenant_export_storage_key",
      sql`storage_key IS NULL OR storage_key = 'tenants/' || tenant_id || '/exports/' || id || '/export.zip'`,
    ),
    check(
      "tenant_export_manifest_sha256",
      sql`manifest_sha256 IS NULL OR manifest_sha256 ~ '^[0-9a-f]{64}$'`,
    ),
    check("tenant_export_bytes", sql`bytes IS NULL OR bytes >= 0`),
  ],
);
