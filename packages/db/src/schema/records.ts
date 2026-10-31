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
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { createdColumns, id, mutableColumns, tenantId } from "./_columns";
import { tenantExport } from "./exports";
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
    /**
     * Signature (ADR-0109): the SHA-256 of the certificate's canonical body and Harbour's
     * certificate key's signature over it. Null on certificates issued before migration 0117.
     */
    bodySha256: text("body_sha256"),
    signature: text("signature"),
    signatureKey: text("signature_key"),
    signatureAlgorithm: text("signature_algorithm"),
    /** Key versions destroyed, with when each is destroyed for good (a crypto-shred). */
    keyVersions: jsonb("key_versions").notNull().default(sql`'[]'::jsonb`),
    keysDestroyedAt: timestamp("keys_destroyed_at", { withTimezone: true }),
    /** When point-in-time recovery no longer holds the deleted rows. */
    backupsExpireAt: timestamp("backups_expire_at", { withTimezone: true }),
    /** A two-person shred: who asked and who approved (members; opaque ids). */
    requestedBy: uuid("requested_by"),
    approvedBy: uuid("approved_by"),
    ...createdColumns(),
  },
  (t) => [
    index("destruction_certificate_executed_idx").on(t.tenantId, t.executedAt),
    unique("destruction_certificate_tenant_id_id_key").on(t.tenantId, t.id),
    check(
      "destruction_certificate_two_people",
      sql`${t.approvedBy} IS NULL OR ${t.requestedBy} IS NULL OR ${t.approvedBy} <> ${t.requestedBy}`,
    ),
  ],
);

/**
 * A whole-organisation crypto-shred (PLAT-012, ADR-0109): asked by one member with
 * platform.retention.manage after the organisation's full export was downloaded, approved by a
 * different one within 7 days, each with step-up. Approval commits `shredding` before the keys
 * are destroyed; completion records the certificate and moves it to `approved`.
 */
export const tenantShredRequest = pgTable(
  "tenant_shred_request",
  {
    id: id(),
    tenantId: tenantId(),
    status: text("status").notNull().default("pending"),
    reason: text("reason").notNull(),
    /** The downloaded full export this shred follows. */
    exportId: uuid("export_id").notNull(),
    requestedBy: uuid("requested_by").notNull(),
    requestedAt: timestamp("requested_at", { withTimezone: true }).notNull().defaultNow(),
    decidedBy: uuid("decided_by"),
    decidedAt: timestamp("decided_at", { withTimezone: true }),
    certificateId: uuid("certificate_id"),
    /** A refusal's reason (migration 0130); no other decision carries one. */
    decisionReason: text("decision_reason"),
    ...mutableColumns(),
  },
  (t) => [
    check(
      "tenant_shred_request_status",
      sql`${t.status} IN ('pending', 'shredding', 'approved', 'cancelled', 'refused')`,
    ),
    check(
      "tenant_shred_request_refusal",
      sql`(${t.status} = 'refused') = (${t.decisionReason} IS NOT NULL) AND (${t.status} <> 'refused' OR (${t.decidedBy} IS NOT NULL AND ${t.decidedAt} IS NOT NULL AND ${t.decidedBy} <> ${t.requestedBy} AND char_length(btrim(${t.decisionReason})) BETWEEN 10 AND 500))`,
    ),
    check("tenant_shred_request_reason", sql`char_length(btrim(${t.reason})) >= 20`),
    // The approver is never the requester (a cancel's rules are in the decide policy).
    check(
      "tenant_shred_request_two_people",
      sql`${t.status} NOT IN ('shredding', 'approved') OR (${t.decidedBy} IS NOT NULL AND ${t.decidedAt} IS NOT NULL AND ${t.decidedBy} <> ${t.requestedBy})`,
    ),
    check(
      "tenant_shred_request_certificate",
      sql`(${t.status} = 'approved') = (${t.certificateId} IS NOT NULL)`,
    ),
    foreignKey({
      name: "tenant_shred_request_requested_by_fk",
      columns: [t.tenantId, t.requestedBy],
      foreignColumns: [tenantUser.tenantId, tenantUser.id],
    }),
    foreignKey({
      name: "tenant_shred_request_decided_by_fk",
      columns: [t.tenantId, t.decidedBy],
      foreignColumns: [tenantUser.tenantId, tenantUser.id],
    }),
    foreignKey({
      name: "tenant_shred_request_export_fk",
      columns: [t.tenantId, t.exportId],
      foreignColumns: [tenantExport.tenantId, tenantExport.id],
    }),
    foreignKey({
      name: "tenant_shred_request_certificate_fk",
      columns: [t.tenantId, t.certificateId],
      foreignColumns: [destructionCertificate.tenantId, destructionCertificate.id],
    }),
    uniqueIndex("tenant_shred_request_one_open")
      .on(t.tenantId)
      .where(sql`status IN ('pending', 'shredding')`),
  ],
);
