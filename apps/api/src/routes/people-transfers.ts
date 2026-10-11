import {
  CompleteReturnCheck,
  CreateHospitalTransfer,
  HandOverTransferPack,
  HospitalTransferList,
  type HospitalTransferOut,
  RecordHospitalReturn,
  TransferPack,
} from "@harbour/contracts";
import {
  document,
  hospitalTransfer,
  propertyItem,
  type Transaction,
  tenantUser,
} from "@harbour/db";
import {
  checkTransferPackHandover,
  type HospitalTransferPack,
  type TransferPackResult,
} from "@harbour/domain";
import { createRoute, z } from "@hono/zod-openapi";
import { and, desc, eq, inArray, isNull } from "drizzle-orm";
import { requirePermission, withTenant } from "../http/context";
import { HttpProblem, problems } from "../http/problem";
import { publish } from "../outbox";
import { readDocumentContent } from "../services/documents";
import { jpegSize, type PdfImage } from "../services/pdf";
import {
  CLOCK_DRIFT_RATE_KEY,
  loadPerson,
  type PersonRecord,
  requireVersion,
  requireWrite,
} from "../services/people";
import { rateNumber } from "../services/rates";
import { toJson } from "../services/safety";
import { assemblePackFor } from "../services/transfer-pack";
import { renderTransferPackPdf, type StoredPack } from "../services/transfer-pack-pdf";
import {
  conflictResponse,
  createRouter,
  errorResponses,
  jsonBody,
  notFoundResponse,
  security,
} from "./openapi";
import { audit, changeStatus, iso, PersonParam, requireAnyPermission } from "./people-shared";

/**
 * The hospital transfer pack and the transfer itself (people.md rule 10; HZ-001, HZ-007, HZ-015,
 * HZ-016, HZ-023). The pack is assembled from the record by `assembleHospitalTransferPack` and
 * never blocked for missing information: each missing safety-critical section prints "not
 * recorded" on the first page, and handing over an incomplete pack needs a named acknowledgement
 * with a reason. It is refused only for a person not receiving care, an incomplete identity, or a
 * section belonging to someone else. The pack is a disclosure to the hospital for direct care,
 * audited with its recipient.
 */

const TransferParams = PersonParam.extend({ transferId: z.uuid() });
const CheckParams = TransferParams.extend({ checkKey: z.string().max(80) });

type TransferRow = typeof hospitalTransfer.$inferSelect;

interface StoredCheck {
  readonly title: string;
  readonly hazardIds: readonly string[];
  readonly doneBy: string | null;
  readonly doneAt: string | null;
}

function transferOut(row: TransferRow): HospitalTransferOut {
  const checks = (row.returnChecks ?? {}) as Record<string, StoredCheck>;
  return {
    id: row.id,
    personId: row.personId,
    locationId: row.locationId,
    leftAt: row.leftAt.toISOString(),
    hospitalName: row.hospitalName,
    hospitalOdsCode: row.hospitalOdsCode,
    reason: row.reason,
    pack: row.pack as HospitalTransferOut["pack"],
    missingCritical: row.missingCritical,
    missingExpected: row.missingExpected,
    itemsSent: row.itemsSent,
    handedOverAt: iso(row.handedOverAt),
    handedOverBy: row.handedOverBy,
    acknowledgement:
      row.ackBy && row.ackAt && row.ackReason
        ? { by: row.ackBy, at: row.ackAt.toISOString(), reason: row.ackReason }
        : null,
    returnedAt: iso(row.returnedAt),
    returnChecks: Object.entries(checks).map(([key, check]) => ({
      key,
      title: check.title,
      hazardIds: [...check.hazardIds],
      doneBy: check.doneBy,
      doneAt: check.doneAt,
    })),
    version: row.version,
  };
}

/** A refused pack: 422 with the domain's words and the sections that belong to someone else. */
function refusePack(result: Extract<TransferPackResult, { ok: false }>): never {
  const detail =
    result.sections.length > 0
      ? `${result.message} Sections: ${result.sections.join(", ")}.`
      : result.message;
  throw new HttpProblem(
    422,
    `transfer_pack_${result.problem}`,
    "The transfer pack was not made.",
    detail,
  );
}

async function transferFor(tx: Transaction, personId: string, transferId: string) {
  const [row] = await tx.select().from(hospitalTransfer).where(eq(hospitalTransfer.id, transferId));
  if (row?.personId !== personId || row.deletedAt) throw problems.notFound();
  return row;
}

/** The items to send must be this person's, still held at the home. */
async function itemsToSend(tx: Transaction, personId: string, ids: readonly string[]) {
  if (ids.length === 0) return;
  const rows = await tx
    .select({ id: propertyItem.id, personId: propertyItem.personId, status: propertyItem.status })
    .from(propertyItem)
    .where(inArray(propertyItem.id, [...ids]));
  if (rows.length !== new Set(ids).size || rows.some((r) => r.personId !== personId)) {
    throw problems.invalid("An item to send was not found in this person's property.");
  }
  if (rows.some((r) => r.status !== "held")) {
    throw problems.invalid("Only items still held at the home can be sent with the person.");
  }
}

async function packFor(
  tx: Transaction,
  p: PersonRecord,
  generatedBy: string,
  reason: string | null,
  sendItemIds: readonly string[],
  now: Date,
): Promise<HospitalTransferPack> {
  const result = await assemblePackFor(tx, p, {
    reasonForTransfer: reason,
    sendItemIds,
    generatedBy,
    now,
  });
  if (!result.ok) refusePack(result);
  return result.pack;
}

async function staffNames(tx: Transaction, pack: unknown): Promise<Map<string, string>> {
  const ids = new Set<string>();
  const walk = (value: unknown) => {
    if (Array.isArray(value)) value.forEach(walk);
    else if (value && typeof value === "object") {
      for (const [key, v] of Object.entries(value)) {
        if ((key === "recordedBy" || key === "confirmedBy") && typeof v === "string") ids.add(v);
        else walk(v);
      }
    }
  };
  walk(pack);
  const valid = [...ids].filter((id) => /^[0-9a-f-]{36}$/i.test(id));
  if (valid.length === 0) return new Map();
  const rows = await tx
    .select({ id: tenantUser.id, name: tenantUser.displayName })
    .from(tenantUser)
    .where(inArray(tenantUser.id, valid));
  return new Map(rows.map((r) => [r.id, r.name]));
}

export const peopleTransfersRouter = createRouter()
  .openapi(
    createRoute({
      method: "get",
      path: "/v1/people/{id}/transfer-pack",
      tags: ["people"],
      summary: "Preview the hospital transfer pack from the record now (HZ-023)",
      description:
        "Never blocked by missing information: missing safety-critical sections are listed and print as 'not recorded'. Refused (422) only for a person not receiving care, without a name and date of birth, or with a section that belongs to someone else (HZ-001).",
      security,
      request: {
        params: PersonParam,
        query: z.object({
          reason: z.string().max(2000).optional(),
          sendItemIds: z.string().max(2000).optional(),
        }),
      },
      responses: { 200: jsonBody(TransferPack, "Pack"), ...errorResponses, ...notFoundResponse },
    }),
    async (c) => {
      const access = await requirePermission(c, "people.movement.record");
      const { id } = c.req.valid("param");
      const query = c.req.valid("query");
      const sendItemIds = query.sendItemIds ? query.sendItemIds.split(",").filter(Boolean) : [];
      const pack = await withTenant(c, async (tx) => {
        const p = await loadPerson(tx, id);
        await itemsToSend(tx, id, sendItemIds);
        const assembled = await packFor(
          tx,
          p,
          access.tenantUserId,
          query.reason ?? null,
          sendItemIds,
          new Date(),
        );
        await audit(c, tx, access, {
          action: "people.transfer_pack.preview",
          resourceType: "person",
          resourceId: id,
          scope: { missingCritical: assembled.missingCritical.length },
        });
        return toJson(assembled) as HospitalTransferOut["pack"];
      });
      return c.json(pack, 200);
    },
  )
  .openapi(
    createRoute({
      method: "get",
      path: "/v1/people/{id}/hospital-transfers",
      tags: ["people"],
      summary: "Hospital transfers, newest first, with the pack each one carried",
      security,
      request: { params: PersonParam },
      responses: {
        200: jsonBody(HospitalTransferList, "Transfers"),
        ...errorResponses,
        ...notFoundResponse,
      },
    }),
    async (c) => {
      const access = await requirePermission(c, "people.person.read");
      const { id } = c.req.valid("param");
      const items = await withTenant(c, async (tx) => {
        await loadPerson(tx, id);
        const rows = await tx
          .select()
          .from(hospitalTransfer)
          .where(and(eq(hospitalTransfer.personId, id), isNull(hospitalTransfer.deletedAt)))
          .orderBy(desc(hospitalTransfer.leftAt));
        await audit(c, tx, access, {
          action: "people.hospital_transfer.list",
          resourceType: "person",
          resourceId: id,
          scope: { count: rows.length },
        });
        return rows.map(transferOut);
      });
      return c.json({ items }, 200);
    },
  )
  .openapi(
    createRoute({
      method: "post",
      path: "/v1/people/{id}/hospital-transfers",
      tags: ["people"],
      summary: "Send the person to hospital with the transfer pack (rule 10)",
      description:
        "Assembles the pack from the record and stores what was sent. A person who is active or on leave moves to in hospital through checkPersonStatusChange in the same transaction (rounds pause, the bed is kept). Items sent with the person are marked as away with them. A device id makes a replayed request return the first copy.",
      security,
      request: {
        params: PersonParam,
        body: { content: { "application/json": { schema: CreateHospitalTransfer } } },
      },
      responses: {
        201: jsonBody(HospitalTransferList.shape.items.element, "Sent"),
        ...errorResponses,
        ...notFoundResponse,
        ...conflictResponse,
      },
    }),
    async (c) => {
      const access = await requirePermission(c, "people.movement.record");
      const { id } = c.req.valid("param");
      const body = c.req.valid("json");
      const now = new Date();
      const leftAt = new Date(body.leftAt);
      const out = await withTenant(c, async (tx) => {
        if (body.id) {
          const [replayed] = await tx
            .select()
            .from(hospitalTransfer)
            .where(eq(hospitalTransfer.id, body.id));
          if (replayed) {
            if (replayed.personId !== id) throw problems.invalid("That id is already used.");
            return transferOut(replayed);
          }
        }
        const p = await loadPerson(tx, id, true);
        requireVersion(p.version, body.version);
        requireWrite(p, "hospital_transfer");
        const drift = await rateNumber(tx, access.tenantId, CLOCK_DRIFT_RATE_KEY);
        if (leftAt.getTime() > now.getTime() + drift * 60_000) {
          throw problems.invalid("The time the person left cannot be in the future.");
        }
        await itemsToSend(tx, id, body.sendItemIds);
        const pack = await packFor(
          tx,
          p,
          access.tenantUserId,
          body.reason ?? null,
          body.sendItemIds,
          now,
        );
        if (p.status === "active" || p.status === "on_leave") {
          await changeStatus(
            c,
            tx,
            p,
            { to: "in_hospital", effectiveAt: leftAt, reason: null },
            now,
          );
        }
        const [row] = await tx
          .insert(hospitalTransfer)
          .values({
            ...(body.id ? { id: body.id } : {}),
            personId: id,
            locationId: p.locationId,
            leftAt,
            hospitalName: body.hospitalName,
            hospitalOdsCode: body.hospitalOdsCode ?? null,
            reason: body.reason ?? null,
            pack: toJson(pack) as Record<string, unknown>,
            missingCritical: [...pack.missingCritical],
            missingExpected: [...pack.missingExpected],
            itemsSent: [...body.sendItemIds],
          })
          .returning()
          .catch((error: unknown) => {
            const code =
              (error as { code?: string }).code ??
              (error as { cause?: { code?: string } }).cause?.code;
            if (code === "23505")
              throw problems.invalid("This person is already recorded as in hospital.");
            throw error;
          });
        if (!row) throw problems.conflict();
        if (body.sendItemIds.length > 0) {
          await tx
            .update(propertyItem)
            .set({ status: "sent_with_person", hospitalTransferId: row.id })
            .where(inArray(propertyItem.id, body.sendItemIds));
        }
        await audit(c, tx, access, {
          action: "people.hospital_transfer.create",
          resourceType: "hospital_transfer",
          resourceId: row.id,
          scope: {
            recipient: body.hospitalName,
            odsCode: body.hospitalOdsCode ?? null,
            missingCritical: pack.missingCritical.length,
          },
        });
        return transferOut(row);
      });
      return c.json(out, 201);
    },
  )
  .openapi(
    createRoute({
      method: "get",
      path: "/v1/people/{id}/hospital-transfers/{transferId}/pdf",
      tags: ["people"],
      summary: "The transfer pack as sent, to print (PDF)",
      description:
        "The first page names the person, shows their photo when it is a JPEG, and lists each safety-critical section that is not recorded; every page carries the name, date of birth, NHS number and when the pack was made (HZ-001, HZ-023).",
      security,
      request: { params: TransferParams },
      responses: {
        200: {
          content: { "application/pdf": { schema: z.string().meta({ format: "binary" }) } },
          description: "The pack",
        },
        ...errorResponses,
        ...notFoundResponse,
      },
    }),
    async (c) => {
      const access = await requireAnyPermission(c, [
        "people.movement.record",
        "people.person.read",
      ]);
      const { id, transferId } = c.req.valid("param");
      const { storage } = c.get("services");
      const bytes = await withTenant(c, async (tx) => {
        const p = await loadPerson(tx, id);
        const row = await transferFor(tx, id, transferId);
        const pack = row.pack as unknown as StoredPack;
        let photo: PdfImage | null = null;
        const photoId = (pack.content.photo as { documentId?: string } | null)?.documentId;
        if (photoId) {
          const [doc] = await tx
            .select({ contentType: document.contentType })
            .from(document)
            .where(eq(document.id, photoId));
          if (doc?.contentType === "image/jpeg") {
            const content = await readDocumentContent(tx, storage, photoId).catch(() => null);
            const size = content ? jpegSize(content.bytes) : null;
            if (content && size) photo = { jpeg: content.bytes, ...size };
          }
        }
        await audit(c, tx, access, {
          action: "people.transfer_pack.print",
          resourceType: "hospital_transfer",
          resourceId: transferId,
          scope: { recipient: row.hospitalName },
        });
        return renderTransferPackPdf({
          pack,
          hospitalName: row.hospitalName,
          locationName: p.locationName,
          names: await staffNames(tx, pack),
          photo,
          printedAt: new Date(),
        });
      });
      return c.body(bytes as Uint8Array<ArrayBuffer>, 200, {
        "content-type": "application/pdf",
        "content-disposition": `attachment; filename="transfer-pack-${transferId}.pdf"`,
        "x-content-type-options": "nosniff",
        "cache-control": "private, no-store",
      });
    },
  )
  .openapi(
    createRoute({
      method: "post",
      path: "/v1/people/{id}/hospital-transfers/{transferId}/handover",
      tags: ["people"],
      summary: "Record that the pack went with the person",
      description:
        "checkTransferPackHandover: a pack missing a safety-critical section can still go, but the hand-over is recorded only with the acknowledgement of the person handing it over and the reason (HZ-023). Publishes people.transfer_pack.handed_over.",
      security,
      request: {
        params: TransferParams,
        body: { content: { "application/json": { schema: HandOverTransferPack } } },
      },
      responses: {
        200: jsonBody(HospitalTransferList.shape.items.element, "Handed over"),
        ...errorResponses,
        ...notFoundResponse,
        ...conflictResponse,
      },
    }),
    async (c) => {
      const access = await requirePermission(c, "people.movement.record");
      const { id, transferId } = c.req.valid("param");
      const body = c.req.valid("json");
      const now = new Date();
      const out = await withTenant(c, async (tx) => {
        await loadPerson(tx, id);
        const row = await transferFor(tx, id, transferId);
        requireVersion(row.version, body.version);
        if (row.handedOverAt) throw problems.invalid("The hand-over has already been recorded.");
        const pack = row.pack as unknown as HospitalTransferPack;
        const acknowledgement = body.acknowledgementReason
          ? { by: access.tenantUserId, at: now, reason: body.acknowledgementReason }
          : null;
        const check = checkTransferPackHandover(
          {
            ...pack,
            missingCritical: row.missingCritical as HospitalTransferPack["missingCritical"],
          },
          acknowledgement,
        );
        if (!check.ok) {
          throw new HttpProblem(
            422,
            `transfer_pack_${check.problem}`,
            "Some details need checking.",
            `${check.message} Missing: ${check.missingCritical.join(", ")}.`,
          );
        }
        const needsAck = row.missingCritical.length > 0;
        const [updated] = await tx
          .update(hospitalTransfer)
          .set({
            handedOverAt: now,
            handedOverBy: access.tenantUserId,
            ...(needsAck && acknowledgement
              ? {
                  ackBy: acknowledgement.by,
                  ackAt: acknowledgement.at,
                  ackReason: acknowledgement.reason,
                }
              : {}),
          })
          .where(
            and(eq(hospitalTransfer.id, transferId), eq(hospitalTransfer.version, body.version)),
          )
          .returning();
        if (!updated) throw problems.conflict();
        await audit(c, tx, access, {
          action: "people.transfer_pack.handover",
          resourceType: "hospital_transfer",
          resourceId: transferId,
          reason: needsAck ? body.acknowledgementReason : undefined,
          scope: { recipient: row.hospitalName, incomplete: check.incomplete },
        });
        await publish(tx, {
          context: "people",
          aggregateType: "hospital_transfer",
          aggregateId: transferId,
          type: "people.transfer_pack.handed_over",
          payload: {
            transferId,
            personId: id,
            incomplete: check.incomplete,
            missingCritical: row.missingCritical.length,
          },
        });
        return transferOut(updated);
      });
      return c.json(out, 200);
    },
  )
  .openapi(
    createRoute({
      method: "post",
      path: "/v1/people/{id}/hospital-transfers/{transferId}/return",
      tags: ["people"],
      summary: "Record the person's return from hospital",
      description:
        "Moves the person back to active through checkPersonStatusChange: rounds resume, the return checks are raised (medicines, allergies, resuscitation decisions and IDDSI levels, which hospitals change, skin, and any belongings that went with them), and the return is recorded as a change that brings the care plan review forward (HZ-008).",
      security,
      request: {
        params: TransferParams,
        body: { content: { "application/json": { schema: RecordHospitalReturn } } },
      },
      responses: {
        200: jsonBody(HospitalTransferList.shape.items.element, "Returned"),
        ...errorResponses,
        ...notFoundResponse,
        ...conflictResponse,
      },
    }),
    async (c) => {
      const access = await requirePermission(c, "people.movement.record");
      const { id, transferId } = c.req.valid("param");
      const body = c.req.valid("json");
      const now = new Date();
      const out = await withTenant(c, async (tx) => {
        const p = await loadPerson(tx, id, true);
        const row = await transferFor(tx, id, transferId);
        requireVersion(row.version, body.version);
        if (row.returnedAt) throw problems.invalid("The return has already been recorded.");
        if (p.status !== "in_hospital") {
          throw problems.invalid("The person is not recorded as in hospital.");
        }
        await changeStatus(
          c,
          tx,
          p,
          { to: "active", effectiveAt: new Date(body.returnedAt), reason: null },
          now,
        );
        const updated = await transferFor(tx, id, transferId);
        await audit(c, tx, access, {
          action: "people.hospital_transfer.return",
          resourceType: "hospital_transfer",
          resourceId: transferId,
        });
        return transferOut(updated);
      });
      return c.json(out, 200);
    },
  )
  .openapi(
    createRoute({
      method: "post",
      path: "/v1/people/{id}/hospital-transfers/{transferId}/return-checks/{checkKey}",
      tags: ["people"],
      summary: "Record a check on return from hospital as done",
      description:
        "Checking the belongings back in returns the items that went with the person to the home's keeping.",
      security,
      request: {
        params: CheckParams,
        body: { content: { "application/json": { schema: CompleteReturnCheck } } },
      },
      responses: {
        200: jsonBody(HospitalTransferList.shape.items.element, "Done"),
        ...errorResponses,
        ...notFoundResponse,
        ...conflictResponse,
      },
    }),
    async (c) => {
      const access = await requireAnyPermission(c, ["people.movement.record", "care.plan.write"]);
      const { id, transferId, checkKey } = c.req.valid("param");
      const body = c.req.valid("json");
      const now = new Date();
      const out = await withTenant(c, async (tx) => {
        await loadPerson(tx, id);
        const row = await transferFor(tx, id, transferId);
        requireVersion(row.version, body.version);
        const checks = { ...((row.returnChecks ?? {}) as Record<string, StoredCheck>) };
        const check = checks[checkKey];
        if (!check) throw problems.notFound();
        if (check.doneAt) throw problems.invalid("This check has already been recorded.");
        checks[checkKey] = { ...check, doneBy: access.tenantUserId, doneAt: now.toISOString() };
        const [updated] = await tx
          .update(hospitalTransfer)
          .set({ returnChecks: checks })
          .where(
            and(eq(hospitalTransfer.id, transferId), eq(hospitalTransfer.version, body.version)),
          )
          .returning();
        if (!updated) throw problems.conflict();
        if (checkKey === "belongings_returned") {
          await tx
            .update(propertyItem)
            .set({ status: "held", hospitalTransferId: null })
            .where(
              and(
                eq(propertyItem.hospitalTransferId, transferId),
                eq(propertyItem.status, "sent_with_person"),
              ),
            );
        }
        await audit(c, tx, access, {
          action: "people.hospital_transfer.return_check",
          resourceType: "hospital_transfer",
          resourceId: transferId,
          scope: { check: checkKey },
        });
        return transferOut(updated);
      });
      return c.json(out, 200);
    },
  );
