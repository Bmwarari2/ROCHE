import {
  ClearQualityIndicatorTarget,
  PirPrefill,
  QualityDashboard,
  QualityDashboardQuery,
  QualityIndicatorTargetList,
  QualityIndicatorTargetOut,
  SetQualityIndicatorTarget,
} from "@harbour/contracts";
import { qualityIndicatorTarget, type Transaction } from "@harbour/db";
import {
  checkIndicatorTarget,
  type Permission,
  phase2Indicators,
  scopeFor,
  ukIsoDate,
} from "@harbour/domain";
import { createRoute, z } from "@hono/zod-openapi";
import { and, asc, eq, isNull } from "drizzle-orm";
import type { Context } from "hono";
import { auditInTx } from "../http/audit";
import { type AppEnv, requirePermission, type TenantAccess, withTenant } from "../http/context";
import { HttpProblem, problems } from "../http/problem";
import { dataSecurityRates } from "../services/data-security";
import {
  checkPeriod,
  dashboardOut,
  indicatorCounts,
  noLooserThan,
  pirOut,
  pirPeriod,
  QUALITY_DASHBOARD_PERMISSION,
  targetsFor,
} from "../services/quality-dashboard";
import {
  conflictResponse,
  createRouter,
  errorResponses,
  jsonBody,
  notFoundResponse,
  security,
} from "./openapi";
import { dbCode } from "./people-shared";

/**
 * The quality dashboard, its targets and the PIR prefill (QUAL-005, QUAL-006; quality.md section
 * 22; ADR-0108). For one location the reader holds `quality.audit.manage` at: the API checks the
 * place, and the database function and row-level security check it again. Counts only; every view
 * and change is audited with ids and codes.
 */

type Tx = Transaction;
const PERMISSION = QUALITY_DASHBOARD_PERMISSION as Permission;
const today = () => ukIsoDate(new Date());

const audit = (
  c: Context<AppEnv>,
  tx: Tx,
  access: TenantAccess,
  action: string,
  resourceType: string,
  resourceId: string | null,
  scope: Record<string, unknown> = {},
) =>
  auditInTx(tx, access, {
    action,
    resourceType,
    ...(resourceId ? { resourceId } : {}),
    scope,
    requestId: c.get("requestId"),
  });

/** Where the reader holds the permission: everywhere, or these locations (never assigned people). */
function placesOf(access: TenantAccess) {
  const { scope, locationIds } = scopeFor(access.effective, PERMISSION);
  return {
    organisationWide: scope === "tenant",
    reaches: (locationId: string | null) =>
      scope === "tenant" ||
      (locationId !== null && scope === "locations" && locationIds.includes(locationId)),
  };
}

function requireLocation(access: TenantAccess, locationId: string | null): void {
  if (!placesOf(access).reaches(locationId)) throw problems.forbidden();
}

const targetOut = (r: typeof qualityIndicatorTarget.$inferSelect) => ({
  id: r.id,
  locationId: r.locationId,
  indicatorKey: r.indicatorKey as z.infer<typeof QualityIndicatorTargetOut>["indicatorKey"],
  green: Number(r.green),
  amber: Number(r.amber),
  version: r.version,
});

export const qualityDashboardRouter = createRouter()
  .openapi(
    createRoute({
      method: "get",
      path: "/v1/quality/dashboard",
      tags: ["quality"],
      summary: "The quality indicators for one location and period, each with its working",
      description:
        "`quality.audit.manage` at the location. Each indicator gives its numerator, denominator, period, source and method, and a status against the organisation's own target. `from` and `to` are whole calendar months that have ended, at most 12 (422 `period_not_months`, `period_not_ended`, `period_too_long`). A source Harbour does not record yet, a period before the location started recording in Harbour or with a downtime still to reconcile gives `no_data` with its reason and no working. A small count (`quality.indicator.min_group_size`) is withheld with its value, but keeps its status against the target. Audited (`quality.dashboard.viewed`).",
      security,
      request: { query: QualityDashboardQuery },
      responses: { 200: jsonBody(QualityDashboard, "The dashboard"), ...errorResponses },
    }),
    async (c) => {
      const access = await requirePermission(c, PERMISSION);
      const { locationId, from, to } = c.req.valid("query");
      requireLocation(access, locationId);
      const on = today();
      checkPeriod(from, to, on);
      const body = await withTenant(c, async (tx) => {
        const rates = await dataSecurityRates(tx, access.tenantId, on);
        const counts = await indicatorCounts(
          tx,
          locationId,
          from,
          to,
          rates.incidentReviewTargetDays,
        );
        const targets = await targetsFor(tx, locationId);
        await audit(c, tx, access, "quality.dashboard.viewed", "location", locationId, {
          from,
          to,
        });
        return {
          locationId,
          generatedAt: new Date().toISOString(),
          period: { from, to },
          minGroupSize: rates.minGroupSize,
          indicators: dashboardOut(rates, counts, targets, locationId, { from, to }),
        };
      });
      return c.json(body, 200);
    },
  )
  .openapi(
    createRoute({
      method: "get",
      path: "/v1/quality/indicator-targets",
      tags: ["quality"],
      summary: "The organisation's indicator targets",
      description:
        "`quality.audit.manage`. The organisation defaults and, with `locationId`, that location's own targets; without it, the targets of every location the reader holds the permission at.",
      security,
      request: { query: z.object({ locationId: z.uuid().optional() }) },
      responses: { 200: jsonBody(QualityIndicatorTargetList, "Targets"), ...errorResponses },
    }),
    async (c) => {
      const access = await requirePermission(c, PERMISSION);
      const { locationId } = c.req.valid("query");
      if (locationId) requireLocation(access, locationId);
      const places = placesOf(access);
      const items = await withTenant(c, async (tx) => {
        const rows = await tx
          .select()
          .from(qualityIndicatorTarget)
          .where(isNull(qualityIndicatorTarget.deletedAt))
          .orderBy(asc(qualityIndicatorTarget.indicatorKey), asc(qualityIndicatorTarget.createdAt));
        return rows
          .filter((r) =>
            r.locationId === null
              ? true
              : locationId
                ? r.locationId === locationId
                : places.reaches(r.locationId),
          )
          .map(targetOut);
      });
      return c.json({ items }, 200);
    },
  )
  .openapi(
    createRoute({
      method: "put",
      path: "/v1/quality/indicator-targets",
      tags: ["quality"],
      summary: "Set a target for an indicator",
      description:
        "`quality.audit.manage` at the location, or across the organisation for the default (`locationId` null). Green and amber in the indicator's direction (422 `wrong_order`), percentages 0 to 100 (422 `percent_range`); a location's target no looser than the organisation default unless set by an organisation-wide holder (422 `looser_than_organisation`). `expectedVersion` null adds a target (409 `already_set` when one is live); otherwise the live target's version (409 when stale). Audited (`quality.indicator_target.set`).",
      security,
      request: {
        body: { content: { "application/json": { schema: SetQualityIndicatorTarget } } },
      },
      responses: {
        200: jsonBody(QualityIndicatorTargetOut, "The target"),
        ...errorResponses,
        ...conflictResponse,
      },
    }),
    async (c) => {
      const access = await requirePermission(c, PERMISSION);
      const body = c.req.valid("json");
      requireLocation(access, body.locationId);
      const definition = phase2Indicators({ bedDaysBase: 1 }).find(
        (d) => d.key === body.indicatorKey,
      );
      if (!definition || checkIndicatorTarget(definition, body).length > 0) {
        throw new HttpProblem(
          422,
          "wrong_order",
          definition?.direction === "higher_is_better"
            ? "Green must be the same as amber or higher."
            : "Green must be the same as amber or lower.",
        );
      }
      if (definition.unit === "percent" && (body.green > 100 || body.amber > 100)) {
        throw new HttpProblem(422, "percent_range", "A percentage target is between 0 and 100.");
      }
      const place = body.locationId
        ? eq(qualityIndicatorTarget.locationId, body.locationId)
        : isNull(qualityIndicatorTarget.locationId);
      const row = await withTenant(c, async (tx) => {
        const [live] = await tx
          .select()
          .from(qualityIndicatorTarget)
          .where(
            and(
              place,
              eq(qualityIndicatorTarget.indicatorKey, body.indicatorKey),
              isNull(qualityIndicatorTarget.deletedAt),
            ),
          );
        // Rule 41: a home's own target is no looser than the organisation default, unless someone
        // who holds the permission across the organisation sets it.
        if (body.locationId !== null && !placesOf(access).organisationWide) {
          const [organisation] = await tx
            .select()
            .from(qualityIndicatorTarget)
            .where(
              and(
                isNull(qualityIndicatorTarget.locationId),
                eq(qualityIndicatorTarget.indicatorKey, body.indicatorKey),
                isNull(qualityIndicatorTarget.deletedAt),
              ),
            );
          const theirs = organisation
            ? { green: Number(organisation.green), amber: Number(organisation.amber) }
            : null;
          if (!noLooserThan(definition.direction, body, theirs)) {
            throw new HttpProblem(
              422,
              "looser_than_organisation",
              "A location's target cannot be less strict than the organisation's. Ask someone who manages quality for the whole organisation.",
            );
          }
        }
        let saved: typeof qualityIndicatorTarget.$inferSelect | undefined;
        if (body.expectedVersion === null) {
          if (live) {
            throw new HttpProblem(
              409,
              "already_set",
              "A target is already set for this. Reload and change it instead.",
            );
          }
          try {
            [saved] = await tx
              .insert(qualityIndicatorTarget)
              .values({
                locationId: body.locationId,
                indicatorKey: body.indicatorKey,
                green: body.green,
                amber: body.amber,
                createdBy: access.tenantUserId,
                updatedBy: access.tenantUserId,
              })
              .returning();
          } catch (error) {
            if (dbCode(error) === "23503") {
              throw new HttpProblem(
                422,
                "location_not_found",
                "That location is not in this organisation.",
              );
            }
            if (dbCode(error) === "23505") {
              throw new HttpProblem(
                409,
                "already_set",
                "A target is already set for this. Reload and change it instead.",
              );
            }
            throw error;
          }
        } else {
          if (!live || live.version !== body.expectedVersion) throw problems.conflict();
          [saved] = await tx
            .update(qualityIndicatorTarget)
            .set({ green: body.green, amber: body.amber })
            .where(
              and(
                eq(qualityIndicatorTarget.id, live.id),
                eq(qualityIndicatorTarget.version, body.expectedVersion),
              ),
            )
            .returning();
          if (!saved) throw problems.conflict();
        }
        if (!saved) throw problems.forbidden();
        await audit(
          c,
          tx,
          access,
          "quality.indicator_target.set",
          "quality_indicator_target",
          saved.id,
          {
            indicatorKey: body.indicatorKey,
            locationId: body.locationId,
          },
        );
        return saved;
      });
      return c.json(targetOut(row), 200);
    },
  )
  .openapi(
    createRoute({
      method: "post",
      path: "/v1/quality/indicator-targets/{id}/clear",
      tags: ["quality"],
      summary: "Clear a target",
      description:
        "`quality.audit.manage` where the target applies. The indicator is then rated against the organisation default, or not at all. Audited (`quality.indicator_target.cleared`).",
      security,
      request: {
        params: z.object({ id: z.uuid() }),
        body: { content: { "application/json": { schema: ClearQualityIndicatorTarget } } },
      },
      responses: {
        200: jsonBody(z.object({ id: z.uuid() }), "Cleared"),
        ...errorResponses,
        ...notFoundResponse,
        ...conflictResponse,
      },
    }),
    async (c) => {
      const access = await requirePermission(c, PERMISSION);
      const { id } = c.req.valid("param");
      const { expectedVersion } = c.req.valid("json");
      await withTenant(c, async (tx) => {
        const [row] = await tx
          .select()
          .from(qualityIndicatorTarget)
          .where(and(eq(qualityIndicatorTarget.id, id), isNull(qualityIndicatorTarget.deletedAt)));
        if (!row) throw problems.notFound();
        requireLocation(access, row.locationId);
        const [cleared] = await tx
          .update(qualityIndicatorTarget)
          .set({ deletedAt: new Date() })
          .where(
            and(
              eq(qualityIndicatorTarget.id, id),
              eq(qualityIndicatorTarget.version, expectedVersion),
            ),
          )
          .returning({ id: qualityIndicatorTarget.id });
        if (!cleared) throw problems.conflict();
        await audit(
          c,
          tx,
          access,
          "quality.indicator_target.cleared",
          "quality_indicator_target",
          id,
          {
            indicatorKey: row.indicatorKey,
            locationId: row.locationId,
          },
        );
      });
      return c.json({ id }, 200);
    },
  )
  .openapi(
    createRoute({
      method: "get",
      path: "/v1/quality/pir",
      tags: ["quality"],
      summary: "The Provider Information Return prefill for one location",
      description:
        "`quality.audit.manage` at the location. The last 12 whole calendar months. Each data point in the question set is `prefilled` with its value, as-of date and records, or `to_complete` with why (not recorded in Harbour, no data, a small number). Nothing is submitted to CQC. Audited (`quality.pir.viewed`).",
      security,
      request: { query: z.object({ locationId: z.uuid() }) },
      responses: { 200: jsonBody(PirPrefill, "The prefill"), ...errorResponses },
    }),
    async (c) => {
      const access = await requirePermission(c, PERMISSION);
      const { locationId } = c.req.valid("query");
      requireLocation(access, locationId);
      const on = today();
      const period = pirPeriod(on);
      const body = await withTenant(c, async (tx) => {
        const rates = await dataSecurityRates(tx, access.tenantId, on);
        const counts = await indicatorCounts(
          tx,
          locationId,
          period.from,
          period.to,
          rates.incidentReviewTargetDays,
        );
        await audit(c, tx, access, "quality.pir.viewed", "location", locationId, period);
        return { locationId, ...pirOut(counts, period, rates.minGroupSize) };
      });
      return c.json(body, 200);
    },
  );
