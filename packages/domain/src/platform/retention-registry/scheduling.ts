/**
 * Retention registry: the scheduling context (retention sweeps plan, slice 3). Rota, time and pay
 * records count from the end of the pay reference period (rota_and_timesheet, payroll_export);
 * rotas, shifts and pay runs keep their anonymous row with the personal columns cleared
 * (provisional, H-1560); lone-working records from the session's finish (lone_worker).
 */

import {
  AS_PARENT,
  classes,
  clearColumns,
  col,
  type DateSource,
  derived,
  entry,
  lookup,
  NO_SUBJECT,
  PARENT,
  parentIs,
  payPeriodEnd,
  type RegistryContext,
  type RetentionSubject,
  type RetentionTableEntry,
  rowClass,
  staff,
  staffFileRecord,
} from "./registry";

/** A rota, time or pay record: from the end of the pay reference period holding `date`. */
const rotaRecord = (
  table: string,
  date: DateSource,
  subject: RetentionSubject,
  extra: Partial<Omit<RetentionTableEntry, "table">> = {},
): RetentionTableEntry =>
  entry(
    table,
    classes("rota_and_timesheet"),
    date.from === "parent"
      ? { createdAt: PARENT, periodEndsAt: PARENT }
      : { createdAt: date, periodEndsAt: payPeriodEnd(date) },
    subject,
    { provisional: ["H-1584"], ...extra },
  );

const H1560 = ["H-1560", "H-1584"];

export const SCHEDULING_REGISTRY: RegistryContext = {
  context: "scheduling",
  entries: [
    rotaRecord("rota", col("ends_on"), NO_SUBJECT, {
      method: clearColumns("created_by", "updated_by"),
      provisional: H1560,
    }),
    rotaRecord("rota_publication", col("published_at"), NO_SUBJECT, {
      parent: parentIs("rota", "rota_id"),
      otherSubjects: [staff("published_by")],
    }),
    rotaRecord("shift", col("ends_at"), NO_SUBJECT, {
      parent: parentIs("rota", "rota_id"),
      method: clearColumns("cancel_reason", "created_by", "updated_by"),
      provisional: H1560,
    }),
    rotaRecord("shift_assignment", PARENT, staff("worker_id"), {
      parent: parentIs("shift", "shift_id"),
    }),
    rotaRecord("roster_override", PARENT, staff("worker_id"), {
      parent: parentIs("shift_assignment", "assignment_id"),
    }),
    rotaRecord("shift_cover_need", col("resolved_at"), staff(null), {
      parent: parentIs("shift_assignment", "assignment_id"),
      provisional: ["H-1558", "H-1584"],
    }),
    rotaRecord("agency_booking", lookup("shift", "shift_id", "ends_at"), staff("worker_id"), {
      parent: parentIs("shift_assignment", "assignment_id"),
    }),
    rotaRecord(
      "agency_worker",
      derived("the latest of the worker's bookings (agency_booking.worker_id)", "tenant_user_id"),
      staff("tenant_user_id"),
      {
        note: "An agency worker has no end date: kept from the last booking (provisional, H-1584)",
      },
    ),
    rotaRecord("agency_awr_record", col("to_on"), staff("worker_id")),
    rotaRecord("agency_worker_feedback", col("created_at"), staff("worker_id"), {
      parent: parentIs("agency_booking", "booking_id"),
    }),
    rotaRecord("location_induction", col("inducted_on"), staff("worker_id")),
    rotaRecord("clock_event", col("recorded_at"), staff("worker_id")),
    rotaRecord("timesheet_entry", col("ended_at"), staff("worker_id")),
    rotaRecord("sleep_in_awake_period", PARENT, staff(null), {
      parent: parentIs("timesheet_entry", "timesheet_entry_id"),
    }),
    entry(
      "pay_run",
      classes("rota_and_timesheet"),
      { createdAt: col("period_end"), periodEndsAt: col("period_end") },
      NO_SUBJECT,
      {
        method: clearColumns("calculated_by", "locked_by", "created_by", "updated_by"),
        provisional: ["H-1560"],
      },
    ),
    rotaRecord("pay_run_line", PARENT, staff("member_id"), {
      parent: parentIs("pay_run", "run_id"),
    }),
    rotaRecord("pay_run_exception", PARENT, staff("member_id"), {
      parent: parentIs("pay_run", "run_id"),
    }),
    entry(
      "payroll_export",
      classes("payroll_export"),
      { createdAt: col("exported_at"), periodEndsAt: lookup("pay_run", "run_id", "period_end") },
      NO_SUBJECT,
      { parent: parentIs("pay_run", "run_id"), provisional: ["H-1558"] },
    ),
    entry("payroll_export_result", AS_PARENT, {}, NO_SUBJECT, {
      parent: parentIs("payroll_export", "export_id"),
    }),
    staffFileRecord("pay_profile", "member_id", "tenant_user"),

    entry(
      "absence",
      classes("sickness_absence"),
      { closedAt: col("ends_on") },
      staff("member_id"),
      {
        provisional: ["H-1558"],
        note: "One table for every kind of absence; the class's notes name sickness only (DPO to confirm for other kinds)",
      },
    ),
    entry("fit_note", classes("sickness_absence"), { closedAt: PARENT }, staff(null), {
      parent: parentIs("absence", "absence_id"),
      provisional: ["H-1558"],
    }),
    entry("return_to_work", classes("sickness_absence"), { closedAt: PARENT }, staff("member_id"), {
      parent: parentIs("absence", "absence_id"),
      provisional: ["H-1558"],
    }),
    entry(
      "working_time_opt_out",
      classes("working_time_opt_out"),
      {
        closedAt: derived(
          "ends_on, else the withdrawal (notice_given_on), else the member's leaving date",
          "ends_on",
          "notice_given_on",
          "worker_id",
        ),
      },
      staff("worker_id"),
    ),
    entry(
      "working_time_result",
      classes("working_time_record"),
      { createdAt: col("created_at") },
      staff("worker_id"),
    ),

    entry(
      "lone_worker_session",
      rowClass("retention_class", "lone_worker"),
      { closedAt: col("finished_at") },
      staff("worker_tenant_user_id"),
    ),
    entry("lone_worker_event", classes("lone_worker"), { closedAt: PARENT }, staff(null), {
      parent: parentIs("lone_worker_session", "session_id"),
      provisional: ["H-1557"],
      note: "Routine check-ins included (lone_worker_check_in retired)",
    }),
    entry(
      "lone_worker_alarm",
      rowClass("retention_class", "lone_worker"),
      { closedAt: PARENT },
      staff("worker_tenant_user_id"),
      {
        parent: parentIs("lone_worker_session", "session_id"),
        note: "An alarm that led to an incident is kept with the incident too, by its class",
      },
    ),
    entry(
      "lone_worker_location",
      {
        kind: "not_retained",
        removedBy:
          "the per-minute lone-worker sweep clears the coordinates; the empty row goes with its event",
        rateKey: "lone_worker.location_days",
        at: col("delete_after"),
      },
      {},
      staff(null),
      {
        parent: parentIs("lone_worker_event", "event_id"),
        method: clearColumns("latitude", "longitude", "accuracy_metres"),
      },
    ),

    entry(
      "pulse_survey_participation",
      classes("staff_survey_response"),
      { closedAt: lookup("pulse_survey", "survey_id", "closed_at") },
      staff("member_id"),
      { provisional: ["H-1557"] },
    ),
    entry(
      "pulse_survey_response",
      classes("staff_survey_response"),
      { closedAt: lookup("pulse_survey", "survey_id", "closed_at") },
      NO_SUBJECT,
      { provisional: ["H-1557"], note: "Anonymous answers" },
    ),
    entry(
      "recognition",
      classes("staff_wellbeing"),
      { createdAt: col("created_at") },
      staff("to_member_id"),
      {
        otherSubjects: [staff("from_member_id")],
        provisional: ["H-1557"],
      },
    ),
    entry(
      "wellbeing_check_in",
      classes("staff_wellbeing"),
      { createdAt: col("created_at") },
      staff("member_id"),
      { provisional: ["H-1557"] },
    ),
    entry("dependency_scale_version", classes("organisation_document"), {}, NO_SUBJECT, {
      note: "Organisation material naming its authors; a version a rota rests on is kept as long as that rota (H-711)",
    }),
  ],
};
