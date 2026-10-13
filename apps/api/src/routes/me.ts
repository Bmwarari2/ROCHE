import { Me, Membership } from "@harbour/contracts";
import { featureFlag, location, tenant } from "@harbour/db";
import { scopeFor } from "@harbour/domain";
import { createRoute, z } from "@hono/zod-openapi";
import { eq, isNull } from "drizzle-orm";
import { membershipsFor, withTenant } from "../http/context";
import { problems } from "../http/problem";
import { accessRowsOfMember, workLocationIds } from "../services/access-rows";
import { createRouter, errorResponses, jsonBody, security } from "./openapi";

export const membershipsRouter = createRouter().openapi(
  createRoute({
    method: "get",
    path: "/v1/memberships",
    tags: ["platform"],
    summary: "Organisations the signed-in person belongs to",
    security,
    responses: {
      200: jsonBody(z.object({ items: z.array(Membership) }), "Memberships"),
      401: errorResponses[401],
    },
  }),
  async (c) => {
    const session = c.get("session");
    if (!session) throw problems.unauthenticated();
    const items = await membershipsFor(c.get("services").appPool, session.authUserId);
    return c.json(
      { items: items.map(({ tenantId, tenantName }) => ({ tenantId, tenantName })) },
      200,
    );
  },
);

export const meRouter = createRouter().openapi(
  createRoute({
    method: "get",
    path: "/v1/me",
    tags: ["platform"],
    summary: "The signed-in user, their active organisation and effective access",
    security,
    responses: { 200: jsonBody(Me, "Current user"), ...errorResponses },
  }),
  async (c) => {
    const access = c.get("access");
    const body = await withTenant(c, async (tx) => {
      const [t] = await tx.select().from(tenant).where(eq(tenant.id, access.tenantId));
      if (!t) throw problems.notFound();
      const allLocations = await tx
        .select()
        .from(location)
        .where(isNull(location.deletedAt))
        .orderBy(location.name);
      // Where the member works: their roles in force now, at a location, or across the
      // organisation for a role scoped to it or marked organisation-wide (`workLocationIds`, the
      // same list as the sync token's; ADR-0071 review round 2).
      const working = new Set(
        workLocationIds(
          await accessRowsOfMember(tx, access.tenantUserId),
          allLocations.map((l) => l.id),
          new Date(),
        ),
      );
      const locations = allLocations.filter((l) => working.has(l.id));
      // The organisation's own rows, deleted ones left out; evaluated after the transaction, so
      // a slow Flagsmith never holds a database connection.
      const overrides = await tx
        .select({
          flagKey: featureFlag.flagKey,
          locationId: featureFlag.locationId,
          enabled: featureFlag.enabled,
        })
        .from(featureFlag)
        .where(isNull(featureFlag.deletedAt));
      return {
        user: {
          id: access.session.authUserId,
          name: access.session.name,
          email: access.session.email,
        },
        tenant: {
          id: t.id,
          name: t.brandName ?? t.name,
          terminology: t.terminology,
          brandAccent: t.brandAccent,
          nation: t.nation,
        },
        tenantUserId: access.tenantUserId,
        memberships: access.memberships.map(({ tenantId, tenantName }) => ({
          tenantId,
          tenantName,
        })),
        locations: locations.map((l) => ({
          id: l.id,
          name: l.name,
          regulator: l.regulator,
          regulatorLocationId: l.regulatorLocationId,
          nation: l.nation,
        })),
        permissions: [...access.effective.permissions].sort(),
        roleKeys: [...access.effective.roleKeys],
        // Whose records the user may open (ADR-0071): each permission has its own scope.
        scope: scopeFor(access.effective, "people.person.read").scope,
        overrides,
      };
    });
    const { overrides, ...rest } = body;
    // Organisation-wide, as before: the OpenFeature provider (apps/api/src/flags).
    const flags = await c
      .get("services")
      .flags.evaluateAll({ tenantId: access.tenantId, locationId: null, overrides });
    return c.json({ ...rest, flags }, 200);
  },
);
