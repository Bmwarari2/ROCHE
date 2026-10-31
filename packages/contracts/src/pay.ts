import { z } from "zod";

/**
 * Pay calculation runs (scheduling.md section 18; SCHED-005, 006, 007). Figures are whole pence or
 * minutes. Statutory figures come from the rate table; a rule set holds the organisation's own rates.
 */

const uuid = z.uuid();
const isoDate = z.iso.date();
const isoDateTime = z.iso.datetime({ offset: true });
const version = z.number().int().min(1);
const pence = z.number().int().min(0).max(100_000_000);
const roleKey = z.string().regex(/^[a-z][a-z0-9_]{0,59}$/);
const minuteOfDay = z.number().int().min(0).max(1439);

export const PayFrequency = z.enum(["weekly", "monthly"]).meta({ id: "PayFrequency" });
export const PayExceptionKind = z
  .enum([
    "unapproved_timesheet",
    "no_pay_profile",
    "no_role_rate",
    "no_date_of_birth",
    "below_nmw",
    "ssp_earnings_missing",
    "no_qualifying_days",
    "rate_missing",
  ])
  .meta({ id: "PayExceptionKind" });

export const PayEnhancement = z
  .object({
    kind: z.enum(["night", "weekend", "bank_holiday", "overtime"]),
    mode: z.enum(["percent", "flat_per_hour"]),
    /** A percentage (25 for 25%), or pence an hour. */
    value: z.number().int().min(0).max(100_000),
  })
  .meta({ id: "PayEnhancement" });

const RuleSetFields = {
  name: z.string().trim().min(1).max(120),
  effectiveFrom: isoDate,
  roleRates: z.record(roleKey, pence),
  enhancements: z.array(PayEnhancement).max(8).default([]),
  stackEnhancements: z.boolean().default(false),
  sleepInFlatPence: pence.default(0),
  mileagePencePerMile: pence.default(0),
  onCallFlatPence: pence.default(0),
  nightStartMinute: minuteOfDay.nullable().default(null),
  nightEndMinute: minuteOfDay.nullable().default(null),
  /** Days paid at the bank holiday enhancement besides the nation's bank holidays. */
  extraBankHolidays: z.array(isoDate).max(40).default([]),
  overtimeAfterMinutes: z.number().int().min(0).max(100_000).nullable().default(null),
  rolledUpHoliday: z.boolean().default(false),
};

export const CreatePayRuleSet = z.object(RuleSetFields).meta({ id: "CreatePayRuleSet" });
export const ChangePayRuleSet = z
  .object({ version, ...RuleSetFields })
  .meta({ id: "ChangePayRuleSet" });
export const ApprovePayRuleSet = z.object({ version }).meta({ id: "ApprovePayRuleSet" });

export const PayRuleSetItem = z
  .object({
    id: uuid,
    version,
    versionNumber: z.number().int(),
    name: z.string(),
    effectiveFrom: isoDate,
    roleRates: z.record(z.string(), z.number()),
    enhancements: z.array(PayEnhancement),
    stackEnhancements: z.boolean(),
    sleepInFlatPence: z.number(),
    mileagePencePerMile: z.number(),
    onCallFlatPence: z.number(),
    nightStartMinute: z.number().nullable(),
    nightEndMinute: z.number().nullable(),
    extraBankHolidays: z.array(isoDate),
    overtimeAfterMinutes: z.number().nullable(),
    rolledUpHoliday: z.boolean(),
    status: z.enum(["draft", "approved"]),
    approvedBy: uuid.nullable(),
    approvedAt: isoDateTime.nullable(),
  })
  .meta({ id: "PayRuleSetItem" });

export const PayRuleSetList = z
  .object({ items: z.array(PayRuleSetItem) })
  .meta({ id: "PayRuleSetList" });

const ProfileFields = {
  frequency: PayFrequency,
  employment: z.enum(["staff", "bank", "agency"]).default("staff"),
  roleKey: roleKey.nullable().default(null),
  apprenticeshipStartedOn: isoDate.nullable().default(null),
  irregularHours: z.boolean().default(false),
  leaveYearStart: isoDate.nullable().default(null),
  /** ISO weekdays normally worked (Monday 1), for SSP. */
  qualifyingWeekdays: z.array(z.number().int().min(1).max(7)).max(7).default([]),
  sspAverageWeeklyEarningsPence: pence.nullable().default(null),
  statePensionAgeOn: isoDate.nullable().default(null),
  /**
   * The organisation's works number, or the payroll provider's employee id: the only way an export
   * names the member (scheduling.md section 19 rule 3). Unique in the organisation.
   */
  payrollReference: z
    .string()
    .regex(/^[A-Za-z0-9][A-Za-z0-9._/-]{0,39}$/, "Letters, digits, dots, dashes and slashes")
    .nullable()
    .default(null),
};

export const PutPayProfile = z
  .object({ version: z.number().int().nullable(), ...ProfileFields })
  .meta({ id: "PutPayProfile" });

export const PayProfileItem = z
  .object({
    memberId: uuid,
    version: z.number().int().nullable(),
    frequency: PayFrequency.nullable(),
    employment: z.enum(["staff", "bank", "agency"]),
    roleKey: z.string().nullable(),
    apprenticeshipStartedOn: isoDate.nullable(),
    irregularHours: z.boolean(),
    leaveYearStart: isoDate.nullable(),
    qualifyingWeekdays: z.array(z.number()),
    sspAverageWeeklyEarningsPence: z.number().nullable(),
    statePensionAgeOn: isoDate.nullable(),
    payrollReference: z.string().nullable(),
  })
  .meta({ id: "PayProfileItem" });

export const CreatePayRun = z
  .object({ frequency: PayFrequency, periodStart: isoDate, periodEnd: isoDate })
  .meta({ id: "CreatePayRun" });
export const PayRunVersion = z.object({ version }).meta({ id: "PayRunVersion" });
export const OverridePayException = z
  .object({ version, reason: z.string().trim().min(3).max(500) })
  .meta({ id: "OverridePayException" });

export const PayWorkingLine = z
  .object({
    step: z.string(),
    pence: z.number().nullable(),
    rateKey: z.string().nullable(),
  })
  .meta({ id: "PayWorkingLine" });

export const PayRunLineItem = z
  .object({
    id: uuid,
    runId: uuid,
    calculation: z.number().int(),
    memberId: uuid,
    paidMinutes: z.number().int(),
    nmwMinutes: z.number().int(),
    basicPence: z.number().int(),
    premiumPence: z.number().int(),
    sleepInPence: z.number().int(),
    onCallPence: z.number().int(),
    mileagePence: z.number().int(),
    nmwTopUpPence: z.number().int(),
    rolledUpHolidayPence: z.number().int(),
    sspPence: z.number().int(),
    totalPence: z.number().int(),
    differencePence: z.number().int().nullable(),
    holidayAccruedMinutes: z.number().int().nullable(),
    nmwBand: z.string().nullable(),
    aeCategory: z.string().nullable(),
    qualifyingEarningsPence: z.number().int().nullable(),
    working: z.array(PayWorkingLine),
    inputHash: z.string(),
  })
  .meta({ id: "PayRunLineItem" });

export const PayRunExceptionItem = z
  .object({
    id: uuid,
    version,
    calculation: z.number().int(),
    memberId: uuid,
    kind: PayExceptionKind,
    ref: uuid.nullable(),
    message: z.string(),
    status: z.enum(["open", "overridden"]),
    overrideReason: z.string().nullable(),
    overriddenBy: uuid.nullable(),
    overriddenAt: isoDateTime.nullable(),
  })
  .meta({ id: "PayRunExceptionItem" });

export const PayRunItem = z
  .object({
    id: uuid,
    version,
    frequency: PayFrequency,
    periodStart: isoDate,
    periodEnd: isoDate,
    kind: z.enum(["regular", "correction"]),
    correctsRunId: uuid.nullable(),
    ruleSetId: uuid,
    nation: z.string(),
    calculation: z.number().int(),
    calculatedAt: isoDateTime.nullable(),
    calculatedBy: uuid.nullable(),
    status: z.enum(["draft", "locked"]),
    lockedBy: uuid.nullable(),
    lockedAt: isoDateTime.nullable(),
    createdBy: uuid.nullable(),
    /** Open exceptions in the latest calculation: locking waits until none. */
    openExceptions: z.number().int(),
  })
  .meta({ id: "PayRunItem" });

export const PayRunList = z.object({ items: z.array(PayRunItem) }).meta({ id: "PayRunList" });

export const PayRunDetail = z
  .object({
    run: PayRunItem,
    lines: z.array(PayRunLineItem),
    exceptions: z.array(PayRunExceptionItem),
  })
  .meta({ id: "PayRunDetail" });

export const PayLineVerification = z
  .object({
    lineId: uuid,
    reproduced: z.boolean(),
    storedHash: z.string(),
    recalculatedHash: z.string(),
    /** Figures that differ, by name; empty when reproduced. */
    differences: z.array(z.string()),
  })
  .meta({ id: "PayLineVerification" });

export const MyPayLines = z
  .object({
    items: z.array(
      z.object({
        line: PayRunLineItem,
        periodStart: isoDate,
        periodEnd: isoDate,
        kind: z.enum(["regular", "correction"]),
        lockedAt: isoDateTime,
      }),
    ),
  })
  .meta({ id: "MyPayLines" });
