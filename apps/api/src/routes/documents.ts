import {
  DestroyDocuments,
  DestructionCertificateList,
  DestructionResult,
  DocumentItem,
  DocumentList,
  DocumentSignRequest,
  DocumentUploadQuery,
  LegalHoldItem,
  LegalHoldList,
  PlaceLegalHold,
  ReleaseLegalHold,
  RetentionCandidateList,
} from "@harbour/contracts";
import {
  destructionCertificate,
  document,
  documentSignature,
  legalHold,
  person,
  retentionClass,
  type Transaction,
} from "@harbour/db";
import {
  checkSignature,
  type DocumentCategoryKey,
  isUnderLegalHold,
  narrowestScope,
  type Permission,
  type RetentionRule,
  retentionDecision,
  scopeFor,
} from "@harbour/domain";
import { createRoute, z } from "@hono/zod-openapi";
import { and, asc, desc, eq, inArray, isNull, ne, or, sql } from "drizzle-orm";
import type { Context } from "hono";
import { auditInTx } from "../http/audit";
import {
  type AppEnv,
  inScopeOf,
  refusalOf,
  requirePermission,
  type TenantAccess,
  useScopeOf,
  withTenant,
} from "../http/context";
import { problems } from "../http/problem";
import { publish } from "../outbox";
import {
  activeHolds,
  careEndedOn,
  contentHeaders,
  destroyingOnFailure,
  imagePrintableOf,
  readDocumentContent,
  storeDocument,
  toDocumentItems,
} from "../services/documents";
import {
  conflictResponse,
  createRouter,
  errorResponses,
  jsonBody,
  notFoundResponse,
  security,
} from "./openapi";

/**
 * Document store, legal holds and destruction (sections 9.1 and 5.1). Uploads send the file as
 * the request body with its own content type; metadata travels in the query string. Documents
 * about a person need the person's permissions and follow their scope.
 */

const UPLOAD_PERMISSION: Record<DocumentCategoryKey, Permission> = {
  person_photo: "people.person.update",
  feed_photo: "comms.feed.publish",
  care_attachment: "care.note.write",
  person_document: "people.person.update",
  organisation_document: "platform.document.manage",
};

const RETENTION_PERMISSION: Permission = "platform.retention.manage";
const binary = z.string().meta({ format: "binary" });
const fileBody = {
  content: {
    "image/jpeg": { schema: binary },
    "image/png": { schema: binary },
    "image/webp": { schema: binary },
    "application/pdf": { schema: binary },
    "application/octet-stream": { schema: binary },
  },
  required: true,
} as const;
const fileResponse = (description: string) => ({
  content: {
    "image/jpeg": { schema: binary },
    "image/png": { schema: binary },
    "image/webp": { schema: binary },
    "application/pdf": { schema: binary },
  },
  description,
});

const DocumentId = z.object({ id: z.uuid() });

/** A document about a person is found with the permission the person's record is opened with. */
const RECORD_READ: Permission = "people.person.read";

/**
 * The permission each category of document about a person is read with, as search reads them
 * (`SEARCHABLE_DOCUMENT_CATEGORIES`; ADR-0071 review round 1, S-M2): a care attachment is part of
 * the care record. An organisation's document (policies, procedures, the statement of purpose)
 * is about no one and is read by any member of the organisation, as before: staff must be able to
 * open the escalation and other policies they follow (HZ-014).
 */
export const DOCUMENT_READ_PERMISSION: Record<DocumentCategoryKey, Permission | null> = {
  person_photo: "people.person.read",
  feed_photo: "people.person.read",
  person_document: "people.person.read",
  care_attachment: "care.note.read",
  organisation_document: null,
};

/**
 * The only records an organisation's document may be attached to (review round 3, an allow-list
 * in place of round 2's block list): it is read by every member, so it is about the organisation
 * or nothing, never a person's record. Anything else is refused.
 */
const ORGANISATION_SUBJECT_TYPES: ReadonlySet<string> = new Set([
  "location",
  "escalation_policy",
  "statement_of_purpose_version",
  "letter_template_version",
]);

/**
 * The permission signing a document about a person needs, by category (review round 2, S2-M1): a
 * signature is a write, so it needs the category's update permission where it reaches the person,
 * never only a read permission (which a break-glass record can open).
 */
const SIGN_PERMISSION: Record<DocumentCategoryKey, Permission | null> = {
  person_photo: "people.person.update",
  feed_photo: "comms.feed.publish",
  person_document: "people.person.update",
  care_attachment: "care.note.write",
  organisation_document: null,
};

/** An organisation's document: no person, and its category says so. Anything else about no one is not served. */
function organisationDocument(row: { personId: string | null; category: string }): boolean {
  return row.personId === null && row.category === "organisation_document";
}

/**
 * Whether a document row is served at all: an organisation's document, or one about a person. A
 * document of a person's category that names no person is not found (review rounds 2 and 3).
 */
function servable(row: { personId: string | null; category: string }): boolean {
  return organisationDocument(row) || row.personId !== null;
}

/** The categories of document about a person, each with the permission it is read with. */
const PERSON_CATEGORIES = (
  Object.entries(DOCUMENT_READ_PERMISSION) as [DocumentCategoryKey, Permission | null][]
).filter((entry): entry is [DocumentCategoryKey, Permission] => entry[1] !== null);

async function findDocument(tx: Transaction, id: string) {
  const [row] = await tx
    .select()
    .from(document)
    .where(and(eq(document.id, id), isNull(document.deletedAt)));
  return row;
}

/**
 * Requires what reading a document about a person needs: people.person.read, and its category's
 * read permission (`DOCUMENT_READ_PERMISSION`), the request then running in the narrowest of their
 * scopes (ADR-0071 review round 1, S-M2). An organisation's document needs nothing.
 */
async function requireRead(
  c: Context<AppEnv>,
  row: { readonly personId: string | null; readonly category: string },
): Promise<TenantAccess> {
  if (organisationDocument(row)) return c.get("access");
  if (!servable(row)) throw problems.notFound();
  const permission = DOCUMENT_READ_PERMISSION[row.category as DocumentCategoryKey] ?? RECORD_READ;
  const access = await requirePermission(c, RECORD_READ);
  return permission === RECORD_READ ? access : requirePermission(c, permission);
}

/**
 * Reads a document's metadata row as a reader of the person's record would find it (an
 * organisation's document needs no permission; ADR-0071), requires its category's read
 * permission, then reads it again in the narrowed scope, so the category's permission must reach
 * the person too (review round 1, S-M2): one held only at another home finds nothing.
 */
async function documentForRead(c: Context<AppEnv>, id: string) {
  useScopeOf(c, RECORD_READ);
  const found = await withTenant(c, (tx) => findDocument(tx, id));
  if (!found) throw problems.notFound();
  // A document about no one is served only as an organisation's document (review round 2).
  if (organisationDocument(found)) return found;
  if (!servable(found)) throw problems.notFound();
  await requireRead(c, found);
  const row = await withTenant(c, (tx) => findDocument(tx, id));
  if (!row) throw problems.notFound();
  return row;
}

async function body(c: Context<AppEnv>): Promise<Uint8Array> {
  return new Uint8Array(await c.req.arrayBuffer());
}

function rethrowReference(error: unknown): never {
  const code =
    (error as { code?: string }).code ?? (error as { cause?: { code?: string } }).cause?.code;
  if (code === "23503" || code === "42501") throw problems.notFound();
  throw error;
}

export const documentsRouter = createRouter()
  .openapi(
    createRoute({
      method: "post",
      path: "/v1/documents",
      tags: ["platform"],
      summary: "Upload a document (the body is the file)",
      description:
        "The file is checked by its contents (JPEG, PNG, WebP or PDF as the category allows), size-limited, scanned for malware and stored encrypted. A file that fails the scan is refused; one that cannot be scanned is kept quarantined.",
      security,
      request: { query: DocumentUploadQuery, body: fileBody },
      responses: {
        201: jsonBody(DocumentItem, "Stored"),
        ...errorResponses,
        ...notFoundResponse,
        413: jsonBody(z.object({ code: z.string() }), "The file is too large"),
      },
    }),
    async (c) => {
      const q = c.req.valid("query");
      const access = await requirePermission(c, UPLOAD_PERMISSION[q.category]);
      // A subject is named by its type and id together (review round 3).
      if (q.subjectId && !q.subjectType) {
        throw problems.invalid("Say what kind of record the document is attached to.");
      }
      if (
        q.category === "organisation_document" &&
        (q.personId || (q.subjectType && !ORGANISATION_SUBJECT_TYPES.has(q.subjectType)))
      ) {
        throw problems.invalid(
          "An organisation's document cannot be attached to a person's record.",
        );
      }
      const bytes = await body(c);
      // Decided before the transaction opens: decoding an image never holds a connection (S2).
      const imagePrintable = imagePrintableOf(bytes);
      const { scanner } = c.get("services");
      const item = await destroyingOnFailure(c.get("services").storage, (storage) =>
        withTenant(c, async (tx) => {
          const row = await storeDocument(tx, { storage, scanner }, access.tenantId, {
            bytes,
            imagePrintable,
            declaredType: c.req.header("content-type") ?? null,
            category: q.category,
            title: q.title,
            fileName: q.fileName,
            personId: q.personId,
            subjectType: q.subjectType,
            subjectId: q.subjectId,
          }).catch(rethrowReference);
          await auditInTx(tx, access, {
            action: "platform.document.upload",
            resourceType: "document",
            resourceId: row.id,
            after: { sha256: row.sha256, category: row.category },
            requestId: c.get("requestId"),
          });
          await publish(tx, {
            context: "platform",
            aggregateType: "document",
            aggregateId: row.id,
            type: "platform.document.stored",
            payload: { category: row.category, status: row.status },
          });
          const [view] = await toDocumentItems(tx, [row]);
          return view;
        }),
      );
      return c.json(item, 201);
    },
  )
  .openapi(
    createRoute({
      method: "get",
      path: "/v1/documents",
      tags: ["platform"],
      summary: "Documents about a person or a record, newest first",
      security,
      request: {
        query: z.object({
          personId: z.uuid().optional(),
          subjectType: z
            .string()
            .regex(/^[a-z_]+$/)
            .max(60)
            .optional(),
          subjectId: z.uuid().optional(),
          category: z
            .enum([
              "person_photo",
              "feed_photo",
              "care_attachment",
              "person_document",
              "organisation_document",
            ])
            .optional(),
        }),
      },
      responses: { 200: jsonBody(DocumentList, "Documents"), ...errorResponses },
    }),
    async (c) => {
      const q = c.req.valid("query");
      const personId = q.personId ?? null;
      // About a person: only the categories whose read permission the session may use, each
      // read in that permission's own scope (ADR-0071 review round 1, S-M2); people.person.read
      // is needed to list any of them. An organisation's documents need nothing.
      const offered = personId
        ? PERSON_CATEGORIES.filter(
            ([category, permission]) =>
              (!q.category || q.category === category) &&
              refusalOf(c.get("access"), RECORD_READ) === null &&
              refusalOf(c.get("access"), permission) === null,
          )
        : [];
      const access = personId ? await requirePermission(c, RECORD_READ) : c.get("access");
      const filters = (category: DocumentCategoryKey | undefined) =>
        and(
          isNull(document.deletedAt),
          ne(document.status, "destroyed"),
          personId
            ? eq(document.personId, personId)
            : and(isNull(document.personId), eq(document.category, "organisation_document")),
          q.subjectType ? eq(document.subjectType, q.subjectType) : undefined,
          q.subjectId ? eq(document.subjectId, q.subjectId) : undefined,
          category ? eq(document.category, category) : undefined,
        );
      const items = await withTenant(c, async (tx) => {
        const query = (category: DocumentCategoryKey | undefined) =>
          tx.select().from(document).where(filters(category)).orderBy(desc(document.createdAt));
        // One category at a time: each sets the transaction's scope while it reads.
        const perCategory: (typeof document.$inferSelect)[] = [];
        for (const [category, permission] of personId ? offered : []) {
          const scope = narrowestScope([
            scopeFor(access.effective, RECORD_READ),
            scopeFor(access.effective, permission),
          ]);
          perCategory.push(...(await inScopeOf(tx, scope, () => query(category).limit(500))));
        }
        const rows = personId
          ? perCategory.sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime()).slice(0, 500)
          : await query(q.category).limit(500);
        await auditInTx(tx, access, {
          action: "platform.document.list",
          resourceType: "document",
          scope: { count: rows.length, personId: q.personId ?? null },
          requestId: c.get("requestId"),
        });
        return toDocumentItems(tx, rows);
      });
      return c.json({ items }, 200);
    },
  )
  .openapi(
    createRoute({
      method: "get",
      path: "/v1/documents/{id}",
      tags: ["platform"],
      summary: "A document's metadata and signatures",
      security,
      request: { params: DocumentId },
      responses: {
        200: jsonBody(DocumentItem, "Document"),
        ...errorResponses,
        ...notFoundResponse,
      },
    }),
    async (c) => {
      const { id } = c.req.valid("param");
      const row = await documentForRead(c, id);
      const [item] = await withTenant(c, (tx) => toDocumentItems(tx, [row]));
      return c.json(item as DocumentItem, 200);
    },
  )
  .openapi(
    createRoute({
      method: "get",
      path: "/v1/documents/{id}/content",
      tags: ["platform"],
      summary: "The document's bytes (audited)",
      security,
      request: { params: DocumentId },
      responses: { 200: fileResponse("The file"), ...errorResponses, ...notFoundResponse },
    }),
    async (c) => {
      const { id } = c.req.valid("param");
      await documentForRead(c, id);
      const access = c.get("access");
      const { storage } = c.get("services");
      const { row, bytes } = await withTenant(c, async (tx) => {
        const found = await readDocumentContent(tx, storage, id);
        await auditInTx(tx, access, {
          action: "platform.document.view",
          resourceType: "document",
          resourceId: id,
          requestId: c.get("requestId"),
        });
        return found;
      });
      return c.body(bytes as Uint8Array<ArrayBuffer>, 200, contentHeaders(row));
    },
  )
  .openapi(
    createRoute({
      method: "post",
      path: "/v1/documents/{id}/versions",
      tags: ["platform"],
      summary: "Upload a new version (the previous one is kept)",
      security,
      request: { params: DocumentId, body: fileBody },
      responses: {
        201: jsonBody(DocumentItem, "New version"),
        ...errorResponses,
        ...notFoundResponse,
      },
    }),
    async (c) => {
      const { id } = c.req.valid("param");
      // Found as a reader would find it; the new version then needs its category's permission,
      // and the document must be found again where that permission reaches before anything is
      // stored (ADR-0071 review round 1, L4).
      useScopeOf(c, RECORD_READ);
      const found = await withTenant(c, (tx) => findDocument(tx, id));
      // A document of a person's category that names no person is not found (review round 3).
      if (!found || found.status === "destroyed" || !servable(found)) throw problems.notFound();
      const access = await requirePermission(
        c,
        UPLOAD_PERMISSION[found.category as DocumentCategoryKey],
      );
      const previous = await withTenant(c, (tx) => findDocument(tx, id));
      if (!previous || previous.status === "destroyed" || !servable(previous)) {
        throw problems.notFound();
      }
      const bytes = await body(c);
      // Decided before the transaction opens: decoding an image never holds a connection (S2).
      const imagePrintable = imagePrintableOf(bytes);
      const { scanner } = c.get("services");
      const item = await destroyingOnFailure(c.get("services").storage, (storage) =>
        withTenant(c, async (tx) => {
          const row = await storeDocument(tx, { storage, scanner }, access.tenantId, {
            bytes,
            imagePrintable,
            declaredType: c.req.header("content-type") ?? null,
            category: previous.category as DocumentCategoryKey,
            title: previous.title,
            fileName: previous.fileName,
            personId: previous.personId,
            subjectType: previous.subjectType,
            subjectId: previous.subjectId,
            previous,
          });
          await auditInTx(tx, access, {
            action: "platform.document.version",
            resourceType: "document",
            resourceId: row.id,
            before: { sha256: previous.sha256 },
            after: { sha256: row.sha256 },
            requestId: c.get("requestId"),
          });
          const [view] = await toDocumentItems(tx, [row]);
          return view;
        }),
      );
      return c.json(item, 201);
    },
  )
  .openapi(
    createRoute({
      method: "post",
      path: "/v1/documents/{id}/signatures",
      tags: ["platform"],
      summary: "Sign a document with a typed name",
      description:
        "Binds the signature to the SHA-256 of the version the signer read; a changed document cannot be signed without being read again. A document about a person needs its category's update permission where it reaches the person (people.person.update for photos and documents, care.note.write for care attachments); a record opened by break-glass cannot be signed.",
      security,
      request: {
        params: DocumentId,
        body: { content: { "application/json": { schema: DocumentSignRequest } } },
      },
      responses: { 201: jsonBody(DocumentItem, "Signed"), ...errorResponses, ...notFoundResponse },
    }),
    async (c) => {
      const { id } = c.req.valid("param");
      const req = c.req.valid("json");
      const read = await documentForRead(c, id);
      if (read.status !== "available") throw problems.notFound();
      // Signing a document about a person is a write: its category's update permission must reach
      // the person, found again in that narrowed scope; a break-glass record never opens it
      // (review round 2, S2-M1). An organisation's document is signed by any member, as before.
      const sign = SIGN_PERMISSION[read.category as DocumentCategoryKey] ?? null;
      let row = read;
      if (read.personId !== null) {
        if (sign === null) throw problems.notFound();
        await requirePermission(c, sign);
        const again = await withTenant(c, (tx) => findDocument(tx, id));
        if (again?.status !== "available") throw problems.notFound();
        row = again;
      }
      const access = c.get("access");
      const check = checkSignature({
        typedName: req.typedName,
        statement: req.statement ?? null,
        sha256Seen: req.sha256Seen,
        currentSha256: row.sha256,
      });
      if (!check.ok) throw problems.invalid(check.message);
      const item = await withTenant(c, async (tx) => {
        await tx.insert(documentSignature).values({
          documentId: id,
          personId: row.personId,
          signerTenantUserId: req.signerCapacity === "staff" ? access.tenantUserId : null,
          signerName: check.signerName,
          signerCapacity: req.signerCapacity,
          statement: check.statement,
          documentSha256: row.sha256,
        });
        await auditInTx(tx, access, {
          action: "platform.document.sign",
          resourceType: "document",
          resourceId: id,
          after: { sha256: row.sha256, capacity: req.signerCapacity },
          requestId: c.get("requestId"),
        });
        const [view] = await toDocumentItems(tx, [row]);
        return view;
      });
      return c.json(item as DocumentItem, 201);
    },
  )
  .openapi(
    createRoute({
      method: "put",
      path: "/v1/people/{id}/photo",
      tags: ["people"],
      summary: "Set the person's photo for identification (the body is the image)",
      security,
      request: { params: DocumentId, body: fileBody },
      responses: {
        201: jsonBody(DocumentItem, "Photo stored"),
        ...errorResponses,
        ...notFoundResponse,
      },
    }),
    async (c) => {
      const access = await requirePermission(c, "people.person.update");
      const { id: personId } = c.req.valid("param");
      const bytes = await body(c);
      // Decided before the transaction opens: decoding an image never holds a connection (S2).
      const imagePrintable = imagePrintableOf(bytes);
      const { scanner } = c.get("services");
      const item = await destroyingOnFailure(c.get("services").storage, (storage) =>
        withTenant(c, async (tx) => {
          const [target] = await tx
            .select({ id: person.id })
            .from(person)
            .where(eq(person.id, personId));
          if (!target) throw problems.notFound();
          const row = await storeDocument(tx, { storage, scanner }, access.tenantId, {
            bytes,
            imagePrintable,
            declaredType: c.req.header("content-type") ?? null,
            category: "person_photo",
            title: "Photo for identification",
            personId,
            subjectType: "person",
            subjectId: personId,
          });
          if (row.status === "available") {
            await tx.update(person).set({ photoDocumentId: row.id }).where(eq(person.id, personId));
          }
          await auditInTx(tx, access, {
            action: "people.person.photo",
            resourceType: "person",
            resourceId: personId,
            after: { documentId: row.id, status: row.status },
            requestId: c.get("requestId"),
          });
          const [view] = await toDocumentItems(tx, [row]);
          return view;
        }),
      );
      return c.json(item, 201);
    },
  )
  .openapi(
    createRoute({
      method: "get",
      path: "/v1/legal-holds",
      tags: ["platform"],
      summary: "Legal holds in force and released",
      security,
      responses: { 200: jsonBody(LegalHoldList, "Holds"), ...errorResponses },
    }),
    async (c) => {
      const access = await requirePermission(c, RETENTION_PERMISSION);
      // Holds name people and give reasons: the read is audited by count, as every records read
      // is (section 5.5; security review, 31 October 2026).
      const rows = await withTenant(c, async (tx) => {
        const found = await tx
          .select()
          .from(legalHold)
          .orderBy(desc(legalHold.placedAt))
          .limit(500);
        await auditInTx(tx, access, {
          action: "platform.legal_hold.list",
          resourceType: "legal_hold",
          scope: { count: found.length },
          requestId: c.get("requestId"),
        });
        return found;
      });
      return c.json({ items: rows.map(holdItem) }, 200);
    },
  )
  .openapi(
    createRoute({
      method: "post",
      path: "/v1/legal-holds",
      tags: ["platform"],
      summary: "Place a legal hold on a person's records or on one record",
      security,
      request: { body: { content: { "application/json": { schema: PlaceLegalHold } } } },
      responses: {
        201: jsonBody(LegalHoldItem, "Hold placed"),
        ...errorResponses,
        ...notFoundResponse,
      },
    }),
    async (c) => {
      const access = await requirePermission(c, RETENTION_PERMISSION);
      const req = c.req.valid("json");
      if (!req.personId && !(req.subjectType && req.subjectId)) {
        throw problems.invalid("Choose a person, or a record type and id.");
      }
      const row = await withTenant(c, async (tx) => {
        await lockRetention(tx, access.tenantId);
        const [placed] = await tx
          .insert(legalHold)
          .values({
            personId: req.personId ?? null,
            subjectType: req.subjectType ?? null,
            subjectId: req.subjectId ?? null,
            reason: req.reason,
          })
          .returning()
          .catch(rethrowReference);
        if (!placed) throw problems.notFound();
        await auditInTx(tx, access, {
          action: "platform.legal_hold.place",
          resourceType: "legal_hold",
          resourceId: placed.id,
          reason: req.reason,
          requestId: c.get("requestId"),
        });
        return placed;
      });
      return c.json(holdItem(row), 201);
    },
  )
  .openapi(
    createRoute({
      method: "post",
      path: "/v1/legal-holds/{id}/release",
      tags: ["platform"],
      summary: "Release a legal hold",
      security,
      request: {
        params: DocumentId,
        body: { content: { "application/json": { schema: ReleaseLegalHold } } },
      },
      responses: {
        200: jsonBody(LegalHoldItem, "Hold released"),
        ...errorResponses,
        ...notFoundResponse,
        ...conflictResponse,
      },
    }),
    async (c) => {
      const access = await requirePermission(c, RETENTION_PERMISSION);
      const { id } = c.req.valid("param");
      const req = c.req.valid("json");
      const row = await withTenant(c, async (tx) => {
        const [released] = await tx
          .update(legalHold)
          .set({
            releasedAt: new Date(),
            releasedBy: access.tenantUserId,
            releaseReason: req.reason,
          })
          .where(
            and(
              eq(legalHold.id, id),
              eq(legalHold.version, req.version),
              isNull(legalHold.releasedAt),
            ),
          )
          .returning();
        if (!released) {
          const [exists] = await tx
            .select({ id: legalHold.id })
            .from(legalHold)
            .where(eq(legalHold.id, id));
          throw exists ? problems.conflict() : problems.notFound();
        }
        await auditInTx(tx, access, {
          action: "platform.legal_hold.release",
          resourceType: "legal_hold",
          resourceId: id,
          reason: req.reason,
          requestId: c.get("requestId"),
        });
        return released;
      });
      return c.json(holdItem(row), 200);
    },
  )
  .openapi(
    createRoute({
      method: "get",
      path: "/v1/retention/candidates",
      tags: ["platform"],
      summary: "Documents past their retention period with no legal hold",
      security,
      responses: { 200: jsonBody(RetentionCandidateList, "Candidates"), ...errorResponses },
    }),
    async (c) => {
      const access = await requirePermission(c, RETENTION_PERMISSION);
      const items = await withTenant(c, async (tx) => {
        const due = await eligibleDocuments(tx, access.tenantId, new Date());
        // A title is shown only where the caller may read that category of document (a person's
        // record needs its own read permissions); otherwise the page says the category alone.
        const mayRead = (category: string) => {
          const permission = DOCUMENT_READ_PERMISSION[category as DocumentCategoryKey];
          if (permission === null) return true;
          if (permission === undefined) return false;
          return refusalOf(access, RECORD_READ) === null && refusalOf(access, permission) === null;
        };
        await auditInTx(tx, access, {
          action: "platform.retention_candidate.list",
          resourceType: "document",
          scope: { count: due.length, documentIds: due.map((d) => d.row.id) },
          requestId: c.get("requestId"),
        });
        return due.map((d) => ({
          documentId: d.row.id,
          category: d.row.category as DocumentCategoryKey,
          retentionClass: d.row.retentionClass,
          eligibleSince: d.since.toISOString(),
          ...(mayRead(d.row.category) ? { title: d.row.title } : {}),
          createdAt: d.row.createdAt.toISOString(),
        }));
      });
      return c.json({ items }, 200);
    },
  )
  .openapi(
    createRoute({
      method: "get",
      path: "/v1/destruction-certificates",
      tags: ["platform"],
      summary: "Destruction certificates, newest first",
      security,
      responses: {
        200: jsonBody(DestructionCertificateList, "Certificates"),
        ...errorResponses,
      },
    }),
    async (c) => {
      const access = await requirePermission(c, RETENTION_PERMISSION);
      const items = await withTenant(c, async (tx) => {
        const rows = await tx
          .select()
          .from(destructionCertificate)
          .orderBy(desc(destructionCertificate.executedAt))
          .limit(500);
        await auditInTx(tx, access, {
          action: "platform.destruction_certificate.list",
          resourceType: "destruction_certificate",
          scope: { count: rows.length },
          requestId: c.get("requestId"),
        });
        return rows.map(certificateItem);
      });
      return c.json({ items }, 200);
    },
  )
  .openapi(
    createRoute({
      method: "post",
      path: "/v1/retention/destroy",
      tags: ["platform"],
      summary: "Destroy documents past retention and issue destruction certificates",
      description:
        "Each id is checked again under the organisation's retention lock, with the documents locked: anything held (including a hold placed while this ran), not yet due or not found is skipped. The tombstone (title removed) and the destruction certificate are committed first; the stored bytes (every version) are deleted after, and a deletion that fails is retried from the outbox (platform.document.destroyed) until it succeeds.",
      security,
      request: { body: { content: { "application/json": { schema: DestroyDocuments } } } },
      responses: { 200: jsonBody(DestructionResult, "Destroyed"), ...errorResponses },
    }),
    async (c) => {
      const access = await requirePermission(c, RETENTION_PERMISSION);
      const req = c.req.valid("json");
      const { storage, logger } = c.get("services");
      const { result, stored } = await withTenant(c, async (tx) => {
        const now = new Date();
        // A hold placed before this point is committed and read below; one placed after waits
        // for this transaction (`lockRetention`). The documents are locked against a concurrent
        // destruction or change, and re-read as they now stand (security review, 31 October 2026).
        await lockRetention(tx, access.tenantId);
        const eligible = await eligibleDocuments(tx, access.tenantId, now, req.documentIds, true);
        const byClass = new Map<string, typeof eligible>();
        for (const e of eligible) {
          byClass.set(e.row.retentionClass, [...(byClass.get(e.row.retentionClass) ?? []), e]);
        }
        const certificates = [];
        const stored: { id: string; storageKey: string }[] = [];
        for (const [recordClass, docs] of byClass) {
          const updated = await tx
            .update(document)
            .set({
              status: "destroyed",
              destroyedAt: now,
              title: "Destroyed document",
              fileName: null,
            })
            .where(
              inArray(
                document.id,
                docs.map((d) => d.row.id),
              ),
            )
            .returning({ id: document.id, storageKey: document.storageKey });
          if (updated.length === 0) continue;
          const [certificate] = await tx
            .insert(destructionCertificate)
            .values({
              recordClass,
              subjectType: "document",
              subjectIds: updated.map((d) => d.id),
              recordCount: updated.length,
              retentionRule: docs[0]?.rule ?? {},
              reason: req.reason,
              method: `storage_delete_all_versions:${storage.provider}`,
              executedAt: now,
            })
            .returning();
          if (!certificate) throw problems.conflict();
          certificates.push(certificate);
          // The bytes are deleted only once this commits; the event retries the deletion until
          // it succeeds (outboxHandlers in jobs/tasks.ts), so none outlive a failed attempt.
          for (const d of updated) {
            await publish(tx, {
              context: "platform",
              aggregateType: "document",
              aggregateId: d.id,
              type: "platform.document.destroyed",
              payload: { certificateId: certificate.id },
            });
            stored.push(d);
          }
        }
        const destroyed = new Set(stored.map((d) => d.id));
        await auditInTx(tx, access, {
          action: "platform.retention.destroy",
          resourceType: "document",
          reason: req.reason,
          scope: { destroyed: destroyed.size, requested: req.documentIds.length },
          requestId: c.get("requestId"),
        });
        return {
          result: {
            certificates: certificates.map(certificateItem),
            skipped: req.documentIds.filter((id) => !destroyed.has(id)),
          },
          stored,
        };
      });
      // Committed: the tombstones and certificates stand, so the bytes go now. A deletion that
      // fails here is left to the outbox event, which the worker retries until it succeeds.
      for (const d of stored) {
        await storage.destroy(d.storageKey).catch((error: unknown) => {
          logger.warn(
            {
              requestId: c.get("requestId"),
              documentId: d.id,
              err: { name: error instanceof Error ? error.name : "Error" },
            },
            "destroyed document's bytes left for the retry",
          );
        });
      }
      return c.json(result, 200);
    },
  );

/**
 * One organisation's retention lock, held until the transaction ends: placing a legal hold and
 * destroying documents both take it, so a destruction always sees every hold committed before it
 * decides, and a hold placed meanwhile waits until the destruction has committed (security
 * review, 31 October 2026). Releasing a hold needs no lock: a destruction that misses a release
 * only skips a document it could have destroyed.
 */
async function lockRetention(tx: Transaction, tenantId: string): Promise<void> {
  await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${`retention:${tenantId}`}))`);
}

function certificateItem(cert: typeof destructionCertificate.$inferSelect) {
  return {
    id: cert.id,
    recordClass: cert.recordClass,
    subjectType: cert.subjectType,
    recordCount: cert.recordCount,
    reason: cert.reason,
    method: cert.method,
    executedAt: cert.executedAt.toISOString(),
  };
}

function holdItem(row: typeof legalHold.$inferSelect) {
  return {
    id: row.id,
    personId: row.personId,
    subjectType: row.subjectType,
    subjectId: row.subjectId,
    reason: row.reason,
    placedAt: row.placedAt.toISOString(),
    releasedAt: row.releasedAt ? row.releasedAt.toISOString() : null,
    releaseReason: row.releaseReason,
    version: row.version,
  };
}

/**
 * Documents that are past retention, not held and not destroyed. The trigger for care-record
 * classes is when care ended (discharge or death); documents of people still receiving care are
 * never eligible. Tenant overrides of the retention class win over the global row. `forUpdate`
 * locks the documents read until the transaction ends (destruction); the holds are read after.
 */
async function eligibleDocuments(
  tx: Transaction,
  tenantId: string,
  now: Date,
  onlyIds?: readonly string[],
  forUpdate = false,
) {
  const query = tx
    .select()
    .from(document)
    .where(
      and(
        isNull(document.deletedAt),
        ne(document.status, "destroyed"),
        onlyIds ? inArray(document.id, [...onlyIds]) : undefined,
      ),
    )
    .orderBy(asc(document.createdAt))
    .limit(5000);
  const rows = forUpdate ? await query.for("update") : await query;
  const classes = await tx
    .select()
    .from(retentionClass)
    .where(or(isNull(retentionClass.tenantId), eq(retentionClass.tenantId, tenantId)));
  const ruleFor = (recordClass: string) =>
    classes.find((r) => r.recordClass === recordClass && r.tenantId === tenantId) ??
    classes.find((r) => r.recordClass === recordClass && r.tenantId === null);
  const holds = await activeHolds(tx);
  const ended = await careEndedOn(
    tx,
    rows.flatMap((r) => (r.personId ? [r.personId] : [])),
  );
  const eligible: { row: (typeof rows)[number]; since: Date; rule: Record<string, unknown> }[] = [];
  for (const row of rows) {
    const rule = ruleFor(row.retentionClass);
    if (!rule) continue;
    const trigger = rule.trigger as RetentionRule["trigger"];
    const triggerDate =
      trigger === "care_ended"
        ? row.personId
          ? (ended.get(row.personId) ?? null)
          : null
        : trigger === "created"
          ? row.createdAt
          : null;
    if (!triggerDate) continue;
    const decision = retentionDecision(
      {
        recordClass: rule.recordClass,
        period: rule.period,
        unit: rule.unit as "years" | "months",
        trigger,
      },
      {
        triggerDate,
        legalHold: isUnderLegalHold(
          { personId: row.personId, subjectType: "document", subjectId: row.id },
          holds,
        ),
      },
      now,
    );
    if (decision.status === "eligible_for_destruction") {
      eligible.push({
        row,
        since: decision.since,
        rule: { period: rule.period, unit: rule.unit, trigger: rule.trigger, source: rule.source },
      });
    }
  }
  return eligible;
}
