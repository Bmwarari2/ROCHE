import {
  auditEvent,
  type Database,
  notification,
  tenantExport,
  withRequestContext,
} from "@harbour/db";
import {
  type DocumentStoragePort,
  EXPORT_ARCHIVE_FILE,
  EXPORT_SCHEMA_VERSION,
  exportExpiresAt,
  exportStoragePrefix,
  PLATFORM_RATE_KEYS,
} from "@harbour/domain";
import { and, asc, eq, inArray, lt, lte } from "drizzle-orm";
import type pg from "pg";
import type { Logger } from "../logger";
import { buildExport } from "../services/export-build";
import { rateNumber } from "../services/rates";
import { errorCode, WORKER_JOB_FAILED_EVENT } from "./run-job";

/**
 * The full export's worker jobs (PLAT-015; platform-completions.md rules 12 to 15; HZ-070): build
 * each queued export into the exports bucket and tell the requester it is ready; delete archives
 * past their expiry and record it; fail an export left running by a stopped worker. Every
 * organisation, whatever its status: the export is free and never withheld (rule 15).
 */

export interface ExportJobDeps {
  readonly workerPool: pg.Pool;
  readonly appPool: pg.Pool;
  readonly appDb: Database;
  readonly logger: Logger;
  readonly storage: DocumentStoragePort;
  readonly exportStorage: DocumentStoragePort;
}

/** An export running this long was left by a stopped worker (a technical limit, not policy). */
export const EXPORT_RUNNING_LIMIT_HOURS = 12;

const archiveKeyOf = (tenantId: string, exportId: string) =>
  `${exportStoragePrefix(tenantId, exportId)}${EXPORT_ARCHIVE_FILE}`;

async function tenants(deps: ExportJobDeps): Promise<string[]> {
  const { rows } = await deps.workerPool.query<{ id: string }>("SELECT id FROM tenant ORDER BY id");
  return rows.map((r) => r.id);
}

const asJob = <T>(
  deps: ExportJobDeps,
  tenantId: string,
  fn: Parameters<typeof withRequestContext<T>>[2],
) =>
  withRequestContext(deps.appDb, { tenantId, userId: null, scope: "tenant", locationIds: [] }, fn);

/** Builds the oldest queued export of each organisation; answers how many became ready. */
export async function runQueuedExports(deps: ExportJobDeps): Promise<number> {
  let ready = 0;
  for (const tenantId of await tenants(deps)) {
    const [claimed] = await asJob(deps, tenantId, async (tx) => {
      const [next] = await tx
        .select({ id: tenantExport.id })
        .from(tenantExport)
        .where(eq(tenantExport.status, "queued"))
        .orderBy(asc(tenantExport.requestedAt))
        .limit(1);
      if (!next) return [];
      return tx
        .update(tenantExport)
        .set({ status: "running", startedAt: new Date() })
        .where(and(eq(tenantExport.id, next.id), eq(tenantExport.status, "queued")))
        .returning();
    });
    if (!claimed) continue;
    const archiveKey = archiveKeyOf(tenantId, claimed.id);
    try {
      const built = await buildExport(deps, {
        tenantId,
        exportId: claimed.id,
        requestedBy: claimed.requestedBy,
        since: claimed.since,
        archiveKey,
      });
      if (!built.manifest.complete) {
        await deps.exportStorage.destroy(archiveKey).catch(() => undefined);
        await fail(deps, tenantId, claimed.id, built.manifest.problems);
        continue;
      }
      await asJob(deps, tenantId, async (tx) => {
        const readyAt = new Date();
        const expiresAt = exportExpiresAt(readyAt, {
          exportLinkExpiryHours: await rateNumber(
            tx,
            tenantId,
            PLATFORM_RATE_KEYS.exportLinkExpiryHours,
          ),
          exportLinkExpiryHoursMax: await rateNumber(
            tx,
            tenantId,
            PLATFORM_RATE_KEYS.exportLinkExpiryHoursMax,
          ),
        });
        await tx
          .update(tenantExport)
          .set({
            status: "ready",
            snapshotAt: built.snapshotAt,
            readyAt,
            expiresAt,
            storageKey: archiveKey,
            bytes: built.bytes,
            manifestSha256: built.manifestSha256,
            schemaVersion: EXPORT_SCHEMA_VERSION,
            warnings: built.manifest.warnings,
          })
          .where(eq(tenantExport.id, claimed.id));
        await tx.insert(auditEvent).values({
          tenantId,
          action: "platform.export.ready",
          resourceType: "tenant_export",
          resourceId: claimed.id,
          scope: {
            kind: claimed.kind,
            snapshotAt: built.snapshotAt.toISOString(),
            tables: built.manifest.tables.length,
            rows: built.manifest.tables.reduce((n, t) => n + t.rows, 0),
            documents: built.manifest.documents.included,
            bytes: built.bytes,
            manifestSha256: built.manifestSha256,
            warnings: built.manifest.warnings.length,
          },
        });
        // Ids only: the title and body name nothing, and the link opens the export page.
        await tx
          .insert(notification)
          .values({
            recipientTenantUserId: claimed.requestedBy,
            kind: "platform.export.ready",
            severity: "info",
            title: "Your data export is ready",
            body: "Download it from the data export page before its link expires.",
            link: "/settings/export",
            channels: ["in_app", "email"],
            sourceType: "tenant_export",
            sourceId: claimed.id,
            dedupeKey: `export_ready:${claimed.id}`,
          })
          .onConflictDoNothing();
      });
      ready += 1;
    } catch (error) {
      const code = errorCode(error) ?? (error instanceof Error ? error.name : "unknown");
      deps.logger.error(
        {
          event: WORKER_JOB_FAILED_EVENT,
          queue: "full-exports",
          tenantId,
          exportId: claimed.id,
          code,
        },
        WORKER_JOB_FAILED_EVENT,
      );
      await fail(deps, tenantId, claimed.id, [{ kind: "build_error", code }]);
    }
  }
  return ready;
}

/** Marks an export failed, audited; another organisation's row in it raises a security alarm. */
async function fail(
  deps: ExportJobDeps,
  tenantId: string,
  exportId: string,
  problems: readonly ({ readonly kind: string } & Record<string, unknown>)[],
): Promise<void> {
  if (problems.some((p) => p.kind === "foreign_tenant_rows")) {
    deps.logger.error(
      { event: "security.export.foreign_rows", tenantId, exportId },
      "security.export.foreign_rows",
    );
  }
  await asJob(deps, tenantId, async (tx) => {
    await tx
      .update(tenantExport)
      .set({ status: "failed", failedAt: new Date(), problems })
      .where(
        and(eq(tenantExport.id, exportId), inArray(tenantExport.status, ["queued", "running"])),
      );
    await tx.insert(auditEvent).values({
      tenantId,
      action: "platform.export.failed",
      outcome: "error",
      resourceType: "tenant_export",
      resourceId: exportId,
      scope: { problems: problems.map((p) => p.kind) },
    });
  });
}

/**
 * Deletes each archive past its expiry and records it (`platform.export.expired`); the export is
 * marked expired only once its archive is gone, so a failed delete is tried again next time. An
 * export left running past `EXPORT_RUNNING_LIMIT_HOURS` is failed and its archive deleted.
 */
export async function sweepExports(deps: ExportJobDeps, now = new Date()): Promise<number> {
  let swept = 0;
  for (const tenantId of await tenants(deps)) {
    try {
      swept += await asJob(deps, tenantId, async (tx) => {
        const due = await tx
          .select({ id: tenantExport.id, storageKey: tenantExport.storageKey })
          .from(tenantExport)
          .where(and(eq(tenantExport.status, "ready"), lte(tenantExport.expiresAt, now)));
        for (const row of due) {
          await deps.exportStorage.destroy(row.storageKey ?? archiveKeyOf(tenantId, row.id));
          await tx
            .update(tenantExport)
            .set({ status: "expired" })
            .where(eq(tenantExport.id, row.id));
          await tx.insert(auditEvent).values({
            tenantId,
            action: "platform.export.expired",
            resourceType: "tenant_export",
            resourceId: row.id,
            scope: { archiveDeleted: true },
          });
        }
        return due.length;
      });
      const stale = await asJob(deps, tenantId, (tx) =>
        tx
          .select({ id: tenantExport.id })
          .from(tenantExport)
          .where(
            and(
              eq(tenantExport.status, "running"),
              lt(
                tenantExport.startedAt,
                new Date(now.getTime() - EXPORT_RUNNING_LIMIT_HOURS * 3_600_000),
              ),
            ),
          ),
      );
      for (const row of stale) {
        await deps.exportStorage.destroy(archiveKeyOf(tenantId, row.id));
        await fail(deps, tenantId, row.id, [{ kind: "stopped" }]);
        swept += 1;
      }
    } catch (error) {
      const code = errorCode(error) ?? (error instanceof Error ? error.name : "unknown");
      deps.logger.error(
        { event: WORKER_JOB_FAILED_EVENT, queue: "export-expiry", tenantId, code },
        WORKER_JOB_FAILED_EVENT,
      );
    }
  }
  return swept;
}
