import { sql } from "drizzle-orm";
import { check, foreignKey, index, pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";
import { createdColumns, id, tenantId } from "./_columns";
import { tenant, tenantUser } from "./platform";

/**
 * Onboarding decisions (PLAT-018; platform-completions.md rules 26 and 27): where a person must
 * decide, the decision is an append-only record of who decided what and when. A later change by
 * Harbour (a new default, a changed retention class, a new safety case) reopens it; the newest
 * record counts. `audit_event` retention class (accountability evidence).
 */

/** A tenant-default setting accepted as Harbour set it, or set to the organisation's own value. */
export const tenantSettingDecision = pgTable(
  "tenant_setting_decision",
  {
    id: id(),
    tenantId: tenantId().references(() => tenant.id),
    rateKey: text("rate_key").notNull(),
    kind: text("kind").notNull(),
    decidedBy: uuid("decided_by").notNull().default(sql`app.current_user_id()`),
    decidedAt: timestamp("decided_at", { withTimezone: true }).notNull().defaultNow(),
    ...createdColumns(),
  },
  (t) => [
    index("tenant_setting_decision_key_idx").on(t.tenantId, t.rateKey, t.decidedAt),
    foreignKey({
      name: "tenant_setting_decision_by_fk",
      columns: [t.tenantId, t.decidedBy],
      foreignColumns: [tenantUser.tenantId, tenantUser.id],
    }),
    check("tenant_setting_decision_kind", sql`kind IN ('accepted', 'set')`),
  ],
);

/** A retention class accepted, lengthened, given a period, or marked not used. */
export const retentionDecision = pgTable(
  "retention_decision",
  {
    id: id(),
    tenantId: tenantId().references(() => tenant.id),
    recordClass: text("record_class").notNull(),
    /** `RetentionDecisionKind` in packages/domain. */
    kind: text("kind").notNull(),
    decidedBy: uuid("decided_by").notNull().default(sql`app.current_user_id()`),
    decidedAt: timestamp("decided_at", { withTimezone: true }).notNull().defaultNow(),
    ...createdColumns(),
  },
  (t) => [
    index("retention_decision_class_idx").on(t.tenantId, t.recordClass, t.decidedAt),
    foreignKey({
      name: "retention_decision_by_fk",
      columns: [t.tenantId, t.decidedBy],
      foreignColumns: [tenantUser.tenantId, tenantUser.id],
    }),
    check(
      "retention_decision_kind",
      sql`kind IN ('accepted', 'lengthened', 'period_set', 'not_used')`,
    ),
  ],
);

/** The organisation's DCB0160 assessment of the safety case for the release it runs. */
export const dcb0160Record = pgTable(
  "dcb0160_record",
  {
    id: id(),
    tenantId: tenantId().references(() => tenant.id),
    safetyCaseVersion: text("safety_case_version").notNull(),
    recordedBy: uuid("recorded_by").notNull().default(sql`app.current_user_id()`),
    recordedAt: timestamp("recorded_at", { withTimezone: true }).notNull().defaultNow(),
    ...createdColumns(),
  },
  (t) => [
    index("dcb0160_record_recorded_idx").on(t.tenantId, t.recordedAt),
    foreignKey({
      name: "dcb0160_record_by_fk",
      columns: [t.tenantId, t.recordedBy],
      foreignColumns: [tenantUser.tenantId, tenantUser.id],
    }),
    check("dcb0160_record_version", sql`char_length(btrim(safety_case_version)) BETWEEN 1 AND 40`),
  ],
);
