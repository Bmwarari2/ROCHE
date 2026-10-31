import { AccountDeletionRequest, Me, Membership } from "@harbour/contracts";
import { featureFlag, location, tenant } from "@harbour/db";
import { scopeFor } from "@harbour/domain";
import { createRoute, z } from "@hono/zod-openapi";
import { eq, isNull } from "drizzle-orm";
import { membershipsFor, withTenant } from "../http/context";
import { problems } from "../http/problem";
import { requireWithinLimit } from "../http/rate-limit";
import { accessRowsOfMember, workLocationIds } from "../services/access-rows";
import { requestAccountDeletion } from "../services/account-deletion";
import { sampleDataState } from "../services/onboarding";
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

export const meRouter = createRouter()
  .openapi(
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
          // The sample data banner (HZ-072): the whole organisation, yes or no only.
          sampleData: (await sampleDataState(tx)).hasSample,
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
  )
  .openapi(
    createRoute({
      method: "post",
      path: "/v1/me/account-deletion-request",
      tags: ["platform"],
      summary: "Ask for your own account to be deleted (MOB-011; App Store and Google Play)",
      description:
        "Any member, for their own account. Staff accounts belong to the care provider, so this raises one task for a Registered Manager (else whoever holds platform.user.manage) due within `account_deletion.confirmation_days`, notifies them and audits the request. Nothing is deleted, and care records never are by this route. A second request while the first is open returns the first (`already_requested`).",
      security,
      responses: {
        200: jsonBody(AccountDeletionRequest, "Already requested"),
        201: jsonBody(AccountDeletionRequest, "Requested"),
        ...errorResponses,
      },
    }),
    async (c) => {
      const access = c.get("access");
      // Each request can email a manager: a few a day per member (security review round 1).
      await requireWithinLimit(
        c.get("services").db,
        access,
        c.get("services").accountDeletionLimiter,
      );
      const out = await requestAccountDeletion(c.get("services").db, access, c.get("requestId"));
      return out.status === "requested" ? c.json(out, 201) : c.json(out, 200);
    },
  );
