import { z } from "zod";

/** Document store and retention contracts (sections 9.1 and 5.1). */

const uuid = z.uuid();
const isoDateTime = z.iso.datetime({ offset: true });
const sha256 = z.string().regex(/^[0-9a-f]{64}$/i, "A SHA-256 hash in hex");

export const DocumentCategoryKey = z
  .enum([
    "person_photo",
    "feed_photo",
    "care_attachment",
    "person_document",
    "organisation_document",
    "organisation_logo",
    "staff_hr_document",
  ])
  .meta({ id: "DocumentCategoryKey" });
export type DocumentCategoryKey = z.infer<typeof DocumentCategoryKey>;

export const DocumentItem = z
  .object({
    id: uuid,
    category: DocumentCategoryKey,
    title: z.string(),
    fileName: z.string().nullable(),
    contentType: z.string(),
    sizeBytes: z.number().int(),
    sha256,
    documentVersion: z.number().int(),
    previousVersionId: uuid.nullable(),
    personId: uuid.nullable(),
    subjectType: z.string().nullable(),
    subjectId: uuid.nullable(),
    status: z.enum(["available", "quarantined", "destroyed"]),
    scanStatus: z.enum(["clean", "infected", "unavailable", "not_scanned"]),
    retentionClass: z.string(),
    legalHold: z.boolean(),
    createdAt: isoDateTime,
    signatures: z.array(
      z.object({
        signerName: z.string(),
        signerCapacity: z.enum(["staff", "person", "representative"]),
        statement: z.string(),
        signedAt: isoDateTime,
        documentSha256: sha256,
      }),
    ),
  })
  .meta({ id: "DocumentItem", description: "Document metadata; the bytes are at /content" });
export type DocumentItem = z.infer<typeof DocumentItem>;

export const DocumentList = z.object({ items: z.array(DocumentItem) }).meta({ id: "DocumentList" });
export type DocumentList = z.infer<typeof DocumentList>;

/** Query parameters for an upload; the request body is the file itself. */
export const DocumentUploadQuery = z
  .object({
    category: DocumentCategoryKey,
    title: z.string().trim().min(2).max(160),
    personId: uuid.optional(),
    subjectType: z
      .string()
      .regex(/^[a-z_]+$/)
      .max(60)
      .optional(),
    subjectId: uuid.optional(),
    fileName: z.string().max(255).optional(),
  })
  .meta({ id: "DocumentUploadQuery" });
export type DocumentUploadQuery = z.infer<typeof DocumentUploadQuery>;

export const DocumentSignRequest = z
  .object({
    typedName: z.string().max(200),
    statement: z.string().max(500).optional(),
    signerCapacity: z.enum(["staff", "person", "representative"]).default("staff"),
    /** The hash of the version the signer read, so a changed document cannot be signed unseen. */
    sha256Seen: sha256,
  })
  .meta({ id: "DocumentSignRequest" });
export type DocumentSignRequest = z.infer<typeof DocumentSignRequest>;

export const LegalHoldItem = z
  .object({
    id: uuid,
    personId: uuid.nullable(),
    subjectType: z.string().nullable(),
    subjectId: uuid.nullable(),
    reason: z.string(),
    placedAt: isoDateTime,
    releasedAt: isoDateTime.nullable(),
    releaseReason: z.string().nullable(),
    version: z.number().int(),
  })
  .meta({ id: "LegalHoldItem" });
export type LegalHoldItem = z.infer<typeof LegalHoldItem>;

export const LegalHoldList = z
  .object({ items: z.array(LegalHoldItem) })
  .meta({ id: "LegalHoldList" });

export const PlaceLegalHold = z
  .object({
    personId: uuid.optional(),
    subjectType: z
      .string()
      .regex(/^[a-z_]+$/)
      .max(60)
      .optional(),
    subjectId: uuid.optional(),
    reason: z.string().trim().min(10).max(500),
  })
  .meta({ id: "PlaceLegalHold" });
export type PlaceLegalHold = z.infer<typeof PlaceLegalHold>;

export const ReleaseLegalHold = z
  .object({ reason: z.string().trim().min(10).max(500), version: z.number().int().min(1) })
  .meta({ id: "ReleaseLegalHold" });
export type ReleaseLegalHold = z.infer<typeof ReleaseLegalHold>;

export const RetentionCandidate = z
  .object({
    documentId: uuid,
    category: DocumentCategoryKey,
    retentionClass: z.string(),
    eligibleSince: isoDateTime,
    /** The document's title and when it was stored, so the reviewer knows what is to go. */
    title: z.string().optional(),
    createdAt: isoDateTime.optional(),
  })
  .meta({ id: "RetentionCandidate", description: "A document past retention with no legal hold" });
export type RetentionCandidate = z.infer<typeof RetentionCandidate>;

export const RetentionCandidateList = z
  .object({ items: z.array(RetentionCandidate) })
  .meta({ id: "RetentionCandidateList" });
export type RetentionCandidateList = z.infer<typeof RetentionCandidateList>;

export const DestroyDocuments = z
  .object({
    documentIds: z.array(uuid).min(1).max(500),
    reason: z.string().trim().min(10).max(500),
  })
  .meta({ id: "DestroyDocuments" });
export type DestroyDocuments = z.infer<typeof DestroyDocuments>;

export const DestructionCertificateItem = z
  .object({
    id: uuid,
    tenantId: uuid,
    subjectIds: z.array(uuid),
    retentionRule: z.record(z.string(), z.unknown()),
    recordClass: z.string(),
    subjectType: z.string(),
    recordCount: z.number().int(),
    reason: z.string(),
    method: z.string(),
    executedAt: isoDateTime,
    /** SHA-256 (hex) of the canonical certificate body that was signed (PLAT-012, ADR-0109). */
    bodySha256: z.string().nullable(),
    signature: z.string().nullable(),
    signatureKey: z.string().nullable(),
    signatureAlgorithm: z.string().nullable(),
    keyVersions: z.array(z.object({ name: z.string(), destroyAt: isoDateTime })),
    keysDestroyedAt: isoDateTime.nullable(),
    backupsExpireAt: isoDateTime.nullable(),
    requestedBy: uuid.nullable(),
    approvedBy: uuid.nullable(),
  })
  .meta({ id: "DestructionCertificateItem" });
export type DestructionCertificateItem = z.infer<typeof DestructionCertificateItem>;

export const DestructionCertificateList = z
  .object({ items: z.array(DestructionCertificateItem) })
  .meta({ id: "DestructionCertificateList" });
export type DestructionCertificateList = z.infer<typeof DestructionCertificateList>;

export const ShredRequestItem = z
  .object({
    id: uuid,
    status: z.enum(["pending", "shredding", "approved", "cancelled"]),
    reason: z.string(),
    exportId: uuid,
    requestedBy: uuid,
    requestedAt: isoDateTime,
    decidedBy: uuid.nullable(),
    decidedAt: isoDateTime.nullable(),
    certificateId: uuid.nullable(),
  })
  .meta({ id: "ShredRequestItem", description: "A whole-organisation shred request (PLAT-012)" });
export type ShredRequestItem = z.infer<typeof ShredRequestItem>;

export const ShredRequestList = z
  .object({ items: z.array(ShredRequestItem) })
  .meta({ id: "ShredRequestList" });
export type ShredRequestList = z.infer<typeof ShredRequestList>;

export const CreateShredRequest = z
  .object({
    /** Opaque wording: no names of people (it is kept on the certificate for good). */
    reason: z.string().max(1000),
    /** The organisation's full export, downloaded within 30 days, that this shred follows. */
    exportId: uuid,
  })
  .strict()
  .meta({ id: "CreateShredRequest" });
export type CreateShredRequest = z.infer<typeof CreateShredRequest>;

export const ShredApproved = z
  .object({ request: ShredRequestItem, certificate: DestructionCertificateItem.nullable() })
  .meta({
    id: "ShredApproved",
    description:
      "certificate is null while the keys are still being destroyed (status shredding): the worker completes it",
  });
export type ShredApproved = z.infer<typeof ShredApproved>;

export const CertificateVerification = z
  .object({
    /** null for a certificate issued before signing began (migration 0117). */
    valid: z.boolean().nullable(),
    /** The exact canonical body that was signed, for checking with the published public key. */
    body: z.string(),
    signature: z.string().nullable(),
    signatureKey: z.string().nullable(),
    signatureAlgorithm: z.string().nullable(),
  })
  .meta({ id: "CertificateVerification" });
export type CertificateVerification = z.infer<typeof CertificateVerification>;

export const DestructionResult = z
  .object({ certificates: z.array(DestructionCertificateItem), skipped: z.array(uuid) })
  .meta({
    id: "DestructionResult",
    description: "Certificates per record class; skipped ids were held, not yet due or not found",
  });
export type DestructionResult = z.infer<typeof DestructionResult>;
