/**
 * Recording a dose (medicines.md rules 13 to 23; master prompt 10.2 and 10.3; HZ-001, HZ-003,
 * HZ-004, HZ-005, HZ-119). `checkAdministration` is the one rule the API runs for every record,
 * from the web or a device, and `checkCorrection` runs it again on what a correction says: it
 * refuses a record without a selected person, a dose and an outcome; refuses one for someone
 * else's medicine, a dose already recorded, a scheduled dose before its window opens, a dose given
 * while an earlier dose of the medicine that day has no outcome, a version not in force, a
 * when-required dose given over its 24-hour maximum, or a member whose medicines competence has
 * lapsed without an override or was never signed off; and asks for a reason for an early or late
 * dose, a different amount, or a dose inside a minimum interval. A dose the person took themselves,
 * or their family gave, is a fact: its amount counts towards the maximum, and it is recorded even
 * before its window or over the maximum, flagged, and over the maximum escalated urgently. Harbour
 * never calculates a dose or says whether one is right: it compares what was given with what the
 * entry, or its checked dosing record, says.
 */

import type { Severity } from "../platform/notifications";
import { formatUkDate, formatUkTime } from "../shared/time";
import { type CompetenceOverride, type CompetenceProblem, checkCompetenceGate } from "./competence";
import { type Dose, formatDose } from "./dose";
import { type DosingRecord, type VariableDoseProblem, variableDoseFor } from "./dosing-record";
import {
  type GivenDose,
  intervalConflicts,
  prnDosesNotCounted,
  prnMaximumExceeded,
} from "./intervals";
import {
  type MarEntry,
  type MedicinesCompetence,
  marEntryDoses,
  marEntryStatus,
  type UncheckedEntryPolicy,
} from "./mar-entry";
import type { MedicinesRates } from "./rates";
import { type MarDose, ukDateOf } from "./schedule";
import {
  closerThanScheduled,
  doseWindow,
  earlyNeedsReason,
  isTimeCritical,
  recordedTiming,
} from "./timing";

export const ADMINISTRATION_OUTCOMES = [
  "given",
  "refused",
  "omitted",
  "not_available",
  "self_administered",
  "given_by_family",
  "withheld",
] as const;
export type AdministrationOutcome = (typeof ADMINISTRATION_OUTCOMES)[number];

/** The words the MAR, the round and every print use for an outcome (never a colour alone). */
export const OUTCOME_WORDS: Readonly<Record<AdministrationOutcome, string>> = {
  given: "Given",
  refused: "Refused",
  omitted: "Not given",
  not_available: "Not available",
  self_administered: "Taken by the person themselves",
  given_by_family: "Given by family, as agreed",
  withheld: "Withheld",
};

/** The coded reasons each outcome takes; `other` always needs words. */
export const OUTCOME_REASONS: Readonly<Record<AdministrationOutcome, readonly string[]>> = {
  given: [],
  self_administered: [],
  given_by_family: [],
  refused: ["declined", "other"],
  omitted: [
    "asleep",
    "away_from_home",
    "in_hospital",
    "nil_by_mouth",
    "unable_to_swallow",
    "vomiting",
    "other",
  ],
  not_available: ["out_of_stock", "not_delivered", "other"],
  withheld: ["prescriber_instruction", "outside_prescribed_parameters", "other"],
};

export const REASON_WORDS: Readonly<Record<string, string>> = {
  declined: "The person declined it",
  asleep: "Asleep",
  away_from_home: "Away from the home",
  in_hospital: "In hospital",
  nil_by_mouth: "Nil by mouth",
  unable_to_swallow: "Unable to swallow",
  vomiting: "Vomiting",
  out_of_stock: "Out of stock",
  not_delivered: "Not delivered",
  prescriber_instruction: "The prescriber said to withhold it",
  outside_prescribed_parameters: "Outside the limits the prescriber set",
  other: "Other",
};

/** Outcomes in which the person took the dose: they count for intervals and the 24-hour maximum. */
export const DOSE_TAKEN_OUTCOMES: ReadonlySet<AdministrationOutcome> = new Set([
  "given",
  "self_administered",
  "given_by_family",
]);

/**
 * Outcomes recording a dose staff did not give but the person already took: facts, so the rules
 * that decide whether staff may give a dose (its window, an earlier dose outstanding, the entry in
 * force, the dosing record, the 24-hour maximum) flag them for review rather than refuse them, and
 * they are always recorded (H-1062).
 */
export const DOSE_ALREADY_TAKEN_OUTCOMES: ReadonlySet<AdministrationOutcome> = new Set([
  "self_administered",
  "given_by_family",
]);

export interface AdministrationInput {
  /** The person selected on the screen. */
  readonly personId: string | null;
  /** The medicine selected. */
  readonly entry: MarEntry | null;
  /** The scheduled dose; null for a when-required dose. */
  readonly dueAt: Date | null;
  readonly outcome: AdministrationOutcome | null;
  readonly reason: { readonly code: string; readonly note: string | null } | null;
  /**
   * The amount given, in the entry's unit; required for "given", and for a dose already taken from
   * an entry with a 24-hour maximum, so that it counts towards it.
   */
  readonly amount: { readonly quantity: number; readonly unitCode: string } | null;
  readonly amountDifferenceReason: string | null;
  /**
   * Drift-corrected time the dose was given (`givenAt`) or the outcome happened. Every timing,
   * interval, maximum and competence rule reads it.
   */
  readonly at: Date;
  /**
   * When the record is made, on the server's clock: the API sets it from its own time, never from
   * the request (for a record made offline, the drift-corrected time of recording, which it keeps
   * beside the receipt time). A dose recorded after it was given must have been given before this.
   */
  readonly recordedAt: Date;
  readonly timingReason: string | null;
  readonly intervalOverrideReason: string | null;
  /** The member who gave the dose or recorded the outcome, and their competence at `at`. */
  readonly administrator: { readonly id: string; readonly competence: MedicinesCompetence };
  /**
   * The administrator's medicines competence at `recordedAt`, which the API reads from workforce's
   * port for that time too: an ordinary round record is judged at both times, and a competence can
   * lapse (at 00:00) between them.
   */
  readonly competenceAtRecording: MedicinesCompetence;
  readonly competenceOverride: CompetenceOverride | null;
  readonly policy: UncheckedEntryPolicy;
  /** The scheduled dose already has an outcome: a change is a correction of that record. */
  readonly alreadyRecorded: boolean;
  /**
   * Set when staff record a dose, or any other outcome, after the event, beyond the round's record
   * delay or when it would be judged differently at the time of recording: a fact, so the rules
   * that decide whether a dose may be given flag it instead of refusing it, and it is never left off
   * the record (H-1067). It needs a reason of `GIVEN_BEFORE_RECORDED_REASON_MIN_LENGTH` characters
   * or more, a time given (`at`) strictly before `recordedAt`, and a recorder with current
   * competence; `administrator` is the member who gave it, whose competence then is checked. Every
   * use is flagged `given_before_recorded`, counted for the override report and escalated to the
   * nurse in charge: urgently when it breaks a rule. Null on the round, where those rules refuse.
   */
  readonly givenBeforeRecorded: {
    readonly reason: string;
    /** Who records it now (rule 22: current competence, or an override of an expired one). */
    readonly recordedBy: {
      readonly id: string;
      readonly competence: MedicinesCompetence;
      readonly override: CompetenceOverride | null;
    };
  } | null;
  /**
   * The due times of this entry's scheduled doses that already have an outcome, at least those in
   * the 24 hours before the dose, so a dose is not given while an earlier one has none.
   */
  readonly recordedDueTimes: readonly Date[];
  /** The entry and its earlier versions (`entryVersionIds`). */
  readonly versionIds: ReadonlySet<string>;
  /** Doses the person took, from every entry, for intervals and the 24-hour total. */
  readonly history: readonly GivenDose[];
  readonly dosingRecords: readonly DosingRecord[];
}

export type AdministrationProblem =
  | CompetenceProblem
  | "person_required"
  | "dose_required"
  | "outcome_required"
  | "wrong_person"
  | "dose_not_scheduled"
  | "dose_not_due_yet"
  | "earlier_dose_outstanding"
  | "already_recorded"
  | "reason_required"
  | "reason_not_for_outcome"
  | "note_required"
  | "entry_not_usable"
  | "amount_required"
  | "amount_wrong_unit"
  | "amount_not_a_dose"
  | "amount_differs_needs_reason"
  | "given_before_recorded_reason_required"
  | "given_after_recorded"
  | "recorded_in_future"
  | "recorded_after_delay"
  | "differs_at_recording_time"
  | "no_checked_dosing_record"
  | "dosing_record_not_checked"
  | "dosing_record_differs"
  | "dosing_records_disagree"
  | "timing_reason_required"
  | "interval_override_required"
  | "prn_maximum_reached";

export type AdministrationFlag =
  | "early"
  | "late"
  /** Given closer to the entry's last dose than the schedule less the window allows, with why. */
  | "close_to_last_dose"
  /** Given closer to the entry's next dose (a record entered later) than the schedule allows. */
  | "close_to_next_dose"
  /** A correction (`checkCorrection`): every one, with its kinds, counted for the report. */
  | "corrected"
  /** A correction that removes a dose recorded as taken, or lowers the amount counted. */
  | "dose_removed"
  /** A correction that moves the time of a dose recorded as taken. */
  | "dose_moved"
  | "interval_override"
  | "competence_override"
  | "amount_differs"
  | "entry_not_yet_checked"
  /** A dose of the medicine in another unit is near this one and not in the 24-hour total. */
  | "other_unit_not_counted"
  /** A dose already taken that went over the 24-hour maximum (escalated urgently). */
  | "over_maximum"
  | ReviewFlag;

/**
 * What a dose that has already happened (taken by the person, given by family, given before it was
 * recorded, or a correction) is flagged with, where a dose about to be given would be refused. Each
 * is sent to the nurse in charge to review (`review` escalation).
 */
export type ReviewFlag =
  /** Recorded after it was given (`givenBeforeRecorded`): every use, counted for the report. */
  | "given_before_recorded"
  /** Recorded after it was given by someone other than the member who gave it. */
  | "given_by_someone_else"
  | "before_window"
  | "earlier_dose_outstanding"
  | "entry_not_usable"
  | "no_usable_dosing_record"
  | "amount_in_other_unit"
  | "competence_not_current"
  | "inside_minimum_interval"
  /** The corrected record breaks the maximum, an interval or the scheduled gap; the original did not. */
  | "breach_created"
  /** The original record broke the maximum, an interval or the scheduled gap; the corrected one does not. */
  | "breach_hidden"
  /** Recorded after the event, and the rules give a different answer at the time it was recorded. */
  | "differs_when_recorded";

/** The words for each review flag, in the review escalation and wherever the record shows it. */
export const REVIEW_FLAG_WORDS: Readonly<Record<ReviewFlag, string>> = {
  given_before_recorded: "it was recorded only after it happened",
  given_by_someone_else: "it was recorded by someone other than the member who gave it",
  before_window: "the dose was taken before its window opened",
  earlier_dose_outstanding: "an earlier dose had no outcome",
  entry_not_usable: "the entry may not be given from at that time",
  no_usable_dosing_record: "no checked dosing record gave the day's dose",
  amount_in_other_unit: "the amount is in another unit, so it is not in the 24-hour total",
  competence_not_current: "the member who gave it had no current medicines competence",
  inside_minimum_interval: "it was taken inside the minimum interval",
  breach_created: "the correction brings it over a limit the original record kept within",
  breach_hidden: "the correction takes away a breach of a limit the original record showed",
  differs_when_recorded:
    "the rules give a different answer at the time it was recorded from the time it was given",
};

/** Flags that need a reason: kept on a round record when they apply at either time it is judged. */
const REASONED_FLAGS: ReadonlySet<AdministrationFlag> = new Set([
  "early",
  "late",
  "close_to_last_dose",
  "close_to_next_dose",
  "interval_override",
  "competence_override",
]);

/** The time-dependent rules, in words, for saying where two times disagree. */
const RULE_WORDS: Readonly<Record<string, string>> = {
  early: "early for a time-critical medicine",
  late: "late",
  close_to_last_dose: "closer to the last dose than the schedule allows",
  close_to_next_dose: "closer to the next dose than the schedule allows",
  interval_override: "inside the minimum interval",
  interval_override_required: "inside the minimum interval",
  competence_override: "under a competence override",
  over_maximum: "over the 24-hour maximum",
  prn_maximum_reached: "over the 24-hour maximum",
  timing_reason_required: "early, late or too close to another dose",
  dose_not_due_yet: "before its window opened",
  entry_not_usable: "from an entry that may not be given from",
  competence_expired: "by a member whose competence had expired",
  competence_not_held: "by a member never signed off",
  override_not_in_force: "outside the competence override",
};

const REVIEW_FLAG_SET: ReadonlySet<string> = new Set(Object.keys(REVIEW_FLAG_WORDS));

/** What a correction changes (`corrected` flag): the outcome, the amount, the time or the giver. */
export type CorrectionKind = "outcome" | "amount" | "time" | "giver" | "detail";

/** The limits re-checked around a dose before and after a correction. */
export type DoseLimit = "maximum" | "interval" | "gap";
const LIMIT_WORDS: Readonly<Record<DoseLimit, string>> = {
  maximum: "the 24-hour maximum",
  interval: "the minimum interval",
  gap: "the scheduled gap between doses",
};

/**
 * Review flags that record how the record was made rather than a rule the dose broke: alone they
 * raise a warning; with any other review flag the escalation is urgent.
 */
const ROUTE_FLAGS: ReadonlySet<ReviewFlag> = new Set([
  "given_before_recorded",
  "given_by_someone_else",
]);

/**
 * The shortest reason accepted for recording a dose after it was given, and for any correction, as
 * for break-glass search (`SEARCH_LIMITS.breakGlassReasonMinLength`): enough to say what happened,
 * so "." or "typo" cannot pass.
 */
export const GIVEN_BEFORE_RECORDED_REASON_MIN_LENGTH = 20;

/**
 * Flags the override report (slice 45) counts per member and period, so a route meant for the
 * exception, or correcting records, cannot quietly become routine (HZ-004, HZ-119, H-1067).
 */
export const REPORTED_FLAGS = [
  "competence_override",
  "given_before_recorded",
  "corrected",
  "dose_removed",
  "dose_moved",
] as const;
export type ReportedFlag = (typeof REPORTED_FLAGS)[number];

/** How often each member's records carry each reported flag, for the override report. */
export function countReportedFlags(
  records: readonly {
    readonly recordedBy: string;
    readonly flags: readonly AdministrationFlag[];
  }[],
): ReadonlyMap<string, Readonly<Record<ReportedFlag, number>>> {
  const counts = new Map<string, Record<ReportedFlag, number>>();
  for (const record of records) {
    const row =
      counts.get(record.recordedBy) ??
      (Object.fromEntries(REPORTED_FLAGS.map((f) => [f, 0])) as Record<ReportedFlag, number>);
    for (const flag of REPORTED_FLAGS) if (record.flags.includes(flag)) row[flag] += 1;
    counts.set(record.recordedBy, row);
  }
  return counts;
}

/**
 * An escalation the API raises through the notification centre's chain when the record is saved
 * (slice 48, which sets who receives it and its acknowledgement): `urgent` when the person has taken
 * more than the prescriber allows in 24 hours, or a dose was given with no checked dose to compare
 * it with; for review, `warning` when only the way it was recorded needs review and `urgent` when a
 * dose that has happened broke a rule; for a correction that removes, lowers or moves a dose,
 * `warning`, or `urgent` when the entry has a 24-hour maximum or a minimum interval, because the
 * change frees room for another dose.
 */
export interface AdministrationEscalation {
  readonly severity: Extract<Severity, "urgent" | "warning">;
  readonly reason: "over_maximum" | "no_prescribed_dose" | "review" | "dose_removed" | "dose_moved";
  readonly message: string;
}

export interface AdministrationIssue {
  readonly problem: AdministrationProblem;
  readonly message: string;
}

export type AdministrationCheck =
  | {
      readonly ok: true;
      readonly flags: readonly AdministrationFlag[];
      /** The dose the entry says to give, a variable dose read from its checked dosing record. */
      readonly prescribed: Dose | null;
      /** What the API escalates when it saves the record; empty for almost every record. */
      readonly escalations: readonly AdministrationEscalation[];
    }
  | { readonly ok: false; readonly issues: readonly AdministrationIssue[] };

type AdministrationRates = Pick<
  MedicinesRates,
  | "doseEarlyMinutes"
  | "doseLateMinutes"
  | "timeCriticalEarlyMinutes"
  | "timeCriticalLateMinutes"
  | "paracetamolMinIntervalHours"
  | "competenceOverrideMaxHours"
  | "clockDriftMinutes"
  | "recordDelayToleranceMinutes"
>;

const blank = (value: string | null | undefined) =>
  value === null || value === undefined || value.trim() === "";

const VARIABLE_DOSE_MESSAGES: Readonly<Record<VariableDoseProblem, string>> = {
  no_dosing_record:
    "No checked dosing record gives this day's dose. Do not give it until the dosing record is recorded and checked.",
  dosing_record_not_checked:
    "The latest dosing record for this day has not been checked. Do not give it until a second person has checked it against its source; an older record is never used instead.",
  dosing_record_differs:
    "The check of the latest dosing record for this day found a difference from its source. Do not give it: tell the nurse in charge, who records the corrected dosing record.",
  dosing_records_disagree:
    "Two dosing records made at the same time give different doses for this day. Do not give it: tell the nurse in charge.",
};
const VARIABLE_DOSE_PROBLEMS: Readonly<Record<VariableDoseProblem, AdministrationProblem>> = {
  no_dosing_record: "no_checked_dosing_record",
  dosing_record_not_checked: "dosing_record_not_checked",
  dosing_record_differs: "dosing_record_differs",
  dosing_records_disagree: "dosing_records_disagree",
};

const DAY_MS = 86_400_000;
const MINUTE_MS = 60_000;

const listWords = (items: readonly string[]) =>
  items.length === 1
    ? (items[0] as string)
    : `${items.slice(0, -1).join(", ")} and ${items.at(-1)}`;

/** The words that name earlier doses with no outcome, and what to do first. */
function earlierDosesMessage(doses: readonly MarDose[]): string {
  const days = [...new Set(doses.map((d) => formatUkDate(d.dueAt)))];
  const list =
    days.length === 1
      ? `${listWords(doses.map((d) => d.time))} on ${days[0]}`
      : listWords(doses.map((d) => `${d.time} on ${formatUkDate(d.dueAt)}`));
  return doses.length === 1
    ? `The dose at ${list} has no outcome. Record what happened to it before giving this one.`
    : `The doses at ${list} have no outcome. Record what happened to them before giving this one.`;
}

/** Whether an amount matches what was prescribed: the amount, within the range, or the dosing record's. */
function amountMatches(
  prescribed: Dose,
  quantity: number,
  variableQuantity: number | null,
): boolean {
  if (prescribed.kind === "amount") return quantity === prescribed.quantity;
  if (prescribed.kind === "range") return quantity >= prescribed.from && quantity <= prescribed.to;
  return variableQuantity !== null && quantity === variableQuantity;
}

/**
 * The entry's doses either side of a scheduled dose given at `at` that are closer to it than the
 * schedule less the window's early side allows (`closerThanScheduled`): the last dose before it,
 * and the next dose after it, so a dose entered later than others is checked against those that
 * follow it too (#162 third review's re-check). A dose at the same instant counts as the last.
 */
function closeDoses(
  entry: MarEntry,
  versionIds: ReadonlySet<string>,
  history: readonly GivenDose[],
  at: Date,
  dueAt: Date,
  rates: AdministrationRates,
): { readonly last: GivenDose | null; readonly next: GivenDose | null } {
  const own = history.filter((d) => versionIds.has(d.entryId));
  const t = at.getTime();
  const last = own
    .filter((d) => d.at.getTime() <= t)
    .sort((a, b) => b.at.getTime() - a.at.getTime())[0];
  const next = own
    .filter((d) => d.at.getTime() > t)
    .sort((a, b) => a.at.getTime() - b.at.getTime())[0];
  const timeCritical = isTimeCritical(entry);
  let closeLast = false;
  if (last) {
    const previousDue = marEntryDoses(entry, {
      from: new Date(last.at.getTime() - DAY_MS),
      to: dueAt,
    }).at(-1);
    closeLast = closerThanScheduled(
      doseWindow(dueAt, timeCritical, rates),
      at,
      last.at,
      previousDue?.dueAt ?? null,
    );
  }
  let closeNext = false;
  if (next) {
    const nextDue = marEntryDoses(entry, {
      from: new Date(dueAt.getTime() + 1),
      to: new Date(next.at.getTime() + DAY_MS),
    })[0];
    closeNext =
      nextDue !== undefined &&
      closerThanScheduled(doseWindow(nextDue.dueAt, timeCritical, rates), next.at, at, dueAt);
  }
  return { last: closeLast ? (last ?? null) : null, next: closeNext ? (next ?? null) : null };
}

/**
 * The limits a dose taken at `at` breaks against the other doses in `history`, both ways: the
 * 24-hour maximum over every 24 hours containing it (when `counted`, its amount in the entry's
 * unit, is known), the minimum intervals, and, for a scheduled dose, the scheduled gap. Used to
 * compare a record before and after a correction (#162 third review's re-check).
 */
function limitsBroken(
  entry: MarEntry,
  versionIds: ReadonlySet<string>,
  history: readonly GivenDose[],
  dose: { readonly at: Date; readonly counted: number | null; readonly dueAt: Date | null },
  rates: AdministrationRates,
): ReadonlySet<DoseLimit> {
  const broken = new Set<DoseLimit>();
  if (
    dose.counted !== null &&
    prnMaximumExceeded(entry, versionIds, history, dose.counted, dose.at) !== null
  ) {
    broken.add("maximum");
  }
  if (intervalConflicts(entry, versionIds, history, dose.at, rates).length > 0) {
    broken.add("interval");
  }
  if (dose.dueAt !== null) {
    const close = closeDoses(entry, versionIds, history, dose.at, dose.dueAt, rates);
    if (close.last !== null || close.next !== null) broken.add("gap");
  }
  return broken;
}

/** A dose's amount in the entry's own unit when it was taken; null when it does not count. */
function countedAmount(
  outcome: AdministrationOutcome | null,
  amount: { readonly quantity: number; readonly unitCode: string } | null,
  unitCode: string | null,
): number | null {
  if (outcome === null || !DOSE_TAKEN_OUTCOMES.has(outcome) || amount === null) return null;
  if (unitCode !== null && amount.unitCode !== unitCode) return null;
  return Number.isFinite(amount.quantity) && amount.quantity > 0 ? amount.quantity : null;
}

/**
 * Checks one administration record; returns every problem, or the flags the record carries and
 * what the API escalates. On the round the rules that decide whether a dose may be given refuse it;
 * a dose the person took themselves, or given by family, or that staff record after giving it
 * (`givenBeforeRecorded`), is a fact, and those rules flag it for review instead.
 */
export function checkAdministration(
  input: AdministrationInput,
  rates: AdministrationRates,
): AdministrationCheck {
  // The same record judged at the server's time of recording, with the competence at that time.
  const recordingTime = (record: AdministrationInput): AdministrationInput => ({
    ...record,
    at: record.recordedAt,
    administrator: { ...record.administrator, competence: record.competenceAtRecording },
    givenBeforeRecorded: null,
  });
  const route = input.givenBeforeRecorded;
  if (route !== null) {
    // A record made after the event is judged at the time given, and also at the time it was
    // recorded: where the rules give a different answer it is flagged and escalated urgently, so a
    // dose dated back through a stop, a lapse or its lateness is never only a warning (#162 final
    // check).
    const atGiven = checkRecord(input, rates, true, route, null, input.at, []);
    if (!atGiven.ok) return atGiven;
    const atRecording = checkRecord(
      recordingTime(input),
      rates,
      true,
      null,
      null,
      input.recordedAt,
      [],
    );
    const differences = disagreements(atGiven, atRecording);
    if (differences.length === 0) return atGiven;
    return checkRecord(input, rates, true, route, null, input.at, differences);
  }
  // An ordinary round record must pass every rule at both the time given and the server's time of
  // recording (the maximum, intervals and gap, the window, the entry in force, competence and any
  // override), so the allowances on the entered time (the record delay back, the clock tolerance
  // forward) can never be used to step past a limit; lateness is judged at the later of the two,
  // so a dose recorded late shows as late. Where a rule passes at one time and fails at the
  // other, the record is refused on the round and goes by the flagged route, which is escalated;
  // a flag that needs a reason at either time stays on the record (#162 third review's third
  // re-check and final check).
  const lateAt = new Date(Math.max(input.at.getTime(), input.recordedAt.getTime()));
  const atGiven = checkRecord(input, rates, false, null, null, lateAt, []);
  if (!atGiven.ok || input.at.getTime() === input.recordedAt.getTime()) return atGiven;
  const atRecording = checkRecord(recordingTime(input), rates, false, null, null, lateAt, []);
  const breaking = (flags: readonly AdministrationFlag[]) =>
    flags.filter(
      (f) => f === "over_maximum" || (REVIEW_FLAG_SET.has(f) && !ROUTE_FLAGS.has(f as ReviewFlag)),
    );
  const differences = atRecording.ok
    ? breaking(atRecording.flags)
        .filter((f) => !breaking(atGiven.flags).includes(f))
        .map((f) =>
          f === "over_maximum"
            ? "it would go over the 24-hour maximum"
            : REVIEW_FLAG_WORDS[f as ReviewFlag],
        )
    : atRecording.issues.map((i) => i.message);
  if (differences.length > 0) {
    return {
      ok: false,
      issues: [
        {
          problem: "differs_at_recording_time",
          message: `At ${formatUkTime(input.recordedAt)}, when it is recorded, this would not pass: ${differences.join(" ")} Record it as made after the event, and say why, so the nurse in charge reviews it.`,
        },
      ],
    };
  }
  const reasoned = atRecording.ok
    ? atRecording.flags.filter((f) => REASONED_FLAGS.has(f) && !atGiven.flags.includes(f))
    : [];
  return reasoned.length > 0 ? { ...atGiven, flags: [...atGiven.flags, ...reasoned] } : atGiven;
}

/**
 * Where the time-dependent rules give a different answer for the same record at two times: each
 * rule that fails, or needs a reason, at one time and not the other, in words.
 */
function disagreements(a: AdministrationCheck, b: AdministrationCheck): readonly string[] {
  const outcomes = (check: AdministrationCheck): ReadonlyMap<string, string> =>
    new Map(
      check.ok
        ? check.flags
            .filter(
              (f) =>
                REASONED_FLAGS.has(f) ||
                f === "over_maximum" ||
                (REVIEW_FLAG_SET.has(f) && !ROUTE_FLAGS.has(f as ReviewFlag)),
            )
            .map((f) => [
              RULE_WORDS[f] ?? f,
              RULE_WORDS[f] ?? REVIEW_FLAG_WORDS[f as ReviewFlag] ?? f,
            ])
        : check.issues.map((i) => [
            RULE_WORDS[i.problem] ?? i.problem,
            RULE_WORDS[i.problem] ?? i.message,
          ]),
    );
  const atA = outcomes(a);
  const atB = outcomes(b);
  const words = [
    ...[...atA].filter(([key]) => !atB.has(key)).map(([, w]) => w),
    ...[...atB].filter(([key]) => !atA.has(key)).map(([, w]) => w),
  ];
  return [...new Set(words)];
}

/** A record of a dose made after it was given: why, and who records it now. */
type RecordedAfterGiving = NonNullable<AdministrationInput["givenBeforeRecorded"]>;

/**
 * The rules for a record. `afterTheEvent`: the record is of something that has already happened
 * (a dose given before it was recorded, or any correction), so the rules that decide whether a
 * dose may be given, and the competence of whoever gave it then, flag it for review instead of
 * refusing it: refusing would leave a dose given off the record, and out of the intervals and the
 * maximum for the next one (#162 second clinical review). `route`: the record says a dose happened
 * and is made after it, by `givenBeforeRecorded` or by a correction to a dose outcome, so it meets
 * the route's own rules (a reason, a time given before `recordedAt`, a competent recorder, every
 * use flagged, counted and escalated; #162 third clinical review and its re-check).
 */
function checkRecord(
  input: AdministrationInput,
  rates: AdministrationRates,
  afterTheEvent: boolean,
  route: RecordedAfterGiving | null,
  /** The record a correction corrects, when this is a correction. */
  original: RecordedAdministration | null,
  /** The time lateness is judged at: the later of the times given and recorded on the round. */
  lateAt: Date,
  /** For a record made after the event: where the rules disagree at the time it was recorded. */
  differsWhenRecorded: readonly string[],
): AdministrationCheck {
  const issues: AdministrationIssue[] = [];
  const add = (problem: AdministrationProblem, message: string) =>
    issues.push({ problem, message });
  const { entry, outcome } = input;

  // 10.3: never without a selected person, a dose and an outcome (HZ-003).
  if (blank(input.personId)) add("person_required", "Choose the person first.");
  if (entry === null || (entry.directions.kind === "regular" && input.dueAt === null)) {
    add("dose_required", "Choose the medicine and the dose this record is for.");
  }
  if (outcome === null)
    add("outcome_required", "Choose what happened: given, refused, not given and so on.");
  if (issues.length > 0 || entry === null || outcome === null) return { ok: false, issues };
  if (input.personId !== entry.personId) {
    return {
      ok: false,
      issues: [
        {
          problem: "wrong_person",
          message: "This medicine is on another person's MAR. Check who you are with.",
        },
      ],
    };
  }

  // The scheduled dose must be one the entry has; a when-required dose has no due time.
  let dose: MarDose | null = null;
  if (entry.directions.kind === "regular" && input.dueAt) {
    const dueAt = input.dueAt;
    dose =
      marEntryDoses(entry, { from: dueAt, to: new Date(dueAt.getTime() + 1) }).find(
        (d) => d.dueAt.getTime() === dueAt.getTime(),
      ) ?? null;
    if (dose === null) add("dose_not_scheduled", "This medicine has no dose due at that time.");
  } else if (input.dueAt !== null) {
    add("dose_not_scheduled", "A when-required medicine has no due time.");
  }
  if (input.alreadyRecorded) {
    add(
      "already_recorded",
      "This dose already has an outcome. To change it, record a correction to that record.",
    );
  }

  // Coded reasons: required where the outcome has them; "other" and "withheld" need words.
  const codes = OUTCOME_REASONS[outcome];
  if (codes.length > 0 && input.reason === null) add("reason_required", "Choose the reason.");
  if (input.reason !== null && !codes.includes(input.reason.code)) {
    add("reason_not_for_outcome", "That reason does not go with this outcome.");
  }
  if ((input.reason?.code === "other" || outcome === "withheld") && blank(input.reason?.note)) {
    add(
      "note_required",
      outcome === "withheld" ? "Say who said to withhold it and why." : "Say what happened.",
    );
  }

  const flags: AdministrationFlag[] = [];
  const escalations: AdministrationEscalation[] = [];
  const review: ReviewFlag[] = [];
  const breaches: { created: readonly DoseLimit[]; hidden: readonly DoseLimit[] } = {
    created: [],
    hidden: [],
  };
  const alreadyTaken = DOSE_ALREADY_TAKEN_OUTCOMES.has(outcome);
  // A dose that has already happened is a fact: the rules that decide whether a dose may be given
  // flag it for the nurse in charge instead of refusing it (H-1062, H-1067).
  const fact = alreadyTaken || afterTheEvent;
  const refuseOrReview = (problem: AdministrationProblem, message: string, flag: ReviewFlag) => {
    if (fact) {
      flags.push(flag);
      review.push(flag);
    } else add(problem, message);
  };
  // Recorded after it was given: a reason that says what happened, a time given strictly before
  // the server's time of recording, a recorder with current competence (rule 22, H-1061), and
  // every use flagged and escalated (#162 third clinical review; H-1067).
  if (route !== null) {
    if (route.reason.trim().length < GIVEN_BEFORE_RECORDED_REASON_MIN_LENGTH) {
      add(
        "given_before_recorded_reason_required",
        `Say why the dose is recorded only after it was given, in ${GIVEN_BEFORE_RECORDED_REASON_MIN_LENGTH} characters or more.`,
      );
    }
    if (input.at.getTime() >= input.recordedAt.getTime()) {
      add(
        "given_after_recorded",
        "A record made after the event must be of something that happened before now. Record a dose about to be given on the round instead.",
      );
    }
    const by = route.recordedBy;
    const recorder = checkCompetenceGate(
      by.id,
      by.competence,
      by.override,
      input.recordedAt,
      rates,
    );
    if (!recorder.ok) add(recorder.problem, recorder.message);
    else if (recorder.overridden) flags.push("competence_override");
    flags.push("given_before_recorded");
    review.push("given_before_recorded");
    if (by.id !== input.administrator.id) {
      flags.push("given_by_someone_else");
      review.push("given_by_someone_else");
    }
  }

  if (dose !== null) {
    const window = doseWindow(dose.dueAt, isTimeCritical(entry), rates);
    const timing = recordedTiming(window, input.at);
    // Never before its own window: a later dose (this evening's, tomorrow's) is not recorded at the
    // morning round, and no outcome is filled in ahead of time (HZ-004 review).
    if (timing === "before_window") {
      refuseOrReview(
        "dose_not_due_yet",
        `This dose is not due yet. Its window opens at ${formatUkTime(window.opensAt)} on ${formatUkDate(window.opensAt)}: record it then.`,
        "before_window",
      );
    }
    // Inside its window a dose is on time. Before its due time it asks a reason only for a
    // time-critical entry; any dose, early, on time or late, asks one when it comes closer to the
    // entry's last dose than the schedule less the window allows (#162 third clinical review and
    // its re-check, against alert fatigue).
    const taken = DOSE_TAKEN_OUTCOMES.has(outcome);
    const late = taken && lateAt.getTime() > window.lateAfter.getTime();
    const early = taken && earlyNeedsReason(window, input.at);
    const close = taken
      ? closeDoses(entry, input.versionIds, input.history, input.at, dose.dueAt, rates)
      : { last: null, next: null };
    const takenBeforeWindow = taken && fact && timing === "before_window";
    if (late || early || close.last || close.next || takenBeforeWindow) {
      if (blank(input.timingReason)) {
        const what = [
          ...(late ? ["late"] : []),
          ...(early ? ["early"] : []),
          ...(close.last
            ? [`closer to the last dose, given at ${formatUkTime(close.last.at)}`]
            : []),
          ...(close.next
            ? [`closer to the next dose, given at ${formatUkTime(close.next.at)}`]
            : []),
        ];
        const gap = close.last || close.next ? ", than the schedule allows" : "";
        add(
          "timing_reason_required",
          takenBeforeWindow
            ? "This dose was taken before its window opened. Say what happened."
            : `This ${early ? "time-critical " : ""}dose is ${listWords(what)}${gap}. Say why.`,
        );
      } else {
        if (late) flags.push("late");
        if (early) flags.push("early");
        if (close.last) flags.push("close_to_last_dose");
        if (close.next) flags.push("close_to_next_dose");
      }
    }

    // A dose is not given while an earlier dose of the medicine, in the 24 hours before it, has no
    // outcome: what happened to that one is recorded first (HZ-004 review).
    if (DOSE_TAKEN_OUTCOMES.has(outcome)) {
      const recorded = new Set(input.recordedDueTimes.map((d) => d.getTime()));
      const earlier = marEntryDoses(entry, {
        from: new Date(dose.dueAt.getTime() - DAY_MS + 1),
        to: dose.dueAt,
      }).filter(
        (d) => d.dueAt.getTime() < dose.dueAt.getTime() && !recorded.has(d.dueAt.getTime()),
      );
      if (earlier.length > 0) {
        refuseOrReview(
          "earlier_dose_outstanding",
          earlierDosesMessage(earlier),
          "earlier_dose_outstanding",
        );
      }
    }
  }

  let prescribed: Dose | null = null;
  if (DOSE_TAKEN_OUTCOMES.has(outcome)) {
    const status = marEntryStatus(entry, input.at, input.policy);
    if (!status.mayGive) {
      refuseOrReview(
        "entry_not_usable",
        status.notice ?? `${status.words}: do not give from this entry.`,
        "entry_not_usable",
      );
    }
    if (entry.secondCheck === null) flags.push("entry_not_yet_checked");

    const prescribedDose =
      entry.directions.kind === "when_required" ? entry.directions.dose : (dose?.dose ?? null);
    let variableQuantity: number | null = null;
    if (prescribedDose?.kind === "variable") {
      // The newest dosing record covering the day decides; never an older one (HZ-005 review).
      const variable = dose
        ? variableDoseFor(input.dosingRecords, input.versionIds, dose.date, dose.time)
        : null;
      if (variable?.ok) variableQuantity = variable.quantity;
      else {
        const problem = variable?.problem ?? "no_dosing_record";
        refuseOrReview(
          VARIABLE_DOSE_PROBLEMS[problem],
          VARIABLE_DOSE_MESSAGES[problem],
          "no_usable_dosing_record",
        );
      }
    }
    prescribed =
      prescribedDose?.kind === "variable"
        ? variableQuantity === null
          ? null
          : { kind: "amount", quantity: variableQuantity, unit: prescribedDose.unit }
        : prescribedDose;

    // A dose already taken from an entry with a 24-hour maximum needs its amount, so it counts;
    // so does one with no checked dose to compare it with, so the nurse in charge sees it.
    const maximum =
      entry.directions.kind === "when_required" ? entry.directions.maxQuantityPer24Hours : null;
    const amount = input.amount;
    if (amount === null && outcome === "given") add("amount_required", "Record the amount given.");
    if (amount === null && alreadyTaken && prescribed === null && maximum === null) {
      add(
        "amount_required",
        "Record the amount taken: there is no checked dose to compare it with, so the nurse in charge reviews it.",
      );
    }
    if (amount === null && alreadyTaken && maximum !== null) {
      add(
        "amount_required",
        "Record the amount taken: it counts towards the most allowed in 24 hours.",
      );
    }
    let counted: number | null = null;
    if (amount !== null && prescribedDose !== null) {
      if (!(Number.isFinite(amount.quantity) && amount.quantity > 0)) {
        add("amount_not_a_dose", "Record the amount given as a number more than zero.");
      } else if (amount.unitCode !== prescribedDose.unit.code) {
        // Staff record what they give in the unit on the MAR. What the person or their family gave
        // is recorded as they gave it, never converted, and so not counted (H-1062).
        if (alreadyTaken) {
          flags.push("amount_in_other_unit");
          review.push("amount_in_other_unit");
        } else add("amount_wrong_unit", "Record the amount in the unit on the MAR.");
      } else {
        counted = amount.quantity;
        if (
          !amountMatches(prescribedDose, amount.quantity, variableQuantity) &&
          prescribed !== null
        ) {
          if (blank(input.amountDifferenceReason)) {
            add(
              "amount_differs_needs_reason",
              alreadyTaken
                ? "The amount taken is not the prescribed dose. Say what happened; the nurse in charge reviews it."
                : "The amount is not the prescribed dose. Say what happened; it is reviewed as a possible medication error.",
            );
          } else flags.push("amount_differs");
        }
      }
    }

    const conflicts = intervalConflicts(entry, input.versionIds, input.history, input.at, rates);
    if (conflicts.length > 0) {
      if (blank(input.intervalOverrideReason)) {
        const first = conflicts[0] as (typeof conflicts)[number];
        const rule =
          first.rule === "paracetamol" ? "the paracetamol rule" : "the prescribed minimum interval";
        add(
          "interval_override_required",
          fact
            ? `This dose was taken within ${rule} of another. Say what happened.`
            : `A dose was taken within ${rule}. Do not give it unless the prescriber agrees; if you must, say why.`,
        );
      } else flags.push("interval_override");
      if (fact) review.push("inside_minimum_interval");
    }

    // The maximum counts every dose taken, over every 24 hours containing this one. Staff never
    // give over it; a dose that has already happened over it is recorded, flagged and escalated
    // urgently (H-1062).
    if (counted !== null && prescribedDose !== null) {
      const over = prnMaximumExceeded(entry, input.versionIds, input.history, counted, input.at);
      if (over && fact) {
        flags.push("over_maximum");
        const unit = prescribedDose.unit;
        const taken = formatDose({ kind: "amount", quantity: over.given + counted, unit });
        const max = formatDose({ kind: "amount", quantity: over.max, unit });
        escalations.push({
          severity: "urgent",
          reason: "over_maximum",
          message: `More than the most allowed in 24 hours has been taken: ${taken} against a maximum of ${max}. Tell the nurse in charge now, who follows your organisation's policy and contacts the prescriber.`,
        });
      } else if (over) {
        add(
          "prn_maximum_reached",
          "This would go over the most allowed in 24 hours. Do not give it: contact the prescriber.",
        );
      }
      if (prnDosesNotCounted(entry, input.versionIds, input.history, input.at).length > 0) {
        flags.push("other_unit_not_counted");
      }
    }

    // A dose that has happened with no checked dose to compare it with (a variable dose with no
    // usable dosing record) is never just a review: the amount recorded goes to the nurse in charge
    // urgently (#162 third clinical review).
    if (fact && prescribed === null && amount !== null && prescribedDose !== null) {
      const recorded =
        amount.unitCode === prescribedDose.unit.code
          ? formatDose({ kind: "amount", quantity: amount.quantity, unit: prescribedDose.unit })
          : "an amount in another unit";
      escalations.push({
        severity: "urgent",
        reason: "no_prescribed_dose",
        message: `A dose was given with no checked dose to compare it with: ${recorded} recorded. Tell the nurse in charge now, who follows your organisation's policy and contacts the prescriber.`,
      });
    }
  }

  // Whoever records an outcome now needs current competence (or an override of an expired one).
  // In a record made after the event, the member named is the one who gave the dose then: their
  // competence is a fact to review, never a reason to leave the dose off the record.
  const gate = checkCompetenceGate(
    input.administrator.id,
    input.administrator.competence,
    input.competenceOverride,
    input.at,
    rates,
  );
  if (!gate.ok && afterTheEvent) {
    flags.push("competence_not_current");
    review.push("competence_not_current");
  } else if (!gate.ok) add(gate.problem, gate.message);
  else if (gate.overridden && !flags.includes("competence_override")) {
    flags.push("competence_override");
  }

  // No record of a time later than now, beyond the drift the table tolerates: a dose recorded at
  // a future time could otherwise step past an interval or the maximum (#162 third review's
  // re-check). A dose recorded after it was given has its own, stricter rule.
  const clockTolerance = rates.clockDriftMinutes * MINUTE_MS;
  if (route === null && input.at.getTime() > input.recordedAt.getTime() + clockTolerance) {
    add(
      "recorded_in_future",
      "The time given is later than now. Check the device's clock, and record the time it happened.",
    );
  }
  // On the round any outcome is recorded at the time it happened, up to the table's record delay
  // (`medicines.record_delay_tolerance_minutes`: carers record after a round). One dated further
  // back goes by the route for a record made after the event, with why, flagged and escalated
  // (#162 third review's re-checks). `checkAdministration` also judges an ordinary record at the
  // time of recording, so neither allowance can clear a limit.
  if (
    !afterTheEvent &&
    input.at.getTime() < input.recordedAt.getTime() - rates.recordDelayToleranceMinutes * MINUTE_MS
  ) {
    add(
      "recorded_after_delay",
      `This is recorded as happening at ${formatUkTime(input.at)}, more than ${rates.recordDelayToleranceMinutes} minutes ago. Record it as made after the event, and say why.`,
    );
  }

  // A correction is a reviewable event: flagged with what it changes, counted, and, when it removes,
  // lowers or moves a dose, escalated (urgently when the entry has a maximum or an interval, since
  // that frees room for another dose); the limits around the dose are checked before and after it,
  // and any breach it creates or hides is flagged (#162 third review's re-check).
  if (original !== null) {
    flags.push("corrected");
    const unit = entry.directions.kind === "when_required" ? entry.directions.dose.unit.code : null;
    const ownUnit = (amount: { readonly unitCode: string } | null) =>
      unit === null || amount === null || amount.unitCode === unit;
    const wasTaken = DOSE_TAKEN_OUTCOMES.has(original.outcome);
    const nowTaken = DOSE_TAKEN_OUTCOMES.has(outcome);
    const before = wasTaken && ownUnit(original.amount) ? (original.amount?.quantity ?? 0) : 0;
    const after = nowTaken && ownUnit(input.amount) ? (input.amount?.quantity ?? 0) : 0;
    const removed = wasTaken && (!nowTaken || after < before);
    const moved = wasTaken && nowTaken && original.at.getTime() !== input.at.getTime();
    const limited =
      (entry.directions.kind === "when_required" &&
        entry.directions.maxQuantityPer24Hours !== null) ||
      entry.minimumIntervalMinutes !== null ||
      entry.tags.includes("paracetamol");
    const room = limited
      ? " That frees room under its 24-hour maximum or minimum interval for another dose."
      : "";
    if (removed) {
      flags.push("dose_removed");
      escalations.push({
        severity: limited ? "urgent" : "warning",
        reason: "dose_removed",
        message: `A dose recorded as taken has been corrected to ${nowTaken ? "a smaller amount" : `"${OUTCOME_WORDS[outcome]}"`}.${room} Tell the nurse in charge, who reviews it under your organisation's policy.`,
      });
    }
    if (moved) {
      flags.push("dose_moved");
      escalations.push({
        severity: limited ? "urgent" : "warning",
        reason: "dose_moved",
        message: `The time of a dose recorded as taken has been corrected from ${formatUkTime(original.at)} to ${formatUkTime(input.at)} on ${formatUkDate(input.at)}.${room} Tell the nurse in charge, who reviews it under your organisation's policy.`,
      });
    }
    const limitsBefore = wasTaken
      ? limitsBroken(
          entry,
          input.versionIds,
          input.history,
          {
            at: original.at,
            counted: countedAmount(original.outcome, original.amount, unit),
            dueAt: original.dueAt,
          },
          rates,
        )
      : new Set<DoseLimit>();
    const limitsAfter = nowTaken
      ? limitsBroken(
          entry,
          input.versionIds,
          input.history,
          {
            at: input.at,
            counted: countedAmount(outcome, input.amount, unit),
            dueAt: dose?.dueAt ?? null,
          },
          rates,
        )
      : new Set<DoseLimit>();
    const created = [...limitsAfter].filter((l) => !limitsBefore.has(l));
    const hidden = [...limitsBefore].filter((l) => !limitsAfter.has(l));
    if (created.length > 0) {
      flags.push("breach_created");
      review.push("breach_created");
      breaches.created = created;
    }
    if (hidden.length > 0) {
      flags.push("breach_hidden");
      review.push("breach_hidden");
      breaches.hidden = hidden;
    }
  }

  if (differsWhenRecorded.length > 0) {
    flags.push("differs_when_recorded");
    review.push("differs_when_recorded");
  }

  if (review.length > 0) {
    const words = review.map((f) =>
      f === "breach_created"
        ? `the correction brings it over ${listWords(breaches.created.map((l) => LIMIT_WORDS[l]))}, which the original record kept within`
        : f === "breach_hidden"
          ? `the correction takes away a breach of ${listWords(breaches.hidden.map((l) => LIMIT_WORDS[l]))} that the original record showed`
          : f === "differs_when_recorded"
            ? `at ${formatUkTime(input.recordedAt)}, when it was recorded, the rules give a different answer (${listWords(differsWhenRecorded)})`
            : REVIEW_FLAG_WORDS[f],
    );
    // A dose that has happened and broke a rule (any review flag beyond how it was recorded, or an
    // urgent escalation already) is urgent, never only a warning (#162 third clinical review).
    const brokeRule =
      review.some((f) => !ROUTE_FLAGS.has(f)) || escalations.some((e) => e.severity === "urgent");
    escalations.push({
      severity: brokeRule ? "urgent" : "warning",
      reason: "review",
      message: `Recorded for the nurse in charge to review under your organisation's policy: ${listWords(words)}.`,
    });
  }

  if (issues.length > 0) return { ok: false, issues };
  return { ok: true, flags, prescribed, escalations };
}

/** A dose on a round, for closing it. */
export interface RoundDose {
  readonly entryId: string;
  readonly dueAt: Date;
  readonly timeCritical: boolean;
  readonly recorded: boolean;
}

export type RoundClose =
  | { readonly ok: true; readonly outstanding: readonly RoundDose[] }
  | { readonly ok: false; readonly outstanding: readonly RoundDose[]; readonly message: string };

/**
 * Closing a round (HZ-003): refused while doses have no outcome unless a reason is given; the
 * outstanding doses, time-critical first, go to the handover and stay outstanding.
 */
export function checkRoundClose(doses: readonly RoundDose[], reason: string | null): RoundClose {
  const outstanding = doses
    .filter((d) => !d.recorded)
    .sort(
      (a, b) =>
        Number(b.timeCritical) - Number(a.timeCritical) || a.dueAt.getTime() - b.dueAt.getTime(),
    );
  if (outstanding.length > 0 && blank(reason)) {
    return {
      ok: false,
      outstanding,
      message: `${outstanding.length} ${outstanding.length === 1 ? "dose has" : "doses have"} no outcome. Record them, or say why the round closes without them.`,
    };
  }
  return { ok: true, outstanding };
}

/** An administration as stored (append-only; slice 22). */
export interface RecordedAdministration {
  readonly id: string;
  readonly personId: string;
  readonly entryId: string;
  readonly dueAt: Date | null;
  /** When the dose was given or the outcome happened. */
  readonly at: Date;
  /** What the record says happened, and the amount (in the entry's unit, or as recorded). */
  readonly outcome: AdministrationOutcome;
  readonly amount: { readonly quantity: number; readonly unitCode: string } | null;
  /** The member who gave the dose or recorded the outcome then. */
  readonly administeredBy: string;
  readonly recordedBy: string;
  /** Set when the server received it: the MAR row is then locked. */
  readonly serverReceivedAt: Date | null;
  readonly supersededById: string | null;
}

/** A MAR row locks once synced (10.3); after that only a referenced correction changes it. */
export function marRowLocked(record: RecordedAdministration): boolean {
  return record.serverReceivedAt !== null;
}

/**
 * Whether a record may still be amended on the device that holds it: only by its author, and only
 * until it syncs.
 */
export function checkAmendment(
  record: RecordedAdministration,
  by: string,
): "row_locked" | "not_author" | null {
  if (marRowLocked(record)) return "row_locked";
  return by === record.recordedBy ? null : "not_author";
}

export type CorrectionProblem =
  | "already_corrected"
  | "correction_reason_required"
  | "correction_moves_dose";

export interface AdministrationCorrectionIssue {
  readonly problem: CorrectionProblem | AdministrationProblem;
  readonly message: string;
}

export type AdministrationCorrectionCheck =
  | (Extract<AdministrationCheck, { readonly ok: true }> & {
      /** What the correction changes; the record is flagged `corrected` and counted. */
      readonly corrected: readonly CorrectionKind[];
    })
  | { readonly ok: false; readonly issues: readonly AdministrationCorrectionIssue[] };

/**
 * A correction is a new record that refers to the one it corrects (`supersedes_id`), with a reason;
 * it corrects the latest record for the dose, and it stays about the same person and dose (for a
 * when-required dose, the same entry and MAR day), so it can never move a record onto another dose.
 * What the corrected record says meets every rule a new record does (`checkAdministration`) as a
 * record made after the event: what would refuse a dose about to be given flags it for review, and
 * over the maximum escalates it urgently, because refusing would leave a false record and a dose
 * given out of the history (#162 second clinical review; H-1067). A correction whose new outcome
 * records that a dose happened (given, taken by the person, given by family) is a record of a dose
 * after it was given, so it follows exactly the rules for one (#162 third review's re-check): a
 * reason of `GIVEN_BEFORE_RECORDED_REASON_MIN_LENGTH` characters or more, a time given strictly
 * before the correction's `recordedAt`, a corrector with current competence then, the named giver
 * checked at the time given, and always the `given_before_recorded` flag, counted and escalated
 * (urgently when a rule was broken). So recording "refused" and correcting it to "given" can never
 * get round that route. Any other correction needs a reason and a corrector with current
 * competence. Only the duplicate check against the record it corrects is left out, and that record
 * (by its id) is left out of the history, so it neither counts twice nor stands in the way of its
 * own correction.
 */
export function checkCorrection(
  original: RecordedAdministration,
  correction: {
    /** Why the record is corrected. */
    readonly reason: string;
    /**
     * What the corrected record says: who gave the dose or recorded the outcome, and when (`at`);
     * its `recordedAt` is when the correction is recorded, on the server's clock.
     */
    readonly record: AdministrationInput;
    /** Who records the correction (the author, or a holder of `medicines.record.manage`). */
    readonly correctedBy: RecordedAfterGiving["recordedBy"];
  },
  rates: AdministrationRates,
): AdministrationCorrectionCheck {
  const issues: AdministrationCorrectionIssue[] = [];
  if (original.supersededById !== null) {
    issues.push({
      problem: "already_corrected",
      message: "This record has been corrected already. Correct the latest record for the dose.",
    });
  }
  const record = correction.record;
  const sameDose =
    original.dueAt === null && record.dueAt === null
      ? ukDateOf(original.at) === ukDateOf(record.at)
      : original.dueAt?.getTime() === record.dueAt?.getTime();
  if (
    record.personId !== original.personId ||
    (record.entry !== null && record.entry.id !== original.entryId) ||
    !sameDose
  ) {
    issues.push({
      problem: "correction_moves_dose",
      message:
        "A correction stays with the person and the dose it corrects. Record another dose as a record of its own.",
    });
  }
  const by = correction.correctedBy;
  const dose = record.outcome !== null && DOSE_TAKEN_OUTCOMES.has(record.outcome);
  // Every correction needs a reason that says what happened (#162 third review's re-check); one
  // to a dose outcome is checked as a dose recorded after it was given, which checks its reason
  // and its recorder's competence; any other correction is checked here.
  let overridden = false;
  if (!dose) {
    if (correction.reason.trim().length < GIVEN_BEFORE_RECORDED_REASON_MIN_LENGTH) {
      issues.push({
        problem: "correction_reason_required",
        message: `Say why it is corrected, in ${GIVEN_BEFORE_RECORDED_REASON_MIN_LENGTH} characters or more.`,
      });
    }
    const gate = checkCompetenceGate(by.id, by.competence, by.override, record.recordedAt, rates);
    if (!gate.ok) issues.push({ problem: gate.problem, message: gate.message });
    else overridden = gate.overridden;
  }
  const content = checkRecord(
    {
      ...record,
      alreadyRecorded: false,
      history: record.history.filter((d) => d.id !== original.id),
    },
    rates,
    true,
    dose ? { reason: correction.reason, recordedBy: by } : null,
    original,
    record.at,
    [],
  );
  if (!content.ok) issues.push(...content.issues);
  if (issues.length > 0 || !content.ok) return { ok: false, issues };
  const sameAmount =
    (original.amount === null && record.amount === null) ||
    (original.amount !== null &&
      record.amount !== null &&
      original.amount.quantity === record.amount.quantity &&
      original.amount.unitCode === record.amount.unitCode);
  const kinds: CorrectionKind[] = [
    ...(original.outcome !== record.outcome ? (["outcome"] as const) : []),
    ...(!sameAmount ? (["amount"] as const) : []),
    ...(original.at.getTime() !== record.at.getTime() ? (["time"] as const) : []),
    ...(original.administeredBy !== record.administrator.id ? (["giver"] as const) : []),
  ];
  const flags = overridden ? [...content.flags, "competence_override" as const] : content.flags;
  return { ...content, flags, corrected: kinds.length > 0 ? kinds : ["detail"] };
}
