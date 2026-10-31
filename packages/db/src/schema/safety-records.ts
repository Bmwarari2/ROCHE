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
  primaryKey,
  text,
  timestamp,
  unique,
  uuid,
} from "drizzle-orm/pg-core";
import { id, mutableColumns, tenantId } from "./_columns";
import { person } from "./people";
import { document, location, tenantUser } from "./platform";

/**
 * Complaints and compliments (Phase 2 slice 18; safety.md Phase 2 rule 2; SAFE-011; Regulation 16
 * of the Health and Social Care Act 2008 (Regulated Activities) Regulations 2014). A complaint runs
 * the complaint workflow (`COMPLAINT_WORKFLOW`) with the tenant's acknowledgement and response
 * targets in working days, paused while waiting for the complainant; its response signposts the
 * Local Government and Social Care Ombudsman. A compliment never runs a clock and may be tagged
 * with the quality statements it is evidence for (the evidence library, slice 14, links from it).
 * Reading and writing need `safety.complaint.manage` where the record is (migration 0080).
 */

export const COMPLAINT_STATES = [
  "received",
  "acknowledged",
  "investigating",
  "responded",
  "appealed",
  "appeal_responded",
  "closed",
] as const;
export const COMPLAINANT_RELATIONSHIPS = [
  "person_using_service",
  "family_or_friend",
  "representative",
  "professional",
  "member_of_public",
  "other",
] as const;
export const COMPLAINT_CHANNELS = ["in_person", "phone", "email", "letter", "other"] as const;
const list = (values: readonly string[]) => sql.raw(values.map((v) => `'${v}'`).join(", "));

export const complaint = pgTable(
  "complaint",
  {
    id: id(),
    tenantId: tenantId(),
    locationId: uuid("location_id").notNull(),
    /** The person using the service it is about, when it is about one. */
    personId: uuid("person_id"),
    complainantName: text("complainant_name").notNull(),
    complainantRelationship: text("complainant_relationship").notNull(),
    /** How to reach them (an address, email or phone), as they gave it. */
    complainantContact: text("complainant_contact"),
    channel: text("channel").notNull(),
    receivedAt: timestamp("received_at", { withTimezone: true }).notNull(),
    /** When the complainant first knew of the matter: the Ombudsman's time limit runs from here. */
    knewOfMatterOn: date("knew_of_matter_on").notNull(),
    summary: text("summary").notNull(),
    state: text("state").notNull().default("received"),
    /** [{ from, to, reason }] UK dates, inclusive: waiting for consent or information. */
    pauses: jsonb("pauses").notNull().default(sql`'[]'::jsonb`),
    acknowledgedAt: timestamp("acknowledged_at", { withTimezone: true }),
    /** { outcome, actionsTaken, ombudsmanSignposted, documentId } (complaintResponseProblems). */
    response: jsonb("response"),
    respondedAt: timestamp("responded_at", { withTimezone: true }),
    appealReceivedAt: timestamp("appeal_received_at", { withTimezone: true }),
    appealReason: text("appeal_reason"),
    appealResponse: jsonb("appeal_response"),
    appealRespondedAt: timestamp("appeal_responded_at", { withTimezone: true }),
    closedReason: text("closed_reason"),
    closedAt: timestamp("closed_at", { withTimezone: true }),
    recordedBy: uuid("recorded_by").notNull(),
    retentionClass: text("retention_class").notNull().default("complaint"),
    ...mutableColumns(),
  },
  (t) => [
    unique("complaint_tenant_id_id_key").on(t.tenantId, t.id),
    foreignKey({
      name: "complaint_location_fk",
      columns: [t.tenantId, t.locationId],
      foreignColumns: [location.tenantId, location.id],
    }),
    foreignKey({
      name: "complaint_person_fk",
      columns: [t.tenantId, t.personId],
      foreignColumns: [person.tenantId, person.id],
    }),
    foreignKey({
      name: "complaint_recorded_by_fk",
      columns: [t.tenantId, t.recordedBy],
      foreignColumns: [tenantUser.tenantId, tenantUser.id],
    }),
    check("complaint_state", sql`state IN (${list(COMPLAINT_STATES)})`),
    check(
      "complaint_relationship",
      sql`complainant_relationship IN (${list(COMPLAINANT_RELATIONSHIPS)})`,
    ),
    check("complaint_channel", sql`channel IN (${list(COMPLAINT_CHANNELS)})`),
    check("complaint_retention_class", sql`retention_class = 'complaint'`),
    check("complaint_summary", sql`length(btrim(summary)) BETWEEN 3 AND 10000`),
    check("complaint_name", sql`length(btrim(complainant_name)) BETWEEN 1 AND 200`),
    check("complaint_pauses", sql`jsonb_typeof(pauses) = 'array'`),
    check(
      "complaint_closed",
      sql`(state = 'closed') = (closed_at IS NOT NULL AND closed_reason IS NOT NULL)`,
    ),
    index("complaint_location_idx").on(t.tenantId, t.locationId, t.receivedAt),
  ],
);

export const compliment = pgTable(
  "compliment",
  {
    id: id(),
    tenantId: tenantId(),
    locationId: uuid("location_id").notNull(),
    personId: uuid("person_id"),
    fromName: text("from_name").notNull(),
    fromRelationship: text("from_relationship").notNull(),
    receivedAt: timestamp("received_at", { withTimezone: true }).notNull(),
    summary: text("summary").notNull(),
    /** Members of staff it praises. */
    staffIds: uuid("staff_ids").array().notNull().default(sql`'{}'::uuid[]`),
    /** The quality statements it is evidence for (identifiers, for slice 14's evidence links). */
    evidenceStatementIds: text("evidence_statement_ids")
      .array()
      .notNull()
      .default(sql`'{}'::text[]`),
    /** A copy of the card, letter or message, when kept. */
    documentId: uuid("document_id"),
    recordedBy: uuid("recorded_by").notNull(),
    retentionClass: text("retention_class").notNull().default("complaint"),
    ...mutableColumns(),
  },
  (t) => [
    unique("compliment_tenant_id_id_key").on(t.tenantId, t.id),
    foreignKey({
      name: "compliment_location_fk",
      columns: [t.tenantId, t.locationId],
      foreignColumns: [location.tenantId, location.id],
    }),
    foreignKey({
      name: "compliment_person_fk",
      columns: [t.tenantId, t.personId],
      foreignColumns: [person.tenantId, person.id],
    }),
    foreignKey({
      name: "compliment_recorded_by_fk",
      columns: [t.tenantId, t.recordedBy],
      foreignColumns: [tenantUser.tenantId, tenantUser.id],
    }),
    foreignKey({
      name: "compliment_document_fk",
      columns: [t.tenantId, t.documentId],
      foreignColumns: [document.tenantId, document.id],
    }),
    check(
      "compliment_relationship",
      sql`from_relationship IN (${list(COMPLAINANT_RELATIONSHIPS)})`,
    ),
    check("compliment_retention_class", sql`retention_class = 'complaint'`),
    check("compliment_summary", sql`length(btrim(summary)) BETWEEN 3 AND 10000`),
    check("compliment_name", sql`length(btrim(from_name)) BETWEEN 1 AND 200`),
    check(
      "compliment_statements",
      sql`array_position(evidence_statement_ids, NULL) IS NULL AND cardinality(evidence_statement_ids) <= 50`,
    ),
    index("compliment_location_idx").on(t.tenantId, t.locationId, t.receivedAt),
  ],
);

/**
 * Speaking up (Phase 2 slice 24; safety.md Phase 2 rule 3; SAFE-012; ADR-0089). A restricted silo:
 * row-level security opens these tables only to the Freedom to Speak Up lead (the silo permission
 * `safety.speak_up.manage`), the members the lead names on a case, and the reporter of a named or
 * confidential concern; a public request carrying an anonymous concern's reply token sees that one
 * concern. A concern never stores who created it (`created_by` stays empty): a named or confidential
 * reporter is linked only through `speak_up_reporter`, and an anonymous one not at all (migration 0086).
 */

export const SPEAK_UP_IDENTITIES = ["named", "confidential", "anonymous"] as const;
export const SPEAK_UP_CATEGORIES = [
  "care_quality_or_safety",
  "staff_safety",
  "conduct",
  "bullying_or_harassment",
  "fraud_or_finance",
  "other",
] as const;
export const SPEAK_UP_STATES = [
  "received",
  "acknowledged",
  "under_review",
  "outcome_shared",
  "closed",
] as const;

export const speakUpConcern = pgTable(
  "speak_up_concern",
  {
    id: id(),
    tenantId: tenantId(),
    identity: text("identity").notNull(),
    category: text("category").notNull(),
    summary: text("summary").notNull(),
    /** The UK date it arrived: a date only, so the time never lines up with anything else. */
    receivedOn: date("received_on").notNull(),
    state: text("state").notNull().default("received"),
    acknowledgedAt: timestamp("acknowledged_at", { withTimezone: true }),
    /** What happened, as the lead shares it with whoever raised the concern. */
    outcome: text("outcome"),
    outcomeSharedAt: timestamp("outcome_shared_at", { withTimezone: true }),
    closedReason: text("closed_reason"),
    closedAt: timestamp("closed_at", { withTimezone: true }),
    /** SHA-256 of an anonymous reporter's reply token (hex); null when they left no way to reply. */
    replyTokenHash: text("reply_token_hash"),
    /** When the reply token stops opening the concern (`speak_up.reply_token_days` from receipt). */
    replyTokenExpiresAt: timestamp("reply_token_expires_at", { withTimezone: true }),
    /** Its own class, 6 years after the concern closes (H-721; retention.md). */
    retentionClass: text("retention_class").notNull().default("speak_up_concern"),
    ...mutableColumns(),
  },
  (t) => [
    unique("speak_up_concern_tenant_id_id_key").on(t.tenantId, t.id),
    unique("speak_up_concern_reply_token_key").on(t.tenantId, t.replyTokenHash),
    check("speak_up_concern_identity", sql`identity IN (${list(SPEAK_UP_IDENTITIES)})`),
    check("speak_up_concern_category", sql`category IN (${list(SPEAK_UP_CATEGORIES)})`),
    check("speak_up_concern_state", sql`state IN (${list(SPEAK_UP_STATES)})`),
    check("speak_up_concern_summary", sql`length(btrim(summary)) BETWEEN 3 AND 10000`),
    check("speak_up_concern_no_creator", sql`created_by IS NULL`),
    check(
      "speak_up_concern_token",
      sql`reply_token_hash IS NULL OR (identity = 'anonymous' AND reply_token_hash ~ '^[0-9a-f]{64}$')`,
    ),
    check(
      "speak_up_concern_token_expiry",
      sql`(reply_token_hash IS NULL) = (reply_token_expires_at IS NULL)`,
    ),
    check("speak_up_concern_retention_class", sql`retention_class = 'speak_up_concern'`),
    check(
      "speak_up_concern_closed",
      sql`(state = 'closed') = (closed_at IS NOT NULL AND closed_reason IS NOT NULL)`,
    ),
  ],
);

export const speakUpReporter = pgTable(
  "speak_up_reporter",
  {
    tenantId: tenantId(),
    concernId: uuid("concern_id").notNull(),
    tenantUserId: uuid("tenant_user_id").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    unique("speak_up_reporter_concern_key").on(t.tenantId, t.concernId),
    foreignKey({
      name: "speak_up_reporter_concern_fk",
      columns: [t.tenantId, t.concernId],
      foreignColumns: [speakUpConcern.tenantId, speakUpConcern.id],
    }),
    foreignKey({
      name: "speak_up_reporter_member_fk",
      columns: [t.tenantId, t.tenantUserId],
      foreignColumns: [tenantUser.tenantId, tenantUser.id],
    }),
  ],
);

export const speakUpCaseMember = pgTable(
  "speak_up_case_member",
  {
    id: id(),
    tenantId: tenantId(),
    concernId: uuid("concern_id").notNull(),
    tenantUserId: uuid("tenant_user_id").notNull(),
    addedBy: uuid("added_by").notNull(),
    removedAt: timestamp("removed_at", { withTimezone: true }),
    removedBy: uuid("removed_by"),
    ...mutableColumns(),
  },
  (t) => [
    unique("speak_up_case_member_tenant_id_id_key").on(t.tenantId, t.id),
    foreignKey({
      name: "speak_up_case_member_concern_fk",
      columns: [t.tenantId, t.concernId],
      foreignColumns: [speakUpConcern.tenantId, speakUpConcern.id],
    }),
    foreignKey({
      name: "speak_up_case_member_member_fk",
      columns: [t.tenantId, t.tenantUserId],
      foreignColumns: [tenantUser.tenantId, tenantUser.id],
    }),
    foreignKey({
      name: "speak_up_case_member_added_by_fk",
      columns: [t.tenantId, t.addedBy],
      foreignColumns: [tenantUser.tenantId, tenantUser.id],
    }),
    check("speak_up_case_member_removed", sql`(removed_at IS NULL) = (removed_by IS NULL)`),
    index("speak_up_case_member_concern_idx").on(t.tenantId, t.concernId),
  ],
);

export const speakUpMessage = pgTable(
  "speak_up_message",
  {
    id: id(),
    tenantId: tenantId(),
    concernId: uuid("concern_id").notNull(),
    /** From whoever raised the concern (no author kept), or from the lead or a case member. */
    fromReporter: boolean("from_reporter").notNull(),
    authorTenantUserId: uuid("author_tenant_user_id"),
    body: text("body").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    unique("speak_up_message_tenant_id_id_key").on(t.tenantId, t.id),
    foreignKey({
      name: "speak_up_message_concern_fk",
      columns: [t.tenantId, t.concernId],
      foreignColumns: [speakUpConcern.tenantId, speakUpConcern.id],
    }),
    foreignKey({
      name: "speak_up_message_author_fk",
      columns: [t.tenantId, t.authorTenantUserId],
      foreignColumns: [tenantUser.tenantId, tenantUser.id],
    }),
    check("speak_up_message_author", sql`from_reporter = (author_tenant_user_id IS NULL)`),
    check("speak_up_message_body", sql`length(btrim(body)) BETWEEN 1 AND 10000`),
    index("speak_up_message_concern_idx").on(t.tenantId, t.concernId, t.createdAt),
  ],
);

/**
 * Counts of public speak-up requests, so a flood cannot bury a real concern (ADR-0089, security
 * review H1). A bucket is a client network's HMAC (keyed by a secret from the managed store and
 * the day, so it cannot be reversed or followed across days), the organisation's own minute
 * bucket, or the organisation's daily count of anonymous concerns. No personal data; windows
 * that have passed are removed.
 */
export const speakUpIntake = pgTable(
  "speak_up_intake",
  {
    tenantId: tenantId(),
    bucket: text("bucket").notNull(),
    windowStart: timestamp("window_start", { withTimezone: true }).notNull(),
    windowEnd: timestamp("window_end", { withTimezone: true }).notNull(),
    hits: integer("hits").notNull().default(1),
  },
  (t) => [
    primaryKey({ name: "speak_up_intake_pkey", columns: [t.tenantId, t.bucket, t.windowStart] }),
    check("speak_up_intake_bucket", sql`bucket ~ '^(net:[0-9a-f]{64}|tenant|day)$'`),
    check("speak_up_intake_window", sql`window_end > window_start`),
    index("speak_up_intake_end_idx").on(t.tenantId, t.windowEnd),
  ],
);
