import { sql } from "drizzle-orm";
import {
  boolean,
  check,
  foreignKey,
  index,
  pgTable,
  text,
  timestamp,
  unique,
  uuid,
} from "drizzle-orm/pg-core";
import { id, mutableColumns, tenantId } from "./_columns";
import { person } from "./people";
import { location, tenantUser } from "./platform";
import { incident, statutoryNotification } from "./safety";
import { task } from "./work";

/**
 * The safeguarding log (Phase 2 slice 13; SAFE-006; docs/specs/safety.md, Phase 2 rule 1 and the
 * safeguarding log section; Care Act 2014 s.42). One concern about one adult using the service,
 * moving through SAFEGUARDING_WORKFLOW: concern, then no_referral (with a reason) or referred,
 * then enquiry, outcome and closed.
 *
 * Scope is the incident scope of ADR-0033 with the concern's one person: tenant-wide roles, the
 * member of staff who raised it, and anyone who can see the person (`app.incident_in_scope`). The
 * API decides what each reader sees: the full log needs `safety.safeguarding.manage`; staff caring
 * for the person read only the protective measures (HZ-126).
 *
 * Code lists mirror the domain constants; packages/db/test/safeguarding-log.test.ts keeps them in
 * step.
 */

const list = (values: readonly string[]) => sql.raw(values.map((v) => `'${v}'`).join(", "));

/** Care and support statutory guidance 14.17 (`ABUSE_TYPES` in the domain). */
export const SAFEGUARDING_ABUSE_TYPE_SQL = list([
  "physical",
  "domestic",
  "sexual",
  "psychological",
  "financial_or_material",
  "modern_slavery",
  "discriminatory",
  "organisational",
  "neglect",
  "self_neglect",
]);

/** `SafeguardingState` in the domain. */
export const SAFEGUARDING_STATE_SQL = list([
  "concern",
  "no_referral",
  "referred",
  "enquiry",
  "outcome",
  "closed",
]);

/** `ENQUIRY_FINDINGS` in the domain. */
export const SAFEGUARDING_FINDING_SQL = list([
  "substantiated",
  "partly_substantiated",
  "not_substantiated",
  "inconclusive",
  "no_s42_enquiry",
]);

export const safeguardingConcern = pgTable(
  "safeguarding_concern",
  {
    id: id(),
    tenantId: tenantId(),
    locationId: uuid("location_id").notNull(),
    /** The adult at risk: a person using the service. */
    personId: uuid("person_id").notNull(),
    /** The incident it came from, if any. */
    incidentId: uuid("incident_id"),
    /** The Phase 1 s.42 draft it was opened from (`safeguarding_s42`), if any. */
    notificationId: uuid("notification_id"),
    /** The pressure-ulcer adult safeguarding decision guide task it came from, if any. */
    decisionGuideTaskId: uuid("decision_guide_task_id"),
    /** One or more of the ten types (statutory guidance 14.17). */
    abuseTypes: text("abuse_types").array().notNull(),
    description: text("description").notNull(),
    /** When the concern was raised: the referral clock starts here. */
    raisedAt: timestamp("raised_at", { withTimezone: true }).notNull(),
    raisedBy: uuid("raised_by").notNull().default(sql`app.current_user_id()`),
    /** `safeguarding.referral_hours` after `raised_at` (a tenant target; the law says without delay). */
    referralDueAt: timestamp("referral_due_at", { withTimezone: true }).notNull(),
    /** Mirrors the `safety.safeguarding` workflow. */
    state: text("state").notNull().default("concern"),
    /** Who decided not to refer, and why (never silently). */
    noReferralReason: text("no_referral_reason"),
    noReferralDecidedBy: uuid("no_referral_decided_by"),
    referralLocalAuthority: text("referral_local_authority"),
    /** `phone`, `online_form`, `email` or `in_person`. */
    referralMethod: text("referral_method"),
    referredAt: timestamp("referred_at", { withTimezone: true }),
    referralReference: text("referral_reference"),
    /** `s42_local_authority` or `s42_caused_to_provider`. */
    enquiryKind: text("enquiry_kind"),
    enquiryOpenedAt: timestamp("enquiry_opened_at", { withTimezone: true }),
    finding: text("finding"),
    findingRecordedAt: timestamp("finding_recorded_at", { withTimezone: true }),
    /** Making Safeguarding Personal: was the person (or an advocate) asked what they wanted? */
    mspAsked: boolean("msp_asked"),
    mspNotAskedReason: text("msp_not_asked_reason"),
    mspDesiredOutcomes: text("msp_desired_outcomes"),
    /** `fully`, `partly` or `not`. */
    mspAchieved: text("msp_achieved"),
    /**
     * Whether a member of staff was involved and removed from regulated activity for harm or risk
     * of harm (SVGA 2006 s.35): `removed`, `would_have_removed` (left before they could be),
     * `not_removed` or `no_staff_involved`. Unanswered (null) until a manager answers it, which is
     * needed before the outcome and before the concern ends.
     */
    staffHarm: text("staff_harm"),
    /** `referred` or `not_required` (Safeguarding Vulnerable Groups Act 2006 s.35). */
    dbsDecision: text("dbs_decision"),
    dbsReason: text("dbs_reason"),
    dbsDecidedAt: timestamp("dbs_decided_at", { withTimezone: true }),
    /** What staff caring for the person must do to keep them safe (HZ-126). */
    protectiveMeasures: text("protective_measures"),
    protectiveMeasuresUpdatedAt: timestamp("protective_measures_updated_at", {
      withTimezone: true,
    }),
    /** Before the concern ends: the measures were carried into the care plan or risk assessment, or are no longer needed. */
    measuresOutcome: text("measures_outcome"),
    closedAt: timestamp("closed_at", { withTimezone: true }),
    closedBy: uuid("closed_by"),
    closedReason: text("closed_reason"),
    /** When the overdue-referral alert went out (once; the escalation chain takes it from there). */
    overdueNotifiedAt: timestamp("overdue_notified_at", { withTimezone: true }),
    retentionClass: text("retention_class").notNull().default("serious_incident"),
    ...mutableColumns(),
  },
  (t) => [
    unique("safeguarding_concern_tenant_id_id_key").on(t.tenantId, t.id),
    unique("safeguarding_concern_notification_key").on(t.tenantId, t.notificationId),
    foreignKey({
      name: "safeguarding_concern_location_fk",
      columns: [t.tenantId, t.locationId],
      foreignColumns: [location.tenantId, location.id],
    }),
    foreignKey({
      name: "safeguarding_concern_person_fk",
      columns: [t.tenantId, t.personId],
      foreignColumns: [person.tenantId, person.id],
    }),
    foreignKey({
      name: "safeguarding_concern_incident_fk",
      columns: [t.tenantId, t.incidentId],
      foreignColumns: [incident.tenantId, incident.id],
    }),
    foreignKey({
      name: "safeguarding_concern_notification_fk",
      columns: [t.tenantId, t.notificationId],
      foreignColumns: [statutoryNotification.tenantId, statutoryNotification.id],
    }),
    foreignKey({
      name: "safeguarding_concern_decision_guide_fk",
      columns: [t.tenantId, t.decisionGuideTaskId],
      foreignColumns: [task.tenantId, task.id],
    }),
    foreignKey({
      name: "safeguarding_concern_raised_by_fk",
      columns: [t.tenantId, t.raisedBy],
      foreignColumns: [tenantUser.tenantId, tenantUser.id],
    }),
    foreignKey({
      name: "safeguarding_concern_no_referral_by_fk",
      columns: [t.tenantId, t.noReferralDecidedBy],
      foreignColumns: [tenantUser.tenantId, tenantUser.id],
    }),
    foreignKey({
      name: "safeguarding_concern_closed_by_fk",
      columns: [t.tenantId, t.closedBy],
      foreignColumns: [tenantUser.tenantId, tenantUser.id],
    }),
    check(
      "safeguarding_concern_abuse_types",
      sql`cardinality(abuse_types) > 0 AND abuse_types <@ ARRAY[${SAFEGUARDING_ABUSE_TYPE_SQL}]::text[]`,
    ),
    check("safeguarding_concern_state", sql`state IN (${SAFEGUARDING_STATE_SQL})`),
    check(
      "safeguarding_concern_no_referral",
      sql`state <> 'no_referral' OR (no_referral_reason IS NOT NULL AND no_referral_decided_by IS NOT NULL)`,
    ),
    check(
      "safeguarding_concern_referral",
      sql`state NOT IN ('referred', 'enquiry') OR (referred_at IS NOT NULL AND referral_local_authority IS NOT NULL)`,
    ),
    check(
      "safeguarding_concern_referral_method",
      sql`referral_method IS NULL OR referral_method IN ('phone', 'online_form', 'email', 'in_person')`,
    ),
    check(
      "safeguarding_concern_enquiry_kind",
      sql`enquiry_kind IS NULL OR enquiry_kind IN ('s42_local_authority', 's42_caused_to_provider')`,
    ),
    check(
      "safeguarding_concern_enquiry",
      sql`state <> 'enquiry' OR (enquiry_kind IS NOT NULL AND enquiry_opened_at IS NOT NULL)`,
    ),
    check(
      "safeguarding_concern_finding",
      sql`finding IS NULL OR finding IN (${SAFEGUARDING_FINDING_SQL})`,
    ),
    check(
      "safeguarding_concern_outcome",
      sql`state NOT IN ('outcome', 'closed') OR finding IS NOT NULL`,
    ),
    check(
      "safeguarding_concern_msp_achieved",
      sql`msp_achieved IS NULL OR msp_achieved IN ('fully', 'partly', 'not')`,
    ),
    check(
      "safeguarding_concern_dbs_decision",
      sql`dbs_decision IS NULL OR dbs_decision IN ('referred', 'not_required')`,
    ),
    check(
      "safeguarding_concern_dbs",
      sql`(dbs_decision IS NULL) = (dbs_decided_at IS NULL)
        AND (dbs_decision IS DISTINCT FROM 'not_required' OR dbs_reason IS NOT NULL)`,
    ),
    check(
      "safeguarding_concern_staff_harm",
      sql`staff_harm IS NULL OR staff_harm IN ('removed', 'would_have_removed', 'not_removed', 'no_staff_involved')`,
    ),
    // The staff question is answered before the outcome and before the concern ends (HZ-126), and a
    // concern that ends with a member of staff removed, or who would have been, needs the DBS decision.
    check(
      "safeguarding_concern_staff_harm_answered",
      sql`state NOT IN ('outcome', 'no_referral', 'closed') OR staff_harm IS NOT NULL`,
    ),
    check(
      "safeguarding_concern_dbs_before_end",
      sql`state NOT IN ('no_referral', 'closed') OR staff_harm NOT IN ('removed', 'would_have_removed')
        OR dbs_decision IS NOT NULL`,
    ),
    // Making Safeguarding Personal starts at the beginning: the person (or an advocate) is asked
    // before the referral decision, and what they wanted is recorded when they were asked.
    check(
      "safeguarding_concern_msp_before_decision",
      sql`state = 'concern' OR (msp_asked IS NOT NULL
        AND (msp_asked OR msp_not_asked_reason IS NOT NULL)
        AND (NOT msp_asked OR msp_desired_outcomes IS NOT NULL))`,
    ),
    check(
      "safeguarding_concern_measures_outcome",
      sql`measures_outcome IS NULL OR measures_outcome IN ('carried_into_care_plan', 'no_longer_needed')`,
    ),
    // Protective measures never vanish when a concern ends: someone decides where they go.
    check(
      "safeguarding_concern_measures_before_end",
      sql`state NOT IN ('no_referral', 'closed') OR protective_measures IS NULL OR measures_outcome IS NOT NULL`,
    ),
    // Only an ended concern may be soft-deleted (retention), never one still open.
    check(
      "safeguarding_concern_deleted",
      sql`deleted_at IS NULL OR state IN ('no_referral', 'closed')`,
    ),
    check(
      "safeguarding_concern_closed",
      sql`(state = 'closed') = (closed_at IS NOT NULL AND closed_by IS NOT NULL AND closed_reason IS NOT NULL)`,
    ),
    check(
      "safeguarding_concern_msp_before_close",
      sql`state <> 'closed' OR (msp_asked IS NOT NULL
        AND (msp_asked OR msp_not_asked_reason IS NOT NULL)
        AND (NOT msp_asked OR (msp_desired_outcomes IS NOT NULL AND msp_achieved IS NOT NULL)))`,
    ),
    check(
      "safeguarding_concern_measures",
      sql`(protective_measures IS NULL) = (protective_measures_updated_at IS NULL)`,
    ),
    check("safeguarding_concern_due", sql`referral_due_at >= raised_at`),
    check("safeguarding_concern_retention_class", sql`retention_class IN ('serious_incident')`),
    index("safeguarding_concern_person_idx").on(t.tenantId, t.personId),
    index("safeguarding_concern_clock_idx").on(t.tenantId, t.state, t.referralDueAt),
    index("safeguarding_concern_location_idx").on(t.tenantId, t.locationId, t.raisedAt),
  ],
);

export const SAFEGUARDING_MUTABLE_TABLES = ["safeguarding_concern"] as const;

export type SafeguardingConcernRow = typeof safeguardingConcern.$inferSelect;
