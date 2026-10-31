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
import { person } from "./people";
import { location, tenant, tenantUser } from "./platform";

/**
 * The breach register and data protection complaints (PLAT-022; platform.md rules 6 to 10 and 18
 * to 26; UK GDPR Arts 33 and 34; DPA 2018 as amended by the Data (Use and Access) Act 2025).
 * Clocks are never stored: they are worked out from these dates and the rate table when read.
 * Interim `audit_event` retention class until the DPO sets periods (H-670).
 */

/** One register entry per personal data breach, reportable or not (Art 33(5)). */
export const dpBreach = pgTable(
  "dp_breach",
  {
    id: id(),
    tenantId: tenantId().references(() => tenant.id),
    /** Where it happened, when it concerns one location; null for the whole organisation. */
    locationId: uuid("location_id"),
    /** `tenant` (found by the organisation) or `processor_notice` (Thapsus told it). */
    source: text("source").notNull(),
    /** What happened, in plain words and without names (the register is not a care record). */
    summary: text("summary").notNull(),
    /** When the organisation became aware: the ICO clock starts here (rule 6). */
    awareAt: timestamp("aware_at", { withTimezone: true }).notNull(),
    occurredAt: timestamp("occurred_at", { withTimezone: true }),
    /** `BreachFactors` as the person assessing recorded them. */
    factors: jsonb("factors"),
    /** `assessBreach`'s suggestion for those factors: decision support only (rule 7). */
    suggestedSeverity: text("suggested_severity"),
    suggestedReportToIco: boolean("suggested_report_to_ico"),
    suggestedTellIndividuals: boolean("suggested_tell_individuals"),
    assessedBy: uuid("assessed_by"),
    assessedAt: timestamp("assessed_at", { withTimezone: true }),
    reportToIco: boolean("report_to_ico"),
    tellIndividuals: boolean("tell_individuals"),
    decisionReasoning: text("decision_reasoning"),
    /** Ticked when the decision goes against the suggestion. */
    acknowledgedSuggestion: boolean("acknowledged_suggestion").notNull().default(false),
    decidedBy: uuid("decided_by"),
    decidedAt: timestamp("decided_at", { withTimezone: true }),
    reportedAt: timestamp("reported_at", { withTimezone: true }),
    icoReference: text("ico_reference"),
    /** Art 33(1): the reasons a report was made after the deadline. */
    delayReason: text("delay_reason"),
    /** The notice to the people affected, as sent (rule 22). */
    subjectNotice: text("subject_notice"),
    individualsToldOn: date("individuals_told_on", { mode: "string" }),
    status: text("status").notNull().default("open"),
    lessons: text("lessons"),
    closedBy: uuid("closed_by"),
    closedAt: timestamp("closed_at", { withTimezone: true }),
    ...mutableColumns(),
  },
  (t) => [
    unique("dp_breach_tenant_id_id_key").on(t.tenantId, t.id),
    index("dp_breach_open_idx").on(t.tenantId, t.status, t.awareAt),
    foreignKey({
      name: "dp_breach_location_fk",
      columns: [t.tenantId, t.locationId],
      foreignColumns: [location.tenantId, location.id],
    }),
    foreignKey({
      name: "dp_breach_assessed_by_fk",
      columns: [t.tenantId, t.assessedBy],
      foreignColumns: [tenantUser.tenantId, tenantUser.id],
    }),
    foreignKey({
      name: "dp_breach_decided_by_fk",
      columns: [t.tenantId, t.decidedBy],
      foreignColumns: [tenantUser.tenantId, tenantUser.id],
    }),
    foreignKey({
      name: "dp_breach_closed_by_fk",
      columns: [t.tenantId, t.closedBy],
      foreignColumns: [tenantUser.tenantId, tenantUser.id],
    }),
    check("dp_breach_source", sql`source IN ('tenant', 'processor_notice')`),
    check("dp_breach_status", sql`status IN ('open', 'closed')`),
    check("dp_breach_summary", sql`char_length(btrim(summary)) BETWEEN 10 AND 4000`),
    check(
      "dp_breach_assessed",
      sql`(factors IS NULL) = (suggested_severity IS NULL)
        AND (factors IS NULL) = (suggested_report_to_ico IS NULL)
        AND (factors IS NULL) = (suggested_tell_individuals IS NULL)
        AND (factors IS NULL) = (assessed_at IS NULL)
        AND (suggested_severity IS NULL OR suggested_severity IN ('low', 'medium', 'high', 'critical'))`,
    ),
    check(
      "dp_breach_decided",
      sql`(decided_at IS NULL) = (report_to_ico IS NULL)
        AND (decided_at IS NULL) = (tell_individuals IS NULL)
        AND (decided_at IS NULL) = (decided_by IS NULL)
        AND (decided_at IS NULL OR (factors IS NOT NULL
          AND char_length(btrim(decision_reasoning)) BETWEEN 20 AND 4000))`,
    ),
    check(
      "dp_breach_reported",
      sql`(reported_at IS NULL) = (ico_reference IS NULL)
        AND (reported_at IS NULL OR report_to_ico IS TRUE)
        AND (ico_reference IS NULL OR char_length(btrim(ico_reference)) BETWEEN 1 AND 100)
        AND (delay_reason IS NULL OR char_length(btrim(delay_reason)) BETWEEN 1 AND 4000)`,
    ),
    check(
      "dp_breach_individuals",
      sql`(individuals_told_on IS NULL) = (subject_notice IS NULL)
        AND (individuals_told_on IS NULL OR tell_individuals IS TRUE)
        AND (subject_notice IS NULL OR char_length(btrim(subject_notice)) BETWEEN 20 AND 10000)`,
    ),
    check(
      "dp_breach_closed",
      sql`(status = 'closed') = (closed_at IS NOT NULL AND closed_by IS NOT NULL)
        AND (status = 'open' OR (decided_at IS NOT NULL
          AND char_length(btrim(lessons)) BETWEEN 20 AND 4000))`,
    ),
  ],
);

/**
 * Thapsus's notice to the organisation as processor (Art 33(2); DPA clause 8.2; rule 24):
 * append-only, written only by `app.send_processor_breach_notice`.
 */
export const processorBreachNotice = pgTable(
  "processor_breach_notice",
  {
    id: id(),
    tenantId: tenantId().references(() => tenant.id),
    breachId: uuid("breach_id").notNull(),
    /** The first notice this one follows up, when facts emerged later. */
    followsId: uuid("follows_id"),
    nature: text("nature").notNull(),
    dataCategories: text("data_categories").notNull(),
    approxPeople: integer("approx_people"),
    approxRecords: integer("approx_records"),
    likelyConsequences: text("likely_consequences").notNull(),
    measures: text("measures").notNull(),
    tenantActions: text("tenant_actions").notNull(),
    contact: text("contact").notNull(),
    /** The Thapsus admin who sent it (operator_user id). */
    sentByOperator: uuid("sent_by_operator").notNull(),
    sentAt: timestamp("sent_at", { withTimezone: true }).notNull().defaultNow(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    unique("processor_breach_notice_tenant_id_id_key").on(t.tenantId, t.id),
    unique("processor_breach_notice_breach_id_key").on(t.tenantId, t.breachId, t.id),
    // A follow-up is about the same breach as the notice it follows, in the same organisation.
    foreignKey({
      name: "processor_breach_notice_follows_fk",
      columns: [t.tenantId, t.breachId, t.followsId],
      foreignColumns: [t.tenantId, t.breachId, t.id],
    }),
    index("processor_breach_notice_breach_idx").on(t.tenantId, t.breachId, t.sentAt),
    foreignKey({
      name: "processor_breach_notice_breach_fk",
      columns: [t.tenantId, t.breachId],
      foreignColumns: [dpBreach.tenantId, dpBreach.id],
    }),
    check(
      "processor_breach_notice_text",
      sql`char_length(btrim(nature)) BETWEEN 10 AND 4000
        AND char_length(btrim(data_categories)) BETWEEN 3 AND 2000
        AND char_length(btrim(likely_consequences)) BETWEEN 3 AND 4000
        AND char_length(btrim(measures)) BETWEEN 3 AND 4000
        AND char_length(btrim(tenant_actions)) BETWEEN 3 AND 4000
        AND char_length(btrim(contact)) BETWEEN 3 AND 500`,
    ),
    check(
      "processor_breach_notice_counts",
      sql`(approx_people IS NULL OR approx_people >= 0)
        AND (approx_records IS NULL OR approx_records >= 0)`,
    ),
  ],
);

/** The organisation's acknowledgement of one processor notice (append-only, once per notice). */
export const processorBreachNoticeAck = pgTable(
  "processor_breach_notice_ack",
  {
    id: id(),
    tenantId: tenantId().references(() => tenant.id),
    noticeId: uuid("notice_id").notNull(),
    acknowledgedBy: uuid("acknowledged_by").notNull().default(sql`app.current_user_id()`),
    acknowledgedAt: timestamp("acknowledged_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    unique("processor_breach_notice_ack_notice_key").on(t.tenantId, t.noticeId),
    foreignKey({
      name: "processor_breach_notice_ack_notice_fk",
      columns: [t.tenantId, t.noticeId],
      foreignColumns: [processorBreachNotice.tenantId, processorBreachNotice.id],
    }),
    foreignKey({
      name: "processor_breach_notice_ack_by_fk",
      columns: [t.tenantId, t.acknowledgedBy],
      foreignColumns: [tenantUser.tenantId, tenantUser.id],
    }),
  ],
);

/** A data protection complaint (DPA 2018 s.164A as amended; rules 9, 10 and 25). */
export const dpComplaint = pgTable(
  "dp_complaint",
  {
    id: id(),
    tenantId: tenantId().references(() => tenant.id),
    locationId: uuid("location_id"),
    receivedOn: date("received_on", { mode: "string" }).notNull(),
    channel: text("channel").notNull(),
    complainantKind: text("complainant_kind").notNull(),
    complainantName: text("complainant_name").notNull(),
    /** How to reach them (email, phone or address), as they gave it. */
    complainantContact: text("complainant_contact"),
    /** The data subject, when it is someone the organisation supports. */
    personId: uuid("person_id"),
    about: text("about").notNull(),
    summary: text("summary").notNull(),
    acknowledgedOn: date("acknowledged_on", { mode: "string" }),
    lastContactOn: date("last_contact_on", { mode: "string" }),
    outcome: text("outcome"),
    icoRightStated: boolean("ico_right_stated").notNull().default(false),
    breachId: uuid("breach_id"),
    status: text("status").notNull().default("open"),
    closedOn: date("closed_on", { mode: "string" }),
    closedBy: uuid("closed_by"),
    ...mutableColumns(),
  },
  (t) => [
    unique("dp_complaint_tenant_id_id_key").on(t.tenantId, t.id),
    index("dp_complaint_open_idx").on(t.tenantId, t.status, t.receivedOn),
    foreignKey({
      name: "dp_complaint_location_fk",
      columns: [t.tenantId, t.locationId],
      foreignColumns: [location.tenantId, location.id],
    }),
    foreignKey({
      name: "dp_complaint_person_fk",
      columns: [t.tenantId, t.personId],
      foreignColumns: [person.tenantId, person.id],
    }),
    foreignKey({
      name: "dp_complaint_breach_fk",
      columns: [t.tenantId, t.breachId],
      foreignColumns: [dpBreach.tenantId, dpBreach.id],
    }),
    foreignKey({
      name: "dp_complaint_closed_by_fk",
      columns: [t.tenantId, t.closedBy],
      foreignColumns: [tenantUser.tenantId, tenantUser.id],
    }),
    check(
      "dp_complaint_channel",
      sql`channel IN ('form', 'email', 'letter', 'phone', 'in_person', 'forwarded_by_thapsus', 'other')`,
    ),
    check(
      "dp_complaint_complainant_kind",
      sql`complainant_kind IN ('person_supported', 'representative', 'family', 'staff', 'other')`,
    ),
    check(
      "dp_complaint_about",
      sql`about IN ('access', 'accuracy', 'sharing', 'security', 'retention', 'other')`,
    ),
    check("dp_complaint_status", sql`status IN ('open', 'closed')`),
    check(
      "dp_complaint_text",
      sql`char_length(btrim(complainant_name)) BETWEEN 1 AND 200
        AND (complainant_contact IS NULL OR char_length(btrim(complainant_contact)) BETWEEN 1 AND 500)
        AND char_length(btrim(summary)) BETWEEN 10 AND 4000`,
    ),
    check(
      "dp_complaint_dates",
      sql`(acknowledged_on IS NULL OR acknowledged_on >= received_on)
        AND (last_contact_on IS NULL OR last_contact_on >= received_on)
        AND (closed_on IS NULL OR closed_on >= received_on)`,
    ),
    check(
      "dp_complaint_closed",
      sql`(status = 'closed') = (closed_on IS NOT NULL AND closed_by IS NOT NULL)
        AND (status = 'open' OR (ico_right_stated
          AND char_length(btrim(outcome)) BETWEEN 20 AND 10000))`,
    ),
  ],
);
