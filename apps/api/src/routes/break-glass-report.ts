import {
  BreakGlassWeeklyReportList,
  type BreakGlassWeeklyReportOut,
  ReviewBreakGlassReport,
} from "@harbour/contracts";
import { breakGlassWeeklyReport } from "@harbour/db";
import { breakGlassReportWeek, previousBreakGlassReportWeek, ukDayBounds } from "@harbour/domain";
import { createRoute, z } from "@hono/zod-openapi";
import { and, eq, isNull } from "drizzle-orm";
import { requirePermission, withTenant } from "../http/context";
import { problems } from "../http/problem";
import {
  conflictResponse,
  createRouter,
  errorResponses,
  jsonBody,
  notFoundResponse,
  security,
} from "./openapi";
import { audit, iso } from "./people-shared";

/**
 * The weekly break-glass report (people.md rule 14; PLAT-006; HZ-011): the stored report for each
 * location the reader can see, for the UK week (Monday to Monday) containing a date, or the last
 * complete week. Counts and opaque ids only; the justifications stay in the audit log. A review is
 * a new row that supersedes the report, with the actions taken.
 */

type ReportRow = typeof breakGlassWeeklyReport.$inferSelect;

function reportOut(row: ReportRow): BreakGlassWeeklyReportOut {
  return {
    id: row.id,
    locationId: row.locationId,
    weekStart: row.weekStart.toISOString(),
    weekEnd: row.weekEnd.toISOString(),
    generatedAt: row.generatedAt.toISOString(),
    repeatThreshold: row.repeatThreshold,
    summary: row.summary as Record<string, unknown>,
    reviewedBy: row.reviewedBy,
    reviewedAt: iso(row.reviewedAt),
    actionsTaken: row.actionsTaken,
    supersedesId: row.supersedesId,
  };
}

export const breakGlassReportRouter = createRouter()
  .openapi(
    createRoute({
      method: "get",
      path: "/v1/break-glass/weekly-report",
      tags: ["platform"],
      summary: "The weekly break-glass report for each location you can see",
      description:
        "`week` is any date in the UK week wanted (Monday 00:00 to Monday 00:00); the last complete week by default. Reports are built by the Monday worker job; a review appears as a later row that supersedes the report.",
      security,
      request: { query: z.object({ week: z.iso.date().optional() }) },
      responses: { 200: jsonBody(BreakGlassWeeklyReportList, "Reports"), ...errorResponses },
    }),
    async (c) => {
      const access = await requirePermission(c, "platform.audit.read");
      const { week: day } = c.req.valid("query");
      const week = day
        ? breakGlassReportWeek(ukDayBounds(day).startsAt)
        : previousBreakGlassReportWeek(new Date());
      const items = await withTenant(c, async (tx) => {
        const rows = await tx
          .select()
          .from(breakGlassWeeklyReport)
          .where(eq(breakGlassWeeklyReport.weekStart, week.start));
        await audit(c, tx, access, {
          action: "platform.break_glass_report.view",
          resourceType: "break_glass_weekly_report",
          scope: { weekStart: week.start.toISOString(), count: rows.length },
        });
        return rows
          .sort(
            (a, b) =>
              a.locationId.localeCompare(b.locationId) ||
              a.createdAt.getTime() - b.createdAt.getTime(),
          )
          .map(reportOut);
      });
      return c.json(
        { weekStart: week.start.toISOString(), weekEnd: week.end.toISOString(), items },
        200,
      );
    },
  )
  .openapi(
    createRoute({
      method: "post",
      path: "/v1/break-glass/weekly-report/{reportId}/review",
      tags: ["platform"],
      summary: "Record the review of a weekly report and the actions taken",
      security,
      request: {
        params: z.object({ reportId: z.uuid() }),
        body: { content: { "application/json": { schema: ReviewBreakGlassReport } } },
      },
      responses: {
        201: jsonBody(BreakGlassWeeklyReportList.shape.items.element, "Reviewed"),
        ...errorResponses,
        ...notFoundResponse,
        ...conflictResponse,
      },
    }),
    async (c) => {
      const access = await requirePermission(c, "platform.audit.read");
      const { reportId } = c.req.valid("param");
      const body = c.req.valid("json");
      const now = new Date();
      const out = await withTenant(c, async (tx) => {
        const [original] = await tx
          .select()
          .from(breakGlassWeeklyReport)
          .where(
            and(
              eq(breakGlassWeeklyReport.id, reportId),
              isNull(breakGlassWeeklyReport.supersedesId),
            ),
          );
        if (!original) throw problems.notFound();
        const [row] = await tx
          .insert(breakGlassWeeklyReport)
          .values({
            locationId: original.locationId,
            weekStart: original.weekStart,
            weekEnd: original.weekEnd,
            generatedAt: original.generatedAt,
            repeatThreshold: original.repeatThreshold,
            summary: original.summary,
            reviewedBy: access.tenantUserId,
            reviewedAt: now,
            actionsTaken: body.actionsTaken,
            supersedesId: original.id,
          })
          .onConflictDoNothing()
          .returning();
        if (!row) throw problems.conflict("This report has already been reviewed.");
        await audit(c, tx, access, {
          action: "platform.break_glass_report.review",
          resourceType: "break_glass_weekly_report",
          resourceId: row.id,
        });
        return reportOut(row);
      });
      return c.json(out, 201);
    },
  );
