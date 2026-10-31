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
  uuid,
} from "drizzle-orm/pg-core";
import { sqlList } from "./_codes";
import { createdColumns, id, mutableColumns, tenantId } from "./_columns";
import { location, tenantUser } from "./platform";
import { staffProfile } from "./workforce";

/**
 * Induction, the Care Certificate and leavers (workforce.md section 2d; WORK-004, WORK-013; plan
 * slice 29, migration 0091). Each row belongs to a staff profile and follows the staff file's
 * rules: read by holders of `workforce.staff_file.read` or `.manage` (and the worker, with
 * `workforce.self.read`), written by holders of `workforce.staff_file.manage`, never on their own
 * file. Care Certificate observations are signed by holders of `workforce.competence.observe`,
 * never the worker. The codes mirror packages/domain (`workforce/induction.ts`), kept in step by
 * test/induction.test.ts.
 */

export const CARE_CERTIFICATE_STANDARD_IDS = Array.from(
  { length: 16 },
  (_, i) => `cc${String(i + 1).padStart(2, "0")}`,
);
export const INDUCTION_TICKED_ITEMS = [
  "contract_issued",
  "system_access_set_up",
  "uniform_and_badge",
  "location_induction",
  "fire_safety_briefing",
  "shadowing_signed_off",
] as const;
export const LEAVER_TICKED_ITEMS = ["property_returned", "final_pay_notified"] as const;
export const PROBATION_REVIEW_OUTCOMES = ["on_track", "concerns"] as const;
export const PROBATION_OUTCOMES = ["passed", "extended", "not_passed"] as const;
export const LEAVING_REASONS = [
  "resignation",
  "end_of_fixed_term",
  "retirement",
  "dismissal",
  "redundancy",
  "tupe_transfer_out",
  "death_in_service",
  "other",
] as const;
export const EXIT_INTERVIEW_STATES = ["not_offered", "offered", "declined", "held"] as const;
export const REFERENCE_KINDS = ["factual", "conduct"] as const;
export const REFERENCE_STATES = ["requested", "sent", "declined"] as const;
/**
 * Decline reasons the database accepts: the domain's (H-876 replaced "no consent to share" with
 * "requester not verified"), and the old one kept valid only for requests already declined with it
 * (expand and contract; the API no longer takes it).
 */
export const REFERENCE_DECLINED_REASONS = [
  "no_consent_to_share",
  "not_employed_here",
  "duplicate_request",
  "requester_not_verified",
] as const;

const ref = (
  name: string,
  t: { tenantId: AnyPgColumn },
  column: AnyPgColumn,
  target: { tenantId: AnyPgColumn; id: AnyPgColumn },
) =>
  foreignKey({ name, columns: [t.tenantId, column], foreignColumns: [target.tenantId, target.id] });

export const inductionPlan = pgTable(
  "induction_plan",
  {
    id: id(),
    tenantId: tenantId(),
    staffProfileId: uuid("staff_profile_id").notNull(),
    /** The worker already holds the Care Certificate (or the Level 2 Adult Social Care Certificate). */
    careCertificateHeld: boolean("care_certificate_held").notNull().default(false),
    probationEndsOn: date("probation_ends_on"),
    probationOutcome: text("probation_outcome"),
    probationDecidedOn: date("probation_decided_on"),
    probationDecidedBy: uuid("probation_decided_by"),
    ...mutableColumns(),
  },
  (t) => [
    unique("induction_plan_tenant_id_id_key").on(t.tenantId, t.id),
    unique("induction_plan_profile_key").on(t.tenantId, t.staffProfileId),
    ref("induction_plan_profile_fk", t, t.staffProfileId, staffProfile),
    ref("induction_plan_decided_by_fk", t, t.probationDecidedBy, tenantUser),
    check(
      "induction_plan_probation",
      sql`(probation_outcome IS NULL) = (probation_decided_on IS NULL)
        AND (probation_outcome IS NULL) = (probation_decided_by IS NULL)
        AND (probation_outcome IS NULL OR (probation_outcome IN (${sqlList(PROBATION_OUTCOMES)}) AND probation_ends_on IS NOT NULL))`,
    ),
  ],
);

/** A ticked checklist item, for induction or for leaving (rules 19 and 22). */
export const staffChecklistItem = pgTable(
  "staff_checklist_item",
  {
    id: id(),
    tenantId: tenantId(),
    staffProfileId: uuid("staff_profile_id").notNull(),
    checklist: text("checklist").notNull(),
    kind: text("kind").notNull(),
    doneOn: date("done_on").notNull(),
    doneBy: uuid("done_by").notNull().default(sql`app.current_user_id()`),
    ...createdColumns(),
  },
  (t) => [
    unique("staff_checklist_item_tenant_id_id_key").on(t.tenantId, t.id),
    unique("staff_checklist_item_once_key").on(t.tenantId, t.staffProfileId, t.checklist, t.kind),
    ref("staff_checklist_item_profile_fk", t, t.staffProfileId, staffProfile),
    ref("staff_checklist_item_done_by_fk", t, t.doneBy, tenantUser),
    check(
      "staff_checklist_item_kind",
      sql`(checklist = 'induction' AND kind IN (${sqlList(INDUCTION_TICKED_ITEMS)}))
        OR (checklist = 'leaving' AND kind IN (${sqlList(LEAVER_TICKED_ITEMS)}))`,
    ),
  ],
);

export const shadowShift = pgTable(
  "shadow_shift",
  {
    id: id(),
    tenantId: tenantId(),
    staffProfileId: uuid("staff_profile_id").notNull(),
    shiftOn: date("shift_on").notNull(),
    locationId: uuid("location_id"),
    /** The experienced member of staff the worker shadowed. */
    shadowedId: uuid("shadowed_id").notNull(),
    recordedBy: uuid("recorded_by").notNull().default(sql`app.current_user_id()`),
    ...createdColumns(),
  },
  (t) => [
    unique("shadow_shift_tenant_id_id_key").on(t.tenantId, t.id),
    ref("shadow_shift_profile_fk", t, t.staffProfileId, staffProfile),
    ref("shadow_shift_location_fk", t, t.locationId, location),
    ref("shadow_shift_shadowed_fk", t, t.shadowedId, tenantUser),
    ref("shadow_shift_recorded_by_fk", t, t.recordedBy, tenantUser),
    index("shadow_shift_profile_idx").on(t.tenantId, t.staffProfileId),
  ],
);

export const probationReview = pgTable(
  "probation_review",
  {
    id: id(),
    tenantId: tenantId(),
    staffProfileId: uuid("staff_profile_id").notNull(),
    reviewOn: date("review_on").notNull(),
    reviewerId: uuid("reviewer_id").notNull().default(sql`app.current_user_id()`),
    outcome: text("outcome").notNull(),
    notes: text("notes"),
    ...createdColumns(),
  },
  (t) => [
    unique("probation_review_tenant_id_id_key").on(t.tenantId, t.id),
    ref("probation_review_profile_fk", t, t.staffProfileId, staffProfile),
    ref("probation_review_reviewer_fk", t, t.reviewerId, tenantUser),
    index("probation_review_profile_idx").on(t.tenantId, t.staffProfileId),
    check("probation_review_outcome", sql`outcome IN (${sqlList(PROBATION_REVIEW_OUTCOMES)})`),
    check("probation_review_notes", sql`notes IS NULL OR length(btrim(notes)) BETWEEN 1 AND 4000`),
  ],
);

export const careCertificateProgress = pgTable(
  "care_certificate_progress",
  {
    id: id(),
    tenantId: tenantId(),
    staffProfileId: uuid("staff_profile_id").notNull(),
    standardId: text("standard_id").notNull(),
    knowledgeAssessedOn: date("knowledge_assessed_on").notNull(),
    knowledgeAssessedBy: uuid("knowledge_assessed_by").notNull(),
    observedOn: date("observed_on"),
    observedBy: uuid("observed_by"),
    ...mutableColumns(),
  },
  (t) => [
    unique("care_certificate_progress_tenant_id_id_key").on(t.tenantId, t.id),
    unique("care_certificate_progress_standard_key").on(t.tenantId, t.staffProfileId, t.standardId),
    ref("care_certificate_progress_profile_fk", t, t.staffProfileId, staffProfile),
    ref("care_certificate_progress_assessor_fk", t, t.knowledgeAssessedBy, tenantUser),
    ref("care_certificate_progress_observer_fk", t, t.observedBy, tenantUser),
    check(
      "care_certificate_progress_standard",
      sql`standard_id IN (${sqlList(CARE_CERTIFICATE_STANDARD_IDS)})`,
    ),
    check(
      "care_certificate_progress_observed",
      sql`(observed_on IS NULL) = (observed_by IS NULL)
        AND (observed_on IS NULL OR observed_on >= knowledge_assessed_on)`,
    ),
  ],
);

export const leaverRecord = pgTable(
  "leaver_record",
  {
    id: id(),
    tenantId: tenantId(),
    staffProfileId: uuid("staff_profile_id").notNull(),
    leavingOn: date("leaving_on").notNull(),
    reason: text("reason").notNull(),
    /** When access ended: by the sweep the day after leaving (no member), or by a manager at once. */
    accessRemovedAt: timestamp("access_removed_at", { withTimezone: true }),
    accessRemovedBy: uuid("access_removed_by"),
    exitInterview: text("exit_interview").notNull().default("not_offered"),
    exitInterviewOn: date("exit_interview_on"),
    /** What the leaver said, in a manager's words (free text; the leaver sees it). */
    exitInterviewSummary: text("exit_interview_summary"),
    /** How long the staff file is kept (rule 23); empty while it cannot be worked out. */
    staffFileRetainUntil: date("staff_file_retain_until"),
    ...mutableColumns(),
  },
  (t) => [
    unique("leaver_record_tenant_id_id_key").on(t.tenantId, t.id),
    unique("leaver_record_profile_key").on(t.tenantId, t.staffProfileId),
    ref("leaver_record_profile_fk", t, t.staffProfileId, staffProfile),
    ref("leaver_record_removed_by_fk", t, t.accessRemovedBy, tenantUser),
    check("leaver_record_reason", sql`reason IN (${sqlList(LEAVING_REASONS)})`),
    check(
      "leaver_record_exit_interview",
      sql`exit_interview IN (${sqlList(EXIT_INTERVIEW_STATES)})
        AND (exit_interview_on IS NULL) = (exit_interview <> 'held')
        AND (exit_interview_summary IS NULL OR (exit_interview = 'held' AND length(btrim(exit_interview_summary)) BETWEEN 1 AND 4000))`,
    ),
    check("leaver_record_access", sql`access_removed_by IS NULL OR access_removed_at IS NOT NULL`),
  ],
);

export const referenceRequest = pgTable(
  "reference_request",
  {
    id: id(),
    tenantId: tenantId(),
    staffProfileId: uuid("staff_profile_id").notNull(),
    requestedOn: date("requested_on").notNull(),
    /** The organisation asking (a prospective employer); never a person's name. */
    requester: text("requester").notNull(),
    kind: text("kind").notNull(),
    state: text("state").notNull().default("requested"),
    sentOn: date("sent_on"),
    sentBy: uuid("sent_by"),
    declinedReason: text("declined_reason"),
    ...mutableColumns(),
  },
  (t) => [
    unique("reference_request_tenant_id_id_key").on(t.tenantId, t.id),
    ref("reference_request_profile_fk", t, t.staffProfileId, staffProfile),
    ref("reference_request_sent_by_fk", t, t.sentBy, tenantUser),
    index("reference_request_profile_idx").on(t.tenantId, t.staffProfileId),
    check("reference_request_requester", sql`length(btrim(requester)) BETWEEN 2 AND 200`),
    check("reference_request_kind", sql`kind IN (${sqlList(REFERENCE_KINDS)})`),
    check(
      "reference_request_state",
      sql`state IN (${sqlList(REFERENCE_STATES)})
        AND (state = 'sent') = (sent_on IS NOT NULL AND sent_by IS NOT NULL)
        AND (state = 'declined') = (declined_reason IS NOT NULL)
        AND (declined_reason IS NULL OR declined_reason IN (${sqlList(REFERENCE_DECLINED_REASONS)}))`,
    ),
  ],
);
