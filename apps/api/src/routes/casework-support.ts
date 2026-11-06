import {
  ApproveCaseworkSupportTicket,
  CaseworkSupportTicket,
  CaseworkSupportTicketList,
  RaiseCaseworkSupportTicket,
} from "@harbour/contracts";
import { caseworkSupportTicket } from "@harbour/db";
import { createRoute, z } from "@hono/zod-openapi";
import { and, desc, eq } from "drizzle-orm";
import { AuditedRefusal, withAuditedRefusal } from "../http/audit";
import {
  requireAnyPermission,
  requirePermission,
  stepUpFresh,
  stepUpRefusal,
  withTenant,
} from "../http/context";
import { problems } from "../http/problem";
import {
  conflictResponse,
  createRouter,
  errorResponses,
  jsonBody,
  notFoundResponse,
  security,
} from "./openapi";
import { audit, dbCode } from "./people-shared";

/**
 * H-804 (recommended answer applied 31/10/2026, reviewed at testing): a case whose case managers
 * have all left is given a new one only through Thapsus support, on a ticket raised by a holder of
 * `platform.user.manage` and approved, with step-up, by the data protection lead
 * (`platform.dpia.sign`), someone else. The ticket names the case by id only; neither the
 * requester nor the approver reads the case, and support appoints the member it names without
 * reading it (`POST /operator/tenants/{tenantId}/casework-support-tickets/{ticketId}/appoint`).
 * The database enforces the same (migration 0121). Audited by ids only.
 */

const RAISE = "platform.user.manage";
const APPROVE = "platform.dpia.sign";
const A = {
  raised: "workforce.casework_support.requested",
  approved: "workforce.casework_support.approved",
} as const;

type Row = typeof caseworkSupportTicket.$inferSelect;
const item = (r: Row) =>
  CaseworkSupportTicket.parse({
    id: r.id,
    version: r.version,
    caseId: r.caseId,
    newManagerId: r.newManagerId,
    requestedBy: r.requestedBy,
    reason: r.reason,
    approvedBy: r.approvedBy,
    approvedAt: r.approvedAt?.toISOString() ?? null,
    usedAt: r.usedAt?.toISOString() ?? null,
  });

const refused = (action: string, id: string | null, reason: string, status: 403 | 409 | 422) =>
  new AuditedRefusal(
    status === 403
      ? problems.forbidden()
      : status === 409
        ? problems.conflict()
        : problems.invalid("That ticket cannot be raised like that."),
    {
      action,
      outcome: "denied",
      resourceType: "casework_support_ticket",
      ...(id ? { resourceId: id } : {}),
      reason,
    },
  );

export const caseworkSupportRouter = createRouter()
  .openapi(
    createRoute({
      method: "get",
      path: "/v1/workforce/casework-support-tickets",
      tags: ["workforce"],
      summary: "Casework support tickets",
      description: `${RAISE} or ${APPROVE}. The organisation's tickets, newest first, by ids only.`,
      security,
      responses: { 200: jsonBody(CaseworkSupportTicketList, "Tickets"), ...errorResponses },
    }),
    async (c) => {
      await requireAnyPermission(c, [RAISE, APPROVE]);
      const rows = await withTenant(c, (tx) =>
        tx.select().from(caseworkSupportTicket).orderBy(desc(caseworkSupportTicket.createdAt)),
      );
      return c.json({ items: rows.map(item) }, 200);
    },
  )
  .openapi(
    createRoute({
      method: "post",
      path: "/v1/workforce/casework-support-tickets",
      tags: ["workforce"],
      summary: "Ask support to give a case a new case manager",
      description: `${RAISE}. Names the case by id and the member who will be its case manager (never oneself). Approved by the data protection lead before support can act. Audited.`,
      security,
      request: {
        body: { content: { "application/json": { schema: RaiseCaseworkSupportTicket } } },
      },
      responses: {
        201: jsonBody(CaseworkSupportTicket, "Raised"),
        ...errorResponses,
        ...notFoundResponse,
      },
    }),
    async (c) => {
      const access = await requirePermission(c, RAISE);
      const body = c.req.valid("json");
      const row = await withAuditedRefusal(c, access, () =>
        withTenant(c, async (tx) => {
          if (body.newManagerId === access.tenantUserId) {
            throw refused(A.raised, null, "names_requester", 422);
          }
          try {
            const [saved] = await tx
              .insert(caseworkSupportTicket)
              .values({
                caseId: body.caseId,
                newManagerId: body.newManagerId,
                reason: body.reason,
                requestedBy: access.tenantUserId,
              })
              .returning();
            if (!saved) throw new Error("ticket not stored");
            await audit(c, tx, access, {
              action: A.raised,
              resourceType: "casework_support_ticket",
              resourceId: saved.id,
            });
            return saved;
          } catch (error) {
            // A case id that does not exist: the database's foreign key, said as not found.
            if (dbCode(error) === "23503") throw refused(A.raised, null, "not_found", 422);
            throw error;
          }
        }),
      );
      return c.json(item(row), 201);
    },
  )
  .openapi(
    createRoute({
      method: "post",
      path: "/v1/workforce/casework-support-tickets/{id}/approve",
      tags: ["workforce"],
      summary: "Approve a casework support ticket",
      description: `${APPROVE}, with a fresh step-up, never one's own request or one naming oneself. Once. Audited.`,
      security,
      request: {
        params: z.object({ id: z.uuid() }),
        body: { content: { "application/json": { schema: ApproveCaseworkSupportTicket } } },
      },
      responses: {
        200: jsonBody(CaseworkSupportTicket, "Approved"),
        ...errorResponses,
        ...notFoundResponse,
        ...conflictResponse,
      },
    }),
    async (c) => {
      const access = await requirePermission(c, APPROVE);
      const stepUp = c.get("access");
      if (!stepUpFresh(stepUp)) throw stepUpRefusal(stepUp);
      const { id } = c.req.valid("param");
      const { expectedVersion } = c.req.valid("json");
      const row = await withAuditedRefusal(c, access, () =>
        withTenant(c, async (tx) => {
          const [found] = await tx
            .select()
            .from(caseworkSupportTicket)
            .where(eq(caseworkSupportTicket.id, id));
          if (!found)
            throw new AuditedRefusal(problems.notFound(), {
              action: A.approved,
              outcome: "denied",
              resourceType: "casework_support_ticket",
              resourceId: id,
              reason: "not_found",
            });
          if (
            found.requestedBy === access.tenantUserId ||
            found.newManagerId === access.tenantUserId
          ) {
            throw refused(A.approved, id, "own_ticket", 403);
          }
          if (found.approvedBy !== null) throw refused(A.approved, id, "already_approved", 409);
          const [saved] = await tx
            .update(caseworkSupportTicket)
            .set({ approvedBy: access.tenantUserId, approvedAt: new Date() })
            .where(
              and(
                eq(caseworkSupportTicket.id, id),
                eq(caseworkSupportTicket.version, expectedVersion),
              ),
            )
            .returning();
          if (!saved) throw refused(A.approved, id, "version_conflict", 409);
          await audit(c, tx, access, {
            action: A.approved,
            resourceType: "casework_support_ticket",
            resourceId: id,
          });
          return saved;
        }),
      );
      return c.json(item(row), 200);
    },
  );
