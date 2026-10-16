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
  auditEvent,
  breakGlassEvent,
  notification,
  person,
  personCareProfile,
  recordVersion,
  type Transaction,
} from "@harbour/db";
import { scopeFor } from "@harbour/domain";
import { createRoute, z } from "@hono/zod-openapi";
import { and, asc, eq, inArray, isNull, sql } from "drizzle-orm";
import type { Context } from "hono";
import { auditInTx, writeAudit } from "../http/audit";
import {
  type AppEnv,
  inScopeOf,
  permissionsReaching,
  requirePermission,
  type TenantAccess,
  withTenant,
} from "../http/context";
import { problems } from "../http/problem";
import { publish } from "../outbox";
import { BREAK_GLASS_ALERT_UNROUTED_ACTION } from "../services/break-glass-report";
import { resuscitationFor } from "../services/care-planning";
import { contentHeaders, readDocumentContent } from "../services/documents";
import { roleHolders } from "../services/role-holders";
import { staffNames } from "../services/staff";
import { createRouter, errorResponses, jsonBody, notFoundResponse, security } from "./openapi";

const NOT_RECORDED: PersonSummary["resuscitation"] = {
  status: "not_recorded",
  conflicting: false,
  recordId: null,
  kind: null,
  completedOn: null,
  clinicianName: null,
  clinicianRole: null,
  reviewDueOn: null,
  reviewOverdue: false,
};

/** Break-glass access lasts long enough to deal with the situation, then lapses (section 4). */
const BREAK_GLASS_MINUTES = 60;

/**
 * Audits a break-glass attempt that opened nothing, after its transaction has rolled back, in a
 * transaction of its own (ADR-0071 review round 2): a coded reason and the person's opaque id, never
 * the justification's words.
 */
async function auditRefusedBreakGlass(
  c: Context<AppEnv>,
  access: TenantAccess,
  personId: string,
  reason: "person_not_found" | "outside_read_scope",
): Promise<void> {
  try {
    await writeAudit(c.get("services").appPool, access, {
      action: "people.person.break_glass",
      outcome: "denied",
      resourceType: "person",
      resourceId: personId,
      reason,
      requestId: c.get("requestId"),
    });
  } catch {
    // The refusal still answers 404 (review round 3): the failure is logged by opaque ids only,
    // never the justification typed.
    c.get("services").logger.error(
      {
        tenantId: access.tenantId,
        tenantUserId: access.tenantUserId,
        personId,
        reason,
        requestId: c.get("requestId"),
      },
      "refused break-glass attempt could not be audited",
    );
  }
}

const PersonId = z.object({ id: z.uuid() });

function isForeignKeyViolation(error: unknown): boolean {
  const cause = (error as { cause?: { code?: string } }).cause;
  return (error as { code?: string }).code === "23503" || cause?.code === "23503";
}

/**
 * HZ-023: an empty list of communication needs is "not recorded" until someone confirms there are
 * none, never "no needs". A list written without the status (an older app version) is a record of
 * needs; a "recorded" status over an empty list falls back to not recorded.
 */
export function communicationNeedsStatus(p: typeof person.$inferSelect) {
  const needs = Array.isArray(p.communicationNeeds) ? p.communicationNeeds : [];
  let status = p.communicationNeedsStatus as PersonSummary["communicationNeedsStatus"];
  if (needs.length > 0) status = "recorded";
  else if (status === "recorded") status = "not_recorded";
  const confirmed = status === "none_identified";
  return {
    communicationNeedsStatus: status,
    communicationNeedsConfirmedBy: confirmed ? p.communicationNeedsConfirmedBy : null,
    communicationNeedsConfirmedAt:
      confirmed && p.communicationNeedsConfirmedAt
        ? p.communicationNeedsConfirmedAt.toISOString()
        : null,
  };
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
  // The resuscitation decision in force shows in every point-of-care header (hazard HZ-015).
  const resuscitation = await resuscitationFor(tx, ids, new Date());
  // So do the prescribed IDDSI levels, or that nobody has recorded them (hazard HZ-016).
  const profiles =
    ids.length === 0
      ? []
      : await tx
          .select({
            personId: personCareProfile.personId,
            food: personCareProfile.iddsiFoodLevel,
            drink: personCareProfile.iddsiDrinkLevel,
          })
          .from(personCareProfile)
          .where(
            and(inArray(personCareProfile.personId, ids), isNull(personCareProfile.deletedAt)),
          );
  const iddsi = new Map(profiles.map((p) => [p.personId, p]));
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
      roomLabel: p.roomLabel,
      photoUrl: p.photoDocumentId ? `/v1/people/${p.id}/photo` : null,
      allergyStatus: p.allergyStatus,
      allergies: allergies
        .filter((a) => a.personId === p.id)
        .map((a) => ({ substance: a.substance, severity: a.severity, reaction: a.reaction })),
      communicationNeeds: (p.communicationNeeds as CommunicationNeed[]) ?? [],
      ...communicationNeedsStatus(p),
      resuscitation: resuscitation.get(p.id) ?? NOT_RECORDED,
      iddsiFoodLevel: (iddsi.get(p.id)?.food ?? "not_recorded") as PersonSummary["iddsiFoodLevel"],
      iddsiDrinkLevel: (iddsi.get(p.id)?.drink ??
        "not_recorded") as PersonSummary["iddsiDrinkLevel"],
      statusChangedAt: p.statusChangedAt.toISOString(),
      sample: p.isSample,
      version: p.version,
    }),
  );
}

export { summaries as personSummaries };

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
        // What the caller may do here, so every tab offers only what the API would take (ADR-0071
        // review rounds 2 and 3, C2-M2 and C3-M1): a break-glass record opens reading only, so
        // nothing reaches the person without it.
        const reaching = await permissionsReaching(tx, access, id, { withoutBreakGlass: true });
        const recordCare = reaching.has("care.note.write");
        const withoutBreakGlass = {
          ...scopeFor(access.effective, "people.person.read"),
          includesBreakGlass: false,
        };
        const [own] = recordCare
          ? [true]
          : await inScopeOf(tx, withoutBreakGlass, () =>
              tx.select({ id: person.id }).from(person).where(eq(person.id, id)),
            );
        return {
          ...summary,
          access: {
            reaching: [...reaching].sort(),
            recordCare,
            editCarePlan: reaching.has("care.plan.write"),
            readOnlyReason: recordCare ? null : own ? ("scope" as const) : ("break_glass" as const),
          },
        };
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
        const staff = await staffNames(
          tx,
          versions.map((v) => v.changedBy),
        );
        return versions.map((v) => ({
          version: v.recordVersion,
          validFrom: v.validFrom.toISOString(),
          validTo: v.validTo.toISOString(),
          changedBy: v.changedBy,
          changedByStaff: staff(v.changedBy),
          data: v.data as Record<string, unknown>,
        }));
      });
      if (!history) throw problems.notFound();
      return c.json({ table: "person", recordId: id, versions: history }, 200);
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
      responses: {
        200: {
          content: {
            "image/jpeg": { schema: z.string().meta({ format: "binary" }) },
            "image/png": { schema: z.string().meta({ format: "binary" }) },
            "image/webp": { schema: z.string().meta({ format: "binary" }) },
          },
          description: "The photo",
        },
        ...errorResponses,
        ...notFoundResponse,
      },
    }),
    async (c) => {
      await requirePermission(c, "people.person.read");
      const { id } = c.req.valid("param");
      const { storage } = c.get("services");
      // Not audited separately: the photo is part of a person view, which is audited.
      const { row, bytes } = await withTenant(c, async (tx) => {
        const [target] = await tx
          .select({ photoDocumentId: person.photoDocumentId })
          .from(person)
          .where(eq(person.id, id));
        if (!target?.photoDocumentId) throw problems.notFound();
        return readDocumentContent(tx, storage, target.photoDocumentId);
      });
      return c.body(bytes as Uint8Array<ArrayBuffer>, 200, contentHeaders(row));
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
      const { personId, justification, reasonCode } = c.req.valid("json");
      const expiresAt = new Date(Date.now() + BREAK_GLASS_MINUTES * 60_000);
      // Why an attempt opened nothing; the transaction rolls back, and the refusal is audited after
      // it, in a transaction of its own, so it leaves a record (ADR-0071 review round 2).
      let refused: "person_not_found" | "outside_read_scope" | null = null;
      const result = await withTenant(c, async (tx) => {
        const opened = await tx
          .insert(breakGlassEvent)
          .values({
            tenantUserId: access.tenantUserId,
            personId,
            justification,
            expiresAt,
            reasonCode: reasonCode ?? null,
          })
          .returning({ id: breakGlassEvent.id })
          .then((rows) => rows[0])
          .catch((error: unknown) => {
            // The person does not exist in this tenant (composite foreign key).
            if (isForeignKeyViolation(error)) return undefined;
            throw error;
          });
        // The failed insert aborted the transaction; nothing more may run in it.
        if (!opened) {
          refused = "person_not_found";
          return null;
        }
        // The record as the break-glass opens it: under the scope of people.person.read, which
        // counts break-glass people (ADR-0071 review round 1, S-M1). A person it does not open
        // rolls the event back (thrown, not returned), so no break-glass record is ever kept
        // without its audit and its alert (L6).
        const [target] = await inScopeOf(tx, scopeFor(access.effective, "people.person.read"), () =>
          tx.select({ locationId: person.locationId }).from(person).where(eq(person.id, personId)),
        );
        if (!target) {
          refused = "outside_read_scope";
          throw problems.notFound();
        }

        // The Registered Managers whose role reaches the person's home and the quality leads, each
        // with a role in force and on the staff (ADR-0071 review round 2), other than the person
        // who opened it: being told of one's own break-glass is not an alert (review round 5).
        const now = new Date();
        const reached = new Set([
          ...(await roleHolders(tx, ["registered_manager"], [target.locationId], now)),
          ...(await roleHolders(tx, ["quality_lead"], null, now)),
        ]);
        const recipients = [...reached].filter((id) => id !== access.tenantUserId);
        if (recipients.length === 0) {
          // No one else is an active Registered Manager reaching the home or quality lead: the
          // record still opens, and the gap is audited as the system (review rounds 4 and 5),
          // coded `opener_only` when the opener alone holds those roles.
          const reasonCode = reached.size > 0 ? "opener_only" : "no_recipient";
          await tx.insert(auditEvent).values({
            tenantId: sql`app.current_tenant_id()`,
            action: BREAK_GLASS_ALERT_UNROUTED_ACTION,
            outcome: "error",
            resourceType: "break_glass_event",
            resourceId: opened.id,
            reason: reasonCode,
            scope: { personId, locationId: target.locationId, reasonCode },
          });
        }
        for (const recipient of recipients) {
          await tx.insert(notification).values({
            recipientTenantUserId: recipient,
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
      }).catch(async (error: unknown) => {
        if (refused) await auditRefusedBreakGlass(c, access, personId, refused);
        throw error;
      });
      if (!result) {
        if (refused) await auditRefusedBreakGlass(c, access, personId, refused);
        throw problems.notFound();
      }
      return c.json(result, 201);
    },
  );
