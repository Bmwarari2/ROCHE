import { createHash } from "node:crypto";
import {
  AcknowledgeHandover,
  ClientIdHeaders,
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
  type Transaction,
  withRequestContext,
} from "@harbour/db";
import {
  checkHandoverNote,
  type HandoverItem,
  handoverOpen,
  scopeFor,
  shiftAt,
  viewerAcknowledgement,
} from "@harbour/domain";
import { createRoute, z } from "@hono/zod-openapi";
import { and, asc, desc, eq, gt, inArray, isNull, lt } from "drizzle-orm";
import type { Context } from "hono";
import { auditInTx } from "../http/audit";
import { type AppEnv, requirePermission, type TenantAccess, withTenant } from "../http/context";
import { HttpProblem, problems } from "../http/problem";
import { requireWithinLimit } from "../http/rate-limit";
import {
  acknowledgementSummary,
  acknowledgementsOf,
  compileOrRefresh,
  type HandoverRow,
  itemsOf,
  locationInScope,
  OFFLINE_WINDOW_RATE_KEY,
  rowShift,
  shiftPatternFor,
  toAcknowledgement,
} from "../services/handover";
import { rateNumber } from "../services/rates";
import { type StaffLookup, staffNames } from "../services/staff";
import { iso, lockClientId, refuseUsedId, withClientId } from "./care-shared";
import {
  conflictResponse,
  createRouter,
  errorResponses,
  jsonBody,
  notFoundResponse,
  security,
} from "./openapi";
import { personSummaries } from "./people";

/**
 * The shift handover (care.md rule 8 as built in slice 5; register rows CARE-013 and COMMS-006;
 * hazard HZ-018). A handover is compiled in the system's view of the organisation, never the
 * requester's, so nothing is missed because of who asked; it is read in the requester's view, so
 * row-level security leaves out the items, and the notes on items, about people outside their
 * scope (HZ-011). Every count a reader sees is over the items they can see; a reader who sees the
 * location's handovers limited to their own people sees only their own acknowledgements and
 * learns nothing about the rest. Who still has to acknowledge is worked out over each member of
 * staff's own scope. Every read and write is audited by record id.
 */

const PERMISSION = "care.handover.manage" as const;
const DAY_MS = 86_400_000;
const LocationParam = z.object({ id: z.uuid() });
const HandoverParams = LocationParam.extend({ handoverId: z.uuid() });

type AckRow = typeof handoverAcknowledgement.$inferSelect;
type NoteRow = typeof handoverNote.$inferSelect;

/** The system's view of the organisation, acting for the person whose request this is. */
const systemFor = (access: TenantAccess) => ({
  tenantId: access.tenantId,
  userId: access.tenantUserId,
  scope: "tenant" as const,
  locationIds: [] as string[],
});

/**
 * Whether the reader sees a location's handovers whole: the roles and grants carrying the handover
 * permission reach the whole organisation, or that location (the database's `app.handover_whole`,
 * under the request's scope for that permission, ADR-0071). Everyone else sees them limited to
 * their people.
 */
const seesWhole = (access: TenantAccess, locationId: string) => {
  const { scope, locationIds } = scopeFor(access.effective, PERMISSION);
  return scope === "tenant" || (scope === "locations" && locationIds.includes(locationId));
};

/**
 * What the reader acknowledges: a token over the handover and the keys of the items they can see,
 * in order. It changes whenever an item they can see is added, never for one they cannot, and says
 * nothing about the items themselves.
 */
const seenToken = (handoverId: string, items: readonly HandoverItem[]) =>
  createHash("sha256")
    .update([handoverId, ...items.map((i) => i.key)].join("\n"))
    .digest("base64url")
    .slice(0, 43);

/** A handover as one reader sees it: the items and acknowledgements row-level security shows. */
interface ReaderView {
  readonly row: HandoverRow;
  readonly items: readonly HandoverItem[];
  readonly acks: readonly AckRow[];
  readonly whole: boolean;
}

/** The summary over what the reader can see; `withStates` adds the whole picture for whole readers. */
function summary(view: ReaderView, access: TenantAccess, now: Date): HandoverSummary {
  const { row, items, whole } = view;
  const me = viewerAcknowledgement(
    items,
    () => true,
    view.acks.map(toAcknowledgement),
    access.tenantUserId,
  );
  const lastAdded = items.reduce(
    (latest, i) => (i.addedAt.getTime() > latest.getTime() ? i.addedAt : latest),
    row.compiledAt,
  );
  return {
    id: row.id,
    locationId: row.locationId,
    shift: {
      name: row.shiftName,
      start: row.shiftStart.toISOString(),
      end: row.shiftEnd.toISOString(),
    },
    compiledAt: row.compiledAt.toISOString(),
    // A limited reader learns when items they can see joined it, never when others did.
    refreshedAt: (whole ? row.refreshedAt : lastAdded).toISOString(),
    lockedAt: iso(row.lockedAt),
    open: handoverOpen(rowShift(row), row.lockedAt, now),
    limitedToYourPeople: !whole,
    itemCount: items.length,
    lateAdditionCount: items.filter((i) => i.lateAddition).length,
    // Only the reader, until `withStates` fills these in for a whole reader.
    acknowledgedBy: me.acknowledgedAt ? [access.tenantUserId] : [],
    pending: me.acknowledgedAt && !me.acknowledged ? [access.tenantUserId] : [],
    // Named by `withStaff` once the states are known.
    staff: [],
    unacknowledged: null,
  };
}

/**
 * For readers who see a handover whole, adds who has acknowledged, who still has items to
 * acknowledge and whether the incoming shift has, worked out in the system's view after the
 * request's own transaction (`acknowledgementSummary`: each member over the people they can see).
 */
async function withStates<T extends HandoverSummary>(
  c: Context<AppEnv>,
  access: TenantAccess,
  items: T[],
  now: Date,
): Promise<T[]> {
  const whole = items.filter((i) => !i.limitedToYourPeople);
  if (whole.length === 0) return withStaff(c, items);
  const states = await withRequestContext(c.get("services").db, systemFor(access), async (tx) => {
    const rows = await tx
      .select()
      .from(handover)
      .where(
        inArray(
          handover.id,
          whole.map((i) => i.id),
        ),
      );
    return acknowledgementSummary(tx, rows, now);
  });
  return withStaff(
    c,
    items.map((item) => {
      const state = item.limitedToYourPeople ? undefined : states.get(item.id);
      return state ? { ...item, ...state } : item;
    }),
  );
}

const noteItem = (n: NoteRow, staff: StaffLookup): HandoverNoteItem => ({
  id: n.id,
  itemKey: n.itemKey,
  personId: n.personId,
  body: n.body,
  createdAt: n.createdAt.toISOString(),
  createdBy: n.createdBy,
  createdByStaff: staff(n.createdBy),
});

const ackItem = (a: AckRow, staff: StaffLookup): HandoverAcknowledgementItem => ({
  id: a.id,
  tenantUserId: a.tenantUserId,
  staff: staff(a.tenantUserId),
  acknowledgedAt: a.acknowledgedAt.toISOString(),
});

/**
 * Names the members each summary lists, acknowledged or pending (care.md section 5, staff names),
 * read in the reader's own view: a member of the organisation, never anyone else.
 */
async function withStaff<T extends HandoverSummary>(c: Context<AppEnv>, items: T[]): Promise<T[]> {
  const ids = items.flatMap((i) => [...i.acknowledgedBy, ...i.pending]);
  if (ids.length === 0) return items;
  const staff = await withTenant(c, (tx) => staffNames(tx, ids));
  return items.map((i) => ({
    ...i,
    staff: [...new Set([...i.acknowledgedBy, ...i.pending])].flatMap((id) => {
      const name = staff(id);
      return name ? [name] : [];
    }),
  }));
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

/** Handovers as the reader sees them, in the reader's transaction. */
async function readerViews(
  tx: Transaction,
  access: TenantAccess,
  rows: readonly HandoverRow[],
): Promise<ReaderView[]> {
  const ids = rows.map((r) => r.id);
  const items = await itemsOf(tx, ids);
  const acks = await acknowledgementsOf(tx, ids);
  return rows.map((row) => ({
    row,
    items: items.get(row.id) ?? [],
    acks: acks.filter((a) => a.handoverId === row.id),
    whole: seesWhole(access, row.locationId),
  }));
}

/** The handover as the reader may see it, with where they stand. */
async function detail(
  tx: Transaction,
  access: TenantAccess,
  row: HandoverRow,
  now: Date,
): Promise<HandoverDetail> {
  const [view] = await readerViews(tx, access, [row]);
  if (!view) throw problems.notFound();
  const notes = await tx
    .select()
    .from(handoverNote)
    .where(eq(handoverNote.handoverId, row.id))
    .orderBy(asc(handoverNote.createdAt), asc(handoverNote.id));
  const you = viewerAcknowledgement(
    view.items,
    () => true,
    view.acks.map(toAcknowledgement),
    access.tenantUserId,
  );
  const people = [
    ...new Set(view.items.map((i) => i.personId).filter((p): p is string => p !== null)),
  ];
  const staff = await staffNames(tx, [
    ...notes.map((n) => n.createdBy),
    ...view.acks.map((a) => a.tenantUserId),
  ]);
  return {
    ...summary(view, access, now),
    items: view.items.map((i) => ({
      key: i.key,
      kind: i.kind,
      personId: i.personId,
      sourceType: i.sourceType,
      sourceId: i.sourceId,
      at: i.at.toISOString(),
      lateAddition: i.lateAddition,
      addedAt: i.addedAt.toISOString(),
      summary: i.summary ? { key: i.summary.key, params: { ...i.summary.params } } : null,
      seen: you.seenKeys.has(i.key),
    })),
    notes: notes.map((n) => noteItem(n, staff)),
    acknowledgements: view.acks.map((a) => ackItem(a, staff)),
    people: people.length === 0 ? [] : await personSummaries(tx, people),
    you: {
      acknowledged: you.acknowledged,
      acknowledgedAt: iso(you.acknowledgedAt),
      unseenKeys: you.unseen.map((i) => i.key),
      seenToken: seenToken(row.id, view.items),
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
        "Counts are over the items you can see. Seeing the location whole, you also see who has acknowledged each, who still has items to acknowledge that they can see, and whether nobody on the incoming shift has acknowledged it.",
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
        await auditInTx(tx, access, {
          action: "care.handover.list",
          resourceType: "handover",
          scope: { locationId, count: rows.length },
          requestId: c.get("requestId"),
        });
        return (await readerViews(tx, access, rows)).map((view) => summary(view, access, now));
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
        "Compiles in the system's view of the organisation, so nothing is missed because of who asked. Items are only ever added; a shift that has ended is locked. Never for a shift that has not started, nor from before the offline window; limited per user a minute.",
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
      await requireWithinLimit(
        c.get("services").db,
        access,
        c.get("services").handoverCompileLimiter,
      );
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
          // The worker compiles every shift in the offline window; nothing older is compiled.
          const windowDays = (await rateNumber(tx, access.tenantId, OFFLINE_WINDOW_RATE_KEY)) + 1;
          if (at.getTime() < now.getTime() - windowDays * DAY_MS) {
            throw problems.invalid(
              `Handovers are compiled for the last ${windowDays} days only. Ask for a later time.`,
            );
          }
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
        'Notes add to items; they never replace or remove one. A handover takes notes until its shift ends or it is locked; after that, a care note tagged "Include in handover" reaches the next one. A replayed id returns the stored note.',
      security,
      request: {
        params: HandoverParams,
        headers: ClientIdHeaders,
        body: { content: { "application/json": { schema: CreateHandoverNote } } },
      },
      responses: {
        201: jsonBody(HandoverDetail, "Note saved (or the earlier copy of a replayed save)"),
        ...errorResponses,
        ...notFoundResponse,
        ...conflictResponse,
      },
    }),
    async (c) => {
      const access = await requirePermission(c, PERMISSION);
      const { id: locationId, handoverId } = c.req.valid("param");
      const body = withClientId(c, c.req.valid("json"));
      const now = new Date();
      const result = await withTenant(c, async (tx) => {
        const row = await loadHandover(tx, locationId, handoverId);
        if (body.id) {
          // Two sends of the same note are taken in turn, and an id another record has is refused
          // in words, never as a server error (#26 review round 2, low).
          await lockClientId(tx, "handover_note", body.id);
          const [replayed] = await tx
            .select()
            .from(handoverNote)
            .where(eq(handoverNote.id, body.id));
          if (replayed) {
            if (replayed.handoverId !== row.id) throw problems.invalid("That id is already used.");
            return detail(tx, access, row, now);
          }
        }
        // Only the items the writer can see (row-level security); the database checks again.
        const items = (await itemsOf(tx, [row.id])).get(row.id) ?? [];
        const check = checkHandoverNote({
          open: handoverOpen(rowShift(row), row.lockedAt, now),
          body: body.body,
          itemKey: body.itemKey ?? null,
          itemKeys: items.map((i) => i.key),
        });
        if (!check.ok) throw problems.invalid(check.message);
        // The person comes from the item (a database trigger sets it).
        const [note] = await tx
          .insert(handoverNote)
          .values({
            ...(body.id ? { id: body.id } : {}),
            handoverId: row.id,
            itemKey: body.itemKey ?? null,
            body: body.body.trim(),
            deviceId: access.deviceId,
          })
          .returning()
          // An id another record has (one the writer cannot see) is refused in words.
          .catch(refuseUsedId);
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
        "Send the `you.seenToken` of the handover as you read it. The server records the items you could see, by its own clock, and refuses an old token (409) when an item you can see has been added since, so you never acknowledge what you have not been shown. Items added later about people you can see ask you again, for the new items only. A replayed id returns the handover as it stands.",
      security,
      request: {
        params: HandoverParams,
        headers: ClientIdHeaders,
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
      const body = withClientId(c, c.req.valid("json"));
      const now = new Date();
      const result = await withTenant(c, async (tx) => {
        const row = await loadHandover(tx, locationId, handoverId);
        if (body.id) {
          // Two sends of the same acknowledgement are taken in turn (#26 review round 2, low).
          await lockClientId(tx, "handover_acknowledgement", body.id);
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
        const items = (await itemsOf(tx, [row.id])).get(row.id) ?? [];
        if (body.seenToken !== seenToken(row.id, items)) {
          throw new HttpProblem(
            409,
            "handover_changed",
            "The handover has changed since you opened it.",
            "Open it again to see what was added, then acknowledge it.",
          );
        }
        const [ack] = await tx
          .insert(handoverAcknowledgement)
          .values({
            ...(body.id ? { id: body.id } : {}),
            handoverId: row.id,
            tenantUserId: access.tenantUserId,
            itemKeys: items.map((i) => i.key),
            acknowledgedAt: now,
            deviceId: access.deviceId,
          })
          .returning()
          // An id another record has (one the reader cannot see) is refused in words.
          .catch(refuseUsedId);
        if (!ack) throw problems.conflict();
        await auditInTx(tx, access, {
          action: "care.handover.acknowledge",
          resourceType: "handover",
          resourceId: row.id,
          scope: { items: items.length, acknowledgementId: ack.id },
          requestId: c.get("requestId"),
        });
        return detail(tx, access, row, now);
      });
      return c.json(await one(c, access, result, now), 201);
    },
  );
