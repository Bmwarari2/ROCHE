import { sql } from "drizzle-orm";
import {
  foreignKey,
  integer,
  pgTable,
  timestamp,
  unique,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { createdColumns, id, tenantId } from "./_columns";
import { tenant, tenantUser } from "./platform";

/**
 * A sample data batch (platform-completions.md rules 29 to 32; HZ-072): loaded by the owner before
 * any real person exists, and removed in one step by `app.remove_sample_batch`, which records when
 * and by whom here (the batch row stays as proof of the removal). Its people carry `is_sample` and
 * `sample_batch_id`.
 */
export const sampleBatch = pgTable(
  "sample_batch",
  {
    id: id(),
    tenantId: tenantId().references(() => tenant.id),
    loadedBy: uuid("loaded_by").notNull().default(sql`app.current_user_id()`),
    loadedAt: timestamp("loaded_at", { withTimezone: true }).notNull().defaultNow(),
    people: integer("people").notNull(),
    removedBy: uuid("removed_by"),
    removedAt: timestamp("removed_at", { withTimezone: true }),
    ...createdColumns(),
  },
  (t) => [
    unique("sample_batch_tenant_id_id_key").on(t.tenantId, t.id),
    // One batch at a time: loading again while one is in place is refused (already_loaded).
    uniqueIndex("sample_batch_one_open_key").on(t.tenantId).where(sql`removed_at IS NULL`),
    foreignKey({
      name: "sample_batch_loaded_by_fk",
      columns: [t.tenantId, t.loadedBy],
      foreignColumns: [tenantUser.tenantId, tenantUser.id],
    }),
    foreignKey({
      name: "sample_batch_removed_by_fk",
      columns: [t.tenantId, t.removedBy],
      foreignColumns: [tenantUser.tenantId, tenantUser.id],
    }),
  ],
);
