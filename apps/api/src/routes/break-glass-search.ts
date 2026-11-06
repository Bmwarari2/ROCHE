import { BreakGlassSearchResults, RunBreakGlassSearch } from "@harbour/contracts";
import { auditEvent, breakGlassEvent, notification, tenant } from "@harbour/db";
import {
  breakGlassSearchAlert,
  buildBreakGlassSearchPlan,
  filterSearchResults,
  type PersonStatus,
  type SearchHit,
  type SearchPlanProblem,
  searchAuditEvent,
  searchRefusalAuditEvent,
} from "@harbour/domain";
import { createRoute } from "@hono/zod-openapi";
import { and, count, eq, gt, sql } from "drizzle-orm";
import { AuditedRefusal, withAuditedRefusal, writeAudit } from "../http/audit";
import {
  inScopeOf,
  requirePermission,
  stepUpAtFor,
  type TenantAccess,
  withTenant,
} from "../http/context";
import { HttpProblem, problems } from "../http/problem";
import { rateNumber } from "../services/rates";
import { roleHolders, toldOf } from "../services/role-holders";
import { createRouter, errorResponses, jsonBody, security } from "./openapi";
import { audit } from "./people-shared";

/**
 * Break-glass search (platform-completions.md rule 9; master prompt section 4; HZ-001, HZ-011):
 * finding a person outside the user's scope. `platform.search.use` and `people.person.break_glass`
 * with step-up, a reason code and a typed reason of 20 characters or more, a specific query (an
 * NHS number, or at least two name words matched whole), and fewer than
 * `break_glass.search_max_per_day` such searches by the user in 24 hours. Results are people only,
 * at most 10, across the organisation, with identity fields only and read-only: location and room
 * are withheld until the record is opened through the ordinary break-glass step. The typed reason
 * is kept once, in a `search` break-glass record that opens nothing; the search alerts the
 * Registered Manager of each home whose people were shown and the data protection lead; reaching
 * the daily limit refuses and tells the data protection lead. Anyone who could not be told (no
 * Registered Manager in force at a home shown, or no active data protection lead) is audited as
 * unrouted. The count and the record are taken under a lock on the user, so two searches at once
 * cannot both pass the limit. Audited with ids only; the weekly report lists searches by home shown.
 */

/** Recipients of a break-glass search alert who could not be told, as a coded audit reason. */
export type UnroutedReason = "no_registered_manager" | "no_data_protection_lead";

type Tx = Parameters<Parameters<typeof withTenant>[1]>[0];

/** The data protection lead named on the organisation, if they may be told now (`toldOf`). */
async function activeLead(tx: Tx, tenantId: string): Promise<string | null> {
  const [org] = await tx
    .select({ lead: tenant.dataProtectionLeadId })
    .from(tenant)
    .where(eq(tenant.id, tenantId));
  if (!org?.lead) return null;
  return (await toldOf(tx, [org.lead])).has(org.lead) ? org.lead : null;
}

async function auditUnrouted(
  tx: Tx,
  resourceType: string,
  resourceId: string,
  reasons: readonly UnroutedReason[],
  locationIds: readonly string[],
): Promise<void> {
  if (reasons.length === 0) return;
  await tx.insert(auditEvent).values({
    tenantId: sql`app.current_tenant_id()`,
    action: "platform.search.break_glass_alert_unrouted",
    outcome: "error",
    resourceType,
    resourceId,
    reason: reasons.join(","),
    scope: { locationIds: [...locationIds] },
  });
}

const TENANT_WIDE = {
  scope: "tenant" as const,
  locationIds: [] as string[],
  includesAssigned: false,
  includesBreakGlass: false,
};

const QUERY_PROBLEMS = new Set<SearchPlanProblem>([
  "empty",
  "too_long",
  "too_short",
  "invalid_nhs_number",
  "query_not_specific",
  "reason_too_short",
  "reason_too_long",
  "reason_code_required",
  "archived_not_permitted",
]);

function problemFor(problem: SearchPlanProblem, message: string, access: TenantAccess) {
  if (QUERY_PROBLEMS.has(problem)) return problems.invalid(message);
  if (problem === "step_up_required") return problems.stepUp();
  if (problem === "mfa_required") {
    return new HttpProblem(
      403,
      access.mfaEnrolled ? "mfa_verification_required" : "mfa_enrolment_required",
      message,
    );
  }
  if (problem === "rate_limited") return new HttpProblem(429, "rate_limited", message);
  return new HttpProblem(403, problem, message);
}

export const breakGlassSearchRouter = createRouter().openapi(
  createRoute({
    method: "post",
    path: "/v1/search/break-glass",
    tags: ["platform"],
    summary: "Find a person outside your access, with a reason",
    description:
      "Needs step-up, a reason code and a typed reason. NHS number or full name, whole words only; at most 10 people, identity only. Alerts the Registered Manager and the data protection lead, is limited per day, and is audited with ids only; the reason is kept in the break-glass record.",
    security,
    request: { body: { content: { "application/json": { schema: RunBreakGlassSearch } } } },
    responses: { 200: jsonBody(BreakGlassSearchResults, "People found"), ...errorResponses },
  }),
  async (c) => {
    await requirePermission(c, "platform.search.use");
    // Step-up and MFA are checked here, and refusals audited, as for opening a record.
    const access = await requirePermission(c, "people.person.break_glass");
    const body = c.req.valid("json");
    const now = new Date();
    let limitReached = false;
    const out = await withAuditedRefusal(c, access, () =>
      withTenant(c, async (tx) => {
        // One search at a time per user: the count and the insert below cannot interleave.
        await tx.execute(
          sql`SELECT pg_advisory_xact_lock(hashtext(${`break_glass_search:${access.tenantUserId}`}))`,
        );
        const [used] = await inScopeOf(tx, TENANT_WIDE, () =>
          tx
            .select({ n: count() })
            .from(breakGlassEvent)
            .where(
              and(
                eq(breakGlassEvent.tenantUserId, access.tenantUserId),
                eq(breakGlassEvent.kind, "search"),
                gt(breakGlassEvent.openedAt, new Date(now.getTime() - 24 * 3_600_000)),
              ),
            ),
        );
        const checked = buildBreakGlassSearchPlan(
          {
            rawQuery: body.query,
            reason: body.reason,
            reasonCode: body.reasonCode,
            includeArchived: body.includeArchived,
          },
          {
            access: access.effective,
            mfaEnrolled: access.mfaSatisfied,
            stepUpAt: stepUpAtFor(access, now),
            searchesInLast24Hours: Number(used?.n ?? 0),
          },
          now,
          access.stepUpWindowSeconds,
          {
            breakGlassSearchMaxPerDay: await rateNumber(
              tx,
              access.tenantId,
              "break_glass.search_max_per_day",
            ),
          },
        );
        if (!checked.ok) {
          if (checked.problem === "rate_limited") {
            limitReached = true;
            return null;
          }
          const event = searchRefusalAuditEvent(checked.problem, ["person"], { breakGlass: true });
          throw new AuditedRefusal(problemFor(checked.problem, checked.message, access), {
            action: event.action,
            outcome: event.outcome,
            resourceType: event.resourceType,
            scope: event.scope,
          });
        }
        const plan = checked.plan;
        const query = plan.query;
        const statuses = plan.personStatuses.join(",");
        const where =
          query.kind === "nhs_number"
            ? sql`p.nhs_number = ${query.nhsNumber}`
            : sql`p.search_names @@ to_tsquery('app.harbour_search', ${query.exactTsQuery})`;
        // Across the organisation, by the names alone (never rooms), whole words only.
        const rows = await inScopeOf(
          tx,
          TENANT_WIDE,
          async () =>
            (
              await tx.execute<Record<string, unknown>>(sql`
              SELECT p.id, p.given_name, p.family_name, p.preferred_name,
                     p.date_of_birth::text AS dob, p.nhs_number, p.status, p.location_id
              FROM person p
              WHERE p.tenant_id = ${access.tenantId} AND p.deleted_at IS NULL
                AND p.status::text = ANY(string_to_array(${statuses}, ','))
                AND ${where}
              ORDER BY p.family_name, p.given_name, p.id
              LIMIT ${plan.pageSize + 1}`)
            ).rows,
        );
        const hits: SearchHit[] = rows.map((r) => ({
          entityType: "person",
          id: String(r.id),
          rank: 1,
          matchQuality: "exact",
          sortName: `${r.given_name} ${r.family_name}`,
          dateOfBirth: r.dob ? String(r.dob) : null,
          personId: String(r.id),
          personStatus: r.status as PersonStatus,
          personLocationId: r.location_id ? String(r.location_id) : null,
          assignedToActor: false,
        }));
        const page = filterSearchResults(plan, hits, now);
        const alert = breakGlassSearchAlert(page);

        // The record holds the reason once, and the homes whose people were shown (for the weekly
        // report); it opens nothing.
        const [record] = await tx
          .insert(breakGlassEvent)
          .values({
            tenantUserId: access.tenantUserId,
            kind: "search",
            personId: null,
            shownLocationIds: [...alert.locationIds],
            justification: body.reason.trim(),
            reasonCode: body.reasonCode,
            openedAt: now,
            expiresAt: now,
          })
          .returning({ id: breakGlassEvent.id });
        if (!record) throw problems.conflict();

        // The alert, as soon as the search runs: the Registered Manager of each home whose people
        // were shown, and the data protection lead; never the searcher themselves.
        const unrouted: UnroutedReason[] = [];
        const managers = new Set<string>();
        for (const locationId of alert.locationIds) {
          const atHome = await roleHolders(tx, ["registered_manager"], [locationId], now);
          if (atHome.length === 0 && !unrouted.includes("no_registered_manager")) {
            unrouted.push("no_registered_manager");
          }
          for (const id of atHome) managers.add(id);
        }
        const lead = await activeLead(tx, access.tenantId);
        if (!lead) unrouted.push("no_data_protection_lead");
        const recipients = [...new Set([...managers, ...(lead ? [lead] : [])])].filter(
          (id) => id !== access.tenantUserId,
        );
        for (const recipient of recipients) {
          await tx.insert(notification).values({
            recipientTenantUserId: recipient,
            kind: "platform.search.break_glass",
            severity: "warning",
            title: alert.title,
            body: alert.body,
            link: "/settings/audit",
            channels: ["in_app", "push"],
            sourceType: "break_glass_event",
            sourceId: record.id,
            dedupeKey: `break_glass_search:${record.id}:${recipient}`,
          });
        }
        await auditUnrouted(tx, "break_glass_event", record.id, unrouted, alert.locationIds);
        const event = searchAuditEvent(plan, page, { breakGlassRecordId: record.id });
        await audit(c, tx, access, {
          action: event.action,
          outcome: event.outcome,
          resourceType: event.resourceType,
          resourceId: record.id,
          scope: event.scope,
        });
        const sameName = new Set(page.warnings.flatMap((w) => w.personIds));
        const byId = new Map(rows.map((r) => [String(r.id), r]));
        return {
          items: page.items.map((hit) => {
            const r = byId.get(hit.id) ?? {};
            return {
              id: hit.id,
              name: `${r.given_name} ${r.family_name}`,
              preferredName: r.preferred_name ? String(r.preferred_name) : null,
              dateOfBirth: r.dob ? String(r.dob) : null,
              nhsNumber: r.nhs_number ? String(r.nhs_number) : null,
              status: hit.personStatus ?? "active",
              sameName: sameName.has(hit.id),
            };
          }),
          // At most the page: never "11 found" when the 11th row only shows there are more.
          total: page.items.length,
          more: page.hasMore,
          breakGlassId: record.id,
        };
      }),
    );
    if (limitReached || out === null) {
      await refuseAtLimit(c, access);
    }
    c.header("Cache-Control", "no-store");
    return c.json(out as NonNullable<typeof out>, 200);
  },
);

/**
 * The daily limit reached: refused, audited, and the data protection lead told, in a transaction
 * of its own so the alert is kept although the search is refused.
 */
async function refuseAtLimit(
  c: Parameters<typeof withTenant>[0],
  access: TenantAccess,
): Promise<never> {
  const now = new Date();
  const alert = breakGlassSearchAlert(null, true);
  await withTenant(c, async (tx) => {
    const lead = await activeLead(tx, access.tenantId);
    if (!lead) {
      await auditUnrouted(tx, "tenant_user", access.tenantUserId, ["no_data_protection_lead"], []);
    } else if (lead !== access.tenantUserId) {
      await tx
        .insert(notification)
        .values({
          recipientTenantUserId: lead,
          kind: "platform.search.break_glass_limit",
          severity: "warning",
          title: alert.title,
          body: alert.body,
          link: "/settings/audit",
          channels: ["in_app", "push"],
          sourceType: "tenant_user",
          sourceId: access.tenantUserId,
          dedupeKey: `break_glass_search_limit:${access.tenantUserId}:${now.toISOString().slice(0, 10)}`,
        })
        // Told once a day: a second refusal the same day is still refused, without a second alert.
        .onConflictDoNothing();
    }
  });
  const event = searchRefusalAuditEvent("rate_limited", ["person"], { breakGlass: true });
  await writeAudit(c.get("services").appPool, access, {
    action: event.action,
    outcome: event.outcome,
    resourceType: event.resourceType,
    scope: event.scope,
    requestId: c.get("requestId"),
  });
  throw new HttpProblem(
    429,
    "rate_limited",
    "You have made the most break-glass searches allowed in 24 hours. The data protection lead has been told.",
  );
}
