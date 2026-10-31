import {
  BreakGlassWeeklyReportList,
  type BreakGlassWeeklyReportOut,
  ReviewBreakGlassReport,
} from "@harbour/contracts";
import { breakGlassWeeklyReport, type Transaction } from "@harbour/db";
import {
  breakGlassReportWeek,
  type Permission,
  previousBreakGlassReportWeek,
  scopeFor,
  ukDayBounds,
} from "@harbour/domain";
import { createRoute, z } from "@hono/zod-openapi";
import { and, eq, isNull } from "drizzle-orm";
import { requirePermission, withTenant } from "../http/context";
import { HttpProblem, problems } from "../http/problem";
import { type StaffLookup, staffNames } from "../services/staff";
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
 * complete week. Counts and opaque ids only, with the names of the staff it counts for attribution
 * (StaffName); the justifications stay in the audit log. Each report also stores the organisation's
 * searches that showed no one at any location (a tenant-level section), shown, with its searchers'
 * names, only to readers whose access reaches the whole organisation. A review is a new row that
 * supersedes the report, with the actions taken, never by anyone the report counts.
 */

type ReportRow = typeof breakGlassWeeklyReport.$inferSelect;

interface SummaryIds {
  readonly byUser?: readonly { readonly tenantUserId?: unknown }[];
  readonly flagged?: readonly { readonly tenantUserId?: unknown }[];
  readonly searches?: { readonly byUser?: readonly { readonly tenantUserId?: unknown }[] };
  readonly unplacedSearches?: { readonly byUser?: readonly { readonly tenantUserId?: unknown }[] };
}

const idsOf = (lines: unknown): string[] =>
  Array.isArray(lines)
    ? lines.flatMap((l) =>
        typeof (l as { tenantUserId?: unknown })?.tenantUserId === "string"
          ? [(l as { tenantUserId: string }).tenantUserId]
          : [],
      )
    : [];

/**
 * Everyone a stored report counts: its user lines, flags and searchers, and, with
 * `organisationWide`, the searchers in its tenant-level section (searches that showed no one at
 * any location). The reviewer is added for naming, never for separation of duties.
 */
export function reportStaffIds(
  row: Pick<ReportRow, "summary">,
  organisationWide: boolean,
): string[] {
  const summary = (row.summary ?? {}) as SummaryIds;
  return [
    ...new Set([
      ...idsOf(summary.byUser),
      ...idsOf(summary.flagged),
      ...idsOf(summary.searches?.byUser),
      ...(organisationWide ? idsOf(summary.unplacedSearches?.byUser) : []),
    ]),
  ];
}

/**
 * The summary as this reader may read it: the tenant-level section only for a reader whose access
 * reaches the whole organisation (review round 1), so a location's manager is never shown, or
 * told the names of, searches that showed no one at their location.
 */
function summaryFor(row: ReportRow, organisationWide: boolean): Record<string, unknown> {
  const summary = row.summary as Record<string, unknown>;
  if (organisationWide) return summary;
  const { unplacedSearches: _withheld, ...rest } = summary;
  return rest;
}

/**
 * The staff this reader is told the names of: everyone the report counts, as far as the reader
 * may see it, and its reviewer. A report stored before the organisation-wide section existed (no
 * `unplacedSearches` key) has searches that showed no one at any location mixed into its own
 * searches, so a reader who does not reach the whole organisation is told only the names of those
 * on its opening lines and flags, never its searchers (security re-review L-1). Separation of
 * duties always uses the full set (`reportStaffIds(row, true)`).
 */
function namedIds(row: ReportRow, organisationWide: boolean): string[] {
  const summary = (row.summary ?? {}) as SummaryIds & Record<string, unknown>;
  const ids =
    organisationWide || "unplacedSearches" in summary
      ? reportStaffIds(row, organisationWide)
      : [...new Set([...idsOf(summary.byUser), ...idsOf(summary.flagged)])];
  return row.reviewedBy && !ids.includes(row.reviewedBy) ? [...ids, row.reviewedBy] : ids;
}

function reportOut(
  row: ReportRow,
  names: StaffLookup,
  organisationWide: boolean,
): BreakGlassWeeklyReportOut {
  return {
    id: row.id,
    locationId: row.locationId,
    weekStart: row.weekStart.toISOString(),
    weekEnd: row.weekEnd.toISOString(),
    generatedAt: row.generatedAt.toISOString(),
    repeatThreshold: row.repeatThreshold,
    summary: summaryFor(row, organisationWide),
    reviewedBy: row.reviewedBy,
    reviewedAt: iso(row.reviewedAt),
    actionsTaken: row.actionsTaken,
    supersedesId: row.supersedesId,
    staff: namedIds(row, organisationWide).flatMap((id) => {
      const name = names(id);
      return name ? [name] : [];
    }),
  };
}

/** Each report with the staff it names, looked up in the reader's transaction. */
async function reportsOut(tx: Transaction, rows: readonly ReportRow[], organisationWide: boolean) {
  const names = await staffNames(
    tx,
    rows.flatMap((row) => namedIds(row, organisationWide)),
  );
  return rows.map((row) => reportOut(row, names, organisationWide));
}

/** Reading and reviewing the reports: the audit reader's permission, where it reaches. */
const PERMISSION: Permission = "platform.audit.read";

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
      const access = await requirePermission(c, PERMISSION);
      const { week: day } = c.req.valid("query");
      const week = day
        ? breakGlassReportWeek(ukDayBounds(day).startsAt)
        : previousBreakGlassReportWeek(new Date());
      const items = await withTenant(c, async (tx) => {
        // Row-level security limits the rows; the API checks the locations again (ADR-0002), where
        // the roles and grants carrying the permission reach (ADR-0071).
        const { scope, locationIds } = scopeFor(access.effective, PERMISSION);
        const rows = (
          await tx
            .select()
            .from(breakGlassWeeklyReport)
            .where(eq(breakGlassWeeklyReport.weekStart, week.start))
        ).filter((r) => scope === "tenant" || locationIds.includes(r.locationId));
        rows.sort(
          (a, b) =>
            a.locationId.localeCompare(b.locationId) ||
            a.createdAt.getTime() - b.createdAt.getTime(),
        );
        await audit(c, tx, access, {
          action: "platform.break_glass_report.view",
          resourceType: "break_glass_weekly_report",
          // Which reports were shown, by id (review round 1), as well as how many.
          scope: {
            weekStart: week.start.toISOString(),
            count: rows.length,
            reportIds: rows.map((r) => r.id),
            // Whether the organisation-wide section and its searchers' names were shown.
            organisationWide: scope === "tenant",
          },
        });
        return reportsOut(tx, rows, scope === "tenant");
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
      const access = await requirePermission(c, PERMISSION);
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
        const { scope, locationIds } = scopeFor(access.effective, PERMISSION);
        if (scope !== "tenant" && !locationIds.includes(original.locationId)) {
          throw problems.notFound();
        }
        // Nobody reviews a report that counts their own use of break-glass, flagged or not: an
        // opening, a search at the location or one that showed no one at any location (review
        // round 1; the opener-reviewer separation of master prompt section 4).
        if (reportStaffIds(original, true).includes(access.tenantUserId)) {
          throw new HttpProblem(
            403,
            "separation_of_duties",
            "Someone else must review this report.",
            "This report counts your own use of break-glass access, so another reviewer records the review.",
          );
        }
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
        const organisationWide = scope === "tenant";
        return reportOut(
          row,
          await staffNames(tx, namedIds(row, organisationWide)),
          organisationWide,
        );
      });
      return c.json(out, 201);
    },
  );
