import { sql } from "drizzle-orm";
import {
  check,
  date,
  foreignKey,
  index,
  pgTable,
  text,
  timestamp,
  unique,
  uuid,
} from "drizzle-orm/pg-core";
import { id, mutableColumns, tenantId } from "./_columns";
import { document, tenant, tenantUser } from "./platform";

/**
 * Data security evidence (QUAL-012; quality.md sections 17.3 rules 29 to 31 and 18): the DSPT
 * assertion tracker with its evidence, the DSPT submission per financial year, and Cyber Essentials
 * and ICO registration records. Statuses are worked out from these dates and the rate table when
 * read, never stored. Interim `audit_event` retention class until the DPO sets periods (H-810).
 */

const FINANCIAL_YEAR = sql`'^[0-9]{4}/[0-9]{2}$'`;

export const dsptAssertion = pgTable(
  "dspt_assertion",
  {
    id: id(),
    tenantId: tenantId().references(() => tenant.id),
    /** The financial year it is assessed for, as `2025/26`. */
    financialYear: text("financial_year").notNull(),
    /** The assertion's reference as the toolkit numbers it, such as `1.1.1`. */
    assertionRef: text("assertion_ref").notNull(),
    title: text("title").notNull(),
    status: text("status").notNull().default("not_started"),
    notes: text("notes"),
    ownerId: uuid("owner_id"),
    ...mutableColumns(),
  },
  (t) => [
    unique("dspt_assertion_tenant_id_id_key").on(t.tenantId, t.id),
    unique("dspt_assertion_ref_key").on(t.tenantId, t.financialYear, t.assertionRef),
    foreignKey({
      name: "dspt_assertion_owner_fk",
      columns: [t.tenantId, t.ownerId],
      foreignColumns: [tenantUser.tenantId, tenantUser.id],
    }),
    check("dspt_assertion_year", sql`financial_year ~ ${FINANCIAL_YEAR}`),
    check("dspt_assertion_ref", sql`assertion_ref ~ '^[0-9]{1,2}(\\.[0-9]{1,2}){1,3}$'`),
    check(
      "dspt_assertion_status",
      sql`status IN ('not_started', 'in_progress', 'met', 'not_met', 'not_applicable')`,
    ),
    check(
      "dspt_assertion_text",
      sql`char_length(btrim(title)) BETWEEN 3 AND 500
        AND (notes IS NULL OR char_length(btrim(notes)) BETWEEN 1 AND 4000)
        AND (status NOT IN ('not_met', 'not_applicable') OR notes IS NOT NULL)`,
    ),
  ],
);

/** Evidence linked to an assertion, and later unlinked: append-only events. */
export const dsptEvidence = pgTable(
  "dspt_evidence",
  {
    id: id(),
    tenantId: tenantId().references(() => tenant.id),
    assertionId: uuid("assertion_id").notNull(),
    documentId: uuid("document_id").notNull(),
    kind: text("kind").notNull(),
    recordedBy: uuid("recorded_by").notNull().default(sql`app.current_user_id()`),
    recordedAt: timestamp("recorded_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("dspt_evidence_assertion_idx").on(t.tenantId, t.assertionId, t.recordedAt),
    foreignKey({
      name: "dspt_evidence_assertion_fk",
      columns: [t.tenantId, t.assertionId],
      foreignColumns: [dsptAssertion.tenantId, dsptAssertion.id],
    }),
    foreignKey({
      name: "dspt_evidence_document_fk",
      columns: [t.tenantId, t.documentId],
      foreignColumns: [document.tenantId, document.id],
    }),
    foreignKey({
      name: "dspt_evidence_by_fk",
      columns: [t.tenantId, t.recordedBy],
      foreignColumns: [tenantUser.tenantId, tenantUser.id],
    }),
    check("dspt_evidence_kind", sql`kind IN ('linked', 'unlinked')`),
  ],
);

/** The organisation's DSPT submission for one financial year. */
export const dsptSubmission = pgTable(
  "dspt_submission",
  {
    id: id(),
    tenantId: tenantId().references(() => tenant.id),
    financialYear: text("financial_year").notNull(),
    submittedOn: date("submitted_on", { mode: "string" }).notNull(),
    outcome: text("outcome").notNull(),
    /** The toolkit's reference for the submission, as given. */
    reference: text("reference"),
    ...mutableColumns(),
  },
  (t) => [
    unique("dspt_submission_tenant_id_id_key").on(t.tenantId, t.id),
    unique("dspt_submission_year_key").on(t.tenantId, t.financialYear),
    check("dspt_submission_year", sql`financial_year ~ ${FINANCIAL_YEAR}`),
    check(
      "dspt_submission_outcome",
      sql`outcome IN ('standards_met', 'approaching_standards', 'standards_not_met')`,
    ),
    check(
      "dspt_submission_reference",
      sql`reference IS NULL OR char_length(btrim(reference)) BETWEEN 1 AND 100`,
    ),
  ],
);

/** A Cyber Essentials, Cyber Essentials Plus or ICO registration record. */
export const securityCertificate = pgTable(
  "security_certificate",
  {
    id: id(),
    tenantId: tenantId().references(() => tenant.id),
    kind: text("kind").notNull(),
    /** The certificate number, or the ICO registration number. */
    reference: text("reference").notNull(),
    issuedOn: date("issued_on", { mode: "string" }).notNull(),
    /** The expiry the certificate itself states, when it does. */
    expiresOn: date("expires_on", { mode: "string" }),
    issuer: text("issuer"),
    /** A copy, as an organisation document. */
    documentId: uuid("document_id"),
    ...mutableColumns(),
  },
  (t) => [
    unique("security_certificate_tenant_id_id_key").on(t.tenantId, t.id),
    index("security_certificate_kind_idx").on(t.tenantId, t.kind, t.issuedOn),
    foreignKey({
      name: "security_certificate_document_fk",
      columns: [t.tenantId, t.documentId],
      foreignColumns: [document.tenantId, document.id],
    }),
    check(
      "security_certificate_kind",
      sql`kind IN ('cyber_essentials', 'cyber_essentials_plus', 'ico_registration')`,
    ),
    check(
      "security_certificate_text",
      sql`char_length(btrim(reference)) BETWEEN 1 AND 100
        AND (issuer IS NULL OR char_length(btrim(issuer)) BETWEEN 1 AND 200)`,
    ),
    check("security_certificate_dates", sql`expires_on IS NULL OR expires_on > issued_on`),
  ],
);
