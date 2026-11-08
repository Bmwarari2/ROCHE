import {
  RetentionDue,
  type RetentionReportCounts,
  type RetentionReportLine,
} from "@harbour/contracts";
import { retentionReport } from "@harbour/db";
import { scopeFor } from "@harbour/domain";
import { createRoute } from "@hono/zod-openapi";
import { desc } from "drizzle-orm";
import { auditInTx } from "../http/audit";
import { requirePermission, withTenant } from "../http/context";
import { problems } from "../http/problem";
import { retentionSweepMode } from "../services/retention-report";
import { createRouter, errorResponses, jsonBody, security } from "./openapi";

/**
 * The retention report (retention sweeps plan 5.4 and 5.9, slice 4; ADR-0135): the latest counts
 * of records due, held and kept, per table and class, for the data protection lead's tenant-wide
 * roles with `platform.retention.manage` (step-up, as every retention route). Counts only: no
 * record id, subject or date. Viewing it is audited by the report's id.
 */

export const REPORT_VIEWED_ACTION = "platform.retention.report_viewed";

export const retentionReportRouter = createRouter().openapi(
  createRoute({
    method: "get",
    path: "/v1/retention/due",
    tags: ["platform"],
    summary: "The latest retention report: counts of records due, held and kept",
    description:
      "Counts per table and record class from the nightly retention sweep in report mode; null until a report has run. Nothing is destroyed. Tenant-wide holders of platform.retention.manage.",
    security,
    responses: { 200: jsonBody(RetentionDue, "The latest report"), ...errorResponses },
  }),
  async (c) => {
    const access = await requirePermission(c, "platform.retention.manage");
    if (scopeFor(access.effective, "platform.retention.manage").scope !== "tenant") {
      throw problems.forbidden();
    }
    const body = await withTenant(c, async (tx): Promise<RetentionDue> => {
      const mode = await retentionSweepMode(tx);
      const [row] = await tx
        .select()
        .from(retentionReport)
        .orderBy(desc(retentionReport.asOf), desc(retentionReport.id))
        .limit(1);
      await auditInTx(tx, access, {
        action: REPORT_VIEWED_ACTION,
        resourceType: "retention_report",
        ...(row ? { resourceId: row.id } : {}),
        scope: { found: row !== undefined },
        requestId: c.get("requestId"),
      });
      if (!row) return { mode, report: null };
      return {
        mode,
        report: {
          id: row.id,
          asOf: row.asOf.toISOString(),
          durationMs: row.durationMs,
          tablesRead: row.tablesRead,
          tablesSkipped: row.tablesSkipped,
          totals: row.totals as RetentionReportCounts,
          lines: row.lines as RetentionReportLine[],
        },
      };
    });
    return c.json(body, 200);
  },
);
