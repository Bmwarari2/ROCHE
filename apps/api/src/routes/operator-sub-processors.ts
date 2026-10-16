import {
  auditEvent,
  notification,
  subProcessorNotice,
  tenant,
  withRequestContext,
} from "@harbour/db";
import {
  checkNoticeTiming,
  OBJECTION_RESOLUTIONS,
  PLATFORM_RATE_KEYS,
  type SubProcessorUse,
  subProcessorUsedBy,
} from "@harbour/domain";
import { createRoute, z } from "@hono/zod-openapi";
import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/node-postgres";
import type { Context } from "hono";
import type { AppEnv } from "../http/context";
import { HttpProblem, problems } from "../http/problem";
import { rateNumber } from "../services/rates";
import { roleHolders } from "../services/role-holders";
import { subProcessorConfigFor } from "../services/sub-processors";
import {
  conflictResponse,
  createRouter,
  errorResponses,
  jsonBody,
  notFoundResponse,
  security,
} from "./openapi";

/**
 * Thapsus's side of sub-processor notices (platform-completions.md rules 24 and 25; DPA clause 6).
 * An admin operator, with a fresh step-up, announces a new or replacement sub-processor: it may
 * not take effect before the longest notice period among the organisations it affects
 * (`checkNoticeTiming`), and each affected organisation's data protection lead (its owners when
 * none is named) is told, with the announcement in its own audit trail. An admin records how an
 * organisation's open objection was resolved. Ids and keys only, never the grounds.
 */

const Use = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("always") }),
  z.object({ kind: z.literal("capability"), capability: z.enum(["mobile_push", "sms"]) }),
  z.object({
    kind: z.literal("ai_provider"),
    provider: z.enum(["bedrock_london", "bedrock_eu", "anthropic", "tenant_own"]),
  }),
]);

const Announce = z
  .object({
    subProcessorKey: z.string().regex(/^[a-z][a-z0-9_]{1,59}$/),
    kind: z.enum(["new", "replacement"]),
    use: Use,
    effectiveFrom: z.iso.datetime({ offset: true }),
  })
  .meta({ id: "AnnounceSubProcessorNotice" });

const Announced = z
  .object({ id: z.uuid(), affectedOrganisations: z.number().int().min(0) })
  .meta({ id: "SubProcessorNoticeAnnounced" });

const Objections = z
  .object({
    items: z.array(
      z.object({
        tenantId: z.uuid(),
        objectedAt: z.iso.datetime({ offset: true }),
        grounds: z.string(),
        resolvedAt: z.iso.datetime({ offset: true }).nullable(),
        resolution: z.enum(OBJECTION_RESOLUTIONS).nullable(),
      }),
    ),
  })
  .meta({ id: "SubProcessorObjections" });

/** The definer functions' refusals, as the console says them. */
function refusalOf(error: unknown): unknown {
  switch ((error as { message?: string }).message) {
    case "operator_not_admin":
      return problems.forbidden();
    case "notice_not_found":
      return problems.notFound();
    case "no_open_objection":
      return new HttpProblem(
        409,
        "no_open_objection",
        "The organisation has no open objection to this notice.",
      );
    default:
      return error;
  }
}

const Resolve = z
  .object({ resolution: z.enum(OBJECTION_RESOLUTIONS) })
  .meta({ id: "ResolveSubProcessorObjection" });

/** An admin with a fresh step-up: announcing or resolving binds every organisation it touches. */
function freshAdmin(c: Context<AppEnv>) {
  const operator = c.get("operator");
  if (operator.role !== "admin") throw problems.forbidden();
  if (!operator.stepUpFresh) throw problems.stepUp();
  return operator;
}

/**
 * In the organisation's own context: the operator's action in its audit trail, and its data
 * protection lead (or, with none named, its owners) told, with a generic title.
 */
async function tellOrganisation(
  c: Context<AppEnv>,
  tenantId: string,
  input: {
    /** The operator's action for the organisation's audit trail; null when already written. */
    readonly audit: { readonly action: string; readonly scope: Record<string, unknown> } | null;
    readonly resourceId: string;
    readonly kind: string;
    readonly title: string;
  },
) {
  const operator = c.get("operator");
  await withRequestContext(
    c.get("services").db,
    { tenantId, userId: null, scope: "tenant", locationIds: [] },
    async (tx) => {
      if (input.audit) {
        await tx.insert(auditEvent).values({
          tenantId,
          actorAuthUserId: operator.authUserId,
          actorRoleKeys: [`thapsus_${operator.role}`],
          action: input.audit.action,
          resourceType: "sub_processor_notice",
          resourceId: input.resourceId,
          scope: { operatorId: operator.id, ...input.audit.scope },
          requestId: c.get("requestId"),
        });
      }
      const [t] = await tx
        .select({ leadId: tenant.dataProtectionLeadId })
        .from(tenant)
        .where(eq(tenant.id, tenantId));
      const recipients = t?.leadId
        ? [t.leadId]
        : await roleHolders(tx, ["owner"], null, new Date());
      for (const recipient of recipients) {
        await tx.insert(notification).values({
          recipientTenantUserId: recipient,
          kind: input.kind,
          severity: "warning",
          title: input.title,
          link: "/settings/data-protection",
          channels: ["in_app", "email"],
          sourceType: "sub_processor_notice",
          sourceId: input.resourceId,
          dedupeKey: `${input.kind}:${input.resourceId}:${recipient}`,
        });
      }
    },
  );
}

export const operatorSubProcessorsRouter = createRouter()
  .openapi(
    createRoute({
      method: "post",
      path: "/operator/sub-processor-notices",
      tags: ["operator"],
      summary: "Announce a new or replacement sub-processor (admins, fresh sign-in)",
      description:
        "Works out which organisations the change affects from their configuration, refuses an effective date before the longest of their notice periods (422 notice_too_short, with the earliest date), stores the notice and tells each affected organisation's data protection lead (or its owners), recording the announcement in its audit trail.",
      security,
      request: { body: { content: { "application/json": { schema: Announce } } } },
      responses: { 201: jsonBody(Announced, "Announced"), ...errorResponses },
    }),
    async (c) => {
      freshAdmin(c);
      const body = c.req.valid("json");
      const services = c.get("services");
      const now = new Date();
      const use = body.use as SubProcessorUse;
      const notice = { announcedAt: now, effectiveFrom: new Date(body.effectiveFrom) };
      const tenants = await drizzle(services.operatorPool)
        .select({ id: tenant.id, status: tenant.status })
        .from(tenant);
      const affected: { readonly id: string; readonly days: number }[] = [];
      for (const { id, status } of tenants) {
        if (status !== "onboarding" && status !== "active") continue;
        const days = await withRequestContext(
          services.db,
          { tenantId: id, userId: null, scope: "tenant", locationIds: [] },
          async (tx) => {
            const [t] = await tx.select().from(tenant).where(eq(tenant.id, id));
            if (!t) return null;
            const config = await subProcessorConfigFor(tx, services.flags, t);
            if (!subProcessorUsedBy(use, config)) return null;
            return rateNumber(tx, id, PLATFORM_RATE_KEYS.subProcessorNoticeDays);
          },
        );
        if (days !== null) affected.push({ id, days });
      }
      const timing = checkNoticeTiming(
        notice,
        affected.map((a) => a.days),
      );
      if (!timing.ok) {
        throw new HttpProblem(
          422,
          "notice_too_short",
          "The change cannot take effect that soon.",
          `The affected organisations need notice until ${timing.earliestEffectiveFrom.toISOString()}.`,
        );
      }
      const [saved] = await drizzle(services.operatorPool)
        .insert(subProcessorNotice)
        .values({
          subProcessorKey: body.subProcessorKey,
          kind: body.kind,
          use,
          announcedAt: now,
          effectiveFrom: notice.effectiveFrom,
        })
        .returning({ id: subProcessorNotice.id });
      if (!saved) throw problems.conflict();
      for (const { id } of affected) {
        await tellOrganisation(c, id, {
          audit: {
            action: "platform.sub_processor.announced",
            scope: { subProcessorKey: body.subProcessorKey, kind: body.kind },
          },
          resourceId: saved.id,
          kind: "platform.sub_processor.notice",
          title: "A sub-processor change needs your answer",
        });
      }
      return c.json({ id: saved.id, affectedOrganisations: affected.length }, 201);
    },
  )
  .openapi(
    createRoute({
      method: "post",
      path: "/operator/tenants/{tenantId}/sub-processor-notices/{id}/resolution",
      tags: ["operator"],
      summary:
        "Record how an organisation's objection to a notice was resolved (admins, fresh sign-in)",
      description:
        "Only while the organisation has an open objection to the notice (409 no_open_objection otherwise). Withdrawn lets the sub-processor process its data; not used for it, or services ended, never does (mayProcessTenantData). Append-only; the organisation's lead is told and its audit trail records it.",
      security,
      request: {
        params: z.object({ tenantId: z.uuid(), id: z.uuid() }),
        body: { content: { "application/json": { schema: Resolve } } },
      },
      responses: {
        201: jsonBody(z.object({ id: z.uuid() }), "Recorded"),
        ...errorResponses,
        ...notFoundResponse,
        ...conflictResponse,
      },
    }),
    async (c) => {
      const operator = freshAdmin(c);
      const { tenantId, id } = c.req.valid("param");
      const { resolution } = c.req.valid("json");
      let saved: string;
      try {
        const { rows } = await c
          .get("services")
          .operatorPool.query<{ id: string }>(
            "SELECT app.resolve_sub_processor_objection($1, $2, $3, $4, $5) AS id",
            [tenantId, id, resolution, operator.authUserId, c.get("requestId") ?? null],
          );
        saved = rows[0]?.id as string;
      } catch (error) {
        throw refusalOf(error);
      }
      // The function wrote the organisation's audit event; its lead (or owners) is told.
      await tellOrganisation(c, tenantId, {
        audit: null,
        resourceId: id,
        kind: "platform.sub_processor.objection_resolved",
        title: "Your objection to a sub-processor change has been resolved",
      });
      return c.json({ id: saved }, 201);
    },
  )
  .openapi(
    createRoute({
      method: "get",
      path: "/operator/sub-processor-notices/{id}/objections",
      tags: ["operator"],
      summary: "The organisations' objections to a notice (admins, fresh sign-in)",
      description:
        "Through app.sub_processor_objections: each organisation's objection with the grounds it gave Thapsus and how it was resolved; every read is recorded in that organisation's audit trail.",
      security,
      request: { params: z.object({ id: z.uuid() }) },
      responses: {
        200: jsonBody(Objections, "Objections"),
        ...errorResponses,
        ...notFoundResponse,
      },
    }),
    async (c) => {
      const operator = freshAdmin(c);
      const { id } = c.req.valid("param");
      try {
        const { rows } = await c.get("services").operatorPool.query<{
          tenant_id: string;
          objected_at: Date;
          grounds: string;
          resolved_at: Date | null;
          resolution: string | null;
        }>("SELECT * FROM app.sub_processor_objections($1, $2, $3)", [
          id,
          operator.authUserId,
          c.get("requestId") ?? null,
        ]);
        return c.json(
          {
            items: rows.map((r) => ({
              tenantId: r.tenant_id,
              objectedAt: r.objected_at.toISOString(),
              grounds: r.grounds,
              resolvedAt: r.resolved_at ? r.resolved_at.toISOString() : null,
              resolution: r.resolution as (typeof OBJECTION_RESOLUTIONS)[number] | null,
            })),
          },
          200,
        );
      } catch (error) {
        throw refusalOf(error);
      }
    },
  );
