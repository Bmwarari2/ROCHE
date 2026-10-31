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
} from "@harbour/domain";
import { createRoute, z } from "@hono/zod-openapi";
import { and, desc, eq, isNull, ne, sql } from "drizzle-orm";
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
  connected: "scheduling.payroll_connection.connected",
  disconnected: "scheduling.payroll_connection.disconnected",
} as const;

const sha256 = (text: string) => createHash("sha256").update(text, "utf8").digest("hex");

type ExportRow = typeof payrollExport.$inferSelect;
type ConnectionRow = typeof payrollConnection.$inferSelect;

const exportItem = (r: ExportRow): z.infer<typeof PayrollExportItem> => ({
  id: r.id,
  runId: r.runId,
  calculation: r.calculation,
  format: r.format as z.infer<typeof PayrollExportItem>["format"],
  formatVersion: r.formatVersion,
  lineCount: r.lineCount,
  contentSha256: r.contentSha256,
  reexport: r.reexport,
  outcome: r.outcome as z.infer<typeof PayrollExportItem>["outcome"],
  externalRef: r.externalRef,
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

/** The run's current calculation's lines, as they may leave (rule 4), with payroll references. */
async function exportLines(
  tx: Transaction,
  run: { readonly id: string; readonly calculation: number },
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
    payrollReference: reference ?? null,
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
          .select()
          .from(payrollExport)
          .where(eq(payrollExport.runId, id))
          .orderBy(desc(payrollExport.exportedAt));
        return rows.map(exportItem);
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
      try {
        const result = await withTenant(c, async (tx) => {
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
          const [earlier] = await tx
            .select({ id: payrollExport.id })
            .from(payrollExport)
            .where(
              and(
                eq(payrollExport.runId, id),
                eq(payrollExport.calculation, run.calculation),
                ne(payrollExport.outcome, "failed"),
              ),
            )
            .limit(1);
          if (earlier && !confirmReexport) {
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
          const lines = await exportLines(tx, run);
          const shape = {
            id: run.id,
            frequency: run.frequency,
            periodStart: run.periodStart,
            periodEnd: run.periodEnd,
          };
          let file: z.infer<typeof PayrollExportResult>["file"] = null;
          let contentSha256: string;
          let outcome: "generated" | "sent" | "failed" = "generated";
          let externalRef: string | null = null;
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
              return refuse(
                c,
                access,
                id,
                "integration_not_connected",
                new HttpProblem(
                  409,
                  "integration_not_connected",
                  "Xero Payroll is not connected for your organisation. Connect it first, or export a file.",
                ),
              );
            }
            const batch = buildXeroBatch(shape, lines);
            if (isExportProblem(batch)) {
              return refuse(
                c,
                access,
                id,
                "payroll_reference_missing",
                new HttpProblem(
                  422,
                  "payroll_reference_missing",
                  "Some members have no payroll reference. Add one to each member's pay profile.",
                  batch.memberIds.join(", "),
                ),
              );
            }
            contentSha256 = sha256(canonicalInput(batch));
            const sent = await services.payrollXero.send(connection, batch);
            outcome = sent.outcome;
            externalRef = sent.externalRef;
          } else {
            const built = buildPayrollFile(format, shape, lines);
            if (isExportProblem(built)) {
              return refuse(
                c,
                access,
                id,
                "payroll_reference_missing",
                new HttpProblem(
                  422,
                  "payroll_reference_missing",
                  "Some members have no payroll reference. Add one to each member's pay profile.",
                  built.memberIds.join(", "),
                ),
              );
            }
            contentSha256 = sha256(built.content);
            file = {
              fileName: built.fileName,
              contentType: built.contentType,
              content: built.content,
            };
          }
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
              externalRef,
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
          const message =
            outcome === "failed"
              ? "Xero Payroll did not accept the export. Nothing was paid: try again, or export a file."
              : row.reexport
                ? "Exported again. This pay run had been exported before: check payroll will not pay it twice."
                : "Exported.";
          return { export: exportItem(row), file, message };
        });
        return c.json(result, 201);
      } catch (error) {
        if (error instanceof PayrollNotConnected) {
          return refuse(
            c,
            access,
            id,
            "integration_not_connected",
            new HttpProblem(
              409,
              "integration_not_connected",
              "Xero Payroll's connection has no tokens. Connect it again, or export a file.",
            ),
          );
        }
        const code = dbCode(error);
        if (code === "23514") {
          return refuse(
            c,
            access,
            id,
            "refused_by_database",
            new HttpProblem(
              409,
              "run_not_locked",
              "Only a locked pay run's current calculation can be exported.",
            ),
          );
        }
        if (code === "42501")
          return refuse(c, access, id, "refused_by_database", problems.forbidden());
        throw error;
      }
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
        "finance.payroll.export with a fresh sign-in, for the whole organisation, after the OAuth handshake has stored the tokens in the managed secret store under secretRef (the handshake itself comes with the live client, H-1190). One connection per provider. Audited.",
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
              secretRef: body.secretRef,
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
