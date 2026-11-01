import { sql } from "drizzle-orm";
import {
  type AnyPgColumn,
  boolean,
  check,
  date,
  foreignKey,
  index,
  integer,
  numeric,
  pgTable,
  text,
  timestamp,
  unique,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { sqlList } from "./_codes";
import { id, mutableColumns, tenantId } from "./_columns";
import { medication, medicationAdministration } from "./medicines";
import { person } from "./people";
import { location, tenantUser } from "./platform";

/**
 * Medicines stock, ordering, disposal and storage temperatures (medicines.md section 15;
 * MEDS-008; plan slice 42; ADR-0103; migration 0138). Stock is kept per person and per dm+d
 * product, never for a controlled drug (its register is section 14). Movements and readings are
 * append-only; guards and row-level security are in migration 0138.
 */

/** `STOCK_MOVEMENTS` and friends in packages/domain (stock.ts); a test keeps them in step. */
export const STOCK_MOVEMENT_CODES = [
  "receipt",
  "carried_forward",
  "administration",
  "returned",
  "disposal",
  "administration_correction",
  "count_adjustment",
] as const;
export const DISPOSAL_REASON_CODES = [
  "refused_dose",
  "dropped_or_spoilt",
  "out_of_date",
  "discontinued",
  "person_left",
  "other",
] as const;
export const ORDER_STATUS_CODES = [
  "draft",
  "submitted",
  "part_received",
  "received",
  "cancelled",
] as const;
export const STORAGE_KIND_CODES = ["fridge", "room"] as const;

const personRef = (name: string, t: { tenantId: AnyPgColumn; personId: AnyPgColumn }) =>
  foreignKey({
    name,
    columns: [t.tenantId, t.personId],
    foreignColumns: [person.tenantId, person.id],
  });
const memberRef = (name: string, tenant: AnyPgColumn, member: AnyPgColumn) =>
  foreignKey({
    name,
    columns: [tenant, member],
    foreignColumns: [tenantUser.tenantId, tenantUser.id],
  });
const locationRef = (name: string, t: { tenantId: AnyPgColumn; locationId: AnyPgColumn }) =>
  foreignKey({
    name,
    columns: [t.tenantId, t.locationId],
    foreignColumns: [location.tenantId, location.id],
  });
const quantity = (name: string) => numeric(name, { precision: 12, scale: 3, mode: "number" });

/** One person's stock of one product (rule 1), opened from a MAR entry in its dose unit. */
export const medicineStockItem = pgTable(
  "medicine_stock_item",
  {
    id: id(),
    tenantId: tenantId(),
    personId: uuid("person_id").notNull(),
    medicationId: uuid("medication_id").notNull(),
    vmpId: text("vmp_id").notNull(),
    productName: text("product_name").notNull(),
    unitCode: text("unit_code").notNull(),
    unitName: text("unit_name").notNull(),
    openedBy: uuid("opened_by").notNull(),
    openedAt: timestamp("opened_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    unique("medicine_stock_item_tenant_id_id_key").on(t.tenantId, t.id),
    unique("medicine_stock_item_person_vmp_key").on(t.tenantId, t.personId, t.vmpId),
    personRef("medicine_stock_item_person_fk", t),
    foreignKey({
      name: "medicine_stock_item_medication_fk",
      columns: [t.tenantId, t.personId, t.medicationId],
      foreignColumns: [medication.tenantId, medication.personId, medication.id],
    }),
    memberRef("medicine_stock_item_opened_by_fk", t.tenantId, t.openedBy),
    check("medicine_stock_item_vmp", sql`vmp_id ~ '^[0-9]{6,18}$'`),
    check(
      "medicine_stock_item_names",
      sql`length(btrim(product_name)) > 0 AND length(btrim(unit_code)) > 0 AND length(btrim(unit_name)) > 0`,
    ),
  ],
);

/** Every change to an item's stock, in sequence, with the balance after it (rules 2 to 5). */
export const medicineStockMovement = pgTable(
  "medicine_stock_movement",
  {
    id: id(),
    tenantId: tenantId(),
    itemId: uuid("item_id").notNull(),
    personId: uuid("person_id").notNull(),
    seq: integer("seq").notNull(),
    movement: text("movement").notNull(),
    change: quantity("change").notNull(),
    balanceAfter: quantity("balance_after").notNull(),
    /** For an administration or its correction. */
    administrationId: uuid("administration_id"),
    /** For a receipt that fills an order line. */
    orderLineId: uuid("order_line_id"),
    /** For a disposal. */
    disposalId: uuid("disposal_id"),
    /** For a count adjustment, and a correction. */
    reason: text("reason"),
    recordedBy: uuid("recorded_by").notNull(),
    recordedAt: timestamp("recorded_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    unique("medicine_stock_movement_tenant_id_id_key").on(t.tenantId, t.id),
    unique("medicine_stock_movement_seq_key").on(t.tenantId, t.itemId, t.seq),
    uniqueIndex("medicine_stock_movement_administration_key")
      .on(t.tenantId, t.administrationId)
      .where(sql`movement = 'administration'`),
    foreignKey({
      name: "medicine_stock_movement_item_fk",
      columns: [t.tenantId, t.itemId],
      foreignColumns: [medicineStockItem.tenantId, medicineStockItem.id],
    }),
    personRef("medicine_stock_movement_person_fk", t),
    foreignKey({
      name: "medicine_stock_movement_administration_fk",
      columns: [t.tenantId, t.administrationId],
      foreignColumns: [medicationAdministration.tenantId, medicationAdministration.id],
    }),
    memberRef("medicine_stock_movement_recorded_by_fk", t.tenantId, t.recordedBy),
    index("medicine_stock_movement_item_idx").on(t.tenantId, t.itemId, t.seq),
    check("medicine_stock_movement_kind", sql`movement IN (${sqlList(STOCK_MOVEMENT_CODES)})`),
    check("medicine_stock_movement_seq", sql`seq >= 1`),
    check(
      "medicine_stock_movement_sign",
      sql`change <> 0 AND CASE movement
        WHEN 'receipt' THEN change > 0 WHEN 'carried_forward' THEN change > 0
        WHEN 'administration' THEN change < 0 WHEN 'returned' THEN change < 0
        WHEN 'disposal' THEN change < 0 ELSE true END`,
    ),
    check(
      "medicine_stock_movement_refs",
      sql`(movement IN ('administration', 'administration_correction')) = (administration_id IS NOT NULL)
        AND (movement = 'disposal') = (disposal_id IS NOT NULL)
        AND (order_line_id IS NULL OR movement = 'receipt')
        AND (movement <> 'count_adjustment' OR length(btrim(coalesce(reason, ''))) >= 3)
        AND (reason IS NULL OR length(reason) <= 500)`,
    ),
  ],
);

/** A disposal of a person's medicine, witnessed per the organisation's policy (rule 5). */
export const medicineDisposal = pgTable(
  "medicine_disposal",
  {
    id: id(),
    tenantId: tenantId(),
    itemId: uuid("item_id").notNull(),
    personId: uuid("person_id").notNull(),
    locationId: uuid("location_id").notNull(),
    quantity: quantity("quantity").notNull(),
    reason: text("reason").notNull(),
    note: text("note"),
    recordedBy: uuid("recorded_by").notNull(),
    recordedAt: timestamp("recorded_at", { withTimezone: true }).notNull().defaultNow(),
    /** The member named to witness it, who confirms it themselves. */
    witnessId: uuid("witness_id"),
    witnessedAt: timestamp("witnessed_at", { withTimezone: true }),
    /** Where the policy allows: why no one could witness it. */
    noWitnessReason: text("no_witness_reason"),
    ...mutableColumns(),
  },
  (t) => [
    unique("medicine_disposal_tenant_id_id_key").on(t.tenantId, t.id),
    foreignKey({
      name: "medicine_disposal_item_fk",
      columns: [t.tenantId, t.itemId],
      foreignColumns: [medicineStockItem.tenantId, medicineStockItem.id],
    }),
    personRef("medicine_disposal_person_fk", t),
    locationRef("medicine_disposal_location_fk", t),
    memberRef("medicine_disposal_recorded_by_fk", t.tenantId, t.recordedBy),
    memberRef("medicine_disposal_witness_fk", t.tenantId, t.witnessId),
    check("medicine_disposal_quantity", sql`quantity > 0`),
    check("medicine_disposal_reason", sql`reason IN (${sqlList(DISPOSAL_REASON_CODES)})`),
    check(
      "medicine_disposal_note",
      sql`(note IS NULL OR length(note) <= 500) AND (reason <> 'other' OR length(btrim(coalesce(note, ''))) >= 3)`,
    ),
    check(
      "medicine_disposal_witness",
      sql`(witness_id IS NULL) <> (no_witness_reason IS NULL)
        AND (witnessed_at IS NULL OR witness_id IS NOT NULL)
        AND (witness_id IS NULL OR witness_id <> recorded_by)
        AND (no_witness_reason IS NULL OR length(btrim(no_witness_reason)) BETWEEN 10 AND 500)`,
    ),
  ],
);

/** A location's 28-day cycle, by the first day of one cycle (rule 6). */
export const medicineOrderCycle = pgTable(
  "medicine_order_cycle",
  {
    id: id(),
    tenantId: tenantId(),
    locationId: uuid("location_id").notNull(),
    anchorOn: date("anchor_on").notNull(),
    ...mutableColumns(),
  },
  (t) => [
    unique("medicine_order_cycle_tenant_id_id_key").on(t.tenantId, t.id),
    unique("medicine_order_cycle_location_key").on(t.tenantId, t.locationId),
    locationRef("medicine_order_cycle_location_fk", t),
  ],
);

/** A location's order for a cycle (rule 7). */
export const medicineOrder = pgTable(
  "medicine_order",
  {
    id: id(),
    tenantId: tenantId(),
    locationId: uuid("location_id").notNull(),
    cycleStartsOn: date("cycle_starts_on").notNull(),
    status: text("status").notNull().default("draft"),
    sentVia: text("sent_via"),
    pharmacyReference: text("pharmacy_reference"),
    submittedBy: uuid("submitted_by"),
    submittedAt: timestamp("submitted_at", { withTimezone: true }),
    ...mutableColumns(),
  },
  (t) => [
    unique("medicine_order_tenant_id_id_key").on(t.tenantId, t.id),
    uniqueIndex("medicine_order_cycle_key")
      .on(t.tenantId, t.locationId, t.cycleStartsOn)
      .where(sql`status <> 'cancelled'`),
    locationRef("medicine_order_location_fk", t),
    memberRef("medicine_order_submitted_by_fk", t.tenantId, t.submittedBy),
    check("medicine_order_status", sql`status IN (${sqlList(ORDER_STATUS_CODES)})`),
    check(
      "medicine_order_submitted",
      sql`(sent_via IS NULL OR sent_via IN ('manual', 'pharmacy_port'))
        AND (status IN ('draft', 'cancelled') OR (sent_via IS NOT NULL AND submitted_at IS NOT NULL AND submitted_by IS NOT NULL))
        AND (pharmacy_reference IS NULL OR (sent_via = 'pharmacy_port' AND pharmacy_reference ~ '^[A-Za-z0-9-]{1,64}$'))`,
    ),
  ],
);

/** One medicine asked for in an order: fixed once the order is submitted (rule 7). */
export const medicineOrderLine = pgTable(
  "medicine_order_line",
  {
    id: id(),
    tenantId: tenantId(),
    orderId: uuid("order_id").notNull(),
    personId: uuid("person_id").notNull(),
    medicationId: uuid("medication_id").notNull(),
    vmpId: text("vmp_id").notNull(),
    productName: text("product_name").notNull(),
    quantity: quantity("quantity").notNull(),
    unitCode: text("unit_code").notNull(),
    ...mutableColumns(),
  },
  (t) => [
    unique("medicine_order_line_tenant_id_id_key").on(t.tenantId, t.id),
    foreignKey({
      name: "medicine_order_line_order_fk",
      columns: [t.tenantId, t.orderId],
      foreignColumns: [medicineOrder.tenantId, medicineOrder.id],
    }),
    personRef("medicine_order_line_person_fk", t),
    foreignKey({
      name: "medicine_order_line_medication_fk",
      columns: [t.tenantId, t.personId, t.medicationId],
      foreignColumns: [medication.tenantId, medication.personId, medication.id],
    }),
    check("medicine_order_line_quantity", sql`quantity > 0`),
    check("medicine_order_line_vmp", sql`vmp_id ~ '^[0-9]{6,18}$'`),
  ],
);

/** A location's fridge or medicines room (rule 8). */
export const medicineStorage = pgTable(
  "medicine_storage",
  {
    id: id(),
    tenantId: tenantId(),
    locationId: uuid("location_id").notNull(),
    kind: text("kind").notNull(),
    name: text("name").notNull(),
    ...mutableColumns(),
  },
  (t) => [
    unique("medicine_storage_tenant_id_id_key").on(t.tenantId, t.id),
    uniqueIndex("medicine_storage_name_key")
      .on(t.tenantId, t.locationId, sql`lower(name)`)
      .where(sql`deleted_at IS NULL`),
    locationRef("medicine_storage_location_fk", t),
    check("medicine_storage_kind", sql`kind IN (${sqlList(STORAGE_KIND_CODES)})`),
    check("medicine_storage_name", sql`length(btrim(name)) BETWEEN 2 AND 80`),
  ],
);

/** A temperature reading, with the range that applied from the rate table (rule 8). */
export const medicineTemperatureReading = pgTable(
  "medicine_temperature_reading",
  {
    id: id(),
    tenantId: tenantId(),
    storageId: uuid("storage_id").notNull(),
    locationId: uuid("location_id").notNull(),
    /** Tenths of a degree Celsius. */
    readingTenths: integer("reading_tenths").notNull(),
    minTenths: integer("min_tenths"),
    maxTenths: integer("max_tenths"),
    /** Set by the database from the rate table. */
    lowTenths: integer("low_tenths"),
    highTenths: integer("high_tenths").notNull().default(0),
    outOfRange: boolean("out_of_range").notNull().default(false),
    taskId: uuid("task_id"),
    recordedBy: uuid("recorded_by").notNull(),
    recordedAt: timestamp("recorded_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    unique("medicine_temperature_reading_tenant_id_id_key").on(t.tenantId, t.id),
    foreignKey({
      name: "medicine_temperature_reading_storage_fk",
      columns: [t.tenantId, t.storageId],
      foreignColumns: [medicineStorage.tenantId, medicineStorage.id],
    }),
    locationRef("medicine_temperature_reading_location_fk", t),
    memberRef("medicine_temperature_reading_recorded_by_fk", t.tenantId, t.recordedBy),
    index("medicine_temperature_reading_storage_idx").on(t.tenantId, t.storageId, t.recordedAt),
    check(
      "medicine_temperature_reading_values",
      sql`reading_tenths BETWEEN -500 AND 600
        AND (min_tenths IS NULL OR (min_tenths BETWEEN -500 AND 600 AND min_tenths <= reading_tenths))
        AND (max_tenths IS NULL OR (max_tenths BETWEEN -500 AND 600 AND max_tenths >= reading_tenths))`,
    ),
  ],
);
