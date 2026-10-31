import { sql } from "drizzle-orm";
import {
  type AnyPgColumn,
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
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { sqlList } from "./_codes";
import { createdColumns, id, mutableColumns, tenantId } from "./_columns";
import { location, tenantUser } from "./platform";
import { shift } from "./rota";

/**
 * Time and attendance and working-time records (scheduling.md section 16; SCHED-004, SCHED-003;
 * hazards HZ-010, HZ-124, HZ-011): clock evidence settings, append-only clock events, timesheet
 * entries corrected by superseding, sleep-in awake periods, opt-outs on file and stored working
 * time results. Row-level security and guards are in migration 0109. Lane C owns this file.
 */

export const CLOCK_KIND_CODES = ["in", "out", "break_start", "break_end"] as const;
export const CLOCK_EVIDENCE_CODES = ["none", "at_location", "nfc"] as const;
export const TIMESHEET_KIND_CODES = [
  "work",
  "sleep_in",
  "on_call_at_workplace",
  "on_call_away",
  "training",
  "travel",
] as const;
export const TRAVEL_KIND_CODES = [
  "between_assignments",
  "home_to_first_assignment",
  "last_assignment_to_home",
  "commute_to_fixed_workplace",
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

/** How clock-ins at a location are evidenced: none by default (H-527). No personal data. */
export const clockSetting = pgTable(
  "clock_setting",
  {
    id: id(),
    tenantId: tenantId(),
    locationId: uuid("location_id").notNull(),
    evidence: text("evidence").notNull().default("none"),
    nfcTagRefs: text("nfc_tag_refs").array().notNull().default(sql`'{}'`),
    ...mutableColumns(),
  },
  (t) => [
    unique("clock_setting_location_key").on(t.tenantId, t.locationId),
    locationRef("clock_setting_location_fk", t),
    check("clock_setting_evidence", sql`evidence IN (${sqlList(CLOCK_EVIDENCE_CODES)})`),
  ],
);

/** A clock event (append-only; the client's UUID is the id, so a replay is idempotent). */
export const clockEvent = pgTable(
  "clock_event",
  {
    id: uuid("id").primaryKey(),
    tenantId: tenantId(),
    workerId: uuid("worker_id").notNull(),
    kind: text("kind").notNull(),
    shiftId: uuid("shift_id"),
    locationId: uuid("location_id").notNull(),
    deviceTime: timestamp("device_time", { withTimezone: true }).notNull(),
    recordedAt: timestamp("recorded_at", { withTimezone: true }).notNull().defaultNow(),
    deviceId: text("device_id"),
    evidence: text("evidence").notNull().default("none"),
    nfcTagRef: text("nfc_tag_ref"),
    flags: text("flags").array().notNull().default(sql`'{}'`),
    ...createdColumns(),
  },
  (t) => [
    unique("clock_event_tenant_id_id_key").on(t.tenantId, t.id),
    staffRef("clock_event_worker_fk", t, t.workerId),
    locationRef("clock_event_location_fk", t),
    foreignKey({
      name: "clock_event_shift_fk",
      columns: [t.tenantId, t.shiftId],
      foreignColumns: [shift.tenantId, shift.id],
    }),
    check("clock_event_kind", sql`kind IN (${sqlList(CLOCK_KIND_CODES)})`),
    check("clock_event_evidence", sql`evidence IN (${sqlList(CLOCK_EVIDENCE_CODES)})`),
    check(
      "clock_event_nfc",
      sql`(evidence = 'nfc') = (nfc_tag_ref IS NOT NULL) AND (nfc_tag_ref IS NULL OR char_length(nfc_tag_ref) BETWEEN 1 AND 120)`,
    ),
    index("clock_event_worker_idx").on(t.tenantId, t.workerId, t.deviceTime),
    index("clock_event_location_idx").on(t.tenantId, t.locationId, t.deviceTime),
  ],
);

/**
 * A stretch of time worked: a draft until approved by someone other than the worker, then fixed;
 * corrected by a new entry superseding it. One open correction per entry.
 */
export const timesheetEntry = pgTable(
  "timesheet_entry",
  {
    id: id(),
    tenantId: tenantId(),
    workerId: uuid("worker_id").notNull(),
    locationId: uuid("location_id").notNull(),
    shiftId: uuid("shift_id"),
    kind: text("kind").notNull(),
    startedAt: timestamp("started_at", { withTimezone: true }).notNull(),
    endedAt: timestamp("ended_at", { withTimezone: true }).notNull(),
    breaks: jsonb("breaks").notNull().default(sql`'[]'::jsonb`),
    travel: text("travel"),
    mileageTenths: integer("mileage_tenths"),
    source: text("source").notNull(),
    clockInId: uuid("clock_in_id"),
    clockOutId: uuid("clock_out_id"),
    status: text("status").notNull().default("draft"),
    approvedBy: uuid("approved_by"),
    approvedAt: timestamp("approved_at", { withTimezone: true }),
    supersedesId: uuid("supersedes_id"),
    correctionReason: text("correction_reason"),
    ...mutableColumns(),
  },
  (t) => [
    unique("timesheet_entry_tenant_id_id_key").on(t.tenantId, t.id),
    staffRef("timesheet_entry_worker_fk", t, t.workerId),
    staffRef("timesheet_entry_approved_by_fk", t, t.approvedBy),
    locationRef("timesheet_entry_location_fk", t),
    foreignKey({
      name: "timesheet_entry_shift_fk",
      columns: [t.tenantId, t.shiftId],
      foreignColumns: [shift.tenantId, shift.id],
    }),
    foreignKey({
      name: "timesheet_entry_supersedes_fk",
      columns: [t.tenantId, t.supersedesId],
      foreignColumns: [t.tenantId, t.id],
    }),
    uniqueIndex("timesheet_entry_one_correction_key")
      .on(t.tenantId, t.supersedesId)
      .where(sql`supersedes_id IS NOT NULL AND deleted_at IS NULL`),
    uniqueIndex("timesheet_entry_clock_out_key")
      .on(t.tenantId, t.clockOutId)
      .where(sql`clock_out_id IS NOT NULL AND supersedes_id IS NULL`),
    index("timesheet_entry_worker_idx").on(t.tenantId, t.workerId, t.startedAt),
    index("timesheet_entry_location_idx").on(t.tenantId, t.locationId, t.startedAt),
    check("timesheet_entry_kind", sql`kind IN (${sqlList(TIMESHEET_KIND_CODES)})`),
    check(
      "timesheet_entry_travel",
      sql`(kind = 'travel') = (travel IS NOT NULL) AND (travel IS NULL OR travel IN (${sqlList(TRAVEL_KIND_CODES)}))`,
    ),
    check(
      "timesheet_entry_mileage",
      sql`mileage_tenths IS NULL OR (kind = 'travel' AND mileage_tenths BETWEEN 0 AND 100000)`,
    ),
    check(
      "timesheet_entry_times",
      sql`ended_at > started_at AND ended_at - started_at <= interval '25 hours'`,
    ),
    check("timesheet_entry_source", sql`source IN ('clock', 'manual')`),
    check("timesheet_entry_status", sql`status IN ('draft', 'approved')`),
    check(
      "timesheet_entry_approved",
      sql`(status = 'approved') = (approved_by IS NOT NULL AND approved_at IS NOT NULL) AND (approved_by IS NULL OR approved_by <> worker_id)`,
    ),
    check(
      "timesheet_entry_correction",
      sql`(supersedes_id IS NULL) = (correction_reason IS NULL) AND (correction_reason IS NULL OR char_length(btrim(correction_reason)) BETWEEN 3 AND 500)`,
    ),
    check("timesheet_entry_breaks", sql`jsonb_typeof(breaks) = 'array'`),
  ],
);

/** A time a sleep-in worker was awake for the purposes of working (append-only). */
export const sleepInAwakePeriod = pgTable(
  "sleep_in_awake_period",
  {
    id: id(),
    tenantId: tenantId(),
    timesheetEntryId: uuid("timesheet_entry_id").notNull(),
    startedAt: timestamp("started_at", { withTimezone: true }).notNull(),
    endedAt: timestamp("ended_at", { withTimezone: true }).notNull(),
    ...createdColumns(),
  },
  (t) => [
    foreignKey({
      name: "sleep_in_awake_period_entry_fk",
      columns: [t.tenantId, t.timesheetEntryId],
      foreignColumns: [timesheetEntry.tenantId, timesheetEntry.id],
    }),
    check("sleep_in_awake_period_times", sql`ended_at > started_at`),
  ],
);

/** A worker's signed agreement that the 48-hour limit does not apply (reg 4(1), 5). */
export const workingTimeOptOut = pgTable(
  "working_time_opt_out",
  {
    id: id(),
    tenantId: tenantId(),
    workerId: uuid("worker_id").notNull(),
    signedOn: date("signed_on").notNull(),
    endsOn: date("ends_on"),
    noticeAmount: integer("notice_amount"),
    noticeUnit: text("notice_unit"),
    noticeGivenOn: date("notice_given_on"),
    recordedBy: uuid("recorded_by").notNull(),
    ...mutableColumns(),
  },
  (t) => [
    unique("working_time_opt_out_tenant_id_id_key").on(t.tenantId, t.id),
    staffRef("working_time_opt_out_worker_fk", t, t.workerId),
    staffRef("working_time_opt_out_recorded_by_fk", t, t.recordedBy),
    index("working_time_opt_out_worker_idx").on(t.tenantId, t.workerId),
    check("working_time_opt_out_recorder", sql`recorded_by <> worker_id`),
    check("working_time_opt_out_ends", sql`ends_on IS NULL OR ends_on >= signed_on`),
    check(
      "working_time_opt_out_notice",
      sql`(notice_amount IS NULL) = (notice_unit IS NULL) AND (notice_unit IS NULL OR (notice_unit IN ('days', 'months') AND notice_amount BETWEEN 0 AND 365))`,
    ),
    check(
      "working_time_opt_out_notice_given",
      sql`notice_given_on IS NULL OR notice_given_on >= signed_on`,
    ),
  ],
);

/** A stored run of the working time check, with its inputs' hash (append-only). */
export const workingTimeResult = pgTable(
  "working_time_result",
  {
    id: id(),
    tenantId: tenantId(),
    workerId: uuid("worker_id").notNull(),
    locationId: uuid("location_id"),
    evaluateFrom: date("evaluate_from").notNull(),
    evaluateTo: date("evaluate_to").notNull(),
    findings: jsonb("findings").notNull(),
    breaches: integer("breaches").notNull(),
    conditionals: integer("conditionals").notNull(),
    inputHash: text("input_hash").notNull(),
    trigger: text("trigger").notNull(),
    ...createdColumns(),
  },
  (t) => [
    staffRef("working_time_result_worker_fk", t, t.workerId),
    locationRef("working_time_result_location_fk", t),
    index("working_time_result_worker_idx").on(t.tenantId, t.workerId, t.evaluateTo),
    check("working_time_result_range", sql`evaluate_to >= evaluate_from`),
    check("working_time_result_counts", sql`breaches >= 0 AND conditionals >= 0`),
    check("working_time_result_findings", sql`jsonb_typeof(findings) = 'array'`),
    check("working_time_result_trigger", sql`trigger IN ('timesheet_approved', 'requested')`),
  ],
);
