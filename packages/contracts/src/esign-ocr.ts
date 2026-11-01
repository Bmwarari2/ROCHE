import { z } from "zod";

/**
 * E-signature requests and OCR of scanned MAR charts (Phase 2 slice 79; INTG-013; ADR-0095;
 * integrations.md section 11). A member signs in Harbour with a fresh second factor, or through
 * DocuSign when the organisation turned it on; OCR values are unconfirmed until a person decides
 * each one, and a released scan's medicines arrive "not yet checked" (HZ-005).
 */

const uuid = z.uuid();
const isoDateTime = z.iso.datetime({ offset: true });
const sha256 = z.string().regex(/^[0-9a-fA-F]{64}$/);
const version = z.number().int().min(1);

export const SignatureRequestState = z
  .enum(["requested", "sent", "signed", "declined", "cancelled", "failed"])
  .meta({ id: "SignatureRequestState" });

export const NewSignatureRequest = z
  .object({
    /** The member asked to sign. */
    signerId: uuid,
    /** The hash of the version the requester means; it must be the current one. */
    documentSha256: sha256,
  })
  .meta({ id: "NewSignatureRequest" });

export const SignatureRequestItem = z
  .object({
    id: uuid,
    version,
    documentId: uuid,
    documentTitle: z.string().nullable(),
    documentSha256: z.string(),
    signer: z.object({ id: uuid, displayName: z.string().nullable() }),
    provider: z.enum(["in_app", "docusign"]),
    state: SignatureRequestState,
    requestedBy: uuid,
    requestedAt: isoDateTime,
    signedAt: isoDateTime.nullable(),
    signatureId: uuid.nullable(),
    signedDocumentId: uuid.nullable(),
    closedReason: z.string().nullable(),
  })
  .meta({ id: "SignatureRequestItem" });

export const SignatureRequestList = z
  .object({ items: z.array(SignatureRequestItem) })
  .meta({ id: "SignatureRequestList" });

export const SignRequest = z
  .object({
    version,
    typedName: z.string().trim().min(2).max(120),
    statement: z.string().trim().min(10).max(500).optional(),
    /** The hash of the bytes the signer read. */
    sha256Seen: sha256,
  })
  .meta({ id: "SignRequest" });

export const CloseSignatureRequest = z
  .object({ version, reason: z.string().trim().min(3).max(500) })
  .meta({ id: "CloseSignatureRequest" });

export const SignatureRequestVersion = z
  .object({ version })
  .meta({ id: "SignatureRequestVersion" });

export const OcrFieldItem = z
  .object({
    id: uuid,
    version,
    position: z.number().int(),
    line: z.number().int(),
    label: z.enum(["medicine", "strength", "dose", "route", "directions", "prescriber", "text"]),
    /** The text as read: never a fact until a person decides it. */
    readText: z.string(),
    /** The engine's own confidence, 0 to 1, for information only. */
    confidence: z.number(),
    state: z.enum(["unconfirmed", "confirmed", "corrected", "rejected"]),
    value: z.string().nullable(),
    decidedBy: uuid.nullable(),
    decidedAt: isoDateTime.nullable(),
  })
  .meta({ id: "OcrFieldItem" });

export const OcrExtractionItem = z
  .object({
    id: uuid,
    version,
    personId: uuid,
    documentId: uuid,
    kind: z.enum(["mar"]),
    engine: z.string(),
    location: z.string(),
    state: z.enum(["blocked", "failed", "ready", "released", "discarded"]),
    failure: z.string().nullable(),
    requestedBy: uuid,
    requestedAt: isoDateTime,
    releasedAt: isoDateTime.nullable(),
    discardedAt: isoDateTime.nullable(),
    fields: z.array(OcrFieldItem),
    /** How many values still wait for a person's decision. */
    undecided: z.number().int(),
  })
  .meta({ id: "OcrExtractionItem" });

export const OcrExtractionList = z
  .object({ items: z.array(OcrExtractionItem.omit({ fields: true })) })
  .meta({ id: "OcrExtractionList" });

export const DecideOcrField = z
  .discriminatedUnion("action", [
    z.object({ version, action: z.literal("confirm") }),
    z.object({ version, action: z.literal("correct"), value: z.string().trim().min(1).max(500) }),
    z.object({ version, action: z.literal("reject") }),
  ])
  .meta({ id: "DecideOcrField" });

export const OcrExtractionVersion = z.object({ version }).meta({ id: "OcrExtractionVersion" });

export const ScannedMedicineLineItem = z
  .object({
    line: z.number().int(),
    medicine: z.string().nullable(),
    strength: z.string().nullable(),
    dose: z.string().nullable(),
    route: z.string().nullable(),
    directions: z.string().nullable(),
    prescriber: z.string().nullable(),
    origin: z.literal("import"),
    state: z.literal("not_yet_checked"),
    secondCheckRequired: z.literal(true),
  })
  .meta({ id: "ScannedMedicineLineItem" });

export const ScannedMedicineLines = z
  .object({
    extractionId: uuid,
    personId: uuid,
    sourceDocumentId: uuid,
    lines: z.array(ScannedMedicineLineItem),
  })
  .meta({ id: "ScannedMedicineLines" });
