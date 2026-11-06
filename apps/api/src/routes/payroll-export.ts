import { createHash } from "node:crypto";
import {
  DisconnectPayroll,
  NewPayrollConnection,
  NewPayrollExport,
  PayrollConnectionItem,
  PayrollConnectionList,
  type PayrollExportItem,
  PayrollExportList,
  PayrollExportResult,
} from "@harbour/contracts";
import {
  payProfile,
  payRun,
  payRunLine,
  payrollConnection,
  payrollExport,
  payrollExportResult,
  type Transaction,
} from "@harbour/db";
import {
  buildPayrollFile,
  buildXeroBatch,
  canonicalInput,
  type ExportAeCategory,
  type ExportLine,
  isExportProblem,
  PAYROLL_FORMAT_VERSIONS,
  type Permission,
  type XeroPayBatch,
} from "@harbour/domain";
import { createRoute, z } from "@hono/zod-openapi";
import { and, asc, desc, eq, isNull, sql } from "drizzle-orm";
import type { Context } from "hono";
import { writeAudit } from "../http/audit";
import { type AppEnv, requirePermission, type TenantAccess, withTenant } from "../http/context";
import { HttpProblem, problems } from "../http/problem";
import { PayrollNotConnected } from "../integrations/payroll/xero";
import {
  conflictResponse,
  createRouter,
  errorResponses,
  jsonBody,
  notFoundResponse,
  security,
} from "./openapi";
import { audit, dbCode } from "./people-shared";

/**
 * Payroll and pension exports (scheduling.md section 19; SCHED-008; ADR-0013, ADR-0097). A locked
 * pay run leaves Harbour only when a holder of finance.payroll.export across the organisation, who
 * also reads pay, exports it with a fresh sign-in: as a file for Staffology, Sage or BrightPay, or
 * to Xero Payroll UK through its adapter once the organisation has connected it. The file is made
 * again from the locked run every time and never stored; its SHA-256 is recorded. The database
 * holds the same rules (migration 0127). Audit events carry ids only, never a figure or a
 * reference.
 */

const EXPORT = "finance.payroll.export" as const satisfies Permission;
const A = {
  created: "scheduling.payroll_export.created",
  refused: "scheduling.payroll_export.refused",
  resultRecorded: "scheduling.payroll_export.result_recorded",
  connected: "scheduling.payroll_connection.connected",
  disconnected: "scheduling.payroll_connection.disconnected",
} as const;

const sha256 = (text: string) => createHash("sha256").update(text, "utf8").digest("hex");

type ExportRow = typeof payrollExport.$inferSelect;
type ResultRow = typeof payrollExportResult.$inferSelect;
type ConnectionRow = typeof payrollConnection.$inferSelect;
type Outcome = z.infer<typeof PayrollExportItem>["outcome"];

/** An API export reads as its recorded result; with none yet, as pending (rule 8). */
const exportItem = (
  r: ExportRow,
  result: Pick<ResultRow, "outcome" | "externalRef"> | null = null,
): z.infer<typeof PayrollExportItem> => ({
  id: r.id,
  runId: r.runId,
  calculation: r.calculation,
  format: r.format as z.infer<typeof PayrollExportItem>["format"],
  formatVersion: r.formatVersion,
  lineCount: r.lineCount,
  contentSha256: r.contentSha256,
  reexport: r.reexport,
  outcome: (result?.outcome ?? r.outcome) as Outcome,
  externalRef: result?.externalRef ?? null,
  exportedBy: r.exportedBy,
  exportedAt: r.exportedAt.toISOString(),
});

const connectionItem = (r: ConnectionRow): z.infer<typeof PayrollConnectionItem> => ({
  id: r.id,
  provider: "xero_payroll_uk",
  externalOrganisationId: r.externalOrganisationId,
  status: r.status as "connected" | "disconnected",
  connectedBy: r.connectedBy,
  connectedAt: r.connectedAt.toISOString(),
  disconnectedAt: r.disconnectedAt ? r.disconnectedAt.toISOString() : null,
  version: r.version,
});

/**
 * Rule 2: finance.payroll.export (with its step-up) held for the whole organisation, and, to export
 * or list exports, the right to read pay, both as the database tests them.
 */
async function requireExporter(
  c: Context<AppEnv>,
  options: { readonly readsPay: boolean },
): Promise<TenantAccess> {
  const access = await requirePermission(c, EXPORT);
  const ok = await withTenant(c, async (tx) => {
    const wide = await tx.execute<{ ok: boolean }>(
      sql`SELECT app.holds_pay_permission(${EXPORT}) AS ok`,
    );
    if (wide.rows[0]?.ok !== true) return false;
    if (!options.readsPay) return true;
    const reads = await tx.execute<{ ok: boolean }>(sql`SELECT app.reads_pay() AS ok`);
    return reads.rows[0]?.ok === true;
  });
  if (!ok) {
    await writeAudit(c.get("services").appPool, access, {
      action: A.refused,
      outcome: "denied",
      resourceType: "pay_run",
      reason: "not_organisation_wide",
      requestId: c.get("requestId"),
    });
    throw new HttpProblem(
      403,
      "pay_not_organisation_wide",
      "Payroll export is organisation-wide: it needs finance.payroll.export, and the right to read pay, for the whole organisation.",
    );
  }
  return access;
}

async function refuse(
  c: Context<AppEnv>,
  access: TenantAccess,
  runId: string,
  reason: string,
  problem: HttpProblem,
): Promise<never> {
  await writeAudit(c.get("services").appPool, access, {
    action: A.refused,
    outcome: "denied",
    resourceType: "pay_run",
    resourceId: runId,
    reason,
    requestId: c.get("requestId"),
  });
  throw problem;
}

/** The database's own words for a refusal (a RAISE): never a failed query's message. */
function raisedMessage(error: unknown): string | undefined {
  const e = error as { message?: string; cause?: { message?: string } };
  return e.cause?.message ?? e.message;
}

/**
 * The run's current calculation's lines, as they may leave (rule 4), with payroll references: the
 * first export's when there was one, so a re-export gives the same content (rule 5), otherwise the
 * pay profiles' as they stand.
 */
async function exportLines(
  tx: Transaction,
  run: { readonly id: string; readonly calculation: number },
  recorded: Readonly<Record<string, string>> | null,
): Promise<ExportLine[]> {
  const rows = await tx
    .select({ l: payRunLine, reference: payProfile.payrollReference })
    .from(payRunLine)
    .leftJoin(
      payProfile,
      and(
        eq(payProfile.tenantId, payRunLine.tenantId),
        eq(payProfile.memberId, payRunLine.memberId),
      ),
    )
    .where(and(eq(payRunLine.runId, run.id), eq(payRunLine.calculation, run.calculation)));
  return rows.map(({ l, reference }) => ({
    memberId: l.memberId,
    payrollReference: (recorded ? recorded[l.memberId] : reference) ?? null,
    paidMinutes: l.paidMinutes,
    basicPence: l.basicPence,
    premiumPence: l.premiumPence,
    sleepInPence: l.sleepInPence,
    onCallPence: l.onCallPence,
    mileagePence: l.mileagePence,
    nmwTopUpPence: l.nmwTopUpPence,
    rolledUpHolidayPence: l.rolledUpHolidayPence,
    sspPence: l.sspPence,
    totalPence: l.totalPence,
    holidayAccruedMinutes: l.holidayAccruedMinutes,
    aeCategory: (l.aeCategory ?? null) as ExportAeCategory | null,
    qualifyingEarningsPence: l.qualifyingEarningsPence,
  }));
}

const RunParam = z.object({ id: z.uuid() });

export const payrollExportRouter = createRouter()
  .openapi(
    createRoute({
      method: "get",
      path: "/v1/pay-runs/{id}/exports",
      tags: ["scheduling"],
      summary: "A pay run's exports to payroll",
      description:
        "finance.payroll.export with the right to read pay, both for the whole organisation. Each export with its format, line count, SHA-256 and whether it was a re-export.",
      security,
      request: { params: RunParam },
      responses: {
        200: jsonBody(PayrollExportList, "Exports"),
        ...errorResponses,
        ...notFoundResponse,
      },
    }),
    async (c) => {
      await requireExporter(c, { readsPay: true });
      const { id } = c.req.valid("param");
      const items = await withTenant(c, async (tx) => {
        const [run] = await tx.select({ id: payRun.id }).from(payRun).where(eq(payRun.id, id));
        if (!run) throw problems.notFound();
        const rows = await tx
          .select({ e: payrollExport, r: payrollExportResult })
          .from(payrollExport)
          .leftJoin(
            payrollExportResult,
            and(
              eq(payrollExportResult.tenantId, payrollExport.tenantId),
              eq(payrollExportResult.exportId, payrollExport.id),
            ),
          )
          .where(eq(payrollExport.runId, id))
          .orderBy(desc(payrollExport.exportedAt));
        return rows.map(({ e, r }) => exportItem(e, r));
      });
      return c.json({ items }, 200);
    },
  )
  .openapi(
    createRoute({
      method: "post",
      path: "/v1/pay-runs/{id}/exports",
      tags: ["scheduling"],
      summary: "Export a locked pay run to payroll",
      description:
        "finance.payroll.export with a fresh sign-in and the right to read pay, both for the whole organisation. Only a locked run's current calculation; every member needs a payroll reference (422 payroll_reference_missing); a second export of the same calculation needs confirmReexport (409 reexport_needs_confirming) and is flagged. A file format returns the file, made from the locked run and never stored; Xero Payroll UK needs the organisation's connection (409 integration_not_connected). Audited with ids only.",
      security,
      request: {
        params: RunParam,
        body: { content: { "application/json": { schema: NewPayrollExport } } },
      },
      responses: {
        201: jsonBody(PayrollExportResult, "Exported"),
        ...errorResponses,
        ...notFoundResponse,
        ...conflictResponse,
      },
    }),
    async (c) => {
      const access = await requireExporter(c, { readsPay: true });
      const { id } = c.req.valid("param");
      const { format, confirmReexport } = c.req.valid("json");
      const services = c.get("services");
      const missing = (memberIds: readonly string[]) =>
        refuse(
          c,
          access,
          id,
          "payroll_reference_missing",
          new HttpProblem(
            422,
            "payroll_reference_missing",
            "Some members have no payroll reference. Add one to each member's pay profile.",
            memberIds.join(", "),
          ),
        );
      const notConnected = (detail: string) =>
        refuse(
          c,
          access,
          id,
          "integration_not_connected",
          new HttpProblem(409, "integration_not_connected", detail),
        );
      type Prepared =
        | { readonly kind: "file"; readonly result: z.infer<typeof PayrollExportResult> }
        | {
            readonly kind: "api";
            readonly row: ExportRow;
            readonly connection: ConnectionRow;
            readonly batch: XeroPayBatch;
          };
      let prepared: Prepared;
      try {
        // Rules 1 to 6, in one transaction holding the run's export lock, so two exports at once
        // cannot both pass as the first. An API export is recorded, and audited, as pending
        // before anything is sent (rule 8).
        prepared = await withTenant(c, async (tx): Promise<Prepared> => {
          await tx.execute(
            sql`SELECT pg_advisory_xact_lock(app.payroll_export_lock_key(app.current_tenant_id(), ${id}::uuid))`,
          );
          const [run] = await tx.select().from(payRun).where(eq(payRun.id, id));
          if (!run) throw problems.notFound();
          if (run.status !== "locked") {
            return refuse(
              c,
              access,
              id,
              "run_not_locked",
              new HttpProblem(409, "run_not_locked", "Only a locked pay run can be exported."),
            );
          }
          const earlier = await tx
            .select({ e: payrollExport, outcome: payrollExportResult.outcome })
            .from(payrollExport)
            .leftJoin(
              payrollExportResult,
              and(
                eq(payrollExportResult.tenantId, payrollExport.tenantId),
                eq(payrollExportResult.exportId, payrollExport.id),
              ),
            )
            .where(and(eq(payrollExport.runId, id), eq(payrollExport.calculation, run.calculation)))
            .orderBy(asc(payrollExport.exportedAt), asc(payrollExport.id));
          // A pending or unknown send counts: only a known failure does not (as the guard).
          if (earlier.some((r) => r.outcome !== "failed") && !confirmReexport) {
            return refuse(
              c,
              access,
              id,
              "reexport_not_confirmed",
              new HttpProblem(
                409,
                "reexport_needs_confirming",
                "This pay run has been exported before. Check payroll will not pay it twice, then confirm the export again.",
              ),
            );
          }
          const recorded = (earlier[0]?.e.payrollReferences ?? null) as Record<
            string,
            string
          > | null;
          const lines = await exportLines(tx, run, recorded);
          const references = Object.fromEntries(
            lines.flatMap((l) => (l.payrollReference ? [[l.memberId, l.payrollReference]] : [])),
          );
          const shape = {
            id: run.id,
            frequency: run.frequency,
            periodStart: run.periodStart,
            periodEnd: run.periodEnd,
          };
          const record = async (contentSha256: string, outcome: "generated" | "pending") => {
            const [row] = await tx
              .insert(payrollExport)
              .values({
                runId: run.id,
                calculation: run.calculation,
                format,
                formatVersion: PAYROLL_FORMAT_VERSIONS[format],
                lineCount: lines.length,
                contentSha256,
                outcome,
                payrollReferences: references,
                exportedBy: access.tenantUserId,
              })
              .returning();
            if (!row) throw new Error("export not recorded");
            await audit(c, tx, access, {
              action: A.created,
              resourceType: "payroll_export",
              resourceId: row.id,
              scopeExtra: {
                runId: run.id,
                format,
                lineCount: row.lineCount,
                reexport: row.reexport,
                outcome,
              },
            });
            return row;
          };
          if (format === "xero_payroll_uk") {
            const [connection] = await tx
              .select()
              .from(payrollConnection)
              .where(
                and(
                  eq(payrollConnection.provider, "xero_payroll_uk"),
                  eq(payrollConnection.status, "connected"),
                  isNull(payrollConnection.deletedAt),
                ),
              );
            if (!connection || !services.payrollXero) {
              return notConnected(
                "Xero Payroll is not connected for your organisation. Connect it first, or export a file.",
              );
            }
            const batch = buildXeroBatch(shape, lines);
            if (isExportProblem(batch)) return missing(batch.memberIds);
            const row = await record(sha256(canonicalInput(batch)), "pending");
            return { kind: "api", row, connection, batch };
          }
          const built = buildPayrollFile(format, shape, lines);
          if (isExportProblem(built)) return missing(built.memberIds);
          const row = await record(sha256(built.content), "generated");
          return {
            kind: "file",
            result: {
              export: exportItem(row),
              file: {
                fileName: built.fileName,
                contentType: built.contentType,
                content: built.content,
              },
              message: row.reexport
                ? "Exported again. This pay run had been exported before: check payroll will not pay it twice."
                : "Exported.",
            },
          };
        });
      } catch (error) {
        if (dbCode(error) === "23514") {
          const raised = raisedMessage(error);
          if (raised === "payroll_export_not_connected") {
            return notConnected(
              "Xero Payroll was disconnected while exporting. Connect it again, or export a file.",
            );
          }
          return refuse(
            c,
            access,
            id,
            "refused_by_database",
            raised === "payroll_export_not_locked"
              ? new HttpProblem(
                  409,
                  "run_not_locked",
                  "Only a locked pay run's current calculation can be exported.",
                )
              : new HttpProblem(409, "export_refused", "This export cannot be recorded."),
          );
        }
        if (dbCode(error) === "42501")
          return refuse(c, access, id, "refused_by_database", problems.forbidden());
        throw error;
      }
      if (prepared.kind === "file") return c.json(prepared.result, 201);

      // Rule 8: the call to Xero, outside any transaction. A refusal is failed; no answer is
      // unknown, which still counts as exported until someone checks Xero.
      const { row, connection, batch } = prepared;
      const adapter = services.payrollXero;
      let sent: { outcome: "sent" | "failed" | "unknown"; externalRef: string | null };
      let noTokens = false;
      if (!adapter) {
        sent = { outcome: "failed", externalRef: null };
        noTokens = true;
      } else {
        try {
          sent = await adapter.send(connection, batch);
        } catch (error) {
          if (!(error instanceof PayrollNotConnected)) throw error;
          sent = { outcome: "failed", externalRef: null };
          noTokens = true;
        }
      }
      const result = await withTenant(c, async (tx) => {
        const [recorded] = await tx
          .insert(payrollExportResult)
          .values({
            exportId: row.id,
            outcome: sent.outcome,
            externalRef: sent.externalRef,
            recordedBy: access.tenantUserId,
          })
          .returning();
        if (!recorded) throw new Error("result not recorded");
        await audit(c, tx, access, {
          action: A.resultRecorded,
          resourceType: "payroll_export",
          resourceId: row.id,
          scopeExtra: { runId: row.runId, outcome: sent.outcome },
        });
        return recorded;
      });
      if (noTokens) {
        return notConnected(
          "Xero Payroll's connection has no tokens. Connect it again, or export a file.",
        );
      }
      const message =
        sent.outcome === "failed"
          ? "Xero Payroll did not accept the export. Nothing was paid: try again, or export a file."
          : sent.outcome === "unknown"
            ? "Xero Payroll did not answer. Check in Xero whether the pay run arrived before exporting again."
            : row.reexport
              ? "Exported again. This pay run had been exported before: check payroll will not pay it twice."
              : "Exported.";
      return c.json({ export: exportItem(row, result), file: null, message }, 201);
    },
  )
  .openapi(
    createRoute({
      method: "get",
      path: "/v1/payroll-connections",
      tags: ["scheduling"],
      summary: "The organisation's payroll provider connections",
      description: "finance.payroll.export for the whole organisation. Never a secret or a token.",
      security,
      responses: { 200: jsonBody(PayrollConnectionList, "Connections"), ...errorResponses },
    }),
    async (c) => {
      await requireExporter(c, { readsPay: false });
      const items = await withTenant(c, async (tx) =>
        (
          await tx.select().from(payrollConnection).orderBy(desc(payrollConnection.connectedAt))
        ).map(connectionItem),
      );
      return c.json({ items }, 200);
    },
  )
  .openapi(
    createRoute({
      method: "post",
      path: "/v1/payroll-connections",
      tags: ["scheduling"],
      summary: "Record a payroll provider connection",
      description:
        "finance.payroll.export with a fresh sign-in, for the whole organisation, naming the organisation's own secret in the managed store (payroll/{tenant}/{provider}/{connection}; never chosen by the caller), which the OAuth handshake fills (it comes with the live client, H-1190). One connection per provider. Audited.",
      security,
      request: { body: { content: { "application/json": { schema: NewPayrollConnection } } } },
      responses: {
        201: jsonBody(PayrollConnectionItem, "Connected"),
        ...errorResponses,
        ...conflictResponse,
      },
    }),
    async (c) => {
      const access = await requireExporter(c, { readsPay: false });
      const body = c.req.valid("json");
      try {
        const item = await withTenant(c, async (tx) => {
          const [row] = await tx
            .insert(payrollConnection)
            .values({
              provider: body.provider,
              externalOrganisationId: body.externalOrganisationId,
              connectedBy: access.tenantUserId,
            })
            .returning();
          if (!row) throw new Error("connection not stored");
          await audit(c, tx, access, {
            action: A.connected,
            resourceType: "payroll_connection",
            resourceId: row.id,
            scopeExtra: { provider: row.provider },
          });
          return connectionItem(row);
        });
        return c.json(item, 201);
      } catch (error) {
        if (dbCode(error) === "23505") {
          throw new HttpProblem(
            409,
            "already_connected",
            "This provider is already connected. Disconnect it first.",
          );
        }
        throw error;
      }
    },
  )
  .openapi(
    createRoute({
      method: "post",
      path: "/v1/payroll-connections/{id}/disconnect",
      tags: ["scheduling"],
      summary: "Disconnect a payroll provider",
      description:
        "finance.payroll.export with a fresh sign-in, for the whole organisation, against version. Final; connecting again makes a new connection. The secret is removed from the managed store separately (H-1190). Audited.",
      security,
      request: {
        params: RunParam,
        body: { content: { "application/json": { schema: DisconnectPayroll } } },
      },
      responses: {
        200: jsonBody(PayrollConnectionItem, "Disconnected"),
        ...errorResponses,
        ...notFoundResponse,
        ...conflictResponse,
      },
    }),
    async (c) => {
      const access = await requireExporter(c, { readsPay: false });
      const { id } = c.req.valid("param");
      const { version } = c.req.valid("json");
      const item = await withTenant(c, async (tx) => {
        const [current] = await tx
          .select()
          .from(payrollConnection)
          .where(eq(payrollConnection.id, id));
        if (!current) throw problems.notFound();
        if (current.status !== "connected") {
          throw new HttpProblem(
            409,
            "already_disconnected",
            "This connection is already disconnected.",
          );
        }
        const [row] = await tx
          .update(payrollConnection)
          .set({ status: "disconnected" })
          .where(and(eq(payrollConnection.id, id), eq(payrollConnection.version, version)))
          .returning();
        if (!row) throw problems.conflict();
        await audit(c, tx, access, {
          action: A.disconnected,
          resourceType: "payroll_connection",
          resourceId: id,
          scopeExtra: { provider: row.provider },
        });
        return connectionItem(row);
      });
      return c.json(item, 200);
    },
  );
