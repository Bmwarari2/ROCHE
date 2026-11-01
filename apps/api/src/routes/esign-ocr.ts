import { randomUUID } from "node:crypto";
import {
  CloseSignatureRequest,
  DecideOcrField,
  NewSignatureRequest,
  OcrExtractionItem,
  OcrExtractionList,
  OcrExtractionVersion,
  ScannedMedicineLines,
  SignatureRequestItem,
  SignatureRequestList,
  SignatureRequestVersion,
  SignRequest,
} from "@harbour/contracts";
import {
  document,
  documentSignature,
  integrationConnection,
  ocrExtraction,
  ocrField,
  person,
  signatureRequest,
  type Transaction,
  tenantUser,
} from "@harbour/db";
import {
  checkSignature,
  DEFAULT_SIGNATURE_PROVIDER,
  decideField,
  envelopeTransition,
  inAppSignRefusal,
  type OcrField,
  type Permission,
  releaseRefusal,
  SIGNATURE_PORT,
  type SignatureProvider,
  type SignatureRequestState,
  scannedMedicineLines,
  unconfirmedFields,
} from "@harbour/domain";
import { createRoute, z } from "@hono/zod-openapi";
import { and, asc, desc, eq, inArray, isNull } from "drizzle-orm";
import type { Context } from "hono";
import { auditInTx } from "../http/audit";
import {
  type AppEnv,
  permissionsReaching,
  requirePermission,
  stepUpRefusal,
  type TenantAccess,
  withTenant,
} from "../http/context";
import { problems } from "../http/problem";
import { publish } from "../outbox";
import {
  destroyingOnFailure,
  imagePrintableOf,
  readDocumentContent,
  storeDocument,
} from "../services/documents";
import { fileBody } from "./documents";
import { createRouter, errorResponses, jsonBody, notFoundResponse, security } from "./openapi";

/**
 * E-signature requests and OCR of scanned MAR charts (Phase 2 slice 79; INTG-013; ADR-0095;
 * integrations.md section 11).
 *
 * Signing: a member with platform.document.manage asks a named member to sign the current version
 * of an organisation document. In Harbour (the default) only that member signs, with a fresh
 * second factor, against the exact bytes asked for; the typed-name signature row and the evidence
 * are written together. Through DocuSign (only when the organisation chose it and the adapter is
 * on), the envelope carries the document and the signer's work email; the signed copy returned is
 * stored as a new version after a malware scan, and only a clean copy marks the request signed.
 *
 * OCR: a member with medicines.record.manage reaching the person stores a photographed MAR chart as
 * the person's document (scan, retention class); only a clean image is read, by the configured
 * engine on the allowlist. Every value is unconfirmed until a person confirms, corrects or rejects
 * it; release needs every value decided and emits integrations.ocr_mar_released for the medicines
 * module, whose lines arrive "not yet checked" and need a second check (HZ-005, H-548).
 */

type Tx = Transaction;
type RequestRow = typeof signatureRequest.$inferSelect;
type ExtractionRow = typeof ocrExtraction.$inferSelect;
type FieldRow = typeof ocrField.$inferSelect;

const DOCUMENT_MANAGE: Permission = "platform.document.manage";
const MEDICINES: Permission = "medicines.record.manage";
const sigTags = ["platform"];
const ocrTags = ["integrations"];
const IdParam = z.object({ id: z.uuid() });
const FieldParam = z.object({ id: z.uuid(), fieldId: z.uuid() });
/** A generic subject: no personal data leaves in an envelope's subject. */
const ENVELOPE_SUBJECT = "A document to sign";
const OPEN: readonly SignatureRequestState[] = ["requested", "sent"];

// ---- Signature requests -----------------------------------------------------------------------

async function requestItems(tx: Tx, rows: readonly RequestRow[]) {
  const people = [...new Set(rows.map((r) => r.signerTenantUserId))];
  const docs = [...new Set(rows.map((r) => r.documentId))];
  const names = people.length
    ? await tx
        .select({ id: tenantUser.id, name: tenantUser.displayName })
        .from(tenantUser)
        .where(inArray(tenantUser.id, people))
    : [];
  const titles = docs.length
    ? await tx
        .select({ id: document.id, title: document.title })
        .from(document)
        .where(inArray(document.id, docs))
    : [];
  return rows.map((r) => ({
    id: r.id,
    version: r.version,
    documentId: r.documentId,
    documentTitle: titles.find((d) => d.id === r.documentId)?.title ?? null,
    documentSha256: r.documentSha256,
    signer: {
      id: r.signerTenantUserId,
      displayName: names.find((n) => n.id === r.signerTenantUserId)?.name ?? null,
    },
    provider: r.provider as SignatureProvider,
    state: r.state as SignatureRequestState,
    requestedBy: r.requestedBy,
    requestedAt: r.createdAt.toISOString(),
    signedAt: r.signedAt?.toISOString() ?? null,
    signatureId: r.signatureId,
    signedDocumentId: r.signedDocumentId,
    closedReason: r.closedReason,
  }));
}

async function findRequest(tx: Tx, id: string): Promise<RequestRow> {
  const [row] = await tx
    .select()
    .from(signatureRequest)
    .where(and(eq(signatureRequest.id, id), isNull(signatureRequest.deletedAt)));
  if (!row) throw problems.notFound();
  return row;
}

async function organisationDocument(tx: Tx, id: string) {
  const [row] = await tx
    .select()
    .from(document)
    .where(and(eq(document.id, id), isNull(document.deletedAt)));
  // Only an organisation's own document is asked for: a person's signs through the typed flow.
  if (!row || row.personId !== null || row.status !== "available") throw problems.notFound();
  return row;
}

/** The organisation's chosen signature provider: in Harbour unless it chose DocuSign. */
async function providerOf(tx: Tx): Promise<SignatureProvider> {
  const [connection] = await tx
    .select({ provider: integrationConnection.provider })
    .from(integrationConnection)
    .where(eq(integrationConnection.port, SIGNATURE_PORT));
  return connection?.provider === "docusign" ? "docusign" : DEFAULT_SIGNATURE_PROVIDER;
}

/** Moves a request on with an expected version; a stale version is a conflict. */
async function moveRequest(
  tx: Tx,
  row: RequestRow,
  expected: number,
  set: Partial<typeof signatureRequest.$inferInsert>,
): Promise<RequestRow> {
  const [saved] = await tx
    .update(signatureRequest)
    .set({ ...set, version: row.version + 1 })
    .where(and(eq(signatureRequest.id, row.id), eq(signatureRequest.version, expected)))
    .returning();
  if (!saved)
    throw problems.conflict("Someone else changed this request. Reload it and try again.");
  return saved;
}

function audit(
  c: Context<AppEnv>,
  tx: Tx,
  access: TenantAccess,
  input: Parameters<typeof auditInTx>[2],
) {
  return auditInTx(tx, access, { ...input, requestId: c.get("requestId") });
}

/** Sends a DocuSign envelope for a request just made, outside its transaction. */
async function sendEnvelope(c: Context<AppEnv>, access: TenantAccess, row: RequestRow) {
  const docusign = c.get("services").docusign;
  if (!docusign) throw problems.featureDisabled("DocuSign is not available.");
  const { storage } = c.get("services");
  const prepared = await withTenant(c, async (tx) => {
    const { row: doc, bytes } = await readDocumentContent(tx, storage, row.documentId);
    const [signer] = await tx
      .select({ name: tenantUser.displayName, email: tenantUser.email })
      .from(tenantUser)
      .where(eq(tenantUser.id, row.signerTenantUserId));
    return { doc, bytes, signer };
  });
  const result = await docusign.send({
    idempotencyKey: row.id,
    subject: ENVELOPE_SUBJECT,
    document: { bytes: prepared.bytes, contentType: prepared.doc.contentType },
    documentSha256: row.documentSha256,
    signer: { name: prepared.signer?.name ?? "", email: prepared.signer?.email ?? "" },
  });
  return withTenant(c, async (tx) => {
    const current = await findRequest(tx, row.id);
    const saved = await moveRequest(
      tx,
      current,
      current.version,
      result.ok
        ? { state: "sent", envelopeId: result.envelopeId }
        : { state: "failed", closedReason: "The provider refused the envelope." },
    );
    await audit(c, tx, access, {
      action: result.ok ? "platform.signature.sent" : "platform.signature.failed",
      outcome: result.ok ? "success" : "error",
      resourceType: "signature_request",
      resourceId: row.id,
      after: { provider: "docusign", state: saved.state },
    });
    return saved;
  });
}

export const esignOcrRouter = createRouter()
  .openapi(
    createRoute({
      method: "post",
      path: "/v1/documents/{id}/signature-requests",
      tags: sigTags,
      summary: "Ask a member to sign an organisation document",
      description:
        "platform.document.manage. The current version only (its SHA-256 must match). In Harbour unless the organisation chose DocuSign and it is on, when an envelope is sent with the document and the signer's work email.",
      security,
      request: {
        params: IdParam,
        body: { content: { "application/json": { schema: NewSignatureRequest } } },
      },
      responses: {
        201: jsonBody(SignatureRequestItem, "Requested"),
        ...errorResponses,
        ...notFoundResponse,
      },
    }),
    async (c) => {
      const access = await requirePermission(c, DOCUMENT_MANAGE);
      const { id } = c.req.valid("param");
      const body = c.req.valid("json");
      const made = await withTenant(c, async (tx) => {
        const doc = await organisationDocument(tx, id);
        if (doc.sha256.toLowerCase() !== body.documentSha256.toLowerCase()) {
          throw problems.conflict(
            "The document has changed since you opened it. Ask for the new version.",
          );
        }
        const [signer] = await tx
          .select({ id: tenantUser.id, status: tenantUser.status })
          .from(tenantUser)
          .where(eq(tenantUser.id, body.signerId));
        if (signer?.status !== "active") throw problems.invalid("Choose an active member to sign.");
        const provider = await providerOf(tx);
        if (provider === "docusign" && !c.get("services").docusign) {
          throw problems.featureDisabled("DocuSign is not available.");
        }
        const [row] = await tx
          .insert(signatureRequest)
          .values({
            documentId: id,
            documentSha256: doc.sha256.toLowerCase(),
            signerTenantUserId: body.signerId,
            provider,
            requestedBy: access.tenantUserId,
          })
          .returning();
        if (!row) throw new Error("signature request was not created");
        await audit(c, tx, access, {
          action: "platform.signature.requested",
          resourceType: "signature_request",
          resourceId: row.id,
          after: { documentId: id, provider, signerId: body.signerId },
        });
        return row;
      });
      const row = made.provider === "docusign" ? await sendEnvelope(c, access, made) : made;
      const [item] = await withTenant(c, (tx) => requestItems(tx, [row]));
      return c.json(item as z.infer<typeof SignatureRequestItem>, 201);
    },
  )
  .openapi(
    createRoute({
      method: "get",
      path: "/v1/documents/{id}/signature-requests",
      tags: sigTags,
      summary: "The signature requests for an organisation document",
      description: "platform.document.manage. Newest first.",
      security,
      request: { params: IdParam },
      responses: {
        200: jsonBody(SignatureRequestList, "Requests"),
        ...errorResponses,
        ...notFoundResponse,
      },
    }),
    async (c) => {
      await requirePermission(c, DOCUMENT_MANAGE);
      const { id } = c.req.valid("param");
      const items = await withTenant(c, async (tx) => {
        await organisationDocument(tx, id);
        const rows = await tx
          .select()
          .from(signatureRequest)
          .where(and(eq(signatureRequest.documentId, id), isNull(signatureRequest.deletedAt)))
          .orderBy(desc(signatureRequest.createdAt));
        return requestItems(tx, rows);
      });
      return c.json({ items }, 200);
    },
  )
  .openapi(
    createRoute({
      method: "get",
      path: "/v1/me/signature-requests",
      tags: sigTags,
      summary: "The documents I am asked to sign",
      description: "Any member: requests naming them, open ones first, then the last 50 others.",
      security,
      responses: { 200: jsonBody(SignatureRequestList, "Requests"), ...errorResponses },
    }),
    async (c) => {
      const access = c.get("access");
      const items = await withTenant(c, async (tx) => {
        const rows = await tx
          .select()
          .from(signatureRequest)
          .where(
            and(
              eq(signatureRequest.signerTenantUserId, access.tenantUserId),
              isNull(signatureRequest.deletedAt),
            ),
          )
          .orderBy(desc(signatureRequest.createdAt))
          .limit(200);
        const open = rows.filter((r) => OPEN.includes(r.state as SignatureRequestState));
        const closed = rows.filter((r) => !OPEN.includes(r.state as SignatureRequestState));
        return requestItems(tx, [...open, ...closed.slice(0, 50)]);
      });
      return c.json({ items }, 200);
    },
  )
  .openapi(
    createRoute({
      method: "post",
      path: "/v1/signature-requests/{id}/sign",
      tags: sigTags,
      summary: "Sign in Harbour, as the member asked",
      description:
        "Only the member named, only an open in-Harbour request, only the exact version asked for (its SHA-256 as read), and only with a second factor used within the step-up window. Writes the typed-name signature and the evidence together.",
      security,
      request: {
        params: IdParam,
        body: { content: { "application/json": { schema: SignRequest } } },
      },
      responses: {
        200: jsonBody(SignatureRequestItem, "Signed"),
        ...errorResponses,
        ...notFoundResponse,
      },
    }),
    async (c) => {
      const access = c.get("access");
      const { id } = c.req.valid("param");
      const body = c.req.valid("json");
      const item = await withTenant(c, async (tx) => {
        const row = await findRequest(tx, id);
        const [doc] = await tx
          .select()
          .from(document)
          .where(and(eq(document.id, row.documentId), isNull(document.deletedAt)));
        const refusal = inAppSignRefusal({
          provider: row.provider as SignatureProvider,
          state: row.state as SignatureRequestState,
          signerId: row.signerTenantUserId,
          memberId: access.tenantUserId,
          stepUpFresh: access.stepUpFresh,
          requestSha256: row.documentSha256,
          currentSha256: doc?.status === "available" ? doc.sha256 : "",
          sha256Seen: body.sha256Seen,
        });
        // Someone else's request is not theirs to know about.
        if (refusal === "not_the_signer") throw problems.notFound();
        if (refusal === "step_up_required") throw stepUpRefusal(access);
        if (refusal === "document_changed") {
          throw problems.conflict(
            "The document has changed since you were asked. Ask for the new version to be sent.",
          );
        }
        if (refusal !== null) throw problems.conflict("This request is not open for signing here.");
        const check = checkSignature({
          typedName: body.typedName,
          statement: body.statement ?? null,
          sha256Seen: body.sha256Seen,
          currentSha256: row.documentSha256,
        });
        if (!check.ok) throw problems.invalid(check.message);
        const [signature] = await tx
          .insert(documentSignature)
          .values({
            documentId: row.documentId,
            personId: null,
            signerTenantUserId: access.tenantUserId,
            signerName: check.signerName,
            signerCapacity: "staff",
            statement: check.statement,
            documentSha256: row.documentSha256,
          })
          .returning({ id: documentSignature.id, at: documentSignature.signedAt });
        if (!signature) throw new Error("signature was not recorded");
        const saved = await moveRequest(tx, row, body.version, {
          state: "signed",
          signatureId: signature.id,
          signedAt: signature.at,
          // The session's second factor was fresh (checked above); which one is not kept.
          stepUpMethod: "second_factor",
        });
        await audit(c, tx, access, {
          action: "platform.signature.signed",
          resourceType: "signature_request",
          resourceId: row.id,
          after: { documentId: row.documentId, sha256: row.documentSha256, stepUp: true },
        });
        return (await requestItems(tx, [saved]))[0];
      });
      return c.json(item as z.infer<typeof SignatureRequestItem>, 200);
    },
  )
  .openapi(
    createRoute({
      method: "post",
      path: "/v1/signature-requests/{id}/cancel",
      tags: sigTags,
      summary: "Cancel an open signature request, with a reason",
      description: "platform.document.manage. A DocuSign envelope is voided too.",
      security,
      request: {
        params: IdParam,
        body: { content: { "application/json": { schema: CloseSignatureRequest } } },
      },
      responses: {
        200: jsonBody(SignatureRequestItem, "Cancelled"),
        ...errorResponses,
        ...notFoundResponse,
      },
    }),
    async (c) => {
      const access = await requirePermission(c, DOCUMENT_MANAGE);
      const { id } = c.req.valid("param");
      const body = c.req.valid("json");
      const row = await withTenant(c, (tx) => findRequest(tx, id));
      if (!OPEN.includes(row.state as SignatureRequestState)) {
        throw problems.conflict("This request is already closed.");
      }
      if (row.provider === "docusign" && row.envelopeId) {
        await c.get("services").docusign?.void(row.envelopeId, body.reason);
      }
      const item = await withTenant(c, async (tx) => {
        const current = await findRequest(tx, id);
        const saved = await moveRequest(tx, current, body.version, {
          state: "cancelled",
          closedReason: body.reason,
        });
        await audit(c, tx, access, {
          action: "platform.signature.cancelled",
          resourceType: "signature_request",
          resourceId: id,
          after: { state: "cancelled" },
        });
        return (await requestItems(tx, [saved]))[0];
      });
      return c.json(item as z.infer<typeof SignatureRequestItem>, 200);
    },
  )
  .openapi(
    createRoute({
      method: "post",
      path: "/v1/signature-requests/{id}/refresh",
      tags: sigTags,
      summary: "Ask DocuSign where a request stands",
      description:
        "platform.document.manage, DocuSign requests only. A completed envelope's signed copy is stored as a new version of the document after a malware scan; only a clean copy marks the request signed, otherwise it stays sent and the copy quarantined.",
      security,
      request: {
        params: IdParam,
        body: { content: { "application/json": { schema: SignatureRequestVersion } } },
      },
      responses: {
        200: jsonBody(SignatureRequestItem, "Where it stands"),
        ...errorResponses,
        ...notFoundResponse,
      },
    }),
    async (c) => {
      const access = await requirePermission(c, DOCUMENT_MANAGE);
      const { id } = c.req.valid("param");
      const body = c.req.valid("json");
      const docusign = c.get("services").docusign;
      const row = await withTenant(c, (tx) => findRequest(tx, id));
      if (row.provider !== "docusign" || !row.envelopeId) {
        throw problems.conflict("Only a DocuSign request is refreshed.");
      }
      if (!docusign) throw problems.featureDisabled("DocuSign is not available.");
      const status = await docusign.status(row.envelopeId);
      if (!status) throw problems.conflict("DocuSign does not know this envelope.");
      const { storage, scanner } = c.get("services");
      const item = await destroyingOnFailure(storage, (writing) =>
        withTenant(c, async (tx) => {
          const current = await findRequest(tx, id);
          if (current.version !== body.version) {
            throw problems.conflict("Someone else changed this request. Reload it and try again.");
          }
          let scan: "clean" | "infected" | "unavailable" | null = null;
          let signedDocumentId: string | null = null;
          if (status.state === "completed" && current.state === "sent") {
            const [original] = await tx
              .select()
              .from(document)
              .where(eq(document.id, current.documentId));
            if (!original) throw problems.notFound();
            try {
              const stored = await storeDocument(
                tx,
                { storage: writing, scanner },
                access.tenantId,
                {
                  bytes: status.signed.bytes,
                  declaredType: status.signed.contentType,
                  category: "organisation_document",
                  title: original.title,
                  fileName: original.fileName,
                  previous: original,
                },
              );
              scan = stored.scanStatus as "clean" | "unavailable";
              signedDocumentId = stored.id;
            } catch {
              // An infected or refused copy is never stored; the request stays sent.
              scan = "infected";
            }
          }
          const next = envelopeTransition(
            current.state as SignatureRequestState,
            status.state,
            scan,
          );
          const saved =
            next === null
              ? current
              : await moveRequest(tx, current, body.version, {
                  state: next,
                  ...(next === "signed"
                    ? {
                        signedDocumentId,
                        signedAt: status.state === "completed" ? status.completedAt : new Date(),
                      }
                    : { closedReason: `DocuSign: ${status.state}` }),
                });
          await audit(c, tx, access, {
            action: "platform.signature.refreshed",
            resourceType: "signature_request",
            resourceId: id,
            after: { provider: status.state, state: saved.state, scan },
          });
          return (await requestItems(tx, [saved]))[0];
        }),
      );
      return c.json(item as z.infer<typeof SignatureRequestItem>, 200);
    },
  )
  // ---- OCR of scanned MAR charts ---------------------------------------------------------------
  .openapi(
    createRoute({
      method: "post",
      path: "/v1/people/{id}/mar-scans",
      tags: ocrTags,
      summary: "Scan a paper MAR chart (the body is the photograph)",
      description:
        "medicines.record.manage where it reaches the person. The photograph is stored as the person's document (malware scan, care record retention); only a clean image is read, by the configured OCR engine on the allowlist (europe-west2). Every value comes back unconfirmed (HZ-005).",
      security,
      request: { params: IdParam, body: fileBody },
      responses: {
        201: jsonBody(OcrExtractionItem, "Scanned"),
        ...errorResponses,
        ...notFoundResponse,
      },
    }),
    async (c) => {
      const access = await requirePermission(c, MEDICINES);
      const { id: personId } = c.req.valid("param");
      const ocr = c.get("services").ocr;
      if (!ocr) throw problems.featureDisabled("Scanning paper MAR charts is not available.");
      const bytes = new Uint8Array(await c.req.arrayBuffer());
      const imagePrintable = imagePrintableOf(bytes);
      const { storage, scanner } = c.get("services");
      const stored = await destroyingOnFailure(storage, (writing) =>
        withTenant(c, async (tx) => {
          await personReached(tx, access, personId);
          const doc = await storeDocument(tx, { storage: writing, scanner }, access.tenantId, {
            bytes,
            imagePrintable,
            declaredType: c.req.header("content-type") ?? null,
            category: "person_document",
            title: "Scanned MAR chart",
            personId,
            subjectType: "person",
            subjectId: personId,
          });
          if (doc.status === "available") return { doc, blocked: null };
          // Not clean: never read. The extraction says so, and nothing else happens.
          const [blocked] = await tx
            .insert(ocrExtraction)
            .values({
              personId,
              documentId: doc.id,
              engine: ocr.engine,
              location: ocr.location,
              state: "blocked",
              failure: "not_clean",
              requestedBy: access.tenantUserId,
            })
            .returning();
          await audit(c, tx, access, {
            action: "integrations.ocr.blocked",
            resourceType: "ocr_extraction",
            resourceId: blocked?.id,
            after: { personId, documentId: doc.id },
          });
          return { doc, blocked: blocked ?? null };
        }),
      );
      if (stored.blocked) {
        const item = await withTenant(c, (tx) =>
          extractionItem(tx, stored.blocked as ExtractionRow),
        );
        return c.json(item, 201);
      }
      const extractionId = randomUUID();
      const read = await ocr.read({
        idempotencyKey: extractionId,
        kind: "mar",
        image: { bytes, contentType: stored.doc.contentType },
      });
      const item = await withTenant(c, async (tx) => {
        await personReached(tx, access, personId);
        const fields = read.ok ? unconfirmedFields(read.fields, () => randomUUID()) : [];
        const failure = !read.ok ? "engine_error" : fields.length === 0 ? "nothing_read" : null;
        const [row] = await tx
          .insert(ocrExtraction)
          .values({
            id: extractionId,
            personId,
            documentId: stored.doc.id,
            engine: ocr.engine,
            location: ocr.location,
            state: failure ? "failed" : "ready",
            failure,
            requestedBy: access.tenantUserId,
          })
          .returning();
        if (!row) throw new Error("extraction was not created");
        if (fields.length > 0 && !failure) {
          await tx.insert(ocrField).values(
            fields.map((f, position) => ({
              id: f.id,
              extractionId,
              personId,
              position,
              lineGroup: Math.max(0, Math.min(999, Math.trunc(f.group))),
              label: f.label,
              readText: f.text,
              confidence: f.confidence.toFixed(3),
            })),
          );
        }
        await audit(c, tx, access, {
          action: "integrations.ocr.read",
          outcome: failure ? "error" : "success",
          resourceType: "ocr_extraction",
          resourceId: extractionId,
          after: { personId, documentId: stored.doc.id, fields: fields.length, failure },
        });
        return extractionItem(tx, row);
      });
      return c.json(item, 201);
    },
  )
  .openapi(
    createRoute({
      method: "get",
      path: "/v1/people/{id}/ocr-extractions",
      tags: ocrTags,
      summary: "A person's scanned MAR charts",
      description: "medicines.record.manage where it reaches the person. Newest first.",
      security,
      request: { params: IdParam },
      responses: {
        200: jsonBody(OcrExtractionList, "Scans"),
        ...errorResponses,
        ...notFoundResponse,
      },
    }),
    async (c) => {
      const access = await requirePermission(c, MEDICINES);
      const { id: personId } = c.req.valid("param");
      const items = await withTenant(c, async (tx) => {
        await personReached(tx, access, personId);
        const rows = await tx
          .select()
          .from(ocrExtraction)
          .where(and(eq(ocrExtraction.personId, personId), isNull(ocrExtraction.deletedAt)))
          .orderBy(desc(ocrExtraction.createdAt))
          .limit(100);
        const out = [];
        for (const r of rows) {
          const { fields: _fields, ...rest } = await extractionItem(tx, r);
          out.push(rest);
        }
        return out;
      });
      return c.json({ items }, 200);
    },
  )
  .openapi(
    createRoute({
      method: "get",
      path: "/v1/ocr-extractions/{id}",
      tags: ocrTags,
      summary: "A scanned chart with each value as read and as decided",
      description: "medicines.record.manage where it reaches the person. The view is audited.",
      security,
      request: { params: IdParam },
      responses: {
        200: jsonBody(OcrExtractionItem, "The scan"),
        ...errorResponses,
        ...notFoundResponse,
      },
    }),
    async (c) => {
      const access = await requirePermission(c, MEDICINES);
      const { id } = c.req.valid("param");
      const item = await withTenant(c, async (tx) => {
        const row = await findExtraction(tx, access, id);
        await audit(c, tx, access, {
          action: "integrations.ocr.viewed",
          resourceType: "ocr_extraction",
          resourceId: id,
        });
        return extractionItem(tx, row);
      });
      return c.json(item, 200);
    },
  )
  .openapi(
    createRoute({
      method: "post",
      path: "/v1/ocr-extractions/{id}/fields/{fieldId}/decision",
      tags: ocrTags,
      summary: "Confirm, correct or reject one value read",
      description:
        "medicines.record.manage where it reaches the person. Once decided a value does not change; a scan still being decided only (HZ-005).",
      security,
      request: {
        params: FieldParam,
        body: { content: { "application/json": { schema: DecideOcrField } } },
      },
      responses: {
        200: jsonBody(OcrExtractionItem, "Decided"),
        ...errorResponses,
        ...notFoundResponse,
      },
    }),
    async (c) => {
      const access = await requirePermission(c, MEDICINES);
      const { id, fieldId } = c.req.valid("param");
      const body = c.req.valid("json");
      const item = await withTenant(c, async (tx) => {
        const extraction = await findExtraction(tx, access, id);
        if (extraction.state !== "ready")
          throw problems.conflict("This scan is not being checked.");
        const [row] = await tx
          .select()
          .from(ocrField)
          .where(and(eq(ocrField.id, fieldId), eq(ocrField.extractionId, id)));
        if (!row) throw problems.notFound();
        if (row.version !== body.version) {
          throw problems.conflict("Someone else changed this value. Reload the scan.");
        }
        const now = new Date();
        const decided = decideField(
          fieldOf(row),
          body.action === "correct"
            ? { action: "correct", value: body.value }
            : { action: body.action },
          access.tenantUserId,
          now,
        );
        if (!decided.ok) {
          throw decided.problem === "already_decided"
            ? problems.conflict("This value has already been decided.")
            : problems.invalid(
                decided.problem === "unchanged"
                  ? "The correction is the same as the text read: confirm it instead."
                  : "Type the value as it should read.",
              );
        }
        const [saved] = await tx
          .update(ocrField)
          .set({
            state: decided.field.state,
            value: decided.field.value,
            decidedBy: access.tenantUserId,
            decidedAt: now,
            version: row.version + 1,
          })
          .where(and(eq(ocrField.id, fieldId), eq(ocrField.version, body.version)))
          .returning({ id: ocrField.id });
        if (!saved) throw problems.conflict("Someone else changed this value. Reload the scan.");
        // The value itself is health data: the audit names the field and the decision only.
        await audit(c, tx, access, {
          action: "integrations.ocr.decided",
          resourceType: "ocr_field",
          resourceId: fieldId,
          after: { extractionId: id, state: decided.field.state },
        });
        return extractionItem(tx, extraction);
      });
      return c.json(item, 200);
    },
  )
  .openapi(
    createRoute({
      method: "post",
      path: "/v1/ocr-extractions/{id}/release",
      tags: ocrTags,
      summary: "Release a fully decided scan to the medicines module",
      description:
        "medicines.record.manage where it reaches the person. Only when every value is decided and at least one stands. Emits integrations.ocr_mar_released (ids only); the medicines module reads the lines, which arrive not yet checked and need a second check (HZ-005, H-548).",
      security,
      request: {
        params: IdParam,
        body: { content: { "application/json": { schema: OcrExtractionVersion } } },
      },
      responses: {
        200: jsonBody(OcrExtractionItem, "Released"),
        ...errorResponses,
        ...notFoundResponse,
      },
    }),
    async (c) => {
      const access = await requirePermission(c, MEDICINES);
      const { id } = c.req.valid("param");
      const body = c.req.valid("json");
      const item = await withTenant(c, async (tx) => {
        const row = await findExtraction(tx, access, id);
        if (row.state !== "ready") throw problems.conflict("This scan is not being checked.");
        const fields = (await fieldsOf(tx, id)).map(fieldOf);
        const refusal = releaseRefusal(fields);
        if (refusal === "undecided_fields") {
          throw problems.conflict("Decide every value before releasing the scan.");
        }
        if (refusal === "nothing_confirmed") {
          throw problems.conflict("Every value was rejected: discard the scan instead.");
        }
        const saved = await moveExtraction(tx, row, body.version, {
          state: "released",
          releasedBy: access.tenantUserId,
          releasedAt: new Date(),
        });
        const lines = scannedMedicineLines(fields);
        await publish(tx, {
          context: "integrations",
          aggregateType: "ocr_extraction",
          aggregateId: id,
          type: "integrations.ocr_mar_released",
          payload: { extractionId: id, personId: row.personId, lines: lines.length },
        });
        await audit(c, tx, access, {
          action: "integrations.ocr.released",
          resourceType: "ocr_extraction",
          resourceId: id,
          after: { personId: row.personId, lines: lines.length },
        });
        return extractionItem(tx, saved);
      });
      return c.json(item, 200);
    },
  )
  .openapi(
    createRoute({
      method: "post",
      path: "/v1/ocr-extractions/{id}/discard",
      tags: ocrTags,
      summary: "Discard a scan: nothing it read is used",
      description:
        "medicines.record.manage where it reaches the person. The image stays the person's document.",
      security,
      request: {
        params: IdParam,
        body: { content: { "application/json": { schema: OcrExtractionVersion } } },
      },
      responses: {
        200: jsonBody(OcrExtractionItem, "Discarded"),
        ...errorResponses,
        ...notFoundResponse,
      },
    }),
    async (c) => {
      const access = await requirePermission(c, MEDICINES);
      const { id } = c.req.valid("param");
      const body = c.req.valid("json");
      const item = await withTenant(c, async (tx) => {
        const row = await findExtraction(tx, access, id);
        if (row.state === "released" || row.state === "discarded") {
          throw problems.conflict("This scan is already finished.");
        }
        const saved = await moveExtraction(tx, row, body.version, {
          state: "discarded",
          discardedBy: access.tenantUserId,
          discardedAt: new Date(),
          failure: null,
        });
        await audit(c, tx, access, {
          action: "integrations.ocr.discarded",
          resourceType: "ocr_extraction",
          resourceId: id,
        });
        return extractionItem(tx, saved);
      });
      return c.json(item, 200);
    },
  )
  .openapi(
    createRoute({
      method: "get",
      path: "/v1/ocr-extractions/{id}/medicine-lines",
      tags: ocrTags,
      summary: "A released scan's medicine lines, for the medicines module",
      description:
        "medicines.record.manage where it reaches the person. Released scans only; confirmed and corrected values only, each line not yet checked with a second check required. Never a dm+d product, dose unit or schedule: the transcriber chooses those (slice 51).",
      security,
      request: { params: IdParam },
      responses: {
        200: jsonBody(ScannedMedicineLines, "Lines"),
        ...errorResponses,
        ...notFoundResponse,
      },
    }),
    async (c) => {
      const access = await requirePermission(c, MEDICINES);
      const { id } = c.req.valid("param");
      const out = await withTenant(c, async (tx) => {
        const row = await findExtraction(tx, access, id);
        if (row.state !== "released") throw problems.notFound();
        const lines = scannedMedicineLines((await fieldsOf(tx, id)).map(fieldOf));
        await audit(c, tx, access, {
          action: "integrations.ocr.lines_read",
          resourceType: "ocr_extraction",
          resourceId: id,
          after: { lines: lines.length },
        });
        return {
          extractionId: id,
          personId: row.personId,
          sourceDocumentId: row.documentId,
          lines,
        };
      });
      return c.json(out, 200);
    },
  );

// ---- OCR helpers ------------------------------------------------------------------------------

/** The person must exist in the caller's scope and their medicines permission must reach them. */
async function personReached(tx: Tx, access: TenantAccess, personId: string) {
  const [found] = await tx.select({ id: person.id }).from(person).where(eq(person.id, personId));
  if (!found) throw problems.notFound();
  const reached = await permissionsReaching(tx, access, personId, { withoutBreakGlass: true });
  if (!reached.has(MEDICINES)) throw problems.notFound();
}

async function findExtraction(tx: Tx, access: TenantAccess, id: string): Promise<ExtractionRow> {
  const [row] = await tx
    .select()
    .from(ocrExtraction)
    .where(and(eq(ocrExtraction.id, id), isNull(ocrExtraction.deletedAt)));
  if (!row) throw problems.notFound();
  await personReached(tx, access, row.personId);
  return row;
}

async function moveExtraction(
  tx: Tx,
  row: ExtractionRow,
  expected: number,
  set: Partial<typeof ocrExtraction.$inferInsert>,
): Promise<ExtractionRow> {
  const [saved] = await tx
    .update(ocrExtraction)
    .set({ ...set, version: row.version + 1 })
    .where(and(eq(ocrExtraction.id, row.id), eq(ocrExtraction.version, expected)))
    .returning();
  if (!saved) throw problems.conflict("Someone else changed this scan. Reload it and try again.");
  return saved;
}

function fieldsOf(tx: Tx, extractionId: string) {
  return tx
    .select()
    .from(ocrField)
    .where(eq(ocrField.extractionId, extractionId))
    .orderBy(asc(ocrField.position));
}

function fieldOf(r: FieldRow): OcrField {
  return {
    id: r.id,
    group: r.lineGroup,
    label: r.label as OcrField["label"],
    text: r.readText,
    confidence: Number(r.confidence),
    state: r.state as OcrField["state"],
    value: r.value,
    decidedBy: r.decidedBy,
    decidedAt: r.decidedAt,
  };
}

async function extractionItem(
  tx: Tx,
  r: ExtractionRow,
): Promise<z.infer<typeof OcrExtractionItem>> {
  const fields = await fieldsOf(tx, r.id);
  return {
    id: r.id,
    version: r.version,
    personId: r.personId,
    documentId: r.documentId,
    kind: "mar",
    engine: r.engine,
    location: r.location,
    state: r.state as z.infer<typeof OcrExtractionItem>["state"],
    failure: r.failure,
    requestedBy: r.requestedBy,
    requestedAt: r.createdAt.toISOString(),
    releasedAt: r.releasedAt?.toISOString() ?? null,
    discardedAt: r.discardedAt?.toISOString() ?? null,
    fields: fields.map((f) => ({
      id: f.id,
      version: f.version,
      position: f.position,
      line: f.lineGroup,
      label: f.label as z.infer<typeof OcrExtractionItem>["fields"][number]["label"],
      readText: f.readText,
      confidence: Number(f.confidence),
      state: f.state as z.infer<typeof OcrExtractionItem>["fields"][number]["state"],
      value: f.value,
      decidedBy: f.decidedBy,
      decidedAt: f.decidedAt?.toISOString() ?? null,
    })),
    undecided: fields.filter((f) => f.state === "unconfirmed").length,
  };
}
