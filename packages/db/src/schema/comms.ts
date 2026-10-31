import { sql } from "drizzle-orm";
import {
  type AnyPgColumn,
  boolean,
  check,
  foreignKey,
  index,
  integer,
  pgTable,
  text,
  timestamp,
  unique,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { sqlList } from "./_codes";
import { createdColumns, id, mutableColumns, tenantId } from "./_columns";
import { contact, person } from "./people";
import { sharingDecision } from "./people-lifecycle";
import { document, tenantUser } from "./platform";
import { incident } from "./safety";

/**
 * Letter and email templates and the letters made from them (comms.md rules 18 to 25; COMMS-007;
 * ADR-0051; hazard HZ-051). Rules live in packages/domain/src/comms/templates.ts; these tables
 * store what they produce. Row-level security, the version workflow and the letter checks are in
 * migration 0059.
 */

/** `TEMPLATE_KINDS` in packages/domain; a test keeps the lists in step. */
export const TEMPLATE_KIND_CODES = [
  "admission",
  "fee_review",
  "incident_follow_up",
  "duty_of_candour",
  "general",
] as const;
/** `LETTER_ONLY_KINDS`: never email. */
export const LETTER_ONLY_KIND_CODES = ["incident_follow_up", "duty_of_candour"] as const;
export const TEMPLATE_CHANNEL_CODES = ["letter", "email"] as const;
/** `TEMPLATE_WORKFLOW` states. */
export const TEMPLATE_VERSION_STATES = [
  "draft",
  "approved",
  "superseded",
  "retired",
  "discarded",
] as const;

const staffRef = (name: string, t: { tenantId: AnyPgColumn }, column: AnyPgColumn) =>
  foreignKey({
    name,
    columns: [t.tenantId, column],
    foreignColumns: [tenantUser.tenantId, tenantUser.id],
  });

/**
 * A template: its kind and channel, fixed once made, and the version in use (kept by the
 * database on approval and retirement). Tenant configuration with no personal data. Retention
 * `organisation_document`.
 */
export const letterTemplate = pgTable(
  "letter_template",
  {
    id: id(),
    tenantId: tenantId(),
    kind: text("kind").notNull(),
    channel: text("channel").notNull(),
    /** The approved version in use; null before the first approval and after retirement. */
    currentVersionId: uuid("current_version_id"),
    ...mutableColumns(),
  },
  (t) => [
    unique("letter_template_tenant_id_id_key").on(t.tenantId, t.id),
    check("letter_template_kind", sql`kind IN (${sqlList(TEMPLATE_KIND_CODES)})`),
    check("letter_template_channel", sql`channel IN (${sqlList(TEMPLATE_CHANNEL_CODES)})`),
    check(
      "letter_template_letter_only",
      sql`channel = 'letter' OR kind NOT IN (${sqlList(LETTER_ONLY_KIND_CODES)})`,
    ),
  ],
);

/**
 * A version of a template (`TEMPLATE_WORKFLOW`): changed only while a draft, then fixed. One draft
 * and one approved version per template at a time; approved never by its author or an editor.
 * Retention `organisation_document`.
 */
export const letterTemplateVersion = pgTable(
  "letter_template_version",
  {
    id: id(),
    tenantId: tenantId(),
    templateId: uuid("template_id").notNull(),
    versionNumber: integer("version_number").notNull(),
    state: text("state").notNull().default("draft"),
    name: text("name").notNull(),
    /** Email only; null for a letter. */
    subject: text("subject"),
    body: text("body").notNull(),
    authorId: uuid("author_id").notNull().default(sql`app.current_user_id()`),
    /** The author and everyone who changed the draft (kept by the database). */
    contributorIds: uuid("contributor_ids").array().notNull().default(sql`'{}'::uuid[]`),
    approvedBy: uuid("approved_by"),
    approvedAt: timestamp("approved_at", { withTimezone: true }),
    retiredBy: uuid("retired_by"),
    retiredAt: timestamp("retired_at", { withTimezone: true }),
    retirementReason: text("retirement_reason"),
    discardReason: text("discard_reason"),
    ...mutableColumns(),
  },
  (t) => [
    unique("letter_template_version_tenant_id_id_key").on(t.tenantId, t.id),
    unique("letter_template_version_number_key").on(t.tenantId, t.templateId, t.versionNumber),
    foreignKey({
      name: "letter_template_version_template_fk",
      columns: [t.tenantId, t.templateId],
      foreignColumns: [letterTemplate.tenantId, letterTemplate.id],
    }),
    staffRef("letter_template_version_author_fk", t, t.authorId),
    staffRef("letter_template_version_approved_by_fk", t, t.approvedBy),
    staffRef("letter_template_version_retired_by_fk", t, t.retiredBy),
    uniqueIndex("letter_template_version_one_draft_key")
      .on(t.tenantId, t.templateId)
      .where(sql`state = 'draft'`),
    uniqueIndex("letter_template_version_one_approved_key")
      .on(t.tenantId, t.templateId)
      .where(sql`state = 'approved'`),
    check("letter_template_version_state", sql`state IN (${sqlList(TEMPLATE_VERSION_STATES)})`),
    check("letter_template_version_number", sql`version_number >= 1`),
    check(
      "letter_template_version_text",
      sql`char_length(btrim(name)) BETWEEN 1 AND 200 AND char_length(body) BETWEEN 1 AND 20000
        AND (subject IS NULL OR char_length(subject) BETWEEN 1 AND 80)`,
    ),
    check(
      "letter_template_version_approved",
      sql`(state IN ('approved', 'superseded', 'retired')) = (approved_by IS NOT NULL AND approved_at IS NOT NULL)`,
    ),
    check(
      "letter_template_version_retired",
      sql`(state = 'retired') = (retired_by IS NOT NULL AND retired_at IS NOT NULL
        AND retirement_reason IS NOT NULL AND btrim(retirement_reason) <> '')`,
    ),
    check(
      "letter_template_version_discarded",
      sql`(state = 'discarded') = (discard_reason IS NOT NULL AND btrim(discard_reason) <> '')`,
    ),
  ],
);

/**
 * A letter or email made from an approved version (rules 24 and 25), about one person, to them
 * or one of their contacts. Append-only. Holds the personal-data fields used, never the content
 * of an email; a letter's rendered PDF is a document about the person. Retention by
 * `letterRetentionClass`: `serious_incident` for an incident or candour letter about an incident
 * graded serious, otherwise `care_record`.
 */
export const letter = pgTable(
  "letter",
  {
    id: id(),
    tenantId: tenantId(),
    templateVersionId: uuid("template_version_id").notNull(),
    personId: uuid("person_id").notNull(),
    /** `person` (the person themselves) or `contact` (one of their contacts). */
    recipientKind: text("recipient_kind").notNull(),
    contactId: uuid("contact_id"),
    channel: text("channel").notNull(),
    /** Merge field keys used that hold personal data (`MERGE_FIELDS`), for the audit trail. */
    personalFields: text("personal_fields").array().notNull().default(sql`'{}'::text[]`),
    specialCategory: boolean("special_category").notNull(),
    resultsToFollow: boolean("results_to_follow").notNull().default(false),
    incidentId: uuid("incident_id"),
    incidentSerious: boolean("incident_serious").notNull().default(false),
    /** The rendered letter (PDF); null for an email. */
    documentId: uuid("document_id"),
    /** The email's delivery reference; null for a letter. */
    deliveryReference: text("delivery_reference"),
    sentBy: uuid("sent_by").notNull().default(sql`app.current_user_id()`),
    sentAt: timestamp("sent_at", { withTimezone: true }).notNull().defaultNow(),
    retentionClass: text("retention_class").notNull(),
    ...createdColumns(),
  },
  (t) => [
    unique("letter_tenant_id_id_key").on(t.tenantId, t.id),
    foreignKey({
      name: "letter_template_version_fk",
      columns: [t.tenantId, t.templateVersionId],
      foreignColumns: [letterTemplateVersion.tenantId, letterTemplateVersion.id],
    }),
    foreignKey({
      name: "letter_person_fk",
      columns: [t.tenantId, t.personId],
      foreignColumns: [person.tenantId, person.id],
    }),
    // The recipient is one of this person's own contacts (rule 24).
    foreignKey({
      name: "letter_contact_fk",
      columns: [t.tenantId, t.personId, t.contactId],
      foreignColumns: [contact.tenantId, contact.personId, contact.id],
    }),
    foreignKey({
      name: "letter_incident_fk",
      columns: [t.tenantId, t.incidentId],
      foreignColumns: [incident.tenantId, incident.id],
    }),
    foreignKey({
      name: "letter_document_fk",
      columns: [t.tenantId, t.documentId],
      foreignColumns: [document.tenantId, document.id],
    }),
    staffRef("letter_sent_by_fk", t, t.sentBy),
    index("letter_person_idx").on(t.tenantId, t.personId, t.sentAt),
    check("letter_channel", sql`channel IN (${sqlList(TEMPLATE_CHANNEL_CODES)})`),
    check(
      "letter_recipient",
      sql`recipient_kind IN ('person', 'contact') AND (recipient_kind = 'contact') = (contact_id IS NOT NULL)`,
    ),
    check("letter_serious", sql`NOT incident_serious OR incident_id IS NOT NULL`),
    check(
      "letter_retention",
      sql`retention_class = CASE WHEN incident_serious THEN 'serious_incident' ELSE 'care_record' END`,
    ),
    check(
      "letter_delivery",
      sql`(channel = 'letter' OR document_id IS NULL) AND (channel = 'email' OR delivery_reference IS NULL)
        AND (channel = 'letter' OR NOT special_category)`,
    ),
    check(
      "letter_fields",
      sql`array_position(personal_fields, NULL) IS NULL AND cardinality(personal_fields) <= 100`,
    ),
  ],
);

// ------------------------------------------------------------------------------------------------
// The family feed (comms.md rules 1 to 12 and section 2.1; COMMS-001; ADR-0061; hazard HZ-022).
// Row-level security, the family scope and `app.family_can_see` are in migration 0061.
// ------------------------------------------------------------------------------------------------

/** `FEED_ITEM_SECTIONS` in packages/domain: each kind of update and its section. */
export const FEED_ITEM_SECTION_CODES = {
  activity: "activities_and_visits",
  visit: "activities_and_visits",
  appointment: "appointments",
  shared_note: "daily_updates",
  photo: "photos",
  care_plan_update: "care_plan",
  finance_statement: "finance",
} as const;
/** `FEED_SOURCE_KINDS` in packages/domain. */
export const FEED_SOURCE_KIND_CODES = [
  "activity",
  "visit",
  "shared_note",
  "photo",
  "care_plan_update",
  "finance_statement",
] as const;
/** `FEED_WITHDRAWAL_REASONS` in packages/domain. */
export const FEED_WITHDRAWAL_REASON_CODES = [
  "source_corrected",
  "published_in_error",
  "person_asked",
  "photo_consent_withdrawn",
] as const;

const FEED_SECTION_CASE = sql.raw(
  `CASE kind ${Object.entries(FEED_ITEM_SECTION_CODES)
    .map(([kind, section]) => `WHEN '${kind}' THEN '${section}'`)
    .join(" ")} END`,
);

/**
 * The link a family session is resolved from (ADR-0061): a portal account (a tenant user holding
 * portal roles only) and the contact the sharing decisions name. A family member never gets a
 * `person_assignment`; the database refuses one for a linked account. Revoked with a reason,
 * never deleted. Retention `care_record`, with the contact.
 */
export const familyPortalUser = pgTable(
  "family_portal_user",
  {
    id: id(),
    tenantId: tenantId(),
    tenantUserId: uuid("tenant_user_id").notNull(),
    personId: uuid("person_id").notNull(),
    contactId: uuid("contact_id").notNull(),
    revokedAt: timestamp("revoked_at", { withTimezone: true }),
    revokedBy: uuid("revoked_by"),
    revokedReason: text("revoked_reason"),
    ...mutableColumns(),
  },
  (t) => [
    staffRef("family_portal_user_tenant_user_fk", t, t.tenantUserId),
    staffRef("family_portal_user_revoked_by_fk", t, t.revokedBy),
    foreignKey({
      name: "family_portal_user_contact_fk",
      columns: [t.tenantId, t.personId, t.contactId],
      foreignColumns: [contact.tenantId, contact.personId, contact.id],
    }),
    uniqueIndex("family_portal_user_open_key")
      .on(t.tenantId, t.tenantUserId, t.contactId)
      .where(sql`revoked_at IS NULL AND deleted_at IS NULL`),
    index("family_portal_user_person_idx").on(t.tenantId, t.personId),
    check(
      "family_portal_user_revoked",
      sql`(revoked_at IS NULL) = (revoked_by IS NULL) AND (revoked_at IS NULL) = (revoked_reason IS NULL)
        AND (revoked_reason IS NULL OR btrim(revoked_reason) <> '')`,
    ),
  ],
);

/**
 * A published family update (append-only; rules 7 to 12): from one record about one person, in
 * one section, in approved phrasing or words written for the family. Withdrawal is its own row.
 * Retention `care_record`.
 */
export const feedItem = pgTable(
  "feed_item",
  {
    id: id(),
    tenantId: tenantId(),
    personId: uuid("person_id").notNull(),
    kind: text("kind").notNull(),
    section: text("section").notNull(),
    carePlanDomain: text("care_plan_domain"),
    sourceKind: text("source_kind").notNull(),
    sourceId: uuid("source_id").notNull(),
    occurredAt: timestamp("occurred_at", { withTimezone: true }).notNull(),
    composedAt: timestamp("composed_at", { withTimezone: true }).notNull().defaultNow(),
    text: text("text").notNull(),
    photoDocumentId: uuid("photo_document_id"),
    phraseKey: text("phrase_key"),
    composedBy: uuid("composed_by").notNull().default(sql`app.current_user_id()`),
    confirmedBy: uuid("confirmed_by"),
    confirmationReason: text("confirmation_reason"),
    supersedesItemId: uuid("supersedes_item_id"),
    /** For a photo: whether anyone else can be recognised in it (composed only when false). */
    otherPeopleIdentifiable: boolean("other_people_identifiable"),
    ...createdColumns(),
  },
  (t) => [
    unique("feed_item_tenant_person_id_key").on(t.tenantId, t.personId, t.id),
    foreignKey({
      name: "feed_item_person_fk",
      columns: [t.tenantId, t.personId],
      foreignColumns: [person.tenantId, person.id],
    }),
    foreignKey({
      name: "feed_item_photo_fk",
      columns: [t.tenantId, t.photoDocumentId],
      foreignColumns: [document.tenantId, document.id],
    }),
    // A correction replaces an update about the same person.
    foreignKey({
      name: "feed_item_supersedes_fk",
      columns: [t.tenantId, t.personId, t.supersedesItemId],
      foreignColumns: [t.tenantId, t.personId, t.id],
    }),
    staffRef("feed_item_composed_by_fk", t, t.composedBy),
    staffRef("feed_item_confirmed_by_fk", t, t.confirmedBy),
    index("feed_item_person_idx").on(t.tenantId, t.personId, t.occurredAt),
    check("feed_item_kind", sql`kind IN (${sqlList(Object.keys(FEED_ITEM_SECTION_CODES))})`),
    check("feed_item_section", sql`section = ${FEED_SECTION_CASE}`),
    check("feed_item_source_kind", sql`source_kind IN (${sqlList(FEED_SOURCE_KIND_CODES)})`),
    check(
      "feed_item_care_plan_domain",
      sql`(kind = 'care_plan_update') = (care_plan_domain IS NOT NULL)`,
    ),
    check(
      "feed_item_photo",
      sql`(photo_document_id IS NULL OR kind = 'photo')
        AND (kind <> 'photo' OR (photo_document_id IS NOT NULL AND other_people_identifiable = false))`,
    ),
    check(
      "feed_item_confirmation",
      sql`(confirmed_by IS NULL) = (confirmation_reason IS NULL)
        AND (confirmation_reason IS NULL OR btrim(confirmation_reason) <> '')`,
    ),
    check("feed_item_text", sql`char_length(btrim(text)) BETWEEN 1 AND 1000`),
    check("feed_item_order", sql`occurred_at <= composed_at`),
  ],
);

/** An update taken down (rule 4; `checkFeedWithdrawal`): once, with a known reason, by whom, when. */
export const feedItemWithdrawal = pgTable(
  "feed_item_withdrawal",
  {
    id: id(),
    tenantId: tenantId(),
    personId: uuid("person_id").notNull(),
    feedItemId: uuid("feed_item_id").notNull(),
    reason: text("reason").notNull(),
    withdrawnBy: uuid("withdrawn_by").notNull().default(sql`app.current_user_id()`),
    withdrawnAt: timestamp("withdrawn_at", { withTimezone: true }).notNull().defaultNow(),
    ...createdColumns(),
  },
  (t) => [
    uniqueIndex("feed_item_withdrawal_once_key").on(t.tenantId, t.feedItemId),
    foreignKey({
      name: "feed_item_withdrawal_item_fk",
      columns: [t.tenantId, t.personId, t.feedItemId],
      foreignColumns: [feedItem.tenantId, feedItem.personId, feedItem.id],
    }),
    staffRef("feed_item_withdrawal_by_fk", t, t.withdrawnBy),
    check("feed_item_withdrawal_reason", sql`reason IN (${sqlList(FEED_WITHDRAWAL_REASON_CODES)})`),
  ],
);

/**
 * One view of one update by one family member (rule 4, the exposure history): the decision that
 * allowed it and the section, status and capacity finding then. Append-only.
 */
export const feedView = pgTable(
  "feed_view",
  {
    id: id(),
    tenantId: tenantId(),
    personId: uuid("person_id").notNull(),
    feedItemId: uuid("feed_item_id").notNull(),
    contactId: uuid("contact_id").notNull(),
    sharingDecisionId: uuid("sharing_decision_id").notNull(),
    section: text("section").notNull(),
    carePlanDomain: text("care_plan_domain"),
    personStatus: text("person_status").notNull(),
    capacityForSharing: text("capacity_for_sharing").notNull(),
    viewedBy: uuid("viewed_by").notNull().default(sql`app.current_user_id()`),
    viewedAt: timestamp("viewed_at", { withTimezone: true }).notNull().defaultNow(),
    ...createdColumns(),
  },
  (t) => [
    foreignKey({
      name: "feed_view_item_fk",
      columns: [t.tenantId, t.personId, t.feedItemId],
      foreignColumns: [feedItem.tenantId, feedItem.personId, feedItem.id],
    }),
    foreignKey({
      name: "feed_view_contact_fk",
      columns: [t.tenantId, t.personId, t.contactId],
      foreignColumns: [contact.tenantId, contact.personId, contact.id],
    }),
    foreignKey({
      name: "feed_view_decision_fk",
      columns: [t.tenantId, t.personId, t.sharingDecisionId],
      foreignColumns: [sharingDecision.tenantId, sharingDecision.personId, sharingDecision.id],
    }),
    staffRef("feed_view_viewed_by_fk", t, t.viewedBy),
    index("feed_view_item_idx").on(t.tenantId, t.feedItemId, t.viewedBy),
    check(
      "feed_view_capacity",
      sql`capacity_for_sharing IN ('presumed', 'assessed_has_capacity', 'assessed_lacks_capacity')`,
    ),
  ],
);
