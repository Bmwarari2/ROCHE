import {
  breakGlassEvent,
  breakGlassWeeklyReport,
  location,
  notification,
  person,
  role,
  roleAssignment,
  type Transaction,
} from "@harbour/db";
import {
  breakGlassWeeklyReport as aggregate,
  type BreakGlassEventView,
  type BreakGlassReasonCode,
  type BreakGlassWeek,
  PEOPLE_RATE_KEYS,
  previousBreakGlassReportWeek,
} from "@harbour/domain";
import { and, eq, gte, isNull, lt } from "drizzle-orm";
import { publish } from "../outbox";
import { registeredManagersAt } from "./people";
import { rateNumber } from "./rates";
import { toJson } from "./safety";

/**
 * The weekly break-glass report (people.md rule 14; PLAT-006; HZ-011): for the UK week before
 * (Monday 00:00 to Monday 00:00), one stored report per location from `breakGlassWeeklyReport`,
 * holding counts and opaque ids only, and one alert with a generic title to the location's
 * Registered Manager and the data protection lead. Idempotent: a week already reported is left
 * alone, so the job can run every day and catch up after a missed Monday.
 */

/** The data protection lead: holders of the quality and compliance lead role (human action H-80). */
export const DATA_PROTECTION_LEAD_ROLES = ["quality_lead"] as const;

async function dataProtectionLeads(tx: Transaction): Promise<string[]> {
  const rows = await tx
    .selectDistinct({ id: roleAssignment.tenantUserId })
    .from(roleAssignment)
    .innerJoin(role, eq(role.id, roleAssignment.roleId))
    .where(
      and(
        eq(role.key, DATA_PROTECTION_LEAD_ROLES[0]),
        isNull(roleAssignment.deletedAt),
        isNull(role.archivedAt),
      ),
    );
  return rows.map((r) => r.id);
}

export async function eventsInWeek(
  tx: Transaction,
  week: BreakGlassWeek,
): Promise<(BreakGlassEventView & { locationId: string })[]> {
  const rows = await tx
    .select({
      id: breakGlassEvent.id,
      tenantUserId: breakGlassEvent.tenantUserId,
      personId: breakGlassEvent.personId,
      reasonCode: breakGlassEvent.reasonCode,
      openedAt: breakGlassEvent.openedAt,
      reviewedAt: breakGlassEvent.reviewedAt,
      locationId: person.locationId,
    })
    .from(breakGlassEvent)
    .innerJoin(person, eq(person.id, breakGlassEvent.personId))
    .where(and(gte(breakGlassEvent.openedAt, week.start), lt(breakGlassEvent.openedAt, week.end)));
  return rows.map((r) => ({ ...r, reasonCode: r.reasonCode as BreakGlassReasonCode | null }));
}

/** Builds and stores last week's report for each location of one tenant (tenant-wide scope). */
export async function generateBreakGlassReports(
  tx: Transaction,
  tenantId: string,
  now: Date,
): Promise<number> {
  const week = previousBreakGlassReportWeek(now);
  const threshold = await rateNumber(tx, tenantId, PEOPLE_RATE_KEYS.breakGlassRepeatThreshold);
  const events = await eventsInWeek(tx, week);
  const locations = await tx
    .select({ id: location.id })
    .from(location)
    .where(isNull(location.deletedAt));
  const leads = await dataProtectionLeads(tx);
  let stored = 0;
  for (const { id: locationId } of locations) {
    const report = aggregate(
      events.filter((e) => e.locationId === locationId),
      week,
      threshold,
    );
    const [inserted] = await tx
      .insert(breakGlassWeeklyReport)
      .values({
        locationId,
        weekStart: week.start,
        weekEnd: week.end,
        generatedAt: now,
        repeatThreshold: threshold,
        summary: toJson(report) as Record<string, unknown>,
      })
      .onConflictDoNothing()
      .returning({ id: breakGlassWeeklyReport.id });
    if (!inserted) continue;
    stored++;
    const recipients = new Set([...(await registeredManagersAt(tx, locationId)), ...leads]);
    for (const recipient of recipients) {
      await tx
        .insert(notification)
        .values({
          recipientTenantUserId: recipient,
          kind: "people.break_glass_report",
          severity: report.flagged.length > 0 ? "warning" : "info",
          title: "The weekly break-glass report is ready",
          body: "Open the report to review last week's break-glass access.",
          link: "/break-glass/weekly-report",
          channels: ["in_app", "email"],
          sourceType: "break_glass_weekly_report",
          sourceId: inserted.id,
          dedupeKey: `break_glass_report:${inserted.id}:${recipient}`,
        })
        .onConflictDoNothing();
    }
    await publish(tx, {
      context: "people",
      aggregateType: "break_glass_weekly_report",
      aggregateId: inserted.id,
      type: "people.break_glass.weekly_report",
      payload: {
        reportId: inserted.id,
        locationId,
        weekStart: week.start.toISOString(),
        totalEvents: report.totalEvents,
        flagged: report.flagged.length,
      },
    });
  }
  return stored;
}
