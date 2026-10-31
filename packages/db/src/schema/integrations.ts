import { sql } from "drizzle-orm";
import {
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
import { createdColumns, id, mutableColumns, tenantId } from "./_columns";
import { notification, tenant } from "./platform";

/**
 * Integrations (`integrations` bounded context, master prompt section 15.3). Every integration is an
 * adapter behind a domain port, with a mock, so tenants without the partner still get a working
 * product. Credentials never live here: `secret_ref` names a Secrets Manager entry.
 */

export const integrationConnection = pgTable(
  "integration_connection",
  {
    id: id(),
    tenantId: tenantId().references(() => tenant.id),
    /** The port, e.g. `comms.email`, `comms.sms`, `comms.push`, `nhs.pds`, `finance.payroll`. */
    port: text("port").notNull(),
    /** The adapter, e.g. `mock`, `smtp`, `expo`, `xero`. */
    provider: text("provider").notNull(),
    status: text("status").notNull().default("configured"),
    /** Non-secret settings only (endpoints, sender ids, feature switches). */
    settings: jsonb("settings").notNull().default(sql`'{}'::jsonb`),
    secretRef: text("secret_ref"),
    lastHealthAt: timestamp("last_health_at", { withTimezone: true }),
    lastHealthOk: text("last_health_ok"),
    lastError: text("last_error"),
    ...mutableColumns(),
  },
  (t) => [
    unique("integration_connection_tenant_id_id_key").on(t.tenantId, t.id),
    unique("integration_connection_port_key").on(t.tenantId, t.port),
  ],
);

/**
 * Inbound data from partners is validated against Zod schemas; anything that fails is quarantined
 * here with the problems found, visible in a queue, never silently dropped (section 15.3 rules).
 */
export const integrationInbound = pgTable(
  "integration_inbound",
  {
    id: id(),
    tenantId: tenantId().references(() => tenant.id),
    port: text("port").notNull(),
    provider: text("provider").notNull(),
    externalId: text("external_id"),
    status: text("status").notNull(),
    payload: jsonb("payload").notNull(),
    problems: jsonb("problems").notNull().default(sql`'[]'::jsonb`),
    receivedAt: timestamp("received_at", { withTimezone: true }).notNull().defaultNow(),
    resolvedAt: timestamp("resolved_at", { withTimezone: true }),
    resolvedBy: uuid("resolved_by"),
    resolution: text("resolution"),
    ...mutableColumns(),
  },
  (t) => [
    unique("integration_inbound_external_key").on(t.tenantId, t.port, t.externalId),
    index("integration_inbound_queue_idx")
      .on(t.tenantId, t.status, t.receivedAt)
      .where(sql`status = 'quarantined'`),
  ],
);

/** One row per notification per channel: what was sent where, and how it went. */
export const notificationDelivery = pgTable(
  "notification_delivery",
  {
    id: id(),
    tenantId: tenantId(),
    notificationId: uuid("notification_id").notNull(),
    channel: text("channel").notNull(),
    provider: text("provider").notNull(),
    status: text("status").notNull().default("pending"),
    attempts: integer("attempts").notNull().default(0),
    providerMessageId: text("provider_message_id"),
    lastError: text("last_error"),
    nextAttemptAt: timestamp("next_attempt_at", { withTimezone: true }),
    sentAt: timestamp("sent_at", { withTimezone: true }),
    ...createdColumns(),
  },
  (t) => [
    foreignKey({
      name: "notification_delivery_notification_fk",
      columns: [t.notificationId],
      foreignColumns: [notification.id],
    }),
    unique("notification_delivery_channel_key").on(t.notificationId, t.channel),
    index("notification_delivery_pending_idx").on(t.createdAt).where(sql`status = 'pending'`),
  ],
);
