import { nmwMinutesIn } from "../classification";
import {
  clip,
  DAYS_PER_WEEK,
  dailyWindows,
  datesFrom,
  plusMinutes,
  type Span,
  spanMinutes,
  subtractSpans,
  ukDateOf,
  ukDay,
  ukDays,
} from "../intervals";
import type { TravelKind, WorkPeriod, WorkPeriodKind } from "../working-time-types";
import { type AeCategory, autoEnrolmentCategory, qualifyingEarningsPence } from "./auto-enrolment";
import { irregularHoursHoliday } from "./holiday";
import { canonicalInput, formatPounds, TENTHS_PER_MILE, type WorkingLine } from "./money";
import { ageOn, type NmwBand, nmwCheck, nmwPayFromGross } from "./nmw";
import {
  type EnhancementKind,
  grossPay,
  type TimesheetEntry as PayEntryLine,
  type PayRuleSet,
} from "./pay-rules";
import type { PayRates } from "./rates";
import { sickPay } from "./ssp";

/**
 * A pay run's line for one member and one pay period (scheduling.md section 18; SCHED-005, 006,
 * 007): the slice 6 rules applied to approved time and recorded sickness. Every figure is in whole
 * pence or minutes, with its working in words, and the canonical inputs so the line reproduces.
 * Statutory figures come only from the rate table (`PayRates`); the rule set holds the
 * organisation's own rates.
 */

export const PAY_FREQUENCIES = ["weekly", "monthly"] as const;
export type PayFrequency = (typeof PAY_FREQUENCIES)[number];

export const PAY_EXCEPTION_KINDS = [
  "unapproved_timesheet",
  "no_pay_profile",
  "no_role_rate",
  "no_date_of_birth",
  "below_nmw",
  "ssp_earnings_missing",
  "rate_missing",
] as const;
export type PayExceptionKind = (typeof PAY_EXCEPTION_KINDS)[number];

export const PAY_EXCEPTION_MESSAGES: Readonly<Record<PayExceptionKind, string>> = {
  unapproved_timesheet: "A timesheet entry in the period is not approved yet.",
  no_pay_profile: "This member has no pay profile.",
  no_role_rate: "The rule set has no rate for this member's role.",
  no_date_of_birth: "The staff file has no date of birth, so the minimum wage band is unknown.",
  below_nmw: "Pay is below the minimum wage: a top-up line was added. Check the rule set.",
  ssp_earnings_missing: "Sickness in the period, but no average weekly earnings for SSP.",
  rate_missing: "The rate table has no figure the calculation needs for this date.",
};

export interface PayException {
  readonly kind: PayExceptionKind;
  /** An opaque id (a timesheet entry), or null. */
  readonly ref: string | null;
}

/** The organisation's own rates (never statutory) with how enhancements are found. */
export interface PayRuleSetFull extends PayRuleSet {
  /** Night window in UK wall-clock minutes from midnight; null when there is no night rate. */
  readonly nightStartMinute: number | null;
  readonly nightEndMinute: number | null;
  /** UK dates paid at the bank holiday enhancement. */
  readonly bankHolidays: readonly string[];
  /** Paid minutes in the period after which the overtime enhancement applies; null for none. */
  readonly overtimeAfterMinutes: number | null;
  readonly rolledUpHoliday: boolean;
}

export interface PayProfile {
  readonly employment: "staff" | "bank" | "agency";
  readonly roleKey: string | null;
  readonly dateOfBirth: string | null;
  readonly apprenticeshipStartedOn: string | null;
  readonly irregularHours: boolean;
  /** The first day of the member's current leave year. */
  readonly leaveYearStart: string | null;
  /** ISO weekdays the member normally works (Monday 1). */
  readonly qualifyingWeekdays: readonly number[];
  readonly sspAverageWeeklyEarningsPence: number | null;
  /** When the member reaches state pension age, if known. */
  readonly statePensionAgeOn: string | null;
}

export interface PayEntry {
  readonly id: string;
  readonly kind: WorkPeriodKind;
  readonly start: Date;
  readonly end: Date;
  readonly breaks: readonly Span[];
  readonly travel: TravelKind | null;
  readonly mileageTenths: number | null;
  /** Times awake on a sleep-in. */
  readonly awake: readonly Span[];
}

export interface PayLineInput {
  readonly memberId: string;
  readonly period: {
    readonly start: string;
    readonly end: string;
    readonly frequency: PayFrequency;
  };
  readonly ruleSet: PayRuleSetFull;
  readonly profile: PayProfile | null;
  /** Approved, current entries starting in the period. */
  readonly entries: readonly PayEntry[];
  /** Draft entries starting in the period. */
  readonly unapprovedEntryIds: readonly string[];
  /** Sickness in the period that falls in a period of incapacity, with what was paid before. */
  readonly sickness: {
    readonly days: readonly string[];
    readonly daysAlreadyPaid: number;
  } | null;
  /** An agency worker's AWR clock, from their bookings. */
  readonly awr: {
    readonly qualifyingWeeks: number;
    readonly qualifiedFromWeek: string | null;
  } | null;
  /** For a correction: the total of the line it corrects, or null when there was none. */
  readonly previousTotalPence: number | null;
}

export interface PayLine {
  readonly memberId: string;
  readonly paidMinutes: number;
  readonly nmwMinutes: number;
  readonly basicPence: number;
  readonly premiumPence: number;
  readonly sleepInPence: number;
  readonly onCallPence: number;
  readonly mileagePence: number;
  readonly nmwTopUpPence: number;
  readonly rolledUpHolidayPence: number;
  readonly sspPence: number;
  readonly totalPence: number;
  readonly holidayAccruedMinutes: number | null;
  readonly nmwBand: NmwBand | null;
  readonly aeCategory: AeCategory | null;
  readonly qualifyingEarningsPence: number | null;
  /** The change from the line a correction corrects; null for a regular run. */
  readonly differencePence: number | null;
  readonly exceptions: readonly PayException[];
  readonly working: readonly WorkingLine[];
  readonly canonicalInput: string;
}

/** Kinds whose time is paid at the role's rate (less breaks). */
const PAID_KINDS: ReadonlySet<WorkPeriodKind> = new Set([
  "work",
  "training",
  "on_call_at_workplace",
]);
const SATURDAY = DAYS_PER_WEEK - 1;
const SUNDAY = 0;

const isPaidTime = (e: PayEntry) =>
  PAID_KINDS.has(e.kind) || (e.kind === "travel" && e.travel === "between_assignments");

interface Piece {
  readonly span: Span;
  readonly enhancements: readonly EnhancementKind[];
}

/**
 * Rule 3: an entry's paid time less breaks, split at UK midnight and the night window, each piece
 * with the night, weekend and bank holiday enhancements that apply.
 */
export function paidPieces(entry: PayEntry, set: PayRuleSetFull): Piece[] {
  if (!isPaidTime(entry)) return [];
  const span = { start: entry.start, end: entry.end };
  const nights =
    set.nightStartMinute !== null && set.nightEndMinute !== null
      ? dailyWindows(span, set.nightStartMinute, set.nightEndMinute)
      : [];
  const cuts = new Set<number>();
  for (const d of datesFrom(ukDateOf(entry.start), ukDateOf(entry.end))) {
    cuts.add(ukDay(d).start.getTime());
  }
  for (const n of nights) {
    cuts.add(n.start.getTime());
    cuts.add(n.end.getTime());
  }
  const pieces: Piece[] = [];
  for (const part of subtractSpans(span, entry.breaks)) {
    const inside = [...cuts]
      .filter((t) => t > part.start.getTime() && t < part.end.getTime())
      .sort((a, b) => a - b)
      .map((t) => new Date(t));
    const edges = [part.start, ...inside, part.end];
    for (let i = 0; i + 1 < edges.length; i++) {
      const piece = { start: edges[i] as Date, end: edges[i + 1] as Date };
      const date = ukDateOf(piece.start);
      const weekday = new Date(`${date}T12:00:00Z`).getUTCDay();
      const enhancements: EnhancementKind[] = [];
      if (nights.some((n) => clip(piece, n) !== null)) enhancements.push("night");
      if (weekday === SATURDAY || weekday === SUNDAY) enhancements.push("weekend");
      if (set.bankHolidays.includes(date)) enhancements.push("bank_holiday");
      pieces.push({ span: piece, enhancements });
    }
  }
  return pieces;
}

/** Rule 3: past the threshold, the rest of the period's paid time also gets overtime. */
export function withOvertime(pieces: readonly Piece[], afterMinutes: number | null): Piece[] {
  if (afterMinutes === null) return [...pieces];
  const sorted = [...pieces].sort((a, b) => a.span.start.getTime() - b.span.start.getTime());
  const out: Piece[] = [];
  let used = 0;
  for (const p of sorted) {
    const minutes = spanMinutes(p.span);
    const left = afterMinutes - used;
    if (left >= minutes) {
      out.push(p);
    } else if (left <= 0) {
      out.push({ span: p.span, enhancements: [...p.enhancements, "overtime"] });
    } else {
      const cut = plusMinutes(p.span.start, left);
      out.push({ span: { start: p.span.start, end: cut }, enhancements: p.enhancements });
      out.push({
        span: { start: cut, end: p.span.end },
        enhancements: [...p.enhancements, "overtime"],
      });
    }
    used += minutes;
  }
  return out;
}

function workPeriodOf(e: PayEntry): WorkPeriod {
  return {
    id: e.id,
    kind: e.kind,
    start: e.start,
    end: e.end,
    ...(e.breaks.length > 0 ? { breaks: e.breaks } : {}),
    ...(e.kind === "travel" && e.travel ? { travel: e.travel } : {}),
    ...(e.kind === "sleep_in"
      ? { sleepIn: { expectedToSleep: true, suitableSleepingFacilities: true, awake: e.awake } }
      : {}),
  };
}

/** Rules 3 to 9: one member's line for a period. `rates` null: the rate table had no figure. */
export function payRunLine(input: PayLineInput, rates: PayRates | null): PayLine {
  const exceptions: PayException[] = input.unapprovedEntryIds.map((ref) => ({
    kind: "unapproved_timesheet",
    ref,
  }));
  const working: WorkingLine[] = [];
  const p = input.profile;
  const empty = (extra: PayException[]): PayLine => ({
    memberId: input.memberId,
    paidMinutes: 0,
    nmwMinutes: 0,
    basicPence: 0,
    premiumPence: 0,
    sleepInPence: 0,
    onCallPence: 0,
    mileagePence: 0,
    nmwTopUpPence: 0,
    rolledUpHolidayPence: 0,
    sspPence: 0,
    totalPence: 0,
    holidayAccruedMinutes: null,
    nmwBand: null,
    aeCategory: null,
    qualifyingEarningsPence: null,
    differencePence: input.previousTotalPence === null ? null : -input.previousTotalPence,
    exceptions: [...exceptions, ...extra],
    working,
    canonicalInput: canonicalInput(input),
  });
  if (!p) return empty([{ kind: "no_pay_profile", ref: null }]);
  if (!rates) return empty([{ kind: "rate_missing", ref: null }]);
  const range = ukDays(input.period.start, input.period.end);
  const pieces = withOvertime(
    input.entries.flatMap((e) => paidPieces(e, input.ruleSet)),
    input.ruleSet.overtimeAfterMinutes,
  );
  const paidMinutes = pieces.reduce((n, x) => n + spanMinutes(x.span), 0);
  const nmwMinutes = nmwMinutesIn(input.entries.map(workPeriodOf), range);
  if (p.employment === "agency") {
    working.push(
      { step: `Agency worker: paid by their agency; ${Math.round(paidMinutes)} minutes worked` },
      {
        step: input.awr?.qualifiedFromWeek
          ? `AWR: qualified for equal basic terms from the week of ${input.awr.qualifiedFromWeek}`
          : `AWR: ${input.awr?.qualifyingWeeks ?? 0} qualifying weeks so far`,
        rateKey: "awr.qualifying_weeks",
      },
    );
    return { ...empty([]), paidMinutes: Math.round(paidMinutes), nmwMinutes };
  }
  const role = p.roleKey;
  if (role === null || input.ruleSet.roleRates[role] === undefined) {
    return empty([{ kind: "no_role_rate", ref: null }]);
  }
  // Group pieces by their enhancements so each line rounds once.
  const groups = new Map<string, { enhancements: EnhancementKind[]; minutes: number }>();
  for (const x of pieces) {
    const key = [...x.enhancements].sort().join("+");
    const g = groups.get(key) ?? { enhancements: [...x.enhancements].sort(), minutes: 0 };
    g.minutes += spanMinutes(x.span);
    groups.set(key, g);
  }
  const lines: PayEntryLine[] = [...groups.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([, g]) => ({
      kind: "work" as const,
      role,
      minutes: Math.round(g.minutes),
      enhancements: g.enhancements,
    }));
  for (const e of input.entries) {
    if (e.kind === "sleep_in") lines.push({ kind: "sleep_in" });
    if (e.kind === "on_call_away") lines.push({ kind: "on_call" });
    if (e.mileageTenths) lines.push({ kind: "mileage", miles: e.mileageTenths / TENTHS_PER_MILE });
  }
  const gross = grossPay(input.ruleSet, lines);
  working.push(...gross.working);
  // Rule 4: the minimum wage.
  let nmwTopUp = 0;
  let band: NmwBand | null = null;
  if (p.dateOfBirth === null) {
    exceptions.push({ kind: "no_date_of_birth", ref: null });
  } else {
    const nmw = nmwCheck(
      {
        dateOfBirth: p.dateOfBirth,
        periodStart: input.period.start,
        apprenticeshipStartedOn: p.apprenticeshipStartedOn,
        minutesCounted: nmwMinutes,
        ...nmwPayFromGross(gross),
        employerUseDeductionsPence: 0,
        accommodation: null,
      },
      rates,
    );
    band = nmw.band;
    working.push(...nmw.working);
    if (!nmw.compliant) {
      nmwTopUp = nmw.shortfallPence;
      exceptions.push({ kind: "below_nmw", ref: null });
      working.push({ step: "Minimum wage top-up added as its own line", pence: nmwTopUp });
    }
  }
  // Rule 5: holiday for irregular-hours and part-year workers.
  let holidayMinutes: number | null = null;
  let rolledUp = 0;
  if (p.irregularHours && p.leaveYearStart) {
    const holiday = irregularHoursHoliday(
      {
        leaveYearStart: p.leaveYearStart,
        minutesWorked: Math.round(paidMinutes),
        payPence: gross.basicPence + gross.premiumPence + gross.sleepInPence + nmwTopUp,
        rolledUp: input.ruleSet.rolledUpHoliday,
      },
      rates,
    );
    if (holiday.applies) {
      holidayMinutes = holiday.accruedMinutes;
      rolledUp = holiday.rolledUpPence ?? 0;
      working.push(...holiday.working);
    } else {
      working.push({ step: `Holiday accrual not applied (${holiday.reason.replace(/_/g, " ")})` });
    }
  }
  // Rule 6: SSP, never for a day the member worked.
  let ssp = 0;
  if (input.sickness && input.sickness.days.length > 0) {
    const worked = new Set(input.entries.map((e) => ukDateOf(e.start)));
    const weekdays = new Set(p.qualifyingWeekdays);
    const days = input.sickness.days.filter((d) => {
      const weekday = new Date(`${d}T12:00:00Z`).getUTCDay() || DAYS_PER_WEEK;
      return weekdays.has(weekday) && !worked.has(d);
    });
    if (p.sspAverageWeeklyEarningsPence === null) {
      exceptions.push({ kind: "ssp_earnings_missing", ref: null });
    } else if (days.length > 0 && weekdays.size > 0) {
      const result = sickPay(
        {
          averageWeeklyEarningsPence: p.sspAverageWeeklyEarningsPence,
          qualifyingDaysPerWeek: weekdays.size,
          sickQualifyingDays: days.length,
          daysAlreadyPaid: input.sickness.daysAlreadyPaid,
        },
        rates,
      );
      if (result.applies) {
        ssp = result.payPence;
        working.push(...result.working);
      } else {
        working.push({ step: "SSP not applied (no rate for the nation)" });
      }
    }
  }
  const total = gross.totalPence + nmwTopUp + rolledUp + ssp;
  // Rule 8: auto-enrolment, a flag only.
  let ae: AeCategory | null = null;
  let qualifying: number | null = null;
  if (p.dateOfBirth !== null) {
    const earnings = total - gross.mileagePence;
    ae = autoEnrolmentCategory(
      {
        age: ageOn(p.dateOfBirth, input.period.start),
        reachedStatePensionAge:
          p.statePensionAgeOn !== null && p.statePensionAgeOn <= input.period.end,
        earningsPence: earnings,
        period: input.period.frequency,
      },
      rates,
    );
    qualifying = qualifyingEarningsPence(earnings, input.period.frequency, rates);
    working.push({
      step: `Auto-enrolment: ${ae.replace(/_/g, " ")} (a flag only); qualifying earnings ${formatPounds(qualifying)}`,
    });
  }
  const difference = input.previousTotalPence === null ? null : total - input.previousTotalPence;
  working.push({ step: "Total for the period", pence: total });
  if (difference !== null) {
    working.push({ step: "Change from the run this corrects", pence: difference });
  }
  return {
    memberId: input.memberId,
    paidMinutes: Math.round(paidMinutes),
    nmwMinutes,
    basicPence: gross.basicPence,
    premiumPence: gross.premiumPence,
    sleepInPence: gross.sleepInPence,
    onCallPence: gross.onCallPence,
    mileagePence: gross.mileagePence,
    nmwTopUpPence: nmwTopUp,
    rolledUpHolidayPence: rolledUp,
    sspPence: ssp,
    totalPence: total,
    holidayAccruedMinutes: holidayMinutes,
    nmwBand: band,
    aeCategory: ae,
    qualifyingEarningsPence: qualifying,
    differencePence: difference,
    exceptions,
    working,
    canonicalInput: canonicalInput(input),
  };
}

/** Rule 9: open exceptions block locking unless overridden with a reason. */
export function runBlocked(
  exceptions: readonly { readonly status: "open" | "overridden" }[],
): boolean {
  return exceptions.some((e) => e.status === "open");
}
