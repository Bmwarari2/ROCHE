import {
  AuditList,
  FormTemplateSummary,
  Health,
  NotificationList,
  RateValue,
} from "@harbour/contracts";
import { auditEvent, formTemplate, notification, person, rateTable } from "@harbour/db";
import { resolveRate, scopeFor } from "@harbour/domain";
import { createRoute, z } from "@hono/zod-openapi";
import { and, desc, eq, inArray, isNull, or, sql } from "drizzle-orm";
import { auditInTx } from "../http/audit";
import { requirePermission, withTenant } from "../http/context";
import { problems } from "../http/problem";
import { createRouter, errorResponses, jsonBody, notFoundResponse, security } from "./openapi";

export const healthRouter = createRouter().openapi(
  createRoute({
    method: "get",
    path: "/health",
    tags: ["platform"],
    summary: "Liveness and database reachability (no personal data)",
    responses: { 200: jsonBody(Health, "Healthy"), 503: jsonBody(Health, "Degraded") },
  }),
  async (c) => {
    const { appPool, config } = c.get("services");
    const database = await appPool
      .query("SELECT 1")
      .then(() => "ok" as const)
      .catch(() => "unavailable" as const);
    const body = {
      status: database === "ok" ? ("ok" as const) : ("degraded" as const),
      version: config.APP_VERSION,
      database,
    };
    return c.json(body, database === "ok" ? 200 : 503);
  },
);

const NotificationId = z.object({ id: z.uuid() });

export const notificationsRouter = createRouter()
  .openapi(
    createRoute({
      method: "get",
      path: "/v1/notifications",
      tags: ["platform"],
      summary: "Your notifications, newest first",
      security,
      responses: { 200: jsonBody(NotificationList, "Notifications"), ...errorResponses },
    }),
    async (c) => {
      const access = c.get("access");
      const rows = await withTenant(c, (tx) =>
        tx
          .select()
          .from(notification)
          .where(eq(notification.recipientTenantUserId, access.tenantUserId))
          .orderBy(desc(notification.createdAt))
          .limit(100),
      );
      return c.json(
        {
          items: rows.map((n) => ({
            id: n.id,
            kind: n.kind,
            severity: n.severity,
            title: n.title,
            body: n.body,
            link: n.link,
            createdAt: n.createdAt.toISOString(),
            readAt: n.readAt?.toISOString() ?? null,
            acknowledgedAt: n.acknowledgedAt?.toISOString() ?? null,
          })),
          unread: rows.filter((n) => n.readAt === null).length,
        },
        200,
      );
    },
  )
  .openapi(
    createRoute({
      method: "post",
      path: "/v1/notifications/{id}/read",
      tags: ["platform"],
      summary: "Mark a notification as read",
      security,
      request: { params: NotificationId },
      responses: { 204: { description: "Marked" }, ...errorResponses, ...notFoundResponse },
    }),
    async (c) => {
      const access = c.get("access");
      const { id } = c.req.valid("param");
      const updated = await withTenant(c, (tx) =>
        tx
          .update(notification)
          .set({ readAt: sql`COALESCE(read_at, now())` })
          .where(
            and(
              eq(notification.id, id),
              eq(notification.recipientTenantUserId, access.tenantUserId),
            ),
          )
          .returning({ id: notification.id }),
      );
      if (updated.length === 0) throw problems.notFound();
      return c.body(null, 204);
    },
  )
  .openapi(
    createRoute({
      method: "post",
      path: "/v1/notifications/{id}/acknowledge",
      tags: ["platform"],
      summary: "Acknowledge a notification, which stops its escalation chain",
      security,
      request: { params: NotificationId },
      responses: { 204: { description: "Acknowledged" }, ...errorResponses, ...notFoundResponse },
    }),
    async (c) => {
      const access = c.get("access");
      const { id } = c.req.valid("param");
      const updated = await withTenant(c, async (tx) => {
        const rows = await tx
          .update(notification)
          .set({
            acknowledgedAt: sql`COALESCE(acknowledged_at, now())`,
            readAt: sql`COALESCE(read_at, now())`,
            escalateAt: null,
          })
          .where(
            and(
              eq(notification.id, id),
              eq(notification.recipientTenantUserId, access.tenantUserId),
            ),
          )
          .returning({ id: notification.id });
        if (rows.length > 0) {
          await auditInTx(tx, access, {
            action: "platform.notification.acknowledge",
            resourceType: "notification",
            resourceId: id,
            requestId: c.get("requestId"),
          });
        }
        return rows;
      });
      if (updated.length === 0) throw problems.notFound();
      return c.body(null, 204);
    },
  );

export const auditRouter = createRouter().openapi(
  createRoute({
    method: "get",
    path: "/v1/audit",
    tags: ["platform"],
    summary: "Audit trail for the organisation, with hash-chain verification",
    description:
      "Whoever holds platform.audit.read across the organisation sees every event, with its reason. Someone who holds it at some locations only sees their own events and events about the people at those locations (resource type person), never a reason; every other event is withheld until audit events carry their location.",
    security,
    request: {
      query: z.object({
        resourceType: z.string().optional(),
        resourceId: z.string().optional(),
        limit: z.coerce.number().int().min(1).max(500).default(100),
      }),
    },
    responses: { 200: jsonBody(AuditList, "Audit entries"), ...errorResponses },
  }),
  async (c) => {
    const access = await requirePermission(c, "platform.audit.read");
    const query = c.req.valid("query");
    // The trail is the organisation's: only someone holding the permission across it reads it
    // whole. Held at some locations only, it fails closed (ADR-0071 review round 1, S-M3): the
    // member's own events, and events about a person the permission's scope reaches (the person
    // table is read under that scope); no other event says where it happened yet.
    const organisationWide = scopeFor(access.effective, "platform.audit.read").scope === "tenant";
    const result = await withTenant(c, async (tx) => {
      const rows = await tx
        .select()
        .from(auditEvent)
        .where(
          and(
            query.resourceType ? eq(auditEvent.resourceType, query.resourceType) : undefined,
            query.resourceId ? eq(auditEvent.resourceId, query.resourceId) : undefined,
            organisationWide
              ? undefined
              : or(
                  eq(auditEvent.actorTenantUserId, access.tenantUserId),
                  and(
                    eq(auditEvent.resourceType, "person"),
                    inArray(
                      auditEvent.resourceId,
                      tx.select({ id: sql<string>`${person.id}::text` }).from(person),
                    ),
                  ),
                ),
          ),
        )
        .orderBy(desc(auditEvent.chainPosition))
        .limit(query.limit);
      const verified = await tx.execute<{ broken: string | null }>(
        sql`SELECT app.verify_audit_chain()::text AS broken`,
      );
      await auditInTx(tx, access, { action: "platform.audit.read", requestId: c.get("requestId") });
      return { rows, intact: verified.rows[0]?.broken === null };
    });
    return c.json(
      {
        items: result.rows.map((e) => ({
          id: e.id,
          occurredAt: e.occurredAt.toISOString(),
          action: e.action,
          outcome: e.outcome,
          actorTenantUserId: e.actorTenantUserId,
          resourceType: e.resourceType,
          resourceId: e.resourceId,
          // A reason (a break-glass justification, a refusal's words) only for the organisation's
          // view (S-M3).
          reason: organisationWide ? e.reason : null,
          chainPosition: e.chainPosition,
        })),
        chainIntact: result.intact,
      },
      200,
    );
  },
);

export const formsRouter = createRouter().openapi(
  createRoute({
    method: "get",
    path: "/v1/forms/templates",
    tags: ["platform"],
    summary: "Form and assessment templates available to the organisation",
    security,
    responses: {
      200: jsonBody(z.object({ items: z.array(FormTemplateSummary) }), "Templates"),
      ...errorResponses,
    },
  }),
  async (c) => {
    const rows = await withTenant(c, (tx) =>
      tx
        .select()
        .from(formTemplate)
        .where(and(isNull(formTemplate.retiredAt), isNull(formTemplate.deletedAt)))
        .orderBy(formTemplate.key, desc(formTemplate.templateVersion)),
    );
    return c.json(
      {
        items: rows.map((t) => ({
          id: t.id,
          key: t.key,
          version: t.templateVersion,
          title: t.title,
          kind: t.kind,
          locked: t.locked,
          global: t.tenantId === null,
        })),
      },
      200,
    );
  },
);

export const ratesRouter = createRouter().openapi(
  createRoute({
    method: "get",
    path: "/v1/rates/{key}",
    tags: ["platform"],
    summary: "A statutory figure in force on a date (tenant override first)",
    security,
    request: {
      params: z.object({ key: z.string().regex(/^[a-z0-9_]+(\.[a-z0-9_]+)+$/) }),
      query: z.object({
        nation: z.enum(["england", "wales", "scotland", "northern_ireland"]).default("england"),
        on: z.iso.date().optional(),
      }),
    },
    responses: { 200: jsonBody(RateValue, "Rate"), ...errorResponses, ...notFoundResponse },
  }),
  async (c) => {
    const access = c.get("access");
    const { key } = c.req.valid("param");
    const { nation, on } = c.req.valid("query");
    const rows = await withTenant(c, (tx) =>
      tx.select().from(rateTable).where(eq(rateTable.key, key)),
    );
    try {
      const rate = resolveRate(
        rows.map((r) => ({
          key: r.key,
          value: r.value,
          unit: r.unit,
          nation: r.nation,
          validFrom: r.validFrom,
          validTo: r.validTo,
          tenantId: r.tenantId,
          verificationStatus: r.verificationStatus,
          source: r.source,
        })),
        key,
        nation,
        on ?? new Date().toISOString().slice(0, 10),
        access.tenantId,
      );
      return c.json(rate, 200);
    } catch {
      throw problems.notFound();
    }
  },
);
