import { sql } from "drizzle-orm";
import {
  type AnyPgColumn,
  boolean,
  date,
  foreignKey,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  unique,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { createdColumns, id, mutableColumns, tenantId } from "./_columns";
import { person } from "./people";
import { location, tenantUser } from "./platform";

/**
 * Task and workflow engine (master prompt section 9.1; rules in packages/domain/src/platform/tasks.ts
 * and workflow.ts). Tasks come from care plan actions, chart rules, assessment triggers, statutory
 * clocks and managers; a series holds the recurrence and the worker materialises its tasks ahead
 * of time. Titles are generic ("Reposition", "Fluid round"): the person is a reference, never text.
 */

const personRef = (name: string, t: { tenantId: AnyPgColumn; personId: AnyPgColumn }) =>
  foreignKey({
    name,
    columns: [t.tenantId, t.personId],
    foreignColumns: [person.tenantId, person.id],
  });

const locationRef = (name: string, t: { tenantId: AnyPgColumn; locationId: AnyPgColumn }) =>
  foreignKey({
    name,
    columns: [t.tenantId, t.locationId],
    foreignColumns: [location.tenantId, location.id],
  });

const assigneeRef = (
  name: string,
  t: { tenantId: AnyPgColumn; assigneeTenantUserId: AnyPgColumn },
) =>
  foreignKey({
    name,
    columns: [t.tenantId, t.assigneeTenantUserId],
    foreignColumns: [tenantUser.tenantId, tenantUser.id],
  });

export const taskSeries = pgTable(
  "task_series",
  {
    id: id(),
    tenantId: tenantId(),
    locationId: uuid("location_id"),
    personId: uuid("person_id"),
    /** `module.what`, for example `care.reposition`; the module decides what completes it. */
    kind: text("kind").notNull(),
    title: text("title").notNull(),
    /** Permission needed to complete the tasks (besides being the assignee). */
    requiredPermission: text("required_permission").notNull(),
    sourceType: text("source_type"),
    sourceId: uuid("source_id"),
    assigneeTenantUserId: uuid("assignee_tenant_user_id"),
    assigneeRoleKey: text("assignee_role_key"),
    /** A Recurrence from packages/domain (UK local times). */
    recurrence: jsonb("recurrence").notNull(),
    startsOn: date("starts_on").notNull(),
    endsOn: date("ends_on"),
    /** Minutes before and after the due time in which the task counts as on time. */
    windowBeforeMinutes: integer("window_before_minutes").notNull().default(0),
    windowAfterMinutes: integer("window_after_minutes").notNull().default(0),
    evidenceRequired: boolean("evidence_required").notNull().default(false),
    priority: text("priority").notNull().default("routine"),
    active: boolean("active").notNull().default(true),
    /** Tasks exist up to this instant; the worker extends it. */
    materialisedUntil: timestamp("materialised_until", { withTimezone: true }),
    ...mutableColumns(),
  },
  (t) => [
    unique("task_series_tenant_id_id_key").on(t.tenantId, t.id),
    personRef("task_series_person_fk", t),
    locationRef("task_series_location_fk", t),
    assigneeRef("task_series_assignee_fk", t),
    index("task_series_active_idx").on(t.tenantId, t.active),
  ],
);

export const task = pgTable(
  "task",
  {
    id: id(),
    tenantId: tenantId(),
    seriesId: uuid("series_id"),
    locationId: uuid("location_id"),
    personId: uuid("person_id"),
    kind: text("kind").notNull(),
    title: text("title").notNull(),
    requiredPermission: text("required_permission").notNull(),
    sourceType: text("source_type"),
    sourceId: uuid("source_id"),
    assigneeTenantUserId: uuid("assignee_tenant_user_id"),
    assigneeRoleKey: text("assignee_role_key"),
    dueAt: timestamp("due_at", { withTimezone: true }).notNull(),
    windowStart: timestamp("window_start", { withTimezone: true }),
    windowEnd: timestamp("window_end", { withTimezone: true }),
    priority: text("priority").notNull().default("routine"),
    evidenceRequired: boolean("evidence_required").notNull().default(false),
    status: text("status").notNull().default("open"),
    statusReason: text("status_reason"),
    completedAt: timestamp("completed_at", { withTimezone: true }),
    completedBy: uuid("completed_by"),
    evidenceType: text("evidence_type"),
    evidenceId: uuid("evidence_id"),
    /** 0 none, 1 escalated to the nurse in charge, 2 further up the location's chain. */
    escalationLevel: integer("escalation_level").notNull().default(0),
    escalatedAt: timestamp("escalated_at", { withTimezone: true }),
    ...mutableColumns(),
  },
  (t) => [
    unique("task_tenant_id_id_key").on(t.tenantId, t.id),
    foreignKey({
      name: "task_series_fk",
      columns: [t.tenantId, t.seriesId],
      foreignColumns: [taskSeries.tenantId, taskSeries.id],
    }),
    personRef("task_person_fk", t),
    locationRef("task_location_fk", t),
    assigneeRef("task_assignee_fk", t),
    // The worker can materialise a series twice without creating duplicates.
    uniqueIndex("task_series_due_key")
      .on(t.tenantId, t.seriesId, t.dueAt)
      .where(sql`series_id IS NOT NULL`),
    index("task_due_idx").on(t.tenantId, t.status, t.dueAt),
    index("task_person_idx").on(t.tenantId, t.personId, t.dueAt),
    index("task_assignee_idx").on(t.tenantId, t.assigneeTenantUserId, t.status),
  ],
);

export const workflowInstance = pgTable(
  "workflow_instance",
  {
    id: id(),
    tenantId: tenantId(),
    definitionKey: text("definition_key").notNull(),
    definitionVersion: integer("definition_version").notNull(),
    subjectType: text("subject_type").notNull(),
    subjectId: uuid("subject_id").notNull(),
    /** Set when the subject concerns a person, so the instance follows the person's scope. */
    personId: uuid("person_id"),
    state: text("state").notNull(),
    enteredStateAt: timestamp("entered_state_at", { withTimezone: true }).notNull().defaultNow(),
    slaDueAt: timestamp("sla_due_at", { withTimezone: true }),
    ...mutableColumns(),
  },
  (t) => [
    unique("workflow_instance_tenant_id_id_key").on(t.tenantId, t.id),
    unique("workflow_instance_subject_key").on(
      t.tenantId,
      t.subjectType,
      t.subjectId,
      t.definitionKey,
    ),
    personRef("workflow_instance_person_fk", t),
    index("workflow_instance_sla_idx").on(t.tenantId, t.slaDueAt),
  ],
);

/** Append-only history of every move, with who made it and why. */
export const workflowTransition = pgTable(
  "workflow_transition",
  {
    id: id(),
    tenantId: tenantId(),
    instanceId: uuid("instance_id").notNull(),
    personId: uuid("person_id"),
    fromState: text("from_state").notNull(),
    toState: text("to_state").notNull(),
    reason: text("reason"),
    stepUp: boolean("step_up").notNull().default(false),
    occurredAt: timestamp("occurred_at", { withTimezone: true }).notNull().defaultNow(),
    ...createdColumns(),
  },
  (t) => [
    foreignKey({
      name: "workflow_transition_instance_fk",
      columns: [t.tenantId, t.instanceId],
      foreignColumns: [workflowInstance.tenantId, workflowInstance.id],
    }),
    personRef("workflow_transition_person_fk", t),
    index("workflow_transition_instance_idx").on(t.tenantId, t.instanceId, t.occurredAt),
  ],
);
