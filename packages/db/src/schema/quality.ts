import { sql } from "drizzle-orm";
import {
  type AnyPgColumn,
  boolean,
  check,
  date,
  foreignKey,
  index,
  integer,
  jsonb,
  numeric,
  pgTable,
  text,
  timestamp,
  unique,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { sqlList } from "./_codes";
import { createdColumns, id, mutableColumns, tenantId } from "./_columns";
import { document, location, tenantUser } from "./platform";

/**
 * Quality: the inspector evidence pack and the statement of purpose (master prompt 11.2;
 * docs/specs/quality.md sections 2 and 4; ADR-0050; hazard HZ-050). Rules live in
 * packages/domain/src/quality; these tables store what they produce. Row-level security, the
 * workflow guards and the link lookup are in migration 0057.
 */

/** `EVIDENCE_PACK_WORKFLOW` states in packages/domain; a test keeps the list in step. */
export const EVIDENCE_PACK_STATES = ["draft", "released", "revoked", "discarded"] as const;
/** `EVIDENCE_RECORD_TYPES` in packages/domain. */
export const EVIDENCE_RECORD_TYPE_CODES = [
  "incident",
  "care_note",
  "observation",
  "body_map_mark",
  "assessment",
  "care_plan_section",
  "risk_assessment",
  "activity_record",
  "visit_log",
  "advance_care_record",
] as const;
/** `EVIDENCE_EXCLUSION_REASONS` in packages/domain. */
export const EVIDENCE_EXCLUSION_REASON_CODES = [
  "restricted_record",
  "outside_date_range",
  "location_not_requested",
  "not_tagged",
  "statement_not_requested",
  "person_not_in_scope",
] as const;
/** Why a link stopped working before its expiry. */
export const EVIDENCE_LINK_REVOCATION_REASONS = ["pack_revoked", "reissued"] as const;
/** Why a bundle's content was deleted (`evidencePackBundleDeletable`). */
export const EVIDENCE_BUNDLE_DELETION_REASONS = [
  "link_ended",
  "pack_revoked",
  "pack_discarded",
] as const;
/** `STATEMENT_OF_PURPOSE_WORKFLOW` states in packages/domain. */
export const STATEMENT_OF_PURPOSE_STATES = [
  "draft",
  "approved",
  "superseded",
  "discarded",
] as const;

const staffRef = (name: string, t: { tenantId: AnyPgColumn }, column: AnyPgColumn) =>
  foreignKey({
    name,
    columns: [t.tenantId, column],
    foreignColumns: [tenantUser.tenantId, tenantUser.id],
  });

/**
 * An inspector evidence pack (`composeEvidencePack`, `EVIDENCE_PACK_WORKFLOW`): the request, who
 * shaped it and its release. Mutable and versioned while a draft; its request is fixed once
 * composed. Visible to holders of `quality.evidence_pack.compose` or `.release` at every one of its
 * locations who can see every person in its scope. Retention `evidence_pack`.
 */
export const evidencePack = pgTable(
  "evidence_pack",
  {
    id: id(),
    tenantId: tenantId(),
    recipientName: text("recipient_name").notNull(),
    recipientOrganisation: text("recipient_organisation").notNull(),
    /** Normalised (`normaliseEmail`): trimmed, lower-cased in ASCII. */
    recipientEmail: text("recipient_email").notNull(),
    purpose: text("purpose").notNull(),
    /** UK dates, inclusive. */
    dateFrom: date("date_from").notNull(),
    dateTo: date("date_to").notNull(),
    locationIds: uuid("location_ids").array().notNull(),
    /** Null for every statement; opaque statement ids until the framework model (QUAL-001). */
    qualityStatementIds: text("quality_statement_ids").array(),
    /** The people in scope, chosen explicitly: never "everyone". */
    personIds: uuid("person_ids").array().notNull(),
    staffNames: text("staff_names").notNull().default("role_only"),
    composedBy: uuid("composed_by").notNull().default(sql`app.current_user_id()`),
    composedAt: timestamp("composed_at", { withTimezone: true }).notNull().defaultNow(),
    /** Every member who changed the draft after composing it (kept by a trigger). */
    editorIds: uuid("editor_ids").array().notNull().default(sql`'{}'::uuid[]`),
    state: text("state").notNull().default("draft"),
    watermark: text("watermark").notNull(),
    releasedBy: uuid("released_by"),
    releasedAt: timestamp("released_at", { withTimezone: true }),
    revokedBy: uuid("revoked_by"),
    revokedAt: timestamp("revoked_at", { withTimezone: true }),
    revocationReason: text("revocation_reason"),
    discardedBy: uuid("discarded_by"),
    discardedAt: timestamp("discarded_at", { withTimezone: true }),
    discardReason: text("discard_reason"),
    ...mutableColumns(),
  },
  (t) => [
    unique("evidence_pack_tenant_id_id_key").on(t.tenantId, t.id),
    staffRef("evidence_pack_composed_by_fk", t, t.composedBy),
    staffRef("evidence_pack_released_by_fk", t, t.releasedBy),
    staffRef("evidence_pack_revoked_by_fk", t, t.revokedBy),
    staffRef("evidence_pack_discarded_by_fk", t, t.discardedBy),
    check("evidence_pack_state", sql`state IN (${sqlList(EVIDENCE_PACK_STATES)})`),
    check("evidence_pack_staff_names", sql`staff_names IN ('role_only', 'include')`),
    check("evidence_pack_dates", sql`date_from <= date_to`),
    check(
      "evidence_pack_scope",
      sql`cardinality(location_ids) > 0 AND cardinality(person_ids) > 0
        AND array_position(location_ids, NULL) IS NULL AND array_position(person_ids, NULL) IS NULL`,
    ),
    check(
      "evidence_pack_recipient",
      sql`btrim(recipient_name) <> '' AND btrim(recipient_organisation) <> ''
        AND recipient_email = lower(btrim(recipient_email))
        AND recipient_email ~ '^[!-~]+@[!-~]+\\.[!-~]+$'`,
    ),
    // MIN_EVIDENCE_PURPOSE_LENGTH in packages/domain; a test keeps it in step.
    check("evidence_pack_purpose", sql`char_length(btrim(purpose)) >= 15`),
    check("evidence_pack_watermark", sql`btrim(watermark) <> ''`),
    check(
      "evidence_pack_released",
      sql`(state IN ('released', 'revoked')) = (released_by IS NOT NULL AND released_at IS NOT NULL)`,
    ),
    check(
      "evidence_pack_revoked",
      sql`(state = 'revoked') = (revoked_by IS NOT NULL AND revoked_at IS NOT NULL
        AND revocation_reason IS NOT NULL AND btrim(revocation_reason) <> '')`,
    ),
    check(
      "evidence_pack_discarded",
      sql`(state = 'discarded') = (discarded_by IS NOT NULL AND discarded_at IS NOT NULL
        AND discard_reason IS NOT NULL AND btrim(discard_reason) <> '')`,
    ),
    index("evidence_pack_state_idx").on(t.tenantId, t.state, t.composedAt),
  ],
);

/**
 * One item considered for a pack (append-only): included with its field outcomes, or excluded with
 * its reason (internal manifest only). A hand redaction adds a new row that supersedes the item.
 * Field values and redacted copies never live here: they are in the bundle, deleted at link end;
 * the manifest keeps the outcomes, reasons and who redacted. Retention `evidence_pack`.
 */
export const evidencePackItem = pgTable(
  "evidence_pack_item",
  {
    id: id(),
    tenantId: tenantId(),
    packId: uuid("pack_id").notNull(),
    /** The item this row replaces (a hand redaction); the newest row is current. */
    supersedesId: uuid("supersedes_id"),
    recordType: text("record_type").notNull(),
    recordId: uuid("record_id").notNull(),
    recordVersion: integer("record_version").notNull(),
    title: text("title").notNull(),
    occurredAt: timestamp("occurred_at", { withTimezone: true }).notNull(),
    qualityStatementIds: text("quality_statement_ids").array().notNull().default(sql`'{}'::text[]`),
    /** Null when included. */
    exclusionReason: text("exclusion_reason"),
    /**
     * `EvidencePackField` outcomes without their values: key (at most 64 characters), label (at
     * most 80), kind, outcome, reason and redactedBy. The redacted copy of a hand redaction lives
     * in the bundle with the other shown values, so nothing typed survives the link's end here.
     */
    fields: jsonb("fields").notNull().default(sql`'[]'::jsonb`),
    /** Everyone who redacted a field by hand: worked out from `fields` by a trigger. */
    redactedBy: uuid("redacted_by").array().notNull().default(sql`'{}'::uuid[]`),
    ...createdColumns(),
  },
  (t) => [
    unique("evidence_pack_item_tenant_id_id_key").on(t.tenantId, t.id),
    foreignKey({
      name: "evidence_pack_item_pack_fk",
      columns: [t.tenantId, t.packId],
      foreignColumns: [evidencePack.tenantId, evidencePack.id],
    }),
    foreignKey({
      name: "evidence_pack_item_supersedes_fk",
      columns: [t.tenantId, t.supersedesId],
      foreignColumns: [t.tenantId, t.id],
    }),
    uniqueIndex("evidence_pack_item_supersedes_key").on(t.supersedesId),
    check(
      "evidence_pack_item_record_type",
      sql`record_type IN (${sqlList(EVIDENCE_RECORD_TYPE_CODES)})`,
    ),
    check(
      "evidence_pack_item_exclusion",
      sql`exclusion_reason IS NULL OR (exclusion_reason IN (${sqlList(EVIDENCE_EXCLUSION_REASON_CODES)})
        AND fields = '[]'::jsonb AND supersedes_id IS NULL)`,
    ),
    check("evidence_pack_item_fields", sql`jsonb_typeof(fields) = 'array'`),
    check("evidence_pack_item_version", sql`record_version >= 1`),
    // A generic label Harbour builds, never free text; bounded so nothing else fits.
    check("evidence_pack_item_title", sql`char_length(btrim(title)) BETWEEN 1 AND 120`),
    index("evidence_pack_item_pack_idx").on(t.tenantId, t.packId),
  ],
);

/**
 * The link a released pack is opened by (ADR-0050): one live link per pack, bound to the
 * recipient's address, stored only as the SHA-256 of its token. Failed code attempts only ever go
 * up. Mutable and versioned. Retention `evidence_pack`.
 */
export const evidencePackLink = pgTable(
  "evidence_pack_link",
  {
    id: id(),
    tenantId: tenantId(),
    packId: uuid("pack_id").notNull(),
    recipientEmail: text("recipient_email").notNull(),
    tokenHash: text("token_hash").notNull(),
    issuedBy: uuid("issued_by").notNull().default(sql`app.current_user_id()`),
    issuedAt: timestamp("issued_at", { withTimezone: true }).notNull().defaultNow(),
    /** The link this one replaced on a re-issue (revoked in the same transaction). */
    replacesLinkId: uuid("replaces_link_id"),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    revokedAt: timestamp("revoked_at", { withTimezone: true }),
    revokedBy: uuid("revoked_by"),
    revocationReason: text("revocation_reason"),
    failedCodeAttempts: integer("failed_code_attempts").notNull().default(0),
    lastOpenedAt: timestamp("last_opened_at", { withTimezone: true }),
    ...mutableColumns(),
  },
  (t) => [
    unique("evidence_pack_link_tenant_id_id_key").on(t.tenantId, t.id),
    unique("evidence_pack_link_token_hash_key").on(t.tokenHash),
    foreignKey({
      name: "evidence_pack_link_pack_fk",
      columns: [t.tenantId, t.packId],
      foreignColumns: [evidencePack.tenantId, evidencePack.id],
    }),
    foreignKey({
      name: "evidence_pack_link_replaces_fk",
      columns: [t.tenantId, t.replacesLinkId],
      foreignColumns: [t.tenantId, t.id],
    }),
    staffRef("evidence_pack_link_issued_by_fk", t, t.issuedBy),
    staffRef("evidence_pack_link_revoked_by_fk", t, t.revokedBy),
    uniqueIndex("evidence_pack_link_live_key")
      .on(t.tenantId, t.packId)
      .where(sql`revoked_at IS NULL`),
    uniqueIndex("evidence_pack_link_replaces_key").on(t.replacesLinkId),
    check("evidence_pack_link_token_hash", sql`token_hash ~ '^[0-9a-f]{64}$'`),
    check("evidence_pack_link_expiry", sql`expires_at > issued_at`),
    check("evidence_pack_link_attempts", sql`failed_code_attempts >= 0`),
    check(
      "evidence_pack_link_revoked",
      sql`(revoked_at IS NULL) = (revocation_reason IS NULL)
        AND (revocation_reason IS NULL
          OR revocation_reason IN (${sqlList(EVIDENCE_LINK_REVOCATION_REASONS)}))`,
    ),
  ],
);

/**
 * A one-time code sent to a link's recipient (ADR-0050): only its hash is stored; used once, then
 * marked used, and nothing else about it ever changes. Retention `evidence_pack`.
 */
export const evidencePackLinkCode = pgTable(
  "evidence_pack_link_code",
  {
    id: id(),
    tenantId: tenantId(),
    linkId: uuid("link_id").notNull(),
    codeHash: text("code_hash").notNull(),
    issuedAt: timestamp("issued_at", { withTimezone: true }).notNull().defaultNow(),
    /** `issued_at` plus `evidence_pack.code_valid_minutes`, never more than ten minutes. */
    validUntil: timestamp("valid_until", { withTimezone: true }).notNull(),
    usedAt: timestamp("used_at", { withTimezone: true }),
    ...createdColumns(),
  },
  (t) => [
    foreignKey({
      name: "evidence_pack_link_code_link_fk",
      columns: [t.tenantId, t.linkId],
      foreignColumns: [evidencePackLink.tenantId, evidencePackLink.id],
    }),
    check("evidence_pack_link_code_hash", sql`code_hash ~ '^[0-9a-f]{64}$'`),
    // EVIDENCE_CODE_MAX_VALID_MINUTES in packages/domain; a test keeps it in step.
    check(
      "evidence_pack_link_code_valid",
      sql`valid_until > issued_at AND valid_until <= issued_at + interval '10 minutes'`,
    ),
    check("evidence_pack_link_code_used", sql`used_at IS NULL OR used_at >= issued_at`),
    index("evidence_pack_link_code_link_idx").on(t.tenantId, t.linkId, t.issuedAt),
  ],
);

/**
 * The pack's content for rendering: the shown value of every included field, by item and key. The
 * PDF is drawn from it and the manifest when asked for and never stored. Changes only while the
 * pack is a draft; deleted (content cleared) when the link ends or the pack is revoked or
 * discarded, never restored. Not versioned, so no copy survives in the history.
 */
export const evidencePackBundle = pgTable(
  "evidence_pack_bundle",
  {
    id: id(),
    tenantId: tenantId(),
    packId: uuid("pack_id").notNull(),
    /** `{ [itemId]: { [fieldKey]: value } }`; null once deleted. */
    content: jsonb("content"),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
    deletedAt: timestamp("deleted_at", { withTimezone: true }),
    deletionReason: text("deletion_reason"),
    ...createdColumns(),
  },
  (t) => [
    unique("evidence_pack_bundle_pack_key").on(t.tenantId, t.packId),
    foreignKey({
      name: "evidence_pack_bundle_pack_fk",
      columns: [t.tenantId, t.packId],
      foreignColumns: [evidencePack.tenantId, evidencePack.id],
    }),
    check(
      "evidence_pack_bundle_deleted",
      sql`(deleted_at IS NULL) = (content IS NOT NULL)
        AND (deleted_at IS NULL) = (deletion_reason IS NULL)
        AND (deletion_reason IS NULL
          OR deletion_reason IN (${sqlList(EVIDENCE_BUNDLE_DELETION_REASONS)}))
        AND (content IS NULL OR jsonb_typeof(content) = 'object')`,
    ),
  ],
);

/**
 * A version of the statement of purpose (`STATEMENT_OF_PURPOSE_WORKFLOW`): changed only while a
 * draft, then fixed. One draft and one approved version at a time. Approval is never by the author
 * or a contributor; the CQC notification is recorded once. Retention `organisation_document`.
 */
export const statementOfPurposeVersion = pgTable(
  "statement_of_purpose_version",
  {
    id: id(),
    tenantId: tenantId(),
    /** 1, 2, 3 in the organisation (distinct from `version`, the row's concurrency counter). */
    versionNumber: integer("version_number").notNull(),
    state: text("state").notNull().default("draft"),
    kind: text("kind").notNull(),
    /** `StatementOfPurposeContent` (Schedule 3 sections) as JSON. */
    content: jsonb("content").notNull(),
    authorId: uuid("author_id").notNull().default(sql`app.current_user_id()`),
    /** The author and every member who changed the draft (kept by a trigger). */
    contributorIds: uuid("contributor_ids").array().notNull().default(sql`'{}'::uuid[]`),
    supersedesId: uuid("supersedes_id"),
    /** `statementOfPurposeChanges` and `statementOfPurposeRegistrationPrompts` at approval. */
    changeSummary: jsonb("change_summary").notNull().default(sql`'[]'::jsonb`),
    registrationPrompts: jsonb("registration_prompts").notNull().default(sql`'[]'::jsonb`),
    approvedBy: uuid("approved_by"),
    approvedAt: timestamp("approved_at", { withTimezone: true }),
    /** Approval plus `cqc.statement_of_purpose.revision_notice_days`; null for a baseline. */
    notificationDueAt: timestamp("notification_due_at", { withTimezone: true }),
    notifiedAt: timestamp("notified_at", { withTimezone: true }),
    notifiedBy: uuid("notified_by"),
    /** The CQC reference, or how it was sent. */
    notificationEvidence: text("notification_evidence"),
    discardReason: text("discard_reason"),
    ...mutableColumns(),
  },
  (t) => [
    unique("statement_of_purpose_version_tenant_id_id_key").on(t.tenantId, t.id),
    unique("statement_of_purpose_version_number_key").on(t.tenantId, t.versionNumber),
    foreignKey({
      name: "statement_of_purpose_version_supersedes_fk",
      columns: [t.tenantId, t.supersedesId],
      foreignColumns: [t.tenantId, t.id],
    }),
    staffRef("statement_of_purpose_version_author_fk", t, t.authorId),
    staffRef("statement_of_purpose_version_approved_by_fk", t, t.approvedBy),
    staffRef("statement_of_purpose_version_notified_by_fk", t, t.notifiedBy),
    uniqueIndex("statement_of_purpose_version_one_draft_key")
      .on(t.tenantId)
      .where(sql`state = 'draft'`),
    uniqueIndex("statement_of_purpose_version_one_approved_key")
      .on(t.tenantId)
      .where(sql`state = 'approved'`),
    check(
      "statement_of_purpose_version_state",
      sql`state IN (${sqlList(STATEMENT_OF_PURPOSE_STATES)})`,
    ),
    check("statement_of_purpose_version_kind", sql`kind IN ('baseline', 'revision')`),
    check("statement_of_purpose_version_number", sql`version_number >= 1`),
    check(
      "statement_of_purpose_version_json",
      sql`jsonb_typeof(content) = 'object' AND jsonb_typeof(change_summary) = 'array'
        AND jsonb_typeof(registration_prompts) = 'array'`,
    ),
    check(
      "statement_of_purpose_version_approved",
      sql`(state IN ('approved', 'superseded')) = (approved_by IS NOT NULL AND approved_at IS NOT NULL)`,
    ),
    check(
      "statement_of_purpose_version_notification_due",
      sql`(kind = 'revision' AND approved_at IS NOT NULL) = (notification_due_at IS NOT NULL)`,
    ),
    check(
      "statement_of_purpose_version_notified",
      sql`(notified_at IS NULL) = (notified_by IS NULL)
        AND (notified_at IS NULL) = (notification_evidence IS NULL)
        AND (notification_evidence IS NULL OR btrim(notification_evidence) <> '')
        AND (notified_at IS NULL OR (kind = 'revision' AND notified_at >= approved_at))`,
    ),
    check(
      "statement_of_purpose_version_discarded",
      sql`(state = 'discarded') = (discard_reason IS NOT NULL AND btrim(discard_reason) <> '')`,
    ),
  ],
);

/**
 * The policy library and read-and-sign (quality.md section 18; QUAL-008; HZ-128; plan slice 25,
 * migration 0087): policies, their versions (one draft and at most one published at a time,
 * publishing supersedes the last) and signatures on the version in force. The database's guards
 * enforce publication in the publisher's own name and the second reviewer.
 */

/** `PolicyState` in packages/domain, kept in step by test/policies.test.ts. */
export const POLICY_VERSION_STATES = ["draft", "published", "superseded", "retired"] as const;

export const policy = pgTable(
  "policy",
  {
    id: id(),
    tenantId: tenantId(),
    policyKey: text("policy_key").notNull(),
    title: text("title").notNull(),
    requireSecondReviewer: boolean("require_second_reviewer").notNull().default(false),
    retiredAt: timestamp("retired_at", { withTimezone: true }),
    retiredReason: text("retired_reason"),
    ...mutableColumns(),
  },
  (t) => [
    unique("policy_tenant_id_id_key").on(t.tenantId, t.id),
    unique("policy_key_key").on(t.tenantId, t.policyKey),
    check("policy_key_format", sql`policy_key ~ '^[a-z][a-z0-9_]{1,63}$'`),
    check("policy_title", sql`length(btrim(title)) BETWEEN 2 AND 160`),
    check(
      "policy_retired",
      sql`(retired_at IS NULL) = (retired_reason IS NULL)
        AND (retired_reason IS NULL OR length(btrim(retired_reason)) >= 10)`,
    ),
  ],
);

export const policyVersion = pgTable(
  "policy_version",
  {
    id: id(),
    tenantId: tenantId(),
    policyId: uuid("policy_id").notNull(),
    versionNumber: integer("version_number").notNull(),
    state: text("state").notNull().default("draft"),
    change: text("change").notNull(),
    changeSummary: text("change_summary").notNull(),
    body: text("body"),
    documentId: uuid("document_id"),
    roles: text("roles").array().notNull().default(sql`'{}'::text[]`),
    reviewDueOn: date("review_due_on"),
    authorId: uuid("author_id").notNull().default(sql`app.current_user_id()`),
    publishedBy: uuid("published_by"),
    publishedOn: date("published_on"),
    publishedAt: timestamp("published_at", { withTimezone: true }),
    supersededAt: timestamp("superseded_at", { withTimezone: true }),
    retiredReason: text("retired_reason"),
    ...mutableColumns(),
  },
  (t) => [
    unique("policy_version_tenant_id_id_key").on(t.tenantId, t.id),
    unique("policy_version_number_key").on(t.tenantId, t.policyId, t.versionNumber),
    foreignKey({
      name: "policy_version_policy_fk",
      columns: [t.tenantId, t.policyId],
      foreignColumns: [policy.tenantId, policy.id],
    }),
    foreignKey({
      name: "policy_version_document_fk",
      columns: [t.tenantId, t.documentId],
      foreignColumns: [document.tenantId, document.id],
    }),
    staffRef("policy_version_author_fk", t, t.authorId),
    staffRef("policy_version_published_by_fk", t, t.publishedBy),
    uniqueIndex("policy_version_one_draft_key")
      .on(t.tenantId, t.policyId)
      .where(sql`state = 'draft'`),
    uniqueIndex("policy_version_one_published_key")
      .on(t.tenantId, t.policyId)
      .where(sql`state = 'published'`),
    check("policy_version_state", sql`state IN (${sqlList(POLICY_VERSION_STATES)})`),
    check("policy_version_change", sql`change IN ('minor', 'major')`),
    check("policy_version_number", sql`version_number >= 1`),
    check("policy_version_summary", sql`length(btrim(change_summary)) BETWEEN 2 AND 2000`),
    check(
      "policy_version_content",
      sql`(body IS NOT NULL OR document_id IS NOT NULL) AND (body IS NULL OR length(body) <= 100000)`,
    ),
    check(
      "policy_version_roles",
      sql`array_position(roles, NULL) IS NULL AND cardinality(roles) <= 40`,
    ),
    check(
      "policy_version_published",
      sql`(state IN ('published', 'superseded', 'retired') AND published_by IS NOT NULL
             AND published_on IS NOT NULL AND published_at IS NOT NULL)
        OR (state = 'draft' AND published_by IS NULL AND published_on IS NULL AND published_at IS NULL)`,
    ),
    check(
      "policy_version_review_date",
      sql`state = 'draft' OR published_on IS NULL OR review_due_on > published_on`,
    ),
  ],
);

export const policySignature = pgTable(
  "policy_signature",
  {
    id: id(),
    tenantId: tenantId(),
    policyVersionId: uuid("policy_version_id").notNull(),
    signerId: uuid("signer_id").notNull().default(sql`app.current_user_id()`),
    signedAt: timestamp("signed_at", { withTimezone: true }).notNull().defaultNow(),
    ...createdColumns(),
  },
  (t) => [
    unique("policy_signature_tenant_id_id_key").on(t.tenantId, t.id),
    unique("policy_signature_once_key").on(t.tenantId, t.policyVersionId, t.signerId),
    foreignKey({
      name: "policy_signature_version_fk",
      columns: [t.tenantId, t.policyVersionId],
      foreignColumns: [policyVersion.tenantId, policyVersion.id],
    }),
    staffRef("policy_signature_signer_fk", t, t.signerId),
    index("policy_signature_signer_idx").on(t.tenantId, t.signerId),
  ],
);

/**
 * The quality dashboard's indicator keys (`QUALITY_INDICATOR_KEYS` in packages/domain; a test keeps
 * the lists in step), and those where a higher value is better, for the direction check.
 */
export const QUALITY_INDICATOR_KEY_CODES = [
  "falls",
  "pressure_ulcers",
  "medication_errors",
  "missed_visits",
  "overdue_reviews",
  "training_compliance",
  "agency_hours",
  "complaints",
  "staff_turnover",
  "incident_response",
] as const;
/** The indicators measured as a percentage, whose targets are 0 to 100. */
export const QUALITY_INDICATOR_PERCENT = [
  "missed_visits",
  "overdue_reviews",
  "training_compliance",
  "agency_hours",
  "staff_turnover",
  "incident_response",
] as const;
export const QUALITY_INDICATOR_HIGHER_IS_BETTER = [
  "training_compliance",
  "incident_response",
] as const;

/**
 * The tenant's own targets for the quality dashboard (quality.md section 22, rule 41; QUAL-005):
 * per indicator, the organisation default (`location_id` null) and optionally one per location.
 * Green and amber are in the indicator's direction. Cleared by `deleted_at`, never deleted.
 * Row-level security, grants and the history trigger are in migration 0108. Retention
 * `organisation_document`; no personal data.
 */
export const qualityIndicatorTarget = pgTable(
  "quality_indicator_target",
  {
    id: id(),
    tenantId: tenantId(),
    locationId: uuid("location_id"),
    indicatorKey: text("indicator_key").notNull(),
    green: numeric("green", { mode: "number" }).notNull(),
    amber: numeric("amber", { mode: "number" }).notNull(),
    ...mutableColumns(),
  },
  (t) => [
    unique("quality_indicator_target_tenant_id_id_key").on(t.tenantId, t.id),
    uniqueIndex("quality_indicator_target_location_key")
      .on(t.tenantId, t.locationId, t.indicatorKey)
      .where(sql`deleted_at IS NULL AND location_id IS NOT NULL`),
    uniqueIndex("quality_indicator_target_organisation_key")
      .on(t.tenantId, t.indicatorKey)
      .where(sql`deleted_at IS NULL AND location_id IS NULL`),
    foreignKey({
      name: "quality_indicator_target_location_fk",
      columns: [t.tenantId, t.locationId],
      foreignColumns: [location.tenantId, location.id],
    }),
    check(
      "quality_indicator_target_key",
      sql`indicator_key IN (${sqlList(QUALITY_INDICATOR_KEY_CODES)})`,
    ),
    check(
      "quality_indicator_target_values",
      sql`green >= 0 AND amber >= 0 AND green <= 1000000 AND amber <= 1000000`,
    ),
    check(
      "quality_indicator_target_percent",
      sql`indicator_key NOT IN (${sqlList(QUALITY_INDICATOR_PERCENT)}) OR (green <= 100 AND amber <= 100)`,
    ),
    check(
      "quality_indicator_target_direction",
      sql`CASE WHEN indicator_key IN (${sqlList(QUALITY_INDICATOR_HIGHER_IS_BETTER)})
        THEN green >= amber ELSE green <= amber END`,
    ),
  ],
);
