import { ExportItem, ExportList, RequestExport } from "@harbour/contracts";
import { type Transaction, tenantExport } from "@harbour/db";
import {
  checkExportDownload,
  checkExportRequest,
  type ExportStatus,
  exportStateAt,
} from "@harbour/domain";
import { createRoute, z } from "@hono/zod-openapi";
import { and, desc, eq, inArray, isNull, sql } from "drizzle-orm";
import { auditInTx, writeAudit } from "../http/audit";
import { requirePermission, stepUpAtFor, type TenantAccess, withTenant } from "../http/context";
import { HttpProblem, problems } from "../http/problem";
import { publish } from "../outbox";
import { inSystemView } from "../services/devices";
import { staffNames } from "../services/staff";
import {
  conflictResponse,
  createRouter,
  errorResponses,
  jsonBody,
  notFoundResponse,
  security,
} from "./openapi";

/**
 * The free full export (PLAT-015; platform-completions.md rules 12 to 15; HZ-070). Asking for one
 * listing and downloading need `platform.export.create` (the owner) with step-up. One export at a time per organisation: asking again answers with the one in
 * hand. The archive is fetched once, by the person who asked, while it is ready; the fetch is
 * recorded before the bytes leave and the archive is then deleted. The export worker builds it.
 */

const PERMISSION = "platform.export.create";
const IdParam = z.object({ id: z.uuid() });
const binary = z.string().meta({ format: "binary" });

type Row = typeof tenantExport.$inferSelect;

const iso = (d: Date | null) => (d ? d.toISOString() : null);

async function items(tx: Transaction, rows: readonly Row[], access: TenantAccess, now: Date) {
  const names = await staffNames(
    tx,
    rows.map((r) => r.requestedBy),
  );
  return rows.map((r) => {
    const status = exportStateAt(
      {
        id: r.id,
        status: r.status as ExportStatus,
        requestedBy: r.requestedBy,
        expiresAt: r.expiresAt,
      },
      now,
    );
    return {
      id: r.id,
      kind: r.kind as "full" | "changes_since",
      since: iso(r.since),
      status,
      requestedBy: names(r.requestedBy),
      requestedAt: r.requestedAt.toISOString(),
      snapshotAt: iso(r.snapshotAt),
      readyAt: iso(r.readyAt),
      expiresAt: iso(r.expiresAt),
      bytes: r.bytes,
      manifestSha256: r.manifestSha256,
      warnings: r.warnings as Record<string, unknown>[],
      downloadedAt: iso(r.downloadedAt),
      mayDownload:
        status === "ready" && r.downloadedAt === null && r.requestedBy === access.tenantUserId,
    };
  });
}

/** The worker deletes the archive on these events (retried until it is gone). Ids only. */
function publishExportEvent(
  tx: Transaction,
  exportId: string,
  type: "platform.export.downloaded" | "platform.export.revoked",
) {
  return publish(tx, {
    context: "platform",
    aggregateType: "tenant_export",
    aggregateId: exportId,
    type,
    payload: { exportId },
  });
}

/** Closes a storage stream the response will not send. */
async function closeStream(body: AsyncIterable<Uint8Array>): Promise<void> {
  const destroy = (body as { destroy?: () => void }).destroy;
  if (typeof destroy === "function") destroy.call(body);
}

const DOWNLOAD_PROBLEM: Record<string, () => HttpProblem> = {
  not_requester: () =>
    new HttpProblem(
      403,
      "not_requester",
      "Only the person who asked for this export can download it.",
      "Ask for your own: it is free.",
    ),
  not_ready: () => new HttpProblem(409, "export_not_ready", "The export is still being prepared."),
  failed: () =>
    new HttpProblem(409, "export_failed", "This export could not be completed. Ask for a new one."),
  expired: () =>
    new HttpProblem(
      410,
      "export_expired",
      "This export has expired and its file has been deleted. Ask for a new one: it is free.",
    ),
  revoked: () =>
    new HttpProblem(410, "export_revoked", "This export was cancelled. Ask for a new one."),
  already_downloaded: () =>
    new HttpProblem(
      410,
      "export_already_downloaded",
      "This export has already been downloaded, and its file deleted. Ask for a new one: it is free.",
    ),
};

export const exportsRouter = createRouter()
  .openapi(
    createRoute({
      method: "post",
      path: "/v1/exports",
      tags: ["platform"],
      summary: "Ask for the organisation's free full export",
      description:
        "platform.export.create with step-up (an MFA sign-in within the window). Free at any time. One export at a time: while one is queued or running, asking again answers 200 with it. With sinceExportId, only the changes since that export's snapshot. Audited (platform.export.requested).",
      security,
      request: { body: { content: { "application/json": { schema: RequestExport } } } },
      responses: {
        200: jsonBody(ExportItem, "The export already being prepared"),
        202: jsonBody(ExportItem, "Queued"),
        ...errorResponses,
        ...notFoundResponse,
      },
    }),
    async (c) => {
      const access = await requirePermission(c, PERMISSION);
      const { sinceExportId } = c.req.valid("json");
      const now = new Date();
      const result = await withTenant(c, async (tx) => {
        let since: Date | null = null;
        if (sinceExportId) {
          const [earlier] = await tx
            .select({ snapshotAt: tenantExport.snapshotAt })
            .from(tenantExport)
            .where(eq(tenantExport.id, sinceExportId));
          if (!earlier?.snapshotAt) return { problem: problems.notFound() };
          since = earlier.snapshotAt;
        }
        const open = await tx
          .select()
          .from(tenantExport)
          .where(inArray(tenantExport.status, ["queued", "running"]));
        const check = checkExportRequest({
          access: access.effective,
          stepUpAt: stepUpAtFor(access, now),
          now,
          stepUpWindowSeconds: access.stepUpWindowSeconds,
          // Not purged while its data is here; the export is never withheld (rule 15).
          tenant: { status: "active", dataPurgedAt: null },
          exports: open.map((e) => ({ id: e.id, status: e.status as ExportStatus })),
          since,
        });
        if (!check.ok && check.problem !== "export_in_progress") {
          return { problem: problems.invalid(check.message) };
        }
        const [inserted] = check.ok
          ? await tx
              .insert(tenantExport)
              .values({
                kind: since ? "changes_since" : "full",
                since,
                requestedBy: access.tenantUserId,
              })
              .onConflictDoNothing()
              .returning()
          : [];
        if (!inserted) {
          // Another request got there first: answer with the one in hand.
          const [current] = await tx
            .select()
            .from(tenantExport)
            .where(inArray(tenantExport.status, ["queued", "running"]));
          if (!current) throw new Error("no export in hand");
          return { existing: (await items(tx, [current], access, now))[0] };
        }
        await auditInTx(tx, access, {
          action: "platform.export.requested",
          resourceType: "tenant_export",
          resourceId: inserted.id,
          scope: { kind: inserted.kind, since: iso(since) },
          requestId: c.get("requestId"),
        });
        return { created: (await items(tx, [inserted], access, now))[0] };
      });
      if ("problem" in result && result.problem) throw result.problem;
      if ("existing" in result && result.existing) return c.json(result.existing, 200);
      if ("created" in result && result.created) return c.json(result.created, 202);
      throw new Error("unreachable");
    },
  )
  .openapi(
    createRoute({
      method: "get",
      path: "/v1/exports",
      tags: ["platform"],
      summary: "The organisation's exports, newest first",
      description:
        "platform.export.create with step-up, as for asking and downloading. Never the archive's place in storage.",
      security,
      responses: { 200: jsonBody(ExportList, "Exports"), ...errorResponses },
    }),
    async (c) => {
      const access = await requirePermission(c, PERMISSION);
      const now = new Date();
      const body = await inSystemView(c.get("services").db, access, async (tx) => {
        const rows = await tx
          .select()
          .from(tenantExport)
          .where(isNull(tenantExport.deletedAt))
          .orderBy(desc(tenantExport.requestedAt))
          .limit(50);
        return { items: await items(tx, rows, access, now) };
      });
      return c.json(body, 200);
    },
  )
  .openapi(
    createRoute({
      method: "post",
      path: "/v1/exports/{id}/revoke",
      tags: ["platform"],
      summary: "Cancel an export, deleting its archive",
      description:
        "platform.export.create with step-up. A queued, running or ready export; the worker then deletes its archive. Audited (platform.export.revoked).",
      security,
      request: { params: IdParam },
      responses: {
        204: { description: "Cancelled" },
        ...errorResponses,
        ...notFoundResponse,
        ...conflictResponse,
      },
    }),
    async (c) => {
      const access = await requirePermission(c, PERMISSION);
      const { id } = c.req.valid("param");
      await withTenant(c, async (tx) => {
        const [row] = await tx
          .update(tenantExport)
          .set({
            status: "revoked",
            revokedAt: sql`now()`,
            revokedBy: access.tenantUserId,
          })
          .where(
            and(
              eq(tenantExport.id, id),
              inArray(tenantExport.status, ["queued", "running", "ready"]),
            ),
          )
          .returning({ id: tenantExport.id });
        if (!row) {
          const [found] = await tx
            .select({ id: tenantExport.id })
            .from(tenantExport)
            .where(eq(tenantExport.id, id));
          throw found ? problems.conflict("This export has already ended.") : problems.notFound();
        }
        await auditInTx(tx, access, {
          action: "platform.export.revoked",
          resourceType: "tenant_export",
          resourceId: id,
          requestId: c.get("requestId"),
        });
        // The archive, if one was written, is deleted by the worker, retried until it is gone.
        await publishExportEvent(tx, id, "platform.export.revoked");
      });
      return c.body(null, 204);
    },
  )
  .openapi(
    createRoute({
      method: "get",
      path: "/v1/exports/{id}/download",
      tags: ["platform"],
      summary: "Download the export archive, once",
      description:
        "platform.export.create with step-up, by the person who asked only, while it is ready and unexpired (checkExportDownload). One fetch: the archive is opened, then the download is recorded (who and when) before the bytes stream out, and the worker then deletes the archive; a second fetch is 410 export_already_downloaded. A read that fails before the claim leaves it untaken, so the person can try again. Audited (platform.export.downloaded).",
      security,
      request: { params: IdParam },
      responses: {
        200: { content: { "application/zip": { schema: binary } }, description: "The archive" },
        ...errorResponses,
        ...notFoundResponse,
        ...conflictResponse,
        410: { description: "Expired, cancelled or already downloaded" },
      },
    }),
    async (c) => {
      const access = await requirePermission(c, PERMISSION);
      const { id } = c.req.valid("param");
      const now = new Date();
      const requestId = c.get("requestId");
      const { appPool, exportStorage } = c.get("services");
      const refuse = async (reason: string): Promise<never> => {
        await writeAudit(appPool, access, {
          action: "platform.export.downloaded",
          outcome: "denied",
          resourceType: "tenant_export",
          resourceId: id,
          reason,
          requestId,
        });
        if (reason === "not_found") throw problems.notFound();
        throw DOWNLOAD_PROBLEM[reason]?.() ?? problems.forbidden();
      };
      const checked = await withTenant(c, async (tx) => {
        const [row] = await tx.select().from(tenantExport).where(eq(tenantExport.id, id));
        if (!row) return { refused: "not_found" };
        const check = checkExportDownload({
          export: {
            id: row.id,
            status: row.status as ExportStatus,
            requestedBy: row.requestedBy,
            expiresAt: row.expiresAt,
          },
          actorTenantUserId: access.tenantUserId,
          access: access.effective,
          stepUpAt: stepUpAtFor(access, now),
          now,
          stepUpWindowSeconds: access.stepUpWindowSeconds,
        });
        if (!check.ok) return { refused: check.problem };
        if (row.downloadedAt !== null || !row.storageKey) return { refused: "already_downloaded" };
        return { key: row.storageKey };
      });
      if (!("key" in checked) || !checked.key) return refuse(checked.refused ?? "not_found");
      // The archive is opened before the download is claimed: a read that fails here leaves the
      // claim untaken, so the person can try again while the archive is there.
      const body = await exportStorage.getStream(checked.key);
      if (!body) return refuse("expired");
      const claimed = await withTenant(c, async (tx) => {
        const [row] = await tx
          .update(tenantExport)
          .set({ downloadedAt: sql`now()`, downloadedBy: access.tenantUserId })
          .where(
            and(
              eq(tenantExport.id, id),
              eq(tenantExport.status, "ready"),
              isNull(tenantExport.downloadedAt),
              sql`${tenantExport.expiresAt} > now()`,
            ),
          )
          .returning({ bytes: tenantExport.bytes });
        if (!row) {
          const [current] = await tx
            .select({ status: tenantExport.status, downloadedAt: tenantExport.downloadedAt })
            .from(tenantExport)
            .where(eq(tenantExport.id, id));
          return current?.downloadedAt
            ? "already_downloaded"
            : current?.status === "revoked"
              ? "revoked"
              : "expired";
        }
        await auditInTx(tx, access, {
          action: "platform.export.downloaded",
          resourceType: "tenant_export",
          resourceId: id,
          scope: { bytes: row.bytes },
          requestId,
        });
        // One fetch: the archive is deleted by the worker, retried until it is gone.
        await publishExportEvent(tx, id, "platform.export.downloaded");
        return null;
      });
      if (claimed !== null) {
        await closeStream(body);
        return refuse(claimed);
      }
      return c.body(ReadableStream.from(body) as ReadableStream<Uint8Array<ArrayBuffer>>, 200, {
        "content-type": "application/zip",
        "content-disposition": `attachment; filename="harbour-export-${id}.zip"`,
        "cache-control": "no-store",
      });
    },
  );
