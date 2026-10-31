import { sql } from "drizzle-orm";
import {
  check,
  foreignKey,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  unique,
  uuid,
} from "drizzle-orm/pg-core";
import { sqlList } from "./_codes";
import { createdColumns, id, tenantId } from "./_columns";
import { location, tenant, tenantUser } from "./platform";

/** `IMPORT_RECORD_TYPES` in packages/domain (imports.ts). */
export const IMPORT_RECORD_TYPE_SQL = sqlList(["people"]);
/** `IMPORT_BATCH_STATUSES` in packages/domain (imports.ts). */
export const IMPORT_BATCH_STATUS_SQL = sqlList([
  "staged",
  "committed",
  "undone",
  "discarded",
  "expired",
]);

/**
 * The import wizard (PLAT-014; platform.md rules 18 to 26; ADR-0092; HZ-130; migration 0088). A
 * batch is one upload: what kind of record, for which location, by whom and when, and where it
 * stands. It holds opaque ids, counts and times only, never a file name, a heading or a value, and
 * is kept as the record of what happened (`audit_event` class). Only a member holding
 * `platform.import.run` across the organisation, in a request scoped to the whole organisation,
 * reaches it (rule 18).
 */
export const importBatch = pgTable(
  "import_batch",
  {
    id: id(),
    tenantId: tenantId().references(() => tenant.id),
    /** `people` in slice 26. */
    recordType: text("record_type").notNull(),
    /** Every person the batch imports lives here. */
    locationId: uuid("location_id").notNull(),
    status: text("status").notNull().default("staged"),
    rowCount: integer("row_count").notNull(),
    uploadedBy: uuid("uploaded_by").notNull().default(sql`app.current_user_id()`),
    uploadedAt: timestamp("uploaded_at", { withTimezone: true }).notNull().defaultNow(),
    /** `uploaded_at` plus `import.staging_expiry_days`: the staged rows go then if still staged. */
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    /** The latest dry run: when, by whom, and how many errors and warnings it found. */
    dryRunAt: timestamp("dry_run_at", { withTimezone: true }),
    dryRunBy: uuid("dry_run_by"),
    dryRunErrors: integer("dry_run_errors"),
    dryRunWarnings: integer("dry_run_warnings"),
    /** When the batch stopped being staged (committed, discarded or expired), and by whom. */
    closedAt: timestamp("closed_at", { withTimezone: true }),
    closedBy: uuid("closed_by"),
    ...createdColumns(),
  },
  (t) => [
    unique("import_batch_tenant_id_id_key").on(t.tenantId, t.id),
    foreignKey({
      name: "import_batch_location_fk",
      columns: [t.tenantId, t.locationId],
      foreignColumns: [location.tenantId, location.id],
    }),
    foreignKey({
      name: "import_batch_uploaded_by_fk",
      columns: [t.tenantId, t.uploadedBy],
      foreignColumns: [tenantUser.tenantId, tenantUser.id],
    }),
    foreignKey({
      name: "import_batch_dry_run_by_fk",
      columns: [t.tenantId, t.dryRunBy],
      foreignColumns: [tenantUser.tenantId, tenantUser.id],
    }),
    foreignKey({
      name: "import_batch_closed_by_fk",
      columns: [t.tenantId, t.closedBy],
      foreignColumns: [tenantUser.tenantId, tenantUser.id],
    }),
    check("import_batch_record_type", sql`record_type IN (${IMPORT_RECORD_TYPE_SQL})`),
    check("import_batch_status", sql`status IN (${IMPORT_BATCH_STATUS_SQL})`),
    check("import_batch_rows", sql`row_count >= 1`),
    check("import_batch_closed", sql`(status = 'staged') = (closed_at IS NULL)`),
    check(
      "import_batch_dry_run",
      sql`(dry_run_at IS NULL) = (dry_run_errors IS NULL)
        AND (dry_run_at IS NULL) = (dry_run_warnings IS NULL)
        AND coalesce(dry_run_errors, 0) >= 0 AND coalesce(dry_run_warnings, 0) >= 0`,
    ),
    index("import_batch_staged_idx").on(t.tenantId, t.expiresAt).where(sql`status = 'staged'`),
  ],
);

/**
 * The quarantine (rules 19 and 25): each data row of a staged batch, as the matched columns' text
 * keyed by Harbour field, exactly as given. Personal data that is not yet anyone's record: inserted
 * with its batch, never changed, and deleted, every row of the batch, in the transaction that
 * commits, discards or expires it (`app.import_batch_closed`).
 */
export const importRow = pgTable(
  "import_row",
  {
    id: id(),
    tenantId: tenantId().references(() => tenant.id),
    batchId: uuid("batch_id").notNull(),
    /** 1 is the first row under the header, as the dry-run report counts. */
    rowNumber: integer("row_number").notNull(),
    /** Harbour field key to the cell's text as given. */
    cells: jsonb("cells").notNull(),
    ...createdColumns(),
  },
  (t) => [
    unique("import_row_tenant_id_id_key").on(t.tenantId, t.id),
    unique("import_row_batch_row_key").on(t.tenantId, t.batchId, t.rowNumber),
    foreignKey({
      name: "import_row_batch_fk",
      columns: [t.tenantId, t.batchId],
      foreignColumns: [importBatch.tenantId, importBatch.id],
    }),
    check("import_row_number", sql`row_number >= 1`),
    check("import_row_cells", sql`jsonb_typeof(cells) = 'object'`),
  ],
);

/**
 * The commit record (rules 23 and 24): one per committed batch, with the ids of the records it
 * created, who committed it and when, and its undo. Committing again finds this row (idempotent).
 * Undone only by `app.undo_import_batch`.
 */
export const importCommit = pgTable(
  "import_commit",
  {
    id: id(),
    tenantId: tenantId().references(() => tenant.id),
    batchId: uuid("batch_id").notNull(),
    /** The people (or later, other records) the commit created; kept as opaque ids after undo. */
    recordIds: uuid("record_ids").array().notNull(),
    recordCount: integer("record_count").notNull(),
    committedBy: uuid("committed_by").notNull().default(sql`app.current_user_id()`),
    committedAt: timestamp("committed_at", { withTimezone: true }).notNull().defaultNow(),
    undoneAt: timestamp("undone_at", { withTimezone: true }),
    undoneBy: uuid("undone_by"),
    ...createdColumns(),
  },
  (t) => [
    unique("import_commit_tenant_id_id_key").on(t.tenantId, t.id),
    unique("import_commit_batch_key").on(t.tenantId, t.batchId),
    foreignKey({
      name: "import_commit_batch_fk",
      columns: [t.tenantId, t.batchId],
      foreignColumns: [importBatch.tenantId, importBatch.id],
    }),
    foreignKey({
      name: "import_commit_committed_by_fk",
      columns: [t.tenantId, t.committedBy],
      foreignColumns: [tenantUser.tenantId, tenantUser.id],
    }),
    foreignKey({
      name: "import_commit_undone_by_fk",
      columns: [t.tenantId, t.undoneBy],
      foreignColumns: [tenantUser.tenantId, tenantUser.id],
    }),
    check("import_commit_count", sql`record_count = cardinality(record_ids) AND record_count >= 1`),
    check("import_commit_undone", sql`(undone_at IS NULL) = (undone_by IS NULL)`),
  ],
);
