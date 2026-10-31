import { type BankHolidays, isWorkingDay } from "../shared/working-days";
import { type RateNation, RateNotFoundError, type RateRow, resolveRate } from "./rates";

/**
 * Data rights rules (PLAT-022; platform.md, Phase 2: data rights, imports and single sign-on, rules
 * 1 to 10): the subject access request clock, the breach clock with decision support, and the data
 * protection complaint clocks. Pure functions: dates are UK calendar dates (yyyy-mm-dd), instants
 * are `Date`s, and every period comes from the rate table (`resolveDataRightsRates`), never a
 * literal. Nothing here decides for a person: the breach assessment only suggests.
 */

// ------------------------------------------------------------------------------------------------
// Rates
// ------------------------------------------------------------------------------------------------

export const DATA_RIGHTS_RATE_KEYS = {
  dsarResponseMonths: "dsar.response_months",
  dsarExtensionMonths: "dsar.extension_months",
  dsarDueSoonDays: "dsar.due_soon_days",
  breachReportHours: "ico.breach.report_hours",
  complaintAcknowledgeDays: "dp_complaint.acknowledge_days",
  complaintAcknowledgeTargetWorkingDays: "dp_complaint.acknowledge_target_working_days",
  complaintUpdateIntervalMonths: "dp_complaint.update_interval_months",
  importUndoWindowDays: "import.undo_window_days",
} as const;

export type DataRightsRateName = keyof typeof DATA_RIGHTS_RATE_KEYS;
export type DataRightsRates = { readonly [K in DataRightsRateName]: number };

type Nation = Exclude<RateNation, "uk" | "all">;

/** Resolves every data rights figure for a tenant on a date; fails loudly if one is missing. */
export function resolveDataRightsRates(
  rows: readonly RateRow[],
  nation: Nation,
  on: string,
  tenantId: string | null,
): DataRightsRates {
  const entries = (Object.keys(DATA_RIGHTS_RATE_KEYS) as DataRightsRateName[]).map(
    (name) =>
      [name, resolveRate(rows, DATA_RIGHTS_RATE_KEYS[name], nation, on, tenantId).value] as const,
  );
  return Object.fromEntries(entries) as DataRightsRates;
}

/**
 * A figure for a duty that may not be in force on the date (the complaint acknowledgement applies
 * to complaints received from 19 June 2026): null rather than an error when no row covers it.
 */
export function resolveOptionalRate(
  rows: readonly RateRow[],
  key: string,
  nation: Nation,
  on: string,
  tenantId: string | null,
): number | null {
  try {
    return resolveRate(rows, key, nation, on, tenantId).value;
  } catch (error) {
    if (error instanceof RateNotFoundError) return null;
    throw error;
  }
}

// ------------------------------------------------------------------------------------------------
// Calendar helpers (UK calendar dates as yyyy-mm-dd)
// ------------------------------------------------------------------------------------------------

const ISO_DATE = /^(\d{4})-(\d{2})-(\d{2})$/;
const DAY_MS = 86_400_000;

function parts(iso: string): [number, number, number] | null {
  const m = ISO_DATE.exec(iso);
  if (!m) return null;
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
  const date = new Date(Date.UTC(y, mo - 1, d));
  if (date.getUTCFullYear() !== y || date.getUTCMonth() !== mo - 1 || date.getUTCDate() !== d) {
    return null;
  }
  return [y, mo, d];
}

export function isRealDate(iso: string | null | undefined): iso is string {
  return typeof iso === "string" && parts(iso) !== null;
}

function toIso(y: number, m: number, d: number): string {
  return new Date(Date.UTC(y, m - 1, d)).toISOString().slice(0, 10);
}

/** The corresponding date `months` later; a day that month lacks becomes its last day. */
export function addCalendarMonths(iso: string, months: number): string {
  const p = parts(iso);
  if (!p) throw new RangeError(`Not a real date: ${iso}`);
  const [y, m, d] = p;
  const index = m - 1 + months;
  const year = y + Math.floor(index / 12);
  const month = (((index % 12) + 12) % 12) + 1;
  const last = new Date(Date.UTC(year, month, 0)).getUTCDate();
  return toIso(year, month, Math.min(d, last));
}

export function addCalendarDays(iso: string, days: number): string {
  const p = parts(iso);
  if (!p) throw new RangeError(`Not a real date: ${iso}`);
  return toIso(p[0], p[1], p[2] + days);
}

/** Whole calendar days from `from` to `to` (to minus from). */
export function daysBetween(from: string, to: string): number {
  return Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / DAY_MS);
}

/** The date itself when it is a working day, otherwise the next working day. */
export function onOrNextWorkingDay(iso: string, holidays: BankHolidays): string {
  let cursor = iso;
  while (!isWorkingDay(cursor, holidays)) cursor = addCalendarDays(cursor, 1);
  return cursor;
}

function addWorkingDaysFrom(iso: string, days: number, holidays: BankHolidays): string {
  let cursor = iso;
  let counted = 0;
  while (counted < days) {
    cursor = addCalendarDays(cursor, 1);
    if (isWorkingDay(cursor, holidays)) counted++;
  }
  return cursor;
}

// ------------------------------------------------------------------------------------------------
// Subject access requests (rules 1 to 5)
// ------------------------------------------------------------------------------------------------

export interface DsarPause {
  /** The day the controller asked for clarification. */
  readonly from: string;
  /** The day the clarification arrived; null while still waiting. */
  readonly to: string | null;
}

export type DsarExtensionGrounds = "complex" | "multiple_requests";

export interface DsarExtension {
  /** The day the extension was decided and the requester told, with the reason. */
  readonly decidedOn: string;
  readonly grounds: DsarExtensionGrounds;
  readonly reason: string;
  /** Further months beyond the first, at most `dsar.extension_months`. */
  readonly months: number;
}

export interface DsarInput {
  readonly receivedOn: string;
  readonly identity: { readonly required: boolean; readonly receivedOn: string | null };
  readonly pauses: readonly DsarPause[];
  readonly extension: DsarExtension | null;
  readonly respondedOn: string | null;
}

export interface DsarRates {
  readonly responseMonths: number;
  readonly extensionMonths: number;
  readonly dueSoonDays: number;
}

export type DsarState =
  | "awaiting_identity"
  | "running"
  | "paused"
  | "due_soon"
  | "overdue"
  | "closed";

export type DsarProblem =
  | "invalid_date"
  | "invalid_pause"
  | "extension_too_late"
  | "extension_too_long"
  | "extension_reason_required";

export type DsarClock =
  | {
      readonly ok: true;
      readonly state: DsarState;
      /** The day the clock started: receipt, or the day identity information arrived. */
      readonly startedOn: string | null;
      /** The due date with pauses and any extension; null while waiting or paused. */
      readonly dueOn: string | null;
      /** The due date without the extension (pauses included), to judge an extension against. */
      readonly originalDueOn: string | null;
      readonly pausedDays: number;
      readonly extended: boolean;
      /** For a closed request: whether the response went after the due date. */
      readonly late: boolean | null;
    }
  | { readonly ok: false; readonly problem: DsarProblem; readonly message: string };

const DSAR_MESSAGES: Record<DsarProblem, string> = {
  invalid_date: "A date is not a real date.",
  invalid_pause:
    "A pause must start after the clock starts, end after it starts, and not overlap another.",
  extension_too_late:
    "An extension must be decided, and the requester told, before the original due date.",
  extension_too_long: "An extension adds at least one month and no more than the law allows.",
  extension_reason_required: "Say why the request is complex or why there are several.",
};

const dsarRefusal = (problem: DsarProblem): DsarClock => ({
  ok: false,
  problem,
  message: DSAR_MESSAGES[problem],
});

/** Checks the pauses and adds up the whole days of those that have ended. */
function pausedDaysOf(
  pauses: readonly DsarPause[],
  startedOn: string,
): { ok: true; days: number; open: boolean } | { ok: false } {
  const sorted = [...pauses].sort((a, b) => a.from.localeCompare(b.from));
  let days = 0;
  let previousEnd: string | null = null;
  let open = false;
  for (const pause of sorted) {
    if (!isRealDate(pause.from) || (pause.to !== null && !isRealDate(pause.to)))
      return { ok: false };
    if (open) return { ok: false };
    if (pause.from < startedOn) return { ok: false };
    if (previousEnd !== null && pause.from < previousEnd) return { ok: false };
    if (pause.to === null) {
      open = true;
      continue;
    }
    if (pause.to < pause.from) return { ok: false };
    days += daysBetween(pause.from, pause.to);
    previousEnd = pause.to;
  }
  return { ok: true, days, open };
}

/**
 * The subject access request clock (rules 1 to 5): the corresponding date one month from the start
 * (the last day of a shorter month), plus each whole day paused for clarification, moved to the
 * next working day; extendable by up to two more months for a complex request or several requests
 * when decided before the original due date.
 */
export function dsarClock(
  input: DsarInput,
  rates: DsarRates,
  holidays: BankHolidays,
  today: string,
): DsarClock {
  if (
    !isRealDate(input.receivedOn) ||
    !isRealDate(today) ||
    (input.identity.receivedOn !== null && !isRealDate(input.identity.receivedOn)) ||
    (input.respondedOn !== null && !isRealDate(input.respondedOn)) ||
    (input.extension !== null && !isRealDate(input.extension.decidedOn))
  ) {
    return dsarRefusal("invalid_date");
  }
  const startedOn = input.identity.required ? input.identity.receivedOn : input.receivedOn;
  if (startedOn === null) {
    return {
      ok: true,
      state: input.respondedOn ? "closed" : "awaiting_identity",
      startedOn: null,
      dueOn: null,
      originalDueOn: null,
      pausedDays: 0,
      extended: false,
      late: input.respondedOn ? false : null,
    };
  }
  const paused = pausedDaysOf(input.pauses, startedOn);
  if (!paused.ok) return dsarRefusal("invalid_pause");

  const due = (months: number) =>
    onOrNextWorkingDay(
      addCalendarDays(addCalendarMonths(startedOn, months), paused.days),
      holidays,
    );
  const originalDueOn = due(rates.responseMonths);

  let dueOn = originalDueOn;
  const extension = input.extension;
  if (extension) {
    if (extension.reason.trim().length === 0) return dsarRefusal("extension_reason_required");
    if (
      !Number.isInteger(extension.months) ||
      extension.months < 1 ||
      extension.months > rates.extensionMonths
    ) {
      return dsarRefusal("extension_too_long");
    }
    if (extension.decidedOn > originalDueOn) return dsarRefusal("extension_too_late");
    dueOn = due(rates.responseMonths + extension.months);
  }

  const base = {
    ok: true as const,
    startedOn,
    originalDueOn,
    pausedDays: paused.days,
    extended: extension !== null,
  };
  if (input.respondedOn) {
    return { ...base, state: "closed", dueOn, late: input.respondedOn > dueOn };
  }
  if (paused.open) return { ...base, state: "paused", dueOn: null, late: null };
  const left = daysBetween(today, dueOn);
  const state: DsarState =
    left < 0 ? "overdue" : left <= rates.dueSoonDays ? "due_soon" : "running";
  return { ...base, state, dueOn, late: null };
}

// ------------------------------------------------------------------------------------------------
// Personal data breaches (rules 6 to 8)
// ------------------------------------------------------------------------------------------------

export interface BreachClockInput {
  /** When the controller became aware (a reasonable degree of certainty a breach occurred). */
  readonly awareAt: Date;
  readonly reportedAt: Date | null;
  /** Art 33(1): the reasons for a report made after the deadline. */
  readonly delayReason: string | null;
}

export type BreachClockState = "open" | "overdue" | "reported_on_time" | "reported_late";

export interface BreachClock {
  readonly deadline: Date;
  readonly state: BreachClockState;
  /** Whole hours left until the deadline, never below 0; null once reported. */
  readonly hoursLeft: number | null;
  readonly delayReasonRequired: boolean;
  readonly delayReasonGiven: boolean;
}

/** The ICO clock: `ico.breach.report_hours` from awareness, counting nights and weekends. */
export function breachClock(
  input: BreachClockInput,
  rates: { readonly reportHours: number },
  now: Date,
): BreachClock {
  const deadline = new Date(input.awareAt.getTime() + rates.reportHours * 3_600_000);
  const delayReasonGiven = (input.delayReason ?? "").trim().length > 0;
  if (input.reportedAt) {
    const late = input.reportedAt.getTime() > deadline.getTime();
    return {
      deadline,
      state: late ? "reported_late" : "reported_on_time",
      hoursLeft: null,
      delayReasonRequired: late,
      delayReasonGiven,
    };
  }
  const left = deadline.getTime() - now.getTime();
  return {
    deadline,
    state: left < 0 ? "overdue" : "open",
    hoursLeft: Math.max(0, Math.floor(left / 3_600_000)),
    delayReasonRequired: left < 0,
    delayReasonGiven,
  };
}

/** The factors from breach-response.md section 4, as the person assessing records them. */
export interface BreachFactors {
  readonly peopleAffected: number;
  /** Whether the people can be identified from what was affected. */
  readonly identifiable: boolean;
  /** Health, care or other special category data. */
  readonly specialCategory: boolean;
  /** Safeguarding information, or where a person at risk lives or can be found. */
  readonly safeguardingOrLocationAtRisk: boolean;
  readonly disclosedOutsideOrganisation: boolean;
  /** Staff could not see care records (loss of availability, for example ransomware). */
  readonly careRecordsUnavailable: boolean;
  /** The data was recovered, deleted unread or otherwise put beyond use. */
  readonly contained: boolean;
}

export type BreachSeverity = "low" | "medium" | "high" | "critical";

const SEVERITY_ORDER: Record<BreachSeverity, number> = { low: 0, medium: 1, high: 2, critical: 3 };

export type BreachReason =
  | "safeguarding_or_location"
  | "care_records_unavailable"
  | "outside_organisation"
  | "not_contained"
  | "special_category"
  | "several_people"
  | "not_identifiable"
  | "contained_no_special_category";

export interface BreachAssessment {
  readonly suggestedSeverity: BreachSeverity;
  /** Why, as codes the screen says in words; the person decides. */
  readonly reasons: readonly BreachReason[];
  readonly considerReportingToIco: boolean;
  readonly considerTellingIndividuals: boolean;
}

/**
 * Decision support for a breach (rule 7): a suggested severity and what to consider, from the
 * severity guide. It never decides whether to report: that is a person's decision with reasons
 * (`checkBreachDecision`). An identifiable disclosure outside the organisation is at least medium
 * (H-611).
 */
export function assessBreach(f: BreachFactors): BreachAssessment {
  if (!Number.isInteger(f.peopleAffected) || f.peopleAffected < 0) {
    throw new RangeError("The number of people affected is a whole number of zero or more.");
  }
  const reasons: BreachReason[] = [];
  let severity: BreachSeverity = "low";
  const raise = (to: BreachSeverity, reason: BreachReason) => {
    reasons.push(reason);
    if (SEVERITY_ORDER[to] > SEVERITY_ORDER[severity]) severity = to;
  };
  if (f.safeguardingOrLocationAtRisk) raise("critical", "safeguarding_or_location");
  if (f.careRecordsUnavailable) raise("critical", "care_records_unavailable");
  if (f.identifiable) {
    if (f.disclosedOutsideOrganisation) {
      // Receiving care itself reveals health, and the people affected are vulnerable, so any
      // identifiable disclosure outside the organisation suggests at least medium, even for one
      // person with no special category data (ICO breach guidance; recommended answer to H-611).
      raise(f.peopleAffected > 1 || f.specialCategory ? "high" : "medium", "outside_organisation");
    }
    if (!f.contained && f.specialCategory) raise("high", "not_contained");
    if (f.specialCategory) raise("medium", "special_category");
    if (f.peopleAffected > 1) raise("medium", "several_people");
  } else if (reasons.length === 0) {
    reasons.push("not_identifiable");
  }
  if (reasons.length === 0) reasons.push("contained_no_special_category");
  return {
    suggestedSeverity: severity,
    reasons,
    considerReportingToIco: SEVERITY_ORDER[severity] >= SEVERITY_ORDER.medium,
    considerTellingIndividuals: SEVERITY_ORDER[severity] >= SEVERITY_ORDER.high,
  };
}

/** The shortest written reasoning a breach decision takes (Art 33(5): record the reasoning). */
export const BREACH_REASONING_MIN = 20;

export interface BreachDecision {
  readonly reportToIco: boolean;
  readonly tellIndividuals: boolean;
  readonly reasoning: string;
  /** Who decided (tenant_user id). */
  readonly decidedBy: string | null;
  /** Ticked when deciding against the suggestion: it was read and considered. */
  readonly acknowledgedSuggestion: boolean;
}

export type BreachDecisionProblem =
  | "reasoning_required"
  | "decider_required"
  | "acknowledgement_required";

const BREACH_MESSAGES: Record<BreachDecisionProblem, string> = {
  reasoning_required: "Write down the reasons for the decision.",
  decider_required: "Record who made the decision.",
  acknowledgement_required:
    "The decision goes against the suggested severity: confirm it was considered.",
};

/** A person's breach decision is recorded only with reasons, a decider and, against the suggestion, an acknowledgement. */
export function checkBreachDecision(
  decision: BreachDecision,
  assessment: BreachAssessment,
):
  | { readonly ok: true }
  | { readonly ok: false; readonly problem: BreachDecisionProblem; readonly message: string } {
  const refuse = (problem: BreachDecisionProblem) =>
    ({ ok: false, problem, message: BREACH_MESSAGES[problem] }) as const;
  if (decision.reasoning.trim().length < BREACH_REASONING_MIN) return refuse("reasoning_required");
  if (!decision.decidedBy) return refuse("decider_required");
  const against =
    (!decision.reportToIco && assessment.considerReportingToIco) ||
    (!decision.tellIndividuals && assessment.considerTellingIndividuals);
  if (against && !decision.acknowledgedSuggestion) return refuse("acknowledgement_required");
  return { ok: true };
}

// ------------------------------------------------------------------------------------------------
// Data protection complaints (rules 9 and 10)
// ------------------------------------------------------------------------------------------------

export interface ComplaintInput {
  readonly receivedOn: string;
  readonly acknowledgedOn: string | null;
  /** The last time the complainant was told how it is going (or acknowledged). */
  readonly lastContactOn: string | null;
  readonly closedOn: string | null;
}

export interface ComplaintRates {
  /** `dp_complaint.acknowledge_days` in force on the day of receipt; null before the duty began. */
  readonly acknowledgeDays: number | null;
  readonly targetWorkingDays: number;
  readonly updateIntervalMonths: number;
}

export type AcknowledgementState = "not_applicable" | "due" | "overdue" | "done" | "done_late";
export type UpdateState = "due" | "overdue" | "closed";

export interface ComplaintClock {
  readonly acknowledgeDueOn: string | null;
  /** The tenant's working-day target, shown alongside the duty, never instead of it. */
  readonly acknowledgeTargetOn: string;
  readonly acknowledgement: AcknowledgementState;
  readonly nextUpdateDueOn: string | null;
  readonly update: UpdateState;
}

/** The complaint clocks: acknowledgement within the statutory days, and updates while open. */
export function complaintClock(
  input: ComplaintInput,
  rates: ComplaintRates,
  holidays: BankHolidays,
  today: string,
): ComplaintClock {
  const acknowledgeDueOn =
    rates.acknowledgeDays === null
      ? null
      : addCalendarDays(input.receivedOn, rates.acknowledgeDays);
  const acknowledgeTargetOn = addWorkingDaysFrom(
    input.receivedOn,
    rates.targetWorkingDays,
    holidays,
  );
  let acknowledgement: AcknowledgementState;
  if (input.acknowledgedOn) {
    acknowledgement =
      acknowledgeDueOn !== null && input.acknowledgedOn > acknowledgeDueOn ? "done_late" : "done";
  } else if (acknowledgeDueOn === null) {
    acknowledgement = "not_applicable";
  } else {
    acknowledgement = today > acknowledgeDueOn ? "overdue" : "due";
  }
  if (input.closedOn) {
    return {
      acknowledgeDueOn,
      acknowledgeTargetOn,
      acknowledgement,
      nextUpdateDueOn: null,
      update: "closed",
    };
  }
  const from = input.lastContactOn ?? input.acknowledgedOn ?? input.receivedOn;
  const nextUpdateDueOn = addCalendarMonths(from, rates.updateIntervalMonths);
  return {
    acknowledgeDueOn,
    acknowledgeTargetOn,
    acknowledgement,
    nextUpdateDueOn,
    update: today > nextUpdateDueOn ? "overdue" : "due",
  };
}

export type ComplaintClosureProblem = "outcome_required" | "ico_right_required";

/** A complaint closes only with its outcome, which tells the complainant they may go to the ICO. */
export function checkComplaintClosure(input: {
  readonly outcomeRecorded: boolean;
  readonly icoRightStated: boolean;
}):
  | { readonly ok: true }
  | { readonly ok: false; readonly problem: ComplaintClosureProblem; readonly message: string } {
  if (!input.outcomeRecorded) {
    return { ok: false, problem: "outcome_required", message: "Record the outcome first." };
  }
  if (!input.icoRightStated) {
    return {
      ok: false,
      problem: "ico_right_required",
      message: "The outcome must tell the complainant they can complain to the ICO.",
    };
  }
  return { ok: true };
}
