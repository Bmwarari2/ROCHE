import {
  SyncDeviceReport,
  SyncDiscard,
  SyncDiscardResult,
  SyncToken,
  SyncUpload,
  SyncUploadResult,
} from "@harbour/contracts";
import { auditEvent, location, roleAssignment, tenantUser } from "@harbour/db";
import { hasClockDrift } from "@harbour/domain";
import {
  isValidWindowDays,
  OFFLINE_WINDOW_RATE_KEY,
  offlineWindowDays,
} from "@harbour/sync/streams";
import { createRoute, z } from "@hono/zod-openapi";
import { and, eq, inArray, isNull, sql } from "drizzle-orm";
import { auditInTx } from "../http/audit";
import { requirePermission, withTenant } from "../http/context";
import { problems } from "../http/problem";
import { PerUserQuota } from "../http/quota";
import {
  DISCARD_ACTIONS,
  DISCARD_OTHERS_PERMISSION,
  recordDeviceHold,
} from "../services/device-holds";
import { rateNumber } from "../services/rates";
import type { SyncTokenSigner } from "../sync/token";

/**
 * The window used when the rate table gives no usable figure: today (and tomorrow, for drift) only,
 * so a misconfigured tenant keeps less on its devices, never more. An alert is logged.
 */
const FAIL_SAFE_WINDOW_DAYS = 1;

/**
 * Per-user quotas on what a device sends on its own (security review round 4, M4). A device sends
 * a deletion's stages and its reports a few times an hour at most; a full window is a 429.
 */
const DISCARDS_PER_HOUR = 240;
const REPORTS_PER_HOUR = 120;
const HOUR_MS = 3_600_000;

import { createRouter, errorResponses, jsonBody, security } from "./openapi";

/**
 * Offline sync (sections 6 and 17): the API mints PowerSync tokens and applies client uploads. It
 * is authoritative: uploads are validated and written through the same permission checks and
 * row-level security as any other write. Phase 0 has no writable synced tables yet, so every
 * operation is rejected with a reason the device can show.
 */
const WRITABLE_TABLES = new Set<string>();

export function createSyncRouter(signer: SyncTokenSigner) {
  const discardQuota = new PerUserQuota(DISCARDS_PER_HOUR, HOUR_MS);
  const reportQuota = new PerUserQuota(REPORTS_PER_HOUR, HOUR_MS);
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
          const rated = await rateNumber(tx, access.tenantId, OFFLINE_WINDOW_RATE_KEY).catch(
            () => null,
          );
          const windowDays = isValidWindowDays(rated) ? rated : FAIL_SAFE_WINDOW_DAYS;
          if (windowDays !== rated) {
            // Opaque ids only: the tenant and the rate key, never the user or the people.
            c.get("services").logger.warn(
              { tenantId: access.tenantId, rateKey: OFFLINE_WINDOW_RATE_KEY },
              "offline window rate missing or out of range; using the fail-safe window",
            );
          }
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
    )
    .openapi(
      createRoute({
        method: "post",
        path: "/v1/sync/discards",
        tags: ["sync"],
        summary: "Record that a device deleted entries that never reached the server",
        description:
          "Writes an append-only audit event for one stage of a deletion (requested, deleted or failed): who deleted them, whose they were, the coded reason, how many and from which device (HZ-040). Anyone but the caller's own entries, deleted by the caller, needs a manager's permission. Each stage of an id is recorded once.",
        security,
        request: { body: { content: { "application/json": { schema: SyncDiscard } } } },
        responses: { 200: jsonBody(SyncDiscardResult, "Recorded"), ...errorResponses },
      }),
      async (c) => {
        const access = await requirePermission(c, "care.note.write");
        discardQuota.take(access.tenantUserId);
        const body = c.req.valid("json");
        const deleter = body.deletedByTenantUserId ?? access.tenantUserId;
        // Anyone's but the caller's own entries, deleted by the caller, need a manager: an unknown
        // owner, another member of staff's entries, or a deletion the device says someone else made
        // (security review round 4, M1). Registered Managers, deputies and nurses hold it.
        if (
          !body.ownerTenantUserId ||
          body.ownerTenantUserId !== access.tenantUserId ||
          deleter !== access.tenantUserId
        ) {
          await requirePermission(c, DISCARD_OTHERS_PERMISSION);
        }
        const action = DISCARD_ACTIONS[body.stage];
        const replay = await withTenant(c, async (tx) => {
          // The owner and the deleter must be staff of this organisation (row-level security keeps
          // the lookup inside the tenant).
          const staffIds = [
            ...new Set([body.ownerTenantUserId, deleter].filter((v) => v !== null)),
          ];
          if (staffIds.length > 0) {
            const staff = await tx
              .select({ id: tenantUser.id })
              .from(tenantUser)
              .where(inArray(tenantUser.id, staffIds));
            if (staff.length !== staffIds.length) {
              throw problems.invalid("The member of staff is not in this organisation.");
            }
          }
          // One record per stage of a deletion, even when two requests race (no index needed).
          await tx.execute(
            sql`SELECT pg_advisory_xact_lock(hashtext(${`device_discard:${action}:${body.id}`}))`,
          );
          const recorded = await tx
            .select({ id: auditEvent.id, action: auditEvent.action })
            .from(auditEvent)
            .where(
              and(
                eq(auditEvent.resourceType, "device_discard"),
                eq(auditEvent.resourceId, body.id),
              ),
            );
          if (recorded.some((r) => r.action === action)) return true;
          // A failure supersedes the request it follows (clinical review round 4, H1).
          const requested = recorded.find((r) => r.action === DISCARD_ACTIONS.requested);
          await auditInTx(tx, access, {
            action,
            resourceType: "device_discard",
            resourceId: body.id,
            // The coded reason only: the person's words never enter the hash-chained trail (M3).
            reason: body.reasonCode,
            scope: {
              kind: body.kind,
              stage: body.stage,
              reasonCode: body.reasonCode,
              ownerTenantUserId: body.ownerTenantUserId,
              // As the device recorded it; the event's actor is whoever sent this request.
              deletedByTenantUserId: deleter,
              entryIds: body.entryIds,
              personIds: body.personIds,
              count: body.count,
              discardedAt: body.discardedAt,
              ...(body.stage === "failed" && requested
                ? { supersedesAuditEventId: requested.id }
                : {}),
            },
            requestId: c.get("requestId"),
          });
          return false;
        });
        return c.json({ id: body.id, recorded: true, replay }, 200);
      },
    )
    .openapi(
      createRoute({
        method: "post",
        path: "/v1/sync/device-report",
        tags: ["sync"],
        summary: "A device's unsent work: counts and the oldest age, no personal data",
        description:
          "Writes an audit event with the device's queued, refused and held counts and the age of the oldest, so the server knows what a lost or wiped device held (HZ-006). While anything waits, the device has one task for the Registered Manager, due when its hold escalates; a report with nothing waiting closes it.",
        security,
        request: { body: { content: { "application/json": { schema: SyncDeviceReport } } } },
        responses: { 204: { description: "Recorded" }, ...errorResponses },
      }),
      async (c) => {
        const access = await requirePermission(c, "people.person.read");
        reportQuota.take(access.tenantUserId);
        const report = c.req.valid("json");
        await withTenant(c, (tx) =>
          auditInTx(tx, access, {
            action: "sync.device.report",
            scope: {
              unsent: report.unsent,
              refused: report.refused,
              held: report.held,
              oldestAgeSeconds: report.oldestAgeSeconds,
              heldSince: report.heldSince ?? null,
              reportedAt: report.reportedAt,
            },
            requestId: c.get("requestId"),
          }),
        );
        // The Registered Manager's task for this device (clinical review round 4, H2).
        await recordDeviceHold(c.get("services").db, access, access.deviceId, report, new Date());
        return c.body(null, 204);
      },
    );
}
