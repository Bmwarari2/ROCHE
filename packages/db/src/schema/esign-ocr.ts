import { sql } from "drizzle-orm";
import {
  type AnyPgColumn,
  check,
  foreignKey,
  index,
  integer,
  numeric,
  pgTable,
  text,
  timestamp,
  unique,
  uuid,
} from "drizzle-orm/pg-core";
import { id, mutableColumns, tenantId } from "./_columns";
import { person } from "./people";
import { document, tenantUser } from "./platform";
import { documentSignature } from "./records";

/**
 * E-signature requests and OCR extractions (Phase 2 slice 79; INTG-013; ADR-0095; integrations.md
 * section 11; migration 0133). Personal data: who is asked to sign what (members only), and the
 * text read from a scanned MAR chart, which is health data and follows the person's scope.
 */

const staffRef = (name: string, t: { tenantId: AnyPgColumn }, column: AnyPgColumn) =>
  foreignKey({
    name,
    columns: [t.tenantId, column],
    foreignColumns: [tenantUser.tenantId, tenantUser.id],
  });
const documentRef = (name: string, t: { tenantId: AnyPgColumn }, column: AnyPgColumn) =>
  foreignKey({
    name,
    columns: [t.tenantId, column],
    foreignColumns: [document.tenantId, document.id],
  });

export const SIGNATURE_REQUEST_STATE_CODES = [
  "requested",
  "sent",
  "signed",
  "declined",
  "cancelled",
  "failed",
] as const;
export const SIGNATURE_PROVIDER_CODES = ["in_app", "docusign"] as const;

export const signatureRequest = pgTable(
  "signature_request",
  {
    id: id(),
    tenantId: tenantId(),
    documentId: uuid("document_id").notNull(),
    /** The SHA-256 of the version to sign; the signer must have read exactly these bytes. */
    documentSha256: text("document_sha256").notNull(),
    signerTenantUserId: uuid("signer_tenant_user_id").notNull(),
    provider: text("provider").notNull(),
    state: text("state").notNull().default("requested"),
    /** The provider's envelope id (DocuSign); null in-app. */
    envelopeId: text("envelope_id"),
    requestedBy: uuid("requested_by").notNull(),
    /** In-app: the signature row written when the member signed. */
    signatureId: uuid("signature_id").references(() => documentSignature.id),
    /** DocuSign: the signed document the provider returned, stored as a new version. */
    signedDocumentId: uuid("signed_document_id"),
    /** How the signer proved it was them (in-app): the second factor's method, never a secret. */
    stepUpMethod: text("step_up_method"),
    signedAt: timestamp("signed_at", { withTimezone: true }),
    closedReason: text("closed_reason"),
    ...mutableColumns(),
  },
  (t) => [
    unique("signature_request_tenant_id_id_key").on(t.tenantId, t.id),
    documentRef("signature_request_document_fk", t, t.documentId),
    documentRef("signature_request_signed_document_fk", t, t.signedDocumentId),
    staffRef("signature_request_signer_fk", t, t.signerTenantUserId),
    staffRef("signature_request_requested_by_fk", t, t.requestedBy),
    index("signature_request_document_idx").on(t.tenantId, t.documentId),
    index("signature_request_signer_idx").on(t.tenantId, t.signerTenantUserId, t.state),
    check(
      "signature_request_state",
      sql`state IN ('requested', 'sent', 'signed', 'declined', 'cancelled', 'failed')`,
    ),
    check("signature_request_provider", sql`provider IN ('in_app', 'docusign')`),
    check("signature_request_sha256", sql`document_sha256 ~ '^[0-9a-f]{64}$'`),
    check(
      "signature_request_signed",
      sql`(state = 'signed') = (signed_at IS NOT NULL)
        AND (state <> 'signed' OR provider <> 'in_app' OR (signature_id IS NOT NULL AND step_up_method IS NOT NULL))
        AND (state <> 'signed' OR provider <> 'docusign' OR signed_document_id IS NOT NULL)`,
    ),
  ],
);

export const OCR_EXTRACTION_STATE_CODES = [
  "blocked",
  "failed",
  "ready",
  "released",
  "discarded",
] as const;
export const OCR_FIELD_STATE_CODES = ["unconfirmed", "confirmed", "corrected", "rejected"] as const;
export const OCR_FIELD_LABEL_CODES = [
  "medicine",
  "strength",
  "dose",
  "route",
  "directions",
  "prescriber",
  "text",
] as const;

export const ocrExtraction = pgTable(
  "ocr_extraction",
  {
    id: id(),
    tenantId: tenantId(),
    personId: uuid("person_id").notNull(),
    /** The scanned image, stored first as the person's document (malware scan, retention class). */
    documentId: uuid("document_id").notNull(),
    kind: text("kind").notNull().default("mar"),
    engine: text("engine").notNull(),
    location: text("location").notNull(),
    /** `blocked`: the image did not scan clean, so it was never read. */
    state: text("state").notNull(),
    /** A short code for a failed read (`engine_error`, `not_clean`); never the engine's message. */
    failure: text("failure"),
    requestedBy: uuid("requested_by").notNull(),
    releasedBy: uuid("released_by"),
    releasedAt: timestamp("released_at", { withTimezone: true }),
    discardedBy: uuid("discarded_by"),
    discardedAt: timestamp("discarded_at", { withTimezone: true }),
    ...mutableColumns(),
  },
  (t) => [
    unique("ocr_extraction_tenant_id_id_key").on(t.tenantId, t.id),
    unique("ocr_extraction_tenant_person_id_key").on(t.tenantId, t.personId, t.id),
    foreignKey({
      name: "ocr_extraction_person_fk",
      columns: [t.tenantId, t.personId],
      foreignColumns: [person.tenantId, person.id],
    }),
    documentRef("ocr_extraction_document_fk", t, t.documentId),
    staffRef("ocr_extraction_requested_by_fk", t, t.requestedBy),
    staffRef("ocr_extraction_released_by_fk", t, t.releasedBy),
    staffRef("ocr_extraction_discarded_by_fk", t, t.discardedBy),
    index("ocr_extraction_person_idx").on(t.tenantId, t.personId),
    check("ocr_extraction_kind", sql`kind IN ('mar')`),
    check(
      "ocr_extraction_engine",
      sql`(engine, location) IN (('google_document_ai', 'europe-west2'), ('mock', 'local'))`,
    ),
    check(
      "ocr_extraction_state",
      sql`state IN ('blocked', 'failed', 'ready', 'released', 'discarded')`,
    ),
    check(
      "ocr_extraction_closed",
      sql`(state = 'released') = (released_at IS NOT NULL AND released_by IS NOT NULL)
        AND (state = 'discarded') = (discarded_at IS NOT NULL AND discarded_by IS NOT NULL)
        AND (state IN ('blocked', 'failed')) = (failure IS NOT NULL)`,
    ),
  ],
);

export const ocrField = pgTable(
  "ocr_field",
  {
    id: id(),
    tenantId: tenantId(),
    extractionId: uuid("extraction_id").notNull(),
    personId: uuid("person_id").notNull(),
    position: integer("position").notNull(),
    /** Which medicine line on the chart (0 first). */
    lineGroup: integer("line_group").notNull(),
    label: text("label").notNull(),
    /** The text as read: never a fact (HZ-005). */
    readText: text("read_text").notNull(),
    /** The engine's own confidence, for information only. */
    confidence: numeric("confidence", { precision: 4, scale: 3 }).notNull(),
    state: text("state").notNull().default("unconfirmed"),
    /** What a person decided: the text as read, or their correction. Null until then. */
    value: text("value"),
    decidedBy: uuid("decided_by"),
    decidedAt: timestamp("decided_at", { withTimezone: true }),
    ...mutableColumns(),
  },
  (t) => [
    unique("ocr_field_tenant_id_id_key").on(t.tenantId, t.id),
    unique("ocr_field_position_key").on(t.tenantId, t.extractionId, t.position),
    foreignKey({
      name: "ocr_field_extraction_fk",
      columns: [t.tenantId, t.personId, t.extractionId],
      foreignColumns: [ocrExtraction.tenantId, ocrExtraction.personId, ocrExtraction.id],
    }),
    staffRef("ocr_field_decided_by_fk", t, t.decidedBy),
    index("ocr_field_extraction_idx").on(t.tenantId, t.extractionId),
    check(
      "ocr_field_label",
      sql`label IN ('medicine', 'strength', 'dose', 'route', 'directions', 'prescriber', 'text')`,
    ),
    check("ocr_field_state", sql`state IN ('unconfirmed', 'confirmed', 'corrected', 'rejected')`),
    check("ocr_field_confidence", sql`confidence >= 0 AND confidence <= 1`),
    check("ocr_field_text", sql`length(read_text) BETWEEN 1 AND 500`),
    check(
      "ocr_field_decided",
      sql`(state = 'unconfirmed') = (decided_by IS NULL AND decided_at IS NULL)
        AND (state IN ('confirmed', 'corrected')) = (value IS NOT NULL)
        AND (value IS NULL OR length(value) BETWEEN 1 AND 500)`,
    ),
  ],
);
