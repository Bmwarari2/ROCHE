import { sql } from "drizzle-orm";
import {
  check,
  foreignKey,
  index,
  jsonb,
  pgTable,
  text,
  timestamp,
  unique,
  uuid,
} from "drizzle-orm/pg-core";
import { id, tenantId } from "./_columns";
import { tenant, tenantUser } from "./platform";

/**
 * Sub-processor change notices and each organisation's responses (UK GDPR Art 28(2) and (4); DPA
 * template clause 6; platform-completions.md rules 23 to 25). A notice is Thapsus's, the same for
 * every organisation, and never changes once announced. A response is the organisation's
 * append-only record: its data protection lead acknowledging a sub-processor it uses (a notice, or
 * the register at onboarding) or objecting to a notice within the window, and Thapsus recording
 * how an objection was resolved. `audit_event` retention class (accountability evidence; H-115).
 */

export const subProcessorNotice = pgTable(
  "sub_processor_notice",
  {
    id: id(),
    /** The catalogue key (`SUB_PROCESSORS`), which may arrive with a later release. */
    subProcessorKey: text("sub_processor_key").notNull(),
    kind: text("kind").notNull(),
    /** `SubProcessorUse`: which organisations it affects. */
    use: jsonb("use").notNull(),
    announcedAt: timestamp("announced_at", { withTimezone: true }).notNull(),
    effectiveFrom: timestamp("effective_from", { withTimezone: true }).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("sub_processor_notice_key_idx").on(t.subProcessorKey, t.announcedAt),
    check("sub_processor_notice_kind", sql`kind IN ('new', 'replacement')`),
    check("sub_processor_notice_dates", sql`effective_from >= announced_at`),
    check(
      "sub_processor_notice_use",
      sql`use ->> 'kind' IN ('always', 'capability', 'ai_provider')`,
    ),
  ],
);

export const subProcessorResponse = pgTable(
  "sub_processor_response",
  {
    id: id(),
    tenantId: tenantId().references(() => tenant.id),
    subProcessorKey: text("sub_processor_key").notNull(),
    /** The notice answered; null for acknowledging the register at onboarding. */
    noticeId: uuid("notice_id").references(() => subProcessorNotice.id),
    kind: text("kind").notNull(),
    /** Why the organisation objects (an objection only). */
    grounds: text("grounds"),
    /** `OBJECTION_RESOLUTIONS` (a resolution only). */
    resolution: text("resolution"),
    /** The data protection lead; null when Thapsus records a resolution. */
    respondedBy: uuid("responded_by").default(sql`app.current_user_id()`),
    respondedAt: timestamp("responded_at", { withTimezone: true }).notNull().defaultNow(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    unique("sub_processor_response_tenant_id_id_key").on(t.tenantId, t.id),
    index("sub_processor_response_key_idx").on(t.tenantId, t.subProcessorKey, t.respondedAt),
    foreignKey({
      name: "sub_processor_response_by_fk",
      columns: [t.tenantId, t.respondedBy],
      foreignColumns: [tenantUser.tenantId, tenantUser.id],
    }),
    check(
      "sub_processor_response_kind",
      sql`CASE kind
        WHEN 'acknowledged' THEN grounds IS NULL AND resolution IS NULL AND responded_by IS NOT NULL
        WHEN 'objected' THEN notice_id IS NOT NULL AND char_length(btrim(grounds)) BETWEEN 20 AND 4000
          AND resolution IS NULL AND responded_by IS NOT NULL
        WHEN 'objection_resolved' THEN notice_id IS NOT NULL AND grounds IS NULL
          AND resolution IN ('objection_withdrawn', 'not_used_for_tenant', 'services_ended')
        ELSE false END`,
    ),
  ],
);
