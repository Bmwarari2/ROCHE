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

const label = z.enum(["medicine", "strength", "dose", "route", "directions", "prescriber", "text"]);
const line = z.number().int().min(0).max(199);
const isoDate = z.iso.date();

export const OcrFieldItem = z
  .object({
    id: uuid,
    version,
    position: z.number().int(),
    /** Where the engine put it: a proposal a person decides. */
    line: z.number().int(),
    label,
    /** The text as read: never a fact until a person decides it. */
    readText: z.string(),
    /**
     * The engine's reading was weak: check this value with particular care. The engine's own
     * number is never sent (automation bias); a value not flagged is no more trustworthy.
     */
    lowConfidence: z.boolean(),
    /** The text read was cut short: correct or reject it, never confirm it. */
    truncated: z.boolean(),
    addedByPerson: z.boolean(),
    state: z.enum(["unconfirmed", "confirmed", "corrected", "rejected"]),
    value: z.string().nullable(),
    decidedLine: z.number().int().nullable(),
    decidedLabel: label.nullable(),
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
    linesCounted: z.number().int().nullable(),
    chartFrom: isoDate.nullable(),
    chartTo: isoDate.nullable(),
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

/** Confirming or correcting also decides the value's line and part (the engine's unless moved). */
export const DecideOcrField = z
  .discriminatedUnion("action", [
    z.object({
      version,
      action: z.literal("confirm"),
      line: line.optional(),
      label: label.optional(),
    }),
    z.object({
      version,
      action: z.literal("correct"),
      value: z.string().trim().min(1).max(500),
      line: line.optional(),
      label: label.optional(),
    }),
    z.object({ version, action: z.literal("reject") }),
  ])
  .meta({ id: "DecideOcrField" });

/** A value the scan missed, typed by a person from the chart. */
export const AddOcrField = z
  .object({ version, line, label, value: z.string().trim().min(1).max(500) })
  .meta({ id: "AddOcrField" });

export const OcrExtractionVersion = z.object({ version }).meta({ id: "OcrExtractionVersion" });

/** What a person confirms about the whole chart before it is released (HZ-005, HZ-130). */
export const ReleaseOcrExtraction = z
  .object({
    version,
    /** The medicine lines they count on the paper chart: typed, never prefilled. */
    linesCounted: z.number().int().min(0).max(200),
    lines: z
      .array(z.object({ line, status: z.enum(["active", "stopped", "cannot_tell"]) }))
      .max(200),
    /** The name and date of birth on the chart are this person's. */
    personConfirmed: z.boolean(),
    chartFrom: isoDate,
    chartTo: isoDate,
    /** This is the chart in use now, not an old one. */
    currentChart: z.boolean(),
  })
  .meta({ id: "ReleaseOcrExtraction" });

const ScannedPart = z
  .object({
    value: z.string(),
    state: z.enum(["confirmed", "corrected"]),
    addedByPerson: z.boolean(),
  })
  .meta({ id: "ScannedPart" });

export const ScannedMedicineLineItem = z
  .object({
    line: z.number().int(),
    medicine: ScannedPart,
    strength: ScannedPart.nullable(),
    dose: ScannedPart.nullable(),
    route: ScannedPart.nullable(),
    directions: ScannedPart.nullable(),
    prescriber: ScannedPart.nullable(),
    notes: z.array(z.string()),
    origin: z.literal("import"),
    state: z.literal("not_yet_checked"),
    secondCheckRequired: z.literal(true),
  })
  .meta({ id: "ScannedMedicineLineItem" });

export const ScannedMedicineLines = z
  .object({
    extractionId: uuid,
    personId: uuid,
    /** The photograph: the second checker compares with it, not with these lines. */
    sourceDocumentId: uuid,
    chartFrom: isoDate,
    chartTo: isoDate,
    lines: z.array(ScannedMedicineLineItem),
    /** Lines the person marked stopped or crossed out on the chart: never released. */
    stoppedLines: z.array(z.number().int()),
    /** Text kept that belongs to no medicine line (for example an allergy note). */
    chartNotes: z.array(z.string()),
    /** Who decided values and who released: none of them may be the second checker. */
    decidedBy: z.array(uuid),
    releasedBy: uuid,
    personConfirmedBy: uuid,
  })
  .meta({ id: "ScannedMedicineLines" });
