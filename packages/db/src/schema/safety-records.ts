import { sql } from "drizzle-orm";
import {
  check,
  date,
  foreignKey,
  index,
  jsonb,
  pgTable,
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
 * Processing purpose B14, complaints and compliments (records of processing; H-700): complaints
 * Art 6(1)(c) under Regulation 16, compliments Art 6(1)(f). Retention class `complaint`.
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
