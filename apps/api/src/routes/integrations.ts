import { integrationConnection, integrationInbound, supportAccessRequest } from "@harbour/db";
import { PORTS, type PortName, VETTING_PORTS, type VettingPort } from "@harbour/domain";
import { createRoute, z } from "@hono/zod-openapi";
import { and, desc, eq, isNull } from "drizzle-orm";
import { auditInTx } from "../http/audit";
import { requirePermission, stepUpFresh, stepUpRefusal, withTenant } from "../http/context";
import { problems } from "../http/problem";
import { KNOWN_PROVIDERS } from "../integrations/adapters";
import { KNOWN_VETTING_PROVIDERS } from "../integrations/vetting";

/** Every port a connection can be made for: communications, and the vetting ports (ADR-0094). */
const ALL_PORTS = [...PORTS, ...VETTING_PORTS] as const;
const isVettingPort = (port: string): port is VettingPort =>
  (VETTING_PORTS as readonly string[]).includes(port);

import { createRouter, errorResponses, jsonBody, notFoundResponse, security } from "./openapi";

/**
 * Integrations settings and the inbound quarantine queue (section 15.3), and the tenant side of
 * Thapsus support access (approve or decline, section 4 Thapsus operator row).
 */

const Connection = z
  .object({
    port: z.string(),
    provider: z.string(),
    status: z.string(),
    settings: z.record(z.string(), z.unknown()),
    hasSecret: z.boolean(),
    lastHealthAt: z.string().nullable(),
    lastError: z.string().nullable(),
  })
  .meta({ id: "IntegrationConnection" });

const QuarantineItem = z
  .object({
    id: z.uuid(),
    port: z.string(),
    provider: z.string(),
    externalId: z.string().nullable(),
    receivedAt: z.string(),
    problems: z.array(z.object({ path: z.string(), message: z.string() })),
  })
  .meta({ id: "QuarantineItem" });

const SupportRequest = z
  .object({
    id: z.uuid(),
    ticketReference: z.string(),
    reason: z.string(),
    requestedAt: z.string(),
    decision: z.enum(["approved", "declined"]).nullable(),
    decidedAt: z.string().nullable(),
    expiresAt: z.string().nullable(),
  })
  .meta({ id: "SupportAccessRequest" });

export const integrationsRouter = createRouter()
  .openapi(
    createRoute({
      method: "get",
      path: "/v1/integrations",
      tags: ["integrations"],
      summary: "Configured integrations and their health; unconfigured ports use mocks",
      security,
      responses: {
        200: jsonBody(
          z.object({ items: z.array(Connection), ports: z.array(z.string()) }),
          "Integrations",
        ),
        ...errorResponses,
      },
    }),
    async (c) => {
      await requirePermission(c, "integrations.connection.manage");
      const rows = await withTenant(c, (tx) =>
        tx.select().from(integrationConnection).where(isNull(integrationConnection.deletedAt)),
      );
      return c.json(
        {
          ports: [...ALL_PORTS],
          items: rows.map((r) => ({
            port: r.port,
            provider: r.provider,
            status: r.status,
            settings: r.settings as Record<string, unknown>,
            hasSecret: r.secretRef !== null,
            lastHealthAt: r.lastHealthAt?.toISOString() ?? null,
            lastError: r.lastError,
          })),
        },
        200,
      );
    },
  )
  .openapi(
    createRoute({
      method: "put",
      path: "/v1/integrations/{port}",
      tags: ["integrations"],
      summary:
        "Choose the provider for a port (credentials are stored in the secret store, not here)",
      description:
        "integrations.connection.manage. A vetting port (ADR-0094) also needs a fresh step-up, and takes only a provider this build knows; the mock is refused in production. Audited.",
      security,
      request: {
        params: z.object({ port: z.enum(ALL_PORTS) }),
        body: {
          content: {
            "application/json": {
              schema: z.object({
                provider: z.string(),
                settings: z
                  .record(z.string(), z.union([z.string(), z.number(), z.boolean()]))
                  .default({}),
                secretRef: z
                  .string()
                  .regex(/^arn:aws:secretsmanager:eu-west-2:/)
                  .nullable()
                  .default(null),
              }),
            },
          },
        },
      },
      responses: { 204: { description: "Saved" }, ...errorResponses },
    }),
    async (c) => {
      const access = await requirePermission(c, "integrations.connection.manage");
      const { port } = c.req.valid("param");
      const body = c.req.valid("json");
      if (isVettingPort(port)) {
        // Switching on a route that sends staff data to a vendor needs a fresh step-up, and a
        // provider this build knows; the mock never runs in production (ADR-0094).
        const stepUp = c.get("access");
        if (!stepUpFresh(stepUp)) throw stepUpRefusal(stepUp);
        const production = c.get("services").config.NODE_ENV === "production";
        if (
          !KNOWN_VETTING_PROVIDERS[port].includes(body.provider) ||
          (production && body.provider === "mock")
        ) {
          throw problems.invalid(`Provider ${body.provider} is not available for ${port}.`);
        }
      } else if (!KNOWN_PROVIDERS[port as PortName].includes(body.provider)) {
        throw problems.invalid(`Provider ${body.provider} is not available for ${port}.`);
      }
      await withTenant(c, async (tx) => {
        await tx
          .insert(integrationConnection)
          .values({
            port,
            provider: body.provider,
            settings: body.settings,
            secretRef: body.secretRef,
          })
          .onConflictDoUpdate({
            target: [integrationConnection.tenantId, integrationConnection.port],
            set: {
              provider: body.provider,
              settings: body.settings,
              secretRef: body.secretRef,
              deletedAt: null,
            },
          });
        await auditInTx(tx, access, {
          action: "integrations.connection.configure",
          resourceType: "integration_connection",
          resourceId: port,
          after: { provider: body.provider },
          requestId: c.get("requestId"),
        });
      });
      return c.body(null, 204);
    },
  )
  .openapi(
    createRoute({
      method: "delete",
      path: "/v1/integrations/{port}",
      tags: ["integrations"],
      summary: "Switch a vetting port off",
      description:
        "integrations.connection.manage, with a fresh step-up. Vetting ports only (ADR-0094): checks then go back to manual entry; checks already made stay on the staff file. Audited.",
      security,
      request: { params: z.object({ port: z.enum(VETTING_PORTS) }) },
      responses: { 204: { description: "Off" }, ...errorResponses },
    }),
    async (c) => {
      const access = await requirePermission(c, "integrations.connection.manage");
      const stepUp = c.get("access");
      if (!stepUpFresh(stepUp)) throw stepUpRefusal(stepUp);
      const { port } = c.req.valid("param");
      await withTenant(c, async (tx) => {
        await tx
          .update(integrationConnection)
          .set({ deletedAt: new Date() })
          .where(
            and(eq(integrationConnection.port, port), isNull(integrationConnection.deletedAt)),
          );
        await auditInTx(tx, access, {
          action: "integrations.connection.removed",
          resourceType: "integration_connection",
          resourceId: port,
          requestId: c.get("requestId"),
        });
      });
      return c.body(null, 204);
    },
  )
  .openapi(
    createRoute({
      method: "get",
      path: "/v1/integrations/quarantine",
      tags: ["integrations"],
      summary: "Inbound partner data that failed validation, waiting for a decision",
      security,
      responses: {
        200: jsonBody(z.object({ items: z.array(QuarantineItem) }), "Queue"),
        ...errorResponses,
      },
    }),
    async (c) => {
      await requirePermission(c, "integrations.connection.manage");
      const rows = await withTenant(c, (tx) =>
        tx
          .select()
          .from(integrationInbound)
          .where(eq(integrationInbound.status, "quarantined"))
          .orderBy(desc(integrationInbound.receivedAt))
          .limit(200),
      );
      return c.json(
        {
          items: rows.map((r) => ({
            id: r.id,
            port: r.port,
            provider: r.provider,
            externalId: r.externalId,
            receivedAt: r.receivedAt.toISOString(),
            problems: r.problems as { path: string; message: string }[],
          })),
        },
        200,
      );
    },
  )
  .openapi(
    createRoute({
      method: "post",
      path: "/v1/integrations/quarantine/{id}/resolve",
      tags: ["integrations"],
      summary: "Discard a quarantined item, or mark it handled by hand",
      security,
      request: {
        params: z.object({ id: z.uuid() }),
        body: {
          content: {
            "application/json": {
              schema: z.object({
                resolution: z.enum(["discarded", "handled_manually"]),
                note: z.string().trim().min(5).max(500),
              }),
            },
          },
        },
      },
      responses: { 204: { description: "Resolved" }, ...errorResponses, ...notFoundResponse },
    }),
    async (c) => {
      const access = await requirePermission(c, "integrations.connection.manage");
      const { id } = c.req.valid("param");
      const { resolution, note } = c.req.valid("json");
      const updated = await withTenant(c, async (tx) => {
        const rows = await tx
          .update(integrationInbound)
          .set({
            status: resolution,
            resolution: note,
            resolvedAt: new Date(),
            resolvedBy: access.tenantUserId,
          })
          .where(and(eq(integrationInbound.id, id), eq(integrationInbound.status, "quarantined")))
          .returning({ id: integrationInbound.id });
        if (rows.length > 0) {
          await auditInTx(tx, access, {
            action: "integrations.quarantine.resolve",
            resourceType: "integration_inbound",
            resourceId: id,
            reason: resolution,
            requestId: c.get("requestId"),
          });
        }
        return rows.length;
      });
      if (updated === 0) throw problems.notFound();
      return c.body(null, 204);
    },
  );

export const supportAccessRouter = createRouter()
  .openapi(
    createRoute({
      method: "get",
      path: "/v1/support-access",
      tags: ["platform"],
      summary: "Requests from Thapsus support to see the organisation's data",
      security,
      responses: {
        200: jsonBody(z.object({ items: z.array(SupportRequest) }), "Requests"),
        ...errorResponses,
      },
    }),
    async (c) => {
      await requirePermission(c, "platform.tenant.manage");
      const rows = await withTenant(c, (tx) =>
        tx
          .select()
          .from(supportAccessRequest)
          .orderBy(desc(supportAccessRequest.requestedAt))
          .limit(100),
      );
      return c.json(
        {
          items: rows.map((r) => ({
            id: r.id,
            ticketReference: r.ticketReference,
            reason: r.reason,
            requestedAt: r.requestedAt.toISOString(),
            decision: (r.decision as "approved" | "declined" | null) ?? null,
            decidedAt: r.decidedAt?.toISOString() ?? null,
            expiresAt: r.expiresAt?.toISOString() ?? null,
          })),
        },
        200,
      );
    },
  )
  .openapi(
    createRoute({
      method: "post",
      path: "/v1/support-access/{id}/decision",
      tags: ["platform"],
      summary: "Approve (for up to 24 hours) or decline a support access request",
      security,
      request: {
        params: z.object({ id: z.uuid() }),
        body: {
          content: {
            "application/json": {
              schema: z.object({
                decision: z.enum(["approved", "declined"]),
                hours: z.number().int().min(1).max(24).default(4),
              }),
            },
          },
        },
      },
      responses: { 204: { description: "Decided" }, ...errorResponses, ...notFoundResponse },
    }),
    async (c) => {
      const access = await requirePermission(c, "platform.support.approve");
      const { id } = c.req.valid("param");
      const { decision, hours } = c.req.valid("json");
      const now = new Date();
      const updated = await withTenant(c, async (tx) => {
        const rows = await tx
          .update(supportAccessRequest)
          .set({
            decision,
            decidedAt: now,
            decidedBy: access.tenantUserId,
            expiresAt: decision === "approved" ? new Date(now.getTime() + hours * 3_600_000) : null,
          })
          .where(and(eq(supportAccessRequest.id, id), isNull(supportAccessRequest.decision)))
          .returning({ id: supportAccessRequest.id });
        if (rows.length > 0) {
          await auditInTx(tx, access, {
            action: `platform.support_access.${decision}`,
            resourceType: "support_access_request",
            resourceId: id,
            scope: { hours: decision === "approved" ? hours : 0 },
            requestId: c.get("requestId"),
          });
        }
        return rows.length;
      });
      if (updated === 0) throw problems.notFound();
      return c.body(null, 204);
    },
  );
