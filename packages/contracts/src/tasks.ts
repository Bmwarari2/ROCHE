import { z } from "zod";
import { StaffName } from "./staff";

/** Task engine contracts (section 9.1). Titles are generic; the person is a reference. */

const uuid = z.uuid();
const isoDateTime = z.iso.datetime({ offset: true });
const isoDate = z.iso.date();
const hhmm = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, "Use 24-hour time, HH:MM");

export const TaskStatus = z
  .enum(["open", "in_progress", "done", "skipped", "cancelled"])
  .meta({ id: "TaskStatus" });
export type TaskStatus = z.infer<typeof TaskStatus>;

export const TaskTimeState = z.enum(["closed", "upcoming", "due", "overdue", "escalated"]).meta({
  id: "TaskTimeState",
  description: "Where the task stands now, from its window and status",
});
export type TaskTimeState = z.infer<typeof TaskTimeState>;

export const TaskPriority = z.enum(["routine", "urgent"]).meta({ id: "TaskPriority" });

/**
 * What a review task is about, as opaque references only (never clinical text): the entries it
 * concerns (a late entry refused after an exit, or an entry that did not complete the task it
 * named) and the rounds missed before a return or a correction was recorded.
 */
export const TaskDetails = z
  .object({
    entries: z
      .array(
        z.object({
          /** The kind of entry: care_note, observation, incident and so on. */
          kind: z.string(),
          /** The device-generated id it was sent with (a refused entry has no server copy). */
          clientId: uuid.nullable().optional(),
          /** The stored entry, when it was kept. */
          entryId: uuid.nullable().optional(),
          occurredAt: isoDateTime.nullable().optional(),
          taskId: uuid.nullable().optional(),
          taskKind: z.string().nullable().optional(),
          outcome: z.string().nullable().optional(),
          deviceId: z.string().nullable().optional(),
          recordedBy: uuid.nullable().optional(),
          at: isoDateTime.nullable().optional(),
          /** A refused entry's server copy (refused_entry.id) and the API's refusal code. */
          refusedEntryId: uuid.nullable().optional(),
          refusalCode: z.string().nullable().optional(),
        }),
      )
      .optional(),
    missedTasks: z
      .array(
        z.object({
          taskId: uuid,
          kind: z.string(),
          dueAt: isoDateTime,
          /** Reopened, overdue, to be caught up (the latest of its series); otherwise missed. */
          reopened: z.boolean(),
        }),
      )
      .optional(),
    /** Entries beyond the 50 listed. */
    entriesOmitted: z.number().int().optional(),
    /**
     * A flagged-entry task (entries uploaded after their device reported deleting them, or listed
     * by a deletion after they reached Harbour): whose entries they are, and how many in all
     * (care.md section 6, Device integrity part 4).
     */
    ownerTenantUserId: uuid.optional(),
    entryCount: z.number().int().min(0).optional(),
    /** Missed rounds beyond the 50 listed (never a medicines round: those are all listed). */
    missedTasksOmitted: z.number().int().optional(),
    /**
     * A late return or correction lists rounds from 00:00 UK time on this date: rounds due before
     * it are not all listed, so the reviewer checks the record (HZ-003).
     */
    missedTasksNotListedBefore: isoDate.optional(),
    /**
     * A staff check's expiry reminder (workforce.md section 5): the staff file and item kind, the
     * date counted down to and the reminder's offset in days. Never the member's name.
     */
    staffProfileId: uuid.optional(),
    complianceItemKind: z.string().optional(),
    reminderDueOn: isoDate.optional(),
    reminderDays: z.number().int().optional(),
    /** A policy read-and-sign or review task (quality.md section 18): the policy, the review state. */
    policyId: uuid.optional(),
    reviewStatus: z.string().optional(),
    remindedOn: isoDate.optional(),
  })
  .meta({ id: "TaskDetails" });
export type TaskDetails = z.infer<typeof TaskDetails>;

export const TaskItem = z
  .object({
    id: uuid,
    seriesId: uuid.nullable(),
    kind: z.string(),
    title: z.string(),
    personId: uuid.nullable(),
    locationId: uuid.nullable(),
    assigneeTenantUserId: uuid.nullable(),
    /** The assignee by name and job title; null when the task is for a role, not a person. */
    assigneeStaff: StaffName.nullable(),
    dueAt: isoDateTime,
    windowStart: isoDateTime.nullable(),
    windowEnd: isoDateTime.nullable(),
    priority: TaskPriority,
    status: TaskStatus,
    statusReason: z.string().nullable(),
    timeState: TaskTimeState,
    evidenceRequired: z.boolean(),
    evidenceType: z.string().nullable(),
    evidenceId: uuid.nullable(),
    /**
     * True when the evidence arrived after the task had been cancelled (an entry recorded offline
     * before the person went to hospital): show it as a flag, an icon and words (HZ-006).
     */
    evidenceAfterClose: z.boolean(),
    /**
     * Brought back after a late return or correction to catch up a missed round once, with a fresh
     * window (people.md rule 2): show it as a flag, an icon and words.
     */
    catchUp: z.boolean(),
    /**
     * Done because an entry answered it while the lifecycle had stopped it (an offline entry
     * uploaded after a move or an exit recorded in error), so it is not due again.
     */
    restoredDone: z.boolean(),
    completedAt: isoDateTime.nullable(),
    /** Who completed it (tenant_user id); null while open or when the system closed it. */
    completedBy: uuid.nullable(),
    /** Who completed it, by name and job title. */
    completedByStaff: StaffName.nullable(),
    escalated: z.boolean(),
    details: TaskDetails.nullable(),
    version: z.number().int(),
  })
  .meta({ id: "TaskItem" });
export type TaskItem = z.infer<typeof TaskItem>;

export const TaskList = z
  .object({
    items: z.array(TaskItem),
    /** True when the window itself held more tasks than the list returns: say so on screen. */
    truncated: z.boolean().optional(),
    /**
     * With `earlier=yes`: open tasks due before the window that did not fit after the window's own
     * tasks (the most recent earlier ones are listed first). Say how many on screen.
     */
    earlierOmitted: z.number().int().min(0).optional(),
  })
  .meta({ id: "TaskList" });
export type TaskList = z.infer<typeof TaskList>;

export const CreateTask = z
  .object({
    title: z.string().trim().min(3).max(120),
    personId: uuid.optional(),
    locationId: uuid.optional(),
    assigneeTenantUserId: uuid.optional(),
    dueAt: isoDateTime,
    windowStart: isoDateTime.optional(),
    windowEnd: isoDateTime.optional(),
    priority: TaskPriority.default("routine"),
  })
  .meta({ id: "CreateTask" });
export type CreateTask = z.infer<typeof CreateTask>;

export const TaskTransitionRequest = z
  .object({
    to: TaskStatus,
    reason: z.string().trim().max(500).optional(),
    evidenceType: z
      .string()
      .regex(/^[a-z_]+$/)
      .max(60)
      .optional(),
    evidenceId: uuid.optional(),
    /** The version the person saw, so two devices cannot silently overwrite each other. */
    version: z.number().int().min(1),
  })
  .meta({ id: "TaskTransitionRequest" });
export type TaskTransitionRequest = z.infer<typeof TaskTransitionRequest>;

export const TaskAssignRequest = z
  .object({ assigneeTenantUserId: uuid.nullable(), version: z.number().int().min(1) })
  .meta({ id: "TaskAssignRequest" });
export type TaskAssignRequest = z.infer<typeof TaskAssignRequest>;

const weekday = z.enum(["mon", "tue", "wed", "thu", "fri", "sat", "sun"]);

export const Recurrence = z
  .discriminatedUnion("freq", [
    z.object({
      freq: z.literal("daily"),
      interval: z.number().int().min(1).max(365).optional(),
      times: z.array(hhmm).min(1).max(24),
    }),
    z.object({
      freq: z.literal("weekly"),
      interval: z.number().int().min(1).max(52).optional(),
      weekdays: z.array(weekday).min(1).max(7),
      times: z.array(hhmm).min(1).max(24),
    }),
    z.object({
      freq: z.literal("monthly"),
      interval: z.number().int().min(1).max(24).optional(),
      dayOfMonth: z.number().int().min(1).max(31),
      times: z.array(hhmm).min(1).max(24),
    }),
    z.object({
      freq: z.literal("every_hours"),
      hours: z.number().int().min(1).max(24),
      anchorTime: hhmm,
    }),
  ])
  .meta({ id: "Recurrence", description: "UK local times; every_hours counts elapsed hours" });
export type Recurrence = z.infer<typeof Recurrence>;

export const CreateTaskSeries = z
  .object({
    title: z.string().trim().min(3).max(120),
    personId: uuid.optional(),
    locationId: uuid.optional(),
    assigneeTenantUserId: uuid.optional(),
    recurrence: Recurrence,
    startsOn: isoDate,
    endsOn: isoDate.optional(),
    windowBeforeMinutes: z.number().int().min(0).max(720).default(0),
    windowAfterMinutes: z.number().int().min(0).max(720).default(0),
    priority: TaskPriority.default("routine"),
    evidenceRequired: z.boolean().default(false),
  })
  .meta({ id: "CreateTaskSeries" });
export type CreateTaskSeries = z.infer<typeof CreateTaskSeries>;

export const TaskSeriesItem = z
  .object({
    id: uuid,
    kind: z.string(),
    title: z.string(),
    personId: uuid.nullable(),
    locationId: uuid.nullable(),
    recurrence: Recurrence,
    startsOn: isoDate,
    endsOn: isoDate.nullable(),
    active: z.boolean(),
    version: z.number().int(),
  })
  .meta({ id: "TaskSeriesItem" });
export type TaskSeriesItem = z.infer<typeof TaskSeriesItem>;

export const EndTaskSeries = z
  .object({ reason: z.string().trim().min(3).max(500), version: z.number().int().min(1) })
  .meta({ id: "EndTaskSeries" });
export type EndTaskSeries = z.infer<typeof EndTaskSeries>;

// ------------------------------------------------------------------------------------------------
// Workflow instances and approvals (PLAT-011)
// ------------------------------------------------------------------------------------------------

export const WorkflowSlaState = z
  .enum(["none", "on_track", "due_today", "overdue", "on_record"])
  .meta({
    id: "WorkflowSlaState",
    description:
      "The current state's deadline: overdue once it has come, due today when later on the same UK day, on track when on a later day, none when the state has no deadline; on_record when the deadline is kept on the record and the list does not have it (open the record to check, never read as no deadline)",
  });
export type WorkflowSlaState = z.infer<typeof WorkflowSlaState>;

export const WorkflowMoveOption = z
  .object({
    to: z.string(),
    /** A step the record's creator may not take (separation of duties). */
    approval: z.boolean(),
    requiresReason: z.boolean(),
    requiresStepUp: z.boolean(),
  })
  .meta({ id: "WorkflowMoveOption" });
export type WorkflowMoveOption = z.infer<typeof WorkflowMoveOption>;

export const WorkflowInstanceItem = z
  .object({
    id: uuid,
    definitionKey: z.string(),
    subjectType: z.string(),
    subjectId: uuid,
    personId: uuid.nullable(),
    /** The incident a candour record belongs to, for its link. */
    incidentId: uuid.nullable(),
    /** The home an outage is at, for its link. */
    locationId: uuid.nullable(),
    state: z.string(),
    /** When the workflow started (the record was raised). */
    startedAt: isoDateTime,
    enteredStateAt: isoDateTime,
    slaDueAt: isoDateTime.nullable(),
    slaState: WorkflowSlaState,
    /** Who started the workflow (raised the record); null when a job started it. */
    createdBy: StaffName.nullable(),
    /**
     * The workflow's permissions the reader holds where this record is: each one's own scope sees
     * the record (ADR-0071), and managing an incident needs it seen whole. The steps follow these.
     */
    permissions: z.array(z.string()),
    /**
     * For an incident whose closing the reader manages: its version (for the forms) and whether a
     * notification still a draft or ready, or an open question, holds closing back (HZ-013; the
     * close route checks again). Null otherwise.
     */
    incident: z
      .object({ version: z.number().int(), status: z.string(), closeBlocked: z.boolean() })
      .nullable(),
    /** The steps open to the reader now. Each is taken on the record's own page or route. */
    moves: z.array(WorkflowMoveOption),
    awaitingYourApproval: z.boolean(),
    /** The reader could approve but raised the record, so someone else must. */
    raisedByYou: z.boolean(),
  })
  .meta({ id: "WorkflowInstanceItem" });
export type WorkflowInstanceItem = z.infer<typeof WorkflowInstanceItem>;

export const WorkflowInstanceList = z
  .object({
    items: z.array(WorkflowInstanceItem),
    /** True when more open workflows were in scope than the list holds. */
    truncated: z.boolean(),
  })
  .meta({ id: "WorkflowInstanceList" });
export type WorkflowInstanceList = z.infer<typeof WorkflowInstanceList>;

export const WorkflowListView = z.enum(["approvals", "all"]).meta({
  id: "WorkflowListView",
  description:
    "approvals: records waiting for the reader's approval, and ones the reader raised that wait for someone else's; all: every open workflow the reader has a part in",
});
export type WorkflowListView = z.infer<typeof WorkflowListView>;
