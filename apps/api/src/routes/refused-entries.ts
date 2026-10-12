import {
  RefusedEntryItem,
  RefusedEntryList,
  SyncRefusedEntry,
  SyncRefusedEntryResult,
} from "@harbour/contracts";
import { refusedEntry } from "@harbour/db";
import { createRoute, z } from "@hono/zod-openapi";
import { eq } from "drizzle-orm";
import { auditInTx } from "../http/audit";
import { requirePermission, withTenant } from "../http/context";
import { problems } from "../http/problem";
import { PerUserQuota } from "../http/quota";
import { personContext } from "../services/care";
import {
  copyRefusedEntry,
  REFUSED_READ_ACTION,
  refusedEntriesFor,
  refusedEntryOut,
} from "../services/refused-entries";
import { PersonParam } from "./care-shared";
import { createRouter, errorResponses, jsonBody, notFoundResponse, security } from "./openapi";

/**
 * Copies of care entries the API refused from a device (care.md section 6, Device integrity part
 * 5; HZ-006): the device sends each refusal's content, the server keeps it with a review task for
 * the nurse in charge, and readers see it like the care record it would have been.
 */

/** Copies each person may send in a rolling day: far above real refusals, a bound on a script. */
const COPIES_PER_DAY = 200;
const DAY_MS = 86_400_000;

export function createRefusedEntriesRouter() {
  const copyQuota = new PerUserQuota(COPIES_PER_DAY, DAY_MS);
  return createRouter()
    .openapi(
      createRoute({
        method: "post",
        path: "/v1/sync/refused-entries",
        tags: ["sync"],
        summary: "Keep the server's copy of a care entry the API refused from a device",
        description:
          "Stores what the device held for an entry the API refused, once per entry id, with the refusal, and adds it to the person's one open review task for the nurse in charge (due at once, urgent when an observation joins it). Written in the organisation's view, so a copy is kept even when its author can no longer see the person; read like the care record. Each person may send 200 copies a day.",
        security,
        request: { body: { content: { "application/json": { schema: SyncRefusedEntry } } } },
        responses: {
          200: jsonBody(SyncRefusedEntryResult, "Kept (or kept before)"),
          ...errorResponses,
        },
      }),
      async (c) => {
        const access = await requirePermission(c, "care.note.write");
        const body = c.req.valid("json");
        copyQuota.take(access.tenantUserId);
        const result = await copyRefusedEntry(c.get("services").db, access, body, {
          author: access.tenantUserId,
          deviceId: access.deviceId,
          now: new Date(),
          requestId: c.get("requestId"),
        });
        return c.json({ ...result, entryId: body.entryId.toLowerCase() }, 200);
      },
    )
    .openapi(
      createRoute({
        method: "get",
        path: "/v1/people/{id}/refused-entries",
        tags: ["care"],
        summary: "Copies of entries about the person a device could not save, newest first",
        security,
        request: { params: PersonParam },
        responses: {
          200: jsonBody(RefusedEntryList, "Copies"),
          ...errorResponses,
          ...notFoundResponse,
        },
      }),
      async (c) => {
        const access = await requirePermission(c, "care.note.read");
        const { id: personId } = c.req.valid("param");
        const items = await withTenant(c, async (tx) => {
          await personContext(tx, personId);
          const rows = await refusedEntriesFor(tx, personId);
          await auditInTx(tx, access, {
            action: REFUSED_READ_ACTION,
            resourceType: "person",
            resourceId: personId,
            scope: { count: rows.length },
            requestId: c.get("requestId"),
          });
          return rows.map(refusedEntryOut);
        });
        return c.json({ items }, 200);
      },
    )
    .openapi(
      createRoute({
        method: "get",
        path: "/v1/refused-entries/{id}",
        tags: ["care"],
        summary: "The server's copy of one entry a device could not save",
        security,
        request: { params: z.object({ id: z.uuid() }) },
        responses: {
          200: jsonBody(RefusedEntryItem, "The copy"),
          ...errorResponses,
          ...notFoundResponse,
        },
      }),
      async (c) => {
        const access = await requirePermission(c, "care.note.read");
        const { id } = c.req.valid("param");
        const item = await withTenant(c, async (tx) => {
          const [row] = await tx.select().from(refusedEntry).where(eq(refusedEntry.id, id));
          if (!row) throw problems.notFound();
          await auditInTx(tx, access, {
            action: REFUSED_READ_ACTION,
            resourceType: "refused_entry",
            resourceId: row.id,
            requestId: c.get("requestId"),
          });
          return refusedEntryOut(row);
        });
        return c.json(item, 200);
      },
    );
}
