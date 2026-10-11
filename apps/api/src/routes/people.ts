import {
  BreakGlassRequest,
  BreakGlassResult,
  type CommunicationNeed,
  PersonList,
  PersonSummary,
  RecordHistory,
} from "@harbour/contracts";
import {
  allergy,
  breakGlassEvent,
  notification,
  person,
  recordVersion,
  role,
  roleAssignment,
  type Transaction,
} from "@harbour/db";
import { createRoute, z } from "@hono/zod-openapi";
import { and, asc, eq, inArray, isNull, or } from "drizzle-orm";
import { auditInTx } from "../http/audit";
import { requirePermission, withTenant } from "../http/context";
import { problems } from "../http/problem";
import { publish } from "../outbox";
import { createRouter, errorResponses, jsonBody, notFoundResponse, security } from "./openapi";

/** Break-glass access lasts long enough to deal with the situation, then lapses (section 4). */
const BREAK_GLASS_MINUTES = 60;

const PersonId = z.object({ id: z.uuid() });

function isForeignKeyViolation(error: unknown): boolean {
  const cause = (error as { cause?: { code?: string } }).cause;
  return (error as { code?: string }).code === "23503" || cause?.code === "23503";
}

async function summaries(tx: Transaction, personIds?: readonly string[]) {
  const people = await tx
    .select()
    .from(person)
    .where(
      and(isNull(person.deletedAt), personIds ? inArray(person.id, [...personIds]) : undefined),
    )
    .orderBy(asc(person.familyName), asc(person.givenName));
  const ids = people.map((p) => p.id);
  const allergies =
    ids.length === 0
      ? []
      : await tx
          .select()
          .from(allergy)
          .where(
            and(
              inArray(allergy.personId, ids),
              isNull(allergy.deletedAt),
              eq(allergy.status, "active"),
            ),
          );
  return people.map(
    (p): PersonSummary => ({
      id: p.id,
      locationId: p.locationId,
      status: p.status,
      givenName: p.givenName,
      familyName: p.familyName,
      preferredName: p.preferredName,
      dateOfBirth: p.dateOfBirth,
      nhsNumber: p.nhsNumber,
      photoUrl: p.photoDocumentId ? `/v1/people/${p.id}/photo` : null,
      allergyStatus: p.allergyStatus,
      allergies: allergies
        .filter((a) => a.personId === p.id)
        .map((a) => ({ substance: a.substance, severity: a.severity, reaction: a.reaction })),
      communicationNeeds: (p.communicationNeeds as CommunicationNeed[]) ?? [],
      version: p.version,
    }),
  );
}

export const peopleRouter = createRouter()
  .openapi(
    createRoute({
      method: "get",
      path: "/v1/people",
      tags: ["people"],
      summary: "People in your scope, with the point-of-care header details",
      security,
      request: { query: z.object({ locationId: z.uuid().optional() }) },
      responses: { 200: jsonBody(PersonList, "People"), ...errorResponses },
    }),
    async (c) => {
      const access = await requirePermission(c, "people.person.read");
      const { locationId } = c.req.valid("query");
      const items = await withTenant(c, async (tx) => {
        const all = await summaries(tx);
        const filtered = locationId ? all.filter((p) => p.locationId === locationId) : all;
        await auditInTx(tx, access, {
          action: "people.person.list",
          resourceType: "person",
          scope: { count: filtered.length, locationId: locationId ?? null },
          requestId: c.get("requestId"),
        });
        return filtered;
      });
      return c.json({ items, nextCursor: null }, 200);
    },
  )
  .openapi(
    createRoute({
      method: "get",
      path: "/v1/people/{id}",
      tags: ["people"],
      summary: "One person's point-of-care summary",
      security,
      request: { params: PersonId },
      responses: { 200: jsonBody(PersonSummary, "Person"), ...errorResponses, ...notFoundResponse },
    }),
    async (c) => {
      const access = await requirePermission(c, "people.person.read");
      const { id } = c.req.valid("param");
      const found = await withTenant(c, async (tx) => {
        const [summary] = await summaries(tx, [id]);
        // A person outside scope is indistinguishable from one that does not exist.
        if (!summary) return null;
        await auditInTx(tx, access, {
          action: "people.person.view",
          resourceType: "person",
          resourceId: id,
          requestId: c.get("requestId"),
        });
        return summary;
      });
      if (!found) throw problems.notFound();
      return c.json(found, 200);
    },
  )
  .openapi(
    createRoute({
      method: "get",
      path: "/v1/people/{id}/history",
      tags: ["people"],
      summary: "Every earlier version of a person's record, for inspectors and audit",
      security,
      request: { params: PersonId },
      responses: {
        200: jsonBody(RecordHistory, "History"),
        ...errorResponses,
        ...notFoundResponse,
      },
    }),
    async (c) => {
      const access = await requirePermission(c, "people.person.read");
      const { id } = c.req.valid("param");
      const history = await withTenant(c, async (tx) => {
        const [visible] = await tx.select({ id: person.id }).from(person).where(eq(person.id, id));
        if (!visible) return null;
        const versions = await tx
          .select()
          .from(recordVersion)
          .where(and(eq(recordVersion.tableName, "person"), eq(recordVersion.recordId, id)))
          .orderBy(asc(recordVersion.recordVersion));
        await auditInTx(tx, access, {
          action: "people.person.history_view",
          resourceType: "person",
          resourceId: id,
          requestId: c.get("requestId"),
        });
        return versions;
      });
      if (!history) throw problems.notFound();
      return c.json(
        {
          table: "person",
          recordId: id,
          versions: history.map((v) => ({
            version: v.recordVersion,
            validFrom: v.validFrom.toISOString(),
            validTo: v.validTo.toISOString(),
            changedBy: v.changedBy,
            data: v.data as Record<string, unknown>,
          })),
        },
        200,
      );
    },
  )
  .openapi(
    createRoute({
      method: "get",
      path: "/v1/people/{id}/photo",
      tags: ["people"],
      summary: "The person's photo (shown on every point-of-care screen)",
      security,
      request: { params: PersonId },
      responses: { ...errorResponses, ...notFoundResponse },
    }),
    async (c) => {
      await requirePermission(c, "people.person.read");
      // The document store and S3 delivery arrive with the admission workflow in Phase 1.
      throw problems.notFound();
    },
  )
  .openapi(
    createRoute({
      method: "post",
      path: "/v1/people/break-glass",
      tags: ["people"],
      summary: "Open a record outside your scope with a written reason",
      description:
        "Alerts the Registered Manager and the quality lead, is audited with the reason, needs a fresh sign-in, and lapses after an hour.",
      security,
      request: { body: { content: { "application/json": { schema: BreakGlassRequest } } } },
      responses: {
        201: jsonBody(BreakGlassResult, "Opened"),
        ...errorResponses,
        ...notFoundResponse,
      },
    }),
    async (c) => {
      const access = await requirePermission(c, "people.person.break_glass");
      const { personId, justification } = c.req.valid("json");
      const expiresAt = new Date(Date.now() + BREAK_GLASS_MINUTES * 60_000);
      const result = await withTenant(c, async (tx) => {
        const opened = await tx
          .insert(breakGlassEvent)
          .values({ tenantUserId: access.tenantUserId, personId, justification, expiresAt })
          .returning({ id: breakGlassEvent.id })
          .then((rows) => rows[0])
          .catch((error: unknown) => {
            // The person does not exist in this tenant (composite foreign key).
            if (isForeignKeyViolation(error)) return undefined;
            throw error;
          });
        // The failed insert aborted the transaction; nothing more may run in it.
        if (!opened) return null;
        const [target] = await tx
          .select({ locationId: person.locationId })
          .from(person)
          .where(eq(person.id, personId));
        if (!target) return null;

        const recipients = await tx
          .selectDistinct({ tenantUserId: roleAssignment.tenantUserId })
          .from(roleAssignment)
          .innerJoin(role, eq(role.id, roleAssignment.roleId))
          .where(
            and(
              isNull(roleAssignment.deletedAt),
              or(
                and(
                  eq(role.key, "registered_manager"),
                  or(
                    isNull(roleAssignment.locationId),
                    eq(roleAssignment.locationId, target.locationId),
                  ),
                ),
                eq(role.key, "quality_lead"),
              ),
            ),
          );
        for (const r of recipients) {
          await tx.insert(notification).values({
            recipientTenantUserId: r.tenantUserId,
            kind: "people.break_glass_opened",
            severity: "warning",
            title: "A record was opened with break-glass access",
            body: "Review the reason given in the audit log.",
            link: `/people/${personId}`,
            channels: ["in_app", "push"],
            sourceType: "break_glass_event",
            sourceId: opened.id,
            dedupeKey: `break_glass:${opened.id}`,
          });
        }
        await auditInTx(tx, access, {
          action: "people.person.break_glass",
          resourceType: "person",
          resourceId: personId,
          reason: justification,
          requestId: c.get("requestId"),
        });
        await publish(tx, {
          context: "people",
          aggregateType: "person",
          aggregateId: personId,
          type: "people.break_glass_opened",
          payload: { breakGlassId: opened.id, tenantUserId: access.tenantUserId },
        });
        return { id: opened.id, expiresAt: expiresAt.toISOString() };
      });
      if (!result) throw problems.notFound();
      return c.json(result, 201);
    },
  );
