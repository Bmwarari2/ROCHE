import { tenant, withRequestContext } from "@harbour/db";
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
import type pg from "pg";
import type { AppEnv } from "../http/context";
import { HttpProblem, problems } from "../http/problem";
import { rateNumber } from "../services/rates";
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
 * not take effect before the longest notice period among the organisations it affects, suspended
 * ones included (their data is still processed; only closed ones are left out), checked with
 * `checkNoticeTiming`. Announcing, reading objections and resolving one go through definer
 * functions (migration 0067) that identify the admin from the transaction's `app.operator_id`
 * and write each organisation's audit trail and an outbox event in one transaction; the worker
 * then tells its lead (or owners), durably and once. Ids and keys only, never the grounds.
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

/** Runs `fn` in one operator transaction with `app.operator_id` set, as the functions require. */
async function asOperator<T>(
  c: Context<AppEnv>,
  operatorId: string,
  fn: (client: pg.PoolClient) => Promise<T>,
): Promise<T> {
  const client = await c.get("services").operatorPool.connect();
  try {
    await client.query("BEGIN");
    await client.query("SELECT set_config('app.operator_id', $1, true)", [operatorId]);
    const result = await fn(client);
    await client.query("COMMIT");
    return result;
  } catch (error) {
    await client.query("ROLLBACK");
    throw refusalOf(error);
  } finally {
    client.release();
  }
}

/** Organisations whose data is still processed: every one not closed. */
const PROCESSED = new Set(["onboarding", "active", "suspended"]);

export const operatorSubProcessorsRouter = createRouter()
  .openapi(
    createRoute({
      method: "post",
      path: "/operator/sub-processor-notices",
      tags: ["operator"],
      summary: "Announce a new or replacement sub-processor (admins, fresh sign-in)",
      description:
        "Works out which organisations the change affects from their configuration (every organisation not closed, suspended ones included), refuses an effective date before the longest of their notice periods (422 notice_too_short, with the earliest date), then through app.announce_sub_processor_notice stores the notice and, for each affected organisation, its audit event and an outbox event the worker turns into a notification to its lead (or owners).",
      security,
      request: { body: { content: { "application/json": { schema: Announce } } } },
      responses: { 201: jsonBody(Announced, "Announced"), ...errorResponses },
    }),
    async (c) => {
      const operator = freshAdmin(c);
      const body = c.req.valid("json");
      const services = c.get("services");
      const use = body.use as SubProcessorUse;
      const effectiveFrom = new Date(body.effectiveFrom);
      const tenants = await drizzle(services.operatorPool)
        .select({ id: tenant.id, status: tenant.status })
        .from(tenant);
      const affected: { readonly id: string; readonly days: number }[] = [];
      for (const { id, status } of tenants) {
        if (!PROCESSED.has(status)) continue;
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
        { announcedAt: new Date(), effectiveFrom },
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
      const id = await asOperator(c, operator.id, async (client) => {
        const { rows } = await client.query<{ id: string }>(
          "SELECT app.announce_sub_processor_notice($1, $2, $3, $4, $5, $6) AS id",
          [
            body.subProcessorKey,
            body.kind,
            JSON.stringify(use),
            effectiveFrom,
            affected.map((a) => a.id),
            c.get("requestId") ?? null,
          ],
        );
        return rows[0]?.id as string;
      });
      return c.json({ id, affectedOrganisations: affected.length }, 201);
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
        "Through app.resolve_sub_processor_objection, only while the organisation has an open objection to the notice (409 no_open_objection otherwise). Withdrawn lets the sub-processor process its data; not used for it, or services ended, never does (mayProcessTenantData). Append-only; the organisation's audit trail records it and the worker tells its lead.",
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
      const saved = await asOperator(c, operator.id, async (client) => {
        const { rows } = await client.query<{ id: string }>(
          "SELECT app.resolve_sub_processor_objection($1, $2, $3, $4) AS id",
          [tenantId, id, resolution, c.get("requestId") ?? null],
        );
        return rows[0]?.id as string;
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
      const rows = await asOperator(c, operator.id, async (client) => {
        const result = await client.query<{
          tenant_id: string;
          objected_at: Date;
          grounds: string;
          resolved_at: Date | null;
          resolution: string | null;
        }>("SELECT * FROM app.sub_processor_objections($1, $2)", [id, c.get("requestId") ?? null]);
        return result.rows;
      });
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
    },
  );
