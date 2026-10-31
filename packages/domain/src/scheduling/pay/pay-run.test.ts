import { describe, expect, it } from "vitest";
import { readRateTable } from "../../../test/rate-table";
import { uk } from "../../../test/working-time";
import {
  type PayEntry,
  type PayLineInput,
  type PayProfile,
  type PayRuleSetFull,
  paidPieces,
  payLineInputFromJson,
  payRunLine,
  runBlocked,
  withOvertime,
} from "./pay-run";
import { resolvePayRates } from "./rates";

/**
 * A pay run's line (scheduling.md section 18): table-driven against the real rate table. One weekly
 * period, Monday 2 to Sunday 8 November 2026, for an invented worker born in 1990.
 */

const rates = resolvePayRates(readRateTable(), "england", "2026-11-02", null);
const MIN = 60_000;

const SET: PayRuleSetFull = {
  id: "example-set",
  version: 1,
  roleRates: { care_worker: rates.nmw21Plus + 50, trainee: rates.nmw21Plus - 100 },
  enhancements: [
    { kind: "night", mode: "percent", value: 10 },
    { kind: "weekend", mode: "flat_per_hour", value: 100 },
    { kind: "bank_holiday", mode: "percent", value: 50 },
    { kind: "overtime", mode: "percent", value: 25 },
  ],
  stackEnhancements: false,
  sleepInFlatPence: 5_000,
  mileagePencePerMile: 45,
  onCallFlatPence: 2_000,
  nightStartMinute: 22 * 60,
  nightEndMinute: 6 * 60,
  bankHolidays: ["2026-12-25"],
  overtimeAfterMinutes: null,
  rolledUpHoliday: false,
};

const PROFILE: PayProfile = {
  employment: "staff",
  roleKey: "care_worker",
  dateOfBirth: "1990-05-01",
  apprenticeshipStartedOn: null,
  irregularHours: false,
  leaveYearStart: null,
  qualifyingWeekdays: [1, 2, 3, 4, 5],
  sspAverageWeeklyEarningsPence: null,
  statePensionAgeOn: null,
};

const entry = (id: string, from: string, to: string, over: Partial<PayEntry> = {}): PayEntry => ({
  id,
  kind: "work",
  start: uk(from),
  end: uk(to),
  breaks: [],
  travel: null,
  mileageTenths: null,
  awake: [],
  ...over,
});

const input = (over: Partial<PayLineInput> = {}): PayLineInput => ({
  memberId: "m1",
  period: { start: "2026-11-02", end: "2026-11-08", frequency: "weekly" },
  ruleSet: SET,
  profile: PROFILE,
  entries: [entry("e1", "2026-11-02 08:00", "2026-11-02 16:00")],
  unapprovedEntryIds: [],
  sickness: null,
  awr: null,
  previousTotalPence: null,
  ...over,
});

const minutes = (pieces: ReturnType<typeof paidPieces>) =>
  pieces.map((p) => [
    (p.span.end.getTime() - p.span.start.getTime()) / MIN,
    p.enhancements.join("+"),
  ]);

describe("paid time split at midnight and the night window (rule 3)", () => {
  it.each([
    [
      "a weekday day with a break",
      entry("a", "2026-11-02 08:00", "2026-11-02 16:00", {
        breaks: [{ start: uk("2026-11-02 12:00"), end: uk("2026-11-02 12:30") }],
      }),
      [
        [240, ""],
        [210, ""],
      ],
    ],
    [
      "a Friday night into Saturday",
      entry("b", "2026-11-06 20:00", "2026-11-07 08:00"),
      [
        [120, ""],
        [120, "night"],
        [360, "night+weekend"],
        [120, "weekend"],
      ],
    ],
    ["a bank holiday", entry("c", "2026-12-25 10:00", "2026-12-25 14:00"), [[240, "bank_holiday"]]],
    [
      "travel between assignments",
      entry("d", "2026-11-02 10:00", "2026-11-02 10:30", {
        kind: "travel",
        travel: "between_assignments",
      }),
      [[30, ""]],
    ],
    [
      "travel from home (not paid time)",
      entry("e", "2026-11-02 07:30", "2026-11-02 08:00", {
        kind: "travel",
        travel: "home_to_first_assignment",
      }),
      [],
    ],
    [
      "a sleep-in (an allowance, not hours)",
      entry("f", "2026-11-02 22:00", "2026-11-03 07:00", {
        kind: "sleep_in",
      }),
      [],
    ],
  ] as const)("%s", (_, e, expected) => {
    expect(minutes(paidPieces(e, SET))).toEqual(expected);
  });

  it("hazard HZ-010 counts the night the clocks go back by the instants worked (13 hours)", () => {
    const pieces = paidPieces(entry("g", "2026-10-24 20:00", "2026-10-25 08:00"), SET);
    expect(
      pieces.reduce((n, p) => n + (p.span.end.getTime() - p.span.start.getTime()) / MIN, 0),
    ).toBe(780);
  });

  it.each([
    [
      "under the threshold",
      1_000,
      [
        [480, ""],
        [480, ""],
      ],
    ],
    [
      "past it part way through",
      600,
      [
        [480, ""],
        [120, ""],
        [360, "overtime"],
      ],
    ],
    [
      "from the start",
      0,
      [
        [480, "overtime"],
        [480, "overtime"],
      ],
    ],
  ] as const)("overtime %s", (_, after, expected) => {
    const pieces = [
      ...paidPieces(entry("h", "2026-11-02 08:00", "2026-11-02 16:00"), SET),
      ...paidPieces(entry("i", "2026-11-03 08:00", "2026-11-03 16:00"), SET),
    ];
    expect(minutes(withOvertime(pieces, after))).toEqual(expected);
  });
});

describe("a member's line (rules 3 to 9)", () => {
  it("pays the role rate for the hours and meets the minimum wage", () => {
    const line = payRunLine(input(), rates);
    expect(line.basicPence).toBe(Math.floor(((rates.nmw21Plus + 50) * 480) / 60));
    expect(line.nmwTopUpPence).toBe(0);
    expect(line.nmwBand).toBe("21_plus");
    expect(line.exceptions).toEqual([]);
    expect(line.totalPence).toBe(line.basicPence);
  });

  it("adds a minimum wage top-up and raises an exception when the role rate is below it", () => {
    const line = payRunLine(input({ profile: { ...PROFILE, roleKey: "trainee" } }), rates);
    const required = Math.ceil((rates.nmw21Plus * 480) / 60);
    expect(line.nmwTopUpPence).toBe(required - line.basicPence);
    expect(line.totalPence).toBe(required);
    expect(line.exceptions).toEqual([{ kind: "below_nmw", ref: null }]);
  });

  it.each([
    ["no pay profile", input({ profile: null }), rates, "no_pay_profile"],
    ["no role rate", input({ profile: { ...PROFILE, roleKey: "cook" } }), rates, "no_role_rate"],
    [
      "no date of birth",
      input({ profile: { ...PROFILE, dateOfBirth: null } }),
      rates,
      "no_date_of_birth",
    ],
    ["no rate table figure", input(), null, "rate_missing"],
    ["a draft timesheet", input({ unapprovedEntryIds: ["d1"] }), rates, "unapproved_timesheet"],
    [
      "sickness with no earnings",
      input({ sickness: { days: ["2026-11-04"], daysAlreadyPaid: 0 } }),
      rates,
      "ssp_earnings_missing",
    ],
  ] as const)("raises an exception for %s", (_, i, r, kind) => {
    expect(payRunLine(i, r).exceptions.map((e) => e.kind)).toContain(kind);
  });

  it("pays SSP for qualifying days of sickness, never a day worked, counting days paid before", () => {
    const sick = (daysAlreadyPaid: number) =>
      payRunLine(
        input({
          profile: { ...PROFILE, sspAverageWeeklyEarningsPence: 50_000 },
          // Monday worked; Tuesday and Wednesday sick; Saturday is not a qualifying day.
          sickness: {
            days: ["2026-11-02", "2026-11-03", "2026-11-04", "2026-11-07"],
            daysAlreadyPaid,
          },
        }),
        rates,
      );
    const fresh = sick(0);
    expect(fresh.sspPence).toBeGreaterThan(0);
    expect(fresh.working.some((w) => /2 qualifying days/.test(w.step))).toBe(true);
    const exhausted = sick(rates.sspMaxWeeks * 5);
    expect(exhausted.sspPence).toBe(0);
  });

  it("accrues holiday for an irregular-hours worker and adds rolled-up pay as its own line", () => {
    const profile = { ...PROFILE, irregularHours: true, leaveYearStart: "2026-04-01" };
    const accrual = payRunLine(input({ profile }), rates);
    expect(accrual.holidayAccruedMinutes).toBe(
      Math.floor((480 * Math.round((rates.holidayAccrualPercent as number) * 100)) / 10_000),
    );
    expect(accrual.rolledUpHolidayPence).toBe(0);
    const rolled = payRunLine(
      input({ profile, ruleSet: { ...SET, rolledUpHoliday: true } }),
      rates,
    );
    expect(rolled.rolledUpHolidayPence).toBeGreaterThan(0);
    expect(rolled.totalPence).toBe(rolled.basicPence + rolled.rolledUpHolidayPence);
  });

  it("pays allowances and mileage, which the minimum wage does not count as pay for hours", () => {
    const line = payRunLine(
      input({
        entries: [
          entry("t", "2026-11-02 08:00", "2026-11-02 08:30", {
            kind: "travel",
            travel: "home_to_first_assignment",
            mileageTenths: 105,
          }),
          entry("s", "2026-11-03 22:00", "2026-11-04 07:00", {
            kind: "sleep_in",
            awake: [{ start: uk("2026-11-04 02:00"), end: uk("2026-11-04 03:00") }],
          }),
          entry("o", "2026-11-05 18:00", "2026-11-06 08:00", { kind: "on_call_away" }),
        ],
      }),
      rates,
    );
    expect(line.mileagePence).toBe(Math.floor(45 * 10.5));
    expect(line.sleepInPence).toBe(5_000);
    expect(line.onCallPence).toBe(2_000);
    expect(line.nmwMinutes).toBe(60);
  });

  it("pays an agency worker nothing and shows their AWR clock", () => {
    const line = payRunLine(
      input({
        profile: { ...PROFILE, employment: "agency" },
        awr: { qualifyingWeeks: rates.awrQualifyingWeeks, qualifiedFromWeek: "2026-10-26" },
      }),
      rates,
    );
    expect(line.totalPence).toBe(0);
    expect(line.paidMinutes).toBe(480);
    expect(line.working.map((w) => w.step).join(" ")).toMatch(/qualified for equal basic terms/);
  });

  it.each([
    ["a weekly earner over the trigger", 4_000, "eligible_jobholder"],
    ["a weekly earner under the lower level", 60, "entitled_worker"],
  ] as const)("flags auto-enrolment for %s", (_, hours, category) => {
    const days = Math.ceil(hours / 8);
    const entries = Array.from({ length: Math.min(days, 7) }, (_, i) =>
      entry(
        `w${i}`,
        `2026-11-0${2 + i} 08:00`,
        `2026-11-0${2 + i} ${hours >= 480 ? "20" : "09"}:00`,
      ),
    );
    const line = payRunLine(input({ entries: hours < 120 ? entries.slice(0, 1) : entries }), rates);
    expect(line.aeCategory).toBe(category);
  });

  it("shows a correction's difference from the line it corrects", () => {
    const base = payRunLine(input(), rates);
    const correction = payRunLine(input({ previousTotalPence: base.totalPence - 500 }), rates);
    expect(correction.differencePence).toBe(500);
  });

  it("gives the same inputs the same canonical text and figures, and others a different one", () => {
    const a = payRunLine(input(), rates);
    const b = payRunLine(input(), rates);
    expect(b).toEqual(a);
    const c = payRunLine(input({ memberId: "m2" }), rates);
    expect(c.canonicalInput).not.toBe(a.canonicalInput);
  });
});

describe("reproducible from what is stored (rule 10)", () => {
  it("recalculates the same line from its stored canonical inputs", () => {
    const original = payRunLine(
      input({
        entries: [
          entry("n", "2026-11-06 20:00", "2026-11-07 08:00", {
            breaks: [{ start: uk("2026-11-07 02:00"), end: uk("2026-11-07 02:30") }],
          }),
        ],
      }),
      rates,
    );
    const again = payRunLine(payLineInputFromJson(JSON.parse(original.canonicalInput)), rates);
    expect(again).toEqual(original);
  });
});

describe("open exceptions block locking (rule 9)", () => {
  it.each([
    [[], false],
    [[{ status: "overridden" }], false],
    [[{ status: "overridden" }, { status: "open" }], true],
  ] as const)("%j", (exceptions, blocked) => {
    expect(runBlocked(exceptions)).toBe(blocked);
  });
});
