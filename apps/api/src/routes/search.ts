import { RunSearch, SearchResults } from "@harbour/contracts";
import { tenantUser } from "@harbour/db";
import {
  buildSearchPlan,
  filterSearchResults,
  type SearchEntityType,
  type SearchPlanProblem,
  searchAuditEvent,
  searchRefusalAuditEvent,
} from "@harbour/domain";
import { createRoute } from "@hono/zod-openapi";
import { eq, sql } from "drizzle-orm";
import { AuditedRefusal, withAuditedRefusal } from "../http/audit";
import { requirePermission, type TenantAccess, withTenant } from "../http/context";
import { HttpProblem, problems } from "../http/problem";
import { RateLimiter, requireWithinLimit } from "../http/rate-limit";
import { accessRowsOf } from "../services/access-rows";
import { rateNumber } from "../services/rates";
import { READ_LIMIT, searchRows } from "../services/search";
import { createRouter, errorResponses, jsonBody, security } from "./openapi";
import { audit } from "./people-shared";

/**
 * Permission-aware search (PLAT-013; platform-completions.md rules 1 to 8; ADR-0070, ADR-0071;
 * hazards HZ-001 and HZ-011). `platform.search.use`, then each kind of record on the permission
 * that already lets the user read it, in that permission's own scope, under forced row-level
 * security; the plan is applied again to every row, results are ranked people first, and only
 * what the user may see is counted. The words typed come in the body, so no access log holds
 * them, and the audit event holds the opaque ids shown, never the words. Break-glass search is a
 * separate route (a later step).
 */

const QUERY_PROBLEMS = new Set<SearchPlanProblem>([
  "empty",
  "too_long",
  "too_short",
  "invalid_nhs_number",
]);

function problemFor(problem: SearchPlanProblem, message: string, access: TenantAccess) {
  if (QUERY_PROBLEMS.has(problem)) return problems.invalid(message);
  if (problem === "mfa_required") {
    return new HttpProblem(
      403,
      access.mfaEnrolled ? "mfa_verification_required" : "mfa_enrolment_required",
      message,
    );
  }
  return new HttpProblem(403, problem, message);
}

/** When the member's search access ends: the latest end of the roles that give search. */
async function roleEndsAt(
  tx: Parameters<typeof accessRowsOf>[0],
  access: TenantAccess,
  now: Date,
): Promise<Date | null> {
  const rows = (await accessRowsOf(tx, [access.tenantUserId])).get(access.tenantUserId);
  const giving = (rows?.assignments ?? []).filter(
    (a) =>
      a.permissions.includes("platform.search.use") &&
      a.validFrom.getTime() <= now.getTime() &&
      (a.validTo === null || a.validTo.getTime() > now.getTime()),
  );
  if (giving.length === 0 || giving.some((a) => a.validTo === null)) return null;
  return new Date(Math.max(...giving.map((a) => (a.validTo as Date).getTime())));
}

/** Whole years between a date of birth and today in the UK. */
function ageOn(dateOfBirth: string, now: Date): number {
  const today = now.toLocaleDateString("en-CA", { timeZone: "Europe/London" });
  const [y, m, d] = today.split("-").map(Number) as [number, number, number];
  const [by, bm, bd] = dateOfBirth.split("-").map(Number) as [number, number, number];
  return y - by - (m < bm || (m === bm && d < bd) ? 1 : 0);
}

export const searchRouter = createRouter().openapi(
  createRoute({
    method: "post",
    path: "/v1/search",
    tags: ["platform"],
    summary: "Search what you can already see",
    description:
      "People, colleagues, documents and notes, each on the permission that lets you read it and in that permission's scope (ADR-0071). The words are sent in the body and never stored; the audit event holds the opaque ids shown. People who have left need platform.search.archived. Out-of-scope matches look exactly like no match.",
    security,
    request: { body: { content: { "application/json": { schema: RunSearch } } } },
    responses: { 200: jsonBody(SearchResults, "Results"), ...errorResponses },
  }),
  async (c) => {
    const access = await requirePermission(c, "platform.search.use");
    const body = c.req.valid("json");
    const now = new Date();
    // A per-member limit from the rate table (`search.requests_per_minute`), so search cannot be
    // used to sweep the records a name at a time; never a literal.
    const perMinute = await withTenant(c, (tx) =>
      rateNumber(tx, access.tenantId, "search.requests_per_minute"),
    );
    await requireWithinLimit(
      c.get("services").db,
      access,
      new RateLimiter("search", perMinute, 60_000),
    );
    const asked: readonly SearchEntityType[] = body.types?.length
      ? body.types
      : ["person", "staff", "document", "note"];
    const out = await withAuditedRefusal(c, access, () =>
      withTenant(c, async (tx) => {
        // A technical bound on the whole search, so a slow query cannot hold a connection.
        await tx.execute(sql`SET LOCAL statement_timeout = '5s'`);
        const [me] = await tx
          .select({ isAgency: tenantUser.isAgency })
          .from(tenantUser)
          .where(eq(tenantUser.id, access.tenantUserId));
        // A member whose row cannot be read is refused, never treated as not an agency worker.
        if (!me) {
          const event = searchRefusalAuditEvent("not_permitted", asked);
          throw new AuditedRefusal(problems.forbidden(), {
            action: event.action,
            outcome: event.outcome,
            resourceType: event.resourceType,
            scope: event.scope,
          });
        }
        const checked = buildSearchPlan(
          { rawQuery: body.query, entityTypes: asked, includeArchived: body.includeArchived },
          {
            access: access.effective,
            // Care records need MFA on this session, not only a factor enrolled (ADR-0072).
            mfaEnrolled: access.mfaSatisfied,
            window: {
              roleEndsAt: await roleEndsAt(tx, access, now),
              isAgencyWorker: me.isAgency,
              // Rotas arrive in Phase 2: no shift is recorded, so agency search fails closed.
              agencyShiftEndsAt: null,
            },
            teamIds: null,
          },
          now,
          {
            agencyPostShiftHours: await rateNumber(
              tx,
              access.tenantId,
              "access.agency.post_shift_hours",
            ),
          },
        );
        if (!checked.ok) {
          const event = searchRefusalAuditEvent(checked.problem, asked);
          throw new AuditedRefusal(problemFor(checked.problem, checked.message, access), {
            action: event.action,
            outcome: event.outcome,
            resourceType: event.resourceType,
            scope: event.scope,
          });
        }
        const plan = checked.plan;
        const { hits, details, capped } = await searchRows(tx, {
          tenantId: access.tenantId,
          actor: access.tenantUserId,
          access: access.effective,
          plan,
        });
        const page = filterSearchResults(plan, hits, now);
        if (page.droppedByPlan > 0) {
          // The database returned rows the plan does not allow: the queries and the plan disagree.
          // An alarm with opaque counts only (HZ-011), in the log and the audit trail.
          c.get("services").logger.error(
            {
              event: "security.search.dropped_by_plan",
              tenantId: access.tenantId,
              dropped: page.droppedByPlan,
            },
            "security.search.dropped_by_plan",
          );
          await audit(c, tx, access, {
            action: "platform.search.dropped_by_plan",
            outcome: "error",
            resourceType: "search",
            scope: { dropped: page.droppedByPlan, read: hits.length },
          });
        }
        const event = searchAuditEvent(plan, page);
        await audit(c, tx, access, {
          action: event.action,
          outcome: event.outcome,
          resourceType: event.resourceType,
          scope: event.scope,
        });
        const sameName = new Set(page.warnings.flatMap((w) => w.personIds));
        const personFields =
          plan.entities.find((e) => e.type === "person")?.fields ?? ([] as readonly string[]);
        const full = personFields.includes("date_of_birth");
        return {
          items: page.items.map((hit) => {
            const detail = details.get(hit.id) ?? {};
            const person = hit.entityType === "person" ? detail.person : undefined;
            return {
              type: hit.entityType,
              id: hit.id,
              match: hit.matchQuality,
              sameName: hit.entityType === "person" && sameName.has(hit.id),
              person: person
                ? {
                    id: hit.id,
                    name: person.name,
                    preferredName: person.preferredName,
                    dateOfBirth: full ? person.dateOfBirth : null,
                    age: !full && person.dateOfBirth ? ageOn(person.dateOfBirth, now) : null,
                    nhsNumber: full ? person.nhsNumber : null,
                    status: hit.personStatus ?? "active",
                    locationName: person.locationName,
                    roomLabel: person.roomLabel,
                    hasPhoto: person.hasPhoto,
                    communicationNeeds: person.communicationNeeds,
                    sample: person.sample,
                  }
                : null,
              staff: hit.entityType === "staff" ? (detail.staff ?? null) : null,
              document:
                hit.entityType === "document" && detail.document
                  ? { ...detail.document, personId: hit.personId }
                  : null,
              note:
                hit.entityType === "note" && detail.note && hit.personId
                  ? { ...detail.note, personId: hit.personId }
                  : null,
            };
          }),
          counts: page.counts,
          total: page.total,
          hasMore: page.hasMore || capped,
          capped,
          readLimit: READ_LIMIT,
          omitted: [...plan.omitted],
          personScope: plan.personScope?.kind ?? null,
          staffScope: plan.staffScope?.kind ?? null,
          includeArchived: plan.includeArchived,
          queryKind: plan.query.kind,
          ignoredTerms: plan.query.kind === "text" ? plan.query.ignoredTerms : 0,
        };
      }),
    );
    // Results name people: never cached anywhere.
    c.header("Cache-Control", "no-store");
    return c.json(out, 200);
  },
);
