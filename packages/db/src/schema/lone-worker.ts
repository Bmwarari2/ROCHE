import { sql } from "drizzle-orm";
import {
  type AnyPgColumn,
  boolean,
  check,
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
import { location, tenantUser } from "./platform";
import { incident } from "./safety";

/**
 * Lone-worker safety (SCHED-012, Phase 2 slice 46; scheduling.md section 15; HZ-125). The rules
 * live in packages/domain/src/scheduling/lone-worker.ts; row-level security, the append-only
 * events and the guards are in migration 0113. Lane C owns this file.
 */

/** `LONE_WORKER_EVENT_KINDS` in packages/domain; a test keeps the lists in step. */
export const LONE_WORKER_EVENT_KIND_CODES = ["check_in", "duress", "help", "finish"] as const;
/** `LONE_WORKER_ALARM_REASONS` in packages/domain. */
export const LONE_WORKER_ALARM_REASON_CODES = [
  "overdue",
  "not_finished",
  "duress",
  "help",
] as const;
/** `LONE_WORKER_ALARM_STATES` in packages/domain. */
export const LONE_WORKER_ALARM_STATE_CODES = [
  "open",
  "acknowledged",
  "resolved_by_check_in",
  "resolved_late_check_in",
  "resolved_by_finish",
] as const;
/** `LONE_WORKER_OUTCOMES` in packages/domain. */
export const LONE_WORKER_OUTCOME_CODES = [
  "safe_confirmed",
  "help_sent",
  "emergency_services_called",
  "other",
] as const;
export const LONE_WORKER_WORK_KIND_CODES = ["domiciliary_visit", "night_shift", "other"] as const;

const staffRef = (name: string, t: { tenantId: AnyPgColumn }, column: AnyPgColumn) =>
  foreignKey({
    name,
    columns: [t.tenantId, column],
    foreignColumns: [tenantUser.tenantId, tenantUser.id],
  });

/**
 * A member of staff's lone-working session. The client supplies the id (offline start). No place
 * name or address: where the worker is comes only from the optional location evidence. One open
 * session per worker. Retention `lone_worker`.
 */
export const loneWorkerSession = pgTable(
  "lone_worker_session",
  {
    id: id(),
    tenantId: tenantId(),
    locationId: uuid("location_id").notNull(),
    workerTenantUserId: uuid("worker_tenant_user_id").notNull().default(sql`app.current_user_id()`),
    workKind: text("work_kind").notNull(),
    startedAt: timestamp("started_at", { withTimezone: true }).notNull(),
    plannedEndAt: timestamp("planned_end_at", { withTimezone: true }).notNull(),
    intervalMinutes: integer("interval_minutes").notNull(),
    finishedAt: timestamp("finished_at", { withTimezone: true }),
    reminderSentFor: timestamp("reminder_sent_for", { withTimezone: true }),
    retentionClass: text("retention_class").notNull().default("lone_worker"),
    ...mutableColumns(),
  },
  (t) => [
    unique("lone_worker_session_tenant_id_id_key").on(t.tenantId, t.id),
    foreignKey({
      name: "lone_worker_session_location_fk",
      columns: [t.tenantId, t.locationId],
      foreignColumns: [location.tenantId, location.id],
    }),
    staffRef("lone_worker_session_worker_fk", t, t.workerTenantUserId),
    uniqueIndex("lone_worker_session_open_key")
      .on(t.tenantId, t.workerTenantUserId)
      .where(sql`finished_at IS NULL AND deleted_at IS NULL`),
    index("lone_worker_session_open_idx")
      .on(t.tenantId, t.locationId)
      .where(sql`finished_at IS NULL`),
    check(
      "lone_worker_session_work_kind",
      sql`work_kind IN (${sqlList(LONE_WORKER_WORK_KIND_CODES)})`,
    ),
    check("lone_worker_session_end", sql`planned_end_at > started_at`),
    check("lone_worker_session_interval", sql`interval_minutes > 0`),
    check("lone_worker_session_retention_class", sql`retention_class IN ('lone_worker')`),
  ],
);

/**
 * A check-in, help request, duress check-in or finish: append-only, client UUID, idempotent.
 * `device_at` is what the device said; `received_at` the server's time; `effective_at` the time it
 * counts from (`acceptEvent`); `late` flags one sent from an offline device. Retention `lone_worker`.
 */
export const loneWorkerEvent = pgTable(
  "lone_worker_event",
  {
    id: uuid("id").primaryKey(),
    tenantId: tenantId(),
    sessionId: uuid("session_id").notNull(),
    kind: text("kind").notNull(),
    deviceAt: timestamp("device_at", { withTimezone: true }).notNull(),
    receivedAt: timestamp("received_at", { withTimezone: true }).notNull().defaultNow(),
    effectiveAt: timestamp("effective_at", { withTimezone: true }).notNull(),
    late: boolean("late").notNull(),
    createdBy: uuid("created_by").default(sql`app.current_user_id()`),
  },
  (t) => [
    unique("lone_worker_event_tenant_id_id_key").on(t.tenantId, t.id),
    foreignKey({
      name: "lone_worker_event_session_fk",
      columns: [t.tenantId, t.sessionId],
      foreignColumns: [loneWorkerSession.tenantId, loneWorkerSession.id],
    }),
    index("lone_worker_event_session_idx").on(t.tenantId, t.sessionId, t.effectiveAt),
    check("lone_worker_event_kind", sql`kind IN (${sqlList(LONE_WORKER_EVENT_KIND_CODES)})`),
    check("lone_worker_event_effective", sql`effective_at <= received_at`),
  ],
);

/**
 * An alarm: raised by the sweep for an overdue check-in or an unfinished session, or at once by a
 * help or duress event. Open until a person other than the worker acknowledges it, or (overdue and
 * unfinished only) a check-in resolves it. Retention `lone_worker`.
 */
export const loneWorkerAlarm = pgTable(
  "lone_worker_alarm",
  {
    id: id(),
    tenantId: tenantId(),
    sessionId: uuid("session_id").notNull(),
    locationId: uuid("location_id").notNull(),
    workerTenantUserId: uuid("worker_tenant_user_id").notNull(),
    reason: text("reason").notNull(),
    state: text("state").notNull().default("open"),
    dueAt: timestamp("due_at", { withTimezone: true }),
    raisedAt: timestamp("raised_at", { withTimezone: true }).notNull(),
    triggerEventId: uuid("trigger_event_id"),
    lastAlertedAt: timestamp("last_alerted_at", { withTimezone: true }).notNull(),
    alertCount: integer("alert_count").notNull().default(1),
    /** Route steps told so far (step 1 at once; later ones by their minutes after `raised_at`). */
    escalationStep: integer("escalation_step").notNull().default(1),
    resolvedAt: timestamp("resolved_at", { withTimezone: true }),
    resolvedByEventId: uuid("resolved_by_event_id"),
    acknowledgedBy: uuid("acknowledged_by"),
    acknowledgedAt: timestamp("acknowledged_at", { withTimezone: true }),
    outcome: text("outcome"),
    note: text("note"),
    incidentId: uuid("incident_id"),
    retentionClass: text("retention_class").notNull().default("lone_worker"),
    ...mutableColumns(),
  },
  (t) => [
    unique("lone_worker_alarm_tenant_id_id_key").on(t.tenantId, t.id),
    foreignKey({
      name: "lone_worker_alarm_session_fk",
      columns: [t.tenantId, t.sessionId],
      foreignColumns: [loneWorkerSession.tenantId, loneWorkerSession.id],
    }),
    foreignKey({
      name: "lone_worker_alarm_location_fk",
      columns: [t.tenantId, t.locationId],
      foreignColumns: [location.tenantId, location.id],
    }),
    staffRef("lone_worker_alarm_worker_fk", t, t.workerTenantUserId),
    staffRef("lone_worker_alarm_acknowledged_by_fk", t, t.acknowledgedBy),
    foreignKey({
      name: "lone_worker_alarm_trigger_event_fk",
      columns: [t.tenantId, t.triggerEventId],
      foreignColumns: [loneWorkerEvent.tenantId, loneWorkerEvent.id],
    }),
    foreignKey({
      name: "lone_worker_alarm_resolved_event_fk",
      columns: [t.tenantId, t.resolvedByEventId],
      foreignColumns: [loneWorkerEvent.tenantId, loneWorkerEvent.id],
    }),
    foreignKey({
      name: "lone_worker_alarm_incident_fk",
      columns: [t.tenantId, t.incidentId],
      foreignColumns: [incident.tenantId, incident.id],
    }),
    // One alarm per missed due time, open or not, so acknowledging it never raises it again
    // (clinical review M2); one open help or duress alarm per session and kind, so repeated
    // presses do not flood the route (security review M4); one alarm per help or duress event.
    uniqueIndex("lone_worker_alarm_overdue_due_key")
      .on(t.tenantId, t.sessionId, t.dueAt)
      .where(sql`reason IN ('overdue', 'not_finished')`),
    uniqueIndex("lone_worker_alarm_open_worker_raised_key")
      .on(t.tenantId, t.sessionId, t.reason)
      .where(sql`state = 'open' AND reason IN ('duress', 'help')`),
    uniqueIndex("lone_worker_alarm_trigger_event_key")
      .on(t.tenantId, t.triggerEventId)
      .where(sql`trigger_event_id IS NOT NULL`),
    index("lone_worker_alarm_open_idx").on(t.tenantId, t.state, t.lastAlertedAt),
    check("lone_worker_alarm_reason", sql`reason IN (${sqlList(LONE_WORKER_ALARM_REASON_CODES)})`),
    check("lone_worker_alarm_state", sql`state IN (${sqlList(LONE_WORKER_ALARM_STATE_CODES)})`),
    check(
      "lone_worker_alarm_outcome",
      sql`outcome IS NULL OR outcome IN (${sqlList(LONE_WORKER_OUTCOME_CODES)})`,
    ),
    check(
      "lone_worker_alarm_trigger",
      sql`(reason IN ('duress', 'help')) = (trigger_event_id IS NOT NULL)
        AND (reason IN ('overdue', 'not_finished')) = (due_at IS NOT NULL)`,
    ),
    check(
      "lone_worker_alarm_acknowledged",
      sql`(state = 'acknowledged') = (acknowledged_at IS NOT NULL AND acknowledged_by IS NOT NULL
        AND outcome IS NOT NULL AND note IS NOT NULL AND btrim(note) <> '')`,
    ),
    check(
      "lone_worker_alarm_not_self",
      sql`acknowledged_by IS NULL OR acknowledged_by <> worker_tenant_user_id`,
    ),
    check(
      "lone_worker_alarm_resolved",
      sql`(state IN ('resolved_by_check_in', 'resolved_late_check_in', 'resolved_by_finish'))
        = (resolved_at IS NOT NULL AND resolved_by_event_id IS NOT NULL)`,
    ),
    check(
      "lone_worker_alarm_worker_raised",
      sql`reason NOT IN ('duress', 'help') OR state IN ('open', 'acknowledged')`,
    ),
    check("lone_worker_alarm_escalation_step", sql`escalation_step >= 1`),
    check("lone_worker_alarm_note_length", sql`note IS NULL OR char_length(note) <= 2000`),
    check("lone_worker_alarm_retention_class", sql`retention_class IN ('lone_worker')`),
  ],
);

/**
 * Location evidence: one point captured with one event, only while the organisation's location
 * flag is on (H-527); never a track. The worker sweep erases the point (clears the coordinates)
 * at `delete_after` (`lone_worker.location_days`); the row stays as proof of the erasure, holding
 * nothing (as `evidence_pack_bundle`). Retention `lone_worker_location`.
 */
export const loneWorkerLocation = pgTable(
  "lone_worker_location",
  {
    id: id(),
    tenantId: tenantId(),
    eventId: uuid("event_id").notNull(),
    sessionId: uuid("session_id").notNull(),
    latitude: numeric("latitude", { precision: 8, scale: 5 }),
    longitude: numeric("longitude", { precision: 8, scale: 5 }),
    accuracyMetres: integer("accuracy_metres"),
    deleteAfter: timestamp("delete_after", { withTimezone: true }).notNull(),
    clearedAt: timestamp("cleared_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    unique("lone_worker_location_event_key").on(t.tenantId, t.eventId),
    foreignKey({
      name: "lone_worker_location_event_fk",
      columns: [t.tenantId, t.eventId],
      foreignColumns: [loneWorkerEvent.tenantId, loneWorkerEvent.id],
    }),
    foreignKey({
      name: "lone_worker_location_session_fk",
      columns: [t.tenantId, t.sessionId],
      foreignColumns: [loneWorkerSession.tenantId, loneWorkerSession.id],
    }),
    index("lone_worker_location_expiry_idx").on(t.deleteAfter).where(sql`cleared_at IS NULL`),
    check(
      "lone_worker_location_cleared",
      sql`(cleared_at IS NULL) = (latitude IS NOT NULL AND longitude IS NOT NULL)
        AND (cleared_at IS NULL OR accuracy_metres IS NULL)`,
    ),
    check("lone_worker_location_latitude", sql`latitude BETWEEN -90 AND 90`),
    check("lone_worker_location_longitude", sql`longitude BETWEEN -180 AND 180`),
    check(
      "lone_worker_location_accuracy",
      sql`accuracy_metres IS NULL OR accuracy_metres BETWEEN 0 AND 100000`,
    ),
  ],
);

export type LoneWorkerSessionRow = typeof loneWorkerSession.$inferSelect;
export type LoneWorkerEventRow = typeof loneWorkerEvent.$inferSelect;
export type LoneWorkerAlarmRow = typeof loneWorkerAlarm.$inferSelect;
