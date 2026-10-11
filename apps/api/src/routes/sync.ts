import { SyncToken, SyncUpload, SyncUploadResult } from "@harbour/contracts";
import { location, roleAssignment } from "@harbour/db";
import { hasClockDrift } from "@harbour/domain";
import { OFFLINE_WINDOW_RATE_KEY, offlineWindowDays } from "@harbour/sync/streams";
import { createRoute, z } from "@hono/zod-openapi";
import { and, eq, isNull } from "drizzle-orm";
import { auditInTx } from "../http/audit";
import { requirePermission, withTenant } from "../http/context";
import { rateNumber } from "../services/rates";
import type { SyncTokenSigner } from "../sync/token";
import { createRouter, errorResponses, jsonBody, security } from "./openapi";

/**
 * Offline sync (sections 6 and 17): the API mints PowerSync tokens and applies client uploads. It
 * is authoritative: uploads are validated and written through the same permission checks and
 * row-level security as any other write. Phase 0 has no writable synced tables yet, so every
 * operation is rejected with a reason the device can show.
 */
const WRITABLE_TABLES = new Set<string>();

export function createSyncRouter(signer: SyncTokenSigner) {
  return createRouter()
    .openapi(
      createRoute({
        method: "get",
        path: "/v1/sync/jwks",
        tags: ["sync"],
        summary: "Public keys PowerSync uses to verify sync tokens",
        responses: {
          200: jsonBody(z.object({ keys: z.array(z.record(z.string(), z.unknown())) }), "JWKS"),
        },
      }),
      async (c) => c.json(await signer.jwks(), 200),
    )
    .openapi(
      createRoute({
        method: "post",
        path: "/v1/sync/token",
        tags: ["sync"],
        summary: "A short-lived token for the PowerSync service, scoped to tenant and assignments",
        security,
        responses: { 200: jsonBody(SyncToken, "Token"), ...errorResponses },
      }),
      async (c) => {
        const access = await requirePermission(c, "people.person.read");
        const { config } = c.get("services");
        const claims = await withTenant(c, async (tx) => {
          const locations = await tx
            .select({ id: location.id })
            .from(location)
            .where(isNull(location.deletedAt));
          const assignments = await tx
            .select({ locationId: roleAssignment.locationId })
            .from(roleAssignment)
            .where(
              and(
                eq(roleAssignment.tenantUserId, access.tenantUserId),
                isNull(roleAssignment.deletedAt),
              ),
            );
          const allIds = locations.map((l) => l.id);
          const workIds = assignments.some((a) => a.locationId === null)
            ? allIds
            : allIds.filter((id) => assignments.some((a) => a.locationId === id));
          const peopleLocationIds =
            access.effective.scope === "tenant"
              ? allIds
              : access.effective.scope === "locations"
                ? [...access.effective.locationIds]
                : [];
          // The offline window comes from the rate table here, never from the device (care.md
          // section 6): the streams read it from this claim and ignore connection parameters.
          const windowDays = await rateNumber(tx, access.tenantId, OFFLINE_WINDOW_RATE_KEY);
          const offlineDays = offlineWindowDays(new Date(), windowDays);
          await auditInTx(tx, access, {
            action: "sync.token.issue",
            scope: {
              scope: access.effective.scope,
              peopleLocations: peopleLocationIds.length,
              offlineWindowDays: windowDays,
            },
            requestId: c.get("requestId"),
          });
          return {
            sub: access.tenantUserId,
            tenant_id: access.tenantId,
            location_ids: workIds,
            people_location_ids: peopleLocationIds,
            offline_days: offlineDays,
          };
        });
        const { token, expiresAt } = await signer.sign(claims);
        return c.json(
          { token, endpoint: config.POWERSYNC_URL, expiresAt: expiresAt.toISOString() },
          200,
        );
      },
    )
    .openapi(
      createRoute({
        method: "post",
        path: "/v1/sync/upload",
        tags: ["sync"],
        summary: "Apply a batch of offline changes from a device",
        security,
        request: { body: { content: { "application/json": { schema: SyncUpload } } } },
        responses: {
          200: jsonBody(SyncUploadResult, "Applied and rejected operations"),
          ...errorResponses,
        },
      }),
      async (c) => {
        const access = c.get("access");
        const { operations } = c.req.valid("json");
        const receivedAt = new Date();
        const drift = operations.some(
          (op) =>
            op.deviceSentAt !== undefined && hasClockDrift(new Date(op.deviceSentAt), receivedAt),
        );
        const rejected = operations
          .filter((op) => !WRITABLE_TABLES.has(op.table))
          .map((op) => ({
            id: op.id,
            code: "table_not_writable",
            message: "This kind of record cannot be changed from a device yet.",
          }));
        await withTenant(c, (tx) =>
          auditInTx(tx, access, {
            action: "sync.upload",
            outcome: rejected.length > 0 ? "denied" : "success",
            scope: { operations: operations.length, rejected: rejected.length, clockDrift: drift },
            requestId: c.get("requestId"),
          }),
        );
        return c.json({ applied: operations.length - rejected.length, rejected }, 200);
      },
    );
}
