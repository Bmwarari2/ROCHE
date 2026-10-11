import { boolean, foreignKey, index, pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";
import { id, mutableColumns, tenantId } from "./_columns";
import { tenant, tenantUser } from "./platform";

/**
 * Thapsus operator console (section 9.1): Thapsus staff who provision tenants and give support.
 * Operators are Better Auth identities listed here; they never hold tenant roles. Support access to
 * a tenant's data needs the tenant's approval, is time-boxed, and every action is audited and
 * visible to the tenant (section 4, Thapsus operator row).
 */

export const operatorUser = pgTable("operator_user", {
  id: id(),
  authUserId: text("auth_user_id").notNull().unique(),
  displayName: text("display_name").notNull(),
  /** `support` (read health, request access) or `admin` (also provision tenants). */
  role: text("role").notNull(),
  active: boolean("active").notNull().default(true),
  ...mutableColumns(),
});

export const supportAccessRequest = pgTable(
  "support_access_request",
  {
    id: id(),
    tenantId: tenantId().references(() => tenant.id),
    operatorUserId: uuid("operator_user_id")
      .notNull()
      .references(() => operatorUser.id),
    /** The support ticket reference and what the operator needs to look at. */
    ticketReference: text("ticket_reference").notNull(),
    reason: text("reason").notNull(),
    requestedAt: timestamp("requested_at", { withTimezone: true }).notNull().defaultNow(),
    decidedAt: timestamp("decided_at", { withTimezone: true }),
    decidedBy: uuid("decided_by"),
    decision: text("decision"),
    /** Access lapses at this time; approval sets it. */
    expiresAt: timestamp("expires_at", { withTimezone: true }),
    ...mutableColumns(),
  },
  (t) => [
    foreignKey({
      name: "support_access_decided_by_fk",
      columns: [t.tenantId, t.decidedBy],
      foreignColumns: [tenantUser.tenantId, tenantUser.id],
    }),
    index("support_access_tenant_idx").on(t.tenantId, t.requestedAt),
  ],
);
