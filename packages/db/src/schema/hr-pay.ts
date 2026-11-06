import { sql } from "drizzle-orm";
import {
  check,
  date,
  foreignKey,
  index,
  integer,
  numeric,
  pgTable,
  text,
  timestamp,
  unique,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { createdColumns, id, mutableColumns, tenantId } from "./_columns";
import { payRun } from "./pay";
import { tenantUser } from "./platform";
import { staffProfile } from "./workforce";

/**
 * Pay through Thapsus-HR (integrations.md section 11.5 rules 11 and 12; slice 89; migration 0151;
 * ADR-0131; HZ-133, HZ-140). Thapsus-HR's pay periods (the pay reference periods for a linked
 * tenant) and its hourly rates, both written by the link's sync alone and read by pay holders;
 * and the units by kind this product worked out when a pay run was locked, kept unchanged as the
 * record of what went to Thapsus-HR's payroll. Units and rates only, never money sent.
 */

export const HR_PAY_FREQUENCIES = ["weekly", "monthly"] as const;

export const hrPayPeriod = pgTable(
  "hr_pay_period",
  {
    id: id(),
    tenantId: tenantId(),
    /** Thapsus-HR's identifier for the pay period. */
    hrId: text("hr_id").notNull(),
    frequency: text("frequency").notNull(),
    startsOn: date("starts_on").notNull(),
    endsOn: date("ends_on").notNull(),
    lastSeenAt: timestamp("last_seen_at", { withTimezone: true }).notNull(),
    ...mutableColumns(),
  },
  (t) => [
    unique("hr_pay_period_tenant_id_id_key").on(t.tenantId, t.id),
    uniqueIndex("hr_pay_period_hr_key").on(t.tenantId, t.hrId).where(sql`deleted_at IS NULL`),
    uniqueIndex("hr_pay_period_start_key")
      .on(t.tenantId, t.frequency, t.startsOn)
      .where(sql`deleted_at IS NULL`),
    check(
      "hr_pay_period_values",
      sql`hr_id ~ '^[A-Za-z0-9_-]{1,64}$' AND frequency IN ('weekly', 'monthly')
        AND ends_on >= starts_on AND ends_on - starts_on <= 30`,
    ),
  ],
);

export const hrPayRate = pgTable(
  "hr_pay_rate",
  {
    id: id(),
    tenantId: tenantId(),
    staffProfileId: uuid("staff_profile_id").notNull(),
    /** Pence an hour, read only for the minimum wage check (rule 11). */
    hourlyPence: integer("hourly_pence").notNull(),
    effectiveFrom: date("effective_from").notNull(),
    lastSeenAt: timestamp("last_seen_at", { withTimezone: true }).notNull(),
    ...mutableColumns(),
  },
  (t) => [
    unique("hr_pay_rate_tenant_id_id_key").on(t.tenantId, t.id),
    foreignKey({
      name: "hr_pay_rate_staff_profile_fk",
      columns: [t.tenantId, t.staffProfileId],
      foreignColumns: [staffProfile.tenantId, staffProfile.id],
    }),
    uniqueIndex("hr_pay_rate_from_key")
      .on(t.tenantId, t.staffProfileId, t.effectiveFrom)
      .where(sql`deleted_at IS NULL`),
    check("hr_pay_rate_values", sql`hourly_pence BETWEEN 1 AND 100000`),
  ],
);

export const hrPayUnit = pgTable(
  "hr_pay_unit",
  {
    id: id(),
    tenantId: tenantId(),
    /** The locked pay run the units were worked out from. */
    runId: uuid("run_id").notNull(),
    hrPayPeriodId: uuid("hr_pay_period_id").notNull(),
    memberId: uuid("member_id").notNull(),
    unitKind: text("unit_kind").notNull(),
    quantity: numeric("quantity", { precision: 10, scale: 2 }).notNull(),
    ...createdColumns(),
  },
  (t) => [
    unique("hr_pay_unit_tenant_id_id_key").on(t.tenantId, t.id),
    unique("hr_pay_unit_kind_key").on(t.tenantId, t.runId, t.memberId, t.unitKind),
    foreignKey({
      name: "hr_pay_unit_run_fk",
      columns: [t.tenantId, t.runId],
      foreignColumns: [payRun.tenantId, payRun.id],
    }),
    foreignKey({
      name: "hr_pay_unit_period_fk",
      columns: [t.tenantId, t.hrPayPeriodId],
      foreignColumns: [hrPayPeriod.tenantId, hrPayPeriod.id],
    }),
    foreignKey({
      name: "hr_pay_unit_member_fk",
      columns: [t.tenantId, t.memberId],
      foreignColumns: [tenantUser.tenantId, tenantUser.id],
    }),
    index("hr_pay_unit_period_idx").on(t.tenantId, t.hrPayPeriodId),
    check(
      "hr_pay_unit_values",
      sql`unit_kind ~ '^(hours(_(bank_holiday|night|overtime|weekend))*|sleep_in|on_call|mileage)$'
        AND quantity > 0`,
    ),
  ],
);
