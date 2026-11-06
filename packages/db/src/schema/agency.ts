import { sql } from "drizzle-orm";
import {
  type AnyPgColumn,
  boolean,
  check,
  date,
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
import { location, tenantUser } from "./platform";
import { shift, shiftAssignment } from "./rota";

/**
 * Bank and agency workers (scheduling.md section 15; SCHED-009; ADR-0088; hazards HZ-124 and
 * HZ-011): agencies, their workers and the organisation's bank staff, bookings of open shifts,
 * inductions at a location and feedback. Row-level security, the access window over role rows and
 * the guards are in migration 0104. Lane C owns this file. Retention `rota_and_timesheet`.
 */

export const AGENCY_WORKER_KINDS = ["agency", "bank"] as const;
export const AGENCY_BOOKING_STATUSES = ["confirmed", "cancelled"] as const;
export const AGENCY_FEEDBACK_KINDS = ["positive", "concern", "do_not_rebook"] as const;
/** Why an agency worker had no booking (AWR reg 7(8)), or a new role (reg 7(3)); H-924. */
export const AWR_RECORD_KINDS = ["break_reason", "role_change", "withdrawal"] as const;
export const AWR_BREAK_REASON_CODES = [
  "sickness",
  "jury_service",
  "protected_leave",
  "annual_leave",
  "shutdown",
  "industrial_action",
] as const;

const staffRef = (name: string, t: { tenantId: AnyPgColumn }, column: AnyPgColumn) =>
  foreignKey({
    name,
    columns: [t.tenantId, column],
    foreignColumns: [tenantUser.tenantId, tenantUser.id],
  });
const locationRef = (name: string, t: { tenantId: AnyPgColumn; locationId: AnyPgColumn }) =>
  foreignKey({
    name,
    columns: [t.tenantId, t.locationId],
    foreignColumns: [location.tenantId, location.id],
  });

/** An agency the organisation books from: its own counterparty (H-547). */
export const agency = pgTable(
  "agency",
  {
    id: id(),
    tenantId: tenantId(),
    name: text("name").notNull(),
    /** The agency's business address for bookings. */
    contactEmail: text("contact_email"),
    frameworkRef: text("framework_ref"),
    defaultChargePencePerHour: integer("default_charge_pence_per_hour"),
    archiveReason: text("archive_reason"),
    ...mutableColumns(),
  },
  (t) => [
    unique("agency_tenant_id_id_key").on(t.tenantId, t.id),
    check("agency_name", sql`char_length(btrim(name)) BETWEEN 1 AND 120`),
    check(
      "agency_charge",
      sql`default_charge_pence_per_hour IS NULL OR default_charge_pence_per_hour BETWEEN 1 AND 1000000`,
    ),
    check(
      "agency_archived",
      sql`(deleted_at IS NULL) = (archive_reason IS NULL) AND (archive_reason IS NULL OR btrim(archive_reason) <> '')`,
    ),
  ],
);

/**
 * A bank or agency worker: a member flagged `is_agency`, with the agency's written confirmation of
 * their checks (agency workers only), recorded by someone who is not the worker.
 */
export const agencyWorker = pgTable(
  "agency_worker",
  {
    id: id(),
    tenantId: tenantId(),
    tenantUserId: uuid("tenant_user_id").notNull(),
    kind: text("kind").notNull(),
    agencyId: uuid("agency_id"),
    roleTitle: text("role_title").notNull(),
    dbsConfirmedOn: date("dbs_confirmed_on"),
    dbsEnhancedBarred: boolean("dbs_enhanced_barred").notNull().default(false),
    rightToWorkConfirmedOn: date("right_to_work_confirmed_on"),
    rightToWorkExpiresOn: date("right_to_work_expires_on"),
    registrationBody: text("registration_body"),
    registrationValidUntil: date("registration_valid_until"),
    confirmedBy: uuid("confirmed_by"),
    doNotBook: boolean("do_not_book").notNull().default(false),
    doNotBookReason: text("do_not_book_reason"),
    ...mutableColumns(),
  },
  (t) => [
    unique("agency_worker_tenant_id_id_key").on(t.tenantId, t.id),
    unique("agency_worker_member_key").on(t.tenantId, t.tenantUserId),
    staffRef("agency_worker_member_fk", t, t.tenantUserId),
    staffRef("agency_worker_confirmed_by_fk", t, t.confirmedBy),
    foreignKey({
      name: "agency_worker_agency_fk",
      columns: [t.tenantId, t.agencyId],
      foreignColumns: [agency.tenantId, agency.id],
    }),
    check("agency_worker_kind", sql`kind IN (${sqlList(AGENCY_WORKER_KINDS)})`),
    check("agency_worker_agency", sql`(kind = 'agency') = (agency_id IS NOT NULL)`),
    check("agency_worker_role_title", sql`char_length(btrim(role_title)) BETWEEN 1 AND 80`),
    check(
      "agency_worker_registration",
      sql`registration_body IS NULL OR registration_body IN ('nmc', 'hcpc', 'swe', 'gmc')`,
    ),
    check("agency_worker_confirmed", sql`confirmed_by IS NULL OR confirmed_by <> tenant_user_id`),
    check(
      "agency_worker_do_not_book",
      sql`do_not_book = (do_not_book_reason IS NOT NULL) AND (do_not_book_reason IS NULL OR btrim(do_not_book_reason) <> '')`,
    ),
  ],
);

/** A booked shift for a bank or agency worker: the shift's assignment with the agency's terms. */
export const agencyBooking = pgTable(
  "agency_booking",
  {
    id: id(),
    tenantId: tenantId(),
    shiftId: uuid("shift_id").notNull(),
    assignmentId: uuid("assignment_id").notNull(),
    locationId: uuid("location_id").notNull(),
    workerId: uuid("worker_id").notNull(),
    agencyId: uuid("agency_id"),
    kind: text("kind").notNull(),
    bookingRef: text("booking_ref"),
    chargePencePerHour: integer("charge_pence_per_hour").notNull(),
    costPence: integer("cost_pence").notNull(),
    status: text("status").notNull().default("confirmed"),
    cancelReason: text("cancel_reason"),
    cancelledAt: timestamp("cancelled_at", { withTimezone: true }),
    ...mutableColumns(),
  },
  (t) => [
    unique("agency_booking_tenant_id_id_key").on(t.tenantId, t.id),
    foreignKey({
      name: "agency_booking_shift_fk",
      columns: [t.tenantId, t.shiftId],
      foreignColumns: [shift.tenantId, shift.id],
    }),
    foreignKey({
      name: "agency_booking_assignment_fk",
      columns: [t.tenantId, t.assignmentId],
      foreignColumns: [shiftAssignment.tenantId, shiftAssignment.id],
    }),
    foreignKey({
      name: "agency_booking_agency_fk",
      columns: [t.tenantId, t.agencyId],
      foreignColumns: [agency.tenantId, agency.id],
    }),
    locationRef("agency_booking_location_fk", t),
    staffRef("agency_booking_worker_fk", t, t.workerId),
    uniqueIndex("agency_booking_live_key")
      .on(t.tenantId, t.assignmentId)
      .where(sql`status = 'confirmed'`),
    index("agency_booking_worker_idx").on(t.tenantId, t.workerId),
    check("agency_booking_kind", sql`kind IN (${sqlList(AGENCY_WORKER_KINDS)})`),
    check("agency_booking_agency", sql`(kind = 'agency') = (agency_id IS NOT NULL)`),
    check("agency_booking_status", sql`status IN (${sqlList(AGENCY_BOOKING_STATUSES)})`),
    check(
      "agency_booking_money",
      sql`charge_pence_per_hour BETWEEN 0 AND 1000000 AND cost_pence >= 0`,
    ),
    check(
      "agency_booking_cancelled",
      sql`(status = 'cancelled') = (cancelled_at IS NOT NULL) AND (status = 'cancelled') = (cancel_reason IS NOT NULL)`,
    ),
  ],
);

/** A worker's induction at a location (append-only), by someone who is not the worker. */
export const locationInduction = pgTable(
  "location_induction",
  {
    id: id(),
    tenantId: tenantId(),
    workerId: uuid("worker_id").notNull(),
    locationId: uuid("location_id").notNull(),
    inductedOn: date("inducted_on").notNull(),
    items: text("items").array().notNull(),
    ...createdColumns(),
  },
  (t) => [
    staffRef("location_induction_worker_fk", t, t.workerId),
    locationRef("location_induction_location_fk", t),
    index("location_induction_worker_idx").on(t.tenantId, t.workerId, t.locationId),
    check("location_induction_items", sql`cardinality(items) BETWEEN 1 AND 40`),
  ],
);

/** Feedback on a bank or agency worker after a booking (append-only). */
export const agencyWorkerFeedback = pgTable(
  "agency_worker_feedback",
  {
    id: id(),
    tenantId: tenantId(),
    workerId: uuid("worker_id").notNull(),
    bookingId: uuid("booking_id").notNull(),
    locationId: uuid("location_id").notNull(),
    kind: text("kind").notNull(),
    notes: text("notes").notNull(),
    ...createdColumns(),
  },
  (t) => [
    staffRef("agency_worker_feedback_worker_fk", t, t.workerId),
    foreignKey({
      name: "agency_worker_feedback_booking_fk",
      columns: [t.tenantId, t.bookingId],
      foreignColumns: [agencyBooking.tenantId, agencyBooking.id],
    }),
    locationRef("agency_worker_feedback_location_fk", t),
    check("agency_worker_feedback_kind", sql`kind IN (${sqlList(AGENCY_FEEDBACK_KINDS)})`),
    check("agency_worker_feedback_notes", sql`char_length(btrim(notes)) BETWEEN 1 AND 2000`),
  ],
);

/**
 * The AWR clock's records for an agency worker (append-only; H-924 recommended answer): a reason
 * for days without a booking, a substantively different role with the date the worker was told in
 * writing, or the withdrawal of an earlier record. Recorded by a rota builder, never the worker.
 */
export const agencyAwrRecord = pgTable(
  "agency_awr_record",
  {
    id: id(),
    tenantId: tenantId(),
    workerId: uuid("worker_id").notNull(),
    kind: text("kind").notNull(),
    fromOn: date("from_on"),
    toOn: date("to_on"),
    reason: text("reason"),
    notifiedOn: date("notified_on"),
    withdrawsId: uuid("withdraws_id"),
    note: text("note"),
    ...createdColumns(),
  },
  (t) => [
    unique("agency_awr_record_tenant_id_id_key").on(t.tenantId, t.id),
    staffRef("agency_awr_record_worker_fk", t, t.workerId),
    foreignKey({
      name: "agency_awr_record_withdraws_fk",
      columns: [t.tenantId, t.withdrawsId],
      foreignColumns: [t.tenantId, t.id],
    }),
    uniqueIndex("agency_awr_record_one_withdrawal_key")
      .on(t.tenantId, t.withdrawsId)
      .where(sql`withdraws_id IS NOT NULL`),
    index("agency_awr_record_worker_idx").on(t.tenantId, t.workerId),
    check("agency_awr_record_kind", sql`kind IN (${sqlList(AWR_RECORD_KINDS)})`),
    check(
      "agency_awr_record_shape",
      sql`(kind = 'break_reason' AND from_on IS NOT NULL AND to_on IS NOT NULL AND to_on >= from_on
          AND reason IN (${sqlList(AWR_BREAK_REASON_CODES)}) AND notified_on IS NULL AND withdraws_id IS NULL)
        OR (kind = 'role_change' AND notified_on IS NOT NULL AND from_on IS NULL AND to_on IS NULL
          AND reason IS NULL AND withdraws_id IS NULL)
        OR (kind = 'withdrawal' AND withdraws_id IS NOT NULL AND from_on IS NULL AND to_on IS NULL
          AND reason IS NULL AND notified_on IS NULL)`,
    ),
    check(
      "agency_awr_record_note",
      sql`note IS NULL OR char_length(btrim(note)) BETWEEN 1 AND 500`,
    ),
  ],
);
