/**
 * MAR entries (medicines.md rules 1 to 6; HZ-005, HZ-121). An entry is one medicine for one person
 * as transcribed from a source document: a dm+d product, a route dm+d gives for it, structured
 * doses, regular times or "when required", the prescriber, the dates, and the source document.
 *
 * States: a new or changed entry is "Not yet checked" until a second person, competent in
 * medicines and not the transcriber, compares it with the source document (NICE SC1, as the
 * master prompt cites it). A check that finds a difference holds the entry until a corrected
 * version replaces it. A change is a new version; a stop records why and on what source. Both work
 * on every version of the medicine, so exactly one version is in force at any instant (rule 6b).
 * Nothing is edited in place, so the history of what the MAR said, and who checked it, is kept.
 *
 * Whether a not-yet-checked entry may be given before its check is the tenant policy the CSO
 * confirms (H-550); the default shows the dose with the notice and lets it be given, because a
 * dose held for want of a second person on a night shift is a missed dose (HZ-003).
 */

import { formatUkDateTime, ukEndOfDay, ukStartOfDay } from "../shared/time";
import { type DmdProductRef, type DmdRoute, isDmdProduct } from "./dmd";
import { checkDose, type Dose, type DoseUnit, isDoseQuantity } from "./dose";
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

/**
 * Regular times with a dose at each, or a when-required (PRN) medicine with its dose and the most
 * the prescription or PRN protocol allows in any 24 hours, in the dose's unit (null when the source
 * states none: the PRN status then says so, H-555).
 */
export type MarDirections =
  | { readonly kind: "regular"; readonly schedule: RegularSchedule }
  | {
      readonly kind: "when_required";
      readonly dose: Dose;
      readonly maxQuantityPer24Hours: number | null;
    };

/**
 * Tags a person sets at transcription and the second check confirms (ADR-0082). They switch on the
 * tenant's rules for the entry; Harbour never sets one by matching ingredients:
 * - `time_critical`: the narrower dose window (for example Parkinson's medicines, insulin);
 * - `paracetamol`: the paracetamol minimum interval, across every entry the person tagged so;
 * - `bisphosphonate`: the before-food instruction;
 * - `psychotropic`: counted in the PRN psychotropic report (slice 28).
 */
export const MEDICINE_TAGS = [
  "time_critical",
  "paracetamol",
  "bisphosphonate",
  "psychotropic",
] as const;
export type MedicineTag = (typeof MEDICINE_TAGS)[number];

/** The tenant's own lists of dm+d VMPs for each tag (ADR-0082: tenant-maintained, H-514). */
export type TenantMedicineLists = Readonly<Record<MedicineTag, ReadonlySet<string>>>;

/**
 * Tags to offer the transcriber for a product: those whose tenant list holds the product's exact
 * VMP. A suggestion only; the transcriber confirms each tag and the second check covers it. Harbour
 * never suggests a tag from an ingredient, a name or another product.
 */
export function suggestedTags(
  product: Pick<DmdProductRef, "vmpId">,
  lists: TenantMedicineLists,
): readonly MedicineTag[] {
  return MEDICINE_TAGS.filter((tag) => lists[tag].has(product.vmpId));
}

export interface MarEntryDraft {
  readonly personId: string;
  readonly product: DmdProductRef;
  readonly route: DmdRoute;
  readonly directions: MarDirections;
  readonly tags: readonly MedicineTag[];
  /** The least time between doses that the prescription or PRN protocol states, if it states one. */
  readonly minimumIntervalMinutes: number | null;
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
  | "bad_tag"
  | "bad_minimum_interval"
  | "bad_maximum"
  | "maximum_below_dose"
  | "not_awaiting_check"
  | "checker_is_transcriber"
  | "checker_not_competent"
  | "source_not_compared"
  | "difference_required"
  | "entry_closed"
  | "different_person"
  | "change_in_past"
  | "not_one_medicine"
  | "todays_doses_unstated"
  | "no_dose_left_today"
  | "nothing_given_yet"
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

/** The most one dose can be: the amount, or the top of a range; 0 for a variable dose. */
function largestSingleDose(dose: Dose): number {
  return dose.kind === "amount" ? dose.quantity : dose.kind === "range" ? dose.to : 0;
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
    const max = d.maxQuantityPer24Hours;
    if (max !== null && !isDoseQuantity(max)) {
      issues.push({
        problem: "bad_maximum",
        message: "Write the most allowed in 24 hours as a number in the dose's unit.",
      });
    } else if (max !== null && max < largestSingleDose(d.dose)) {
      issues.push({
        problem: "maximum_below_dose",
        message:
          "The most allowed in 24 hours is less than one dose. Check both against the source document.",
      });
    }
  }
  if (
    new Set(draft.tags).size !== draft.tags.length ||
    draft.tags.some((t) => !MEDICINE_TAGS.includes(t))
  ) {
    issues.push({ problem: "bad_tag", message: "Choose each tag once, from the list." });
  }
  const interval = draft.minimumIntervalMinutes;
  if (interval !== null && !(Number.isInteger(interval) && interval > 0)) {
    issues.push({
      problem: "bad_minimum_interval",
      message: "Write the least time between doses in whole minutes, as the source states it.",
    });
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

/**
 * On the day a change takes effect, what happened to that day's doses: `all_given` (every dose
 * that day was given or recorded before the change, so the new version gives none that day) or
 * `some_still_due` (a dose is still to come that day, at the new times).
 */
export type TodaysDoses = "all_given" | "some_still_due";

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
  /** Set when a later change or stop took effect before this version started: it is never in force. */
  readonly withdrawn: { readonly by: string; readonly at: Date; readonly reason: string } | null;
  /** The day this version took over mid-day, and what happened to that day's doses (rule 6c). */
  readonly changeDay: { readonly date: string; readonly todaysDoses: TodaysDoses } | null;
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

/** A new entry's details: the person's earlier entries keep a restarted medicine's day count. */
export interface NewEntryMeta extends TranscriptionMeta {
  /**
   * Every version of the person's entries the API holds for the same dm+d product, stopped ones
   * included (the API passes them all; the rule keeps those for this person and VMP): a stop then
   * a start of the same product keeps the count from the last dose due (rule 6a).
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
    changeDay: null,
  };
}

/**
 * The last dose due before an instant across versions of a medicine (withdrawn versions had no
 * doses), looking back from `before` to the earliest version's start.
 */
export function lastDueDose(versions: readonly MarEntry[], before: Date): MarDose | null {
  const live = versions.filter((v) => v.withdrawn === null && v.directions.kind === "regular");
  if (live.length === 0) return null;
  const earliest = Math.min(...live.map((v) => v.startsAt.getTime()));
  for (let to = before.getTime(); to > earliest; to -= LOOK_BACK_DAYS * DAY_MS) {
    const window = {
      from: new Date(Math.max(earliest, to - LOOK_BACK_DAYS * DAY_MS)),
      to: new Date(to),
    };
    const doses = live.flatMap((v) => marEntryDoses(v, window));
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
 * A new entry, "Not yet checked" whatever its origin (an import or a reconciliation too). A
 * restart of a product the person had before keeps that medicine's day count (rule 6a).
 */
export function transcribeMarEntry(
  draft: MarEntryDraft,
  facts: DmdProductFacts,
  meta: NewEntryMeta,
): MarEntryResult {
  const issues = checkMarEntryDraft(draft, facts);
  if (issues.length > 0) return { ok: false, issues };
  const earlier = meta.earlierEntries.filter(
    (e) => e.personId === draft.personId && e.product.vmpId === draft.product.vmpId,
  );
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
    versions.every((v) => v.personId === first.personId) &&
    new Set(versions.map((v) => v.id)).size === versions.length
  );
}

function withdraw(
  versions: readonly MarEntry[],
  after: Date,
  by: string,
  at: Date,
  reason: string,
) {
  return versions
    .filter((v) => v.withdrawn === null && v.startsAt.getTime() > after.getTime())
    .map((v): MarEntry => ({ ...v, state: "withdrawn", withdrawn: { by, at, reason } }));
}

export type MarEntryChange =
  | {
      readonly ok: true;
      readonly next: MarEntry;
      /** The version in force when the change takes effect, now ending then; null if none had started. */
      readonly replaced: MarEntry | null;
      /** Later versions that had not started, withdrawn: the API audits each. */
      readonly withdrawn: readonly MarEntry[];
    }
  | { readonly ok: false; readonly issues: readonly MarEntryIssue[] };

/** A change's details: the reason when it moves the day count, and what happened to that day's doses. */
export interface ChangeMeta extends TranscriptionMeta {
  readonly reanchorReason?: string | null;
  readonly todaysDoses?: TodaysDoses | null;
}

/**
 * A change (dose, time, product, anything) is a new version, "Not yet checked", taking effect at
 * `draft.startsAt` (now or later). It works on every version of the medicine (`versions`), so at
 * every instant exactly one version is in force (rule 6b): the version in force when the change
 * takes effect ends then, and any later version that had not started is withdrawn. A stop still to
 * come carries over to the new version, so a change never cancels a stop. The day count carries
 * over from the last dose due (rule 6a), and a change on a day with doses says what happened to
 * that day's doses (rule 6c). Corrections are changes: allowed whenever a version is in force,
 * whatever is still to come.
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
  if (draft.personId !== versions[0]?.personId) {
    return fail("different_person", "The change is for a different person from the entry.");
  }
  const takesEffect = draft.startsAt;
  if (takesEffect.getTime() < meta.at.getTime()) {
    return fail(
      "change_in_past",
      "A change takes effect now or later. Doses before it stay as they were recorded.",
    );
  }
  const current = versionInForceAt(versions, takesEffect);
  const pending = versions.filter(
    (v) => v.withdrawn === null && v.startsAt.getTime() > takesEffect.getTime(),
  );
  if (current === null && pending.length === 0) {
    return fail(
      "entry_closed",
      "This medicine has stopped or ended by then. Record it as a new entry if it starts again.",
    );
  }
  const issues = checkMarEntryDraft(draft, facts);
  if (issues.length > 0) return { ok: false, issues };
  const count = countRule(versions, draft, meta);
  if ("issue" in count) return { ok: false, issues: [count.issue] };

  const latest = versions.reduce((a, b) => (b.version > a.version ? b : a));
  const carriedStop =
    current?.stop && current.stop.effectiveAt.getTime() > takesEffect.getTime()
      ? current.stop
      : null;
  const candidate: MarEntry = {
    ...newEntry(draft, meta),
    version: latest.version + 1,
    replacesId: (current ?? latest).id,
    reanchor: count.reanchor,
    stop: carriedStop,
  };

  // Rule 6c: a change on a day with doses says what happened to that day's doses.
  const day = ukDateOf(takesEffect);
  const dayWindow = { from: ukStartOfDay(day), to: ukEndOfDay(day) };
  const oldToday = current ? marEntryDoses(current, dayWindow) : [];
  const newToday = marEntryDoses(candidate, { from: takesEffect, to: dayWindow.to });
  let changeDay: MarEntry["changeDay"] = null;
  if (oldToday.length > 0 || newToday.length > 0) {
    if (!meta.todaysDoses) {
      return fail(
        "todays_doses_unstated",
        "This change takes effect on a day with doses. Say whether that day's doses have all been given, or one is still due at the new times.",
      );
    }
    if (meta.todaysDoses === "some_still_due" && newToday.length === 0) {
      return fail(
        "no_dose_left_today",
        "The new times leave no dose for the rest of that day. Start the change the next day, or ask the prescriber when that day's dose is due.",
      );
    }
    const dueBefore = oldToday.some((d) => d.dueAt.getTime() < takesEffect.getTime());
    if (meta.todaysDoses === "all_given" && !dueBefore) {
      return fail(
        "nothing_given_yet",
        "No dose was due yet that day under the current entry, so none can have been given. Say a dose is still due at the new times, or start the change the next day.",
      );
    }
    changeDay = { date: day, todaysDoses: meta.todaysDoses };
  }
  const next: MarEntry = { ...candidate, changeDay };
  return {
    ok: true,
    next,
    replaced: current
      ? { ...current, state: "replaced", replacedById: next.id, replacedFrom: takesEffect }
      : null,
    withdrawn: withdraw(
      versions,
      takesEffect,
      meta.by,
      meta.at,
      `Replaced before it started by version ${next.version}`,
    ),
  };
}

export type MarEntryStopResult =
  | {
      readonly ok: true;
      readonly stopped: MarEntry | null;
      readonly withdrawn: readonly MarEntry[];
    }
  | { readonly ok: false; readonly issues: readonly MarEntryIssue[] };

/**
 * Stops a medicine now or later, with the reason and the source document that says so: the
 * version in force then ends, and any later version that had not started is withdrawn (rule 6b).
 */
export function stopMarEntry(
  versions: readonly MarEntry[],
  stop: MarEntryStop,
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
  const withdrawn = withdraw(
    versions,
    stop.effectiveAt,
    stop.by,
    stop.at,
    "Stopped before it started",
  );
  if (current === null && withdrawn.length === 0) {
    return fail("entry_closed", "This medicine has already stopped or ended by then.");
  }
  return {
    ok: true,
    stopped: current ? { ...current, state: "stopped", stop } : null,
    withdrawn,
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
 * withdrawn version; none on its change day when that day's doses were all given (rule 6c).
 */
export function marEntryDoses(
  entry: MarEntry,
  window: { readonly from: Date; readonly to: Date },
): readonly MarDose[] {
  if (entry.directions.kind !== "regular" || entry.withdrawn !== null) return [];
  const doses = expandSchedule(
    entry.directions.schedule,
    { startsAt: entry.startsAt, endsAt: marEntryEnd(entry) },
    window,
  );
  const skip = entry.changeDay?.todaysDoses === "all_given" ? entry.changeDay.date : null;
  return skip === null ? doses : doses.filter((d) => d.date !== skip);
}

/** Tenant policy for entries awaiting their second check (H-550). */
export type UncheckedEntryPolicy = "give_with_notice" | "hold_until_checked";

export const MAR_ENTRY_NOTICES = {
  notYetChecked:
    "Not yet checked against the source document. A second person competent in medicines must check it.",
  holdUntilChecked:
    "Not yet checked: do not give until a second person competent in medicines has checked it against the source document. Tell the nurse in charge.",
  differenceFound:
    "Do not give: the check found a difference from the source document. Tell the nurse in charge, who records a corrected entry.",
  variableDose:
    "Variable dose: give only the dose the checked dosing record gives for the day. With none, do not give: tell the nurse in charge.",
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
  const join = (notice: string | null) => [notice, ending].filter(Boolean).join(" ") || null;
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
  // Rule 18: a variable dose comes from the checked dosing record; `checkAdministration` refuses
  // any dose without one (`no_checked_dosing_record`), so the entry shows where the dose comes from.
  if (hasVariableDose(entry)) {
    return {
      ...status,
      notice: [status.notice, MAR_ENTRY_NOTICES.variableDose].filter(Boolean).join(" "),
    };
  }
  return status;
}
