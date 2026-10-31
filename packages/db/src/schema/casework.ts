import { sql } from "drizzle-orm";
import {
  type AnyPgColumn,
  boolean,
  check,
  date,
  foreignKey,
  index,
  pgTable,
  text,
  timestamp,
  unique,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { sqlList } from "./_codes";
import { id, mutableColumns, tenantId } from "./_columns";
import { tenantUser } from "./platform";
import { incident } from "./safety";

/**
 * Employee relations casework (workforce.md section 2c; WORK-010; plan slice 39, migration 0101):
 * grievance, disciplinary, capability, sickness absence and probation cases, their members,
 * hearings and timeline. A restricted silo (ADR-0089): only the members named on a case read it;
 * no role, grant or break-glass reaches it, the owner and the Registered Manager included. A
 * holder of the silo permission `workforce.casework.manage` opens a case and becomes its first
 * case manager. No `capture_version` (record_version is read widely); each change is audited by
 * id. The codes mirror packages/domain (`workforce/casework.ts`), kept in step by
 * test/casework.test.ts.
 */

export const CASE_TYPES = [
  "grievance",
  "disciplinary",
  "capability",
  "sickness_absence",
  "probation",
] as const;
export const CASE_STAGES = [
  "open",
  "investigation",
  "hearing",
  "outcome",
  "appeal",
  "closed",
] as const;
export const CASE_MEMBER_ROLES = [
  "case_manager",
  "investigator",
  "hearing_chair",
  "appeal_chair",
  "note_taker",
  "hr_adviser",
] as const;
export const CASE_OUTCOMES = [
  "upheld",
  "partly_upheld",
  "not_upheld",
  "no_action",
  "first_written_warning",
  "final_written_warning",
  "action_short_of_dismissal",
  "dismissal",
  "improvement_plan",
  "redeployment",
  "support_plan",
  "reasonable_adjustments",
  "passed",
  "extended",
  "not_passed",
] as const;
export const APPEAL_OUTCOMES = ["upheld", "partly_upheld", "not_upheld"] as const;
export const CASE_CLOSING_REASONS = [
  "outcome_accepted",
  "appeal_decided",
  "resolved_informally",
  "no_case_to_answer",
  "withdrawn",
  "left_employment",
] as const;
export const REFERRAL_DECISIONS = ["referred", "not_required"] as const;
export const REFERRAL_NOT_REQUIRED_REASONS = [
  "harm_test_not_met",
  "not_regulated_activity",
  "referred_by_another_body",
  "other_recorded_in_case",
] as const;
export const INDEPENDENCE_EXCEPTIONS = ["no_other_manager_available"] as const;
export const HEARING_KINDS = ["investigation_meeting", "hearing", "appeal_hearing"] as const;
export const HEARING_STATES = [
  "scheduled",
  "held",
  "not_attended",
  "postponed",
  "cancelled",
] as const;
export const POSTPONEMENT_REASONS = [
  "companion_unavailable",
  "employee_unwell",
  "employer_request",
  "other",
] as const;
export const CASE_EVENT_KINDS = [
  "opened",
  "stage_changed",
  "member_added",
  "member_removed",
  "hearing_arranged",
  "hearing_updated",
  "suspension_started",
  "suspension_reviewed",
  "suspension_ended",
  "referral_recorded",
  "safeguarding_linked",
  "appeal_grounds",
  "note",
] as const;

const ref = (
  name: string,
  t: { tenantId: AnyPgColumn },
  column: AnyPgColumn,
  target: { tenantId: AnyPgColumn; id: AnyPgColumn },
) =>
  foreignKey({ name, columns: [t.tenantId, column], foreignColumns: [target.tenantId, target.id] });

/** A referral decision (rule 17): none yet, referred on a date, or not required with a reason. */
const referral = (prefix: "dbs" | "regulator") => {
  const c = (name: string) => sql.raw(`${prefix}_referral${name}`);
  return sql`(${c("")} IS NULL AND ${c("_on")} IS NULL AND ${c("_reason")} IS NULL)
    OR (${c("")} = 'referred' AND ${c("_on")} IS NOT NULL AND ${c("_reason")} IS NULL)
    OR (${c("")} = 'not_required' AND ${c("_on")} IS NULL
        AND ${c("_reason")} IN (${sqlList(REFERRAL_NOT_REQUIRED_REASONS)}))`;
};

export const employeeCase = pgTable(
  "employee_case",
  {
    id: id(),
    tenantId: tenantId(),
    caseType: text("case_type").notNull(),
    /** The member of staff the case is about (never a member of it). */
    subjectTenantUserId: uuid("subject_tenant_user_id").notNull(),
    /** Set by the database from the staff profile when opened: on a professional register. */
    subjectRegistered: boolean("subject_registered").notNull().default(false),
    summary: text("summary").notNull(),
    openedOn: date("opened_on").notNull(),
    stage: text("stage").notNull().default("open"),
    /** The day the case reached its current stage (the timeline, rule 15). */
    stageSince: date("stage_since").notNull(),
    outcome: text("outcome"),
    outcomeDecidedOn: date("outcome_decided_on"),
    warningExpiresOn: date("warning_expires_on"),
    appealOutcome: text("appeal_outcome"),
    appealDecidedOn: date("appeal_decided_on"),
    suspendedOn: date("suspended_on"),
    suspensionReviewOn: date("suspension_review_on"),
    closedReason: text("closed_reason"),
    closedOn: date("closed_on"),
    dbsReferral: text("dbs_referral"),
    dbsReferralOn: date("dbs_referral_on"),
    dbsReferralReason: text("dbs_referral_reason"),
    regulatorReferral: text("regulator_referral"),
    regulatorReferralOn: date("regulator_referral_on"),
    regulatorReferralReason: text("regulator_referral_reason"),
    /** The safeguarding concern (an incident in the safeguarding log) the case is linked to. */
    safeguardingIncidentId: uuid("safeguarding_incident_id"),
    ...mutableColumns(),
  },
  (t) => [
    unique("employee_case_tenant_id_id_key").on(t.tenantId, t.id),
    ref("employee_case_subject_fk", t, t.subjectTenantUserId, tenantUser),
    ref("employee_case_incident_fk", t, t.safeguardingIncidentId, incident),
    index("employee_case_subject_idx").on(t.tenantId, t.subjectTenantUserId),
    check("employee_case_type", sql`case_type IN (${sqlList(CASE_TYPES)})`),
    check("employee_case_stage", sql`stage IN (${sqlList(CASE_STAGES)})`),
    check("employee_case_summary", sql`length(btrim(summary)) BETWEEN 3 AND 10000`),
    check(
      "employee_case_outcome",
      sql`(outcome IS NULL AND outcome_decided_on IS NULL)
        OR (outcome IN (${sqlList(CASE_OUTCOMES)}) AND outcome_decided_on IS NOT NULL)`,
    ),
    check(
      "employee_case_warning",
      sql`(warning_expires_on IS NULL) = (outcome IS NULL OR outcome NOT IN ('first_written_warning', 'final_written_warning'))
        AND (warning_expires_on IS NULL OR warning_expires_on > outcome_decided_on)`,
    ),
    check(
      "employee_case_appeal",
      sql`(appeal_outcome IS NULL AND appeal_decided_on IS NULL)
        OR (appeal_outcome IN (${sqlList(APPEAL_OUTCOMES)}) AND appeal_decided_on IS NOT NULL AND outcome IS NOT NULL)`,
    ),
    check(
      "employee_case_suspension",
      sql`(suspended_on IS NULL) = (suspension_review_on IS NULL)
        AND (suspended_on IS NULL OR (case_type = 'disciplinary' AND suspension_review_on > suspended_on))`,
    ),
    check(
      "employee_case_closed",
      sql`(stage = 'closed') = (closed_on IS NOT NULL AND closed_reason IS NOT NULL)
        AND (closed_reason IS NULL OR closed_reason IN (${sqlList(CASE_CLOSING_REASONS)}))
        AND (stage <> 'closed' OR suspended_on IS NULL)`,
    ),
    check("employee_case_dbs_referral", referral("dbs")),
    check("employee_case_regulator_referral", referral("regulator")),
  ],
);

export const employeeCaseMember = pgTable(
  "employee_case_member",
  {
    id: id(),
    tenantId: tenantId(),
    caseId: uuid("case_id").notNull(),
    tenantUserId: uuid("tenant_user_id").notNull(),
    memberRole: text("member_role").notNull(),
    /** Why one person takes two parts of the case (Acas: "where practicable"), or empty. */
    independenceException: text("independence_exception"),
    addedBy: uuid("added_by").notNull(),
    removedAt: timestamp("removed_at", { withTimezone: true }),
    removedBy: uuid("removed_by"),
    ...mutableColumns(),
  },
  (t) => [
    unique("employee_case_member_tenant_id_id_key").on(t.tenantId, t.id),
    ref("employee_case_member_case_fk", t, t.caseId, employeeCase),
    ref("employee_case_member_member_fk", t, t.tenantUserId, tenantUser),
    ref("employee_case_member_added_by_fk", t, t.addedBy, tenantUser),
    ref("employee_case_member_removed_by_fk", t, t.removedBy, tenantUser),
    uniqueIndex("employee_case_member_active_key")
      .on(t.tenantId, t.caseId, t.tenantUserId, t.memberRole)
      .where(sql`removed_at IS NULL`),
    index("employee_case_member_user_idx").on(t.tenantId, t.tenantUserId),
    check("employee_case_member_role", sql`member_role IN (${sqlList(CASE_MEMBER_ROLES)})`),
    check(
      "employee_case_member_exception",
      sql`independence_exception IS NULL OR independence_exception IN (${sqlList(INDEPENDENCE_EXCEPTIONS)})`,
    ),
    check("employee_case_member_removed", sql`(removed_at IS NULL) = (removed_by IS NULL)`),
  ],
);

export const employeeCaseHearing = pgTable(
  "employee_case_hearing",
  {
    id: id(),
    tenantId: tenantId(),
    caseId: uuid("case_id").notNull(),
    kind: text("kind").notNull(),
    /** Who leads it: the investigator, the hearing chair or the appeal chair (a case member). */
    ledBy: uuid("led_by").notNull(),
    invitedOn: date("invited_on").notNull(),
    scheduledAt: timestamp("scheduled_at", { withTimezone: true }).notNull(),
    issueSetOut: boolean("issue_set_out").notNull(),
    evidenceShared: boolean("evidence_shared").notNull(),
    companionRightGiven: boolean("companion_right_given").notNull(),
    state: text("state").notNull().default("scheduled"),
    heldOn: date("held_on"),
    /** Whether the employee was accompanied (recorded when held; never who by). */
    accompanied: boolean("accompanied"),
    postponedReason: text("postponed_reason"),
    ...mutableColumns(),
  },
  (t) => [
    unique("employee_case_hearing_tenant_id_id_key").on(t.tenantId, t.id),
    ref("employee_case_hearing_case_fk", t, t.caseId, employeeCase),
    ref("employee_case_hearing_led_by_fk", t, t.ledBy, tenantUser),
    index("employee_case_hearing_case_idx").on(t.tenantId, t.caseId),
    check("employee_case_hearing_kind", sql`kind IN (${sqlList(HEARING_KINDS)})`),
    check("employee_case_hearing_state", sql`state IN (${sqlList(HEARING_STATES)})`),
    check(
      "employee_case_hearing_held",
      sql`(state = 'held') = (held_on IS NOT NULL) AND (accompanied IS NULL OR state = 'held')`,
    ),
    check(
      "employee_case_hearing_postponed",
      sql`(postponed_reason IS NULL) = (state <> 'postponed')
        AND (postponed_reason IS NULL OR postponed_reason IN (${sqlList(POSTPONEMENT_REASONS)}))`,
    ),
  ],
);

export const employeeCaseEvent = pgTable(
  "employee_case_event",
  {
    id: id(),
    tenantId: tenantId(),
    caseId: uuid("case_id").notNull(),
    kind: text("kind").notNull(),
    fromStage: text("from_stage"),
    toStage: text("to_stage"),
    occurredOn: date("occurred_on").notNull(),
    /** A case member's note, or the appeal's grounds (free text; only on those kinds). */
    body: text("body"),
    recordedBy: uuid("recorded_by").notNull().default(sql`app.current_user_id()`),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    unique("employee_case_event_tenant_id_id_key").on(t.tenantId, t.id),
    ref("employee_case_event_case_fk", t, t.caseId, employeeCase),
    ref("employee_case_event_recorded_by_fk", t, t.recordedBy, tenantUser),
    index("employee_case_event_case_idx").on(t.tenantId, t.caseId, t.createdAt),
    check("employee_case_event_kind", sql`kind IN (${sqlList(CASE_EVENT_KINDS)})`),
    check(
      "employee_case_event_stages",
      sql`(from_stage IS NULL OR from_stage IN (${sqlList(CASE_STAGES)}))
        AND (to_stage IS NULL OR to_stage IN (${sqlList(CASE_STAGES)}))`,
    ),
    check(
      "employee_case_event_body",
      sql`(kind IN ('note', 'appeal_grounds')) = (body IS NOT NULL) AND (body IS NULL OR length(btrim(body)) BETWEEN 1 AND 10000)`,
    ),
  ],
);
