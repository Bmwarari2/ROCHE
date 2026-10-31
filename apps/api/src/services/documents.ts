import { createHash } from "node:crypto";
import type { DocumentItem } from "@harbour/contracts";
import { document, documentSignature, legalHold, person, type Transaction } from "@harbour/db";
import {
  checkUpload,
  DOCUMENT_CATEGORIES,
  type DocumentCategoryKey,
  type DocumentStoragePort,
  documentStorageKey,
  isUnderLegalHold,
  type LegalHoldView,
  type MalwareScanPort,
  safeFileName,
} from "@harbour/domain";
import { and, eq, inArray, isNull, sql } from "drizzle-orm";
import { problems } from "../http/problem";
import { isPrintableImage } from "./pdf";

/**
 * Document store service (section 9.1): content checks, malware scan, storage, versioning and the
 * metadata view. Bytes are written to storage only once the row is inserted (so a row the
 * caller's scope refuses stores nothing), and a transaction that fails afterwards has them
 * destroyed again (`destroyingOnFailure`; ADR-0071 review round 1, L4): never a row pointing at
 * nothing, and no orphan object left behind by a refused or failed upload.
 */

type DocumentRow = typeof document.$inferSelect;

export interface StoredUpload {
  readonly bytes: Uint8Array;
  readonly declaredType: string | null;
  readonly category: DocumentCategoryKey;
  readonly title: string;
  readonly fileName?: string | null;
  readonly personId?: string | null;
  readonly subjectType?: string | null;
  readonly subjectId?: string | null;
  readonly previous?: DocumentRow | null;
  /** A retention class other than the category's, for a document whose kind sets it (right to work copies). */
  readonly retentionClass?: string;
  /**
   * For a JPEG or PNG: whether the transfer pack can print it, decided by the caller with
   * `imagePrintableOf` before the transaction opens, so no image is decoded while a connection is
   * held (S2).
   */
  readonly imagePrintable?: boolean | null;
}

/**
 * Whether an uploaded file is a JPEG or PNG the transfer pack can print (`isPrintableImage`), or
 * null when it is not a JPEG or PNG at all. Called before the upload's transaction opens.
 */
export function imagePrintableOf(bytes: Uint8Array): boolean | null {
  if (bytes[0] === 0xff && bytes[1] === 0xd8) {
    return isPrintableImage({ bytes, contentType: "image/jpeg" });
  }
  if (bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47) {
    return isPrintableImage({ bytes, contentType: "image/png" });
  }
  return null;
}

export interface DocumentDeps {
  readonly storage: DocumentStoragePort;
  readonly scanner: MalwareScanPort;
}

export async function storeDocument(
  tx: Transaction,
  deps: DocumentDeps,
  tenantId: string,
  upload: StoredUpload,
): Promise<DocumentRow> {
  const check = checkUpload(upload.category, {
    bytes: upload.bytes,
    declaredType: upload.declaredType,
    hasPerson: Boolean(upload.personId),
  });
  if (!check.ok) throw problems.invalid(check.message);
  const verdict = await deps.scanner.scan(upload.bytes);
  if (verdict === "infected") {
    throw problems.invalid("The file failed a malware check and was not saved.");
  }
  const [{ id }] = (await tx.execute<{ id: string }>(sql`SELECT app.uuid_v7() AS id`)).rows as [
    { id: string },
  ];
  const key = documentStorageKey(tenantId, id);
  const rules = DOCUMENT_CATEGORIES[upload.category];
  const [row] = await tx
    .insert(document)
    .values({
      id,
      category: upload.category,
      title: upload.title,
      fileName: safeFileName(upload.fileName),
      retentionClass: upload.retentionClass ?? rules.retentionClass,
      storageKey: key,
      contentType: check.contentType,
      sizeBytes: upload.bytes.length,
      sha256: createHash("sha256").update(upload.bytes).digest("hex"),
      documentVersion: upload.previous ? upload.previous.documentVersion + 1 : 1,
      previousVersionId: upload.previous?.id ?? null,
      personId: upload.personId ?? null,
      subjectType: upload.subjectType ?? null,
      subjectId: upload.subjectId ?? null,
      status: verdict === "clean" ? "available" : "quarantined",
      scanStatus: verdict,
      imagePrintable: check.contentType.startsWith("image/")
        ? (upload.imagePrintable ?? null)
        : null,
    })
    .returning();
  if (!row) throw new Error("document row was not created");
  // Only now that the row is in (row-level security has accepted it) are the bytes stored.
  await deps.storage.put(key, upload.bytes, check.contentType);
  return row;
}

/**
 * Runs an upload's transaction with a storage that remembers what it wrote, and destroys those
 * objects when the transaction fails, so a refused or failed upload leaves no bytes behind
 * (ADR-0071 review round 1, L4). A destroy that fails is left to the retention sweep.
 */
export async function destroyingOnFailure<T>(
  storage: DocumentStoragePort,
  run: (storage: DocumentStoragePort) => Promise<T>,
): Promise<T> {
  const written: string[] = [];
  const tracking: DocumentStoragePort = {
    provider: storage.provider,
    put: async (key, bytes, contentType) => {
      written.push(key);
      await storage.put(key, bytes, contentType);
    },
    get: (key) => storage.get(key),
    destroy: (key) => storage.destroy(key),
    health: () => storage.health(),
    putStream: async (key, source, contentType) => {
      written.push(key);
      await storage.putStream(key, source, contentType);
    },
    getStream: (key) => storage.getStream(key),
    getRange: (key, start, end) => storage.getRange(key, start, end),
  };
  try {
    return await run(tracking);
  } catch (error) {
    for (const key of written) await storage.destroy(key).catch(() => undefined);
    throw error;
  }
}

export async function activeHolds(tx: Transaction): Promise<LegalHoldView[]> {
  // Holds are visible only to tenant-wide roles; for others this is empty and the hold flag is
  // shown as false, which is safe: holds only ever stop destruction, a tenant-wide action.
  return tx
    .select({
      personId: legalHold.personId,
      subjectType: legalHold.subjectType,
      subjectId: legalHold.subjectId,
      releasedAt: legalHold.releasedAt,
    })
    .from(legalHold)
    .where(isNull(legalHold.releasedAt));
}

export async function toDocumentItems(
  tx: Transaction,
  rows: readonly DocumentRow[],
): Promise<DocumentItem[]> {
  if (rows.length === 0) return [];
  const signatures = await tx
    .select()
    .from(documentSignature)
    .where(
      inArray(
        documentSignature.documentId,
        rows.map((r) => r.id),
      ),
    );
  const holds = await activeHolds(tx);
  return rows.map((r) => ({
    id: r.id,
    category: r.category as DocumentItem["category"],
    title: r.title,
    fileName: r.fileName,
    contentType: r.contentType,
    sizeBytes: r.sizeBytes,
    sha256: r.sha256,
    documentVersion: r.documentVersion,
    previousVersionId: r.previousVersionId,
    personId: r.personId,
    subjectType: r.subjectType,
    subjectId: r.subjectId,
    status: r.status as DocumentItem["status"],
    scanStatus: r.scanStatus as DocumentItem["scanStatus"],
    retentionClass: r.retentionClass,
    legalHold: isUnderLegalHold(
      { personId: r.personId, subjectType: "document", subjectId: r.id },
      holds,
    ),
    createdAt: r.createdAt.toISOString(),
    signatures: signatures
      .filter((s) => s.documentId === r.id)
      .map((s) => ({
        signerName: s.signerName,
        signerCapacity: s.signerCapacity as "staff" | "person" | "representative",
        statement: s.statement,
        signedAt: s.signedAt.toISOString(),
        documentSha256: s.documentSha256,
      })),
  }));
}

/** The bytes of an available document, or not found (quarantined and destroyed documents included). */
export async function readDocumentContent(
  tx: Transaction,
  storage: DocumentStoragePort,
  documentId: string,
): Promise<{ row: DocumentRow; bytes: Uint8Array }> {
  const [row] = await tx
    .select()
    .from(document)
    .where(and(eq(document.id, documentId), isNull(document.deletedAt)));
  if (row?.status !== "available") throw problems.notFound();
  const bytes = await storage.get(row.storageKey);
  if (!bytes) throw problems.notFound();
  return { row, bytes };
}

/** When care ended for a person (discharge or death), the trigger for care-record retention. */
export async function careEndedOn(tx: Transaction, personIds: readonly string[]) {
  if (personIds.length === 0) return new Map<string, Date | null>();
  const rows = await tx
    .select({ id: person.id, dischargedAt: person.dischargedAt, deceasedAt: person.deceasedAt })
    .from(person)
    .where(inArray(person.id, [...personIds]));
  return new Map(rows.map((r) => [r.id, r.deceasedAt ?? r.dischargedAt ?? null]));
}

/** Headers that stop a stored file being interpreted as anything but itself (ASVS V5). */
export function contentHeaders(row: DocumentRow): Record<string, string> {
  const inline = DOCUMENT_CATEGORIES[row.category as DocumentCategoryKey]?.inline ?? false;
  const name = (row.fileName ?? `document-${row.id}`).replace(/[^\w .()-]/g, "_");
  return {
    "content-type": row.contentType,
    "content-length": String(row.sizeBytes),
    "content-disposition": `${inline ? "inline" : "attachment"}; filename="${name}"`,
    "x-content-type-options": "nosniff",
    "content-security-policy": "default-src 'none'; sandbox",
    "cache-control": "private, no-store",
  };
}
