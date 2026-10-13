import {
  DowntimePackOut,
  type DowntimePackOut as DowntimePackOutT,
  DowntimePlaces,
  SetDowntimePlaces,
} from "@harbour/contracts";
import { location, task } from "@harbour/db";
import {
  type DowntimePack,
  downtimePackFreshness,
  downtimePageHeader,
  type Permission,
  type RateNation,
  scopeFor,
} from "@harbour/domain";
import { createRoute, z } from "@hono/zod-openapi";
import { and, eq, inArray } from "drizzle-orm";
import type { Context } from "hono";
import { type AppEnv, requirePermission, type TenantAccess, withTenant } from "../http/context";
import { problems } from "../http/problem";
import {
  buildDowntimePack,
  DOWNTIME_PLACES_TASK,
  freshnessContext,
  latestVisiblePack,
  livePeopleAt,
  operationsRates,
  packLocation,
  packServes,
  type StoredPackRow,
} from "../services/downtime-pack";
import { renderDowntimePackPdf } from "../services/downtime-pack-pdf";
import { createRouter, errorResponses, jsonBody, notFoundResponse, security } from "./openapi";
import { audit, iso } from "./people-shared";

/**
 * The downtime pack routes (operations.md sections 5 and 12; OPS-028; HZ-021). Reading needs
 * `operations.downtime.read` where the location is, and runs in that permission's scope: the pack
 * is the latest one the reader can open, built again on the spot when it no longer serves the
 * people receiving care there (someone moved in, out or away, went to hospital or came back, the
 * places changed, or it expired), so a holder at a reachable location is never left without one.
 * The PDF is drawn when asked for, with the page header worked out at that moment, and is never
 * stored. Where the paper MAR and the PEEPs are kept is changed and confirmed with
 * `platform.location.manage`.
 */

const READ: Permission = "operations.downtime.read";
const PLACES: Permission = "platform.location.manage";
type Nation = Exclude<RateNation, "uk" | "all">;

const Params = z.object({ id: z.uuid() });

/** The location must be where the permission's roles and grants reach (ADR-0071). */
function requireReach(access: TenantAccess, permission: Permission, locationId: string): void {
  const { scope, locationIds } = scopeFor(access.effective, permission);
  if (scope !== "tenant" && !(scope === "locations" && locationIds.includes(locationId))) {
    throw problems.notFound();
  }
}

interface Read {
  readonly row: StoredPackRow;
  readonly built: boolean;
  readonly header: readonly string[];
  readonly freshness: ReturnType<typeof downtimePackFreshness>;
}

/** The pack the reader gets now, built when none serves, with its words worked out now. */
async function readPack(
  c: Context<AppEnv>,
  access: TenantAccess,
  locationId: string,
  options: { readonly forceBuild: boolean; readonly action: string },
): Promise<Read> {
  const now = new Date();
  return withTenant(c, async (tx) => {
    const place = await packLocation(tx, locationId);
    if (!place) throw problems.notFound();
    let row = await latestVisiblePack(tx, locationId);
    let built = false;
    if (options.forceBuild || !packServes(row, await livePeopleAt(tx, locationId), place, now)) {
      row = await buildDowntimePack(tx, {
        tenantId: access.tenantId,
        locationId,
        source: "server_on_demand",
        generatedBy: access.tenantUserId,
        now,
      });
      built = true;
      await audit(c, tx, access, {
        action: "operations.downtime_pack.generated",
        resourceType: "downtime_pack",
        resourceId: row.id,
        scope: { locationId, source: row.source, reason: options.forceBuild ? "asked" : "read" },
      });
    }
    if (!row) throw problems.notFound();
    const rates = await operationsRates(tx, access.tenantId, place.nation as Nation, now);
    const context = await freshnessContext(tx, locationId, rates);
    await audit(c, tx, access, {
      action: options.action,
      resourceType: "downtime_pack",
      resourceId: row.id,
      scope: { locationId },
    });
    const pack = {
      locationName: (row.content as Pick<DowntimePack, "locationName">).locationName,
      generatedAt: row.generatedAt,
      asAt: row.asAt,
      validUntil: row.validUntil,
    };
    return {
      row,
      built,
      header: downtimePageHeader(pack, now, context).lines,
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
      summary: "The location's downtime pack, with its freshness now (JSON or PDF)",
      description:
        "The latest pack you can open, built on the spot when it no longer names exactly the people receiving care here with their status now, the places changed, or it expired. `format=pdf` prints it with the header worked out now on every page (HZ-021). Opening and printing are audited.",
      security,
      request: {
        params: Params,
        query: z.object({ format: z.enum(["json", "pdf"]).default("json") }),
      },
      responses: {
        200: {
          content: {
            "application/json": { schema: DowntimePackOut },
            "application/pdf": { schema: z.string().meta({ format: "binary" }) },
          },
          description: "The pack",
        },
        ...errorResponses,
        ...notFoundResponse,
      },
    }),
    async (c) => {
      const access = await requirePermission(c, READ);
      const { id } = c.req.valid("param");
      const { format } = c.req.valid("query");
      requireReach(access, READ, id);
      const read = await readPack(c, access, id, {
        forceBuild: false,
        action:
          format === "pdf" ? "operations.downtime_pack.printed" : "operations.downtime_pack.opened",
      });
      if (format === "json") return c.json(packOut(read), 200);
      const bytes = renderDowntimePackPdf(
        read.row.content as Parameters<typeof renderDowntimePackPdf>[0],
        read.header,
      );
      return c.body(bytes as Uint8Array<ArrayBuffer>, 200, {
        "content-type": "application/pdf",
        "content-disposition": `attachment; filename="downtime-pack-${read.row.id}.pdf"`,
        "x-content-type-options": "nosniff",
        "cache-control": "private, no-store",
        "content-security-policy": "default-src 'none'; sandbox",
      });
    },
  )
  .openapi(
    createRoute({
      method: "post",
      path: "/v1/locations/{id}/downtime-pack",
      tags: ["operations"],
      summary: "Build the location's downtime pack now",
      security,
      request: { params: Params },
      responses: {
        201: jsonBody(DowntimePackOut, "Built"),
        ...errorResponses,
        ...notFoundResponse,
      },
    }),
    async (c) => {
      const access = await requirePermission(c, READ);
      const { id } = c.req.valid("param");
      requireReach(access, READ, id);
      const read = await readPack(c, access, id, {
        forceBuild: true,
        action: "operations.downtime_pack.opened",
      });
      return c.json(packOut(read), 201);
    },
  )
  .openapi(
    createRoute({
      method: "put",
      path: "/v1/locations/{id}/downtime-places",
      tags: ["operations"],
      summary: "Set, and confirm, where the location keeps the paper MAR and the PEEPs",
      description:
        "Until the eMAR and PEEPs are in Harbour, the downtime pack says where these are kept. A place changed without `confirm` is unconfirmed again and prints as not set; confirming completes the task asking for it (H-201).",
      security,
      request: {
        params: Params,
        body: { content: { "application/json": { schema: SetDowntimePlaces } } },
      },
      responses: {
        200: jsonBody(DowntimePlaces, "The places"),
        ...errorResponses,
        ...notFoundResponse,
      },
    }),
    async (c) => {
      const access = await requirePermission(c, PLACES);
      const { id } = c.req.valid("param");
      const body = c.req.valid("json");
      requireReach(access, PLACES, id);
      const out = await withTenant(c, async (tx) => {
        const [row] = await tx
          .update(location)
          .set({
            downtimeMarLocation: body.marLocation,
            downtimePeepLocation: body.peepLocation,
            ...(body.confirm
              ? {
                  downtimePlacesConfirmedBy: access.tenantUserId,
                  downtimePlacesConfirmedAt: new Date(),
                }
              : {}),
          })
          .where(eq(location.id, id))
          .returning();
        if (!row) throw problems.notFound();
        if (row.downtimePlacesConfirmedAt) {
          await tx
            .update(task)
            .set({ status: "done", completedAt: new Date(), completedBy: access.tenantUserId })
            .where(
              and(
                eq(task.kind, DOWNTIME_PLACES_TASK),
                eq(task.sourceId, id),
                inArray(task.status, ["open", "in_progress"]),
              ),
            );
        }
        await audit(c, tx, access, {
          action: "operations.downtime_places.changed",
          resourceType: "location",
          resourceId: id,
          scope: { confirmed: row.downtimePlacesConfirmedAt !== null },
        });
        return {
          locationId: row.id,
          marLocation: row.downtimeMarLocation,
          peepLocation: row.downtimePeepLocation,
          confirmedAt: iso(row.downtimePlacesConfirmedAt),
          confirmedBy: row.downtimePlacesConfirmedBy,
        };
      });
      return c.json(out, 200);
    },
  );
