import {
  CompleteReturnCheck,
  CreateHospitalTransfer,
  HandOverTransferPack,
  HospitalTransferList,
  type HospitalTransferOut,
  PreviewTransferPack,
  RecordHospitalReturn,
  TransferPack,
} from "@harbour/contracts";
import {
  document,
  hospitalTransfer,
  propertyItem,
  type Transaction,
  task,
  tenantUser,
} from "@harbour/db";
import {
  checkTransferPackHandover,
  type HospitalTransferPack,
  type TransferPackResult,
} from "@harbour/domain";
import { createRoute, z } from "@hono/zod-openapi";
import { and, desc, eq, inArray, isNull, like } from "drizzle-orm";
import type { Context } from "hono";
import { type AppEnv, requirePermission, type TenantAccess, withTenant } from "../http/context";
import { HttpProblem, problems } from "../http/problem";
import { requireWithinLimit } from "../http/rate-limit";
import { publish } from "../outbox";
import { type ImageObject, pdfImage } from "../services/pdf";
import {
  CLOCK_DRIFT_RATE_KEY,
  loadPerson,
  type PersonRecord,
  requireVersion,
  requireWrite,
  returnCheckTaskKind,
} from "../services/people";
import { rateNumber } from "../services/rates";
import { toJson } from "../services/safety";
import { assemblePackFor, decidePhotoPrintable } from "../services/transfer-pack";
import { renderTransferPackPdf, type StoredPack } from "../services/transfer-pack-pdf";
import {
  conflictResponse,
  createRouter,
  errorResponses,
  jsonBody,
  notFoundResponse,
  security,
} from "./openapi";
import {
  AuditedRefusal,
  audit,
  changeStatus,
  iso,
  PersonParam,
  requireAnyPermission,
  withAuditedRefusal,
} from "./people-shared";

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

type CheckTask = Pick<
  typeof task.$inferSelect,
  "id" | "kind" | "status" | "dueAt" | "completedBy" | "completedAt"
>;

/** The tasks that carry each transfer's return checks (owner role, due time, escalation). */
async function checkTasks(tx: Transaction, transferIds: readonly string[]) {
  if (transferIds.length === 0) return new Map<string, CheckTask[]>();
  const rows = await tx
    .select({
      id: task.id,
      kind: task.kind,
      status: task.status,
      dueAt: task.dueAt,
      completedBy: task.completedBy,
      completedAt: task.completedAt,
      sourceId: task.sourceId,
    })
    .from(task)
    .where(
      and(
        eq(task.sourceType, "hospital_transfer"),
        inArray(task.sourceId, [...transferIds]),
        like(task.kind, "people.return_check.%"),
        isNull(task.deletedAt),
      ),
    );
  const byTransfer = new Map<string, CheckTask[]>();
  for (const row of rows) {
    if (!row.sourceId) continue;
    byTransfer.set(row.sourceId, [...(byTransfer.get(row.sourceId) ?? []), row]);
  }
  return byTransfer;
}

async function transferWithTasks(tx: Transaction, row: TransferRow) {
  return transferOut(row, (await checkTasks(tx, [row.id])).get(row.id) ?? []);
}

function transferOut(row: TransferRow, tasks: readonly CheckTask[] = []): HospitalTransferOut {
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
    returnChecks: Object.entries(checks).map(([key, check]) => {
      const carried = tasks.find((t) => t.kind === returnCheckTaskKind(key));
      const doneByTask = carried?.status === "done";
      return {
        key,
        title: check.title,
        hazardIds: [...check.hazardIds],
        doneBy: check.doneBy ?? (doneByTask ? carried.completedBy : null),
        doneAt: check.doneAt ?? (doneByTask ? iso(carried.completedAt) : null),
        taskId: carried?.id ?? null,
        dueAt: carried ? carried.dueAt.toISOString() : null,
      };
    }),
    version: row.version,
  };
}

/** Checking belongings back in is a movement, not a clinical check. */
const MOVEMENT_RETURN_CHECKS = new Set(["belongings_returned"]);

/** Whether the caller may record a return check: its task's permission, or being its assignee. */
async function mayDoReturnCheck(
  tx: Transaction,
  access: TenantAccess,
  transferId: string,
  checkKey: string,
): Promise<boolean> {
  const held: ReadonlySet<string> = new Set(access.effective.permissions);
  if (MOVEMENT_RETURN_CHECKS.has(checkKey) && held.has("people.movement.record")) return true;
  const [carried] = await tx
    .select({ permission: task.requiredPermission, assignee: task.assigneeTenantUserId })
    .from(task)
    .where(
      and(
        eq(task.sourceType, "hospital_transfer"),
        eq(task.sourceId, transferId),
        eq(task.kind, returnCheckTaskKind(checkKey)),
        isNull(task.deletedAt),
      ),
    )
    .limit(1);
  // With no task, belongings stay with whoever records movements and the rest need the care plan.
  if (!carried) {
    return held.has(
      MOVEMENT_RETURN_CHECKS.has(checkKey) ? "people.movement.record" : "care.plan.write",
    );
  }
  return carried.assignee === access.tenantUserId || held.has(carried.permission);
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

/** Limits the caller, then decides an older photo's printability before any transaction (S2). */
async function beforePack(c: Context<AppEnv>, access: TenantAccess, personId: string) {
  // The pack routes build a snapshot and may print a photo: a per-user limit (S2).
  requireWithinLimit(c.get("services").transferPackLimiter, `${access.tenantUserId}:transfer-pack`);
  await decidePhotoPrintable((fn) => withTenant(c, fn), c.get("services").storage, personId);
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

/** The pack as it would be made now, for the screen (clinical text stays out of the URL). */
async function previewPack(
  c: Context<AppEnv>,
  access: TenantAccess,
  id: string,
  body: PreviewTransferPack,
) {
  await beforePack(c, access, id);
  return withTenant(c, async (tx) => {
    const p = await loadPerson(tx, id);
    await itemsToSend(tx, id, body.sendItemIds);
    const assembled = await packFor(
      tx,
      p,
      access.tenantUserId,
      body.reason ?? null,
      body.sendItemIds,
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
}

const PREVIEW_DESCRIPTION =
  "Never blocked by missing information: missing safety-critical sections are listed and print as 'not recorded', and recorded information that needs checking is listed too. Refused (422) only for a person not receiving care, without a name and date of birth, or with a section that belongs to someone else (HZ-001).";

export const peopleTransfersRouter = createRouter()
  .openapi(
    createRoute({
      method: "get",
      path: "/v1/people/{id}/transfer-pack",
      tags: ["people"],
      summary: "Preview the hospital transfer pack from the record now (HZ-023)",
      description: `${PREVIEW_DESCRIPTION} With no reason or items to send; POST the same path to include them.`,
      security,
      request: { params: PersonParam },
      responses: { 200: jsonBody(TransferPack, "Pack"), ...errorResponses, ...notFoundResponse },
    }),
    async (c) => {
      const access = await requirePermission(c, "people.movement.record");
      const { id } = c.req.valid("param");
      return c.json(await previewPack(c, access, id, { sendItemIds: [] }), 200);
    },
  )
  .openapi(
    createRoute({
      method: "post",
      path: "/v1/people/{id}/transfer-pack",
      tags: ["people"],
      summary: "Preview the hospital transfer pack with the reason and the items to send",
      description: `${PREVIEW_DESCRIPTION} Nothing is stored: the reason is clinical free text, so it travels in the body, never the URL.`,
      security,
      request: {
        params: PersonParam,
        body: { content: { "application/json": { schema: PreviewTransferPack } } },
      },
      responses: { 200: jsonBody(TransferPack, "Pack"), ...errorResponses, ...notFoundResponse },
    }),
    async (c) => {
      const access = await requirePermission(c, "people.movement.record");
      const { id } = c.req.valid("param");
      return c.json(await previewPack(c, access, id, c.req.valid("json")), 200);
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
      // The packs are a disclosure-ready summary of the record: the same permission as making one.
      const access = await requirePermission(c, "people.movement.record");
      const { id } = c.req.valid("param");
      const items = await withTenant(c, async (tx) => {
        await loadPerson(tx, id);
        const rows = await tx
          .select()
          .from(hospitalTransfer)
          .where(and(eq(hospitalTransfer.personId, id), isNull(hospitalTransfer.deletedAt)))
          .orderBy(desc(hospitalTransfer.leftAt));
        const tasks = await checkTasks(
          tx,
          rows.map((r) => r.id),
        );
        await audit(c, tx, access, {
          action: "people.hospital_transfer.list",
          resourceType: "person",
          resourceId: id,
          scope: { count: rows.length },
        });
        return rows.map((r) => transferOut(r, tasks.get(r.id) ?? []));
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
      await beforePack(c, access, id);
      const out = await withTenant(c, async (tx) => {
        if (body.id) {
          const [replayed] = await tx
            .select()
            .from(hospitalTransfer)
            .where(eq(hospitalTransfer.id, body.id));
          if (replayed) {
            if (replayed.personId !== id) throw problems.invalid("That id is already used.");
            await audit(c, tx, access, {
              action: "people.hospital_transfer.view",
              resourceType: "hospital_transfer",
              resourceId: replayed.id,
              scope: { replay: true },
            });
            return transferWithTasks(tx, replayed);
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
      const access = await requirePermission(c, "people.movement.record");
      const { id, transferId } = c.req.valid("param");
      const { storage } = c.get("services");
      requireWithinLimit(
        c.get("services").transferPackLimiter,
        `${access.tenantUserId}:transfer-pack`,
      );
      // Everything from the database in one short transaction; the photo is read and decoded and
      // the PDF drawn after it ends, so no connection is held while the CPU works (S2).
      const read = await withTenant(c, async (tx) => {
        const p = await loadPerson(tx, id);
        const row = await transferFor(tx, id, transferId);
        const pack = row.pack as unknown as StoredPack;
        // JPEG and PNG photos print; anything that cannot be read or drawn is named on page 1.
        const photoId = (pack.content.photo as { documentId?: string } | null)?.documentId;
        let photo: { storageKey: string; contentType: string } | null = null;
        if (photoId) {
          const [doc] = await tx
            .select({
              contentType: document.contentType,
              personId: document.personId,
              storageKey: document.storageKey,
              status: document.status,
              imagePrintable: document.imagePrintable,
            })
            .from(document)
            .where(and(eq(document.id, photoId), isNull(document.deletedAt)));
          // A photo decided as not printable at upload is never decoded.
          if (doc && doc.personId === id && doc.status === "available" && doc.imagePrintable) {
            photo = { storageKey: doc.storageKey, contentType: doc.contentType };
          }
        }
        await audit(c, tx, access, {
          action: "people.transfer_pack.print",
          resourceType: "hospital_transfer",
          resourceId: transferId,
          scope: { recipient: row.hospitalName },
        });
        return {
          pack,
          hospitalName: row.hospitalName,
          locationName: p.locationName,
          names: await staffNames(tx, pack),
          photo,
        };
      });
      let image: ImageObject | null = null;
      if (read.photo) {
        const content = await storage.get(read.photo.storageKey).catch(() => null);
        image = content ? pdfImage({ bytes: content, contentType: read.photo.contentType }) : null;
      }
      const bytes = renderTransferPackPdf({
        pack: read.pack,
        hospitalName: read.hospitalName,
        locationName: read.locationName,
        names: read.names,
        photo: image,
        printedAt: new Date(),
      });
      return c.body(bytes as Uint8Array<ArrayBuffer>, 200, {
        "content-type": "application/pdf",
        "content-disposition": `attachment; filename="transfer-pack-${transferId}.pdf"`,
        "x-content-type-options": "nosniff",
        "cache-control": "private, no-store",
        "content-security-policy": "default-src 'none'; sandbox",
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
            complete: pack.complete,
            attention: pack.attention ?? [],
            missingCritical: row.missingCritical as HospitalTransferPack["missingCritical"],
          },
          acknowledgement,
        );
        if (!check.ok) {
          const listed = [...check.missingCritical, ...check.toAcknowledge];
          throw new HttpProblem(
            422,
            `transfer_pack_${check.problem}`,
            "Some details need checking.",
            `${check.message} To acknowledge: ${listed.join(", ")}.`,
          );
        }
        const needsAck =
          row.missingCritical.length > 0 || (pack.attention ?? []).some((a) => a.acknowledge);
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
        return transferWithTasks(tx, updated);
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
        return transferWithTasks(tx, updated);
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
      const out = await withAuditedRefusal(c, access, () =>
        withTenant(c, async (tx) => {
          await loadPerson(tx, id);
          const row = await transferFor(tx, id, transferId);
          requireVersion(row.version, body.version);
          const checks = { ...((row.returnChecks ?? {}) as Record<string, StoredCheck>) };
          const check = Object.hasOwn(checks, checkKey) ? checks[checkKey] : undefined;
          if (!check) throw problems.notFound();
          if (check.doneAt) throw problems.invalid("This check has already been recorded.");
          // Each check is done only by someone who may complete its task (a clinical check needs
          // care.plan.write, or being its assignee); checking belongings back in stays with
          // whoever records movements (HZ-005, HZ-015, HZ-016).
          if (!(await mayDoReturnCheck(tx, access, transferId, checkKey))) {
            throw new AuditedRefusal(problems.forbidden(), {
              action: "people.hospital_transfer.return_check",
              outcome: "denied",
              resourceType: "hospital_transfer",
              resourceId: transferId,
              reason: "missing_permission",
            });
          }
          checks[checkKey] = { ...check, doneBy: access.tenantUserId, doneAt: now.toISOString() };
          const [updated] = await tx
            .update(hospitalTransfer)
            .set({ returnChecks: checks })
            .where(
              and(eq(hospitalTransfer.id, transferId), eq(hospitalTransfer.version, body.version)),
            )
            .returning();
          if (!updated) throw problems.conflict();
          await tx
            .update(task)
            .set({
              status: "done",
              completedAt: now,
              completedBy: access.tenantUserId,
              evidenceType: "hospital_transfer",
              evidenceId: transferId,
            })
            .where(
              and(
                eq(task.sourceType, "hospital_transfer"),
                eq(task.sourceId, transferId),
                eq(task.kind, returnCheckTaskKind(checkKey)),
                inArray(task.status, ["open", "in_progress"]),
              ),
            );
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
          return transferWithTasks(tx, updated);
        }),
      );
      return c.json(out, 200);
    },
  );
