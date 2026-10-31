import { sql } from "drizzle-orm";
import {
  type AnyPgColumn,
  boolean,
  check,
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

/**
 * Why the people lifecycle stopped a task or a series, as a code to match on (the wording in
 * `status_reason` is for people): rounds paused while the person is away, tasks and series ended
 * at a discharge or death, the exit task of an exit recorded in error or a planned exit
 * cancelled, and rounds whose window passed before a late-recorded return or correction (kept
 * cancelled and reviewed). A correction or return reopens exactly what was stopped with its code
 * (people.md rule 2).
 */
export const TASK_STOP_CODES = [
  "paused_while_away",
  "ended_at_exit",
  "exit_recorded_in_error",
  "planned_exit_cancelled",
  "missed_before_return_recorded",
] as const;
export type TaskStopCode = (typeof TASK_STOP_CODES)[number];
/** How a return or correction brought a stopped task back (people.md rule 2). */
export const TASK_RESTORE_CODES = ["caught_up", "answered_while_stopped"] as const;
export type TaskRestoreCode = (typeof TASK_RESTORE_CODES)[number];
const TASK_STOP_CODES_SQL = sql.raw(TASK_STOP_CODES.map((c) => `'${c}'`).join(", "));

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
    /** Why the series is inactive when the people lifecycle stopped it (`TASK_STOP_CODES`). */
    inactiveCode: text("inactive_code"),
    /**
     * The exit record whose discharge or death stopped the series (`ended_at_exit`), so correcting
     * that exit restarts exactly what it stopped. An opaque reference: no foreign key across modules.
     */
    stoppedByExitId: uuid("stopped_by_exit_id"),
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
    // One live series per care plan action (care.md rule 14): active, or stopped by the people
    // lifecycle and waiting for the person's return or a correction. A series the plan ended is
    // not live.
    uniqueIndex("task_series_care_plan_action_key")
      .on(t.tenantId, t.sourceId)
      .where(
        sql`source_type = 'care_plan_action' AND deleted_at IS NULL AND (active OR inactive_code IS NOT NULL)`,
      ),
    check(
      "task_series_inactive_code",
      sql`inactive_code IS NULL OR (NOT active AND inactive_code IN (${TASK_STOP_CODES_SQL}))`,
    ),
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
    /** Why the people lifecycle cancelled the task (`TASK_STOP_CODES`), to reopen it exactly. */
    cancelCode: text("cancel_code"),
    /**
     * How a return or correction brought the task back (`TASK_RESTORE_CODES`): caught up once with a
     * fresh window, or done because an entry answered it while it was stopped (people.md rule 2).
     */
    restoreCode: text("restore_code"),
    /**
     * True for a round of a care plan series that its plan no longer drives (the plan is not active,
     * or the series has ended): the round view's "From an earlier plan: check the current plan"
     * (`planRoundNotice`; HZ-024). Kept by the database (migration 0071's triggers, from the series
     * and its plan), never written by the API, so the phone can say it offline.
     */
    fromEarlierPlan: boolean("from_earlier_plan").notNull().default(false),
    /** The exit record that ended the task (`ended_at_exit`); see `task_series.stopped_by_exit_id`. */
    stoppedByExitId: uuid("stopped_by_exit_id"),
    completedAt: timestamp("completed_at", { withTimezone: true }),
    completedBy: uuid("completed_by"),
    evidenceType: text("evidence_type"),
    evidenceId: uuid("evidence_id"),
    /**
     * True when the evidence arrived after the task had been cancelled (an entry recorded offline
     * before the person went to hospital, for example): linked, flagged, and the task stays
     * cancelled (HZ-006).
     */
    evidenceAfterClose: boolean("evidence_after_close").notNull().default(false),
    /**
     * What a review task is about, as opaque references only (never clinical text): the entries,
     * devices and users of a late entry, or the rounds missed before a return (`TaskDetails` in
     * packages/contracts).
     */
    details: jsonb("details"),
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
    // One open task per kind, source, location and assignee for the tasks Care mode sync raises
    // (device holds, flagged entries) and the refused-entry review, so racing requests never raise
    // two whatever the advisory locks do (care.md section 6, Device integrity part 4; HZ-008).
    uniqueIndex("task_sync_open_source_key")
      .on(
        t.tenantId,
        t.kind,
        t.sourceType,
        t.sourceId,
        sql`coalesce(location_id, '00000000-0000-0000-0000-000000000000'::uuid)`,
        sql`coalesce(assignee_tenant_user_id, '00000000-0000-0000-0000-000000000000'::uuid)`,
      )
      .where(
        sql`status IN ('open', 'in_progress') AND deleted_at IS NULL AND kind IN ('sync.device_hold', 'sync.entry_reported_deleted', 'sync.entry_deleted_after_upload', 'care.refused_entry_review')`,
      ),
    index("task_due_idx").on(t.tenantId, t.status, t.dueAt),
    index("task_person_idx").on(t.tenantId, t.personId, t.dueAt),
    index("task_assignee_idx").on(t.tenantId, t.assigneeTenantUserId, t.status),
    check(
      "task_cancel_code",
      sql`cancel_code IS NULL OR (status = 'cancelled' AND cancel_code IN (${TASK_STOP_CODES_SQL}))`,
    ),
    check(
      "task_restore_code",
      sql`restore_code IS NULL OR restore_code IN ('caught_up', 'answered_while_stopped')`,
    ),
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
