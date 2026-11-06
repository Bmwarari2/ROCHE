import {
  CertificateVerification,
  CreateShredRequest,
  DestructionCertificateItem,
  RefuseShredRequest,
  ShredApproved,
  ShredExportList,
  ShredRequestItem,
  ShredRequestList,
} from "@harbour/contracts";
import {
  destructionCertificate,
  type Transaction,
  tenantShredRequest,
  tenantUser,
} from "@harbour/db";
import {
  checkShredApproval,
  checkShredRefusal,
  checkShredRequest,
  type Permission,
  SHRED_REQUEST_EXPIRY_DAYS,
  scopeFor,
  shredRequestExpired,
  shredRequestExpiresAt,
} from "@harbour/domain";
import { createRoute, z } from "@hono/zod-openapi";
import { desc, eq, inArray } from "drizzle-orm";
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
import { publish } from "../outbox";
import { certificatePdf } from "../services/certificate-pdf";
import {
  backupDays,
  type CertificateRow,
  certificateItem,
  verifyCertificate,
} from "../services/certificates";
import { activeHolds } from "../services/documents";
import {
  completeShred,
  exportDownloaded,
  openRequests,
  requesterEligible,
  SHRED_APPROVED_EVENT,
  usableShredExports,
} from "../services/shred";
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
 * member asks, after downloading the organisation's full export; a different member approves
 * within 7 days, while the requester can still manage retention, each with a fresh step-up; an
 * active legal hold refuses both. Approval commits first, then the keys are destroyed and the
 * signed certificate issued (`completeShred`; the outbox finishes it if this request cannot).
 * Refusals are audited.
 */

const PERMISSION: Permission = "platform.retention.manage";
const Id = z.object({ id: z.uuid() });
const FORBIDDEN = new Set(["step_up_required", "same_person", "not_requester"]);
const INVALID = new Set(["reason_too_short", "export_not_downloaded"]);
const PDF_NAME = (id: string) => `destruction-certificate-${id}.pdf`;

type Row = typeof tenantShredRequest.$inferSelect;

type Names = ReadonlyMap<string, string>;

/** The display names of the members a set of requests names (screens only; ADR-0109 keeps them off certificates). */
async function namesOf(tx: Transaction, rows: readonly Row[]): Promise<Names> {
  const ids = [
    ...new Set(rows.flatMap((r) => [r.requestedBy, r.decidedBy]).filter((v): v is string => !!v)),
  ];
  if (ids.length === 0) return new Map();
  const found = await tx
    .select({ id: tenantUser.id, name: tenantUser.displayName })
    .from(tenantUser)
    .where(inArray(tenantUser.id, ids));
  return new Map(found.map((f) => [f.id, f.name]));
}

function item(row: Row, names: Names = new Map(), now = new Date()): ShredRequestItem {
  return {
    id: row.id,
    status: row.status as ShredRequestItem["status"],
    reason: row.reason,
    exportId: row.exportId,
    requestedBy: row.requestedBy,
    requestedByName: names.get(row.requestedBy) ?? null,
    requestedAt: row.requestedAt.toISOString(),
    expiresAt: shredRequestExpiresAt(row.requestedAt).toISOString(),
    lapsed: row.status === "pending" && shredRequestExpired(row.requestedAt, now),
    decidedBy: row.decidedBy,
    decidedByName: row.decidedBy ? (names.get(row.decidedBy) ?? null) : null,
    decidedAt: row.decidedAt?.toISOString() ?? null,
    decisionReason: row.decisionReason,
    certificateId: row.certificateId,
  };
}

/** One certificate, or 404; audited as `action`. */
async function loadCertificate(
  c: Context<AppEnv>,
  access: TenantAccess,
  id: string,
  action: string,
): Promise<CertificateRow> {
  return withTenant(c, async (tx) => {
    const [found] = await tx
      .select()
      .from(destructionCertificate)
      .where(eq(destructionCertificate.id, id));
    if (!found) throw problems.notFound();
    await auditInTx(tx, access, {
      action,
      resourceType: "destruction_certificate",
      resourceId: id,
      requestId: c.get("requestId"),
    });
    return found;
  });
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
        const names = await namesOf(tx, rows);
        return rows.map((r) => item(r, names));
      });
      return c.json({ items }, 200);
    },
  )
  .openapi(
    createRoute({
      method: "get",
      path: "/v1/retention/shred-exports",
      tags: ["platform"],
      summary: "The full exports a shred may follow",
      description:
        "Full exports downloaded within 30 days, newest download first: ids and times only, for choosing one when asking for a shred. Tenant-wide holders of platform.retention.manage.",
      security,
      responses: { 200: jsonBody(ShredExportList, "Exports"), ...errorResponses },
    }),
    async (c) => {
      await requireTenantWide(c);
      const items = await withTenant(c, (tx) => usableShredExports(tx, new Date()));
      return c.json(
        { items: items.map((e) => ({ id: e.id, downloadedAt: e.downloadedAt.toISOString() })) },
        200,
      );
    },
  )
  .openapi(
    createRoute({
      method: "post",
      path: "/v1/retention/shred-requests",
      tags: ["platform"],
      summary: "Ask for the organisation's records to be crypto-shredded",
      description:
        "Needs a fresh step-up, a reason of at least 20 characters (no names: it is kept on the certificate) and the organisation's full export, downloaded within 30 days. Refused while any legal hold is active or another request is open. A different member approves it within 7 days.",
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
          const verdict = checkShredRequest({
            stepUpFresh: stepUpFresh(access),
            reason: req.reason,
            exportDownloaded: await exportDownloaded(tx, req.exportId, new Date()),
            activeHolds: (await activeHolds(tx)).length,
            openRequests: await openRequests(tx),
          });
          if (!verdict.ok) refused(action, verdict.problem, verdict.message);
          const [inserted] = await tx
            .insert(tenantShredRequest)
            .values({
              reason: req.reason.trim(),
              exportId: req.exportId,
              requestedBy: access.tenantUserId,
            })
            .returning();
          if (!inserted) throw problems.conflict();
          await auditInTx(tx, access, {
            action,
            resourceType: "tenant_shred_request",
            resourceId: inserted.id,
            scope: { exportId: req.exportId },
            requestId: c.get("requestId"),
          });
          return item(inserted, await namesOf(tx, [inserted]));
        }),
      );
      return c.json(row, 201);
    },
  )
  .openapi(
    createRoute({
      method: "post",
      path: "/v1/retention/shred-requests/{id}/approve",
      tags: ["platform"],
      summary: "Approve a shred: the organisation's keys are scheduled for destruction",
      description:
        "A different member from the requester, with a fresh step-up, within 7 days of the request, while the requester can still manage retention, the export is still recent and no legal hold is active. The approval is recorded first (status shredding); then every version of the organisation's key is scheduled for destruction and a signed certificate is issued (status approved, 200). If the keys cannot be reached now, 202 says the worker will complete it. Afterwards stored documents, exports and DSAR bundles can no longer be read (410 shredded) and cannot be restored once the delay ends.",
      security,
      request: { params: Id },
      responses: {
        200: jsonBody(ShredApproved, "Shredded, with its certificate"),
        202: jsonBody(ShredApproved, "Approved; the worker is completing the shred"),
        ...errorResponses,
        ...notFoundResponse,
        ...conflictResponse,
      },
    }),
    async (c) => {
      const access = await requireTenantWide(c);
      const { id } = c.req.valid("param");
      const services = c.get("services");
      const action = "platform.retention.shred_approved";
      const approved = await withAuditedRefusal(c, access, () =>
        withTenant(c, async (tx) => {
          await lockRetention(tx, access.tenantId);
          const request = await pendingRequest(tx, id);
          const now = new Date();
          const verdict = checkShredApproval({
            stepUpFresh: stepUpFresh(access),
            status: request.status,
            requestedBy: request.requestedBy,
            requestedAt: request.requestedAt,
            approverId: access.tenantUserId,
            requesterEligible: await requesterEligible(tx, request.requestedBy),
            exportDownloaded: await exportDownloaded(tx, request.exportId, now),
            activeHolds: (await activeHolds(tx)).length,
            now,
          });
          if (!verdict.ok) refused(action, verdict.problem, verdict.message, id);
          const [row] = await tx
            .update(tenantShredRequest)
            .set({ status: "shredding", decidedBy: access.tenantUserId, decidedAt: now })
            .where(eq(tenantShredRequest.id, id))
            .returning();
          if (!row) throw problems.conflict();
          await publish(tx, {
            context: "platform",
            aggregateType: "tenant_shred_request",
            aggregateId: id,
            type: SHRED_APPROVED_EVENT,
            payload: { approverId: access.tenantUserId },
          });
          await auditInTx(tx, access, {
            action,
            resourceType: "tenant_shred_request",
            resourceId: id,
            requestId: c.get("requestId"),
          });
          return row;
        }),
      );
      // Committed: the approval stands. The keys go now; the outbox retries if this fails.
      const done = await completeShred(
        {
          appDb: services.db,
          tenantKeys: services.tenantKeys,
          dataKeyCache: services.dataKeyCache,
          backupDays: backupDays(services.config),
        },
        { tenantId: access.tenantId, requestId: id, approverId: access.tenantUserId },
      ).catch((error: unknown) => {
        services.logger.error(
          {
            requestId: c.get("requestId"),
            shredRequestId: id,
            err: { name: error instanceof Error ? error.name : "Error" },
          },
          "shred left for the worker to complete",
        );
        return null;
      });
      const request = done?.request ?? approved;
      const names = await withTenant(c, (tx) => namesOf(tx, [request]));
      if (done?.certificate) {
        return c.json(
          { request: item(request, names), certificate: certificateItem(done.certificate) },
          200,
        );
      }
      return c.json({ request: item(request, names), certificate: null }, 202);
    },
  )
  .openapi(
    createRoute({
      method: "post",
      path: "/v1/retention/shred-requests/{id}/refuse",
      tags: ["platform"],
      summary: "Refuse a pending shred request",
      description: `A different member from the requester, with a fresh step-up, within ${SHRED_REQUEST_EXPIRY_DAYS} days of the request, with a reason of 10 to 500 characters (no names). A refusal is final; a lapsed request is withdrawn instead (cancel).`,
      security,
      request: {
        params: Id,
        body: { content: { "application/json": { schema: RefuseShredRequest } } },
      },
      responses: {
        200: jsonBody(ShredRequestItem, "Refused"),
        ...errorResponses,
        ...notFoundResponse,
        ...conflictResponse,
      },
    }),
    async (c) => {
      const access = await requireTenantWide(c);
      const { id } = c.req.valid("param");
      const { reason } = c.req.valid("json");
      const action = "platform.retention.shred_refused";
      const row = await withAuditedRefusal(c, access, () =>
        withTenant(c, async (tx) => {
          const request = await pendingRequest(tx, id);
          const now = new Date();
          const verdict = checkShredRefusal({
            stepUpFresh: stepUpFresh(access),
            status: request.status,
            requestedBy: request.requestedBy,
            requestedAt: request.requestedAt,
            refuserId: access.tenantUserId,
            reason,
            now,
          });
          if (!verdict.ok) refused(action, verdict.problem, verdict.message, id);
          const [done] = await tx
            .update(tenantShredRequest)
            .set({
              status: "refused",
              decidedBy: access.tenantUserId,
              decidedAt: now,
              decisionReason: reason.trim(),
            })
            .where(eq(tenantShredRequest.id, id))
            .returning()
            .catch((error: unknown) => {
              // A reason the database counts differently is still a reason problem, never a 500.
              if ((error as { code?: string } | null)?.code === "23514") {
                refused(action, "reason_too_short", "Give the reason in 10 to 500 characters.", id);
              }
              throw error;
            });
          if (!done) throw problems.conflict();
          // The reason stays on the request; the audit carries the decision only.
          await auditInTx(tx, access, {
            action,
            resourceType: "tenant_shred_request",
            resourceId: id,
            requestId: c.get("requestId"),
          });
          return item(done, await namesOf(tx, [done]));
        }),
      );
      return c.json(row, 200);
    },
  )
  .openapi(
    createRoute({
      method: "post",
      path: "/v1/retention/shred-requests/{id}/cancel",
      tags: ["platform"],
      summary: "Cancel a pending shred request",
      description: `The requester may cancel their own pending request; any other holder may withdraw one more than ${SHRED_REQUEST_EXPIRY_DAYS} days old. An approved request (shredding or approved) cannot be cancelled.`,
      security,
      request: { params: Id },
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
          const own = request.requestedBy === access.tenantUserId;
          if (!own && !shredRequestExpired(request.requestedAt, new Date())) {
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
            ...(own ? {} : { reason: "expired" }),
            requestId: c.get("requestId"),
          });
          return item(cancelled, await namesOf(tx, [cancelled]));
        }),
      );
      return c.json(row, 200);
    },
  )
  .openapi(
    createRoute({
      method: "get",
      path: "/v1/destruction-certificates/{id}",
      tags: ["platform"],
      summary: "One destruction certificate",
      security,
      request: { params: Id },
      responses: {
        200: jsonBody(DestructionCertificateItem, "The certificate"),
        ...errorResponses,
        ...notFoundResponse,
      },
    }),
    async (c) => {
      const access = await requireTenantWide(c);
      const { id } = c.req.valid("param");
      const row = await loadCertificate(c, access, id, "platform.destruction_certificate.view");
      return c.json(certificateItem(row), 200);
    },
  )
  .openapi(
    createRoute({
      method: "get",
      path: "/v1/destruction-certificates/{id}/pdf",
      tags: ["platform"],
      summary: "A destruction certificate as a PDF",
      description:
        "Built on request from the stored, signed certificate (never stored: after a whole-organisation shred the organisation's documents no longer open). It states the signature check made when it was built, the signing key version and algorithm, the SHA-256, the signature, the exact signed body and when backups expire. Opaque ids only.",
      security,
      request: { params: Id },
      responses: {
        200: {
          description: "The certificate as a PDF",
          content: { "application/pdf": { schema: z.string().meta({ format: "binary" }) } },
        },
        ...errorResponses,
        ...notFoundResponse,
      },
    }),
    async (c) => {
      // No step-up: the certificate holds opaque ids and the reason only, no personal data
      // (platform.md rule 12; security review of PLAT-012 part 2, L3).
      const access = await requireTenantWide(c);
      const { id } = c.req.valid("param");
      const { tenantKeys } = c.get("services");
      const row = await loadCertificate(c, access, id, "platform.destruction_certificate.download");
      const checked = await verifyCertificate(tenantKeys, row);
      const bytes = certificatePdf(row, checked, new Date());
      return c.body(bytes as Uint8Array<ArrayBuffer>, 200, {
        "content-type": "application/pdf",
        "content-disposition": `attachment; filename="${PDF_NAME(row.id)}"`,
        "cache-control": "no-store",
        "x-content-type-options": "nosniff",
      });
    },
  )
  .openapi(
    createRoute({
      method: "get",
      path: "/v1/destruction-certificates/{id}/verification",
      tags: ["platform"],
      summary: "Check a destruction certificate's signature",
      description:
        "Rebuilds the certificate's canonical body from the stored record and checks its SHA-256 and its signature against Harbour's certificate key. The body is returned exactly as signed, so anyone with the published public key can check it independently.",
      security,
      request: { params: Id },
      responses: {
        200: jsonBody(CertificateVerification, "Checked"),
        ...errorResponses,
        ...notFoundResponse,
      },
    }),
    async (c) => {
      const access = await requirePermission(c, PERMISSION);
      const { id } = c.req.valid("param");
      const { tenantKeys } = c.get("services");
      const row = await loadCertificate(c, access, id, "platform.destruction_certificate.verify");
      const checked = await verifyCertificate(tenantKeys, row);
      return c.json(
        {
          valid: checked.valid,
          body: checked.body,
          signature: row.signature,
          signatureKey: row.signatureKey,
          signatureAlgorithm: row.signatureAlgorithm,
        },
        200,
      );
    },
  );
