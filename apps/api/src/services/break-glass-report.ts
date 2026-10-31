import {
  breakGlassEvent,
  breakGlassWeeklyReport,
  location,
  notification,
  person,
  type Transaction,
} from "@harbour/db";
import {
  breakGlassWeeklyReport as aggregate,
  type BreakGlassEventView,
  type BreakGlassReasonCode,
  type BreakGlassSearchView,
  type BreakGlassWeek,
  PEOPLE_RATE_KEYS,
  previousBreakGlassReportWeek,
  resolveAccess,
  scopeFor,
} from "@harbour/domain";
import { and, eq, gte, isNull, lt } from "drizzle-orm";
import { publish } from "../outbox";
import { accessRowsOf } from "./access-rows";
import { registeredManagersAt } from "./people";
import { rateNumber } from "./rates";
import { roleHolders } from "./role-holders";
import { toJson } from "./safety";

/**
 * The weekly break-glass report (people.md rule 14; PLAT-006; HZ-011): for the UK week before
 * (Monday 00:00 to Monday 00:00), one stored report per location from `breakGlassWeeklyReport`,
 * holding counts and opaque ids only, and one alert with a generic title to the location's
 * Registered Manager and the data protection lead. Idempotent: a week already reported is left
 * alone, so the job can run every day and catch up after a missed Monday.
 */

/**
 * A break-glass alert no one active could be sent (ADR-0071 review round 4): audited as the
 * system with a coded reason, and counted in the operator's daily unrouted signal.
 */
export const BREAK_GLASS_ALERT_UNROUTED_ACTION = "people.break_glass_alert.unrouted";

/** The data protection lead: holders of the quality and compliance lead role (human action H-80). */
export const DATA_PROTECTION_LEAD_ROLES = ["quality_lead"] as const;

async function dataProtectionLeads(tx: Transaction, now: Date): Promise<string[]> {
  // A role in force, on the staff, anywhere (ADR-0071 review round 2), as for the alert when a
  // record is opened by break-glass.
  return roleHolders(tx, DATA_PROTECTION_LEAD_ROLES, null, now);
}

/**
 * Of these members, those whose `platform.audit.read` reaches the whole organisation now: the
 * only readers given a report's organisation-wide section (the route's `summaryFor`).
 */
async function readersAcrossOrganisation(
  tx: Transaction,
  ids: readonly string[],
  now: Date,
): Promise<Set<string>> {
  if (ids.length === 0) return new Set();
  const rows = await accessRowsOf(tx, ids);
  return new Set(
    ids.filter((id) => {
      const mine = rows.get(id);
      if (!mine) return false;
      const access = resolveAccess(mine.assignments, mine.grants, now);
      return scopeFor(access, "platform.audit.read").scope === "tenant";
    }),
  );
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
    .where(
      and(
        // Openings only: break-glass searches name no one person (a later step lists them).
        eq(breakGlassEvent.kind, "open"),
        gte(breakGlassEvent.openedAt, week.start),
        lt(breakGlassEvent.openedAt, week.end),
      ),
    );
  return rows.flatMap((r) =>
    r.personId
      ? [{ ...r, personId: r.personId, reasonCode: r.reasonCode as BreakGlassReasonCode | null }]
      : [],
  );
}

/**
 * The week's break-glass searches, each with the homes whose people it showed. A search that
 * showed no one at a home (no match, or only people without a home) has no locations: the report
 * puts it in every report's tenant-level section, read only across the organisation, so it is
 * still reported weekly (master prompt section 4) without naming its searcher to a location's
 * manager (review round 1 of feat/web-break-glass-report).
 */
export async function searchesInWeek(
  tx: Transaction,
  week: BreakGlassWeek,
): Promise<(BreakGlassSearchView & { locationIds: readonly string[] })[]> {
  const rows = await tx
    .select({
      id: breakGlassEvent.id,
      tenantUserId: breakGlassEvent.tenantUserId,
      reasonCode: breakGlassEvent.reasonCode,
      openedAt: breakGlassEvent.openedAt,
      locationIds: breakGlassEvent.shownLocationIds,
    })
    .from(breakGlassEvent)
    .where(
      and(
        eq(breakGlassEvent.kind, "search"),
        gte(breakGlassEvent.openedAt, week.start),
        lt(breakGlassEvent.openedAt, week.end),
      ),
    );
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
  const searches = await searchesInWeek(tx, week);
  const locations = await tx
    .select({ id: location.id })
    .from(location)
    .where(isNull(location.deletedAt));
  const leads = await dataProtectionLeads(tx, now);
  const organisationReaders = await readersAcrossOrganisation(tx, leads, now);
  // A search that showed no one at any location is the organisation's, not a location's: it goes
  // in each report's tenant-level section, which only readers reaching the whole organisation see
  // (review round 1 of feat/web-break-glass-report), never in a location's own searches.
  const unplaced = searches.filter((e) => e.locationIds.length === 0);
  let stored = 0;
  for (const { id: locationId } of locations) {
    const report = aggregate(
      events.filter((e) => e.locationId === locationId),
      week,
      threshold,
      searches.filter((e) => e.locationIds.includes(locationId)),
      unplaced,
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
    const recipients = new Set([...(await registeredManagersAt(tx, locationId, now)), ...leads]);
    const locationFlagged =
      report.flagged.length > 0 || report.searches.byUser.some((u) => u.flags.length > 0);
    // The tenant-level section's flags raise the alert only for the data protection leads whose
    // `platform.audit.read` reaches the whole organisation, the only ones who read it; nobody is
    // told of searches they cannot see (security re-review I-1).
    const unplacedFlagged = report.unplacedSearches.byUser.some((u) => u.flags.length > 0);
    for (const recipient of recipients) {
      await tx
        .insert(notification)
        .values({
          recipientTenantUserId: recipient,
          kind: "people.break_glass_report",
          severity:
            locationFlagged || (unplacedFlagged && organisationReaders.has(recipient))
              ? "warning"
              : "info",
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
        searches: report.searches.total,
        flagged: report.flagged.length,
      },
    });
  }
  return stored;
}
