import { sql } from "drizzle-orm";
import {
  type AnyPgColumn,
  check,
  foreignKey,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  unique,
  uuid,
} from "drizzle-orm/pg-core";
import { createdColumns, id, mutableColumns, tenantId } from "./_columns";
import { person } from "./people";
import { document, tenantUser } from "./platform";

/**
 * Records management (section 9.1 document store, section 5.1 retention): typed-name signatures
 * bound to the exact bytes signed, legal holds that stop destruction, and destruction certificates
 * that prove what was destroyed, when, under which rule and on whose approval.
 */

const personRef = (name: string, t: { tenantId: AnyPgColumn; personId: AnyPgColumn }) =>
  foreignKey({
    name,
    columns: [t.tenantId, t.personId],
    foreignColumns: [person.tenantId, person.id],
  });

/** Append-only: a signature is never edited; a new version of the document needs a new signature. */
export const documentSignature = pgTable(
  "document_signature",
  {
    id: id(),
    tenantId: tenantId(),
    documentId: uuid("document_id").notNull(),
    personId: uuid("person_id"),
    signerTenantUserId: uuid("signer_tenant_user_id"),
    /** The name exactly as typed (whitespace normalised). */
    signerName: text("signer_name").notNull(),
    /** `staff`, `person` or `representative` (with authority recorded on the contact). */
    signerCapacity: text("signer_capacity").notNull(),
    statement: text("statement").notNull(),
    /** SHA-256 of the bytes the signer saw; must equal the document's hash when signed. */
    documentSha256: text("document_sha256").notNull(),
    signedAt: timestamp("signed_at", { withTimezone: true }).notNull().defaultNow(),
    ...createdColumns(),
  },
  (t) => [
    foreignKey({
      name: "document_signature_document_fk",
      columns: [t.tenantId, t.documentId],
      foreignColumns: [document.tenantId, document.id],
    }),
    personRef("document_signature_person_fk", t),
    foreignKey({
      name: "document_signature_signer_fk",
      columns: [t.tenantId, t.signerTenantUserId],
      foreignColumns: [tenantUser.tenantId, tenantUser.id],
    }),
    index("document_signature_document_idx").on(t.tenantId, t.documentId),
    // For a composite reference from a signature request (migration 0133; ADR-0002).
    unique("document_signature_tenant_document_id_key").on(t.tenantId, t.documentId, t.id),
  ],
);

export const legalHold = pgTable(
  "legal_hold",
  {
    id: id(),
    tenantId: tenantId(),
    /** A hold on a person covers every record about them. */
    personId: uuid("person_id"),
    subjectType: text("subject_type"),
    subjectId: uuid("subject_id"),
    reason: text("reason").notNull(),
    placedAt: timestamp("placed_at", { withTimezone: true }).notNull().defaultNow(),
    releasedAt: timestamp("released_at", { withTimezone: true }),
    releasedBy: uuid("released_by"),
    releaseReason: text("release_reason"),
    ...mutableColumns(),
  },
  (t) => [
    personRef("legal_hold_person_fk", t),
    check(
      "legal_hold_target",
      sql`${t.personId} IS NOT NULL OR (${t.subjectType} IS NOT NULL AND ${t.subjectId} IS NOT NULL)`,
    ),
    index("legal_hold_active_idx").on(t.tenantId, t.releasedAt),
  ],
);

/** Append-only proof of destruction. Holds opaque ids only: the records themselves are gone. */
export const destructionCertificate = pgTable(
  "destruction_certificate",
  {
    id: id(),
    tenantId: tenantId(),
    recordClass: text("record_class").notNull(),
    subjectType: text("subject_type").notNull(),
    subjectIds: uuid("subject_ids").array().notNull(),
    recordCount: integer("record_count").notNull(),
    /** The retention rule applied: period, unit, trigger and source. */
    retentionRule: jsonb("retention_rule").notNull(),
    reason: text("reason").notNull(),
    method: text("method").notNull(),
    executedAt: timestamp("executed_at", { withTimezone: true }).notNull().defaultNow(),
    ...createdColumns(),
  },
  (t) => [index("destruction_certificate_executed_idx").on(t.tenantId, t.executedAt)],
);
