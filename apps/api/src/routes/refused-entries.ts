import {
  HandoverHeaders,
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
import { personContext } from "../services/care";
import { refuseCareModeOff, refuseRevokedDevice } from "../services/devices";
import { heldHandoverOf, planHandedOverEntry } from "../services/held-handover";
import {
  copyRefusedEntry,
  REFUSED_READ_ACTION,
  refusedCopyQuota,
  refusedEntriesFor,
  refusedEntryOut,
} from "../services/refused-entries";
import { staffNames } from "../services/staff";
import { PersonParam } from "./care-shared";
import { createRouter, errorResponses, jsonBody, notFoundResponse, security } from "./openapi";

/**
 * Copies of care entries the API refused from a device (care.md section 6, Device integrity part
 * 5; HZ-006): the device sends each refusal's content, the server keeps it with a review task for
 * the nurse in charge, and readers see it like the care record it would have been.
 */

export function createRefusedEntriesRouter() {
  const copyQuota = refusedCopyQuota();
  return createRouter()
    .openapi(
      createRoute({
        method: "post",
        path: "/v1/sync/refused-entries",
        tags: ["sync"],
        summary: "Keep the server's copy of a care entry the API refused from a device",
        description:
          "Stores the request a device made for an entry the API refused (checked against that entry kind's own contract), once per entry id, with the refusal (in the owner's name when a manager hands over another member's held entries, as for the entry routes), and adds it to the person's one open review task for the nurse in charge (due at once; urgent, with a notice to the nurse in charge, when an observation joins it). A copy about a person is taken only when its author cared for them within the offline window; otherwise, as for a person unknown here, it is refused the same way. Written in the organisation's view, so a copy is kept even when its author can no longer see the person; read like the care record. A revoked device's copies come only with a hand-over, and a handed-over copy is checked against the device's hold like the entry it is (its owner's care judged from the entry's own time). Each author's copies count against 200 a day, after the replay check.",
        security,
        request: {
          // A hand-over of held entries (care.md section 6, Device integrity part 6).
          headers: HandoverHeaders,
          body: { content: { "application/json": { schema: SyncRefusedEntry } } },
        },
        responses: {
          200: jsonBody(SyncRefusedEntryResult, "Kept (or kept before)"),
          ...errorResponses,
        },
      }),
      async (c) => {
        const access = await requirePermission(c, "care.note.write");
        const body = c.req.valid("json");
        // A manager handing over another member's held entries sends their refusals' copies too,
        // in the owner's name (care.md section 6, Device integrity part 6).
        const handover = await heldHandoverOf(c, access);
        // Otherwise a revoked device's copies are refused like its uploads (#25 review round 2, M2).
        if (!handover) {
          await refuseRevokedDevice(
            c.get("services"),
            access,
            "sync.refused_entry",
            c.get("requestId"),
          );
          if (access.deviceId) await refuseCareModeOff(c.get("services"), access);
        }
        // A handed-over copy is checked against the hold like the entry it is, and admitted in
        // the copy's transaction (#25 review round 3, low).
        const admission = handover
          ? await planHandedOverEntry(c, handover, {
              table: body.table,
              entryId: body.entryId,
              personId: body.personId?.toLowerCase() ?? null,
              occurredAt: body.payload.occurredAt,
              deviceTime: body.payload.deviceTime,
            })
          : null;
        const result = await copyRefusedEntry(c.get("services").db, access, body, {
          author: handover?.ownerTenantUserId ?? access.tenantUserId,
          deviceId: access.deviceId,
          now: new Date(),
          requestId: c.get("requestId"),
          admission,
          quota: copyQuota,
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
        description:
          "Pages of at most `limit` copies (50 by default); pass `nextBefore` as `before` for the next.",
        security,
        request: {
          params: PersonParam,
          query: z.object({
            before: z.uuid().optional(),
            limit: z.coerce.number().int().min(1).max(200).default(50),
          }),
        },
        responses: {
          200: jsonBody(RefusedEntryList, "Copies"),
          ...errorResponses,
          ...notFoundResponse,
        },
      }),
      async (c) => {
        const access = await requirePermission(c, "care.note.read");
        const { id: personId } = c.req.valid("param");
        const { before, limit } = c.req.valid("query");
        const page = await withTenant(c, async (tx) => {
          await personContext(tx, personId);
          const { rows, next } = await refusedEntriesFor(tx, personId, { before, limit });
          await auditInTx(tx, access, {
            action: REFUSED_READ_ACTION,
            resourceType: "person",
            resourceId: personId,
            scope: { count: rows.length },
            requestId: c.get("requestId"),
          });
          const staff = await staffNames(
            tx,
            rows.flatMap((r) => [r.authorTenantUserId, r.createdBy]),
          );
          return { items: rows.map((r) => refusedEntryOut(r, staff)), nextBefore: next };
        });
        return c.json(page, 200);
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
          return refusedEntryOut(
            row,
            await staffNames(tx, [row.authorTenantUserId, row.createdBy]),
          );
        });
        return c.json(item, 200);
      },
    );
}
