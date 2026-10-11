import {
  CreateTask,
  CreateTaskSeries,
  EndTaskSeries,
  TaskAssignRequest,
  TaskItem,
  TaskList,
  TaskSeriesItem,
  TaskTransitionRequest,
} from "@harbour/contracts";
import { type Transaction, task, taskSeries } from "@harbour/db";
import {
  can,
  checkTaskTransition,
  isPermission,
  RecurrenceError,
  type TaskStatus,
  TERMINAL_TASK_STATUSES,
  validateRecurrence,
} from "@harbour/domain";
import { createRoute, z } from "@hono/zod-openapi";
import { and, asc, eq, gte, inArray, isNull, lt } from "drizzle-orm";
import type { Context } from "hono";
import { auditInTx } from "../http/audit";
import { type AppEnv, requirePermission, type TenantAccess, withTenant } from "../http/context";
import { problems } from "../http/problem";
import { publish } from "../outbox";
import { escalationMinutes, materialiseSeries, toTaskItem } from "../services/tasks";
import {
  conflictResponse,
  createRouter,
  errorResponses,
  jsonBody,
  notFoundResponse,
  security,
} from "./openapi";

/**
 * Tasks (section 9.1). Anyone in the tenant sees the tasks row-level security lets them see; tasks
 * about people need MFA like any care record. A task can be completed by its assignee or by anyone
 * holding the permission the task names; managers create, assign and schedule tasks.
 */

const PERSON_TASK_PERMISSION = "care.note.write";
const GENERAL_TASK_PERMISSION = "platform.task.manage";
const DAY_MS = 86_400_000;

/** The assignee, or anyone holding the permission the task names (no step-up: completing is not submitting). */
function canComplete(access: TenantAccess, row: typeof task.$inferSelect): boolean {
  if (row.assigneeTenantUserId === access.tenantUserId) return true;
  return isPermission(row.requiredPermission) && can(access.effective, row.requiredPermission);
}

async function findTask(tx: Transaction, id: string) {
  const [row] = await tx
    .select()
    .from(task)
    .where(and(eq(task.id, id), isNull(task.deletedAt)));
  return row;
}

function requireMfaFor(access: TenantAccess, personId: string | null) {
  if (personId && !access.mfaSatisfied) throw problems.mfaRequired();
}

function asTaskStatus(value: string): TaskStatus {
  return value as TaskStatus;
}

function rejectRecurrence(error: unknown): never {
  if (error instanceof RecurrenceError) throw problems.invalid(error.message);
  throw error;
}

const taskIdParam = z.object({ id: z.uuid() });

export const tasksRouter = createRouter()
  .openapi(
    createRoute({
      method: "get",
      path: "/v1/tasks",
      tags: ["platform"],
      summary: "Tasks in your scope: by default open tasks due from yesterday to tomorrow",
      security,
      request: {
        query: z.object({
          view: z.enum(["all", "mine"]).default("all"),
          personId: z.uuid().optional(),
          locationId: z.uuid().optional(),
          status: z.enum(["open", "closed", "any"]).default("open"),
          from: z.iso.datetime({ offset: true }).optional(),
          to: z.iso.datetime({ offset: true }).optional(),
        }),
      },
      responses: { 200: jsonBody(TaskList, "Tasks"), ...errorResponses },
    }),
    async (c) => {
      const access = c.get("access");
      const q = c.req.valid("query");
      const now = new Date();
      if (q.personId) requireMfaFor(access, q.personId);
      const from = q.from ? new Date(q.from) : new Date(now.getTime() - DAY_MS);
      const to = q.to ? new Date(q.to) : new Date(now.getTime() + DAY_MS);
      if (to.getTime() - from.getTime() > 31 * DAY_MS)
        throw problems.invalid("Ask for 31 days or fewer.");
      const items = await withTenant(c, async (tx) => {
        const rows = await tx
          .select()
          .from(task)
          .where(
            and(
              isNull(task.deletedAt),
              gte(task.dueAt, from),
              lt(task.dueAt, to),
              q.status === "open"
                ? inArray(task.status, ["open", "in_progress"])
                : q.status === "closed"
                  ? inArray(task.status, [...TERMINAL_TASK_STATUSES])
                  : undefined,
              q.view === "mine" ? eq(task.assigneeTenantUserId, access.tenantUserId) : undefined,
              q.personId ? eq(task.personId, q.personId) : undefined,
              q.locationId ? eq(task.locationId, q.locationId) : undefined,
              // Without MFA, tasks about people stay hidden (they are care records).
              access.mfaSatisfied ? undefined : isNull(task.personId),
            ),
          )
          .orderBy(asc(task.dueAt))
          .limit(1000);
        const minutes = await escalationMinutes(tx, access.tenantId);
        await auditInTx(tx, access, {
          action: "platform.task.list",
          resourceType: "task",
          scope: {
            count: rows.length,
            personId: q.personId ?? null,
            locationId: q.locationId ?? null,
          },
          requestId: c.get("requestId"),
        });
        return rows.map((r) => toTaskItem(r, now, minutes));
      });
      return c.json({ items }, 200);
    },
  )
  .openapi(
    createRoute({
      method: "post",
      path: "/v1/tasks",
      tags: ["platform"],
      summary: "Create a one-off task",
      security,
      request: { body: { content: { "application/json": { schema: CreateTask } } } },
      responses: {
        201: jsonBody(TaskItem, "Task created"),
        ...errorResponses,
        ...notFoundResponse,
      },
    }),
    async (c) => {
      const access = await requirePermission(c, GENERAL_TASK_PERMISSION);
      const body = c.req.valid("json");
      requireMfaFor(access, body.personId ?? null);
      checkWindow(body.dueAt, body.windowStart, body.windowEnd);
      const now = new Date();
      const item = await withTenant(c, async (tx) => {
        const [row] = await tx
          .insert(task)
          .values({
            kind: "platform.manual",
            title: body.title,
            requiredPermission: body.personId ? PERSON_TASK_PERMISSION : GENERAL_TASK_PERMISSION,
            personId: body.personId ?? null,
            locationId: body.locationId ?? null,
            assigneeTenantUserId: body.assigneeTenantUserId ?? null,
            dueAt: new Date(body.dueAt),
            windowStart: body.windowStart ? new Date(body.windowStart) : null,
            windowEnd: body.windowEnd ? new Date(body.windowEnd) : null,
            priority: body.priority,
          })
          .returning()
          .catch(rethrowReference);
        if (!row) throw problems.notFound();
        await auditInTx(tx, access, {
          action: "platform.task.create",
          resourceType: "task",
          resourceId: row.id,
          requestId: c.get("requestId"),
        });
        return toTaskItem(row, now, await escalationMinutes(tx, access.tenantId));
      });
      return c.json(item, 201);
    },
  )
  .openapi(
    createRoute({
      method: "post",
      path: "/v1/tasks/{id}/transition",
      tags: ["platform"],
      summary: "Start, complete, skip or cancel a task",
      security,
      request: {
        params: taskIdParam,
        body: { content: { "application/json": { schema: TaskTransitionRequest } } },
      },
      responses: {
        200: jsonBody(TaskItem, "Task updated"),
        ...errorResponses,
        ...notFoundResponse,
        ...conflictResponse,
      },
    }),
    async (c) => transition(c, c.req.valid("param").id, c.req.valid("json")),
  )
  .openapi(
    createRoute({
      method: "post",
      path: "/v1/tasks/{id}/assign",
      tags: ["platform"],
      summary: "Assign or unassign a task",
      security,
      request: {
        params: taskIdParam,
        body: { content: { "application/json": { schema: TaskAssignRequest } } },
      },
      responses: {
        200: jsonBody(TaskItem, "Task assigned"),
        ...errorResponses,
        ...notFoundResponse,
      },
    }),
    async (c) => {
      const access = await requirePermission(c, GENERAL_TASK_PERMISSION);
      const { id } = c.req.valid("param");
      const body = c.req.valid("json");
      const now = new Date();
      const item = await withTenant(c, async (tx) => {
        const row = await findTask(tx, id);
        if (!row) throw problems.notFound();
        requireMfaFor(access, row.personId);
        if (row.version !== body.version) throw problems.conflict();
        if (TERMINAL_TASK_STATUSES.includes(asTaskStatus(row.status))) {
          throw problems.invalid("This task is already finished.");
        }
        const [updated] = await tx
          .update(task)
          .set({ assigneeTenantUserId: body.assigneeTenantUserId })
          .where(and(eq(task.id, id), eq(task.version, body.version)))
          .returning()
          .catch(rethrowReference);
        if (!updated) throw problems.conflict();
        await auditInTx(tx, access, {
          action: "platform.task.assign",
          resourceType: "task",
          resourceId: id,
          requestId: c.get("requestId"),
        });
        return toTaskItem(updated, now, await escalationMinutes(tx, access.tenantId));
      });
      return c.json(item, 200);
    },
  )
  .openapi(
    createRoute({
      method: "post",
      path: "/v1/task-series",
      tags: ["platform"],
      summary: "Schedule a recurring task (UK local times)",
      security,
      request: { body: { content: { "application/json": { schema: CreateTaskSeries } } } },
      responses: {
        201: jsonBody(TaskSeriesItem, "Series created"),
        ...errorResponses,
        ...notFoundResponse,
      },
    }),
    async (c) => {
      const access = await requirePermission(c, GENERAL_TASK_PERMISSION);
      const body = c.req.valid("json");
      requireMfaFor(access, body.personId ?? null);
      try {
        validateRecurrence({
          rule: body.recurrence,
          startsOn: body.startsOn,
          endsOn: body.endsOn ?? null,
        });
      } catch (error) {
        rejectRecurrence(error);
      }
      const now = new Date();
      const series = await withTenant(c, async (tx) => {
        const [row] = await tx
          .insert(taskSeries)
          .values({
            kind: "platform.manual",
            title: body.title,
            requiredPermission: body.personId ? PERSON_TASK_PERMISSION : GENERAL_TASK_PERMISSION,
            personId: body.personId ?? null,
            locationId: body.locationId ?? null,
            assigneeTenantUserId: body.assigneeTenantUserId ?? null,
            recurrence: body.recurrence,
            startsOn: body.startsOn,
            endsOn: body.endsOn ?? null,
            windowBeforeMinutes: body.windowBeforeMinutes,
            windowAfterMinutes: body.windowAfterMinutes,
            priority: body.priority,
            evidenceRequired: body.evidenceRequired,
          })
          .returning()
          .catch(rethrowReference);
        if (!row) throw problems.notFound();
        await materialiseSeries(tx, row, now);
        await auditInTx(tx, access, {
          action: "platform.task_series.create",
          resourceType: "task_series",
          resourceId: row.id,
          requestId: c.get("requestId"),
        });
        const [fresh] = await tx.select().from(taskSeries).where(eq(taskSeries.id, row.id));
        return fresh ?? row;
      });
      return c.json(seriesItem(series), 201);
    },
  )
  .openapi(
    createRoute({
      method: "post",
      path: "/v1/task-series/{id}/end",
      tags: ["platform"],
      summary: "End a recurring task; open future tasks are cancelled with the reason",
      security,
      request: {
        params: taskIdParam,
        body: { content: { "application/json": { schema: EndTaskSeries } } },
      },
      responses: {
        200: jsonBody(TaskSeriesItem, "Series ended"),
        ...errorResponses,
        ...notFoundResponse,
      },
    }),
    async (c) => {
      const access = await requirePermission(c, GENERAL_TASK_PERMISSION);
      const { id } = c.req.valid("param");
      const body = c.req.valid("json");
      const now = new Date();
      const series = await withTenant(c, async (tx) => {
        const [row] = await tx.select().from(taskSeries).where(eq(taskSeries.id, id));
        if (!row) throw problems.notFound();
        requireMfaFor(access, row.personId);
        if (row.version !== body.version) throw problems.conflict();
        const [ended] = await tx
          .update(taskSeries)
          .set({ active: false, endsOn: now.toISOString().slice(0, 10) })
          .where(and(eq(taskSeries.id, id), eq(taskSeries.version, body.version)))
          .returning();
        if (!ended) throw problems.conflict();
        await tx
          .update(task)
          .set({ status: "cancelled", statusReason: body.reason })
          .where(
            and(
              eq(task.seriesId, id),
              inArray(task.status, ["open", "in_progress"]),
              gte(task.dueAt, now),
            ),
          );
        await auditInTx(tx, access, {
          action: "platform.task_series.end",
          resourceType: "task_series",
          resourceId: id,
          reason: body.reason,
          requestId: c.get("requestId"),
        });
        return ended;
      });
      return c.json(seriesItem(series), 200);
    },
  );

function seriesItem(row: typeof taskSeries.$inferSelect) {
  return {
    id: row.id,
    kind: row.kind,
    title: row.title,
    personId: row.personId,
    locationId: row.locationId,
    recurrence: row.recurrence as TaskSeriesItem["recurrence"],
    startsOn: row.startsOn,
    endsOn: row.endsOn,
    active: row.active,
    version: row.version,
  };
}

function checkWindow(dueAt: string, windowStart?: string, windowEnd?: string) {
  const due = Date.parse(dueAt);
  if (windowStart && Date.parse(windowStart) > due)
    throw problems.invalid("The window must start by the due time.");
  if (windowEnd && Date.parse(windowEnd) < due)
    throw problems.invalid("The window must end at or after the due time.");
}

/** A person, location or assignee outside the tenant fails the composite foreign key: not found. */
function rethrowReference(error: unknown): never {
  const code =
    (error as { code?: string }).code ?? (error as { cause?: { code?: string } }).cause?.code;
  // 23503: foreign key (another tenant's or a missing record); 42501: outside your scope (RLS).
  if (code === "23503" || code === "42501") throw problems.notFound();
  throw error;
}

async function transition(c: Context<AppEnv>, id: string, body: TaskTransitionRequest) {
  const access = c.get("access");
  const now = new Date();
  const item = await withTenant(c, async (tx) => {
    const row = await findTask(tx, id);
    if (!row) throw problems.notFound();
    requireMfaFor(access, row.personId);
    if (!canComplete(access, row)) throw problems.forbidden();
    if (row.version !== body.version) throw problems.conflict();
    const check = checkTaskTransition(asTaskStatus(row.status), {
      to: body.to,
      reason: body.reason ?? null,
      evidenceId: body.evidenceId ?? null,
      evidenceRequired: row.evidenceRequired,
    });
    if (!check.ok) throw problems.invalid(check.message);
    const finished = TERMINAL_TASK_STATUSES.includes(body.to);
    const [updated] = await tx
      .update(task)
      .set({
        status: body.to,
        statusReason: body.reason ?? null,
        completedAt: finished ? now : null,
        completedBy: finished ? access.tenantUserId : null,
        evidenceType: body.evidenceType ?? row.evidenceType,
        evidenceId: body.evidenceId ?? row.evidenceId,
      })
      .where(and(eq(task.id, id), eq(task.version, body.version)))
      .returning();
    if (!updated) throw problems.conflict();
    await auditInTx(tx, access, {
      action: `platform.task.${body.to}`,
      resourceType: "task",
      resourceId: id,
      reason: body.reason,
      requestId: c.get("requestId"),
    });
    if (finished) {
      await publish(tx, {
        context: "platform",
        aggregateType: "task",
        aggregateId: id,
        type: `platform.task.${body.to}`,
        payload: { kind: row.kind, sourceType: row.sourceType, sourceId: row.sourceId },
      });
    }
    return toTaskItem(updated, now, await escalationMinutes(tx, access.tenantId));
  });
  return c.json(item, 200);
}
