import {
  NotificationClock,
  NotRequiredNotification,
  PrepareNotification,
  StatutoryNotificationDetail,
  StatutoryNotificationKind,
  StatutoryNotificationList,
  StatutoryNotificationStatus,
  SubmitNotification,
} from "@harbour/contracts";
import { statutoryNotification, type Transaction } from "@harbour/db";
import {
  type NotificationStatus,
  STATUTORY_NOTIFICATION_WORKFLOW,
  submissionEvidenceProblems,
} from "@harbour/domain";
import { createRoute, z } from "@hono/zod-openapi";
import { and, asc, eq, isNull } from "drizzle-orm";
import type { Context } from "hono";
import { auditInTx } from "../http/audit";
import { type AppEnv, requirePermission, type TenantAccess, withTenant } from "../http/context";
import { problems } from "../http/problem";
import { publish } from "../outbox";
import { acknowledgeOverdueAlerts } from "../services/safety";
import {
  conflictResponse,
  createRouter,
  errorResponses,
  jsonBody,
  notFoundResponse,
  security,
} from "./openapi";
import { notificationDetail, notificationSummary } from "./safety-shared";
import { moveOrRefuse } from "./workflow-shared";

/**
 * Statutory notifications (docs/specs/safety.md sections 3 to 5; SAFE-002 to SAFE-005; HZ-013):
 * the drafts the classifier and the DoLS register create, with their clocks. Harbour prepares and
 * records; the manager submits on the regulator's own portal and records the reference. Submitting
 * and deciding "not required" need `safety.notification.submit` with step-up, and stop the overdue
 * escalation. Reads and writes are audited by record id; "not required" with its reason.
 */

const NotificationParam = z.object({ id: z.uuid() });
type NotificationRow = typeof statutoryNotification.$inferSelect;

function audit(
  c: Context<AppEnv>,
  tx: Transaction,
  access: TenantAccess,
  input: Parameters<typeof auditInTx>[2],
) {
  return auditInTx(tx, access, { ...input, requestId: c.get("requestId") });
}

async function load(tx: Transaction, id: string, version?: number): Promise<NotificationRow> {
  const [row] = await tx
    .select()
    .from(statutoryNotification)
    .where(and(eq(statutoryNotification.id, id), isNull(statutoryNotification.deletedAt)));
  if (!row) throw problems.notFound();
  if (version !== undefined && row.version !== version) throw problems.conflict();
  return row;
}

const subject = (n: NotificationRow) => ({
  subjectType: "statutory_notification",
  subjectId: n.id,
  personId: n.personId,
});

export const statutoryNotificationsRouter = createRouter()
  .openapi(
    createRoute({
      method: "get",
      path: "/v1/notifications/statutory",
      tags: ["safety"],
      summary: "Statutory notifications in your scope with their clocks, soonest due first",
      description:
        "Without-delay kinds are due when the incident happened and show as overdue until submitted or marked not required (safety.md rule 10).",
      security,
      request: {
        query: z.object({
          status: StatutoryNotificationStatus.optional(),
          clock: NotificationClock.optional(),
          kind: StatutoryNotificationKind.optional(),
          locationId: z.uuid().optional(),
          incidentId: z.uuid().optional(),
          personId: z.uuid().optional(),
        }),
      },
      responses: { 200: jsonBody(StatutoryNotificationList, "Notifications"), ...errorResponses },
    }),
    async (c) => {
      const access = await requirePermission(c, "safety.incident.manage");
      const q = c.req.valid("query");
      const now = new Date();
      const items = await withTenant(c, async (tx) => {
        const rows = await tx
          .select()
          .from(statutoryNotification)
          .where(
            and(
              isNull(statutoryNotification.deletedAt),
              q.status ? eq(statutoryNotification.status, q.status) : undefined,
              q.kind ? eq(statutoryNotification.kind, q.kind) : undefined,
              q.locationId ? eq(statutoryNotification.locationId, q.locationId) : undefined,
              q.incidentId ? eq(statutoryNotification.incidentId, q.incidentId) : undefined,
              q.personId ? eq(statutoryNotification.personId, q.personId) : undefined,
            ),
          )
          .orderBy(asc(statutoryNotification.dueAt))
          .limit(1000);
        const summaries = rows
          .map((r) => notificationSummary(r, now))
          .filter((s) => !q.clock || s.clock === q.clock);
        await audit(c, tx, access, {
          action: "safety.notification.list",
          scope: { count: summaries.length },
        });
        return summaries;
      });
      return c.json({ items }, 200);
    },
  )
  .openapi(
    createRoute({
      method: "get",
      path: "/v1/notifications/statutory/{id}",
      tags: ["safety"],
      summary: "One notification: its deadlines, reasons, required content and sources",
      security,
      request: { params: NotificationParam },
      responses: {
        200: jsonBody(StatutoryNotificationDetail, "Notification"),
        ...errorResponses,
        ...notFoundResponse,
      },
    }),
    async (c) => {
      const access = await requirePermission(c, "safety.incident.manage");
      const { id } = c.req.valid("param");
      const detail = await withTenant(c, async (tx) => {
        const row = await load(tx, id);
        await audit(c, tx, access, {
          action: "safety.notification.view",
          resourceType: "statutory_notification",
          resourceId: id,
        });
        return notificationDetail(row, new Date());
      });
      return c.json(detail, 200);
    },
  )
  .openapi(
    createRoute({
      method: "post",
      path: "/v1/notifications/statutory/{id}/prepare",
      tags: ["safety"],
      summary: "Prepare a draft: fill in the regulator's form and mark it ready (or back to draft)",
      security,
      request: {
        params: NotificationParam,
        body: { content: { "application/json": { schema: PrepareNotification } } },
      },
      responses: {
        200: jsonBody(StatutoryNotificationDetail, "Prepared"),
        ...errorResponses,
        ...notFoundResponse,
        ...conflictResponse,
      },
    }),
    async (c) => {
      const access = await requirePermission(c, "safety.incident.manage");
      const { id } = c.req.valid("param");
      const body = c.req.valid("json");
      const now = new Date();
      const detail = await withTenant(c, async (tx) => {
        const row = await load(tx, id, body.version);
        if (row.status !== "draft" && row.status !== "ready") {
          throw problems.invalid("A submitted or not-required notification cannot be changed.");
        }
        const to: NotificationStatus = body.ready ? "ready" : "draft";
        if (to !== row.status) {
          await moveOrRefuse(c, tx, STATUTORY_NOTIFICATION_WORKFLOW, subject(row), to, null, now);
        }
        const [saved] = await tx
          .update(statutoryNotification)
          .set({ content: body.content, status: to })
          .where(
            and(eq(statutoryNotification.id, id), eq(statutoryNotification.version, body.version)),
          )
          .returning();
        if (!saved) throw problems.conflict();
        await audit(c, tx, access, {
          action: "safety.notification.prepare",
          resourceType: "statutory_notification",
          resourceId: id,
          scope: { status: to },
        });
        return notificationDetail(saved, now);
      });
      return c.json(detail, 200);
    },
  )
  .openapi(
    createRoute({
      method: "post",
      path: "/v1/notifications/statutory/{id}/submit",
      tags: ["safety"],
      summary: "Record that a ready notification was submitted (step-up)",
      description:
        "Needs safety.notification.submit and a fresh sign-in, the submission time and the regulator's reference or the submitted form (submissionEvidenceProblems). Stops the overdue escalation and publishes safety.notification.submitted.",
      security,
      request: {
        params: NotificationParam,
        body: { content: { "application/json": { schema: SubmitNotification } } },
      },
      responses: {
        200: jsonBody(StatutoryNotificationDetail, "Submitted"),
        ...errorResponses,
        ...notFoundResponse,
        ...conflictResponse,
      },
    }),
    async (c) => {
      const access = await requirePermission(c, "safety.notification.submit");
      const { id } = c.req.valid("param");
      const body = c.req.valid("json");
      const now = new Date();
      const detail = await withTenant(c, async (tx) => {
        const row = await load(tx, id, body.version);
        const evidence = {
          submittedAt: new Date(body.submittedAt),
          externalReference: body.externalReference ?? null,
          evidenceDocumentId: body.evidenceDocumentId ?? null,
        };
        const missing = submissionEvidenceProblems(evidence, now);
        if (missing.length > 0) throw problems.invalid(missing.join(" "));
        await moveOrRefuse(
          c,
          tx,
          STATUTORY_NOTIFICATION_WORKFLOW,
          subject(row),
          "submitted",
          null,
          now,
        );
        const [saved] = await tx
          .update(statutoryNotification)
          .set({
            status: "submitted",
            submittedBy: access.tenantUserId,
            submittedAt: evidence.submittedAt,
            externalReference: evidence.externalReference,
            evidenceDocumentId: evidence.evidenceDocumentId,
          })
          .where(
            and(eq(statutoryNotification.id, id), eq(statutoryNotification.version, body.version)),
          )
          .returning()
          .catch((error: unknown) => {
            const code =
              (error as { code?: string }).code ??
              (error as { cause?: { code?: string } }).cause?.code;
            if (code === "23503") throw problems.invalid("The evidence document was not found.");
            throw error;
          });
        if (!saved) throw problems.conflict();
        await acknowledgeOverdueAlerts(tx, id, now);
        await publish(tx, {
          context: "safety",
          aggregateType: "statutory_notification",
          aggregateId: id,
          type: "safety.notification.submitted",
          payload: {
            notificationId: id,
            kind: saved.kind,
            incidentId: saved.incidentId,
            late: evidence.submittedAt.getTime() > saved.dueAt.getTime(),
          },
        });
        await audit(c, tx, access, {
          action: "safety.notification.submit",
          resourceType: "statutory_notification",
          resourceId: id,
        });
        return notificationDetail(saved, now);
      });
      return c.json(detail, 200);
    },
  )
  .openapi(
    createRoute({
      method: "post",
      path: "/v1/notifications/statutory/{id}/not-required",
      tags: ["safety"],
      summary: "Decide a notification is not required, with the reason (step-up)",
      description:
        "Needs safety.notification.submit and a fresh sign-in; the reason is kept on the notification and in the audit trail (safety.md section 3). Stops the overdue escalation.",
      security,
      request: {
        params: NotificationParam,
        body: { content: { "application/json": { schema: NotRequiredNotification } } },
      },
      responses: {
        200: jsonBody(StatutoryNotificationDetail, "Marked not required"),
        ...errorResponses,
        ...notFoundResponse,
        ...conflictResponse,
      },
    }),
    async (c) => {
      const access = await requirePermission(c, "safety.notification.submit");
      const { id } = c.req.valid("param");
      const body = c.req.valid("json");
      const now = new Date();
      const detail = await withTenant(c, async (tx) => {
        const row = await load(tx, id, body.version);
        await moveOrRefuse(
          c,
          tx,
          STATUTORY_NOTIFICATION_WORKFLOW,
          subject(row),
          "not_required",
          body.reason,
          now,
        );
        const [saved] = await tx
          .update(statutoryNotification)
          .set({ status: "not_required", notRequiredReason: body.reason })
          .where(
            and(eq(statutoryNotification.id, id), eq(statutoryNotification.version, body.version)),
          )
          .returning();
        if (!saved) throw problems.conflict();
        await acknowledgeOverdueAlerts(tx, id, now);
        await audit(c, tx, access, {
          action: "safety.notification.not_required",
          resourceType: "statutory_notification",
          resourceId: id,
          reason: body.reason,
        });
        return notificationDetail(saved, now);
      });
      return c.json(detail, 200);
    },
  );
