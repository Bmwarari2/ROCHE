import {
  auditEvent,
  type Database,
  destructionCertificate,
  type Transaction,
  tenantExport,
  tenantShredRequest,
  tenantUser,
  withRequestContext,
} from "@harbour/db";
import { shredExportUsable, type TenantKeyPort } from "@harbour/domain";
import { and, eq, inArray, sql } from "drizzle-orm";
import type { DataKeyCache } from "../integrations/envelope";
import { type CertificateRow, issueCertificate } from "./certificates";

/**
 * Whole-organisation crypto-shredding (PLAT-012, ADR-0109), in two steps so that destroying the
 * keys, which cannot be undone, never happens inside a transaction that can still roll back
 * (security review of PLAT-012, H1):
 *
 * 1. Approval commits the decision first: the request moves to `shredding` with its approver,
 *    the approval is audited and a `platform.tenant.shred_approved` outbox event is published,
 *    all under the organisation's retention lock. From then on the request cannot be cancelled and
 *    no legal hold can be placed.
 * 2. Completion (`completeShred`) destroys every key version, forgets cached data keys, then
 *    issues the signed certificate and moves the request to `approved`. The API runs it at once;
 *    if it fails, the outbox event runs it again until it succeeds (the key provider's shred is
 *    idempotent), and each failure is logged as `worker.job.failed`.
 */

export const SHRED_APPROVED_EVENT = "platform.tenant.shred_approved";
export const SHRED_RECORD_CLASS = "organisation_exit";

export interface ShredDeps {
  readonly appDb: Database;
  readonly tenantKeys: TenantKeyPort;
  readonly dataKeyCache?: DataKeyCache;
  /** `backupDays(config)`. */
  readonly backupDays: number;
}

type RequestRow = typeof tenantShredRequest.$inferSelect;

/**
 * Runs `fn` with `app.user_id` set to another value for the duration, then puts it back. Used
 * only for reads that row-level security words in terms of the current user: whether the
 * requester still holds the permission, and the export (readable without a member in tenant
 * scope, as the export worker reads it). Nothing is written while it is changed.
 */
async function readingAs<T>(tx: Transaction, userId: string | null, fn: () => Promise<T>) {
  const saved = await tx.execute<{ user: string | null }>(
    sql`SELECT current_setting('app.user_id', true) AS user`,
  );
  const before = saved.rows[0]?.user ?? "";
  await tx.execute(sql`SELECT set_config('app.user_id', ${userId ?? ""}, true)`);
  try {
    return await fn();
  } finally {
    await tx.execute(sql`SELECT set_config('app.user_id', ${before}, true)`);
  }
}

/** The requester is still an active member holding platform.retention.manage tenant-wide. */
export async function requesterEligible(tx: Transaction, requestedBy: string): Promise<boolean> {
  const [member] = await tx
    .select({ status: tenantUser.status })
    .from(tenantUser)
    .where(eq(tenantUser.id, requestedBy));
  if (member?.status !== "active") return false;
  const held = await readingAs(tx, requestedBy, () =>
    tx.execute<{ held: boolean }>(
      sql`SELECT app.holds_permission_at('platform.retention.manage', NULL) AS held`,
    ),
  );
  return held.rows[0]?.held === true;
}

/** Whether the export exists, is a full export and was downloaded recently. */
export async function exportDownloaded(
  tx: Transaction,
  exportId: string,
  now: Date,
): Promise<boolean> {
  const [row] = await readingAs(tx, null, () =>
    tx
      .select({ kind: tenantExport.kind, downloadedAt: tenantExport.downloadedAt })
      .from(tenantExport)
      .where(eq(tenantExport.id, exportId)),
  );
  return row !== undefined && shredExportUsable(row, now);
}

/** Requests pending or shredding (at most one, by the unique index). */
export async function openRequests(tx: Transaction): Promise<number> {
  const rows = await tx
    .select({ id: tenantShredRequest.id })
    .from(tenantShredRequest)
    .where(inArray(tenantShredRequest.status, ["pending", "shredding"]));
  return rows.length;
}

/** Whether a shred is under way or done: legal holds are then refused (review H1). */
export async function shredStarted(tx: Transaction): Promise<boolean> {
  const rows = await tx
    .select({ id: tenantShredRequest.id })
    .from(tenantShredRequest)
    .where(inArray(tenantShredRequest.status, ["shredding", "approved"]));
  return rows.length > 0;
}

export interface ShredOutcome {
  readonly request: RequestRow;
  readonly certificate: CertificateRow | null;
}

/**
 * Completes an approved shred: idempotent, safe to run more than once and concurrently. Runs as
 * the approver, so row-level security applies as it did to the approval.
 */
export async function completeShred(
  deps: ShredDeps,
  input: { readonly tenantId: string; readonly requestId: string; readonly approverId: string },
): Promise<ShredOutcome | null> {
  const ctx = {
    tenantId: input.tenantId,
    userId: input.approverId,
    scope: "tenant" as const,
    locationIds: [],
  };
  const current = await withRequestContext(deps.appDb, ctx, (tx) => outcome(tx, input.requestId));
  if (current?.request.status !== "shredding") return current;
  const keyVersions = await deps.tenantKeys.shred(input.tenantId);
  deps.dataKeyCache?.forgetTenant(input.tenantId);
  return withRequestContext(deps.appDb, ctx, async (tx) => {
    const [request] = await tx
      .select()
      .from(tenantShredRequest)
      .where(
        and(eq(tenantShredRequest.id, input.requestId), eq(tenantShredRequest.status, "shredding")),
      )
      .for("update");
    // Completed meanwhile by another run: report what it recorded.
    if (!request) return outcome(tx, input.requestId);
    const certificate = await issueCertificate(tx, deps.tenantKeys, {
      tenantId: input.tenantId,
      recordClass: SHRED_RECORD_CLASS,
      subjectType: "tenant",
      subjectIds: [input.tenantId],
      recordCount: keyVersions.length,
      retentionRule: {
        trigger: "tenant_exit",
        source: "retention-and-deletion.md section 4",
        exportId: request.exportId,
      },
      reason: request.reason,
      method: `kms_key_destroy:${deps.tenantKeys.provider}`,
      executedAt: new Date(),
      requestedBy: request.requestedBy,
      approvedBy: input.approverId,
      keyVersions,
      backupDays: deps.backupDays,
    });
    const [approved] = await tx
      .update(tenantShredRequest)
      .set({ status: "approved", certificateId: certificate.id })
      .where(eq(tenantShredRequest.id, input.requestId))
      .returning();
    if (!approved) throw new Error("shred request not completed");
    await tx.insert(auditEvent).values({
      tenantId: input.tenantId,
      actorTenantUserId: input.approverId,
      action: "platform.retention.shred_completed",
      outcome: "success",
      resourceType: "tenant_shred_request",
      resourceId: input.requestId,
      scope: { certificateId: certificate.id, keyVersions: keyVersions.length },
    });
    return { request: approved, certificate };
  });
}

async function outcome(tx: Transaction, requestId: string): Promise<ShredOutcome | null> {
  const [request] = await tx
    .select()
    .from(tenantShredRequest)
    .where(eq(tenantShredRequest.id, requestId));
  if (!request) return null;
  if (!request.certificateId) return { request, certificate: null };
  const [certificate] = await tx
    .select()
    .from(destructionCertificate)
    .where(eq(destructionCertificate.id, request.certificateId));
  return { request, certificate: certificate ?? null };
}
