import { createHash } from "node:crypto";
import type { DocumentItem } from "@harbour/contracts";
import { document, documentSignature, legalHold, person, type Transaction } from "@harbour/db";
import {
  checkUpload,
  DOCUMENT_CATEGORIES,
  type DocumentCategoryKey,
  type DocumentStoragePort,
  documentStorageKey,
  type HeldDocumentVersion,
  isDocumentUnderLegalHold,
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

/**
 * Each document's whole version chain (every version before and after it, destroyed or not), so
 * a hold on any version holds them all (security review of #134, M1). Versions link back through
 * `previous_version_id`, which has no foreign key: walk back to the first version, then forward
 * from it. A document whose chain never reaches a first version (a missing or unreadable earlier
 * version, or a loop) gets no entry, and `documentHeld` counts it as held (review of #134, L3).
 */
export async function documentVersionChains(
  tx: Transaction,
  ids: readonly string[],
): Promise<Map<string, HeldDocumentVersion[]>> {
  const chains = new Map<string, HeldDocumentVersion[]>();
  if (ids.length === 0) return chains;
  const { rows } = await tx.execute<{
    start_id: string;
    id: string;
    person_id: string | null;
    subject_type: string | null;
    subject_id: string | null;
    legal_hold: boolean;
  }>(sql`
    WITH RECURSIVE back (start_id, id, previous_id) AS (
      SELECT d.id, d.id, d.previous_version_id FROM document d
       WHERE d.id = ANY(ARRAY[${sql.join(
         ids.map((id) => sql`${id}`),
         sql`, `,
       )}]::uuid[])
      UNION
      SELECT b.start_id, p.id, p.previous_version_id
        FROM back b JOIN document p ON p.id = b.previous_id
    ),
    firsts AS (SELECT start_id, id AS first_id FROM back WHERE previous_id IS NULL),
    forward (first_id, id) AS (
      SELECT DISTINCT first_id, first_id FROM firsts
      UNION
      SELECT f.first_id, d.id FROM forward f JOIN document d ON d.previous_version_id = f.id
    )
    SELECT firsts.start_id, d.id, d.person_id, d.subject_type, d.subject_id, d.legal_hold
      FROM firsts
      JOIN forward f ON f.first_id = firsts.first_id
      JOIN document d ON d.id = f.id
  `);
  for (const r of rows) {
    const list = chains.get(r.start_id) ?? [];
    list.push({
      id: r.id,
      personId: r.person_id,
      subjectType: r.subject_type,
      subjectId: r.subject_id,
      legalHold: r.legal_hold,
    });
    chains.set(r.start_id, list);
  }
  return chains;
}

/**
 * Whether a legal hold covers a document (`isDocumentUnderLegalHold` over its whole chain), as
 * both destruction and the document view judge it. A chain that could not be read back to its
 * first version fails closed: held (review of #134, L3 and L4).
 */
export function documentHeld(
  id: string,
  chains: ReadonlyMap<string, readonly HeldDocumentVersion[]>,
  holds: readonly LegalHoldView[],
): boolean {
  const chain = chains.get(id);
  return chain === undefined || isDocumentUnderLegalHold(chain, holds);
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
  const chains = await documentVersionChains(
    tx,
    rows.map((r) => r.id),
  );
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
    // The same judgement as destruction (review of #134, L4).
    legalHold: documentHeld(r.id, chains, holds),
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
