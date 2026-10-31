/**
 * Dosing records for variable doses (medicines.md rule 18; HZ-005, HZ-116). A variable-dose entry
 * (for example warfarin, whose dose changes with each blood test) holds only the unit; each day's
 * dose comes from a dosing record transcribed from its source (the anticoagulant clinic's letter
 * or record). A dosing record is checked like a MAR entry: by a second person, not the one who
 * wrote it, with current medicines competence, who compared it with the source. A dose is given
 * only from the latest checked record that covers that day and time.
 */

import { isDoseQuantity } from "./dose";
import type { MarEntry, MarSourceDocument, SecondCheck, SecondCheckInput } from "./mar-entry";
import { MAR_SOURCE_KINDS } from "./mar-entry";

export interface DosingRecordDraft {
  readonly personId: string;
  readonly entryId: string;
  readonly source: MarSourceDocument;
  /** The dose for each prescribed time on each day, in the entry's unit. */
  readonly doses: readonly {
    readonly date: string;
    readonly time: string;
    readonly quantity: number;
  }[];
}

export interface DosingRecord extends DosingRecordDraft {
  readonly id: string;
  readonly recordedBy: string;
  readonly recordedAt: Date;
  readonly secondCheck: SecondCheck | null;
}

export type DosingRecordProblem =
  | "not_variable"
  | "wrong_person"
  | "source_required"
  | "no_doses"
  | "bad_date"
  | "time_not_prescribed"
  | "dose_given_twice"
  | "bad_quantity"
  | "not_awaiting_check"
  | "checker_is_recorder"
  | "checker_not_competent"
  | "source_not_compared"
  | "difference_required";

export interface DosingRecordIssue {
  readonly problem: DosingRecordProblem;
  readonly message: string;
}

/** The times of an entry whose dose is variable. */
function variableTimes(entry: MarEntry): ReadonlySet<string> {
  if (entry.directions.kind !== "regular") return new Set();
  return new Set(
    entry.directions.schedule.times.filter((t) => t.dose.kind === "variable").map((t) => t.time),
  );
}

function isCalendarDate(value: string): boolean {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!match) return false;
  const d = new Date(Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3])));
  return d.toISOString().slice(0, 10) === value;
}

/** Checks a dosing record against its entry; returns every problem, or none. */
export function checkDosingRecordDraft(
  entry: MarEntry,
  draft: DosingRecordDraft,
): readonly DosingRecordIssue[] {
  const issues: DosingRecordIssue[] = [];
  const add = (problem: DosingRecordProblem, message: string) => issues.push({ problem, message });
  const times = variableTimes(entry);
  if (times.size === 0) add("not_variable", "This medicine's dose is not variable.");
  if (draft.personId !== entry.personId || draft.entryId !== entry.id) {
    add("wrong_person", "This dosing record is for a different person or medicine.");
  }
  if (!MAR_SOURCE_KINDS.includes(draft.source.kind) || draft.source.reference.trim() === "") {
    add(
      "source_required",
      "Say which document the doses come from, so the second person can check it.",
    );
  }
  if (draft.doses.length === 0) add("no_doses", "Give at least one day's dose.");
  const seen = new Set<string>();
  for (const dose of draft.doses) {
    if (!isCalendarDate(dose.date)) add("bad_date", `"${dose.date}" is not a date.`);
    if (!times.has(dose.time))
      add("time_not_prescribed", `${dose.time} is not a variable-dose time on this medicine.`);
    const key = `${dose.date} ${dose.time}`;
    if (seen.has(key)) add("dose_given_twice", `${key} is given twice.`);
    seen.add(key);
    if (!isDoseQuantity(dose.quantity))
      add("bad_quantity", `The dose for ${key} is not a dose quantity.`);
  }
  return issues;
}

export type DosingRecordResult =
  | { readonly ok: true; readonly record: DosingRecord }
  | { readonly ok: false; readonly issues: readonly DosingRecordIssue[] };

/** A new dosing record, not yet checked. */
export function recordDosingRecord(
  entry: MarEntry,
  draft: DosingRecordDraft,
  meta: { readonly id: string; readonly by: string; readonly at: Date },
): DosingRecordResult {
  const issues = checkDosingRecordDraft(entry, draft);
  if (issues.length > 0) return { ok: false, issues };
  return {
    ok: true,
    record: { ...draft, id: meta.id, recordedBy: meta.by, recordedAt: meta.at, secondCheck: null },
  };
}

/** The second check of a dosing record, by the same rules as a MAR entry's (HZ-116). */
export function checkDosingRecord(
  record: DosingRecord,
  check: SecondCheckInput,
): DosingRecordResult {
  const fail = (problem: DosingRecordProblem, message: string): DosingRecordResult => ({
    ok: false,
    issues: [{ problem, message }],
  });
  if (record.secondCheck !== null)
    return fail("not_awaiting_check", "This dosing record has been checked.");
  if (check.by === record.recordedBy) {
    return fail(
      "checker_is_recorder",
      "A second person must check the doses. The person who wrote them cannot.",
    );
  }
  if (check.competence !== "current") {
    return fail(
      "checker_not_competent",
      "Only someone whose medicines competence is current can check doses.",
    );
  }
  if (!check.comparedWithSource) {
    return fail(
      "source_not_compared",
      `Compare the doses with ${record.source.reference} before confirming.`,
    );
  }
  if (check.outcome === "differs_from_source" && (check.difference ?? "").trim() === "") {
    return fail("difference_required", "Say what differs from the source document.");
  }
  return {
    ok: true,
    record: {
      ...record,
      secondCheck: {
        by: check.by,
        at: check.at,
        outcome: check.outcome,
        difference: check.outcome === "differs_from_source" ? check.difference : null,
      },
    },
  };
}

/**
 * The dose to give at a variable-dose time: from the most recently recorded dosing record that a
 * second person checked and found to match its source, and that covers the day and time. Null when
 * there is none, and then no dose may be given (`no_checked_dosing_record`).
 */
export function variableDoseFor(
  records: readonly DosingRecord[],
  entryIds: ReadonlySet<string>,
  date: string,
  time: string,
): number | null {
  const usable = records
    .filter((r) => entryIds.has(r.entryId) && r.secondCheck?.outcome === "matches_source")
    .sort((a, b) => b.recordedAt.getTime() - a.recordedAt.getTime());
  for (const record of usable) {
    const dose = record.doses.find((d) => d.date === date && d.time === time);
    if (dose) return dose.quantity;
  }
  return null;
}
