import {
  CreateShredRequest,
  ShredApproved,
  ShredRequestItem,
  ShredRequestList,
} from "@harbour/contracts";
import { type Transaction, tenantShredRequest } from "@harbour/db";
import { checkShredApproval, checkShredRequest, type Permission, scopeFor } from "@harbour/domain";
import { createRoute, z } from "@hono/zod-openapi";
import { desc, eq } from "drizzle-orm";
import type { Context } from "hono";
import { AuditedRefusal, auditInTx, withAuditedRefusal } from "../http/audit";
import {
  type AppEnv,
  requirePermission,
  stepUpFresh,
  type TenantAccess,
  withTenant,
} from "../http/context";
import { HttpProblem, problems } from "../http/problem";
import { certificateItem, issueCertificate } from "../services/certificates";
import { activeHolds } from "../services/documents";
import { lockRetention } from "./documents";
import {
  conflictResponse,
  createRouter,
  errorResponses,
  jsonBody,
  notFoundResponse,
  security,
} from "./openapi";

/**
 * Whole-organisation crypto-shredding (PLAT-012; platform.md, Crypto-shredding; ADR-0109). One
 * member asks, a different member approves, each with a fresh step-up; an active legal hold
 * refuses both. Approval schedules every version of the organisation's key for destruction and
 * issues a signed certificate in the same transaction: if anything after the keys fails, the
 * transaction rolls back, the request stays pending and approving again (the key provider's shred
 * is idempotent) completes it. Refusals are audited.
 */

const PERMISSION: Permission = "platform.retention.manage";
const ShredRequestId = z.object({ id: z.uuid() });
const RECORD_CLASS = "organisation_exit";
const FORBIDDEN = new Set(["step_up_required", "same_person", "not_requester"]);
const INVALID = new Set(["reason_too_short", "export_not_confirmed"]);

type Row = typeof tenantShredRequest.$inferSelect;

function item(row: Row): ShredRequestItem {
  return {
    id: row.id,
    status: row.status as ShredRequestItem["status"],
    reason: row.reason,
    exportConfirmed: row.exportConfirmed,
    requestedBy: row.requestedBy,
    requestedAt: row.requestedAt.toISOString(),
    decidedBy: row.decidedBy,
    decidedAt: row.decidedAt?.toISOString() ?? null,
    certificateId: row.certificateId,
  };
}

/** Records-management decisions are tenant-wide: a location-scoped holder is refused here too. */
async function requireTenantWide(c: Context<AppEnv>): Promise<TenantAccess> {
  const access = await requirePermission(c, PERMISSION);
  if (scopeFor(access.effective, PERMISSION).scope !== "tenant") throw problems.forbidden();
  return access;
}

function refused(action: string, problem: string, message: string, id?: string): never {
  const status = FORBIDDEN.has(problem) ? 403 : INVALID.has(problem) ? 422 : 409;
  throw new AuditedRefusal(new HttpProblem(status, problem, "The shred was not made.", message), {
    action,
    outcome: "denied",
    resourceType: "tenant_shred_request",
    ...(id ? { resourceId: id } : {}),
    reason: problem,
  });
}

/**
 * The request, locked while it is pending. The decide policy hides a decided request from
 * `FOR UPDATE`, so it is read first and locked only while pending; one decided meanwhile comes
 * back as it now stands, and the domain check refuses it as no longer pending.
 */
async function pendingRequest(tx: Transaction, id: string): Promise<Row> {
  const [row] = await tx.select().from(tenantShredRequest).where(eq(tenantShredRequest.id, id));
  if (!row) throw problems.notFound();
  if (row.status !== "pending") return row;
  const [locked] = await tx
    .select()
    .from(tenantShredRequest)
    .where(eq(tenantShredRequest.id, id))
    .for("update");
  return locked ?? { ...row, status: "decided" };
}

export const shredRouter = createRouter()
  .openapi(
    createRoute({
      method: "get",
      path: "/v1/retention/shred-requests",
      tags: ["platform"],
      summary: "Whole-organisation shred requests",
      security,
      responses: { 200: jsonBody(ShredRequestList, "Requests"), ...errorResponses },
    }),
    async (c) => {
      const access = await requireTenantWide(c);
      const items = await withTenant(c, async (tx) => {
        const rows = await tx
          .select()
          .from(tenantShredRequest)
          .orderBy(desc(tenantShredRequest.requestedAt))
          .limit(100);
        await auditInTx(tx, access, {
          action: "platform.retention.shred_request.list",
          resourceType: "tenant_shred_request",
          scope: { count: rows.length },
          requestId: c.get("requestId"),
        });
        return rows.map(item);
      });
      return c.json({ items }, 200);
    },
  )
  .openapi(
    createRoute({
      method: "post",
      path: "/v1/retention/shred-requests",
      tags: ["platform"],
      summary: "Ask for the organisation's records to be crypto-shredded",
      description:
        "Needs a fresh step-up, a reason of at least 20 characters and confirmation that the organisation's full export has been taken. Refused while any legal hold is active or another request is pending. A different member approves it.",
      security,
      request: { body: { content: { "application/json": { schema: CreateShredRequest } } } },
      responses: {
        201: jsonBody(ShredRequestItem, "Requested"),
        ...errorResponses,
        ...conflictResponse,
      },
    }),
    async (c) => {
      const access = await requireTenantWide(c);
      const req = c.req.valid("json");
      const action = "platform.retention.shred_requested";
      const row = await withAuditedRefusal(c, access, () =>
        withTenant(c, async (tx) => {
          await lockRetention(tx, access.tenantId);
          const pending = await tx
            .select({ id: tenantShredRequest.id })
            .from(tenantShredRequest)
            .where(eq(tenantShredRequest.status, "pending"));
          const verdict = checkShredRequest({
            stepUpFresh: stepUpFresh(access),
            reason: req.reason,
            exportConfirmed: req.exportConfirmed,
            activeHolds: (await activeHolds(tx)).length,
            pendingRequests: pending.length,
          });
          if (!verdict.ok) refused(action, verdict.problem, verdict.message);
          const [inserted] = await tx
            .insert(tenantShredRequest)
            .values({
              reason: req.reason.trim(),
              exportConfirmed: req.exportConfirmed,
              requestedBy: access.tenantUserId,
            })
            .returning();
          if (!inserted) throw problems.conflict();
          await auditInTx(tx, access, {
            action,
            resourceType: "tenant_shred_request",
            resourceId: inserted.id,
            reason: inserted.reason,
            requestId: c.get("requestId"),
          });
          return inserted;
        }),
      );
      return c.json(item(row), 201);
    },
  )
  .openapi(
    createRoute({
      method: "post",
      path: "/v1/retention/shred-requests/{id}/approve",
      tags: ["platform"],
      summary: "Approve a shred: the organisation's keys are scheduled for destruction",
      description:
        "A different member from the requester, with a fresh step-up, while no legal hold is active. Every version of the organisation's key is scheduled for destruction: its stored documents, exports and DSAR bundles can no longer be read (410 shredded) and cannot be restored once the delay ends. Issues a signed destruction certificate naming both people and the key versions.",
      security,
      request: { params: ShredRequestId },
      responses: {
        200: jsonBody(ShredApproved, "Shredded"),
        ...errorResponses,
        ...notFoundResponse,
        ...conflictResponse,
      },
    }),
    async (c) => {
      const access = await requireTenantWide(c);
      const { id } = c.req.valid("param");
      const { tenantKeys, dataKeyCache, config } = c.get("services");
      const action = "platform.retention.shred_approved";
      const out = await withAuditedRefusal(c, access, () =>
        withTenant(c, async (tx) => {
          await lockRetention(tx, access.tenantId);
          const request = await pendingRequest(tx, id);
          const verdict = checkShredApproval({
            stepUpFresh: stepUpFresh(access),
            status: request.status,
            requestedBy: request.requestedBy,
            approverId: access.tenantUserId,
            activeHolds: (await activeHolds(tx)).length,
          });
          if (!verdict.ok) refused(action, verdict.problem, verdict.message, id);
          const executedAt = new Date();
          const keyVersions = await tenantKeys.shred(access.tenantId);
          // A cached data key must not outlive the shred in this process (ADR-0109).
          dataKeyCache.forgetTenant(access.tenantId);
          const certificate = await issueCertificate(tx, tenantKeys, {
            tenantId: access.tenantId,
            recordClass: RECORD_CLASS,
            subjectType: "tenant",
            subjectIds: [access.tenantId],
            recordCount: keyVersions.length,
            retentionRule: { trigger: "tenant_exit", source: "retention-and-deletion.md" },
            reason: request.reason,
            method: `kms_key_destroy:${tenantKeys.provider}`,
            executedAt,
            requestedBy: request.requestedBy,
            approvedBy: access.tenantUserId,
            keyVersions,
            pitrDays: config.DATABASE_PITR_DAYS,
          });
          const [approved] = await tx
            .update(tenantShredRequest)
            .set({
              status: "approved",
              decidedBy: access.tenantUserId,
              decidedAt: executedAt,
              certificateId: certificate.id,
            })
            .where(eq(tenantShredRequest.id, id))
            .returning();
          if (!approved) throw problems.conflict();
          await auditInTx(tx, access, {
            action,
            resourceType: "tenant_shred_request",
            resourceId: id,
            scope: { certificateId: certificate.id, keyVersions: keyVersions.length },
            requestId: c.get("requestId"),
          });
          return { request: item(approved), certificate: certificateItem(certificate) };
        }),
      );
      return c.json(out, 200);
    },
  )
  .openapi(
    createRoute({
      method: "post",
      path: "/v1/retention/shred-requests/{id}/cancel",
      tags: ["platform"],
      summary: "Cancel your own pending shred request",
      security,
      request: { params: ShredRequestId },
      responses: {
        200: jsonBody(ShredRequestItem, "Cancelled"),
        ...errorResponses,
        ...notFoundResponse,
        ...conflictResponse,
      },
    }),
    async (c) => {
      const access = await requireTenantWide(c);
      const { id } = c.req.valid("param");
      const action = "platform.retention.shred_cancelled";
      const row = await withAuditedRefusal(c, access, () =>
        withTenant(c, async (tx) => {
          const request = await pendingRequest(tx, id);
          if (!stepUpFresh(access)) {
            refused(action, "step_up_required", "Confirm it is you before cancelling.", id);
          }
          if (request.status !== "pending") {
            refused(action, "not_pending", "This shred is no longer waiting for approval.", id);
          }
          if (request.requestedBy !== access.tenantUserId) {
            refused(action, "not_requester", "Only the person who asked can cancel it.", id);
          }
          const [cancelled] = await tx
            .update(tenantShredRequest)
            .set({ status: "cancelled", decidedBy: access.tenantUserId, decidedAt: new Date() })
            .where(eq(tenantShredRequest.id, id))
            .returning();
          if (!cancelled) throw problems.conflict();
          await auditInTx(tx, access, {
            action,
            resourceType: "tenant_shred_request",
            resourceId: id,
            requestId: c.get("requestId"),
          });
          return cancelled;
        }),
      );
      return c.json(item(row), 200);
    },
  );
