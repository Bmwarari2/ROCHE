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
