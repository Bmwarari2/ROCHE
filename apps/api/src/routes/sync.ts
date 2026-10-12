import {
  SyncDeviceReport,
  SyncDiscard,
  SyncDiscardResult,
  SyncToken,
  SyncUpload,
  SyncUploadResult,
} from "@harbour/contracts";
import { auditEvent, deviceDiscardEntry, location, roleAssignment, tenantUser } from "@harbour/db";
import { hasClockDrift } from "@harbour/domain";
import {
  isValidWindowDays,
  OFFLINE_WINDOW_RATE_KEY,
  offlineWindowDays,
} from "@harbour/sync/streams";
import { createRoute, z } from "@hono/zod-openapi";
import { and, asc, eq, inArray, isNull, sql } from "drizzle-orm";
import { auditInTx } from "../http/audit";
import { requirePermission, withTenant } from "../http/context";
import { problems } from "../http/problem";
import { PerUserQuota } from "../http/quota";
import {
  closeDeviceHoldOnDeletion,
  DISCARD_ACTIONS,
  DISCARD_OTHERS_PERMISSION,
  flagEntriesAlreadyUploaded,
  recordDeviceHold,
} from "../services/device-holds";
import { bindDevice, inSystemView, refuseRevokedDevice } from "../services/devices";
import { rateNumber } from "../services/rates";
import type { SyncTokenSigner } from "../sync/token";

/**
 * The window used when the rate table gives no usable figure: today (and tomorrow, for drift) only,
 * so a misconfigured tenant keeps less on its devices, never more. An alert is logged.
 */
const FAIL_SAFE_WINDOW_DAYS = 1;

/**
 * Per-user quotas on what a device sends on its own (security reviews round 4, M4 and round 5,
 * S-M2). Real use is a deletion now and then (two stages each, sent again a few times when the
 * network fails) and a report after each sync; a full window is a 429, which the device reads as
 * "try again later". Each deletion record lists at most 500 entry ids, and each person's new
 * records list at most a day's worth, so one token cannot grow the hash-chained audit trail for
 * good. Each person starts at most 20 deletion records a day, with or without ids (security review
 * round 6, M2 remainder): a record with no ids costs nothing against the id quota.
 */
const DISCARDS_PER_HOUR = 30;
const DISCARD_RECORDS_PER_DAY = 20;
const DISCARD_IDS_PER_DAY = 2_000;
const REPORTS_PER_HOUR = 120;
const HOUR_MS = 3_600_000;
const DAY_MS = 86_400_000;

/** Deletions that remove a device's whole hold (or its unsent work at sign-out). */
const WHOLE_HOLD_KINDS: ReadonlySet<string> = new Set(["held_deleted", "signed_out_with_unsent"]);

import { createRouter, errorResponses, jsonBody, security } from "./openapi";

/**
 * Offline sync (sections 6 and 17): the API mints PowerSync tokens and applies client uploads. It
 * is authoritative: uploads are validated and written through the same permission checks and
 * row-level security as any other write. Phase 0 has no writable synced tables yet, so every
 * operation is rejected with a reason the device can show.
 */
const WRITABLE_TABLES = new Set<string>();

export function createSyncRouter(signer: SyncTokenSigner) {
  const discardQuota = new PerUserQuota("sync.discards", DISCARDS_PER_HOUR, HOUR_MS);
  const discardRecordsQuota = new PerUserQuota(
    "sync.discard_records",
    DISCARD_RECORDS_PER_DAY,
    DAY_MS,
  );
  const discardIdsQuota = new PerUserQuota("sync.discard_ids", DISCARD_IDS_PER_DAY, DAY_MS);
  const reportQuota = new PerUserQuota("sync.reports", REPORTS_PER_HOUR, HOUR_MS);
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
        description:
          "Claims: sub, tenant_id, location_ids, people_location_ids and offline_days (the offline window from the rate table, never from the device). The device the request names (x-harbour-device) is bound to the member; a device a manager revoked is refused with 403 device_revoked, which the device reads apart from an expired session (401) and the session codes.",
        security,
        responses: { 200: jsonBody(SyncToken, "Token"), ...errorResponses },
      }),
      async (c) => {
        const access = await requirePermission(c, "people.person.read");
        const { config } = c.get("services");
        // A revoked device never gets another token (care.md section 6, Device integrity part 2).
        await refuseRevokedDevice(c.get("services"), access, "sync.token", c.get("requestId"));
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
            // The device the token is for, when it says; the binding itself is `device_binding`.
            ...(access.deviceId ? { resourceType: "device", resourceId: access.deviceId } : {}),
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
        // The member has used this device (care.md section 6, Device integrity part 1): written in
        // the system's view, so a hold report naming them as its owner counts.
        const deviceId = access.deviceId;
        if (deviceId) {
          await inSystemView(c.get("services").db, access, (tx) =>
            bindDevice(tx, deviceId, access.tenantUserId, new Date(), access.session.sessionId),
          );
        }
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
        await refuseRevokedDevice(c.get("services"), access, "sync.upload", c.get("requestId"));
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
          "Writes an append-only audit event for one stage of a deletion (requested, deleted or failed): who deleted them, whose they were, the coded reason, how many and from which device (HZ-040). Anyone but the caller's own entries, deleted by the caller, needs a manager's permission. Each stage of an id is recorded once, and later stages must match the first (kind and owner) and come from its sender, the owner or a manager. Each person starts at most 20 deletion records a day. A deletion recorded as deleted closes the hold tasks of the device it names (or the sender's) when the sender owns the hold, raised its task or can act on it there, and listed entries already on the server are counted on one review task for the record.",
        security,
        request: { body: { content: { "application/json": { schema: SyncDiscard } } } },
        responses: { 200: jsonBody(SyncDiscardResult, "Recorded"), ...errorResponses },
      }),
      async (c) => {
        const access = await requirePermission(c, "care.note.write");
        await withTenant(c, (tx) => discardQuota.take(tx, access.tenantUserId));
        const body = c.req.valid("json");
        // Who deleted, as the device recorded it; unknown stays unknown in the record (security
        // review round 5, S-L2). For the permission decision only, an unknown deleter is the caller.
        const recordedDeleter = body.deletedByTenantUserId ?? null;
        const deleter = recordedDeleter ?? access.tenantUserId;
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
        const { replay } = await withTenant(c, async (tx) => {
          // The owner and the deleter must be staff of this organisation (row-level security keeps
          // the lookup inside the tenant).
          const staffIds = [
            ...new Set([body.ownerTenantUserId, recordedDeleter].filter((v) => v !== null)),
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
            .select({
              id: auditEvent.id,
              action: auditEvent.action,
              actor: auditEvent.actorTenantUserId,
              scope: auditEvent.scope,
            })
            .from(auditEvent)
            .where(
              and(
                eq(auditEvent.resourceType, "device_discard"),
                eq(auditEvent.resourceId, body.id),
              ),
            )
            .orderBy(asc(auditEvent.seq));
          // A later stage belongs to the deletion it continues (security review round 5, S-L1):
          // the same kind and owner, from the same sender, the owner, or a manager.
          const [earliest] = recorded;
          if (earliest) {
            const was = (earliest.scope ?? {}) as { kind?: unknown; ownerTenantUserId?: unknown };
            if (
              was.kind !== body.kind ||
              (was.ownerTenantUserId ?? null) !== body.ownerTenantUserId
            ) {
              throw problems.invalid("This deletion was recorded for other entries.");
            }
            if (
              earliest.actor !== access.tenantUserId &&
              body.ownerTenantUserId !== access.tenantUserId
            ) {
              await requirePermission(c, DISCARD_OTHERS_PERMISSION);
            }
          }
          if (recorded.some((r) => r.action === action)) return { replay: true };
          // A new deletion counts against the sender's day: one record, and its entry ids (S-M2;
          // security review round 6, M2 remainder).
          if (!earliest) {
            await discardRecordsQuota.check(tx, access.tenantUserId);
            await discardIdsQuota.take(tx, access.tenantUserId, body.entryIds.length);
            await discardRecordsQuota.take(tx, access.tenantUserId);
          }
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
              deletedByTenantUserId: recordedDeleter,
              entryIds: body.entryIds,
              personIds: body.personIds,
              count: body.count,
              discardedAt: body.discardedAt,
              ...(body.idsMissing ? { idsMissing: body.idsMissing } : {}),
              // The device the entries were held on, when it differs from the sender's now.
              ...(body.deviceId ? { heldOnDeviceId: body.deviceId } : {}),
              ...(body.stage === "failed" && requested
                ? { supersedesAuditEventId: requested.id }
                : {}),
            },
            requestId: c.get("requestId"),
          });
          // The entry ids this stage lists, one row each, so an upload finds its deletion by an
          // index (care.md section 6, Device integrity part 3; the HZ-040 go-live blocker).
          if (body.entryIds.length > 0) {
            await tx
              .insert(deviceDiscardEntry)
              .values(
                [...new Set(body.entryIds.map((id) => id.toLowerCase()))].map((entryId) => ({
                  discardId: body.id,
                  stage: body.stage,
                  entryId,
                  ownerTenantUserId: body.ownerTenantUserId,
                })),
              )
              .onConflictDoNothing();
          }
          // Part of the database left on the device after its entries became unreadable is a
          // security event of its own (clinical review round 5, C-M1).
          if (body.stage === "deleted" && body.leftover && body.leftover.length > 0) {
            await auditInTx(tx, access, {
              action: "sync.device.residue",
              resourceType: "device_discard",
              resourceId: body.id,
              scope: { leftover: body.leftover },
              requestId: c.get("requestId"),
            });
          }
          return { replay: false };
        });
        if (!replay) {
          const services = c.get("services");
          const requestId = c.get("requestId");
          // The device's hold is gone: its tasks close (clinical review round 5, C-M3), found by
          // the device the deletion names, since a stage sent later comes from the device's next
          // database (clinical review round 6, M1).
          if (body.stage === "deleted" && WHOLE_HOLD_KINDS.has(body.kind)) {
            await closeDeviceHoldOnDeletion(
              services.db,
              access,
              body.deviceId ?? access.deviceId,
              new Date(),
              requestId,
            );
          }
          // Listed entries the server already had are flagged once the deletion is done (C-L2;
          // security review round 6, N1).
          if (body.stage === "deleted") {
            await flagEntriesAlreadyUploaded(services.db, access, body, requestId);
          }
        }
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
          "Writes an audit event with the device's queued, refused, held and blocked counts and the age of the oldest, so the server knows what a lost or wiped device held (HZ-006). Any member of the organisation may report (with MFA when their roles call for it), so a device whose Care mode access was withdrawn can still report its hold. A named owner counts only when bound to the device (a sync token issued to it or a report sent from it, kept as a device binding); otherwise the claim is recorded and changes nothing. Times later than the server's are taken as the server's, and a hold's start is never earlier than the device's last report for it said, nor than the server first saw the device. While anything waits, the device has a task for the Registered Manager at each location of its sync scope where the hold's owner or the reporter works, due when its hold escalates and never moved later; one closed in the last day is reopened, its escalation reset at most once a day. A report with nothing waiting closes them when it comes from the hold's owner, from whoever raised them or from a manager at one of their locations. Each reporter raises tasks for a few devices a day; past that, their holds join one task for that reporter, due at the earliest of them.",
        security,
        request: { body: { content: { "application/json": { schema: SyncDeviceReport } } } },
        responses: { 204: { description: "Recorded" }, ...errorResponses },
      }),
      async (c) => {
        // Any member of the organisation may report what their device holds: counts and times, no
        // personal data. A hold often starts because the access Care mode needs was withdrawn, and
        // its report must still get through at once (clinical review round 4, H2). What a member
        // can do with it is bounded (security reviews rounds 5 to 7): raise a task for a few
        // devices a day, bring a due time earlier, and close only a task for a hold they own or
        // raised, unless they can act on it at its location; naming an owner who has never used the
        // device changes nothing. MFA is asked wherever the member's roles call for it, as on the
        // care routes.
        const access = c.get("access");
        if (!access.mfaSatisfied) throw problems.mfaRequired();
        await withTenant(c, (tx) => reportQuota.take(tx, access.tenantUserId));
        const report = c.req.valid("json");
        const receivedAt = new Date();
        // The hold's owner must be staff of this organisation (row-level security keeps the lookup
        // inside the tenant): they may close the task (clinical review round 6, M1).
        const owner = report.ownerTenantUserId ?? null;
        if (owner && owner !== access.tenantUserId) {
          const [member] = await withTenant(c, (tx) =>
            tx.select({ id: tenantUser.id }).from(tenantUser).where(eq(tenantUser.id, owner)),
          );
          if (!member) throw problems.invalid("The member of staff is not in this organisation.");
        }
        // The audit event and the Registered Manager's task for this device (clinical review
        // round 4, H2).
        await recordDeviceHold(
          c.get("services").db,
          access,
          access.deviceId,
          report,
          receivedAt,
          c.get("requestId"),
        );
        return c.body(null, 204);
      },
    );
}
