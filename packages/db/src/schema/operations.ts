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
  uuid,
} from "drizzle-orm/pg-core";
import { sqlList } from "./_codes";
import { createdColumns, id, mutableColumns, tenantId } from "./_columns";
import { document, location, tenantUser } from "./platform";
import { workflowInstance } from "./work";

/**
 * Operations: the downtime pack and outages (master prompt 13.4; docs/specs/operations.md section
 * 2; hazards HZ-017 and HZ-021). Rules live in packages/domain/src/operations; these tables store
 * what they produce. Row-level security and the outage guard are in migration 0051.
 */

/** How a pack was built (data-standards.md, `downtime_pack.source`). */
export const DOWNTIME_PACK_SOURCES = ["server_nightly", "server_on_demand", "kiosk_cache"] as const;
/** `OUTAGE_KINDS` in packages/domain; a test keeps the list in step. */
export const OUTAGE_KIND_CODES = [
  "power",
  "network",
  "harbour_unavailable",
  "device_failure",
  "planned_maintenance",
  "other",
] as const;
/** `OUTAGE_WORKFLOW` states in packages/domain; a test keeps the list in step. */
export const OUTAGE_STATES = ["declared", "closed", "reconciled", "cancelled"] as const;

const staffRef = (name: string, t: { tenantId: AnyPgColumn }, column: AnyPgColumn) =>
  foreignKey({
    name,
    columns: [t.tenantId, column],
    foreignColumns: [tenantUser.tenantId, tenantUser.id],
  });

/**
 * One downtime pack for a location (`assembleDowntimePack`): append-only, never changed. A pack
 * follows its location, and its content the people on it: it is visible only to someone who may see
 * every one of them (operations.md section 2). Retention `downtime_pack`, or `downtime_record` for a
 * pack in force during a declared outage, worked out from the outages at its location.
 */
export const downtimePack = pgTable(
  "downtime_pack",
  {
    id: id(),
    tenantId: tenantId(),
    locationId: uuid("location_id").notNull(),
    source: text("source").notNull(),
    generatedAt: timestamp("generated_at", { withTimezone: true }).notNull(),
    /** When the information was read: the server's read time, or a kiosk's last sync. */
    asAt: timestamp("as_at", { withTimezone: true }).notNull(),
    /** `as_at` plus `downtime_pack.valid_hours`. */
    validUntil: timestamp("valid_until", { withTimezone: true }).notNull(),
    /** Null for the nightly job (the system); the member who built it otherwise. */
    generatedBy: uuid("generated_by"),
    /** Everyone with a page in the pack: the row-level security policy reads it. */
    personIds: uuid("person_ids").array().notNull(),
    /** The `DowntimePack` snapshot as JSON. */
    content: jsonb("content").notNull(),
    /** Warnings by kind and section: counts and opaque ids only, never words. */
    warnings: jsonb("warnings").notNull().default(sql`'{}'::jsonb`),
    /** The rendered PDF, when the server rendered one. */
    documentId: uuid("document_id"),
    ...createdColumns(),
  },
  (t) => [
    foreignKey({
      name: "downtime_pack_location_fk",
      columns: [t.tenantId, t.locationId],
      foreignColumns: [location.tenantId, location.id],
    }),
    staffRef("downtime_pack_generated_by_fk", t, t.generatedBy),
    foreignKey({
      name: "downtime_pack_document_fk",
      columns: [t.tenantId, t.documentId],
      foreignColumns: [document.tenantId, document.id],
    }),
    check("downtime_pack_source", sql`source IN (${sqlList(DOWNTIME_PACK_SOURCES)})`),
    // The nightly pack is the system's; one built on demand or on a kiosk names its member.
    check("downtime_pack_generated_by", sql`(source = 'server_nightly') = (generated_by IS NULL)`),
    check("downtime_pack_times", sql`as_at <= generated_at AND valid_until > as_at`),
    check(
      "downtime_pack_json",
      sql`jsonb_typeof(content) = 'object' AND jsonb_typeof(warnings) = 'object'`,
    ),
    index("downtime_pack_location_idx").on(t.tenantId, t.locationId, t.generatedAt),
  ],
);

/**
 * An outage at a location (`OUTAGE_WORKFLOW`): declared, closed when systems return, reconciled
 * once every paper record is entered and checked, or cancelled when declared in error. Mutable and
 * versioned; windows at a location never overlap (an exclusion constraint), and a guard keeps the
 * window back-entries rely on (migration 0051).
 */
export const outage = pgTable(
  "outage",
  {
    id: id(),
    tenantId: tenantId(),
    locationId: uuid("location_id").notNull(),
    kind: text("kind").notNull(),
    description: text("description").notNull(),
    state: text("state").notNull().default("declared"),
    workflowInstanceId: uuid("workflow_instance_id"),
    /** When it began, which may be before it was declared. */
    startedAt: timestamp("started_at", { withTimezone: true }).notNull(),
    /** When systems came back; null while it is open. */
    endedAt: timestamp("ended_at", { withTimezone: true }),
    declaredAt: timestamp("declared_at", { withTimezone: true }).notNull().defaultNow(),
    declaredBy: uuid("declared_by").notNull().default(sql`app.current_user_id()`),
    /** Declared more than `care_note.late_entry_hours` after it began. */
    declaredLate: boolean("declared_late").notNull().default(false),
    closedAt: timestamp("closed_at", { withTimezone: true }),
    closedBy: uuid("closed_by"),
    /** The closure plus `downtime.back_entry_due_hours`. */
    backEntryDueAt: timestamp("back_entry_due_at", { withTimezone: true }),
    reconciledAt: timestamp("reconciled_at", { withTimezone: true }),
    reconciledBy: uuid("reconciled_by"),
    reconciliationStatement: text("reconciliation_statement"),
    /** The possible duplicates reviewed before reconciling (entry ids from the care tables). */
    reviewedEntryIds: uuid("reviewed_entry_ids").array().notNull().default(sql`'{}'::uuid[]`),
    /** Distinct paper forms entered. */
    formsEntered: integer("forms_entered"),
    cancelledAt: timestamp("cancelled_at", { withTimezone: true }),
    cancelledBy: uuid("cancelled_by"),
    cancellationReason: text("cancellation_reason"),
    ...mutableColumns(),
  },
  (t) => [
    unique("outage_tenant_id_id_key").on(t.tenantId, t.id),
    foreignKey({
      name: "outage_location_fk",
      columns: [t.tenantId, t.locationId],
      foreignColumns: [location.tenantId, location.id],
    }),
    foreignKey({
      name: "outage_workflow_fk",
      columns: [t.tenantId, t.workflowInstanceId],
      foreignColumns: [workflowInstance.tenantId, workflowInstance.id],
    }),
    staffRef("outage_declared_by_fk", t, t.declaredBy),
    staffRef("outage_closed_by_fk", t, t.closedBy),
    staffRef("outage_reconciled_by_fk", t, t.reconciledBy),
    staffRef("outage_cancelled_by_fk", t, t.cancelledBy),
    check("outage_kind", sql`kind IN (${sqlList(OUTAGE_KIND_CODES)})`),
    check("outage_state", sql`state IN (${sqlList(OUTAGE_STATES)})`),
    check("outage_description", sql`char_length(btrim(description)) > 0`),
    check("outage_window", sql`ended_at IS NULL OR ended_at >= started_at`),
    check(
      "outage_closed",
      sql`(state IN ('closed', 'reconciled')) = (closed_at IS NOT NULL AND closed_by IS NOT NULL
        AND ended_at IS NOT NULL AND back_entry_due_at IS NOT NULL)`,
    ),
    check(
      "outage_reconciled",
      sql`(state = 'reconciled') = (reconciled_at IS NOT NULL AND reconciled_by IS NOT NULL
        AND reconciliation_statement IS NOT NULL AND forms_entered IS NOT NULL)`,
    ),
    check("outage_forms_entered", sql`forms_entered IS NULL OR forms_entered >= 0`),
    check(
      "outage_cancelled",
      sql`(state = 'cancelled') = (cancelled_at IS NOT NULL AND cancelled_by IS NOT NULL
        AND cancellation_reason IS NOT NULL)`,
    ),
    index("outage_location_idx").on(t.tenantId, t.locationId, t.startedAt),
  ],
);
