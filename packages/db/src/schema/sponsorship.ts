import { sql } from "drizzle-orm";
import {
  boolean,
  check,
  date,
  foreignKey,
  index,
  numeric,
  pgTable,
  text,
  timestamp,
  unique,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { createdColumns, id, mutableColumns, tenantId } from "./_columns";
import { tenant, tenantUser } from "./platform";

/**
 * Sponsor licence records, staff data protection and LDSS claims (workforce.md section 12; slice
 * 35; migration 0097; WORK-003, WORK-007, WORK-011). Sponsor records are HR only
 * (`workforce.immigration.read`, `workforce.sponsor.manage`), never one's own; retention class
 * `staff_file` (tenant's chosen row), with the right to work copies under `right_to_work_copy`.
 */

const memberFk = (name: string, t: { tenantId: never; tenantUserId: never }) =>
  foreignKey({
    name,
    columns: [t.tenantId, t.tenantUserId],
    foreignColumns: [tenantUser.tenantId, tenantUser.id],
  });

/** A sponsored worker: the certificate of sponsorship, visa, pay and the evidence held. */
export const sponsoredWorker = pgTable(
  "sponsored_worker",
  {
    id: id(),
    tenantId: tenantId().references(() => tenant.id),
    tenantUserId: uuid("tenant_user_id").notNull(),
    /** The certificate of sponsorship number, as the Home Office issued it. */
    cosReference: text("cos_reference").notNull(),
    cosAssignedOn: date("cos_assigned_on", { mode: "string" }).notNull(),
    /** SOC 2020 occupation code on the certificate (6135, 6136 and others). */
    socCode: text("soc_code").notNull(),
    /** `skilled_worker`, `health_and_care_worker` or `other`. */
    route: text("route").notNull(),
    visaExpiresOn: date("visa_expires_on", { mode: "string" }).notNull(),
    contractedWeeklyHours: numeric("contracted_weekly_hours", { precision: 5, scale: 2 }).notNull(),
    guaranteedYearlyPay: numeric("guaranteed_yearly_pay", { precision: 10, scale: 2 }).notNull(),
    /** How English language was shown (`ENGLISH_EVIDENCE`), or `not_recorded`. */
    englishEvidence: text("english_evidence").notNull().default("not_recorded"),
    /** The date switching evidence was checked, when the worker switched into the route (H-524). */
    switchingEvidenceOn: date("switching_evidence_on", { mode: "string" }),
    /** Appendix D records held (`APPENDIX_D_ITEMS`). */
    appendixDHeld: text("appendix_d_held").array().notNull().default(sql`'{}'::text[]`),
    /** `active` or `ended`. */
    status: text("status").notNull().default("active"),
    endedOn: date("ended_on", { mode: "string" }),
    ...mutableColumns(),
  },
  (t) => [
    unique("sponsored_worker_tenant_id_id_key").on(t.tenantId, t.id),
    uniqueIndex("sponsored_worker_one_active_key")
      .on(t.tenantId, t.tenantUserId)
      .where(sql`status = 'active' AND deleted_at IS NULL`),
    memberFk("sponsored_worker_member_fk", t as never),
    check(
      "sponsored_worker_route",
      sql`route IN ('skilled_worker', 'health_and_care_worker', 'other')`,
    ),
    check(
      "sponsored_worker_english",
      sql`english_evidence IN ('not_recorded', 'majority_english_speaking_country', 'degree_taught_in_english', 'secure_english_language_test', 'previous_grant')`,
    ),
    check("sponsored_worker_soc", sql`soc_code ~ '^[0-9]{4}$'`),
    check("sponsored_worker_hours", sql`contracted_weekly_hours > 0`),
    check("sponsored_worker_pay", sql`guaranteed_yearly_pay >= 0`),
    check(
      "sponsored_worker_status",
      sql`(status = 'active' AND ended_on IS NULL) OR (status = 'ended' AND ended_on IS NOT NULL)`,
    ),
    check(
      "sponsored_worker_appendix_d",
      sql`appendix_d_held <@ ARRAY['passport_or_travel_document', 'right_to_work_check', 'contact_details', 'certificate_of_sponsorship', 'recruitment_evidence', 'english_language_evidence', 'registration_or_qualification', 'absence_records']::text[]`,
    ),
  ],
);

/** An absence of a sponsored worker, authorised or not (absence monitoring). */
export const sponsorAbsence = pgTable(
  "sponsor_absence",
  {
    id: id(),
    tenantId: tenantId().references(() => tenant.id),
    sponsoredWorkerId: uuid("sponsored_worker_id").notNull(),
    fromOn: date("from_on", { mode: "string" }).notNull(),
    toOn: date("to_on", { mode: "string" }).notNull(),
    authorised: boolean("authorised").notNull(),
    ...mutableColumns(),
  },
  (t) => [
    unique("sponsor_absence_tenant_id_id_key").on(t.tenantId, t.id),
    index("sponsor_absence_worker_idx").on(t.tenantId, t.sponsoredWorkerId),
    foreignKey({
      name: "sponsor_absence_worker_fk",
      columns: [t.tenantId, t.sponsoredWorkerId],
      foreignColumns: [sponsoredWorker.tenantId, sponsoredWorker.id],
    }),
    check("sponsor_absence_dates", sql`to_on >= from_on`),
  ],
);

/** A reportable change and when it was reported on the sponsor management system. */
export const sponsorReport = pgTable(
  "sponsor_report",
  {
    id: id(),
    tenantId: tenantId().references(() => tenant.id),
    sponsoredWorkerId: uuid("sponsored_worker_id").notNull(),
    /** `SPONSOR_REPORT_KINDS`. */
    kind: text("kind").notNull(),
    happenedOn: date("happened_on", { mode: "string" }).notNull(),
    reportedOn: date("reported_on", { mode: "string" }),
    /** The reference the sponsor management system gave. */
    smsReference: text("sms_reference"),
    ...mutableColumns(),
  },
  (t) => [
    unique("sponsor_report_tenant_id_id_key").on(t.tenantId, t.id),
    index("sponsor_report_worker_idx").on(t.tenantId, t.sponsoredWorkerId),
    foreignKey({
      name: "sponsor_report_worker_fk",
      columns: [t.tenantId, t.sponsoredWorkerId],
      foreignColumns: [sponsoredWorker.tenantId, sponsoredWorker.id],
    }),
    check(
      "sponsor_report_kind",
      sql`kind IN ('did_not_start', 'unauthorised_absence', 'employment_ended', 'change_of_job', 'change_of_salary', 'change_of_work_location', 'change_of_hours', 'other')`,
    ),
    check(
      "sponsor_report_reported",
      sql`(reported_on IS NULL) = (sms_reference IS NULL) AND (reported_on IS NULL OR reported_on >= happened_on)`,
    ),
  ],
);

/** A member's acknowledgement of a version of the staff privacy notice (append-only). */
export const staffPrivacyAcknowledgement = pgTable(
  "staff_privacy_acknowledgement",
  {
    id: id(),
    tenantId: tenantId().references(() => tenant.id),
    tenantUserId: uuid("tenant_user_id").notNull(),
    noticeVersion: text("notice_version").notNull(),
    acknowledgedAt: timestamp("acknowledged_at", { withTimezone: true }).notNull().defaultNow(),
    ...createdColumns(),
  },
  (t) => [
    unique("staff_privacy_acknowledgement_tenant_id_id_key").on(t.tenantId, t.id),
    unique("staff_privacy_acknowledgement_once_key").on(
      t.tenantId,
      t.tenantUserId,
      t.noticeVersion,
    ),
    memberFk("staff_privacy_acknowledgement_member_fk", t as never),
    check(
      "staff_privacy_acknowledgement_version",
      sql`length(btrim(notice_version)) BETWEEN 1 AND 40`,
    ),
  ],
);

/** A member's decision on an optional use of their photo or image (append-only; latest wins). */
export const staffImageConsent = pgTable(
  "staff_image_consent",
  {
    id: id(),
    tenantId: tenantId().references(() => tenant.id),
    tenantUserId: uuid("tenant_user_id").notNull(),
    /** `IMAGE_PURPOSES`. */
    purpose: text("purpose").notNull(),
    /** `given`, `refused` or `withdrawn`. */
    decision: text("decision").notNull(),
    decidedAt: timestamp("decided_at", { withTimezone: true }).notNull().defaultNow(),
    ...createdColumns(),
  },
  (t) => [
    unique("staff_image_consent_tenant_id_id_key").on(t.tenantId, t.id),
    index("staff_image_consent_member_idx").on(t.tenantId, t.tenantUserId),
    memberFk("staff_image_consent_member_fk", t as never),
    check(
      "staff_image_consent_purpose",
      sql`purpose IN ('newsletter', 'website', 'social_media', 'family_feed')`,
    ),
    check("staff_image_consent_decision", sql`decision IN ('given', 'refused', 'withdrawn')`),
  ],
);

/** A Learning and Development Support Scheme claim for a member's course. */
export const ldssClaim = pgTable(
  "ldss_claim",
  {
    id: id(),
    tenantId: tenantId().references(() => tenant.id),
    tenantUserId: uuid("tenant_user_id").notNull(),
    courseTitle: text("course_title").notNull(),
    completedOn: date("completed_on", { mode: "string" }),
    /** As the claim states it; Harbour holds no LDSS funding figure (H-903). */
    claimedAmount: numeric("claimed_amount", { precision: 10, scale: 2 }),
    /** `LDSS_STATUSES`. */
    status: text("status").notNull().default("planned"),
    reference: text("reference"),
    submittedOn: date("submitted_on", { mode: "string" }),
    paidOn: date("paid_on", { mode: "string" }),
    reason: text("reason"),
    ...mutableColumns(),
  },
  (t) => [
    unique("ldss_claim_tenant_id_id_key").on(t.tenantId, t.id),
    index("ldss_claim_tenant_status_idx").on(t.tenantId, t.status),
    memberFk("ldss_claim_member_fk", t as never),
    check(
      "ldss_claim_status",
      sql`status IN ('planned', 'submitted', 'paid', 'rejected', 'withdrawn')`,
    ),
    check("ldss_claim_amount", sql`claimed_amount IS NULL OR claimed_amount >= 0`),
    check(
      "ldss_claim_states",
      sql`(status <> 'submitted' OR (reference IS NOT NULL AND submitted_on IS NOT NULL))
        AND (status <> 'paid' OR paid_on IS NOT NULL)
        AND (status NOT IN ('rejected', 'withdrawn') OR reason IS NOT NULL)`,
    ),
  ],
);
