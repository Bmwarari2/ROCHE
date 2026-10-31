import { sql } from "drizzle-orm";
import {
  boolean,
  check,
  date,
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
import { id, mutableColumns, tenantId } from "./_columns";
import { contact, person } from "./people";
import { tenant, tenantUser } from "./platform";

/**
 * A data subject request (PLAT-022; platform.md, Phase 2: the DSAR workbench; ADR-0090): access,
 * rectification, erasure or portability, from or for a person supported, one of their contacts or
 * a member of staff. The statutory clock is worked out on read by `dsarClock` from the dates kept
 * here. `data_rights_case` retention class (retention.md).
 */
export const dsarCase = pgTable(
  "dsar_case",
  {
    id: id(),
    tenantId: tenantId().references(() => tenant.id),
    /** `access`, `rectification`, `erasure` or `portability`. */
    requestKind: text("request_kind").notNull(),
    /** `person`, `contact` or `staff`. */
    subjectKind: text("subject_kind").notNull(),
    subjectPersonId: uuid("subject_person_id"),
    subjectContactId: uuid("subject_contact_id"),
    subjectStaffId: uuid("subject_staff_id"),
    /** `subject` or `representative`. */
    requesterKind: text("requester_kind").notNull(),
    /** A representative's name, as given; null when the subject asks. */
    requesterName: text("requester_name"),
    /** Where the response goes, as the requester gave it. */
    requesterAddress: text("requester_address"),
    /** A representative's authority: `lpa_health_welfare`, `lpa_property_finance`, `deputy`, `written_authority` or `other`. */
    authority: text("authority"),
    /** `email`, `post`, `phone`, `in_person` or `portal`. */
    channel: text("channel").notNull(),
    receivedOn: date("received_on", { mode: "string" }).notNull(),
    identityRequired: boolean("identity_required").notNull().default(true),
    identityVerifiedOn: date("identity_verified_on", { mode: "string" }),
    /** `document_seen`, `known_to_staff`, `authority_checked` or `portal_account`; never the document itself. */
    identityMethod: text("identity_method"),
    /** Clarification pauses, `[{from, to}]` as ISO dates; an open pause has `to` null. */
    pauses: jsonb("pauses").notNull().default(sql`'[]'::jsonb`),
    extensionMonths: integer("extension_months"),
    /** `complex` or `multiple_requests` (UK GDPR Art 12(3)). */
    extensionGrounds: text("extension_grounds"),
    extensionReason: text("extension_reason"),
    extensionDecidedOn: date("extension_decided_on", { mode: "string" }),
    respondedOn: date("responded_on", { mode: "string" }),
    /** `open`, `closed` or `withdrawn`. */
    status: text("status").notNull().default("open"),
    /** `fulfilled`, `partly_fulfilled`, `refused` or `withdrawn`. */
    outcome: text("outcome"),
    outcomeReason: text("outcome_reason"),
    /** Tables with personal data the collector did not search (no subject column), recorded on collection. */
    notSearched: text("not_searched").array().notNull().default(sql`'{}'::text[]`),
    collectedAt: timestamp("collected_at", { withTimezone: true }),
    /** Rectification decisions, `[{table, recordId, field, decision, reason, decidedOn}]`. */
    rectification: jsonb("rectification").notNull().default(sql`'[]'::jsonb`),
    /** The erasure assessment as recorded: counts by outcome and the records still kept, by class. */
    erasure: jsonb("erasure"),
    /** SHA-256 of the bundle as issued. */
    bundleSha256: text("bundle_sha256"),
    bundleIssuedAt: timestamp("bundle_issued_at", { withTimezone: true }),
    ...mutableColumns(),
  },
  (t) => [
    unique("dsar_case_tenant_id_id_key").on(t.tenantId, t.id),
    index("dsar_case_tenant_status_idx").on(t.tenantId, t.status, t.receivedOn),
    foreignKey({
      name: "dsar_case_person_fk",
      columns: [t.tenantId, t.subjectPersonId],
      foreignColumns: [person.tenantId, person.id],
    }),
    foreignKey({
      name: "dsar_case_contact_fk",
      columns: [t.tenantId, t.subjectPersonId, t.subjectContactId],
      foreignColumns: [contact.tenantId, contact.personId, contact.id],
    }),
    foreignKey({
      name: "dsar_case_staff_fk",
      columns: [t.tenantId, t.subjectStaffId],
      foreignColumns: [tenantUser.tenantId, tenantUser.id],
    }),
    check(
      "dsar_case_request_kind",
      sql`request_kind IN ('access', 'rectification', 'erasure', 'portability')`,
    ),
    check(
      "dsar_case_subject",
      sql`(subject_kind = 'person' AND subject_person_id IS NOT NULL AND subject_contact_id IS NULL AND subject_staff_id IS NULL)
        OR (subject_kind = 'contact' AND subject_person_id IS NOT NULL AND subject_contact_id IS NOT NULL AND subject_staff_id IS NULL)
        OR (subject_kind = 'staff' AND subject_person_id IS NULL AND subject_contact_id IS NULL AND subject_staff_id IS NOT NULL)`,
    ),
    check(
      "dsar_case_requester",
      sql`(requester_kind = 'subject' AND authority IS NULL)
        OR (requester_kind = 'representative' AND requester_name IS NOT NULL
          AND authority IS NOT NULL AND authority IN ('lpa_health_welfare', 'lpa_property_finance', 'deputy', 'written_authority', 'other'))`,
    ),
    check("dsar_case_channel", sql`channel IN ('email', 'post', 'phone', 'in_person', 'portal')`),
    check(
      "dsar_case_identity",
      sql`(identity_verified_on IS NULL) = (identity_method IS NULL)
        AND (identity_method IS NULL OR identity_method IN ('document_seen', 'known_to_staff', 'authority_checked', 'portal_account'))`,
    ),
    check(
      "dsar_case_extension",
      sql`(extension_months IS NULL AND extension_grounds IS NULL AND extension_reason IS NULL AND extension_decided_on IS NULL)
        OR (extension_months BETWEEN 1 AND 2 AND extension_grounds IS NOT NULL AND extension_grounds IN ('complex', 'multiple_requests')
          AND extension_reason IS NOT NULL AND extension_decided_on IS NOT NULL)`,
    ),
    check("dsar_case_pauses", sql`jsonb_typeof(pauses) = 'array'`),
    check("dsar_case_rectification", sql`jsonb_typeof(rectification) = 'array'`),
    check("dsar_case_status", sql`status IN ('open', 'closed', 'withdrawn')`),
    check(
      "dsar_case_outcome",
      sql`(status = 'open' AND outcome IS NULL)
        OR (status = 'closed' AND outcome IS NOT NULL AND outcome IN ('fulfilled', 'partly_fulfilled', 'refused') AND responded_on IS NOT NULL)
        OR (status = 'withdrawn' AND outcome = 'withdrawn')`,
    ),
    check(
      "dsar_case_outcome_reason",
      sql`outcome IS NULL OR outcome IN ('fulfilled', 'withdrawn') OR outcome_reason IS NOT NULL`,
    ),
    check(
      "dsar_case_bundle",
      sql`(bundle_sha256 IS NULL) = (bundle_issued_at IS NULL)
        AND (bundle_sha256 IS NULL OR bundle_sha256 ~ '^[0-9a-f]{64}$')`,
    ),
  ],
);

/**
 * One record found for a case, and the decision a person made about it: disclose, redact named
 * fields or withhold, with a reason (platform.md rule 5). Holds the record's table and id only,
 * never a copy of its content. `data_rights_case` retention class.
 */
export const dsarItem = pgTable(
  "dsar_item",
  {
    id: id(),
    tenantId: tenantId().references(() => tenant.id),
    caseId: uuid("case_id").notNull(),
    tableName: text("table_name").notNull(),
    recordId: text("record_id").notNull(),
    /** `pending`, `disclose`, `redact` or `withhold`. */
    decision: text("decision").notNull().default("pending"),
    redactedFields: text("redacted_fields").array().notNull().default(sql`'{}'::text[]`),
    reason: text("reason"),
    reviewedBy: uuid("reviewed_by"),
    reviewedAt: timestamp("reviewed_at", { withTimezone: true }),
    ...mutableColumns(),
  },
  (t) => [
    unique("dsar_item_tenant_id_id_key").on(t.tenantId, t.id),
    unique("dsar_item_case_record_key").on(t.tenantId, t.caseId, t.tableName, t.recordId),
    index("dsar_item_case_decision_idx").on(t.tenantId, t.caseId, t.decision),
    foreignKey({
      name: "dsar_item_case_fk",
      columns: [t.tenantId, t.caseId],
      foreignColumns: [dsarCase.tenantId, dsarCase.id],
    }),
    foreignKey({
      name: "dsar_item_reviewed_by_fk",
      columns: [t.tenantId, t.reviewedBy],
      foreignColumns: [tenantUser.tenantId, tenantUser.id],
    }),
    check("dsar_item_decision", sql`decision IN ('pending', 'disclose', 'redact', 'withhold')`),
    check(
      "dsar_item_reviewed",
      sql`(decision = 'pending') = (reviewed_by IS NULL AND reviewed_at IS NULL)`,
    ),
    check(
      "dsar_item_redaction",
      sql`(decision = 'redact') = (cardinality(redacted_fields) > 0)
        AND (decision IN ('pending', 'disclose') OR reason IS NOT NULL)`,
    ),
  ],
);
