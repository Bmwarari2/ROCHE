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
import { doseWindow, isTimeCritical, recordedTiming } from "./timing";

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
  /** Drift-corrected time the dose was given or the outcome happened. */
  readonly at: Date;
  readonly timingReason: string | null;
  readonly intervalOverrideReason: string | null;
  readonly administrator: { readonly id: string; readonly competence: MedicinesCompetence };
  readonly competenceOverride: CompetenceOverride | null;
  readonly policy: UncheckedEntryPolicy;
  /** The scheduled dose already has an outcome: a change is a correction of that record. */
  readonly alreadyRecorded: boolean;
  /**
   * Set, with why, when staff record a dose they have already given (it was given before it could
   * be recorded): a fact, so the rules that decide whether a dose may be given flag it for the nurse
   * in charge to review instead of refusing it, and it is never left off the record (H-1067). Null
   * on the round, where those rules refuse the dose before it is given.
   */
  readonly givenBeforeRecorded: { readonly reason: string } | null;
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
  | "before_window"
  | "earlier_dose_outstanding"
  | "entry_not_usable"
  | "no_usable_dosing_record"
  | "amount_in_other_unit"
  | "competence_not_current";

/** The words for each review flag, in the review escalation and wherever the record shows it. */
export const REVIEW_FLAG_WORDS: Readonly<Record<ReviewFlag, string>> = {
  before_window: "the dose was taken before its window opened",
  earlier_dose_outstanding: "an earlier dose had no outcome",
  entry_not_usable: "the entry may not be given from at that time",
  no_usable_dosing_record: "no checked dosing record gave the day's dose",
  amount_in_other_unit: "the amount is in another unit, so it is not in the 24-hour total",
  competence_not_current: "the member who gave it had no current medicines competence",
};

/**
 * An escalation the API raises through the notification centre's chain when the record is saved
 * (slice 48, which sets who receives it and its acknowledgement): `urgent` when the person has taken
 * more than the prescriber allows in 24 hours; `warning` for a record flagged for review.
 */
export interface AdministrationEscalation {
  readonly severity: Extract<Severity, "urgent" | "warning">;
  readonly reason: "over_maximum" | "review";
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
 * Checks one administration record; returns every problem, or the flags the record carries and
 * what the API escalates. On the round the rules that decide whether a dose may be given refuse it;
 * a dose the person took themselves, or given by family, or that staff record after giving it
 * (`givenBeforeRecorded`), is a fact, and those rules flag it for review instead.
 */
export function checkAdministration(
  input: AdministrationInput,
  rates: AdministrationRates,
): AdministrationCheck {
  return checkRecord(input, rates, input.outcome === "given" && input.givenBeforeRecorded !== null);
}

/**
 * The rules for a record. `afterTheEvent`: the record is of something that has already happened
 * (a dose given before it was recorded, or any correction), so the rules that decide whether a
 * dose may be given, and the competence of whoever gave it then, flag it for review instead of
 * refusing it: refusing would leave a dose given off the record, and out of the intervals and the
 * maximum for the next one (#162 second clinical review).
 */
function checkRecord(
  input: AdministrationInput,
  rates: AdministrationRates,
  afterTheEvent: boolean,
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
  if (outcome === "given" && input.givenBeforeRecorded !== null) {
    if (blank(input.givenBeforeRecorded.reason)) {
      add(
        "given_before_recorded_reason_required",
        "Say why the dose is recorded only after it was given.",
      );
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
    if (
      DOSE_TAKEN_OUTCOMES.has(outcome) &&
      timing !== "on_time" &&
      (fact || timing !== "before_window")
    ) {
      if (blank(input.timingReason)) {
        add(
          "timing_reason_required",
          timing === "before_window"
            ? "This dose was taken before its window opened. Say what happened."
            : `This dose is ${timing}. Say why.`,
        );
      } else if (timing !== "before_window") flags.push(timing);
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

    // A dose already taken from an entry with a 24-hour maximum needs its amount, so it counts.
    const maximum =
      entry.directions.kind === "when_required" ? entry.directions.maxQuantityPer24Hours : null;
    const amount = input.amount;
    if (amount === null && outcome === "given") add("amount_required", "Record the amount given.");
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
  else if (gate.overridden) flags.push("competence_override");

  if (review.length > 0) {
    const words = review.map((f) => REVIEW_FLAG_WORDS[f]);
    escalations.push({
      severity: "warning",
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
  | Extract<AdministrationCheck, { readonly ok: true }>
  | { readonly ok: false; readonly issues: readonly AdministrationCorrectionIssue[] };

/**
 * A correction is a new record that refers to the one it corrects (`supersedes_id`), with a reason;
 * it corrects the latest record for the dose, and it stays about the same person and dose (for a
 * when-required dose, the same entry and MAR day), so it can never move a record onto another dose.
 * Whoever records the correction needs current medicines competence now (rule 22). What the
 * corrected record says meets every rule a new record does (`checkAdministration`: the entry in
 * force, the window, an earlier dose outstanding, the dosing record, the amount, intervals, the
 * maximum and the competence of the member who gave it), as a record made after the event: what
 * would refuse a dose about to be given flags it for review, and over the maximum escalates it
 * urgently, because refusing would leave a false record and a dose given out of the history (#162
 * second clinical review; H-1067). So "refused" corrected to "given" is checked as a dose given
 * then, and never lost. Only the duplicate check against the record it corrects is left out, and
 * that record (by its id) is left out of the history, so it neither counts twice nor stands in the
 * way of its own correction.
 */
export function checkCorrection(
  original: RecordedAdministration,
  correction: {
    /** Why the record is corrected. */
    readonly reason: string;
    /** What the corrected record says: who gave the dose or recorded the outcome, and when. */
    readonly record: AdministrationInput;
    /** Who records the correction, and when (the author, or a holder of `medicines.record.manage`). */
    readonly correctedBy: {
      readonly id: string;
      readonly competence: MedicinesCompetence;
      readonly override: CompetenceOverride | null;
      readonly at: Date;
    };
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
  if (blank(correction.reason)) {
    issues.push({ problem: "correction_reason_required", message: "Say why it is corrected." });
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
  const gate = checkCompetenceGate(by.id, by.competence, by.override, by.at, rates);
  if (!gate.ok) issues.push({ problem: gate.problem, message: gate.message });
  const content = checkRecord(
    {
      ...record,
      alreadyRecorded: false,
      history: record.history.filter((d) => d.id !== original.id),
    },
    rates,
    true,
  );
  if (!content.ok) issues.push(...content.issues);
  if (issues.length > 0 || !content.ok) return { ok: false, issues };
  return gate.ok && gate.overridden
    ? { ...content, flags: [...content.flags, "competence_override"] }
    : content;
}
