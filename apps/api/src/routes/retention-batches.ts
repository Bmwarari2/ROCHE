import {
  CancelDestructionBatch,
  DestructionBatch,
  type DestructionBatchCancelReason,
  DestructionBatchItemList,
  DestructionBatchList,
} from "@harbour/contracts";
import { destructionBatch, destructionBatchItem } from "@harbour/db";
import { cancelProblem, scopeFor } from "@harbour/domain";
import { createRoute, z } from "@hono/zod-openapi";
import { and, asc, desc, eq, gt, lt } from "drizzle-orm";
import type { Context } from "hono";
import { auditInTx, writeAudit } from "../http/audit";
import { type AppEnv, requirePermission, withTenant } from "../http/context";
import { problems } from "../http/problem";
import { createRouter, errorResponses, jsonBody, security } from "./openapi";

/**
 * Destruction batches (retention sweeps plan 5.4 and 5.5, slice 6; ADR-0135): the records the
 * nightly sweep proposed for destruction, per class, for tenant-wide holders of
 * `platform.retention.manage` (step-up, as every retention route). A reviewer may cancel a
 * proposed batch, with its version and a reason code. Nothing is destroyed or hidden by a batch;
 * approval comes with slice 9. Every list, view and cancel is audited with ids and counts only.
 */

const PERMISSION = "platform.retention.manage";
export const BATCHES_LISTED_ACTION = "platform.retention.batches_listed";
export const BATCH_VIEWED_ACTION = "platform.retention.batch_viewed";
export const BATCH_CANCELLED_ACTION = "platform.retention.batch_cancelled";

/** A tenant-wide holder of the permission; a narrower scope is refused and audited. */
async function reviewer(c: Context<AppEnv>, action: string) {
  const access = await requirePermission(c, PERMISSION);
  if (scopeFor(access.effective, PERMISSION).scope !== "tenant") {
    await writeAudit(c.get("services").appPool, access, {
      action,
      outcome: "denied",
      reason: "scope_not_tenant_wide",
      requestId: c.get("requestId"),
    });
    throw problems.forbidden();
  }
  return access;
}

type BatchRow = typeof destructionBatch.$inferSelect;

function batchOut(row: BatchRow): DestructionBatch {
  return {
    id: row.id,
    status: row.status as DestructionBatch["status"],
    recordClass: row.recordClass,
    rule: row.rule as DestructionBatch["rule"],
    itemCount: row.itemCount,
    tables: row.tables as Record<string, number>,
    proposedAt: row.proposedAt.toISOString(),
    cancelledAt: row.cancelledAt?.toISOString() ?? null,
    cancelledBy: row.cancelledBy,
    cancelReason: row.cancelReason as DestructionBatchCancelReason | null,
    version: row.version,
  };
}

const page = {
  cursor: z.uuid().optional(),
  limit: z.coerce.number().int().min(1).max(500).default(100),
};
const BatchParams = z.object({ id: z.uuid() });

export const retentionBatchesRouter = createRouter()
  .openapi(
    createRoute({
      method: "get",
      path: "/v1/retention/batches",
      tags: ["platform"],
      summary: "Destruction batches the retention sweep proposed",
      description:
        "Newest first, a page at a time (pass nextCursor back as cursor); optionally by status. A batch is a proposal only: nothing is destroyed or hidden. Tenant-wide holders of platform.retention.manage, with step-up.",
      security,
      request: {
        query: z.object({
          status: z.enum(["proposed", "cancelled"]).optional(),
          ...page,
        }),
      },
      responses: { 200: jsonBody(DestructionBatchList, "Batches"), ...errorResponses },
    }),
    async (c) => {
      const access = await reviewer(c, BATCHES_LISTED_ACTION);
      const { status, cursor, limit } = c.req.valid("query");
      const body = await withTenant(c, async (tx) => {
        const rows = await tx
          .select()
          .from(destructionBatch)
          .where(
            and(
              status ? eq(destructionBatch.status, status) : undefined,
              cursor ? lt(destructionBatch.id, cursor) : undefined,
            ),
          )
          .orderBy(desc(destructionBatch.id))
          .limit(limit + 1);
        const shown = rows.slice(0, limit);
        await auditInTx(tx, access, {
          action: BATCHES_LISTED_ACTION,
          resourceType: "destruction_batch",
          scope: { count: shown.length, status: status ?? null },
          requestId: c.get("requestId"),
        });
        return {
          items: shown.map(batchOut),
          nextCursor: rows.length > limit ? (shown.at(-1)?.id ?? null) : null,
        };
      });
      return c.json(body, 200);
    },
  )
  .openapi(
    createRoute({
      method: "get",
      path: "/v1/retention/batches/{id}/items",
      tags: ["platform"],
      summary: "A destruction batch and the records it proposes",
      description:
        "The batch and its items (table, record id, class, dates, whom it is about), a page at a time in the order proposed. Tenant-wide holders of platform.retention.manage, with step-up; audited with the batch id.",
      security,
      request: { params: BatchParams, query: z.object(page) },
      responses: {
        200: jsonBody(DestructionBatchItemList, "The batch and its items"),
        ...errorResponses,
      },
    }),
    async (c) => {
      const access = await reviewer(c, BATCH_VIEWED_ACTION);
      const { id } = c.req.valid("param");
      const { cursor, limit } = c.req.valid("query");
      const body = await withTenant(c, async (tx) => {
        const [batch] = await tx.select().from(destructionBatch).where(eq(destructionBatch.id, id));
        if (!batch) throw problems.notFound();
        const rows = await tx
          .select()
          .from(destructionBatchItem)
          .where(
            and(
              eq(destructionBatchItem.batchId, id),
              cursor ? gt(destructionBatchItem.id, cursor) : undefined,
            ),
          )
          .orderBy(asc(destructionBatchItem.id))
          .limit(limit + 1);
        const shown = rows.slice(0, limit);
        await auditInTx(tx, access, {
          action: BATCH_VIEWED_ACTION,
          resourceType: "destruction_batch",
          resourceId: id,
          scope: { count: shown.length },
          requestId: c.get("requestId"),
        });
        return {
          batch: batchOut(batch),
          items: shown.map((i) => ({
            id: i.id,
            tableName: i.tableName,
            recordId: i.recordId,
            recordClass: i.recordClass,
            triggerOn: i.triggerOn,
            dueOn: i.dueOn,
            subjectKind: i.subjectKind as "person" | "applicant" | "none",
            subjectIds: i.subjectIds,
          })),
          nextCursor: rows.length > limit ? (shown.at(-1)?.id ?? null) : null,
        };
      });
      return c.json(body, 200);
    },
  )
  .openapi(
    createRoute({
      method: "post",
      path: "/v1/retention/batches/{id}/cancel",
      tags: ["platform"],
      summary: "Cancel a proposed destruction batch",
      description:
        "With expectedVersion and a reason code. The batch stays, cancelled, with who and when; its records are kept and may be proposed again by a later sweep. A stale version is refused (409), and so is a batch already decided. Tenant-wide holders of platform.retention.manage, with step-up.",
      security,
      request: {
        params: BatchParams,
        body: { content: { "application/json": { schema: CancelDestructionBatch } } },
      },
      responses: { 200: jsonBody(DestructionBatch, "Cancelled"), ...errorResponses },
    }),
    async (c) => {
      const access = await reviewer(c, BATCH_CANCELLED_ACTION);
      const { id } = c.req.valid("param");
      const body = c.req.valid("json");
      const saved = await withTenant(c, async (tx) => {
        const [batch] = await tx
          .select()
          .from(destructionBatch)
          .where(eq(destructionBatch.id, id))
          .for("update");
        if (!batch) throw problems.notFound();
        const problem = cancelProblem(batch, body.expectedVersion);
        if (problem === "version_conflict") throw problems.conflict();
        if (problem === "not_proposed") {
          throw problems.conflict("The batch has already been decided.");
        }
        const [updated] = await tx
          .update(destructionBatch)
          .set({
            status: "cancelled",
            cancelledAt: new Date(),
            cancelledBy: access.tenantUserId,
            cancelReason: body.reason,
          })
          .where(and(eq(destructionBatch.id, id), eq(destructionBatch.version, batch.version)))
          .returning();
        if (!updated) throw problems.conflict();
        await auditInTx(tx, access, {
          action: BATCH_CANCELLED_ACTION,
          resourceType: "destruction_batch",
          resourceId: id,
          scope: {
            reason: body.reason,
            itemCount: updated.itemCount,
            recordClass: updated.recordClass,
          },
          requestId: c.get("requestId"),
        });
        return batchOut(updated);
      });
      return c.json(saved, 200);
    },
  );
