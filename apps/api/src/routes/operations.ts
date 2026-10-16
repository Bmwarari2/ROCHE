import { DowntimePackOut, type DowntimePackOut as DowntimePackOutT } from "@harbour/contracts";
import {
  type DowntimePack,
  downtimePackFreshness,
  downtimePageHeader,
  formatUkDateTime,
  type Permission,
  type RateNation,
  scopeFor,
} from "@harbour/domain";
import { createRoute, z } from "@hono/zod-openapi";
import { sql } from "drizzle-orm";
import type { Context } from "hono";
import { writeAudit } from "../http/audit";
import { type AppEnv, requirePermission, type TenantAccess, withTenant } from "../http/context";
import { HttpProblem, problems } from "../http/problem";
import { RateLimiter, requireWithinLimit } from "../http/rate-limit";
import {
  buildDowntimePack,
  freshnessContext,
  latestVisiblePack,
  livePeopleAt,
  operationsRates,
  packLocation,
  packServes,
  type StoredPackRow,
} from "../services/downtime-pack";
import { rateNumber } from "../services/rates";
import {
  createRouter,
  errorResponses,
  jsonBody,
  limitedResponse,
  notFoundResponse,
  security,
  unavailableResponse,
} from "./openapi";
import { audit, dbCode, requireStepUp } from "./people-shared";

/**
 * The downtime pack routes (operations.md sections 5, 12 and 13; OPS-028; HZ-021). Reading needs
 * `operations.downtime.read` where the location is, and runs in that permission's scope: the pack
 * is the latest one the reader can open, built again on the spot when it no longer serves the
 * people receiving care there (someone moved in, out or away, went to hospital or came back,
 * anything it was built from changed, or it expired), so a holder at a reachable location is never
 * left without one. One build runs at a time per location; each member opens, prints or builds
 * packs at most `downtime_pack.requests_per_hour` times an hour; building on request needs a
 * fresh sign-in, as a whole-home pack is a bulk export (master prompt section 5.3). If a build
 * fails, the latest pack is served and says so. The header lines every printed page carries are
 * worked out at the moment of the request.
 */

const READ: Permission = "operations.downtime.read";
const LIMIT_KEY = "downtime_pack.requests_per_hour";
const HOUR_MS = 3_600_000;
type Nation = Exclude<RateNation, "uk" | "all">;

const Params = z.object({ id: z.uuid() });

/**
 * The location must be where the permission's roles and grants reach (ADR-0071); a location out of
 * reach reads as not found, and the refusal is audited (#45 review round 1).
 */
export async function requireReach(
  c: Context<AppEnv>,
  access: TenantAccess,
  permission: Permission,
  locationId: string,
  action: string,
): Promise<void> {
  const { scope, locationIds } = scopeFor(access.effective, permission);
  if (scope === "tenant" || (scope === "locations" && locationIds.includes(locationId))) return;
  await writeAudit(c.get("services").appPool, access, {
    action,
    outcome: "denied",
    resourceType: "location",
    resourceId: locationId,
    reason: "out_of_scope",
    requestId: c.get("requestId"),
  });
  throw problems.notFound();
}

/** Each member opens, prints or builds packs at most so many times an hour (#45 security M1). */
export async function requirePackLimit(c: Context<AppEnv>, access: TenantAccess): Promise<void> {
  const limit = await withTenant(c, (tx) => rateNumber(tx, access.tenantId, LIMIT_KEY));
  await requireWithinLimit(
    c.get("services").db,
    access,
    new RateLimiter("downtime_pack", limit, HOUR_MS),
  );
}

export interface Read {
  readonly row: StoredPackRow;
  readonly built: boolean;
  /** A build was needed and failed, so this is the latest pack there was (#45 clinical M1). */
  readonly rebuildFailed: boolean;
  readonly header: readonly string[];
  readonly freshness: ReturnType<typeof downtimePackFreshness>;
}

/** The pack the reader gets now, built when none serves, with its words worked out now. */
export async function readPack(
  c: Context<AppEnv>,
  access: TenantAccess,
  locationId: string,
  options: { readonly action: string; readonly reason: "read" | "asked" },
): Promise<Read> {
  const now = new Date();
  return withTenant(c, async (tx) => {
    const place = await packLocation(tx, locationId);
    if (!place) throw problems.notFound();
    // One build at a time per location: a second reader waits, then finds the pack just built.
    await tx.execute(
      sql`SELECT pg_advisory_xact_lock(hashtext(${`downtime-pack-build:${access.tenantId}:${locationId}`}))`,
    );
    let row = await latestVisiblePack(tx, locationId);
    const people = await livePeopleAt(tx, locationId);
    let built = false;
    let rebuildFailed = false;
    if (!(await packServes(tx, row, people, now))) {
      try {
        row = await tx.transaction((sp) =>
          buildDowntimePack(sp, {
            tenantId: access.tenantId,
            locationId,
            source: "server_on_demand",
            generatedBy: access.tenantUserId,
            now,
          }),
        );
        built = true;
        await audit(c, tx, access, {
          action: "operations.downtime_pack.generated",
          resourceType: "downtime_pack",
          resourceId: row.id,
          scope: { locationId, source: row.source, reason: options.reason },
        });
      } catch (error) {
        // Never a bare failure: the latest pack, saying it could not be rebuilt (ids only logged).
        rebuildFailed = true;
        c.get("services").logger.error(
          { requestId: c.get("requestId"), locationId, code: dbCode(error) ?? "unknown" },
          "downtime pack rebuild failed",
        );
        await audit(c, tx, access, {
          action: "operations.downtime_pack.generated",
          outcome: "error",
          resourceType: "location",
          resourceId: locationId,
          reason: "rebuild_failed",
          scope: { locationId, servedPackId: row?.id ?? null },
        });
        if (!row) {
          throw new HttpProblem(
            503,
            "downtime_pack_unavailable",
            "The downtime pack could not be built just now.",
            "Try again in a few minutes. Until then, use the last printed pack and ask the nurse in charge about any change since.",
          );
        }
      }
    }
    if (!row) throw problems.notFound();
    const rates = await operationsRates(tx, access.tenantId, place.nation as Nation, now);
    const context = await freshnessContext(tx, locationId, rates);
    await audit(c, tx, access, {
      action: options.action,
      resourceType: "downtime_pack",
      resourceId: row.id,
      scope: { locationId, rebuildFailed },
    });
    const pack = {
      locationName: (row.content as Pick<DowntimePack, "locationName">).locationName,
      generatedAt: row.generatedAt,
      asAt: row.asAt,
      validUntil: row.validUntil,
    };
    const header = [...downtimePageHeader(pack, now, context).lines];
    if (rebuildFailed) {
      header.splice(
        2,
        0,
        `This pack could not be rebuilt just now: it is the one made ${formatUkDateTime(row.generatedAt)}. Ask the nurse in charge about any change since.`,
      );
    }
    return {
      row,
      built,
      rebuildFailed,
      header,
      freshness: downtimePackFreshness(pack, now, context),
    };
  });
}

function packOut(read: Read): DowntimePackOutT {
  const content = read.row.content as { pages?: unknown[]; warnings?: unknown[] };
  return {
    id: read.row.id,
    locationId: read.row.locationId,
    source: read.row.source as DowntimePackOutT["source"],
    generatedAt: read.row.generatedAt.toISOString(),
    asAt: read.row.asAt.toISOString(),
    validUntil: read.row.validUntil.toISOString(),
    generatedBy: read.row.generatedBy,
    freshness: read.freshness,
    header: [...read.header],
    built: read.built,
    rebuildFailed: read.rebuildFailed,
    pages: (content.pages ?? []) as Record<string, unknown>[],
    warnings: (content.warnings ?? []) as Record<string, unknown>[],
  };
}

export const operationsRouter = createRouter()
  .openapi(
    createRoute({
      method: "get",
      path: "/v1/locations/{id}/downtime-pack",
      tags: ["operations"],
      summary: "The location's downtime pack, with its freshness now",
      description:
        "The latest pack you can open, built on the spot when it no longer names exactly the people receiving care here with their status now, anything it was built from changed, or it expired (HZ-021). If that build fails, the latest pack is served and says so (`rebuildFailed`). Needs a fresh sign-in (a whole-home pack is a bulk export). Opening is audited.",
      security,
      request: { params: Params },
      responses: {
        200: jsonBody(DowntimePackOut, "The pack"),
        ...errorResponses,
        ...notFoundResponse,
        ...limitedResponse,
        ...unavailableResponse,
      },
    }),
    async (c) => {
      const access = await requirePermission(c, READ);
      const { id } = c.req.valid("param");
      const action = "operations.downtime_pack.opened";
      await requireReach(c, access, READ, id, action);
      // The JSON holds the same whole-home data as the PDF, so it needs the same fresh sign-in
      // (#45 review round 2): step-up on the print alone could be skipped by asking for JSON.
      await requireStepUp(c, access, action);
      await requirePackLimit(c, access);
      const read = await readPack(c, access, id, { action, reason: "read" });
      return c.json(packOut(read), 200);
    },
  )
  .openapi(
    createRoute({
      method: "post",
      path: "/v1/locations/{id}/downtime-pack",
      tags: ["operations"],
      summary: "Build the location's downtime pack now, unless the latest still serves",
      description:
        "Needs a fresh sign-in (a whole-home pack is a bulk export). The latest pack is reused when nothing it was built from has changed (`built` says which).",
      security,
      request: { params: Params },
      responses: {
        201: jsonBody(DowntimePackOut, "Built, or the latest reused"),
        ...errorResponses,
        ...notFoundResponse,
        ...limitedResponse,
        ...unavailableResponse,
      },
    }),
    async (c) => {
      const access = await requirePermission(c, READ);
      const { id } = c.req.valid("param");
      const action = "operations.downtime_pack.opened";
      await requireReach(c, access, READ, id, action);
      await requireStepUp(c, access, "operations.downtime_pack.generated");
      await requirePackLimit(c, access);
      const read = await readPack(c, access, id, { action, reason: "asked" });
      return c.json(packOut(read), 201);
    },
  );
