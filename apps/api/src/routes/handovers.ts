import {
  AcknowledgeHandover,
  CompileHandover,
  CreateHandoverNote,
  type HandoverAcknowledgementItem,
  HandoverDetail,
  HandoverList,
  type HandoverNoteItem,
  type HandoverSummary,
} from "@harbour/contracts";
import {
  handover,
  handoverAcknowledgement,
  handoverNote,
  person,
  type Transaction,
  withRequestContext,
} from "@harbour/db";
import {
  checkHandoverAcknowledgement,
  checkHandoverNote,
  type HandoverItem,
  handoverOpen,
  shiftAt,
  viewerAcknowledgement,
} from "@harbour/domain";
import { createRoute, z } from "@hono/zod-openapi";
import { and, asc, desc, eq, gt, inArray, isNull, lt } from "drizzle-orm";
import type { Context } from "hono";
import { auditInTx } from "../http/audit";
import { type AppEnv, requirePermission, type TenantAccess, withTenant } from "../http/context";
import { problems } from "../http/problem";
import {
  acknowledgementSummary,
  compileOrRefresh,
  type HandoverRow,
  locationInScope,
  rowShift,
  shiftPatternFor,
  storedItems,
} from "../services/handover";
import { iso } from "./care-shared";
import { createRouter, errorResponses, jsonBody, notFoundResponse, security } from "./openapi";
import { personSummaries } from "./people";

/**
 * The shift handover (care.md rule 8 as built in slice 5; register rows CARE-013 and COMMS-006;
 * hazard HZ-018). A handover is compiled in the system's view of the organisation, never the
 * requester's, so nothing is missed because of who asked; it is read in the requester's view, so
 * items about people outside their scope are left out and counted (HZ-011). Who still has to
 * acknowledge is worked out over each member of staff's own scope. Every read and write is
 * audited by record id.
 */

const PERMISSION = "care.handover.manage";
const DAY_MS = 86_400_000;
const LocationParam = z.object({ id: z.uuid() });
const HandoverParams = LocationParam.extend({ handoverId: z.uuid() });

type AckRow = typeof handoverAcknowledgement.$inferSelect;
type NoteRow = typeof handoverNote.$inferSelect;
type AckState = { readonly acknowledgedBy: string[]; readonly pending: string[] };

/** The system's view of the organisation, acting for the person whose request this is. */
const systemFor = (access: TenantAccess) => ({
  tenantId: access.tenantId,
  userId: access.tenantUserId,
  scope: "tenant" as const,
  locationIds: [] as string[],
});

function summary(row: HandoverRow, acks: readonly AckRow[], now: Date): HandoverSummary {
  const items = storedItems(row);
  return {
    id: row.id,
    locationId: row.locationId,
    shift: {
      name: row.shiftName,
      start: row.shiftStart.toISOString(),
      end: row.shiftEnd.toISOString(),
    },
    compiledAt: row.compiledAt.toISOString(),
    refreshedAt: row.refreshedAt.toISOString(),
    lockedAt: iso(row.lockedAt),
    open: handoverOpen(rowShift(row), row.lockedAt, now),
    itemCount: items.length,
    lateAdditionCount: items.filter((i) => i.lateAddition).length,
    acknowledgedBy: [...new Set(acks.map((a) => a.tenantUserId))],
    // Filled in by `withStates` once the request's own transaction has committed.
    pending: [],
    // The shift it hands over to starts when this one ends.
    unacknowledged: acks.length === 0 && now.getTime() >= row.shiftEnd.getTime(),
    version: row.version,
  };
}

/**
 * Adds who still has to acknowledge, worked out in the system's view of the organisation after
 * the request's own transaction (`acknowledgementSummary`: each member over the people they can
 * see, so nobody is listed for items outside their scope).
 */
async function withStates<T extends HandoverSummary>(
  c: Context<AppEnv>,
  access: TenantAccess,
  items: T[],
  now: Date,
): Promise<T[]> {
  if (items.length === 0) return items;
  const states = await withRequestContext(c.get("services").db, systemFor(access), async (tx) => {
    const rows = await tx
      .select()
      .from(handover)
      .where(
        inArray(
          handover.id,
          items.map((i) => i.id),
        ),
      );
    return acknowledgementSummary(
      tx,
      rows,
      await acknowledgementsOf(
        tx,
        rows.map((r) => r.id),
      ),
      now,
    );
  });
  return items.map((item) => {
    const state: AckState | undefined = states.get(item.id);
    return state ? { ...item, acknowledgedBy: state.acknowledgedBy, pending: state.pending } : item;
  });
}

const noteItem = (n: NoteRow): HandoverNoteItem => ({
  id: n.id,
  itemKey: n.itemKey,
  personId: n.personId,
  body: n.body,
  createdAt: n.createdAt.toISOString(),
  createdBy: n.createdBy,
});

const ackItem = (a: AckRow): HandoverAcknowledgementItem => ({
  id: a.id,
  tenantUserId: a.tenantUserId,
  itemsSeen: a.itemsSeen,
  acknowledgedAt: a.acknowledgedAt.toISOString(),
});

async function acknowledgementsOf(tx: Transaction, handoverIds: readonly string[]) {
  if (handoverIds.length === 0) return [];
  return tx
    .select()
    .from(handoverAcknowledgement)
    .where(inArray(handoverAcknowledgement.handoverId, [...handoverIds]))
    .orderBy(asc(handoverAcknowledgement.acknowledgedAt), asc(handoverAcknowledgement.id));
}

/** The people on a handover the reader may see (row-level security decides). */
async function visiblePeople(tx: Transaction, items: readonly HandoverItem[]) {
  const ids = [...new Set(items.map((i) => i.personId).filter((p): p is string => p !== null))];
  if (ids.length === 0) return new Set<string>();
  const rows = await tx
    .select({ id: person.id })
    .from(person)
    .where(and(inArray(person.id, ids), isNull(person.deletedAt)));
  return new Set(rows.map((r) => r.id));
}

async function loadHandover(tx: Transaction, locationId: string, handoverId: string) {
  const [row] = await tx
    .select()
    .from(handover)
    .where(
      and(
        eq(handover.id, handoverId),
        eq(handover.locationId, locationId),
        isNull(handover.deletedAt),
      ),
    );
  if (!row) throw problems.notFound();
  return row;
}

/** The handover as the reader may see it, with where they stand. */
async function detail(
  tx: Transaction,
  access: TenantAccess,
  row: HandoverRow,
  now: Date,
): Promise<HandoverDetail> {
  const items = storedItems(row);
  const visible = await visiblePeople(tx, items);
  const isVisible = (i: HandoverItem) => i.personId === null || visible.has(i.personId);
  const acks = await acknowledgementsOf(tx, [row.id]);
  const notes = await tx
    .select()
    .from(handoverNote)
    .where(eq(handoverNote.handoverId, row.id))
    .orderBy(asc(handoverNote.createdAt), asc(handoverNote.id));
  const you = viewerAcknowledgement(
    items,
    isVisible,
    acks.map((a) => ({
      tenantUserId: a.tenantUserId,
      at: a.acknowledgedAt,
      itemsSeen: a.itemsSeen,
    })),
    access.tenantUserId,
  );
  const seenUpTo = you.itemsSeen ?? 0;
  const shown = items
    .map((i, index) => ({ i, index }))
    .filter(({ i }) => isVisible(i))
    .map(({ i, index }) => ({
      key: i.key,
      kind: i.kind,
      personId: i.personId,
      sourceType: i.sourceType,
      sourceId: i.sourceId,
      at: i.at.toISOString(),
      lateAddition: i.lateAddition,
      addedAt: i.addedAt.toISOString(),
      seen: index < seenUpTo,
    }));
  return {
    ...summary(row, acks, now),
    items: shown,
    hiddenItemCount: items.length - shown.length,
    notes: notes.map(noteItem),
    acknowledgements: acks.map(ackItem),
    people: visible.size === 0 ? [] : await personSummaries(tx, [...visible]),
    you: {
      acknowledged: you.acknowledged,
      itemsSeen: you.itemsSeen,
      unseenKeys: you.unseen.map((i) => i.key),
    },
  };
}

/** Reads and audits one handover in the reader's view. */
async function viewed(
  c: Context<AppEnv>,
  access: TenantAccess,
  tx: Transaction,
  locationId: string,
  handoverId: string,
  now: Date,
) {
  const row = await loadHandover(tx, locationId, handoverId);
  await auditInTx(tx, access, {
    action: "care.handover.view",
    resourceType: "handover",
    resourceId: row.id,
    requestId: c.get("requestId"),
  });
  return detail(tx, access, row, now);
}

async function one(c: Context<AppEnv>, access: TenantAccess, item: HandoverDetail, now: Date) {
  const [withState] = await withStates(c, access, [item], now);
  return withState ?? item;
}

export const handoversRouter = createRouter()
  .openapi(
    createRoute({
      method: "get",
      path: "/v1/locations/{id}/handovers",
      tags: ["care"],
      summary: "A location's shift handovers, latest first (default: the last 7 days)",
      description:
        "Each says who has acknowledged it, who still has items to acknowledge that they can see, and whether nobody has acknowledged it once the next shift has started.",
      security,
      request: {
        params: LocationParam,
        query: z.object({
          from: z.iso.datetime({ offset: true }).optional(),
          to: z.iso.datetime({ offset: true }).optional(),
        }),
      },
      responses: {
        200: jsonBody(HandoverList, "Handovers"),
        ...errorResponses,
        ...notFoundResponse,
      },
    }),
    async (c) => {
      const access = await requirePermission(c, PERMISSION);
      const { id: locationId } = c.req.valid("param");
      const q = c.req.valid("query");
      const now = new Date();
      const to = q.to ? new Date(q.to) : now;
      const from = q.from ? new Date(q.from) : new Date(to.getTime() - 7 * DAY_MS);
      if (to.getTime() <= from.getTime()) {
        throw problems.invalid("Ask for a period that ends after it starts.");
      }
      if (to.getTime() - from.getTime() > 31 * DAY_MS) {
        throw problems.invalid("Ask for 31 days or fewer.");
      }
      const items = await withTenant(c, async (tx) => {
        if (!(await locationInScope(tx, locationId))) throw problems.notFound();
        const rows = await tx
          .select()
          .from(handover)
          .where(
            and(
              eq(handover.locationId, locationId),
              isNull(handover.deletedAt),
              gt(handover.shiftEnd, from),
              lt(handover.shiftStart, to),
            ),
          )
          .orderBy(desc(handover.shiftStart));
        const acks = await acknowledgementsOf(
          tx,
          rows.map((r) => r.id),
        );
        await auditInTx(tx, access, {
          action: "care.handover.list",
          resourceType: "handover",
          scope: { locationId, count: rows.length },
          requestId: c.get("requestId"),
        });
        return rows.map((r) =>
          summary(
            r,
            acks.filter((a) => a.handoverId === r.id),
            now,
          ),
        );
      });
      return c.json({ items: await withStates(c, access, items, now) }, 200);
    },
  )
  .openapi(
    createRoute({
      method: "post",
      path: "/v1/locations/{id}/handovers",
      tags: ["care"],
      summary: "Compile the handover of a shift, or add what has appeared since it was compiled",
      description:
        "Compiles in the system's view of the organisation, so nothing is missed because of who asked. Items are only ever added; a shift that has ended is locked. Never for a shift that has not started.",
      security,
      request: {
        params: LocationParam,
        body: { content: { "application/json": { schema: CompileHandover } } },
      },
      responses: {
        200: jsonBody(HandoverDetail, "The handover as you may see it"),
        ...errorResponses,
        ...notFoundResponse,
      },
    }),
    async (c) => {
      const access = await requirePermission(c, PERMISSION);
      const { id: locationId } = c.req.valid("param");
      const body = c.req.valid("json");
      const now = new Date();
      const at = body.at ? new Date(body.at) : now;
      const loc = await withTenant(c, (tx) => locationInScope(tx, locationId));
      if (!loc) throw problems.notFound();
      const handoverId = await withRequestContext(
        c.get("services").db,
        systemFor(access),
        async (tx) => {
          const shift = shiftAt(at, await shiftPatternFor(tx, access.tenantId, loc.nation));
          if (shift.start.getTime() > now.getTime()) {
            throw problems.invalid(
              "That shift has not started, so it has nothing to hand over yet.",
            );
          }
          const outcome = await compileOrRefresh(tx, {
            tenantId: access.tenantId,
            locationId,
            shift,
            now,
            lock: shift.end.getTime() <= now.getTime(),
            audit: (action, id, scope) =>
              auditInTx(tx, access, {
                action,
                resourceType: "handover",
                resourceId: id,
                scope,
                requestId: c.get("requestId"),
              }),
          });
          return outcome.row.id;
        },
      );
      const result = await withTenant(c, (tx) =>
        viewed(c, access, tx, locationId, handoverId, now),
      );
      return c.json(await one(c, access, result, now), 200);
    },
  )
  .openapi(
    createRoute({
      method: "get",
      path: "/v1/locations/{id}/handovers/{handoverId}",
      tags: ["care"],
      summary: "One handover: its items, notes and acknowledgements, and where you stand",
      security,
      request: { params: HandoverParams },
      responses: {
        200: jsonBody(HandoverDetail, "The handover as you may see it"),
        ...errorResponses,
        ...notFoundResponse,
      },
    }),
    async (c) => {
      const access = await requirePermission(c, PERMISSION);
      const { id: locationId, handoverId } = c.req.valid("param");
      const now = new Date();
      const result = await withTenant(c, (tx) =>
        viewed(c, access, tx, locationId, handoverId, now),
      );
      return c.json(await one(c, access, result, now), 200);
    },
  )
  .openapi(
    createRoute({
      method: "post",
      path: "/v1/locations/{id}/handovers/{handoverId}/notes",
      tags: ["care"],
      summary: "Add a note to an open handover, or to one of its items",
      description:
        "Notes add to items; they never replace or remove one. A handover takes notes until its shift ends or it is locked. A replayed id returns the stored note.",
      security,
      request: {
        params: HandoverParams,
        body: { content: { "application/json": { schema: CreateHandoverNote } } },
      },
      responses: {
        201: jsonBody(HandoverDetail, "Note saved (or the earlier copy of a replayed save)"),
        ...errorResponses,
        ...notFoundResponse,
      },
    }),
    async (c) => {
      const access = await requirePermission(c, PERMISSION);
      const { id: locationId, handoverId } = c.req.valid("param");
      const body = c.req.valid("json");
      const now = new Date();
      const result = await withTenant(c, async (tx) => {
        const row = await loadHandover(tx, locationId, handoverId);
        if (body.id) {
          const [replayed] = await tx
            .select()
            .from(handoverNote)
            .where(eq(handoverNote.id, body.id));
          if (replayed) {
            if (replayed.handoverId !== row.id) throw problems.invalid("That id is already used.");
            return detail(tx, access, row, now);
          }
        }
        const items = storedItems(row);
        const visible = await visiblePeople(tx, items);
        // Items about people outside the writer's scope are not on the handover they see.
        const keys = items
          .filter((i) => i.personId === null || visible.has(i.personId))
          .map((i) => i.key);
        const check = checkHandoverNote({
          open: handoverOpen(rowShift(row), row.lockedAt, now),
          body: body.body,
          itemKey: body.itemKey ?? null,
          itemKeys: keys,
        });
        if (!check.ok) throw problems.invalid(check.message);
        const item = body.itemKey ? items.find((i) => i.key === body.itemKey) : undefined;
        const [note] = await tx
          .insert(handoverNote)
          .values({
            ...(body.id ? { id: body.id } : {}),
            handoverId: row.id,
            itemKey: body.itemKey ?? null,
            personId: item?.personId ?? null,
            body: body.body.trim(),
            deviceId: access.deviceId,
          })
          .returning();
        if (!note) throw problems.conflict();
        await auditInTx(tx, access, {
          action: "care.handover.note.create",
          resourceType: "handover_note",
          resourceId: note.id,
          scope: { handoverId: row.id, onItem: note.itemKey !== null },
          requestId: c.get("requestId"),
        });
        return detail(tx, access, row, now);
      });
      return c.json(await one(c, access, result, now), 201);
    },
  )
  .openapi(
    createRoute({
      method: "post",
      path: "/v1/locations/{id}/handovers/{handoverId}/acknowledgements",
      tags: ["care"],
      summary: "Acknowledge a handover as you have read it",
      description:
        "Records how many items the handover held when you read it (its itemCount as you saw it), by the server's clock. Items added later about people you can see ask you again, for the new items only. A replayed id returns the handover as it stands.",
      security,
      request: {
        params: HandoverParams,
        body: { content: { "application/json": { schema: AcknowledgeHandover } } },
      },
      responses: {
        201: jsonBody(HandoverDetail, "Acknowledged"),
        ...errorResponses,
        ...notFoundResponse,
      },
    }),
    async (c) => {
      const access = await requirePermission(c, PERMISSION);
      const { id: locationId, handoverId } = c.req.valid("param");
      const body = c.req.valid("json");
      const now = new Date();
      const result = await withTenant(c, async (tx) => {
        const row = await loadHandover(tx, locationId, handoverId);
        if (body.id) {
          const [replayed] = await tx
            .select()
            .from(handoverAcknowledgement)
            .where(eq(handoverAcknowledgement.id, body.id));
          if (replayed) {
            if (replayed.handoverId !== row.id || replayed.tenantUserId !== access.tenantUserId) {
              throw problems.invalid("That id is already used.");
            }
            return detail(tx, access, row, now);
          }
        }
        const check = checkHandoverAcknowledgement(body.itemsSeen, storedItems(row).length);
        if (!check.ok) throw problems.invalid(check.message);
        const [ack] = await tx
          .insert(handoverAcknowledgement)
          .values({
            ...(body.id ? { id: body.id } : {}),
            handoverId: row.id,
            tenantUserId: access.tenantUserId,
            itemsSeen: body.itemsSeen,
            acknowledgedAt: now,
            deviceId: access.deviceId,
          })
          .returning();
        if (!ack) throw problems.conflict();
        await auditInTx(tx, access, {
          action: "care.handover.acknowledge",
          resourceType: "handover",
          resourceId: row.id,
          scope: { itemsSeen: body.itemsSeen, acknowledgementId: ack.id },
          requestId: c.get("requestId"),
        });
        return detail(tx, access, row, now);
      });
      return c.json(await one(c, access, result, now), 201);
    },
  );
