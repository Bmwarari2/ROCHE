/**
 * Recording a dose (medicines.md rules 13 to 23; master prompt 10.2 and 10.3; HZ-001, HZ-003,
 * HZ-004, HZ-005, HZ-119). `checkAdministration` is the one rule the API runs for every record,
 * from the web or a device: it refuses a record without a selected person, a dose and an outcome;
 * refuses one for someone else's medicine, a dose already recorded, a version not in force, a
 * when-required dose over its 24-hour maximum, or a member whose medicines competence has lapsed
 * without an override; and asks for a reason for an early or late dose, a different amount, or a
 * dose inside a minimum interval. Harbour never calculates a dose or says whether one is right: it
 * compares what was given with what the entry, or its checked dosing record, says.
 */

import { type CompetenceOverride, type CompetenceProblem, checkCompetenceGate } from "./competence";
import type { Dose } from "./dose";
import { type DosingRecord, variableDoseFor } from "./dosing-record";
import { type GivenDose, intervalConflicts, prnMaximumExceeded } from "./intervals";
import {
  type MarEntry,
  type MedicinesCompetence,
  marEntryDoses,
  marEntryStatus,
  type UncheckedEntryPolicy,
} from "./mar-entry";
import type { MedicinesRates } from "./rates";
import type { MarDose } from "./schedule";
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

export interface AdministrationInput {
  /** The person selected on the screen. */
  readonly personId: string | null;
  /** The medicine selected. */
  readonly entry: MarEntry | null;
  /** The scheduled dose; null for a when-required dose. */
  readonly dueAt: Date | null;
  readonly outcome: AdministrationOutcome | null;
  readonly reason: { readonly code: string; readonly note: string | null } | null;
  /** The amount given, in the entry's unit; required for "given". */
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
  | "already_recorded"
  | "reason_required"
  | "reason_not_for_outcome"
  | "note_required"
  | "entry_not_usable"
  | "amount_required"
  | "amount_wrong_unit"
  | "amount_not_a_dose"
  | "amount_differs_needs_reason"
  | "no_checked_dosing_record"
  | "timing_reason_required"
  | "interval_override_required"
  | "prn_maximum_reached";

export type AdministrationFlag =
  | "early"
  | "late"
  | "interval_override"
  | "competence_override"
  | "amount_differs"
  | "entry_not_yet_checked";

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

/** Checks one administration record; returns every problem, or the flags the record carries. */
export function checkAdministration(
  input: AdministrationInput,
  rates: AdministrationRates,
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
  let prescribed: Dose | null = null;
  if (DOSE_TAKEN_OUTCOMES.has(outcome)) {
    const status = marEntryStatus(entry, input.at, input.policy);
    if (!status.mayGive)
      add("entry_not_usable", status.notice ?? `${status.words}: do not give from this entry.`);
    if (entry.secondCheck === null) flags.push("entry_not_yet_checked");

    const prescribedDose =
      entry.directions.kind === "when_required" ? entry.directions.dose : (dose?.dose ?? null);
    const variableQuantity =
      prescribedDose?.kind === "variable" && dose
        ? variableDoseFor(input.dosingRecords, input.versionIds, dose.date, dose.time)
        : null;
    if (prescribedDose?.kind === "variable" && variableQuantity === null) {
      add(
        "no_checked_dosing_record",
        "No checked dosing record gives this day's dose. Do not give it until the dosing record is recorded and checked.",
      );
    }
    prescribed =
      prescribedDose?.kind === "variable"
        ? variableQuantity === null
          ? null
          : { kind: "amount", quantity: variableQuantity, unit: prescribedDose.unit }
        : prescribedDose;

    const amount = input.amount;
    if (outcome === "given" && amount === null) add("amount_required", "Record the amount given.");
    if (amount !== null && prescribedDose !== null) {
      if (amount.unitCode !== prescribedDose.unit.code) {
        add("amount_wrong_unit", "Record the amount in the unit on the MAR.");
      } else if (!(Number.isFinite(amount.quantity) && amount.quantity > 0)) {
        add("amount_not_a_dose", "Record the amount given as a number more than zero.");
      } else if (
        !amountMatches(prescribedDose, amount.quantity, variableQuantity) &&
        prescribed !== null
      ) {
        if (blank(input.amountDifferenceReason)) {
          add(
            "amount_differs_needs_reason",
            "The amount is not the prescribed dose. Say what happened; it is reviewed as a possible medication error.",
          );
        } else flags.push("amount_differs");
      }
    }

    if (dose !== null) {
      const timing = recordedTiming(doseWindow(dose.dueAt, isTimeCritical(entry), rates), input.at);
      if (timing !== "on_time") {
        if (blank(input.timingReason)) {
          add("timing_reason_required", `This dose is ${timing}. Say why.`);
        } else flags.push(timing);
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
          `A dose was taken within ${rule}. Do not give it unless the prescriber agrees; if you must, say why.`,
        );
      } else flags.push("interval_override");
    }

    const quantity = amount?.quantity ?? 0;
    if (prnMaximumExceeded(entry, input.versionIds, input.history, quantity, input.at)) {
      add(
        "prn_maximum_reached",
        "This would go over the most allowed in 24 hours. Do not give it: contact the prescriber.",
      );
    }
  }

  const gate = checkCompetenceGate(
    input.administrator.id,
    input.administrator.competence,
    input.competenceOverride,
    input.at,
    rates,
  );
  if (!gate.ok) add(gate.problem, gate.message);
  else if (gate.overridden) flags.push("competence_override");

  if (issues.length > 0) return { ok: false, issues };
  return { ok: true, flags, prescribed };
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

export type CorrectionProblem = "already_corrected" | "reason_required" | "correction_moves_dose";

/**
 * A correction is a new record that refers to the one it corrects (`supersedes_id`), with a reason;
 * it corrects the latest record for the dose, and it stays about the same person and dose, so it
 * can never move a record onto another dose.
 */
export function checkCorrection(
  original: RecordedAdministration,
  correction: {
    readonly reason: string;
    readonly personId: string;
    readonly entryId: string;
    readonly dueAt: Date | null;
  },
): readonly CorrectionProblem[] {
  const problems: CorrectionProblem[] = [];
  if (original.supersededById !== null) problems.push("already_corrected");
  if (blank(correction.reason)) problems.push("reason_required");
  const sameDue = (original.dueAt?.getTime() ?? null) === (correction.dueAt?.getTime() ?? null);
  if (
    correction.personId !== original.personId ||
    correction.entryId !== original.entryId ||
    !sameDue
  ) {
    problems.push("correction_moves_dose");
  }
  return problems;
}
