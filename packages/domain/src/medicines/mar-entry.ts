/**
 * MAR entries (medicines.md rules 1 to 6; HZ-005, HZ-121). An entry is one medicine for one person
 * as transcribed from a source document: a dm+d product, a route dm+d gives for it, structured
 * doses, regular times or "when required", the prescriber, the dates, and the source document.
 *
 * States: a new or changed entry is "Not yet checked" until a second person, competent in
 * medicines and not the transcriber, compares it with the source document (NICE SC1, as the
 * master prompt cites it). A check that finds a difference holds the entry until a corrected
 * version replaces it. A change is a new version of the same dm+d product; a stop records why and
 * on what source. Both work on every version of the medicine, so exactly one version is in force
 * at any instant (rule 6b), and one entry per product is in force for a person. Nothing is edited
 * in place, so the history of what the MAR said, and who checked it, is kept.
 *
 * The version rules refuse the sequences that are hard to get right rather than handling them
 * (H-553): a change part-way through a day with doses (except a correction after a check found a
 * difference), a change or stop while a later version is scheduled (unless it withdraws that
 * version, with the reason), a change that drops or extends the course end, and a change into
 * another product.
 *
 * Whether a not-yet-checked entry may be given before its check is the tenant policy the CSO
 * confirms (H-550); the default shows the dose with the notice and lets it be given, because a
 * dose held for want of a second person on a night shift is a missed dose (HZ-003).
 */

import { formatUkDateTime, formatUkTime, ukEndOfDay, ukStartOfDay } from "../shared/time";
import { type DmdProductRef, type DmdRoute, isDmdProduct } from "./dmd";
import { checkDose, type Dose, type DoseUnit } from "./dose";
import {
  checkSchedule,
  expandSchedule,
  keepsCountFrom,
  type MarDose,
  type RegularSchedule,
  type ScheduleProblem,
  ukDateOf,
} from "./schedule";

export const MAR_SOURCE_KINDS = [
  "prescription",
  "pharmacy_label",
  "pharmacy_mar",
  "discharge_letter",
  "transfer_letter",
  "gp_record",
  "clinic_letter",
  "prescriber_instruction",
  "previous_mar",
] as const;

/**
 * Where the entry was transcribed from: a prescription or its pharmacy label or MAR, a letter or
 * record from the prescriber, the discharge or transfer letter, or the MAR from the previous care
 * setting. A verbal instruction is not a source (H-552).
 */
export type MarSourceKind = (typeof MAR_SOURCE_KINDS)[number];

export interface MarSourceDocument {
  readonly kind: MarSourceKind;
  /** What identifies the document to the checker (for example "Discharge letter, Ward 7, 02/11/2026"). */
  readonly reference: string;
  /** The stored document, when it is uploaded. */
  readonly documentId: string | null;
}

/** Regular times with a dose at each, or a when-required (PRN) medicine with its dose. */
export type MarDirections =
  | { readonly kind: "regular"; readonly schedule: RegularSchedule }
  | { readonly kind: "when_required"; readonly dose: Dose };

export interface MarEntryDraft {
  readonly personId: string;
  readonly product: DmdProductRef;
  readonly route: DmdRoute;
  readonly directions: MarDirections;
  /** What the medicine is for; required for a when-required medicine. */
  readonly indication: string | null;
  /** As written on the source, for example "30 minutes before breakfast". */
  readonly specialInstructions: string | null;
  /** The prescriber as named on the source. */
  readonly prescriber: string;
  readonly startsAt: Date;
  readonly stopsAt: Date | null;
  /** When the prescriber asked for the medicine to be reviewed (YYYY-MM-DD). */
  readonly reviewOn: string | null;
  readonly source: MarSourceDocument;
}

/** What dm+d says about the chosen product (slice 10's reference data). */
export interface DmdProductFacts {
  readonly permittedDoseUnits: readonly DoseUnit[];
  readonly permittedRoutes: readonly DmdRoute[];
}

export type MarEntryProblem =
  | ScheduleProblem
  | "product_not_dmd"
  | "route_not_permitted"
  | "indication_required"
  | "prescriber_required"
  | "source_required"
  | "stops_before_starts"
  | "bad_review_date"
  | "not_awaiting_check"
  | "checker_is_transcriber"
  | "checker_not_competent"
  | "source_not_compared"
  | "difference_required"
  | "entry_closed"
  | "different_person"
  | "different_product"
  | "same_product_in_force"
  | "change_in_past"
  | "not_one_medicine"
  | "later_version_scheduled"
  | "change_from_tomorrow"
  | "course_end_kept"
  | "restart_from_tomorrow"
  | "count_reanchored"
  | "entry_ended"
  | "stop_in_past"
  | "reason_required";

export interface MarEntryIssue {
  readonly problem: MarEntryProblem;
  readonly message: string;
  readonly time?: string;
}

function blank(value: string | null | undefined): boolean {
  return value === null || value === undefined || value.trim() === "";
}

function isCalendarDate(value: string): boolean {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!match) return false;
  const d = new Date(Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3])));
  return d.toISOString().slice(0, 10) === value;
}

function checkSource(source: MarSourceDocument): readonly MarEntryIssue[] {
  if (MAR_SOURCE_KINDS.includes(source.kind) && !blank(source.reference)) return [];
  return [
    {
      problem: "source_required",
      message: "Say which document this comes from, so the second person can check it.",
    },
  ];
}

/** Checks a draft entry against dm+d and the record-keeping rules; returns every problem, or none. */
export function checkMarEntryDraft(
  draft: MarEntryDraft,
  facts: DmdProductFacts,
): readonly MarEntryIssue[] {
  const issues: MarEntryIssue[] = [];
  if (!isDmdProduct(draft.product)) {
    issues.push({
      problem: "product_not_dmd",
      message: "Choose the medicine from dm+d. A typed name cannot be used.",
    });
  }
  if (!facts.permittedRoutes.some((r) => r.code === draft.route.code)) {
    issues.push({
      problem: "route_not_permitted",
      message: `dm+d does not give "${draft.route.name}" as a route for this product.`,
    });
  }
  const d = draft.directions;
  if (d.kind === "regular") issues.push(...checkSchedule(d.schedule, facts.permittedDoseUnits));
  else {
    issues.push(...checkDose(d.dose, facts.permittedDoseUnits));
    if (blank(draft.indication)) {
      issues.push({
        problem: "indication_required",
        message: "Say what the when-required medicine is for, as the prescriber wrote it.",
      });
    }
  }
  if (blank(draft.prescriber)) {
    issues.push({
      problem: "prescriber_required",
      message: "Name the prescriber as the source document does.",
    });
  }
  issues.push(...checkSource(draft.source));
  if (draft.stopsAt && draft.stopsAt.getTime() <= draft.startsAt.getTime()) {
    issues.push({ problem: "stops_before_starts", message: "The stop must be after the start." });
  }
  if (draft.reviewOn !== null && !isCalendarDate(draft.reviewOn)) {
    issues.push({ problem: "bad_review_date", message: "The review date is not a real date." });
  }
  return issues;
}

export type MarEntryState =
  | "not_yet_checked"
  | "checked"
  | "difference_found"
  | "stopped"
  | "replaced"
  | "withdrawn";

/** How the entry was made: typed from a source, from a reconciliation, or imported (slice 51). */
export type MarEntryOrigin = "transcribed" | "reconciliation" | "import";

/**
 * The member's medicines competence. The API reads it on the server from workforce's competence
 * port (slice 17; ADR-0085), never from the request (section 3).
 */
export type MedicinesCompetence = "current" | "expired" | "not_held";

export interface SecondCheck {
  readonly by: string;
  readonly at: Date;
  readonly outcome: "matches_source" | "differs_from_source";
  readonly difference: string | null;
}

export interface MarEntryStop {
  readonly by: string;
  readonly at: Date;
  readonly effectiveAt: Date;
  readonly reason: string;
  readonly source: MarSourceDocument;
}

export interface MarEntry extends MarEntryDraft {
  readonly id: string;
  readonly version: number;
  readonly origin: MarEntryOrigin;
  readonly state: MarEntryState;
  readonly transcribedBy: string;
  readonly transcribedAt: Date;
  /** The earlier version this one replaces. */
  readonly replacesId: string | null;
  readonly secondCheck: SecondCheck | null;
  readonly stop: MarEntryStop | null;
  readonly replacedById: string | null;
  /** When the newer version takes over; this entry's doses end there. */
  readonly replacedFrom: Date | null;
  /** Set when this version deliberately moved the day count (rule 6a). */
  readonly reanchor: { readonly by: string; readonly at: Date; readonly reason: string } | null;
  /** Set when a later change or stop withdrew this version before it started: it is never in force. */
  readonly withdrawn: { readonly by: string; readonly at: Date; readonly reason: string } | null;
  /**
   * The UK date (YYYY-MM-DD) when this version corrected one whose check found a difference,
   * taking effect part-way through a day with doses: that day it carries a notice to check the
   * day's doses (rule 6c).
   */
  readonly correctedPartWayThrough: string | null;
}

export type MarEntryResult =
  | { readonly ok: true; readonly entry: MarEntry }
  | { readonly ok: false; readonly issues: readonly MarEntryIssue[] };

export interface TranscriptionMeta {
  readonly id: string;
  readonly by: string;
  readonly at: Date;
  readonly origin: MarEntryOrigin;
}

/** A new entry's details: the person's earlier entries of the product. */
export interface NewEntryMeta extends TranscriptionMeta {
  /**
   * Every version of the person's entries the API holds for the same dm+d product, stopped ones
   * included (the API passes them all; the rule keeps those for this person and VMP). One entry of
   * a product is in force at a time, and a restart keeps the count from the last dose due (rule
   * 6a) and starts on a day with no dose already due under the entry that stopped (rule 6c).
   */
  readonly earlierEntries: readonly MarEntry[];
  readonly reanchorReason?: string | null;
}

function fail(problem: MarEntryProblem, message: string): { ok: false; issues: MarEntryIssue[] } {
  return { ok: false, issues: [{ problem, message }] };
}

const DAY_MS = 86_400_000;
/** How far back `lastDueDose` looks in one step. */
const LOOK_BACK_DAYS = 64;

function newEntry(draft: MarEntryDraft, meta: TranscriptionMeta): MarEntry {
  return {
    ...draft,
    id: meta.id,
    version: 1,
    origin: meta.origin,
    state: "not_yet_checked",
    transcribedBy: meta.by,
    transcribedAt: meta.at,
    replacesId: null,
    secondCheck: null,
    stop: null,
    replacedById: null,
    replacedFrom: null,
    reanchor: null,
    withdrawn: null,
    correctedPartWayThrough: null,
  };
}

const live = (versions: readonly MarEntry[]) => versions.filter((v) => v.withdrawn === null);

/** The regular doses due on the MAR in a window, across versions, earliest first. */
function dosesIn(
  versions: readonly MarEntry[],
  window: { readonly from: Date; readonly to: Date },
): readonly MarDose[] {
  return versions
    .flatMap((v) => marEntryDoses(v, window))
    .sort((a, b) => a.dueAt.getTime() - b.dueAt.getTime());
}

/**
 * The last dose due before an instant across versions of a medicine (withdrawn versions had no
 * doses), looking back from `before` to the earliest version's start.
 */
export function lastDueDose(versions: readonly MarEntry[], before: Date): MarDose | null {
  const regular = live(versions).filter((v) => v.directions.kind === "regular");
  if (regular.length === 0) return null;
  const earliest = Math.min(...regular.map((v) => v.startsAt.getTime()));
  for (let to = before.getTime(); to > earliest; to -= LOOK_BACK_DAYS * DAY_MS) {
    const window = {
      from: new Date(Math.max(earliest, to - LOOK_BACK_DAYS * DAY_MS)),
      to: new Date(to),
    };
    const doses = regular.flatMap((v) => marEntryDoses(v, window));
    if (doses.length > 0) {
      return doses.reduce((a, b) => (b.dueAt.getTime() > a.dueAt.getTime() ? b : a));
    }
  }
  return null;
}

/** Rule 6a: a regular pattern keeps the count from the last dose due, or says why it starts anew. */
function countRule(
  versions: readonly MarEntry[],
  draft: MarEntryDraft,
  meta: { readonly by: string; readonly at: Date; readonly reanchorReason?: string | null },
): { readonly reanchor: MarEntry["reanchor"] } | { readonly issue: MarEntryIssue } {
  if (draft.directions.kind !== "regular") return { reanchor: null };
  const last = lastDueDose(versions, draft.startsAt);
  if (keepsCountFrom(last ? last.date : null, draft.directions.schedule.pattern))
    return { reanchor: null };
  if (blank(meta.reanchorReason)) {
    return {
      issue: {
        problem: "count_reanchored",
        message: `The last dose was due on ${formatUkDateTime(last?.dueAt as Date)}, a day the new pattern does not fall on, so this moves the days the dose is counted from. Keep the count, or say why the prescriber's new pattern starts a new count.`,
      },
    };
  }
  return { reanchor: { by: meta.by, at: meta.at, reason: (meta.reanchorReason as string).trim() } };
}

/**
 * A new entry, "Not yet checked" whatever its origin (an import or a reconciliation too). It is
 * refused while an entry of the same dm+d product (VMP) is in force for the person then or later:
 * that entry is changed instead (H-553). A restart of a product the person had before keeps that
 * medicine's day count (rule 6a), and starts on a day with no dose already due under the entry
 * that stopped, so no dose is given twice (rule 6c).
 */
export function transcribeMarEntry(
  draft: MarEntryDraft,
  facts: DmdProductFacts,
  meta: NewEntryMeta,
): MarEntryResult {
  const issues = checkMarEntryDraft(draft, facts);
  if (issues.length > 0) return { ok: false, issues };
  const earlier = live(meta.earlierEntries).filter(
    (e) => e.personId === draft.personId && e.product.vmpId === draft.product.vmpId,
  );
  const inForce = earlier.find((e) => {
    const end = marEntryEnd(e);
    return end === null || end.getTime() > draft.startsAt.getTime();
  });
  if (inForce) {
    return fail(
      "same_product_in_force",
      `${draft.product.name} is already on the MAR from ${formatUkDateTime(inForce.startsAt)}. Change that entry, or stop it first.`,
    );
  }
  const day = ukDateOf(draft.startsAt);
  const dueEarlier = dosesIn(earlier, { from: ukStartOfDay(day), to: draft.startsAt });
  if (dueEarlier.length > 0) {
    return fail(
      "restart_from_tomorrow",
      `A dose was due at ${formatUkTime(dueEarlier[0]?.dueAt as Date)} that day under the entry that stopped. Start the new entry from 00:00 the next day, so no dose is given twice.`,
    );
  }
  const count = countRule(earlier, draft, meta);
  if ("issue" in count) return { ok: false, issues: [count.issue] };
  return { ok: true, entry: { ...newEntry(draft, meta), reanchor: count.reanchor } };
}

export interface SecondCheckInput {
  readonly by: string;
  readonly at: Date;
  readonly competence: MedicinesCompetence;
  /** The checker confirms they compared the entry with the source document itself. */
  readonly comparedWithSource: boolean;
  readonly outcome: SecondCheck["outcome"];
  /** What differs, required when the outcome is a difference. */
  readonly difference: string | null;
}

/** The states that record a version's end; a check never overwrites them. */
const END_STATES: ReadonlySet<MarEntryState> = new Set(["stopped", "replaced", "withdrawn"]);

/**
 * Records the second check. The checker is a different person from the transcriber, holds
 * current medicines competence and has compared the entry with the source document. An entry with
 * a stop or a replacement still to come is checked as any other while it is in force, so a future
 * change never leaves the current version unchecked (and held, under that policy) until then.
 */
export function recordSecondCheck(entry: MarEntry, check: SecondCheckInput): MarEntryResult {
  if (entry.secondCheck !== null) {
    return fail("not_awaiting_check", "This entry has already been checked.");
  }
  const end = marEntryEnd(entry);
  if (end && check.at.getTime() >= end.getTime()) {
    return fail("entry_ended", "This entry has ended. Check the entry in force instead.");
  }
  if (check.by === entry.transcribedBy) {
    return fail(
      "checker_is_transcriber",
      "A second person must check this entry. The person who wrote it cannot check it.",
    );
  }
  if (check.competence !== "current") {
    return fail(
      "checker_not_competent",
      "Only someone whose medicines competence is current can check an entry.",
    );
  }
  if (!check.comparedWithSource) {
    return fail(
      "source_not_compared",
      `Compare the entry with the source document (${entry.source.reference}) before confirming.`,
    );
  }
  if (check.outcome === "differs_from_source" && blank(check.difference)) {
    return fail("difference_required", "Say what differs from the source document.");
  }
  return {
    ok: true,
    entry: {
      ...entry,
      state: END_STATES.has(entry.state)
        ? entry.state
        : check.outcome === "matches_source"
          ? "checked"
          : "difference_found",
      secondCheck: {
        by: check.by,
        at: check.at,
        outcome: check.outcome,
        difference: check.outcome === "differs_from_source" ? check.difference : null,
      },
    },
  };
}

/** The version of a medicine in force at an instant: started, not ended, not withdrawn (rule 6b). */
export function versionInForceAt(versions: readonly MarEntry[], at: Date): MarEntry | null {
  return (
    versions.find((v) => {
      if (v.withdrawn !== null || v.startsAt.getTime() > at.getTime()) return false;
      const end = marEntryEnd(v);
      return end === null || at.getTime() < end.getTime();
    }) ?? null
  );
}

function oneMedicine(versions: readonly MarEntry[]): boolean {
  const first = versions[0];
  return (
    first !== undefined &&
    versions.every(
      (v) => v.personId === first.personId && v.product.vmpId === first.product.vmpId,
    ) &&
    new Set(versions.map((v) => v.id)).size === versions.length
  );
}

/** Versions that start after an instant: a change or stop then withdraws them only when asked. */
function laterVersions(versions: readonly MarEntry[], after: Date): readonly MarEntry[] {
  return live(versions).filter((v) => v.startsAt.getTime() > after.getTime());
}

function laterScheduled(later: readonly MarEntry[], stop: MarEntryStop | null): MarEntryIssue {
  const first = later.reduce<MarEntry | null>(
    (a, b) => (a === null || b.startsAt.getTime() < a.startsAt.getTime() ? b : a),
    null,
  );
  return {
    problem: "later_version_scheduled",
    message: first
      ? `Version ${first.version} starts ${formatUkDateTime(first.startsAt)}. Change that version instead, or withdraw it here and say why.`
      : `A stop is already recorded from ${formatUkDateTime((stop as MarEntryStop).effectiveAt)}. To stop sooner, say why the earlier stop replaces it.`,
  };
}

function withdraw(
  later: readonly MarEntry[],
  by: string,
  at: Date,
  reason: string | null | undefined,
): readonly MarEntry[] {
  const why = (reason ?? "").trim();
  return later.map(
    (v): MarEntry => ({ ...v, state: "withdrawn", withdrawn: { by, at, reason: why } }),
  );
}

export type MarEntryChange =
  | {
      readonly ok: true;
      readonly next: MarEntry;
      /** The version in force when the change takes effect, now ending then. */
      readonly replaced: MarEntry;
      /** Later versions that had not started, withdrawn as the change asked: the API audits each. */
      readonly withdrawn: readonly MarEntry[];
    }
  | { readonly ok: false; readonly issues: readonly MarEntryIssue[] };

/** A change's details: why it moves the day count, and why it withdraws later versions. */
export interface ChangeMeta extends TranscriptionMeta {
  readonly reanchorReason?: string | null;
  /** Why the versions scheduled to start later are withdrawn; without it, the change is refused. */
  readonly withdrawLaterReason?: string | null;
}

/**
 * A change is a new version of the same dm+d product (VMP): the dose, times, route, brand (AMP),
 * dates and directions can change; another VMP is a stop and a new entry. It is "Not yet checked"
 * and takes effect at `draft.startsAt` (now or later), when a version is in force: a medicine that
 * has stopped, or has not started, is not changed (a correction of an entry not yet started takes
 * effect from its start). It works on every version of the medicine (`versions`), so at every
 * instant exactly one version is in force (rule 6b): the version in force when the change takes
 * effect ends then. A change while a later version is scheduled is refused unless it
 * withdraws that version, with the reason (H-553). A stop still to come, on the version in force or
 * on a version withdrawn, carries over to the new version: a change never cancels a stop. So does
 * the course end (`stopsAt`): the new version gives the same end or an earlier one, never none or
 * a later one (`course_end_kept`); a course that continues past its end is a new entry from then.
 * The day count carries over from the last dose due (rule 6a). A change part-way through a day on
 * which either version has a regular dose is refused: it takes effect from 00:00 the next day, so
 * no dose that day is given twice or dropped (rule 6c). The exception is a correction, a change
 * of a version whose check found a difference: it fixes a transcription error, so it takes effect
 * at once for the rest of the day, and carries a notice that day to check the day's doses.
 */
export function changeMarEntry(
  versions: readonly MarEntry[],
  draft: MarEntryDraft,
  facts: DmdProductFacts,
  meta: ChangeMeta,
): MarEntryChange {
  if (!oneMedicine(versions)) {
    return fail("not_one_medicine", "These are not the versions of one medicine for one person.");
  }
  const first = versions[0] as MarEntry;
  if (draft.personId !== first.personId) {
    return fail("different_person", "The change is for a different person from the entry.");
  }
  if (draft.product.vmpId !== first.product.vmpId) {
    return fail(
      "different_product",
      `A change keeps the same medicine (${first.product.name}). To switch to ${draft.product.name}, stop this entry and record the new medicine as a new entry.`,
    );
  }
  const takesEffect = draft.startsAt;
  if (takesEffect.getTime() < meta.at.getTime()) {
    return fail(
      "change_in_past",
      "A change takes effect now or later. Doses before it stay as they were recorded.",
    );
  }
  const current = versionInForceAt(versions, takesEffect);
  if (current === null) {
    return fail(
      "entry_closed",
      "No version of this medicine is in force then: it has stopped, or has not started yet. Change it from a time it is in force, or record it as a new entry if it starts again.",
    );
  }
  const later = laterVersions(versions, takesEffect);
  if (later.length > 0 && blank(meta.withdrawLaterReason)) {
    return { ok: false, issues: [laterScheduled(later, null)] };
  }
  const issues = checkMarEntryDraft(draft, facts);
  if (issues.length > 0) return { ok: false, issues };
  const count = countRule(versions, draft, meta);
  if ("issue" in count) return { ok: false, issues: [count.issue] };

  const courseEnd = [current, ...later]
    .map((v) => v.stopsAt)
    .filter((end): end is Date => end !== null && end.getTime() > takesEffect.getTime())
    .reduce<Date | null>((a, b) => (a === null || b.getTime() < a.getTime() ? b : a), null);
  if (
    courseEnd !== null &&
    (draft.stopsAt === null || draft.stopsAt.getTime() > courseEnd.getTime())
  ) {
    return fail(
      "course_end_kept",
      `This course ends ${formatUkDateTime(courseEnd)}. A change keeps that end: give it, or an earlier one, as the new version's end. To continue past it, record a new entry from then.`,
    );
  }

  const latest = versions.reduce((a, b) => (b.version > a.version ? b : a));
  const carriedStop = [current, ...later]
    .map((v) => v.stop)
    .filter(
      (st): st is MarEntryStop => st !== null && st.effectiveAt.getTime() > takesEffect.getTime(),
    )
    .reduce<MarEntryStop | null>(
      (a, b) => (a === null || b.effectiveAt.getTime() < a.effectiveAt.getTime() ? b : a),
      null,
    );
  const next: MarEntry = {
    ...newEntry(draft, meta),
    version: latest.version + 1,
    replacesId: current.id,
    reanchor: count.reanchor,
    stop: carriedStop,
  };

  // Rule 6c: part-way through a day, only when neither version has a regular dose that day, or
  // as a correction of a version whose check found a difference, with that day's notice.
  const day = ukDateOf(takesEffect);
  const dayStart = ukStartOfDay(day);
  let correctedPartWayThrough: string | null = null;
  if (takesEffect.getTime() !== dayStart.getTime()) {
    const dayEnd = ukEndOfDay(day);
    const before = dosesIn(live(versions), { from: dayStart, to: dayEnd });
    const after = dosesIn([next], { from: takesEffect, to: dayEnd });
    if (before.length > 0 || after.length > 0) {
      if (current.secondCheck?.outcome !== "differs_from_source") {
        return fail(
          "change_from_tomorrow",
          "This medicine has a dose on the day the change takes effect. Start the change from 00:00 the next day, so no dose that day is given twice or dropped.",
        );
      }
      correctedPartWayThrough = day;
    }
  }
  return {
    ok: true,
    next: { ...next, correctedPartWayThrough },
    replaced: { ...current, state: "replaced", replacedById: next.id, replacedFrom: takesEffect },
    withdrawn: withdraw(later, meta.by, meta.at, meta.withdrawLaterReason),
  };
}

export type MarEntryStopResult =
  | {
      readonly ok: true;
      readonly stopped: MarEntry | null;
      readonly withdrawn: readonly MarEntry[];
    }
  | { readonly ok: false; readonly issues: readonly MarEntryIssue[] };

/** Why a stop withdraws the versions scheduled later, or replaces a later stop (H-553). */
export interface StopMeta {
  readonly withdrawLaterReason?: string | null;
}

/**
 * Stops a medicine now or later, with the reason and the source document that says so: the
 * version in force then ends (rule 6b). A stop while a later version or a later stop is scheduled
 * is refused unless it withdraws that version, or replaces that stop, with the reason (H-553).
 */
export function stopMarEntry(
  versions: readonly MarEntry[],
  stop: MarEntryStop,
  meta: StopMeta = {},
): MarEntryStopResult {
  if (!oneMedicine(versions)) {
    return fail("not_one_medicine", "These are not the versions of one medicine for one person.");
  }
  if (blank(stop.reason)) return fail("reason_required", "Say why the medicine is stopped.");
  const source = checkSource(stop.source);
  if (source.length > 0) return { ok: false, issues: source };
  if (stop.effectiveAt.getTime() < stop.at.getTime()) {
    return fail(
      "stop_in_past",
      "A stop takes effect now or later. Doses before it stay on the MAR as recorded.",
    );
  }
  const current = versionInForceAt(versions, stop.effectiveAt);
  const later = laterVersions(versions, stop.effectiveAt);
  if (current === null && later.length === 0) {
    return fail("entry_closed", "This medicine has already stopped or ended by then.");
  }
  if ((later.length > 0 || current?.stop) && blank(meta.withdrawLaterReason)) {
    return { ok: false, issues: [laterScheduled(later, current?.stop ?? null)] };
  }
  return {
    ok: true,
    stopped: current ? { ...current, state: "stopped", stop } : null,
    withdrawn: withdraw(later, stop.by, stop.at, meta.withdrawLaterReason),
  };
}

/** The first instant with no doses: the stop date, a stop, the newer version, or (withdrawn) its start. */
export function marEntryEnd(entry: MarEntry): Date | null {
  if (entry.withdrawn !== null) return entry.startsAt;
  const ends = [entry.stopsAt, entry.stop?.effectiveAt ?? null, entry.replacedFrom].filter(
    (d): d is Date => d !== null,
  );
  return ends.length === 0 ? null : new Date(Math.min(...ends.map((d) => d.getTime())));
}

/**
 * The regular doses an entry has on the MAR in [from, to); none for a when-required medicine or a
 * withdrawn version.
 */
export function marEntryDoses(
  entry: MarEntry,
  window: { readonly from: Date; readonly to: Date },
): readonly MarDose[] {
  if (entry.directions.kind !== "regular" || entry.withdrawn !== null) return [];
  return expandSchedule(
    entry.directions.schedule,
    { startsAt: entry.startsAt, endsAt: marEntryEnd(entry) },
    window,
  );
}

/** Tenant policy for entries awaiting their second check (H-550). */
export type UncheckedEntryPolicy = "give_with_notice" | "hold_until_checked";

export const MAR_ENTRY_NOTICES = {
  notYetChecked:
    "Not yet checked against the source document. A second person competent in medicines must check it.",
  holdUntilChecked:
    "Not yet checked: do not give until a second person competent in medicines has checked it against the source document. Tell the nurse in charge.",
  differenceFound:
    "Do not give: the check found a difference from the source document. Tell the nurse in charge, who records the corrected version; it can take effect at once.",
  changeTomorrow:
    "A change starts tomorrow: check today's remaining doses with the nurse in charge.",
  correctedToday:
    "Corrected part-way through today: check today's doses with the nurse in charge before giving the rest.",
  variableDose:
    "Do not give from this entry: its dose comes from the dosing record, which is not built yet. Ask the prescriber for today's dose and record it as a new MAR entry, stopping this one first.",
} as const;

export interface MarEntryStatus {
  readonly words: string;
  readonly mayGive: boolean;
  readonly notice: string | null;
}

function hasVariableDose(entry: MarEntry): boolean {
  const d = entry.directions;
  return d.kind === "when_required"
    ? d.dose.kind === "variable"
    : d.schedule.times.some((t) => t.dose.kind === "variable");
}

/**
 * What the MAR and the round say about an entry at an instant, in words (status is never shown
 * by colour alone), and whether a dose may be given from it: only from the version in force.
 */
export function marEntryStatus(
  entry: MarEntry,
  now: Date,
  policy: UncheckedEntryPolicy,
): MarEntryStatus {
  if (entry.withdrawn !== null) {
    return { words: "Withdrawn before it started", mayGive: false, notice: null };
  }
  if (now.getTime() < entry.startsAt.getTime()) {
    return {
      words: "Not started yet",
      mayGive: false,
      notice: `Starts ${formatUkDateTime(entry.startsAt)}. Until then, give only from the entry in force.`,
    };
  }
  const end = marEntryEnd(entry);
  if (end && now.getTime() >= end.getTime()) {
    const words =
      entry.replacedFrom && entry.replacedFrom.getTime() <= now.getTime()
        ? "Replaced by a newer entry"
        : entry.stop && entry.stop.effectiveAt.getTime() <= now.getTime()
          ? "Stopped"
          : "Ended";
    return { words, mayGive: false, notice: null };
  }
  const ending =
    entry.replacedFrom && entry.replacedFrom.getTime() === end?.getTime()
      ? `Replaced from ${formatUkDateTime(end)}.`
      : entry.stop && entry.stop.effectiveAt.getTime() === end?.getTime()
        ? `Stops from ${formatUkDateTime(end)}.`
        : null;
  const today = ukDateOf(now);
  const replacedTomorrow =
    entry.replacedFrom !== null &&
    entry.replacedFrom.getTime() === end?.getTime() &&
    entry.replacedFrom.getTime() === ukEndOfDay(today).getTime();
  const dayNotice = replacedTomorrow
    ? MAR_ENTRY_NOTICES.changeTomorrow
    : entry.correctedPartWayThrough === today
      ? MAR_ENTRY_NOTICES.correctedToday
      : null;
  const join = (notice: string | null) =>
    [notice, dayNotice, ending].filter(Boolean).join(" ") || null;
  let status: MarEntryStatus;
  if (entry.secondCheck === null) {
    status =
      policy === "give_with_notice"
        ? { words: "Not yet checked", mayGive: true, notice: join(MAR_ENTRY_NOTICES.notYetChecked) }
        : {
            words: "Not yet checked",
            mayGive: false,
            notice: join(MAR_ENTRY_NOTICES.holdUntilChecked),
          };
  } else if (entry.secondCheck.outcome === "differs_from_source") {
    status = {
      words: "Check found a difference",
      mayGive: false,
      notice: join(MAR_ENTRY_NOTICES.differenceFound),
    };
  } else {
    status = { words: "Checked", mayGive: true, notice: join(null) };
  }
  // Rule 2: no dose from a variable-dose entry until its dosing record is built and checked (slice 3).
  if (hasVariableDose(entry)) {
    return { ...status, mayGive: false, notice: join(MAR_ENTRY_NOTICES.variableDose) };
  }
  return status;
}
