import {
  AuditRecordDetail,
  AuditRecordList,
  AuditScheduleItem,
  AuditScheduleList,
  AuditStarterList,
  AuditTemplateItem,
  AuditTemplateList,
  CompleteAudit,
  CreateAuditSchedule,
  CreateAuditTemplate,
  RetireAuditTemplate,
  SaveAuditAnswers,
  StartAudit,
  UpdateAuditTemplate,
} from "@harbour/contracts";
import {
  auditAction,
  auditRecord,
  auditSchedule,
  auditStarterTemplate,
  auditTemplate,
  location,
  type Transaction,
  task,
  tenantUser,
} from "@harbour/db";
import {
  AUDIT_COMPLETION_MESSAGES,
  type AuditKind,
  type AuditTemplateProblem,
  checkAuditCompletion,
  checkAuditTemplate,
  defaultActionDueOn,
  nextAuditDue,
  scoreAudit,
  ukDayBounds,
  ukIsoDate,
} from "@harbour/domain";
import { createRoute, z } from "@hono/zod-openapi";
import { and, asc, desc, eq, inArray } from "drizzle-orm";
import type { Context } from "hono";
import { AuditedRefusal, withAuditedRefusal, writeAudit } from "../http/audit";
import {
  type AppEnv,
  requirePermission,
  type TenantAccess,
  usablePermissions,
  withTenant,
} from "../http/context";
import { HttpProblem, problems } from "../http/problem";
import {
  answersOf,
  frameworksInForce,
  lastCompletedOn,
  questionsOf,
  recordDetail,
  recordSummary,
  scoredTemplate,
  templateItem,
} from "../services/quality-audits";
import { frameworkContent } from "../services/quality-framework";
import { rateNumber } from "../services/rates";
import {
  conflictResponse,
  createRouter,
  errorResponses,
  jsonBody,
  notFoundResponse,
  security,
} from "./openapi";
import { audit, dbCode } from "./people-shared";

/**
 * The audit programme and mock inspections (quality.md section 19; QUAL-004; HZ-011; migration
 * 0081). Everything is `quality.audit.manage`: templates for whoever holds it anywhere, schedules
 * and audits only at the locations where they hold it (the database's row-level security holds the
 * same line). An audit keeps the questions and framework version it started with; a mock
 * inspection starts only against the framework version in force; completion takes a self-rating on
 * the rate table's CQC scale from a person and an action, with an owner's task, for each answer
 * that fell short. Every change, and every refusal, is audited.
 */

const MANAGE = "quality.audit.manage";
const TASK_KIND = "quality.audit_action";
const A = {
  templateSaved: "quality.audit.template_saved",
  templateRetired: "quality.audit.template_retired",
  scheduled: "quality.audit.scheduled",
  started: "quality.audit.started",
  answered: "quality.audit.answered",
  completed: "quality.audit.completed",
} as const;
type Action = (typeof A)[keyof typeof A];
const RESOURCE: Readonly<Record<Action, string>> = {
  [A.templateSaved]: "audit_template",
  [A.templateRetired]: "audit_template",
  [A.scheduled]: "audit_schedule",
  [A.started]: "audit_record",
  [A.answered]: "audit_record",
  [A.completed]: "audit_record",
};

const TEMPLATE_MESSAGES: Readonly<Record<AuditTemplateProblem, string>> = {
  no_questions: "Add at least one question.",
  invalid_weight: "Give every question a weight of 1 or more.",
  unknown_statement:
    "Map questions only to quality statements of the template's framework version.",
  duplicate_question: "Give each question its own key.",
  wrong_framework: "Map the questions to the template's own framework version.",
};

const IdParam = z.object({ id: z.uuid() });

const refused = (problem: HttpProblem, action: Action, id: string | null, reason: string) =>
  new AuditedRefusal(problem, {
    action,
    outcome: "denied",
    resourceType: RESOURCE[action],
    ...(id ? { resourceId: id } : {}),
    reason,
  });

const stateConflict = (detail: string) => new HttpProblem(409, "invalid_state", detail);

/** Runs a change; refusals and the database's own (403, 409) are audited. */
async function change<T>(
  c: Context<AppEnv>,
  access: TenantAccess,
  action: Action,
  id: string | null,
  fn: (tx: Transaction) => Promise<T>,
): Promise<T> {
  try {
    return await withAuditedRefusal(c, access, () => withTenant(c, fn));
  } catch (error) {
    const code = dbCode(error);
    if (code !== "42501" && code !== "23000" && code !== "23514" && code !== "23505") throw error;
    await writeAudit(c.get("services").appPool, access, {
      action,
      outcome: "denied",
      resourceType: RESOURCE[action],
      ...(id ? { resourceId: id } : {}),
      reason: code === "42501" ? "refused_by_database" : "invalid_state",
      requestId: c.get("requestId"),
    });
    if (code === "42501") throw problems.forbidden();
    if (code === "23505") {
      throw stateConflict("That key is already used by another of your audit templates.");
    }
    throw stateConflict("This changed since you read it. Reload and try again.");
  }
}

/** A template's questions checked against its framework version, which must be published. */
async function checkTemplate(
  tx: Transaction,
  action: Action,
  id: string | null,
  template: {
    key: string;
    kind: AuditKind;
    title: string;
    frameworkVersionId: string;
    questions: readonly z.infer<typeof AuditTemplateItem>["questions"][number][];
  },
) {
  const framework = await frameworkContent(tx, template.frameworkVersionId);
  if (!framework) throw refused(problems.notFound(), action, id, "framework_not_found");
  if (framework.domain.state !== "published") {
    throw refused(
      stateConflict("Map a template only to the framework version in use."),
      action,
      id,
      "framework_not_published",
    );
  }
  const found = checkAuditTemplate(template, framework.domain);
  if (found.length > 0) {
    throw refused(
      problems.invalid(found.map((p) => TEMPLATE_MESSAGES[p]).join(" ")),
      action,
      id,
      found.join(","),
    );
  }
}

async function visibleLocation(tx: Transaction, id: string, action: Action) {
  const [row] = await tx.select({ id: location.id }).from(location).where(eq(location.id, id));
  if (!row) throw refused(problems.notFound(), action, null, "location_not_found");
}

async function lockedAudit(tx: Transaction, id: string, version: number, action: Action) {
  const [row] = await tx.select().from(auditRecord).where(eq(auditRecord.id, id)).for("update");
  if (!row) throw refused(problems.notFound(), action, id, "audit_not_found_or_out_of_scope");
  if (row.state === "completed") {
    throw refused(
      stateConflict("This audit is completed and does not change."),
      action,
      id,
      "audit_completed",
    );
  }
  if (row.version !== version) throw refused(problems.conflict(), action, id, "version_conflict");
  return row;
}

export const qualityAuditsRouter = createRouter()
  .openapi(
    createRoute({
      method: "get",
      path: "/v1/quality/audit-starters",
      tags: ["quality"],
      summary: "Harbour's starter audit templates",
      description:
        "quality.audit.manage. Global reference data: the starter templates (medication, care plans, IPC, environment, dignity, night visit, mock inspection) mapped to the framework, for the organisation to copy and make its own.",
      security,
      responses: { 200: jsonBody(AuditStarterList, "Starter templates"), ...errorResponses },
    }),
    async (c) => {
      await requirePermission(c, MANAGE);
      const rows = await withTenant(c, (tx) =>
        tx.select().from(auditStarterTemplate).orderBy(asc(auditStarterTemplate.key)),
      );
      const items = rows.map((r) => ({
        key: r.key,
        kind: r.kind as AuditKind,
        title: r.title,
        frameworkVersionId: r.frameworkVersionId,
        questions: questionsOf(r.questions),
        source: r.source,
      }));
      return c.json({ items }, 200);
    },
  )
  .openapi(
    createRoute({
      method: "get",
      path: "/v1/quality/audit-templates",
      tags: ["quality"],
      summary: "The organisation's audit templates",
      description: "quality.audit.manage. Active and retired, by key.",
      security,
      responses: { 200: jsonBody(AuditTemplateList, "Audit templates"), ...errorResponses },
    }),
    async (c) => {
      await requirePermission(c, MANAGE);
      const rows = await withTenant(c, (tx) =>
        tx.select().from(auditTemplate).orderBy(asc(auditTemplate.key)),
      );
      return c.json({ items: rows.map(templateItem) }, 200);
    },
  )
  .openapi(
    createRoute({
      method: "post",
      path: "/v1/quality/audit-templates",
      tags: ["quality"],
      summary: "Add an audit template, from a starter or your own",
      description:
        "quality.audit.manage. From a Harbour starter (`starterKey`; the other fields default to the starter's) or your own (kind, title, framework version and questions). The questions are checked against the framework version, which must be published (rule 8); the key is unique in the organisation. Audited.",
      security,
      request: { body: { content: { "application/json": { schema: CreateAuditTemplate } } } },
      responses: {
        201: jsonBody(AuditTemplateItem, "Added"),
        ...errorResponses,
        ...notFoundResponse,
        ...conflictResponse,
      },
    }),
    async (c) => {
      const access = await requirePermission(c, MANAGE);
      const body = c.req.valid("json");
      const created = await change(c, access, A.templateSaved, null, async (tx) => {
        let starter: typeof auditStarterTemplate.$inferSelect | undefined;
        if (body.starterKey) {
          [starter] = await tx
            .select()
            .from(auditStarterTemplate)
            .where(eq(auditStarterTemplate.key, body.starterKey));
          if (!starter)
            throw refused(problems.notFound(), A.templateSaved, null, "starter_not_found");
        }
        const kind = body.kind ?? (starter?.kind as AuditKind | undefined);
        const title = body.title ?? starter?.title;
        const frameworkVersionId = body.frameworkVersionId ?? starter?.frameworkVersionId;
        const questions = body.questions ?? (starter ? questionsOf(starter.questions) : undefined);
        if (!kind || !title || !frameworkVersionId || !questions) {
          throw refused(
            problems.invalid(
              "Give the kind, title, framework version and questions, or choose a starter template.",
            ),
            A.templateSaved,
            null,
            "template_incomplete",
          );
        }
        const template = { key: body.key, kind, title, frameworkVersionId, questions };
        await checkTemplate(tx, A.templateSaved, null, template);
        const [row] = await tx
          .insert(auditTemplate)
          .values({ ...template, starterKey: starter?.key ?? null })
          .returning();
        if (!row) throw new Error("audit template not stored");
        await audit(c, tx, access, {
          action: A.templateSaved,
          resourceType: "audit_template",
          resourceId: row.id,
          scope: {
            key: row.key,
            kind: row.kind,
            starterKey: row.starterKey,
            frameworkVersionId: row.frameworkVersionId,
            questions: questions.length,
            version: row.version,
          },
        });
        return templateItem(row);
      });
      return c.json(created, 201);
    },
  )
  .openapi(
    createRoute({
      method: "put",
      path: "/v1/quality/audit-templates/{id}",
      tags: ["quality"],
      summary: "Change an audit template",
      description:
        "quality.audit.manage, against the version read. Title, framework version and questions (rule 8); the key and kind stay. Audits already started keep the questions and framework version they started with. A retired template does not change. Audited.",
      security,
      request: {
        params: IdParam,
        body: { content: { "application/json": { schema: UpdateAuditTemplate } } },
      },
      responses: {
        200: jsonBody(AuditTemplateItem, "Changed"),
        ...errorResponses,
        ...notFoundResponse,
        ...conflictResponse,
      },
    }),
    async (c) => {
      const access = await requirePermission(c, MANAGE);
      const { id } = c.req.valid("param");
      const body = c.req.valid("json");
      const saved = await change(c, access, A.templateSaved, id, async (tx) => {
        const [current] = await tx
          .select()
          .from(auditTemplate)
          .where(eq(auditTemplate.id, id))
          .for("update");
        if (!current) throw refused(problems.notFound(), A.templateSaved, id, "template_not_found");
        if (current.state === "retired") {
          throw refused(
            stateConflict("This template is retired and does not change."),
            A.templateSaved,
            id,
            "template_retired",
          );
        }
        if (current.version !== body.version) {
          throw refused(problems.conflict(), A.templateSaved, id, "version_conflict");
        }
        await checkTemplate(tx, A.templateSaved, id, {
          key: current.key,
          kind: current.kind as AuditKind,
          title: body.title,
          frameworkVersionId: body.frameworkVersionId,
          questions: body.questions,
        });
        const [row] = await tx
          .update(auditTemplate)
          .set({
            title: body.title,
            frameworkVersionId: body.frameworkVersionId,
            questions: body.questions,
          })
          .where(and(eq(auditTemplate.id, id), eq(auditTemplate.version, body.version)))
          .returning();
        if (!row) throw refused(problems.conflict(), A.templateSaved, id, "version_conflict");
        await audit(c, tx, access, {
          action: A.templateSaved,
          resourceType: "audit_template",
          resourceId: id,
          scope: {
            frameworkVersionId: row.frameworkVersionId,
            questions: body.questions.length,
            version: row.version,
          },
        });
        return templateItem(row);
      });
      return c.json(saved, 200);
    },
  )
  .openapi(
    createRoute({
      method: "post",
      path: "/v1/quality/audit-templates/{id}/retire",
      tags: ["quality"],
      summary: "Retire an audit template",
      description:
        "quality.audit.manage, against the version read. No new audits start from it; its audits and schedules stay readable. Retiring is final. Audited.",
      security,
      request: {
        params: IdParam,
        body: { content: { "application/json": { schema: RetireAuditTemplate } } },
      },
      responses: {
        200: jsonBody(AuditTemplateItem, "Retired"),
        ...errorResponses,
        ...notFoundResponse,
        ...conflictResponse,
      },
    }),
    async (c) => {
      const access = await requirePermission(c, MANAGE);
      const { id } = c.req.valid("param");
      const { version } = c.req.valid("json");
      const retired = await change(c, access, A.templateRetired, id, async (tx) => {
        const [current] = await tx.select().from(auditTemplate).where(eq(auditTemplate.id, id));
        if (!current)
          throw refused(problems.notFound(), A.templateRetired, id, "template_not_found");
        if (current.state === "retired") {
          throw refused(
            stateConflict("This template is already retired."),
            A.templateRetired,
            id,
            "template_retired",
          );
        }
        const [row] = await tx
          .update(auditTemplate)
          .set({ state: "retired" })
          .where(and(eq(auditTemplate.id, id), eq(auditTemplate.version, version)))
          .returning();
        if (!row) throw refused(problems.conflict(), A.templateRetired, id, "version_conflict");
        await audit(c, tx, access, {
          action: A.templateRetired,
          resourceType: "audit_template",
          resourceId: id,
          scope: { version: row.version },
        });
        return templateItem(row);
      });
      return c.json(retired, 200);
    },
  )
  .openapi(
    createRoute({
      method: "get",
      path: "/v1/quality/audit-schedules",
      tags: ["quality"],
      summary: "Audit schedules, with when each is next due",
      description:
        "quality.audit.manage, at the locations where you hold it. Each schedule with its last completed audit, when the next is due (the schedule's own frequency in calendar months after the last, or the first due date) and whether it is overdue on today's UK date (rule 13).",
      security,
      request: { query: z.object({ locationId: z.uuid().optional() }) },
      responses: { 200: jsonBody(AuditScheduleList, "Schedules"), ...errorResponses },
    }),
    async (c) => {
      await requirePermission(c, MANAGE);
      const { locationId } = c.req.valid("query");
      const today = ukIsoDate(new Date());
      const items = await withTenant(c, async (tx) => {
        const rows = await tx
          .select({ schedule: auditSchedule, template: auditTemplate })
          .from(auditSchedule)
          .innerJoin(auditTemplate, eq(auditTemplate.id, auditSchedule.templateId))
          .where(locationId ? eq(auditSchedule.locationId, locationId) : undefined)
          .orderBy(asc(auditTemplate.key));
        return Promise.all(
          rows.map(async ({ schedule, template }) => {
            const last = await lastCompletedOn(tx, schedule.templateId, schedule.locationId);
            const due = last
              ? nextAuditDue(last, schedule.frequencyMonths, today)
              : { dueOn: schedule.firstDueOn, overdue: today > schedule.firstDueOn };
            return {
              id: schedule.id,
              templateId: schedule.templateId,
              templateTitle: template.title,
              kind: template.kind as AuditKind,
              locationId: schedule.locationId,
              frequencyMonths: schedule.frequencyMonths,
              firstDueOn: schedule.firstDueOn,
              lastCompletedOn: last,
              nextDueOn: due.dueOn,
              overdue: due.overdue,
              version: schedule.version,
            };
          }),
        );
      });
      return c.json({ items }, 200);
    },
  )
  .openapi(
    createRoute({
      method: "post",
      path: "/v1/quality/audit-schedules",
      tags: ["quality"],
      summary: "Schedule an audit template at a location",
      description:
        "quality.audit.manage at the location. One schedule per template and location, every 1 to 60 months from the first due date. Audited.",
      security,
      request: { body: { content: { "application/json": { schema: CreateAuditSchedule } } } },
      responses: {
        201: jsonBody(AuditScheduleItem, "Scheduled"),
        ...errorResponses,
        ...notFoundResponse,
        ...conflictResponse,
      },
    }),
    async (c) => {
      const access = await requirePermission(c, MANAGE);
      const body = c.req.valid("json");
      const today = ukIsoDate(new Date());
      const created = await change(c, access, A.scheduled, null, async (tx) => {
        const [template] = await tx
          .select()
          .from(auditTemplate)
          .where(eq(auditTemplate.id, body.templateId));
        if (!template) throw refused(problems.notFound(), A.scheduled, null, "template_not_found");
        if (template.state !== "active") {
          throw refused(
            stateConflict("Schedule only an active template."),
            A.scheduled,
            null,
            "template_retired",
          );
        }
        await visibleLocation(tx, body.locationId, A.scheduled);
        const [row] = await tx.insert(auditSchedule).values(body).returning();
        if (!row) throw new Error("audit schedule not stored");
        await audit(c, tx, access, {
          action: A.scheduled,
          resourceType: "audit_schedule",
          resourceId: row.id,
          scope: {
            templateId: row.templateId,
            locationId: row.locationId,
            frequencyMonths: row.frequencyMonths,
            firstDueOn: row.firstDueOn,
          },
        });
        return {
          id: row.id,
          templateId: row.templateId,
          templateTitle: template.title,
          kind: template.kind as AuditKind,
          locationId: row.locationId,
          frequencyMonths: row.frequencyMonths,
          firstDueOn: row.firstDueOn,
          lastCompletedOn: null,
          nextDueOn: row.firstDueOn,
          overdue: today > row.firstDueOn,
          version: row.version,
        };
      });
      return c.json(created, 201);
    },
  )
  .openapi(
    createRoute({
      method: "get",
      path: "/v1/quality/audits",
      tags: ["quality"],
      summary: "Audits and mock inspections",
      description:
        "quality.audit.manage, at the locations where you hold it. Newest first, at most 500, by location, kind or state.",
      security,
      request: {
        query: z.object({
          locationId: z.uuid().optional(),
          kind: z
            .string()
            .regex(/^[a-z_]{1,32}$/)
            .optional(),
          state: z.enum(["in_progress", "completed"]).optional(),
        }),
      },
      responses: { 200: jsonBody(AuditRecordList, "Audits"), ...errorResponses },
    }),
    async (c) => {
      await requirePermission(c, MANAGE);
      const q = c.req.valid("query");
      const rows = await withTenant(c, (tx) =>
        tx
          .select()
          .from(auditRecord)
          .where(
            and(
              q.locationId ? eq(auditRecord.locationId, q.locationId) : undefined,
              q.kind ? eq(auditRecord.kind, q.kind) : undefined,
              q.state ? eq(auditRecord.state, q.state) : undefined,
            ),
          )
          .orderBy(desc(auditRecord.auditedOn), desc(auditRecord.createdAt))
          .limit(500),
      );
      return c.json({ items: rows.map(recordSummary) }, 200);
    },
  )
  .openapi(
    createRoute({
      method: "get",
      path: "/v1/quality/audits/{id}",
      tags: ["quality"],
      summary: "An audit with its score, method, findings and actions",
      description:
        "quality.audit.manage at the audit's location. Scored against the questions and framework version it started with, whatever the template now says (rule 4); the method in words beside the score; the answers that fell short by quality statement (rule 14); whether its framework version is still the one in force.",
      security,
      request: { params: IdParam },
      responses: {
        200: jsonBody(AuditRecordDetail, "The audit"),
        ...errorResponses,
        ...notFoundResponse,
      },
    }),
    async (c) => {
      await requirePermission(c, MANAGE);
      const { id } = c.req.valid("param");
      const detail = await withTenant(c, async (tx) => {
        const [row] = await tx.select().from(auditRecord).where(eq(auditRecord.id, id));
        if (!row) throw problems.notFound();
        const actions = await tx
          .select()
          .from(auditAction)
          .where(eq(auditAction.auditId, id))
          .orderBy(asc(auditAction.createdAt));
        const live = await frameworksInForce(tx, new Date());
        return recordDetail(row, actions, live.has(row.frameworkVersionId));
      });
      return c.json(detail, 200);
    },
  )
  .openapi(
    createRoute({
      method: "post",
      path: "/v1/quality/audits",
      tags: ["quality"],
      summary: "Start an audit or mock inspection",
      description:
        "quality.audit.manage at the location. Starts from an active template, copying its questions, version and framework version, which the audit keeps (rule 4). A mock inspection starts only when its template is mapped to the framework version in force (409 otherwise). The audit date is today or earlier. Audited.",
      security,
      request: { body: { content: { "application/json": { schema: StartAudit } } } },
      responses: {
        201: jsonBody(AuditRecordDetail, "Started"),
        ...errorResponses,
        ...notFoundResponse,
        ...conflictResponse,
      },
    }),
    async (c) => {
      const access = await requirePermission(c, MANAGE);
      const body = c.req.valid("json");
      const now = new Date();
      const started = await change(c, access, A.started, null, async (tx) => {
        if (body.auditedOn > ukIsoDate(now)) {
          throw refused(
            problems.invalid("An audit cannot be dated in the future."),
            A.started,
            null,
            "audited_on_future",
          );
        }
        const [template] = await tx
          .select()
          .from(auditTemplate)
          .where(eq(auditTemplate.id, body.templateId));
        if (!template) throw refused(problems.notFound(), A.started, null, "template_not_found");
        if (template.state !== "active") {
          throw refused(
            stateConflict("Start an audit only from an active template."),
            A.started,
            null,
            "template_retired",
          );
        }
        const live = await frameworksInForce(tx, now);
        if (template.kind === "mock_inspection" && !live.has(template.frameworkVersionId)) {
          throw refused(
            stateConflict(
              "A mock inspection uses the framework version in force. Move the template to it first.",
            ),
            A.started,
            null,
            "framework_not_in_force",
          );
        }
        await visibleLocation(tx, body.locationId, A.started);
        const [row] = await tx
          .insert(auditRecord)
          .values({
            templateId: template.id,
            templateVersion: template.version,
            kind: template.kind,
            title: template.title,
            questions: template.questions,
            frameworkVersionId: template.frameworkVersionId,
            locationId: body.locationId,
            auditedOn: body.auditedOn,
            startedBy: access.tenantUserId,
          })
          .returning();
        if (!row) throw new Error("audit not stored");
        await audit(c, tx, access, {
          action: A.started,
          resourceType: "audit_record",
          resourceId: row.id,
          scope: {
            templateId: row.templateId,
            templateVersion: row.templateVersion,
            kind: row.kind,
            frameworkVersionId: row.frameworkVersionId,
            locationId: row.locationId,
            auditedOn: row.auditedOn,
          },
        });
        return recordDetail(row, [], live.has(row.frameworkVersionId));
      });
      return c.json(started, 201);
    },
  )
  .openapi(
    createRoute({
      method: "put",
      path: "/v1/quality/audits/{id}/answers",
      tags: ["quality"],
      summary: "Save answers to an audit in progress",
      description:
        "quality.audit.manage at the audit's location, against the version read. Answers (yes, partial, no, not applicable, or null to clear) are merged into those saved, for the audit's own questions only. Audited.",
      security,
      request: {
        params: IdParam,
        body: { content: { "application/json": { schema: SaveAuditAnswers } } },
      },
      responses: {
        200: jsonBody(AuditRecordDetail, "Saved"),
        ...errorResponses,
        ...notFoundResponse,
        ...conflictResponse,
      },
    }),
    async (c) => {
      const access = await requirePermission(c, MANAGE);
      const { id } = c.req.valid("param");
      const body = c.req.valid("json");
      const saved = await change(c, access, A.answered, id, async (tx) => {
        const current = await lockedAudit(tx, id, body.version, A.answered);
        const keys = new Set(questionsOf(current.questions).map((q) => q.key));
        const unknown = Object.keys(body.answers).filter((k) => !keys.has(k));
        if (unknown.length > 0) {
          throw refused(
            problems.invalid("Answer only this audit's own questions."),
            A.answered,
            id,
            "unknown_question",
          );
        }
        const answers = { ...answersOf(current.answers), ...body.answers };
        const [row] = await tx
          .update(auditRecord)
          .set({ answers })
          .where(and(eq(auditRecord.id, id), eq(auditRecord.version, body.version)))
          .returning();
        if (!row) throw refused(problems.conflict(), A.answered, id, "version_conflict");
        const score = scoreAudit(scoredTemplate(row), answers);
        await audit(c, tx, access, {
          action: A.answered,
          resourceType: "audit_record",
          resourceId: id,
          scope: {
            answered: Object.keys(body.answers).length,
            unanswered: score.unanswered.length,
            version: row.version,
          },
        });
        const live = await frameworksInForce(tx, new Date());
        return recordDetail(row, [], live.has(row.frameworkVersionId));
      });
      return c.json(saved, 200);
    },
  )
  .openapi(
    createRoute({
      method: "post",
      path: "/v1/quality/audits/{id}/complete",
      tags: ["quality"],
      summary: "Complete an audit with the self-rating and actions",
      description:
        "quality.audit.manage at the audit's location, against the version read. Every question answered or not applicable; an action with a description, an owner in the organisation and a due date on or after the audit for each answer that fell short where the question needs one (a missing due date takes the organisation's `quality.audit.action_due_days` after the audit); a self-rating on the rate table's CQC scale, given by a person and never worked out from the score (rules 10 to 12). The score is stored with its points; each action raises a task for its owner. The audit never changes afterwards. Audited.",
      security,
      request: {
        params: IdParam,
        body: { content: { "application/json": { schema: CompleteAudit } } },
      },
      responses: {
        200: jsonBody(AuditRecordDetail, "Completed"),
        ...errorResponses,
        ...notFoundResponse,
        ...conflictResponse,
      },
    }),
    async (c) => {
      const access = await requirePermission(c, MANAGE);
      const { id } = c.req.valid("param");
      const body = c.req.valid("json");
      const now = new Date();
      const completed = await change(c, access, A.completed, id, async (tx) => {
        const current = await lockedAudit(tx, id, body.version, A.completed);
        const tenantId = access.tenantId;
        const [ratingScaleMin, ratingScaleMax, auditActionDueDays] = await Promise.all(
          ["cqc.rating_scale.min", "cqc.rating_scale.max", "quality.audit.action_due_days"].map(
            (key) => rateNumber(tx, tenantId, key, "england", ukIsoDate(now)),
          ),
        );
        const rates = {
          ratingScaleMin: ratingScaleMin as number,
          ratingScaleMax: ratingScaleMax as number,
          auditActionDueDays: auditActionDueDays as number,
        };
        const answers = answersOf(current.answers);
        const actions = body.actions.map((a) => ({
          questionKey: a.questionKey,
          description: a.description,
          ownerId: a.ownerId,
          dueOn: a.dueOn ?? defaultActionDueOn(current.auditedOn, rates),
        }));
        const template = scoredTemplate(current);
        const found = checkAuditCompletion(
          template,
          {
            templateKey: current.templateId,
            frameworkVersionId: current.frameworkVersionId,
            auditedOn: current.auditedOn,
            answers,
            selfRating: body.selfRating,
            actions,
          },
          rates,
          [...usablePermissions(access, now)],
        );
        if (found.length > 0) {
          throw refused(
            problems.invalid(found.map((p) => AUDIT_COMPLETION_MESSAGES[p]).join(" ")),
            A.completed,
            id,
            found.join(","),
          );
        }
        const keys = new Set(template.questions.map((q) => q.key));
        if (actions.some((a) => !keys.has(a.questionKey))) {
          throw refused(
            problems.invalid("Raise actions only on this audit's own questions."),
            A.completed,
            id,
            "unknown_question",
          );
        }
        const owners = [...new Set(actions.map((a) => a.ownerId))];
        if (owners.length > 0) {
          const known = await tx
            .select({ id: tenantUser.id })
            .from(tenantUser)
            .where(inArray(tenantUser.id, owners));
          if (known.length !== owners.length) {
            throw refused(
              problems.invalid("Choose each action's owner from your organisation."),
              A.completed,
              id,
              "owner_not_found",
            );
          }
        }
        const score = scoreAudit(template, answers);
        const [row] = await tx
          .update(auditRecord)
          .set({
            state: "completed",
            selfRating: body.selfRating,
            scorePercent: score.percent === null ? null : score.percent.toFixed(3),
            achieved: score.achieved.toFixed(2),
            possible: score.possible,
          })
          .where(and(eq(auditRecord.id, id), eq(auditRecord.version, body.version)))
          .returning();
        if (!row) throw refused(problems.conflict(), A.completed, id, "version_conflict");
        const stored = [];
        for (const action of actions) {
          const day = ukDayBounds(action.dueOn);
          const [raised] = await tx
            .insert(task)
            .values({
              kind: TASK_KIND,
              title: "Complete an audit action",
              requiredPermission: MANAGE,
              locationId: row.locationId,
              sourceType: "audit_record",
              sourceId: row.id,
              assigneeTenantUserId: action.ownerId,
              dueAt: day.startsAt,
              windowStart: day.startsAt,
              windowEnd: day.endsAt,
            })
            .returning({ id: task.id });
          const [item] = await tx
            .insert(auditAction)
            .values({ auditId: row.id, ...action, taskId: raised?.id ?? null })
            .returning();
          if (item) stored.push(item);
        }
        await audit(c, tx, access, {
          action: A.completed,
          resourceType: "audit_record",
          resourceId: id,
          scope: {
            kind: row.kind,
            frameworkVersionId: row.frameworkVersionId,
            scorePercent: score.percent,
            achieved: score.achieved,
            possible: score.possible,
            selfRating: body.selfRating,
            actions: stored.map((a) => a.id),
          },
        });
        const live = await frameworksInForce(tx, now);
        return recordDetail(row, stored, live.has(row.frameworkVersionId));
      });
      return c.json(completed, 200);
    },
  );
