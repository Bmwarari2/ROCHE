import {
  ClientIdHeaders,
  CreateDiscardReason,
  CreateEscalationPolicyLink,
  DiscardReasonCode,
  DiscardReasonItem,
  DiscardReasonList,
  EscalationPolicyLinkItem,
  EscalationPolicyLinkList,
  RemoveEscalationPolicyLink,
  UpdateDiscardReason,
  UpdateEscalationPolicyLink,
} from "@harbour/contracts";
import {
  discardReason,
  document,
  escalationPolicyLink,
  location,
  type Transaction,
} from "@harbour/db";
import {
  checkDiscardReason,
  checkEscalationPolicyLink,
  ESCALATION_POLICY_BANDS,
  placesCover,
} from "@harbour/domain";
import { createRoute, z } from "@hono/zod-openapi";
import { and, asc, eq, isNull } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import { auditInTx } from "../http/audit";
import { requirePermission, type TenantAccess, withTenant } from "../http/context";
import { HttpProblem, problems } from "../http/problem";
import { permissionPlaces } from "../services/permission-places";
import { lockClientId, requireSameDetails, withClientId } from "./care-shared";
import {
  conflictResponse,
  createRouter,
  errorResponses,
  jsonBody,
  notFoundResponse,
  security,
} from "./openapi";

/**
 * Care settings the organisation configures (care.md section 5, escalation policies, and section
 * 6, Device integrity part 8): the escalation policy each validated tool's result links, and the
 * coded reasons for deleting unsent entries on a device. Configuration, not personal data; every
 * change is audited by id and kept as a version.
 */

type LinkRow = typeof escalationPolicyLink.$inferSelect;
type ReasonRow = typeof discardReason.$inferSelect;

const LinkParams = z.object({ linkId: z.uuid() });
const ReasonParams = z.object({ code: DiscardReasonCode });

/** Who changes the escalation policy links: holders of the policy permission. */
const POLICY_PERMISSION = "quality.policy.manage" as const;
/** Who changes the coded discard reasons: the organisation's settings. */
const SETTINGS_PERMISSION = "platform.tenant.manage" as const;

function linkItem(row: LinkRow): EscalationPolicyLinkItem {
  return {
    id: row.id,
    toolKey: row.toolKey as EscalationPolicyLinkItem["toolKey"],
    band: row.band,
    locationId: row.locationId,
    title: row.title,
    reference: row.reference,
    documentId: row.documentId,
    updatedAt: row.updatedAt.toISOString(),
    version: row.version,
  };
}

function reasonItem(row: ReasonRow): DiscardReasonItem {
  return {
    code: row.code,
    label: row.label,
    labelCy: row.labelCy,
    sortOrder: row.sortOrder,
    seeded: row.seeded,
    retiredAt: row.retiredAt ? row.retiredAt.toISOString() : null,
    version: row.version,
  };
}

/**
 * A link for the whole organisation needs quality.policy.manage across the organisation; one for
 * a location needs it there. Read from the roles and grants that carry the permission, never the
 * request's merged scope, which a second role elsewhere widens (#26 review round 2, S1).
 * Row-level security checks it again (`app.holds_permission_at`, migration 0046).
 */
async function requireLinkPlace(
  tx: Transaction,
  access: TenantAccess,
  locationId: string | null,
): Promise<void> {
  const places = await permissionPlaces(tx, access.tenantUserId, POLICY_PERMISSION, new Date());
  if (placesCover(places, locationId)) return;
  throw new HttpProblem(
    403,
    "missing_permission",
    "You can change escalation policies only where you manage policies.",
    locationId === null
      ? "A policy for the whole organisation needs a role that manages policies across the organisation."
      : undefined,
  );
}

/**
 * The organisation's coded reasons are its settings: only a member who holds
 * platform.tenant.manage across the organisation changes them (#26 review round 2, S1).
 */
async function requireOrganisationSettings(tx: Transaction, access: TenantAccess): Promise<void> {
  const places = await permissionPlaces(tx, access.tenantUserId, SETTINGS_PERMISSION, new Date());
  if (!placesCover(places, null)) throw problems.forbidden();
}

/**
 * The policy document must be one of the organisation's current documents: an organisation
 * document (never a person's), available (not quarantined or destroyed) and its latest version
 * (#26 review round 2, low).
 */
async function requirePolicyDocument(tx: Transaction, documentId: string | null | undefined) {
  if (!documentId) return;
  const newer = alias(document, "newer_version");
  const [found] = await tx
    .select({
      personId: document.personId,
      category: document.category,
      status: document.status,
      destroyedAt: document.destroyedAt,
      newerId: newer.id,
    })
    .from(document)
    .leftJoin(newer, and(eq(newer.previousVersionId, document.id), isNull(newer.deletedAt)))
    .where(and(eq(document.id, documentId), isNull(document.deletedAt)));
  if (
    !found ||
    found.personId !== null ||
    found.category !== "organisation_document" ||
    found.status !== "available" ||
    found.destroyedAt !== null
  ) {
    throw problems.invalid(
      "The policy document was not found among your organisation's current policy documents.",
    );
  }
  if (found.newerId !== null) {
    throw problems.invalid(
      "A newer version of this policy document has been uploaded. Link the newer version.",
    );
  }
}

async function requireLocation(tx: Transaction, locationId: string | null) {
  if (!locationId) return;
  const [found] = await tx
    .select({ id: location.id })
    .from(location)
    .where(and(eq(location.id, locationId), isNull(location.deletedAt)));
  if (!found) throw problems.invalid("The location was not found.");
}

const isUniqueViolation = (error: unknown) =>
  ((error as { code?: string }).code ?? (error as { cause?: { code?: string } }).cause?.code) ===
  "23505";

export const careSettingsRouter = createRouter()
  .openapi(
    createRoute({
      method: "get",
      path: "/v1/escalation-policies",
      tags: ["care"],
      summary: "The escalation policy each validated tool's result links",
      description:
        "The organisation's live links, for one band or every band of a tool, for one location or the whole organisation, with the bands each tool's results carry. Results show the most specific link for their tool, band and location, or that none is configured; Harbour adds no recommendation (medical-device boundary section 5 rule 4).",
      security,
      responses: {
        200: jsonBody(EscalationPolicyLinkList, "Links"),
        ...errorResponses,
      },
    }),
    async (c) => {
      await requirePermission(c, "care.plan.read");
      const rows = await withTenant(c, (tx) =>
        tx
          .select()
          .from(escalationPolicyLink)
          .where(isNull(escalationPolicyLink.deletedAt))
          .orderBy(asc(escalationPolicyLink.toolKey), asc(escalationPolicyLink.createdAt)),
      );
      return c.json(
        {
          items: rows.map(linkItem),
          bands: Object.fromEntries(
            Object.entries(ESCALATION_POLICY_BANDS).map(([tool, bands]) => [tool, [...bands]]),
          ),
        },
        200,
      );
    },
  )
  .openapi(
    createRoute({
      method: "post",
      path: "/v1/escalation-policies",
      tags: ["care"],
      summary: "Link the organisation's escalation policy to a validated tool",
      description:
        "For one band or every band, at one location or across the organisation (organisation-wide access for the latter). One live link per tool, band and place: 409 when one exists, so change that one. A replay with the same client id returns the link it made.",
      security,
      request: {
        headers: ClientIdHeaders,
        body: { content: { "application/json": { schema: CreateEscalationPolicyLink } } },
      },
      responses: {
        201: jsonBody(EscalationPolicyLinkItem, "Linked"),
        ...errorResponses,
        ...conflictResponse,
      },
    }),
    async (c) => {
      const access = await requirePermission(c, POLICY_PERMISSION);
      const body = withClientId(c, c.req.valid("json"));
      const check = checkEscalationPolicyLink({
        toolKey: body.toolKey,
        band: body.band,
        title: body.title,
        reference: body.reference ?? null,
      });
      if (!check.ok) throw problems.invalid(check.message);
      const item = await withTenant(c, async (tx) => {
        await requireLinkPlace(tx, access, body.locationId);
        if (body.id) {
          await lockClientId(tx, "escalation_policy_link", body.id);
          const [replayed] = await tx
            .select()
            .from(escalationPolicyLink)
            .where(eq(escalationPolicyLink.id, body.id));
          if (replayed) {
            // A link removed since is never returned as live, and a link sent again with other
            // details is refused (#26 review round 2, C5).
            if (replayed.deletedAt !== null) {
              throw problems.conflict(
                "This policy link has been removed since it was saved: reload before linking a policy again.",
              );
            }
            requireSameDetails(replayed, {
              toolKey: body.toolKey,
              band: body.band,
              locationId: body.locationId,
              title: body.title,
              reference: body.reference ?? null,
              documentId: body.documentId ?? null,
            });
            return linkItem(replayed);
          }
        }
        await requireLocation(tx, body.locationId);
        await requirePolicyDocument(tx, body.documentId);
        const [row] = await tx
          .insert(escalationPolicyLink)
          .values({
            ...(body.id ? { id: body.id } : {}),
            toolKey: body.toolKey,
            band: body.band,
            locationId: body.locationId,
            title: body.title.trim(),
            reference: body.reference?.trim() || null,
            documentId: body.documentId ?? null,
          })
          .returning()
          .catch((error: unknown) => {
            if (isUniqueViolation(error)) {
              throw problems.conflict(
                "A policy is already linked for this tool, band and place: change that one.",
              );
            }
            throw error;
          });
        if (!row) throw problems.conflict();
        await auditInTx(tx, access, {
          action: "care.escalation_policy.link",
          resourceType: "escalation_policy_link",
          resourceId: row.id,
          scope: { toolKey: row.toolKey, band: row.band, locationId: row.locationId },
          requestId: c.get("requestId"),
        });
        return linkItem(row);
      });
      return c.json(item, 201);
    },
  )
  .openapi(
    createRoute({
      method: "put",
      path: "/v1/escalation-policies/{linkId}",
      tags: ["care"],
      summary: "Change a linked policy's name, reference or document",
      security,
      request: {
        params: LinkParams,
        body: { content: { "application/json": { schema: UpdateEscalationPolicyLink } } },
      },
      responses: {
        200: jsonBody(EscalationPolicyLinkItem, "Changed"),
        ...errorResponses,
        ...notFoundResponse,
        ...conflictResponse,
      },
    }),
    async (c) => {
      const access = await requirePermission(c, POLICY_PERMISSION);
      const { linkId } = c.req.valid("param");
      const body = c.req.valid("json");
      const item = await withTenant(c, async (tx) => {
        const [current] = await tx
          .select()
          .from(escalationPolicyLink)
          .where(and(eq(escalationPolicyLink.id, linkId), isNull(escalationPolicyLink.deletedAt)));
        if (!current) throw problems.notFound();
        await requireLinkPlace(tx, access, current.locationId);
        const check = checkEscalationPolicyLink({
          toolKey: current.toolKey,
          band: current.band,
          title: body.title,
          reference: body.reference ?? null,
        });
        if (!check.ok) throw problems.invalid(check.message);
        if (current.version !== body.version) throw problems.conflict();
        await requirePolicyDocument(tx, body.documentId);
        const [row] = await tx
          .update(escalationPolicyLink)
          .set({
            title: body.title.trim(),
            ...(body.reference !== undefined ? { reference: body.reference?.trim() || null } : {}),
            ...(body.documentId !== undefined ? { documentId: body.documentId } : {}),
          })
          .where(
            and(
              eq(escalationPolicyLink.id, linkId),
              eq(escalationPolicyLink.version, body.version),
            ),
          )
          .returning();
        if (!row) throw problems.conflict();
        await auditInTx(tx, access, {
          action: "care.escalation_policy.update",
          resourceType: "escalation_policy_link",
          resourceId: row.id,
          requestId: c.get("requestId"),
        });
        return linkItem(row);
      });
      return c.json(item, 200);
    },
  )
  .openapi(
    createRoute({
      method: "post",
      path: "/v1/escalation-policies/{linkId}/remove",
      tags: ["care"],
      summary: "Remove a link: results for that tool and band then say no policy is configured",
      description:
        "Unless a broader link covers them (every band, or the organisation's). The link is kept in its history.",
      security,
      request: {
        params: LinkParams,
        body: { content: { "application/json": { schema: RemoveEscalationPolicyLink } } },
      },
      responses: {
        200: jsonBody(EscalationPolicyLinkItem, "Removed"),
        ...errorResponses,
        ...notFoundResponse,
        ...conflictResponse,
      },
    }),
    async (c) => {
      const access = await requirePermission(c, POLICY_PERMISSION);
      const { linkId } = c.req.valid("param");
      const body = c.req.valid("json");
      const item = await withTenant(c, async (tx) => {
        const [current] = await tx
          .select()
          .from(escalationPolicyLink)
          .where(and(eq(escalationPolicyLink.id, linkId), isNull(escalationPolicyLink.deletedAt)));
        if (!current) throw problems.notFound();
        await requireLinkPlace(tx, access, current.locationId);
        const [row] = await tx
          .update(escalationPolicyLink)
          .set({ deletedAt: new Date() })
          .where(
            and(
              eq(escalationPolicyLink.id, linkId),
              eq(escalationPolicyLink.version, body.version),
            ),
          )
          .returning();
        if (!row) throw problems.conflict();
        await auditInTx(tx, access, {
          action: "care.escalation_policy.remove",
          resourceType: "escalation_policy_link",
          resourceId: row.id,
          scope: { toolKey: row.toolKey, band: row.band, locationId: row.locationId },
          requestId: c.get("requestId"),
        });
        return linkItem(row);
      });
      return c.json(item, 200);
    },
  )
  .openapi(
    createRoute({
      method: "get",
      path: "/v1/discard-reasons",
      tags: ["care"],
      summary: "The organisation's coded reasons for deleting unsent entries on a device",
      description:
        "Live reasons first in their order, then retired ones. Only the code ever leaves a device; a retired code is no longer offered and is still accepted from a device that recorded it before.",
      security,
      responses: { 200: jsonBody(DiscardReasonList, "Reasons"), ...errorResponses },
    }),
    async (c) => {
      // Whoever may record a deletion reads them (the permission POST /v1/sync/discards needs):
      // a device offers them before anything is deleted (#26 review round 2, low).
      await requirePermission(c, "care.note.write");
      const rows = await withTenant(c, (tx) =>
        tx
          .select()
          .from(discardReason)
          .orderBy(asc(discardReason.sortOrder), asc(discardReason.code)),
      );
      const items = rows.map(reasonItem);
      return c.json(
        {
          items: [
            ...items.filter((r) => r.retiredAt === null),
            ...items.filter((r) => r.retiredAt !== null),
          ],
        },
        200,
      );
    },
  )
  .openapi(
    createRoute({
      method: "post",
      path: "/v1/discard-reasons",
      tags: ["care"],
      summary: "Add a coded reason for deleting unsent entries",
      description: "Organisation-wide access only. A code is never reused or deleted.",
      security,
      request: {
        body: { content: { "application/json": { schema: CreateDiscardReason } } },
      },
      responses: {
        201: jsonBody(DiscardReasonItem, "Added"),
        ...errorResponses,
        ...conflictResponse,
      },
    }),
    async (c) => {
      const access = await requirePermission(c, SETTINGS_PERMISSION);
      const body = c.req.valid("json");
      const item = await withTenant(c, async (tx) => {
        await requireOrganisationSettings(tx, access);
        const existing = await tx
          .select({ code: discardReason.code, retiredAt: discardReason.retiredAt })
          .from(discardReason);
        const check = checkDiscardReason({ code: body.code, label: body.label }, existing);
        if (!check.ok) {
          if (check.field === "code" && existing.some((r) => r.code === body.code)) {
            throw problems.conflict(check.message);
          }
          throw problems.invalid(check.message);
        }
        const [row] = await tx
          .insert(discardReason)
          .values({
            code: body.code,
            label: body.label.trim(),
            labelCy: body.labelCy?.trim() || null,
            sortOrder: body.sortOrder,
          })
          .returning()
          .catch((error: unknown) => {
            if (isUniqueViolation(error))
              throw problems.conflict("That code is already in your list.");
            throw error;
          });
        if (!row) throw problems.conflict();
        await auditInTx(tx, access, {
          action: "care.discard_reason.create",
          resourceType: "discard_reason",
          resourceId: row.id,
          scope: { code: row.code },
          requestId: c.get("requestId"),
        });
        return reasonItem(row);
      });
      return c.json(item, 201);
    },
  )
  .openapi(
    createRoute({
      method: "put",
      path: "/v1/discard-reasons/{code}",
      tags: ["care"],
      summary: "Change a coded reason's wording or order, or retire it or offer it again",
      security,
      request: {
        params: ReasonParams,
        body: { content: { "application/json": { schema: UpdateDiscardReason } } },
      },
      responses: {
        200: jsonBody(DiscardReasonItem, "Changed"),
        ...errorResponses,
        ...notFoundResponse,
        ...conflictResponse,
      },
    }),
    async (c) => {
      const access = await requirePermission(c, SETTINGS_PERMISSION);
      const { code } = c.req.valid("param");
      const body = c.req.valid("json");
      const now = new Date();
      const item = await withTenant(c, async (tx) => {
        await requireOrganisationSettings(tx, access);
        const [current] = await tx.select().from(discardReason).where(eq(discardReason.code, code));
        if (!current) throw problems.notFound();
        if (current.version !== body.version) throw problems.conflict();
        if (body.label !== undefined) {
          const check = checkDiscardReason({ code: "valid_code", label: body.label }, []);
          if (!check.ok) throw problems.invalid(check.message);
        }
        const retire =
          body.retired === undefined
            ? {}
            : body.retired
              ? current.retiredAt
                ? {}
                : { retiredAt: now, retiredBy: access.tenantUserId }
              : { retiredAt: null, retiredBy: null };
        const [row] = await tx
          .update(discardReason)
          .set({
            ...(body.label !== undefined ? { label: body.label.trim() } : {}),
            ...(body.labelCy !== undefined ? { labelCy: body.labelCy?.trim() || null } : {}),
            ...(body.sortOrder !== undefined ? { sortOrder: body.sortOrder } : {}),
            ...retire,
          })
          .where(and(eq(discardReason.code, code), eq(discardReason.version, body.version)))
          .returning();
        if (!row) throw problems.conflict();
        await auditInTx(tx, access, {
          action:
            body.retired === true && !current.retiredAt
              ? "care.discard_reason.retire"
              : "care.discard_reason.update",
          resourceType: "discard_reason",
          resourceId: row.id,
          scope: { code: row.code },
          requestId: c.get("requestId"),
        });
        return reasonItem(row);
      });
      return c.json(item, 200);
    },
  );
