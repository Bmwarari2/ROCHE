import {
  type ComplaintItem,
  ComplaintItem as ComplaintItemSchema,
  ComplaintList,
  type ComplaintResponse,
  ComplaintState,
  ComplaintStep,
  type ComplimentItem,
  ComplimentItem as ComplimentItemSchema,
  ComplimentList,
  CreateComplaint,
  CreateCompliment,
  SetComplaintPauses,
  TagCompliment,
} from "@harbour/contracts";
import { complaint, compliment, location, type Transaction } from "@harbour/db";
import {
  COMPLAINT_WORKFLOW,
  type ComplaintClocks,
  type ComplaintPause,
  complaintClocks,
  complaintResponseProblems,
  complaintStateDeadline,
  type ComplaintState as DomainComplaintState,
  ombudsmanDeadline,
  resolveSafetyPhase2Rates,
  SAFETY_PHASE2_RATE_KEYS,
  ukIsoDate,
} from "@harbour/domain";
import { createRoute, z } from "@hono/zod-openapi";
import { and, desc, eq, isNull } from "drizzle-orm";
import type { Context } from "hono";
import { auditInTx } from "../http/audit";
import { type AppEnv, requirePermission, type TenantAccess, withTenant } from "../http/context";
import { problems } from "../http/problem";
import { publish } from "../outbox";
import { bankHolidays, rateRows } from "../services/rates";
import { type StaffLookup, staffNames } from "../services/staff";
import { setWorkflowDeadline, startWorkflow } from "../services/workflow";
import {
  conflictResponse,
  createRouter,
  errorResponses,
  jsonBody,
  notFoundResponse,
  security,
} from "./openapi";
import { requireHeldAtLocation } from "./safety-shared";
import { moveOrRefuse } from "./workflow-shared";

/**
 * Complaints and compliments (Phase 2 slice 18; safety.md Phase 2 rule 2; SAFE-011; Regulation 16).
 * Every route needs safety.complaint.manage where the record is (checked here, and again by
 * row-level security, migration 0080). A complaint runs `COMPLAINT_WORKFLOW` through the workflow
 * engine; its acknowledgement and response targets (tenant targets in working days, paused while
 * waiting for the complainant) are written onto the workflow, so the approvals list shows them. A
 * response is refused without the Ombudsman signposted and a kept copy. A compliment never runs a
 * clock and may be tagged with the quality statements it is evidence for. Audit and events carry
 * ids only, never the complainant's details or what they said.
 */

const PERMISSION = "safety.complaint.manage" as const;
const IdParam = z.object({ id: z.uuid() });
type ComplaintRow = typeof complaint.$inferSelect;
type ComplimentRow = typeof compliment.$inferSelect;

const subject = (id: string) => ({ subjectType: "complaint", subjectId: id, personId: null });

function audit(
  c: Context<AppEnv>,
  tx: Transaction,
  access: TenantAccess,
  input: Parameters<typeof auditInTx>[2],
) {
  return auditInTx(tx, access, { ...input, requestId: c.get("requestId") });
}

const iso = (d: Date | null) => d?.toISOString() ?? null;

interface Clocks {
  readonly clocks: ComplaintClocks;
  readonly ombudsman: { normallyBy: string; wording: string } | null;
}

/** The complaint's clocks: the tenant's targets with the home's nation's bank holidays. */
async function clocksOf(
  tx: Transaction,
  tenantId: string,
  row: Pick<ComplaintRow, "locationId" | "receivedAt" | "pauses" | "knewOfMatterOn">,
): Promise<Clocks> {
  const [home] = await tx
    .select({ nation: location.nation })
    .from(location)
    .where(eq(location.id, row.locationId));
  const nation = home?.nation ?? "england";
  // The targets are the organisation's own (any nation); the Ombudsman row is England's for now.
  const rates = resolveSafetyPhase2Rates(
    await rateRows(tx, Object.values(SAFETY_PHASE2_RATE_KEYS)),
    "england",
    ukIsoDate(row.receivedAt),
    tenantId,
  );
  const clocks = complaintClocks(
    row.receivedAt,
    row.pauses as ComplaintPause[],
    rates,
    await bankHolidays(tx, nation),
  );
  const ombudsman =
    nation === "england"
      ? {
          normallyBy: ombudsmanDeadline(row.knewOfMatterOn, rates),
          wording: `The complainant can ask the Local Government and Social Care Ombudsman to look at the complaint, normally within ${rates.lgscoTimeLimitMonths} months of first knowing of the matter.`,
        }
      : null;
  return { clocks, ombudsman };
}

function complaintItem(row: ComplaintRow, { clocks, ombudsman }: Clocks, staff: StaffLookup) {
  const item: ComplaintItem = {
    id: row.id,
    locationId: row.locationId,
    personId: row.personId,
    complainantName: row.complainantName,
    complainantRelationship:
      row.complainantRelationship as ComplaintItem["complainantRelationship"],
    complainantContact: row.complainantContact,
    channel: row.channel as ComplaintItem["channel"],
    receivedAt: row.receivedAt.toISOString(),
    knewOfMatterOn: row.knewOfMatterOn,
    summary: row.summary,
    state: row.state as ComplaintItem["state"],
    pauses: row.pauses as ComplaintItem["pauses"],
    acknowledgedAt: iso(row.acknowledgedAt),
    response: (row.response ?? null) as ComplaintResponse | null,
    respondedAt: iso(row.respondedAt),
    appealReceivedAt: iso(row.appealReceivedAt),
    appealReason: row.appealReason,
    appealResponse: (row.appealResponse ?? null) as ComplaintResponse | null,
    appealRespondedAt: iso(row.appealRespondedAt),
    closedReason: row.closedReason,
    closedAt: iso(row.closedAt),
    clocks: {
      acknowledgeBy: clocks.acknowledgeBy,
      respondBy: clocks.respondBy,
      pausedWorkingDays: clocks.pausedWorkingDays,
      wording: clocks.wording,
    },
    ombudsman,
    recordedBy: staff(row.recordedBy),
    version: row.version,
  };
  return item;
}

function complimentItem(row: ComplimentRow, staff: StaffLookup): ComplimentItem {
  return {
    id: row.id,
    locationId: row.locationId,
    personId: row.personId,
    fromName: row.fromName,
    fromRelationship: row.fromRelationship as ComplimentItem["fromRelationship"],
    receivedAt: row.receivedAt.toISOString(),
    summary: row.summary,
    staff: row.staffIds.flatMap((id) => {
      const name = staff(id);
      return name ? [name] : [];
    }),
    evidenceStatementIds: row.evidenceStatementIds,
    documentId: row.documentId,
    recordedBy: staff(row.recordedBy),
    version: row.version,
  };
}

async function loadComplaint(tx: Transaction, id: string, version?: number): Promise<ComplaintRow> {
  const [row] = await tx
    .select()
    .from(complaint)
    .where(and(eq(complaint.id, id), isNull(complaint.deletedAt)));
  if (!row) throw problems.notFound();
  if (version !== undefined && row.version !== version) throw problems.conflict();
  return row;
}

async function complaintOut(tx: Transaction, tenantId: string, row: ComplaintRow) {
  return complaintItem(
    row,
    await clocksOf(tx, tenantId, row),
    await staffNames(tx, [row.recordedBy]),
  );
}

/** Writes the deadline of the complaint's state onto its workflow (the approvals list). */
async function syncDeadline(tx: Transaction, row: ComplaintRow, { clocks }: Clocks) {
  await setWorkflowDeadline(
    tx,
    COMPLAINT_WORKFLOW,
    subject(row.id),
    complaintStateDeadline(row.state as DomainComplaintState, clocks),
  );
}

const OPEN_FOR_PAUSES = new Set(["received", "acknowledged", "investigating"]);

export const complaintsRouter = createRouter()
  .openapi(
    createRoute({
      method: "post",
      path: "/v1/complaints",
      tags: ["safety"],
      summary: "Record a complaint (Regulation 16); starts its clocks",
      description:
        "Needs safety.complaint.manage at the complaint's home. Starts the complaint workflow with the acknowledgement target written onto it, and publishes safety.complaint.received (ids only).",
      security,
      request: { body: { content: { "application/json": { schema: CreateComplaint } } } },
      responses: {
        201: jsonBody(ComplaintItemSchema, "Recorded"),
        ...errorResponses,
        ...conflictResponse,
      },
    }),
    async (c) => {
      const access = await requirePermission(c, PERMISSION);
      const body = c.req.valid("json");
      const now = new Date();
      if (Date.parse(body.receivedAt) > now.getTime()) {
        throw problems.invalid("When it was received cannot be in the future.");
      }
      if (body.knewOfMatterOn > ukIsoDate(new Date(body.receivedAt))) {
        throw problems.invalid("When they knew of the matter cannot be after it was received.");
      }
      await requireHeldAtLocation(c, access, PERMISSION, {
        type: "location",
        id: body.locationId,
        locationId: body.locationId,
      });
      const item = await withTenant(c, async (tx) => {
        const [row] = await tx
          .insert(complaint)
          .values({
            ...(body.id ? { id: body.id } : {}),
            locationId: body.locationId,
            personId: body.personId ?? null,
            complainantName: body.complainantName,
            complainantRelationship: body.complainantRelationship,
            complainantContact: body.complainantContact ?? null,
            channel: body.channel,
            receivedAt: new Date(body.receivedAt),
            knewOfMatterOn: body.knewOfMatterOn,
            summary: body.summary,
            recordedBy: access.tenantUserId,
          })
          .onConflictDoNothing()
          .returning();
        if (!row) throw problems.conflict();
        const clocks = await clocksOf(tx, access.tenantId, row);
        await startWorkflow(
          tx,
          access.tenantId,
          COMPLAINT_WORKFLOW,
          subject(row.id),
          now,
          complaintStateDeadline("received", clocks.clocks),
        );
        await publish(tx, {
          context: "safety",
          aggregateType: "complaint",
          aggregateId: row.id,
          type: "safety.complaint.received",
          payload: { complaintId: row.id, locationId: row.locationId },
        });
        await audit(c, tx, access, {
          action: "safety.complaint.create",
          resourceType: "complaint",
          resourceId: row.id,
        });
        return complaintItem(row, clocks, await staffNames(tx, [row.recordedBy]));
      });
      return c.json(item, 201);
    },
  )
  .openapi(
    createRoute({
      method: "get",
      path: "/v1/complaints",
      tags: ["safety"],
      summary: "Complaints at the homes where you manage them, newest first",
      security,
      request: {
        query: z.object({ locationId: z.uuid().optional(), state: ComplaintState.optional() }),
      },
      responses: { 200: jsonBody(ComplaintList, "Complaints"), ...errorResponses },
    }),
    async (c) => {
      const access = await requirePermission(c, PERMISSION);
      const query = c.req.valid("query");
      const items = await withTenant(c, async (tx) => {
        const rows = await tx
          .select()
          .from(complaint)
          .where(
            and(
              isNull(complaint.deletedAt),
              query.locationId ? eq(complaint.locationId, query.locationId) : undefined,
              query.state ? eq(complaint.state, query.state) : undefined,
            ),
          )
          .orderBy(desc(complaint.receivedAt))
          .limit(500);
        const staff = await staffNames(
          tx,
          rows.map((r) => r.recordedBy),
        );
        const out: ComplaintItem[] = [];
        for (const row of rows)
          out.push(complaintItem(row, await clocksOf(tx, access.tenantId, row), staff));
        await audit(c, tx, access, {
          action: "safety.complaint.list",
          scope: { count: out.length },
        });
        return out;
      });
      return c.json({ items }, 200);
    },
  )
  .openapi(
    createRoute({
      method: "get",
      path: "/v1/complaints/{id}",
      tags: ["safety"],
      summary: "One complaint, with its clocks and the Ombudsman's time limit",
      security,
      request: { params: IdParam },
      responses: {
        200: jsonBody(ComplaintItemSchema, "Complaint"),
        ...errorResponses,
        ...notFoundResponse,
      },
    }),
    async (c) => {
      const access = await requirePermission(c, PERMISSION);
      const { id } = c.req.valid("param");
      const item = await withTenant(c, async (tx) => {
        const row = await loadComplaint(tx, id);
        await audit(c, tx, access, {
          action: "safety.complaint.view",
          resourceType: "complaint",
          resourceId: id,
        });
        return complaintOut(tx, access.tenantId, row);
      });
      return c.json(item, 200);
    },
  )
  .openapi(
    createRoute({
      method: "post",
      path: "/v1/complaints/{id}/step",
      tags: ["safety"],
      summary: "Take the next complaint step: acknowledge, investigate, respond, appeal or close",
      description:
        "A response (first or after an appeal) needs the outcome, what was done, the Ombudsman signposted and a kept copy (complaintResponseProblems); an appeal needs when it arrived and why; closing needs a reason. The workflow engine checks the step and the permission; the new state's deadline is written onto the workflow.",
      security,
      request: {
        params: IdParam,
        body: { content: { "application/json": { schema: ComplaintStep } } },
      },
      responses: {
        200: jsonBody(ComplaintItemSchema, "Moved"),
        ...errorResponses,
        ...notFoundResponse,
        ...conflictResponse,
      },
    }),
    async (c) => {
      const access = await requirePermission(c, PERMISSION);
      const { id } = c.req.valid("param");
      const body = c.req.valid("json");
      const now = new Date();
      const item = await withTenant(c, async (tx) => {
        const row = await loadComplaint(tx, id, body.version);
        await requireHeldAtLocation(c, access, PERMISSION, {
          type: "complaint",
          id,
          locationId: row.locationId,
        });
        const changes: Partial<typeof complaint.$inferInsert> = { state: body.to };
        if (body.to === "acknowledged") changes.acknowledgedAt = now;
        if (body.to === "responded" || body.to === "appeal_responded") {
          const response = body.response;
          const needs = complaintResponseProblems({
            outcome: response?.outcome ?? null,
            actionsTaken: response?.actionsTaken ?? null,
            ombudsmanSignposted: response?.ombudsmanSignposted ?? false,
            documentId: response?.documentId ?? null,
          });
          if (needs.length > 0) throw problems.invalid(needs.join(" "));
          if (body.to === "responded") {
            changes.response = response;
            changes.respondedAt = now;
          } else {
            changes.appealResponse = response;
            changes.appealRespondedAt = now;
          }
        }
        if (body.to === "appealed") {
          if (!body.appeal) throw problems.invalid("Record when the appeal arrived and why.");
          if (Date.parse(body.appeal.receivedAt) > now.getTime()) {
            throw problems.invalid("When the appeal arrived cannot be in the future.");
          }
          changes.appealReceivedAt = new Date(body.appeal.receivedAt);
          changes.appealReason = body.appeal.reason;
        }
        if (body.to === "closed") {
          changes.closedAt = now;
          changes.closedReason = body.reason ?? null;
        }
        await moveOrRefuse(c, tx, COMPLAINT_WORKFLOW, subject(id), body.to, body.reason, now);
        const [saved] = await tx
          .update(complaint)
          .set(changes)
          .where(and(eq(complaint.id, id), eq(complaint.version, body.version)))
          .returning();
        if (!saved) throw problems.conflict();
        const clocks = await clocksOf(tx, access.tenantId, saved);
        await syncDeadline(tx, saved, clocks);
        if (body.to === "responded" || body.to === "appeal_responded" || body.to === "closed") {
          await publish(tx, {
            context: "safety",
            aggregateType: "complaint",
            aggregateId: id,
            type: body.to === "closed" ? "safety.complaint.closed" : "safety.complaint.responded",
            payload: {
              complaintId: id,
              locationId: saved.locationId,
              ...(body.response ? { outcome: body.response.outcome } : {}),
            },
          });
        }
        await audit(c, tx, access, {
          action: `safety.complaint.${body.to}`,
          resourceType: "complaint",
          resourceId: id,
        });
        return complaintItem(saved, clocks, await staffNames(tx, [saved.recordedBy]));
      });
      return c.json(item, 200);
    },
  )
  .openapi(
    createRoute({
      method: "put",
      path: "/v1/complaints/{id}/pauses",
      tags: ["safety"],
      summary: "Record when the response target is paused, waiting for the complainant",
      description:
        "UK dates, inclusive, each with a reason (waiting for consent or information). Only before the response; the response target moves by the working days paused, and the new deadline is written onto the workflow.",
      security,
      request: {
        params: IdParam,
        body: { content: { "application/json": { schema: SetComplaintPauses } } },
      },
      responses: {
        200: jsonBody(ComplaintItemSchema, "Saved"),
        ...errorResponses,
        ...notFoundResponse,
        ...conflictResponse,
      },
    }),
    async (c) => {
      const access = await requirePermission(c, PERMISSION);
      const { id } = c.req.valid("param");
      const body = c.req.valid("json");
      const item = await withTenant(c, async (tx) => {
        const row = await loadComplaint(tx, id, body.version);
        await requireHeldAtLocation(c, access, PERMISSION, {
          type: "complaint",
          id,
          locationId: row.locationId,
        });
        if (!OPEN_FOR_PAUSES.has(row.state)) {
          throw problems.invalid("Pauses can be recorded only before the response is sent.");
        }
        const received = ukIsoDate(row.receivedAt);
        for (const p of body.pauses) {
          if (p.from > p.to) throw problems.invalid("A pause cannot end before it starts.");
          if (p.to < received) {
            throw problems.invalid("A pause cannot end before the complaint was received.");
          }
        }
        const [saved] = await tx
          .update(complaint)
          .set({ pauses: body.pauses })
          .where(and(eq(complaint.id, id), eq(complaint.version, body.version)))
          .returning();
        if (!saved) throw problems.conflict();
        const clocks = await clocksOf(tx, access.tenantId, saved);
        await syncDeadline(tx, saved, clocks);
        await audit(c, tx, access, {
          action: "safety.complaint.pauses",
          resourceType: "complaint",
          resourceId: id,
          scope: { count: body.pauses.length },
        });
        return complaintItem(saved, clocks, await staffNames(tx, [saved.recordedBy]));
      });
      return c.json(item, 200);
    },
  )
  .openapi(
    createRoute({
      method: "post",
      path: "/v1/compliments",
      tags: ["safety"],
      summary: "Record a compliment, optionally tagged as evidence for quality statements",
      description:
        "Needs safety.complaint.manage at its home. Never runs a clock. Publishes safety.compliment.recorded (ids and statement identifiers only) for the evidence library's links (slice 14).",
      security,
      request: { body: { content: { "application/json": { schema: CreateCompliment } } } },
      responses: {
        201: jsonBody(ComplimentItemSchema, "Recorded"),
        ...errorResponses,
        ...conflictResponse,
      },
    }),
    async (c) => {
      const access = await requirePermission(c, PERMISSION);
      const body = c.req.valid("json");
      if (Date.parse(body.receivedAt) > Date.now()) {
        throw problems.invalid("When it was received cannot be in the future.");
      }
      await requireHeldAtLocation(c, access, PERMISSION, {
        type: "location",
        id: body.locationId,
        locationId: body.locationId,
      });
      const item = await withTenant(c, async (tx) => {
        const [row] = await tx
          .insert(compliment)
          .values({
            ...(body.id ? { id: body.id } : {}),
            locationId: body.locationId,
            personId: body.personId ?? null,
            fromName: body.fromName,
            fromRelationship: body.fromRelationship,
            receivedAt: new Date(body.receivedAt),
            summary: body.summary,
            staffIds: [...new Set(body.staffIds)],
            evidenceStatementIds: [...new Set(body.evidenceStatementIds)],
            documentId: body.documentId ?? null,
            recordedBy: access.tenantUserId,
          })
          .onConflictDoNothing()
          .returning();
        if (!row) throw problems.conflict();
        await publish(tx, {
          context: "safety",
          aggregateType: "compliment",
          aggregateId: row.id,
          type: "safety.compliment.recorded",
          payload: {
            complimentId: row.id,
            locationId: row.locationId,
            evidenceStatementIds: row.evidenceStatementIds.join(","),
          },
        });
        await audit(c, tx, access, {
          action: "safety.compliment.create",
          resourceType: "compliment",
          resourceId: row.id,
        });
        return complimentItem(row, await staffNames(tx, [row.recordedBy, ...row.staffIds]));
      });
      return c.json(item, 201);
    },
  )
  .openapi(
    createRoute({
      method: "get",
      path: "/v1/compliments",
      tags: ["safety"],
      summary: "Compliments at the homes where you manage complaints, newest first",
      security,
      request: { query: z.object({ locationId: z.uuid().optional() }) },
      responses: { 200: jsonBody(ComplimentList, "Compliments"), ...errorResponses },
    }),
    async (c) => {
      const access = await requirePermission(c, PERMISSION);
      const query = c.req.valid("query");
      const items = await withTenant(c, async (tx) => {
        const rows = await tx
          .select()
          .from(compliment)
          .where(
            and(
              isNull(compliment.deletedAt),
              query.locationId ? eq(compliment.locationId, query.locationId) : undefined,
            ),
          )
          .orderBy(desc(compliment.receivedAt))
          .limit(500);
        const staff = await staffNames(
          tx,
          rows.flatMap((r) => [r.recordedBy, ...r.staffIds]),
        );
        await audit(c, tx, access, {
          action: "safety.compliment.list",
          scope: { count: rows.length },
        });
        return rows.map((r) => complimentItem(r, staff));
      });
      return c.json({ items }, 200);
    },
  )
  .openapi(
    createRoute({
      method: "put",
      path: "/v1/compliments/{id}/evidence",
      tags: ["safety"],
      summary: "Tag a compliment with the quality statements it is evidence for",
      security,
      request: {
        params: IdParam,
        body: { content: { "application/json": { schema: TagCompliment } } },
      },
      responses: {
        200: jsonBody(ComplimentItemSchema, "Tagged"),
        ...errorResponses,
        ...notFoundResponse,
        ...conflictResponse,
      },
    }),
    async (c) => {
      const access = await requirePermission(c, PERMISSION);
      const { id } = c.req.valid("param");
      const body = c.req.valid("json");
      const item = await withTenant(c, async (tx) => {
        const [row] = await tx
          .select()
          .from(compliment)
          .where(and(eq(compliment.id, id), isNull(compliment.deletedAt)));
        if (!row) throw problems.notFound();
        if (row.version !== body.version) throw problems.conflict();
        await requireHeldAtLocation(c, access, PERMISSION, {
          type: "compliment",
          id,
          locationId: row.locationId,
        });
        const [saved] = await tx
          .update(compliment)
          .set({ evidenceStatementIds: [...new Set(body.evidenceStatementIds)] })
          .where(and(eq(compliment.id, id), eq(compliment.version, body.version)))
          .returning();
        if (!saved) throw problems.conflict();
        await publish(tx, {
          context: "safety",
          aggregateType: "compliment",
          aggregateId: id,
          type: "safety.compliment.tagged",
          payload: {
            complimentId: id,
            locationId: saved.locationId,
            evidenceStatementIds: saved.evidenceStatementIds.join(","),
          },
        });
        await audit(c, tx, access, {
          action: "safety.compliment.tag",
          resourceType: "compliment",
          resourceId: id,
          scope: { count: saved.evidenceStatementIds.length },
        });
        return complimentItem(saved, await staffNames(tx, [saved.recordedBy, ...saved.staffIds]));
      });
      return c.json(item, 200);
    },
  );
