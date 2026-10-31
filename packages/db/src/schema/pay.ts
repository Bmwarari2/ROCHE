import { sql } from "drizzle-orm";
import {
  type AnyPgColumn,
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
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { sqlList } from "./_codes";
import { createdColumns, id, mutableColumns, tenantId } from "./_columns";
import { tenantUser } from "./platform";

/**
 * Pay calculation runs (scheduling.md section 18; SCHED-005, 006, 007; HZ-011): the organisation's
 * versioned pay rule sets, each member's pay profile, runs drafted, checked by a second person and
 * locked, their lines (append-only, with canonical inputs and working) and exceptions. Row-level
 * security and guards are in migration 0116. Pay is organisation-wide (rule 13).
 */

export const PAY_FREQUENCY_CODES = ["weekly", "monthly"] as const;
export const PAY_EMPLOYMENT_CODES = ["staff", "bank", "agency"] as const;
export const PAY_EXCEPTION_KIND_CODES = [
  "unapproved_timesheet",
  "no_pay_profile",
  "no_role_rate",
  "no_date_of_birth",
  "below_nmw",
  "ssp_earnings_missing",
  "rate_missing",
] as const;

const staffRef = (name: string, t: { tenantId: AnyPgColumn }, column: AnyPgColumn) =>
  foreignKey({
    name,
    columns: [t.tenantId, column],
    foreignColumns: [tenantUser.tenantId, tenantUser.id],
  });

/** The organisation's own rates (never statutory figures), versioned; fixed once approved. */
export const payRuleSet = pgTable(
  "pay_rule_set",
  {
    id: id(),
    tenantId: tenantId(),
    name: text("name").notNull(),
    versionNumber: integer("version_number").notNull(),
    effectiveFrom: date("effective_from").notNull(),
    /** Pence an hour by role key. */
    roleRates: jsonb("role_rates").notNull(),
    /** `[{ kind, mode, value }]`, as `Enhancement`. */
    enhancements: jsonb("enhancements").notNull().default(sql`'[]'::jsonb`),
    stackEnhancements: boolean("stack_enhancements").notNull().default(false),
    sleepInFlatPence: integer("sleep_in_flat_pence").notNull().default(0),
    mileagePencePerMile: integer("mileage_pence_per_mile").notNull().default(0),
    onCallFlatPence: integer("on_call_flat_pence").notNull().default(0),
    nightStartMinute: integer("night_start_minute"),
    nightEndMinute: integer("night_end_minute"),
    bankHolidays: date("bank_holidays").array().notNull().default(sql`'{}'`),
    overtimeAfterMinutes: integer("overtime_after_minutes"),
    rolledUpHoliday: boolean("rolled_up_holiday").notNull().default(false),
    status: text("status").notNull().default("draft"),
    /** The author and everyone who changed the draft (kept by the database). */
    contributorIds: uuid("contributor_ids").array().notNull().default(sql`'{}'::uuid[]`),
    approvedBy: uuid("approved_by"),
    approvedAt: timestamp("approved_at", { withTimezone: true }),
    ...mutableColumns(),
  },
  (t) => [
    unique("pay_rule_set_tenant_id_id_key").on(t.tenantId, t.id),
    unique("pay_rule_set_version_key").on(t.tenantId, t.versionNumber),
    staffRef("pay_rule_set_approved_by_fk", t, t.approvedBy),
    uniqueIndex("pay_rule_set_one_draft_key").on(t.tenantId).where(sql`status = 'draft'`),
    check("pay_rule_set_status", sql`status IN ('draft', 'approved')`),
    check("pay_rule_set_version", sql`version_number >= 1`),
    check("pay_rule_set_name", sql`char_length(btrim(name)) BETWEEN 1 AND 120`),
    check(
      "pay_rule_set_json",
      sql`jsonb_typeof(role_rates) = 'object' AND jsonb_typeof(enhancements) = 'array'`,
    ),
    check(
      "pay_rule_set_amounts",
      sql`sleep_in_flat_pence >= 0 AND mileage_pence_per_mile >= 0 AND on_call_flat_pence >= 0
        AND (overtime_after_minutes IS NULL OR overtime_after_minutes >= 0)`,
    ),
    check(
      "pay_rule_set_night",
      sql`(night_start_minute IS NULL) = (night_end_minute IS NULL)
        AND (night_start_minute IS NULL OR (night_start_minute BETWEEN 0 AND 1439
          AND night_end_minute BETWEEN 0 AND 1439 AND night_start_minute <> night_end_minute))`,
    ),
    check(
      "pay_rule_set_approved",
      sql`(status = 'approved') = (approved_by IS NOT NULL AND approved_at IS NOT NULL)
        AND (approved_by IS NULL OR NOT approved_by = ANY (contributor_ids))`,
    ),
  ],
);

/** What a member's pay needs that the staff file does not hold. One per member. */
export const payProfile = pgTable(
  "pay_profile",
  {
    id: id(),
    tenantId: tenantId(),
    memberId: uuid("member_id").notNull(),
    frequency: text("frequency").notNull(),
    employment: text("employment").notNull().default("staff"),
    roleKey: text("role_key"),
    apprenticeshipStartedOn: date("apprenticeship_started_on"),
    irregularHours: boolean("irregular_hours").notNull().default(false),
    leaveYearStart: date("leave_year_start"),
    qualifyingWeekdays: integer("qualifying_weekdays").array().notNull().default(sql`'{}'`),
    sspAverageWeeklyEarningsPence: integer("ssp_average_weekly_earnings_pence"),
    statePensionAgeOn: date("state_pension_age_on"),
    ...mutableColumns(),
  },
  (t) => [
    unique("pay_profile_tenant_id_id_key").on(t.tenantId, t.id),
    unique("pay_profile_member_key").on(t.tenantId, t.memberId),
    staffRef("pay_profile_member_fk", t, t.memberId),
    check("pay_profile_frequency", sql`frequency IN (${sqlList(PAY_FREQUENCY_CODES)})`),
    check("pay_profile_employment", sql`employment IN (${sqlList(PAY_EMPLOYMENT_CODES)})`),
    check("pay_profile_role", sql`role_key IS NULL OR role_key ~ '^[a-z][a-z0-9_]{0,59}$'`),
    check("pay_profile_weekdays", sql`qualifying_weekdays <@ ARRAY[1, 2, 3, 4, 5, 6, 7]`),
    check(
      "pay_profile_earnings",
      sql`ssp_average_weekly_earnings_pence IS NULL OR ssp_average_weekly_earnings_pence BETWEEN 0 AND 10000000`,
    ),
  ],
);

/** A pay calculation run for one period: a draft until checked by a second person and locked. */
export const payRun = pgTable(
  "pay_run",
  {
    id: id(),
    tenantId: tenantId(),
    frequency: text("frequency").notNull(),
    periodStart: date("period_start").notNull(),
    periodEnd: date("period_end").notNull(),
    kind: text("kind").notNull().default("regular"),
    correctsRunId: uuid("corrects_run_id"),
    ruleSetId: uuid("rule_set_id").notNull(),
    nation: text("nation").notNull(),
    /** The rate table rows the calculation used, so it reproduces (rule 10). */
    rateRows: jsonb("rate_rows").notNull().default(sql`'[]'::jsonb`),
    calculation: integer("calculation").notNull().default(0),
    calculatedAt: timestamp("calculated_at", { withTimezone: true }),
    calculatedBy: uuid("calculated_by"),
    status: text("status").notNull().default("draft"),
    lockedBy: uuid("locked_by"),
    lockedAt: timestamp("locked_at", { withTimezone: true }),
    ...mutableColumns(),
  },
  (t) => [
    unique("pay_run_tenant_id_id_key").on(t.tenantId, t.id),
    foreignKey({
      name: "pay_run_rule_set_fk",
      columns: [t.tenantId, t.ruleSetId],
      foreignColumns: [payRuleSet.tenantId, payRuleSet.id],
    }),
    foreignKey({
      name: "pay_run_corrects_fk",
      columns: [t.tenantId, t.correctsRunId],
      foreignColumns: [t.tenantId, t.id],
    }),
    staffRef("pay_run_calculated_by_fk", t, t.calculatedBy),
    staffRef("pay_run_locked_by_fk", t, t.lockedBy),
    uniqueIndex("pay_run_one_regular_key")
      .on(t.tenantId, t.frequency, t.periodStart)
      .where(sql`kind = 'regular'`),
    uniqueIndex("pay_run_one_open_correction_key")
      .on(t.tenantId, t.correctsRunId)
      .where(sql`kind = 'correction' AND status = 'draft'`),
    check("pay_run_frequency", sql`frequency IN (${sqlList(PAY_FREQUENCY_CODES)})`),
    check(
      "pay_run_kind",
      sql`(kind = 'correction') = (corrects_run_id IS NOT NULL) AND kind IN ('regular', 'correction')`,
    ),
    check("pay_run_period", sql`period_end >= period_start AND period_end - period_start <= 30`),
    check("pay_run_status", sql`status IN ('draft', 'locked')`),
    check("pay_run_nation", sql`nation IN ('england', 'wales', 'scotland', 'northern_ireland')`),
    check(
      "pay_run_locked",
      sql`(status = 'locked') = (locked_by IS NOT NULL AND locked_at IS NOT NULL)
        AND (status = 'draft' OR calculation >= 1)`,
    ),
    check("pay_run_rate_rows", sql`jsonb_typeof(rate_rows) = 'array'`),
  ],
);

/** One member's line in one calculation of a run (append-only). */
export const payRunLine = pgTable(
  "pay_run_line",
  {
    id: id(),
    tenantId: tenantId(),
    runId: uuid("run_id").notNull(),
    calculation: integer("calculation").notNull(),
    memberId: uuid("member_id").notNull(),
    paidMinutes: integer("paid_minutes").notNull(),
    nmwMinutes: integer("nmw_minutes").notNull(),
    basicPence: integer("basic_pence").notNull(),
    premiumPence: integer("premium_pence").notNull(),
    sleepInPence: integer("sleep_in_pence").notNull(),
    onCallPence: integer("on_call_pence").notNull(),
    mileagePence: integer("mileage_pence").notNull(),
    nmwTopUpPence: integer("nmw_top_up_pence").notNull(),
    rolledUpHolidayPence: integer("rolled_up_holiday_pence").notNull(),
    sspPence: integer("ssp_pence").notNull(),
    totalPence: integer("total_pence").notNull(),
    differencePence: integer("difference_pence"),
    holidayAccruedMinutes: integer("holiday_accrued_minutes"),
    nmwBand: text("nmw_band"),
    aeCategory: text("ae_category"),
    qualifyingEarningsPence: integer("qualifying_earnings_pence"),
    working: jsonb("working").notNull(),
    inputs: jsonb("inputs").notNull(),
    inputHash: text("input_hash").notNull(),
    ...createdColumns(),
  },
  (t) => [
    unique("pay_run_line_tenant_id_id_key").on(t.tenantId, t.id),
    foreignKey({
      name: "pay_run_line_run_fk",
      columns: [t.tenantId, t.runId],
      foreignColumns: [payRun.tenantId, payRun.id],
    }),
    staffRef("pay_run_line_member_fk", t, t.memberId),
    unique("pay_run_line_member_key").on(t.tenantId, t.runId, t.calculation, t.memberId),
    index("pay_run_line_member_idx").on(t.tenantId, t.memberId),
    check("pay_run_line_calculation", sql`calculation >= 1`),
    check(
      "pay_run_line_json",
      sql`jsonb_typeof(working) = 'array' AND jsonb_typeof(inputs) = 'object'`,
    ),
    check("pay_run_line_hash", sql`input_hash ~ '^[0-9a-f]{64}$'`),
  ],
);

/** A finding that blocks locking until put right or overridden with a reason. */
export const payRunException = pgTable(
  "pay_run_exception",
  {
    id: id(),
    tenantId: tenantId(),
    runId: uuid("run_id").notNull(),
    calculation: integer("calculation").notNull(),
    memberId: uuid("member_id").notNull(),
    kind: text("kind").notNull(),
    ref: uuid("ref"),
    /** The line's input hash: an override carries forward only while it is unchanged. */
    lineInputHash: text("line_input_hash").notNull(),
    status: text("status").notNull().default("open"),
    overrideReason: text("override_reason"),
    overriddenBy: uuid("overridden_by"),
    overriddenAt: timestamp("overridden_at", { withTimezone: true }),
    ...mutableColumns(),
  },
  (t) => [
    unique("pay_run_exception_tenant_id_id_key").on(t.tenantId, t.id),
    foreignKey({
      name: "pay_run_exception_run_fk",
      columns: [t.tenantId, t.runId],
      foreignColumns: [payRun.tenantId, payRun.id],
    }),
    staffRef("pay_run_exception_member_fk", t, t.memberId),
    staffRef("pay_run_exception_overridden_by_fk", t, t.overriddenBy),
    index("pay_run_exception_run_idx").on(t.tenantId, t.runId, t.calculation),
    check("pay_run_exception_kind", sql`kind IN (${sqlList(PAY_EXCEPTION_KIND_CODES)})`),
    check("pay_run_exception_status", sql`status IN ('open', 'overridden')`),
    check(
      "pay_run_exception_override",
      sql`(status = 'overridden') = (overridden_by IS NOT NULL AND overridden_at IS NOT NULL AND override_reason IS NOT NULL)
        AND (override_reason IS NULL OR char_length(btrim(override_reason)) BETWEEN 3 AND 500)
        AND (overridden_by IS NULL OR overridden_by <> member_id)`,
    ),
  ],
);
