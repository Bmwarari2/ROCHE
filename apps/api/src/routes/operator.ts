import {
  auditEvent,
  integrationConnection,
  location,
  notification,
  operatorUser,
  role,
  roleAssignment,
  supportAccessRequest,
  tenant,
  withRequestContext,
} from "@harbour/db";
import { BUILTIN_ROLES } from "@harbour/domain";
import { createRoute, z } from "@hono/zod-openapi";
import { and, count, eq, isNull, sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/node-postgres";
import type { Context, MiddlewareHandler } from "hono";
import { sessionFactorState } from "../auth/session-factor";
import { type AppEnv, SSO_OFF } from "../http/context";
import { HttpProblem, problems } from "../http/problem";
import { createRouter, errorResponses, jsonBody, security } from "./openapi";

/** Why an approved casework support ticket cannot be used now (app.operator_appoint_case_manager). */
const SUPPORT_TICKET_REFUSALS = new Set([
  "ticket_not_approved",
  "ticket_used",
  "case_not_open",
  "case_has_manager",
  "manager_not_allowed",
]);

/**
 * Thapsus operator console API (section 9.1). Operators are Better Auth identities listed in
 * `operator_user`; they always need MFA, never hold tenant roles, and use the harbour_operator
 * database role, which can provision tenants and read health but cannot read people or care data.
 * Support access to a tenant's data starts with a request the tenant approves; every operator action
 * on a tenant is written to that tenant's audit trail, where the tenant can see it.
 */

export const operatorMiddleware: MiddlewareHandler<AppEnv> = async (c, next) => {
  const session = c.get("session");
  if (!session) throw problems.unauthenticated();
  const { operatorPool, authPool } = c.get("services");
  const db = drizzle(operatorPool);
  const [op] = await db
    .select({ id: operatorUser.id, role: operatorUser.role, active: operatorUser.active })
    .from(operatorUser)
    .where(eq(operatorUser.authUserId, session.authUserId));
  if (!op?.active) throw problems.forbidden();
  // Operators never use an organisation's single sign-on (#33 re-check 2).
  if (session.ssoTenantId !== null) throw SSO_OFF();
  // As for members: only a session signed in or confirmed with a second factor (ADR-0072).
  const { mfa, stepUpFresh } = await sessionFactorState(
    authPool,
    session,
    c.get("services").config.STEP_UP_WINDOW_SECONDS,
  );
  if (mfa === "enrol") throw problems.mfaRequired();
  if (mfa === "verify") throw problems.mfaVerify();
  c.set("operator", {
    id: op.id,
    authUserId: session.authUserId,
    role: op.role as "support" | "admin",
    stepUpFresh,
  });
  await next();
};

const TenantSummary = z
  .object({
    id: z.uuid(),
    name: z.string(),
    status: z.string(),
    nation: z.string(),
    locations: z.number().int(),
    createdAt: z.string(),
  })
  .meta({ id: "OperatorTenantSummary" });

const ProvisionRequest = z
  .object({
    name: z.string().trim().min(2).max(200),
    legalName: z.string().trim().min(2).max(200),
    legalForm: z.enum([
      "limited_company",
      "charity",
      "community_interest_company",
      "partnership",
      "sole_trader",
      "public_body",
      "franchise",
    ]),
    cqcProviderId: z.string().trim().max(20).optional(),
    nation: z.enum(["england", "wales", "scotland", "northern_ireland"]).default("england"),
    owner: z.object({ displayName: z.string().trim().min(2).max(200), email: z.email() }),
  })
  .meta({ id: "ProvisionTenantRequest" });

/** Writes an operator action into the tenant's own audit chain and tells its owners. */
async function recordForTenant(
  c: Context<AppEnv>,
  tenantId: string,
  action: string,
  resourceId: string,
  notifyOwners: { title: string; link: string } | null,
) {
  const { db } = c.get("services");
  const operator = c.get("operator");
  await withRequestContext(
    db,
    { tenantId, userId: null, scope: "tenant", locationIds: [] },
    async (tx) => {
      await tx.insert(auditEvent).values({
        tenantId,
        actorAuthUserId: operator.authUserId,
        actorRoleKeys: [`thapsus_${operator.role}`],
        action,
        resourceType: "tenant",
        resourceId,
        requestId: c.get("requestId"),
      });
      if (notifyOwners) {
        const owners = await tx
          .selectDistinct({ id: roleAssignment.tenantUserId })
          .from(roleAssignment)
          .innerJoin(role, eq(role.id, roleAssignment.roleId))
          .where(and(eq(role.key, "owner"), isNull(roleAssignment.deletedAt)));
        for (const owner of owners) {
          await tx.insert(notification).values({
            recipientTenantUserId: owner.id,
            kind: "platform.support_access_requested",
            severity: "warning",
            title: notifyOwners.title,
            link: notifyOwners.link,
            channels: ["in_app", "email"],
          });
        }
      }
    },
  );
}

export const operatorRouter = createRouter()
  .openapi(
    createRoute({
      method: "get",
      path: "/operator/tenants",
      tags: ["operator"],
      summary: "Every tenant with its status (no people or care data)",
      security,
      responses: {
        200: jsonBody(z.object({ items: z.array(TenantSummary) }), "Tenants"),
        ...errorResponses,
      },
    }),
    async (c) => {
      const db = drizzle(c.get("services").operatorPool);
      const rows = await db
        .select({
          id: tenant.id,
          name: tenant.name,
          status: tenant.status,
          nation: tenant.nation,
          createdAt: tenant.createdAt,
          locations: count(location.id),
        })
        .from(tenant)
        .leftJoin(location, eq(location.tenantId, tenant.id))
        .groupBy(tenant.id)
        .orderBy(tenant.name);
      return c.json(
        {
          items: rows.map((r) => ({
            ...r,
            locations: Number(r.locations),
            createdAt: r.createdAt.toISOString(),
          })),
        },
        200,
      );
    },
  )
  .openapi(
    createRoute({
      method: "post",
      path: "/operator/tenants",
      tags: ["operator"],
      summary: "Provision a tenant with its built-in roles and an invited owner (admins only)",
      security,
      request: { body: { content: { "application/json": { schema: ProvisionRequest } } } },
      responses: { 201: jsonBody(z.object({ id: z.uuid() }), "Provisioned"), ...errorResponses },
    }),
    async (c) => {
      if (c.get("operator").role !== "admin") throw problems.forbidden();
      const body = c.req.valid("json");
      const roles = BUILTIN_ROLES.map((r) => ({
        key: r.key,
        name: r.name,
        description: r.description,
        permissions: r.permissions,
        scopeKind: r.scopeKind,
      }));
      const client = await c.get("services").operatorPool.connect();
      let id: string;
      try {
        await client.query("BEGIN");
        const { rows } = await client.query<{ id: string }>(
          "SELECT app.provision_tenant($1, $2, $3) AS id",
          [
            JSON.stringify({
              name: body.name,
              legalName: body.legalName,
              legalForm: body.legalForm,
              cqcProviderId: body.cqcProviderId ?? null,
              nation: body.nation,
            }),
            JSON.stringify(roles),
            JSON.stringify(body.owner),
          ],
        );
        await client.query("COMMIT");
        id = rows[0]?.id as string;
      } catch (error) {
        await client.query("ROLLBACK");
        if ((error as { code?: string }).code === "23505") {
          throw problems.invalid("A tenant with that CQC provider ID already exists.");
        }
        throw error;
      } finally {
        client.release();
      }
      await recordForTenant(c, id, "platform.tenant.provisioned", id, null);
      return c.json({ id }, 201);
    },
  )
  .openapi(
    createRoute({
      method: "post",
      path: "/operator/tenants/{tenantId}/casework-support-tickets/{ticketId}/appoint",
      tags: ["operator"],
      summary: "Appoint the case manager an approved casework support ticket names",
      description:
        "H-804: for a case whose case managers have all left, on a ticket the organisation raised and its data protection lead approved. Support never reads the case. Once per ticket. Audited to the organisation and its owners are told.",
      security,
      request: { params: z.object({ tenantId: z.uuid(), ticketId: z.uuid() }) },
      responses: {
        200: jsonBody(z.object({ ticketId: z.uuid() }), "Appointed"),
        ...errorResponses,
      },
    }),
    async (c) => {
      const { tenantId, ticketId } = c.req.valid("param");
      const operator = c.get("operator");
      const client = await c.get("services").operatorPool.connect();
      try {
        await client.query("BEGIN");
        await client.query("SELECT set_config('app.tenant_id', $1, true)", [tenantId]);
        await client.query("SELECT app.operator_appoint_case_manager($1, $2)", [
          ticketId,
          operator.id,
        ]);
        await client.query("COMMIT");
      } catch (error) {
        await client.query("ROLLBACK");
        const message = error instanceof Error ? error.message : "";
        if (message === "ticket_not_found") throw problems.notFound();
        if (SUPPORT_TICKET_REFUSALS.has(message)) {
          throw new HttpProblem(409, message, "This ticket cannot be used for that.");
        }
        throw error;
      } finally {
        client.release();
      }
      await recordForTenant(c, tenantId, "workforce.case.manager_appointed_by_support", ticketId, {
        title: "Thapsus support appointed a case manager, as your approved ticket asked",
        link: "/settings/support-access",
      });
      return c.json({ ticketId }, 200);
    },
  )
  .openapi(
    createRoute({
      method: "post",
      path: "/operator/tenants/{tenantId}/support-access",
      tags: ["operator"],
      summary:
        "Ask a tenant for time-boxed support access; the tenant's owners are told and decide",
      security,
      request: {
        params: z.object({ tenantId: z.uuid() }),
        body: {
          content: {
            "application/json": {
              schema: z.object({
                ticketReference: z.string().trim().min(3).max(40),
                reason: z.string().trim().min(20).max(1000),
              }),
            },
          },
        },
      },
      responses: { 201: jsonBody(z.object({ id: z.uuid() }), "Requested"), ...errorResponses },
    }),
    async (c) => {
      const { tenantId } = c.req.valid("param");
      const { ticketReference, reason } = c.req.valid("json");
      const operator = c.get("operator");
      const client = await c.get("services").operatorPool.connect();
      let id: string;
      try {
        await client.query("BEGIN");
        await client.query("SELECT set_config('app.tenant_id', $1, true)", [tenantId]);
        const exists = await client.query("SELECT 1 FROM tenant WHERE id = $1", [tenantId]);
        if ((exists.rowCount ?? 0) === 0) throw problems.notFound();
        const rows = await drizzle(client)
          .insert(supportAccessRequest)
          .values({ tenantId, operatorUserId: operator.id, ticketReference, reason })
          .returning({ id: supportAccessRequest.id });
        await client.query("COMMIT");
        id = rows[0]?.id as string;
      } catch (error) {
        await client.query("ROLLBACK");
        throw error;
      } finally {
        client.release();
      }
      await recordForTenant(c, tenantId, "platform.support_access.requested", id, {
        title: "Thapsus support asked to see your data",
        link: "/settings/support-access",
      });
      return c.json({ id }, 201);
    },
  )
  .openapi(
    createRoute({
      method: "get",
      path: "/operator/health",
      tags: ["operator"],
      summary: "Platform and integration health across tenants",
      security,
      responses: {
        200: jsonBody(
          z.object({
            database: z.enum(["ok", "unavailable"]),
            integrations: z.array(
              z.object({
                tenantId: z.uuid(),
                port: z.string(),
                provider: z.string(),
                status: z.string(),
                lastError: z.string().nullable(),
              }),
            ),
          }),
          "Health",
        ),
        ...errorResponses,
      },
    }),
    async (c) => {
      const db = drizzle(c.get("services").operatorPool);
      const database = await db
        .execute(sql`SELECT 1`)
        .then(() => "ok" as const)
        .catch(() => "unavailable" as const);
      const integrations = await db
        .select({
          tenantId: integrationConnection.tenantId,
          port: integrationConnection.port,
          provider: integrationConnection.provider,
          status: integrationConnection.status,
          lastError: integrationConnection.lastError,
        })
        .from(integrationConnection)
        .where(isNull(integrationConnection.deletedAt));
      return c.json({ database, integrations }, 200);
    },
  );
