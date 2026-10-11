import { sql } from "drizzle-orm";
import { integer, timestamp, uuid } from "drizzle-orm/pg-core";

/**
 * Column helpers shared by every Harbour table (master prompt section 18).
 *
 * Defaults are evaluated by Postgres, not the application, so rows written by seeds, workers and
 * SQL tooling get the same values as rows written through the API:
 * - `id` is a UUIDv7 from `app.uuid_v7()`; offline clients may supply their own UUIDv7 instead.
 * - `tenant_id` defaults to the transaction's tenant (`app.current_tenant_id()`); row-level
 *   security then checks that any explicit value matches it.
 * - `created_by` / `updated_by` default to the acting tenant user (`app.current_user_id()`).
 */

export const id = () => uuid("id").primaryKey().default(sql`app.uuid_v7()`);

export const tenantId = () => uuid("tenant_id").notNull().default(sql`app.current_tenant_id()`);

/** For global reference tables where a NULL tenant means "applies to every tenant". */
export const optionalTenantId = () => uuid("tenant_id");

export const createdColumns = () => ({
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  createdBy: uuid("created_by").default(sql`app.current_user_id()`),
});

/** Mutable aggregates: optimistic concurrency via `version`, soft delete under retention. */
export const mutableColumns = () => ({
  ...createdColumns(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  updatedBy: uuid("updated_by").default(sql`app.current_user_id()`),
  version: integer("version").notNull().default(1),
  deletedAt: timestamp("deleted_at", { withTimezone: true }),
});

/**
 * Append-only events (care notes, administrations, audit events): no updated_at, no version.
 * `recorded_at` is the server-received time; `device_time` and `device_offset_minutes` keep what
 * the device said, so clock drift can be detected (hazard HZ-010).
 */
export const eventColumns = () => ({
  occurredAt: timestamp("occurred_at", { withTimezone: true }).notNull(),
  recordedAt: timestamp("recorded_at", { withTimezone: true }).notNull().defaultNow(),
  deviceTime: timestamp("device_time", { withTimezone: true }),
  deviceOffsetMinutes: integer("device_offset_minutes"),
  createdBy: uuid("created_by").default(sql`app.current_user_id()`),
});
