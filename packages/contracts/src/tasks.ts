import { z } from "zod";

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
    completedAt: isoDateTime.nullable(),
    escalated: z.boolean(),
    details: TaskDetails.nullable(),
    version: z.number().int(),
  })
  .meta({ id: "TaskItem" });
export type TaskItem = z.infer<typeof TaskItem>;

export const TaskList = z.object({ items: z.array(TaskItem) }).meta({ id: "TaskList" });
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
