import {
  CloseKeyIssue,
  CreateKeyIssue,
  CreatePropertyItem,
  DisposePropertyItem,
  type KeyIssueOut,
  KeyList,
  LosePropertyItem,
  type PropertyItemOut,
  PropertyList,
  ReturnPropertyItem,
} from "@harbour/contracts";
import { document, incident, keyIssue, propertyItem, type Transaction } from "@harbour/db";
import {
  checkPropertyDisposal,
  checkPropertyItemIn,
  checkPropertyLoss,
  checkPropertyReturn,
  isValuable,
  outstandingKeys,
  outstandingProperty,
  type PersonStatus,
  type PropertyItemRecord,
  type PropertyProblem,
  type PropertySignature,
  propertyToSendWithPerson,
  ukIsoDate,
} from "@harbour/domain";
import { createRoute, z } from "@hono/zod-openapi";
import { and, eq, inArray } from "drizzle-orm";
import type { Context } from "hono";
import { type AppEnv, requirePermission, type TenantAccess, withTenant } from "../http/context";
import { problems } from "../http/problem";
import {
  loadPerson,
  personKeys,
  personProperty,
  requireVersion,
  requireWrite,
} from "../services/people";
import {
  conflictResponse,
  createRouter,
  errorResponses,
  jsonBody,
  notFoundResponse,
  security,
} from "./openapi";
import { audit, invalidOnForeignKey, PersonParam } from "./people-shared";

/**
 * Personal property, valuables and keys (people.md rule 7; Regulation 13). Every item in is
 * described, dated, counted and acknowledged, with a second member of staff witnessing valuables
 * and anything nobody could sign for; each item leaves once (returned, disposed of or lost with an
 * incident). Cash is refused: residents' money is a ledger (finance). Keys and property still held
 * keep an exit from closing. Reads and writes are audited by record id.
 */

const ItemParams = PersonParam.extend({ itemId: z.uuid() });
const KeyParams = PersonParam.extend({ keyId: z.uuid() });

const PROPERTY_MESSAGES: Record<PropertyProblem, string> = {
  description_required: "Describe the item.",
  cash_not_allowed: "Cash is not recorded as property: record it in the residents' money ledger.",
  unknown_category: "Choose a category for the item.",
  quantity_invalid: "Count the items as a whole number of 1 or more.",
  invalid_date: "Enter the date as a real date.",
  signer_name_required: "Type the name of the person who signed.",
  unable_reason_required: "Say why nobody could sign.",
  witness_required:
    "A second member of staff must witness valuables and items nobody could sign for.",
  witness_same_as_recorder: "The witness must be a different member of staff.",
  already_closed: "This item has already been returned, disposed of or recorded as lost.",
  returned_before_received: "The date cannot be before the item was received.",
  recipient_required: "Say who received the item.",
  recipient_not_entitled:
    "After a death, property goes only to the personal representative (executor or administrator).",
  reason_required: "Give a reason.",
  incident_required: "Record the incident for the lost item first.",
};

function refuse(issues: readonly PropertyProblem[]): never {
  throw problems.invalid(issues.map((i) => PROPERTY_MESSAGES[i]).join(" "));
}

type ItemRow = typeof propertyItem.$inferSelect;

function signature(input: {
  signer: PropertySignature["signer"];
  name?: string | undefined;
  unableReason?: string | undefined;
  signedAt: string;
}): PropertySignature {
  return {
    signer: input.signer,
    name: input.name ?? null,
    unableReason: input.unableReason ?? null,
    signedAt: new Date(input.signedAt),
  };
}

function record(row: ItemRow): PropertyItemRecord {
  return {
    id: row.id,
    category: row.category,
    valuable: row.valuable,
    receivedOn: row.receivedOn,
    status: row.status as PropertyItemRecord["status"],
  };
}

export function propertyItemOut(row: ItemRow): PropertyItemOut {
  return {
    id: row.id,
    personId: row.personId,
    description: row.description,
    category: row.category as PropertyItemOut["category"],
    quantity: row.quantity,
    valuable: isValuable(row),
    photoDocumentIds: row.photoDocumentIds,
    receivedOn: row.receivedOn,
    recordedBy: row.recordedBy,
    acknowledgement: {
      signer: row.ackSigner as PropertyItemOut["acknowledgement"]["signer"],
      name: row.ackName,
      unableReason: row.ackUnableReason,
      signedAt: row.ackSignedAt.toISOString(),
    },
    witnessedBy: row.witnessedBy,
    status: row.status as PropertyItemOut["status"],
    hospitalTransferId: row.hospitalTransferId,
    returned:
      row.status === "returned" && row.returnedOn && row.returnedBy
        ? {
            on: row.returnedOn,
            recipientName: row.returnRecipientName ?? "",
            recipientCapacity: row.returnRecipientCapacity ?? "",
            signer: row.returnSigner ?? "",
            signerName: row.returnSignerName,
            by: row.returnedBy,
            witnessedBy: row.returnWitnessedBy,
          }
        : null,
    disposed:
      row.status === "disposed" &&
      row.disposedOn &&
      row.disposalReason &&
      row.disposedBy &&
      row.disposalWitnessedBy
        ? {
            on: row.disposedOn,
            reason: row.disposalReason,
            by: row.disposedBy,
            witnessedBy: row.disposalWitnessedBy,
          }
        : null,
    lost:
      row.status === "lost" && row.lostOn && row.lossIncidentId
        ? { on: row.lostOn, incidentId: row.lossIncidentId }
        : null,
    version: row.version,
  };
}

function keyOut(row: typeof keyIssue.$inferSelect): KeyIssueOut {
  return {
    id: row.id,
    personId: row.personId,
    label: row.label,
    issuedOn: row.issuedOn,
    issuedTo: row.issuedTo as KeyIssueOut["issuedTo"],
    returnedOn: row.returnedOn,
    reportedLostOn: row.reportedLostOn,
    outstanding: row.returnedOn === null && row.reportedLostOn === null,
    version: row.version,
  };
}

async function propertyList(tx: Transaction, personId: string) {
  const rows = await personProperty(tx, personId);
  const records = rows.map(record);
  return {
    items: rows.map(propertyItemOut),
    outstanding: outstandingProperty(records).map((r) => r.id),
    toSendWithPerson: propertyToSendWithPerson(records).map((r) => r.id),
  };
}

async function itemFor(tx: Transaction, personId: string, itemId: string, version: number) {
  const [row] = await tx.select().from(propertyItem).where(eq(propertyItem.id, itemId));
  if (row?.personId !== personId || row.deletedAt) throw problems.notFound();
  requireVersion(row.version, version);
  return row;
}

function notInFuture(date: string) {
  if (date > ukIsoDate(new Date())) throw problems.invalid("The date cannot be in the future.");
}

export const peoplePropertyRouter = createRouter()
  .openapi(
    createRoute({
      method: "get",
      path: "/v1/people/{id}/property",
      tags: ["people"],
      summary: "The property inventory, with what is still held and what travels to hospital",
      security,
      request: { params: PersonParam },
      responses: {
        200: jsonBody(PropertyList, "Inventory"),
        ...errorResponses,
        ...notFoundResponse,
      },
    }),
    async (c) => {
      const access = await requirePermission(c, "people.person.read");
      const { id } = c.req.valid("param");
      const list = await withTenant(c, async (tx) => {
        await loadPerson(tx, id);
        const result = await propertyList(tx, id);
        await audit(c, tx, access, {
          action: "people.property.list",
          resourceType: "person",
          resourceId: id,
          scope: { count: result.items.length },
        });
        return result;
      });
      return c.json(list, 200);
    },
  )
  .openapi(
    createRoute({
      method: "post",
      path: "/v1/people/{id}/property",
      tags: ["people"],
      summary: "Record an item of property in (rule 7)",
      description:
        "checkPropertyItemIn: described, dated, counted, a category (never cash), acknowledged by the person or their representative or with the reason nobody could sign, and witnessed by a second member of staff for valuables and unsigned items. A device id makes a replayed request return the first copy.",
      security,
      request: {
        params: PersonParam,
        body: { content: { "application/json": { schema: CreatePropertyItem } } },
      },
      responses: {
        201: jsonBody(
          PropertyList.shape.items.element,
          "Recorded (or the earlier copy of a replay)",
        ),
        ...errorResponses,
        ...notFoundResponse,
      },
    }),
    async (c) => {
      const access = await requirePermission(c, "people.property.manage");
      const { id } = c.req.valid("param");
      const body = c.req.valid("json");
      const item = await withTenant(c, async (tx) => {
        if (body.id) {
          const [replayed] = await tx
            .select()
            .from(propertyItem)
            .where(eq(propertyItem.id, body.id));
          if (replayed) {
            if (replayed.personId !== id) throw problems.invalid("That id is already used.");
            return propertyItemOut(replayed);
          }
        }
        const p = await loadPerson(tx, id);
        requireWrite(p, "property_item");
        notInFuture(body.receivedOn);
        const acknowledgement = signature(body.acknowledgement);
        const check = checkPropertyItemIn({
          description: body.description,
          category: body.category,
          quantity: body.quantity,
          valuable: body.valuable,
          photoDocumentIds: body.photoDocumentIds,
          receivedOn: body.receivedOn,
          recordedBy: access.tenantUserId,
          acknowledgement,
          witnessedBy: body.witnessedBy ?? null,
        });
        if (!check.ok) refuse(check.problems);
        if (body.photoDocumentIds.length > 0) {
          const photos = await tx
            .select({ id: document.id, personId: document.personId })
            .from(document)
            .where(inArray(document.id, body.photoDocumentIds));
          if (
            photos.length !== body.photoDocumentIds.length ||
            photos.some((d) => d.personId !== id)
          ) {
            throw problems.invalid("A photo was not found in this person's documents.");
          }
        }
        const [row] = await tx
          .insert(propertyItem)
          .values({
            ...(body.id ? { id: body.id } : {}),
            personId: id,
            description: body.description.trim(),
            category: body.category.trim().toLowerCase(),
            quantity: body.quantity,
            valuable: body.valuable,
            photoDocumentIds: body.photoDocumentIds,
            receivedOn: body.receivedOn,
            recordedBy: access.tenantUserId,
            ackSigner: acknowledgement.signer,
            ackName: acknowledgement.name ?? null,
            ackUnableReason: acknowledgement.unableReason ?? null,
            ackSignedAt: acknowledgement.signedAt,
            witnessedBy: body.witnessedBy ?? null,
          })
          .returning()
          .catch(invalidOnForeignKey("witness"));
        if (!row) throw problems.conflict();
        await audit(c, tx, access, {
          action: "people.property.create",
          resourceType: "property_item",
          resourceId: row.id,
          scope: { valuable: isValuable(row), witnessed: row.witnessedBy !== null },
        });
        return propertyItemOut(row);
      });
      return c.json(item, 201);
    },
  )
  .openapi(
    createRoute({
      method: "post",
      path: "/v1/people/{id}/property/{itemId}/return",
      tags: ["people"],
      summary: "Return an item, with who received it and their signature",
      description:
        "checkPropertyReturn: once only, not before it came in, a named recipient who signs (or the reason they could not), a witness for valuables and unsigned returns, and after a death only to the personal representative.",
      security,
      request: {
        params: ItemParams,
        body: { content: { "application/json": { schema: ReturnPropertyItem } } },
      },
      responses: {
        200: jsonBody(PropertyList.shape.items.element, "Returned"),
        ...errorResponses,
        ...notFoundResponse,
        ...conflictResponse,
      },
    }),
    async (c) => {
      const access = await requirePermission(c, "people.property.manage");
      const { id, itemId } = c.req.valid("param");
      const body = c.req.valid("json");
      const item = await withTenant(c, async (tx) => {
        const p = await loadPerson(tx, id);
        requireWrite(p, "property_return");
        notInFuture(body.returnedOn);
        const row = await itemFor(tx, id, itemId, body.version);
        const sig = signature(body.signature);
        const check = checkPropertyReturn(
          record(row),
          {
            returnedOn: body.returnedOn,
            returnedBy: access.tenantUserId,
            recipientName: body.recipientName,
            recipientCapacity: body.recipientCapacity,
            signature: sig,
            witnessedBy: body.witnessedBy ?? null,
          },
          p.status as PersonStatus,
        );
        if (!check.ok) refuse(check.problems);
        const [updated] = await tx
          .update(propertyItem)
          .set({
            status: "returned",
            hospitalTransferId: null,
            returnedOn: body.returnedOn,
            returnRecipientName: body.recipientName,
            returnRecipientCapacity: body.recipientCapacity,
            returnSigner: sig.signer,
            returnSignerName: sig.name ?? null,
            returnUnableReason: sig.unableReason ?? null,
            returnSignedAt: sig.signedAt,
            returnedBy: access.tenantUserId,
            returnWitnessedBy: body.witnessedBy ?? null,
          })
          .where(and(eq(propertyItem.id, itemId), eq(propertyItem.version, body.version)))
          .returning()
          .catch(invalidOnForeignKey("witness"));
        if (!updated) throw problems.conflict();
        await audit(c, tx, access, {
          action: "people.property.return",
          resourceType: "property_item",
          resourceId: itemId,
          scope: { recipientCapacity: body.recipientCapacity },
        });
        return propertyItemOut(updated);
      });
      return c.json(item, 200);
    },
  )
  .openapi(
    createRoute({
      method: "post",
      path: "/v1/people/{id}/property/{itemId}/dispose",
      tags: ["people"],
      summary: "Record that an item was disposed of, with the reason and a witness",
      security,
      request: {
        params: ItemParams,
        body: { content: { "application/json": { schema: DisposePropertyItem } } },
      },
      responses: {
        200: jsonBody(PropertyList.shape.items.element, "Disposed of"),
        ...errorResponses,
        ...notFoundResponse,
        ...conflictResponse,
      },
    }),
    async (c) => {
      const access = await requirePermission(c, "people.property.manage");
      const { id, itemId } = c.req.valid("param");
      const body = c.req.valid("json");
      const item = await withTenant(c, async (tx) => {
        const p = await loadPerson(tx, id);
        requireWrite(p, "property_return");
        notInFuture(body.on);
        const row = await itemFor(tx, id, itemId, body.version);
        const check = checkPropertyDisposal(record(row), {
          on: body.on,
          by: access.tenantUserId,
          reason: body.reason,
          witnessedBy: body.witnessedBy,
        });
        if (!check.ok) refuse(check.problems);
        const [updated] = await tx
          .update(propertyItem)
          .set({
            status: "disposed",
            disposedOn: body.on,
            disposalReason: body.reason,
            disposedBy: access.tenantUserId,
            disposalWitnessedBy: body.witnessedBy,
          })
          .where(and(eq(propertyItem.id, itemId), eq(propertyItem.version, body.version)))
          .returning()
          .catch(invalidOnForeignKey("witness"));
        if (!updated) throw problems.conflict();
        await audit(c, tx, access, {
          action: "people.property.dispose",
          resourceType: "property_item",
          resourceId: itemId,
          reason: body.reason,
        });
        return propertyItemOut(updated);
      });
      return c.json(item, 200);
    },
  )
  .openapi(
    createRoute({
      method: "post",
      path: "/v1/people/{id}/property/{itemId}/lose",
      tags: ["people"],
      summary: "Record that an item was lost, with the incident raised for it",
      security,
      request: {
        params: ItemParams,
        body: { content: { "application/json": { schema: LosePropertyItem } } },
      },
      responses: {
        200: jsonBody(PropertyList.shape.items.element, "Recorded as lost"),
        ...errorResponses,
        ...notFoundResponse,
        ...conflictResponse,
      },
    }),
    async (c) => {
      const access = await requirePermission(c, "people.property.manage");
      const { id, itemId } = c.req.valid("param");
      const body = c.req.valid("json");
      const item = await withTenant(c, async (tx) => {
        const p = await loadPerson(tx, id);
        requireWrite(p, "property_return");
        notInFuture(body.on);
        const row = await itemFor(tx, id, itemId, body.version);
        const [found] = await tx
          .select({ personIds: incident.personIds })
          .from(incident)
          .where(eq(incident.id, body.incidentId));
        const check = checkPropertyLoss(record(row), {
          on: body.on,
          incidentId: found?.personIds.includes(id) ? body.incidentId : null,
        });
        if (!check.ok) refuse(check.problems);
        const [updated] = await tx
          .update(propertyItem)
          .set({
            status: "lost",
            hospitalTransferId: null,
            lostOn: body.on,
            lossIncidentId: body.incidentId,
          })
          .where(and(eq(propertyItem.id, itemId), eq(propertyItem.version, body.version)))
          .returning();
        if (!updated) throw problems.conflict();
        await audit(c, tx, access, {
          action: "people.property.lose",
          resourceType: "property_item",
          resourceId: itemId,
          scope: { incidentId: body.incidentId },
        });
        return propertyItemOut(updated);
      });
      return c.json(item, 200);
    },
  )
  .openapi(
    createRoute({
      method: "get",
      path: "/v1/people/{id}/keys",
      tags: ["people"],
      summary: "Keys and fobs issued, and which are still out",
      security,
      request: { params: PersonParam },
      responses: { 200: jsonBody(KeyList, "Keys"), ...errorResponses, ...notFoundResponse },
    }),
    async (c) => {
      const access = await requirePermission(c, "people.person.read");
      const { id } = c.req.valid("param");
      const items = await withTenant(c, async (tx) => {
        await loadPerson(tx, id);
        const rows = await personKeys(tx, id);
        await audit(c, tx, access, {
          action: "people.keys.list",
          resourceType: "person",
          resourceId: id,
          scope: {
            count: rows.length,
            outstanding: outstandingKeys(
              rows.map((r) => ({ ...r, issuedTo: r.issuedTo as "person" | "representative" })),
            ).length,
          },
        });
        return rows.map(keyOut);
      });
      return c.json({ items }, 200);
    },
  )
  .openapi(
    createRoute({
      method: "post",
      path: "/v1/people/{id}/keys",
      tags: ["people"],
      summary: "Issue a key or fob",
      security,
      request: {
        params: PersonParam,
        body: { content: { "application/json": { schema: CreateKeyIssue } } },
      },
      responses: {
        201: jsonBody(KeyList.shape.items.element, "Issued (or the earlier copy of a replay)"),
        ...errorResponses,
        ...notFoundResponse,
      },
    }),
    async (c) => {
      const access = await requirePermission(c, "people.property.manage");
      const { id } = c.req.valid("param");
      const body = c.req.valid("json");
      const item = await withTenant(c, async (tx) => {
        if (body.id) {
          const [replayed] = await tx.select().from(keyIssue).where(eq(keyIssue.id, body.id));
          if (replayed) {
            if (replayed.personId !== id) throw problems.invalid("That id is already used.");
            return keyOut(replayed);
          }
        }
        const p = await loadPerson(tx, id);
        requireWrite(p, "key_issue");
        notInFuture(body.issuedOn);
        const [row] = await tx
          .insert(keyIssue)
          .values({
            ...(body.id ? { id: body.id } : {}),
            personId: id,
            label: body.label,
            issuedOn: body.issuedOn,
            issuedTo: body.issuedTo,
          })
          .returning();
        if (!row) throw problems.conflict();
        await audit(c, tx, access, {
          action: "people.key.issue",
          resourceType: "key_issue",
          resourceId: row.id,
        });
        return keyOut(row);
      });
      return c.json(item, 201);
    },
  )
  .openapi(
    createRoute({
      method: "post",
      path: "/v1/people/{id}/keys/{keyId}/return",
      tags: ["people"],
      summary: "Record that a key came back",
      security,
      request: {
        params: KeyParams,
        body: { content: { "application/json": { schema: CloseKeyIssue } } },
      },
      responses: {
        200: jsonBody(KeyList.shape.items.element, "Returned"),
        ...errorResponses,
        ...notFoundResponse,
        ...conflictResponse,
      },
    }),
    async (c) => {
      const access = await requirePermission(c, "people.property.manage");
      const item = await closeKey(c, access, c.req.valid("param"), c.req.valid("json"), "returned");
      return c.json(item, 200);
    },
  )
  .openapi(
    createRoute({
      method: "post",
      path: "/v1/people/{id}/keys/{keyId}/lost",
      tags: ["people"],
      summary: "Record that a key was reported lost",
      security,
      request: {
        params: KeyParams,
        body: { content: { "application/json": { schema: CloseKeyIssue } } },
      },
      responses: {
        200: jsonBody(KeyList.shape.items.element, "Reported lost"),
        ...errorResponses,
        ...notFoundResponse,
        ...conflictResponse,
      },
    }),
    async (c) => {
      const access = await requirePermission(c, "people.property.manage");
      const item = await closeKey(c, access, c.req.valid("param"), c.req.valid("json"), "lost");
      return c.json(item, 200);
    },
  );

async function closeKey(
  c: Context<AppEnv>,
  access: TenantAccess,
  { id, keyId }: { id: string; keyId: string },
  body: CloseKeyIssue,
  how: "returned" | "lost",
): Promise<KeyIssueOut> {
  return withTenant(c, async (tx) => {
    const p = await loadPerson(tx, id);
    requireWrite(p, "key_return");
    notInFuture(body.on);
    const [row] = await tx.select().from(keyIssue).where(eq(keyIssue.id, keyId));
    if (row?.personId !== id || row.deletedAt) throw problems.notFound();
    requireVersion(row.version, body.version);
    if (row.returnedOn || row.reportedLostOn) {
      throw problems.invalid("This key has already been returned or reported lost.");
    }
    if (body.on < row.issuedOn)
      throw problems.invalid("The date cannot be before the key was issued.");
    const [updated] = await tx
      .update(keyIssue)
      .set(how === "returned" ? { returnedOn: body.on } : { reportedLostOn: body.on })
      .where(and(eq(keyIssue.id, keyId), eq(keyIssue.version, body.version)))
      .returning();
    if (!updated) throw problems.conflict();
    await audit(c, tx, access, {
      action: how === "returned" ? "people.key.return" : "people.key.lost",
      resourceType: "key_issue",
      resourceId: keyId,
    });
    return keyOut(updated);
  });
}
