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
import {
  activityRecord,
  assessment,
  bodyMapMark,
  careNote,
  observation,
  person,
  shift,
  shiftCoverNeed,
  type Transaction,
  task,
  taskSeries,
  visitLog,
} from "@harbour/db";
import {
  can,
  checkTaskEvidence,
  checkTaskTransition,
  isPermission,
  PLAN_ACTION_SOURCE_TYPE,
  RecurrenceError,
  requiresMfa,
  scopeFor,
  type TaskStatus,
  TERMINAL_TASK_STATUSES,
  validateRecurrence,
} from "@harbour/domain";
import { createRoute, z } from "@hono/zod-openapi";
import { and, asc, count, desc, eq, gte, inArray, isNull, lt } from "drizzle-orm";
import type { Context } from "hono";
import { AuditedRefusal, auditInTx, withAuditedRefusal, writeAudit } from "../http/audit";
import {
  type AppEnv,
  inScopeOf,
  mfaRefusal,
  requirePermission,
  type TenantAccess,
  useScopeOf,
  withTenant,
} from "../http/context";
import { problems } from "../http/problem";
import { publish } from "../outbox";
import { COVER_TASK_KIND } from "../services/device-holds";
import {
  assigneeMayComplete,
  EVIDENCE_ONLY_TASK_KINDS,
  escalationMinutes,
  GENERAL_TASK_PERMISSION,
  materialiseSeries,
  mayBeGiven,
  SELF_ESCALATED_TASK_KINDS,
  taskStaff,
  toTaskItem,
} from "../services/tasks";
import {
  conflictResponse,
  createRouter,
  errorResponses,
  jsonBody,
  notFoundResponse,
  security,
} from "./openapi";

/**
 * Tasks (section 9.1). Anyone in the tenant sees the tasks row-level security lets them see, in the
 * scope of the permission a person's record is opened with (`people.person.read`, ADR-0071): a
 * task about a person when they may open that person's record, one about nobody when it is theirs
 * or at a location that permission reaches. Tasks about people need MFA like any care record. A
 * task can be completed by anyone holding the permission the task names where the task is, or by
 * its assignee while they could still be given it; managers create, assign and schedule tasks.
 */

const PERSON_TASK_PERMISSION = "care.note.write";
/** The scope tasks are listed and found in (`SCOPE_WITHOUT_PERMISSION`, ADR-0071). */
const TASK_READ_SCOPE = "people.person.read";
const DAY_MS = 86_400_000;
/** The most tasks one list returns; `truncated` says when there were more. */
const TASK_LIST_LIMIT = 1000;

/** Why someone may not be given a task. */
const ASSIGNEE_REFUSED =
  "That person cannot be given this task: they do not hold its permission at this location, or cannot see the person it is about.";

/** Why a task about a person cannot be placed at another location (review round 5). */
const LOCATION_NOT_HOME =
  "A task about a person is placed where they live. Leave the location out, or choose their home.";

/**
 * Whether the caller may move a task (no step-up: completing is not submitting): anyone holding
 * the permission it names where the task is (the roles and grants carrying it reach the task's
 * person or location, ADR-0071), or its assignee while they could still be given it (S1 follow-on;
 * `assigneeMayComplete`). Returns why not, for the audit, or null.
 */
async function completionRefusal(
  tx: Transaction,
  access: TenantAccess,
  row: typeof task.$inferSelect,
  now: Date,
): Promise<string | null> {
  if (EVIDENCE_ONLY_TASK_KINDS.includes(row.kind)) return "completed_by_its_evidence";
  const permission = row.requiredPermission;
  if (isPermission(permission) && can(access.effective, permission)) {
    const here = await inScopeOf(tx, scopeFor(access.effective, permission), () =>
      findTask(tx, row.id),
    );
    if (here) return null;
  }
  if (await assigneeMayComplete(tx, access.tenantUserId, row, now)) return null;
  return row.assigneeTenantUserId === access.tenantUserId
    ? "assignee_lacks_permission"
    : "missing_permission";
}

/**
 * A task about a person names a permission, so its assignee must hold it at the task's location
 * when it is created, as when it is assigned (S1), and must be able to see the person with
 * `people.person.read` and that permission (`mayBeGiven`; ADR-0071 review round 1, C-M4); a
 * general task goes to anyone. Refused and audited (after the transaction) otherwise.
 */
async function requireAssignable(
  tx: Transaction,
  action: string,
  row: {
    readonly assigneeTenantUserId: string | null | undefined;
    readonly requiredPermission: string;
    readonly locationId: string | null;
    readonly personId: string | null;
  },
  now: Date,
): Promise<void> {
  const assignee = row.assigneeTenantUserId;
  if (!assignee || row.requiredPermission === GENERAL_TASK_PERMISSION) return;
  if (await mayBeGiven(tx, assignee, row, now)) return;
  throw new AuditedRefusal(problems.invalid(ASSIGNEE_REFUSED), {
    action,
    outcome: "denied",
    reason: "assignee_lacks_permission",
    scope: { assigneeTenantUserId: assignee, locationId: row.locationId },
  });
}

/**
 * A cover task (scheduling.md section 15 rule 7; HZ-123) is for the rota's managers only: matched
 * with the rota, its shift would say which colleague is away. Anyone else at the home (who the
 * task's row-level security lets see a task with no person) does not see it; its assignee does.
 */
function coverTaskHidden(
  access: TenantAccess,
  row: { kind: string; locationId: string | null; assigneeTenantUserId: string | null },
): boolean {
  if (row.kind !== COVER_TASK_KIND) return false;
  if (row.assigneeTenantUserId === access.tenantUserId) return false;
  if (!can(access.effective, "scheduling.rota.manage")) return true;
  const reach = scopeFor(access.effective, "scheduling.rota.manage");
  return !(
    reach.scope === "tenant" ||
    (reach.scope === "locations" &&
      row.locationId !== null &&
      reach.locationIds.includes(row.locationId))
  );
}

/**
 * A cover task closes itself when its cover need resolves (`closeCoverTasks`): nobody marks it
 * done, skipped or cancelled while the need is open and the shift has not started, so the shift's
 * only signal cannot be put away before cover is found (security review, finding 1).
 */
async function coverStillNeeded(
  tx: Transaction,
  row: { kind: string; sourceId: string | null },
  now: Date,
): Promise<boolean> {
  if (row.kind !== COVER_TASK_KIND || !row.sourceId) return false;
  const [need] = await tx
    .select({ resolvedAt: shiftCoverNeed.resolvedAt, startsAt: shift.startsAt })
    .from(shiftCoverNeed)
    .innerJoin(
      shift,
      and(eq(shift.tenantId, shiftCoverNeed.tenantId), eq(shift.id, shiftCoverNeed.shiftId)),
    )
    .where(eq(shiftCoverNeed.id, row.sourceId));
  // A need the reader cannot see is treated as open: closing waits for the resolution.
  return !need || (need.resolvedAt === null && need.startsAt > now);
}

async function findTask(tx: Transaction, id: string) {
  const [row] = await tx
    .select()
    .from(task)
    .where(and(eq(task.id, id), isNull(task.deletedAt)));
  return row;
}

/**
 * Whether a task needs MFA to open: one about a person (a care record), or one whose required
 * permission needs MFA (a staff file reminder; security review round 1 of slice 17, finding 3).
 */
function taskNeedsMfa(row: { personId: string | null; requiredPermission: string }): boolean {
  return (
    row.personId !== null ||
    (isPermission(row.requiredPermission) && requiresMfa(row.requiredPermission))
  );
}

function requireMfaFor(
  access: TenantAccess,
  row: { personId: string | null; requiredPermission: string },
) {
  if (taskNeedsMfa(row) && !access.mfaSatisfied) throw mfaRefusal(access);
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
          /**
           * With open tasks: also every open task due before `from`, however old, so a missed
           * round or a review left open never drops off the list (HZ-003, HZ-008).
           */
          earlier: z.enum(["yes", "no"]).default("no"),
          from: z.iso.datetime({ offset: true }).optional(),
          to: z.iso.datetime({ offset: true }).optional(),
        }),
      },
      responses: { 200: jsonBody(TaskList, "Tasks"), ...errorResponses },
    }),
    async (c) => {
      const access = useScopeOf(c, TASK_READ_SCOPE);
      const q = c.req.valid("query");
      const now = new Date();
      if (q.personId && !access.mfaSatisfied) throw mfaRefusal(access);
      const from = q.from ? new Date(q.from) : new Date(now.getTime() - DAY_MS);
      const to = q.to ? new Date(q.to) : new Date(now.getTime() + DAY_MS);
      if (to.getTime() - from.getTime() > 31 * DAY_MS)
        throw problems.invalid("Ask for 31 days or fewer.");
      const earlier = q.status === "open" && q.earlier === "yes";
      const items = await withTenant(c, async (tx) => {
        const matching = and(
          isNull(task.deletedAt),
          q.status === "open"
            ? inArray(task.status, ["open", "in_progress"])
            : q.status === "closed"
              ? inArray(task.status, [...TERMINAL_TASK_STATUSES])
              : undefined,
          q.view === "mine" ? eq(task.assigneeTenantUserId, access.tenantUserId) : undefined,
          q.personId ? eq(task.personId, q.personId) : undefined,
          q.locationId ? eq(task.locationId, q.locationId) : undefined,
          // Without MFA, tasks about people stay hidden (they are care records), and so do staff
          // file reminders (filtered below).
          access.mfaSatisfied ? undefined : isNull(task.personId),
        );
        // The window's own tasks first, so old open tasks never push today's off the list (HZ-003).
        const rows = await tx
          .select()
          .from(task)
          .where(and(matching, gte(task.dueAt, from), lt(task.dueAt, to)))
          .orderBy(asc(task.dueAt))
          .limit(TASK_LIST_LIMIT + 1);
        const truncated = rows.length > TASK_LIST_LIMIT;
        if (truncated) rows.length = TASK_LIST_LIMIT;
        // Then open tasks due before the window, however old, the most recent first, in the room
        // left; how many did not fit is counted, so the page can say so (HZ-003, HZ-008).
        let earlierOmitted = 0;
        if (earlier) {
          const before = and(matching, lt(task.dueAt, from));
          const room = TASK_LIST_LIMIT - rows.length;
          const older =
            room > 0
              ? await tx.select().from(task).where(before).orderBy(desc(task.dueAt)).limit(room)
              : [];
          const [all] = await tx.select({ n: count() }).from(task).where(before);
          earlierOmitted = Math.max(0, Number(all?.n ?? 0) - older.length);
          rows.unshift(...older.reverse());
        }
        // Without MFA, tasks whose permission needs it stay hidden too (staff file reminders;
        // security review round 1 of slice 17, finding 3).
        if (!access.mfaSatisfied) {
          const kept = rows.filter((r) => !taskNeedsMfa(r));
          rows.length = 0;
          rows.push(...kept);
        }
        {
          const kept = rows.filter((r) => !coverTaskHidden(access, r));
          rows.length = 0;
          rows.push(...kept);
        }
        const minutes = await escalationMinutes(tx, access.tenantId);
        await auditInTx(tx, access, {
          action: "platform.task.list",
          resourceType: "task",
          scope: {
            count: rows.length,
            personId: q.personId ?? null,
            locationId: q.locationId ?? null,
            earlier,
          },
          requestId: c.get("requestId"),
        });
        const staff = await taskStaff(tx, rows);
        return {
          items: rows.map((r) => toTaskItem(r, now, minutes, staff)),
          truncated,
          ...(earlier ? { earlierOmitted } : {}),
        };
      });
      return c.json(items, 200);
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
      requireMfaFor(access, { personId: body.personId ?? null, requiredPermission: "" });
      checkWindow(body.dueAt, body.windowStart, body.windowEnd);
      const now = new Date();
      const requiredPermission = body.personId ? PERSON_TASK_PERMISSION : GENERAL_TASK_PERMISSION;
      const item = await withAuditedRefusal(c, access, () =>
        withTenant(c, async (tx) => {
          // A task about a person takes the person's home when none is given, so it is routed,
          // listed and escalated where the person lives (ADR-0071 review round 4); a location
          // given with a person must be that home (review round 5).
          let locationId = body.locationId ?? null;
          if (body.personId) {
            const [home] = await tx
              .select({ locationId: person.locationId })
              .from(person)
              .where(eq(person.id, body.personId));
            if (!home) throw problems.notFound();
            if (locationId && locationId !== home.locationId) {
              throw problems.invalid(LOCATION_NOT_HOME);
            }
            locationId = home.locationId;
          }
          await requireAssignable(
            tx,
            "platform.task.create",
            {
              assigneeTenantUserId: body.assigneeTenantUserId,
              requiredPermission,
              locationId,
              personId: body.personId ?? null,
            },
            now,
          );
          const [row] = await tx
            .insert(task)
            .values({
              kind: "platform.manual",
              title: body.title,
              requiredPermission,
              personId: body.personId ?? null,
              locationId,
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
          return toTaskItem(
            row,
            now,
            await escalationMinutes(tx, access.tenantId),
            await taskStaff(tx, [row]),
          );
        }),
      );
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
        if (!row || coverTaskHidden(access, row)) throw problems.notFound();
        requireMfaFor(access, row);
        if (row.version !== body.version) throw problems.conflict();
        if (TERMINAL_TASK_STATUSES.includes(asTaskStatus(row.status))) {
          throw problems.invalid("This task is already finished.");
        }
        // Being the assignee lets someone complete the task, so a task that needs a permission
        // (a clinical check, a medicines round) goes only to someone who holds it at the task's
        // location, whoever assigns it (themselves included; S1), and a task about a person only
        // to someone who can see the person with people.person.read and that permission
        // (ADR-0071 review round 1, C-M4). A general task, which names only the task-management
        // permission, is allocated to anyone: that is what it is for.
        if (
          body.assigneeTenantUserId &&
          row.requiredPermission !== GENERAL_TASK_PERMISSION &&
          !(await mayBeGiven(tx, body.assigneeTenantUserId, row, now))
        ) {
          return null;
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
        return toTaskItem(
          updated,
          now,
          await escalationMinutes(tx, access.tenantId),
          await taskStaff(tx, [updated]),
        );
      });
      if (!item) {
        // Written after the transaction, which wrote nothing, so the refusal is kept.
        await writeAudit(c.get("services").appPool, access, {
          action: "platform.task.assign",
          outcome: "denied",
          resourceType: "task",
          resourceId: id,
          reason: "assignee_lacks_permission",
          requestId: c.get("requestId"),
        });
        throw problems.invalid(ASSIGNEE_REFUSED);
      }
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
      requireMfaFor(access, { personId: body.personId ?? null, requiredPermission: "" });
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
      const requiredPermission = body.personId ? PERSON_TASK_PERMISSION : GENERAL_TASK_PERMISSION;
      const series = await withAuditedRefusal(c, access, () =>
        withTenant(c, async (tx) => {
          // Its occurrences inherit the assignee, so the series is checked like a task (S1).
          await requireAssignable(
            tx,
            "platform.task_series.create",
            {
              assigneeTenantUserId: body.assigneeTenantUserId,
              requiredPermission,
              locationId: body.locationId ?? null,
              personId: body.personId ?? null,
            },
            now,
          );
          const [row] = await tx
            .insert(taskSeries)
            .values({
              kind: "platform.manual",
              title: body.title,
              requiredPermission,
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
        }),
      );
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
        requireMfaFor(access, row);
        // The care plan says what is done and when; its rounds change only with it (care.md
        // rule 14, HZ-024).
        if (row.sourceType === PLAN_ACTION_SOURCE_TYPE) {
          throw problems.invalid(
            "These rounds come from the care plan. Change the plan to stop or change them.",
          );
        }
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

/**
 * The entry a transition cites as evidence, as the caller's own read finds it (row-level security:
 * another organisation's, another home's or a missing id are all not found), or null.
 */
async function citedEntry(
  tx: Transaction,
  type: string,
  id: string,
): Promise<{ personId: string; chart?: string | null } | null> {
  const one = async (rows: Promise<{ personId: string; chart?: string | null }[]>) =>
    (await rows)[0] ?? null;
  switch (type) {
    case "observation":
      return one(
        tx
          .select({ personId: observation.personId, chart: observation.chart })
          .from(observation)
          .where(eq(observation.id, id)),
      );
    case "care_note":
      return one(
        tx.select({ personId: careNote.personId }).from(careNote).where(eq(careNote.id, id)),
      );
    case "body_map_mark":
      return one(
        tx
          .select({ personId: bodyMapMark.personId })
          .from(bodyMapMark)
          .where(eq(bodyMapMark.id, id)),
      );
    case "activity_record":
      return one(
        tx
          .select({ personId: activityRecord.personId })
          .from(activityRecord)
          .where(eq(activityRecord.id, id)),
      );
    case "visit_log":
      return one(
        tx.select({ personId: visitLog.personId }).from(visitLog).where(eq(visitLog.id, id)),
      );
    case "assessment":
      return one(
        tx.select({ personId: assessment.personId }).from(assessment).where(eq(assessment.id, id)),
      );
    default:
      return null;
  }
}

const EVIDENCE_REFUSED = "That record cannot stand as evidence for this task.";

async function transition(c: Context<AppEnv>, id: string, body: TaskTransitionRequest) {
  const access = useScopeOf(c, TASK_READ_SCOPE);
  const now = new Date();
  const item = await withAuditedRefusal(c, access, () =>
    withTenant(c, async (tx) => {
      const row = await findTask(tx, id);
      if (!row || coverTaskHidden(access, row)) throw problems.notFound();
      requireMfaFor(access, row);
      if (TERMINAL_TASK_STATUSES.includes(body.to) && (await coverStillNeeded(tx, row, now))) {
        throw problems.conflict(
          "This shift still needs cover. The task closes when someone else is put on the shift.",
        );
      }
      const refused = await completionRefusal(tx, access, row, now);
      if (refused) {
        // Written after the transaction, which writes nothing, so the refusal is kept.
        throw new AuditedRefusal(problems.forbidden(), {
          action: `platform.task.${body.to}`,
          outcome: "denied",
          resourceType: "task",
          resourceId: id,
          reason: refused,
        });
      }
      if (row.version !== body.version) throw problems.conflict();
      // A task that only resolving its cause finishes (#120 review round 4, M1): the duty of
      // candour holding an incident open ends when nothing holds it, never by a person marking
      // the task done, skipped or cancelled, which would restart its escalation.
      if (SELF_ESCALATED_TASK_KINDS.includes(row.kind) && body.to !== "in_progress") {
        throw problems.invalid(
          "This task finishes on its own once the duty of candour no longer holds the incident open: finish the duty of candour on the incident.",
        );
      }
      const check = checkTaskTransition(asTaskStatus(row.status), {
        to: body.to,
        reason: body.reason ?? null,
        evidenceId: body.evidenceId ?? null,
        evidenceRequired: row.evidenceRequired,
      });
      if (!check.ok) throw problems.invalid(check.message);
      // A record cited as evidence must be one Harbour accepts, about this task's person, and the
      // evidence this task asks for (HZ-029, HZ-001). Every refusal reads the same, so an id
      // cannot be probed; the audit keeps why, with opaque ids only.
      const cites = body.evidenceId !== undefined || body.evidenceType !== undefined;
      if (cites) {
        const refuse = (reason: string) =>
          new AuditedRefusal(problems.invalid(EVIDENCE_REFUSED), {
            action: `platform.task.${body.to}`,
            outcome: "denied",
            resourceType: "task",
            resourceId: id,
            reason,
            scope: { evidenceType: body.evidenceType ?? null, evidenceId: body.evidenceId ?? null },
          });
        if (body.to !== "done") throw refuse("evidence_without_completion");
        const found =
          body.evidenceType && body.evidenceId
            ? await citedEntry(tx, body.evidenceType, body.evidenceId)
            : null;
        const problem = checkTaskEvidence(
          { personId: row.personId, kind: row.kind, evidenceRequired: row.evidenceRequired },
          { type: body.evidenceType ?? null, id: body.evidenceId ?? null, found },
        );
        if (problem) throw refuse(problem);
      }
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
      return toTaskItem(
        updated,
        now,
        await escalationMinutes(tx, access.tenantId),
        await taskStaff(tx, [updated]),
      );
    }),
  );
  return c.json(item, 200);
}
