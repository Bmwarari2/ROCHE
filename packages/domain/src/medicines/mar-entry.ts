/**
 * MAR entries (medicines.md rules 1 to 6; HZ-005, HZ-121). An entry is one medicine for one person
 * as transcribed from a source document: a dm+d product, a route dm+d gives for it, structured
 * doses, regular times or "when required", the prescriber, the dates, and the source document.
 *
 * States: a new or changed entry is "Not yet checked" until a second person, competent in
 * medicines and not the transcriber, compares it with the source document (NICE SC1, as the
 * master prompt cites it). A check that finds a difference holds the entry until a corrected
 * version replaces it. A change is a new version that replaces the old from the moment it takes
 * effect; a stop records why and on what source. Nothing is edited in place, so the history of
 * what the MAR said, and who checked it, is kept.
 *
 * Whether a not-yet-checked entry may be given before its check is the tenant policy the CSO
 * confirms (H-550); the default shows the dose with the notice and lets it be given, because a
 * dose held for want of a second person on a night shift is a missed dose (HZ-003).
 */

import { formatUkDateTime } from "../shared/time";
import { type DmdProductRef, type DmdRoute, isDmdProduct } from "./dmd";
import { checkDose, type Dose, type DoseUnit } from "./dose";
import {
  checkSchedule,
  expandSchedule,
  type MarDose,
  type RegularSchedule,
  type ScheduleProblem,
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
  | "change_in_past"
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
  | "replaced";

/** How the entry was made: typed from a source, from a reconciliation, or imported (slice 51). */
export type MarEntryOrigin = "transcribed" | "reconciliation" | "import";

/** The member's medicines competence, from workforce (slice 17's port; ADR-0085). */
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

function fail(problem: MarEntryProblem, message: string): { ok: false; issues: MarEntryIssue[] } {
  return { ok: false, issues: [{ problem, message }] };
}

/** A new entry, "Not yet checked" whatever its origin (an import or a reconciliation too). */
export function transcribeMarEntry(
  draft: MarEntryDraft,
  facts: DmdProductFacts,
  meta: TranscriptionMeta,
): MarEntryResult {
  const issues = checkMarEntryDraft(draft, facts);
  if (issues.length > 0) return { ok: false, issues };
  return {
    ok: true,
    entry: {
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
    },
  };
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

/**
 * Records the second check. The checker is a different person from the transcriber, holds
 * current medicines competence and has compared the entry with the source document.
 */
export function recordSecondCheck(entry: MarEntry, check: SecondCheckInput): MarEntryResult {
  if (entry.state !== "not_yet_checked") {
    return fail("not_awaiting_check", "This entry is not waiting for a check.");
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
      state: check.outcome === "matches_source" ? "checked" : "difference_found",
      secondCheck: {
        by: check.by,
        at: check.at,
        outcome: check.outcome,
        difference: check.outcome === "differs_from_source" ? check.difference : null,
      },
    },
  };
}

function closed(entry: MarEntry): boolean {
  return entry.state === "stopped" || entry.state === "replaced";
}

export type MarEntryChange =
  | { readonly ok: true; readonly replaced: MarEntry; readonly next: MarEntry }
  | { readonly ok: false; readonly issues: readonly MarEntryIssue[] };

/**
 * A change (dose, time, product, anything) is a new version, "Not yet checked", that replaces the
 * entry from the moment it takes effect (`draft.startsAt`, now or later). The old version keeps
 * its doses before then; nothing is edited in place.
 */
export function changeMarEntry(
  entry: MarEntry,
  draft: MarEntryDraft,
  facts: DmdProductFacts,
  meta: TranscriptionMeta,
): MarEntryChange {
  if (closed(entry)) return fail("entry_closed", "This entry has been stopped or replaced.");
  if (draft.personId !== entry.personId) {
    return fail("different_person", "The change is for a different person from the entry.");
  }
  if (draft.startsAt.getTime() < meta.at.getTime()) {
    return fail(
      "change_in_past",
      "A change takes effect now or later. Doses before it stay as they were recorded.",
    );
  }
  const created = transcribeMarEntry(draft, facts, meta);
  if (!created.ok) return created;
  return {
    ok: true,
    replaced: { ...entry, state: "replaced", replacedById: meta.id, replacedFrom: draft.startsAt },
    next: { ...created.entry, version: entry.version + 1, replacesId: entry.id },
  };
}

/** Stops an entry now or later, with the reason and the source document that says so. */
export function stopMarEntry(entry: MarEntry, stop: MarEntryStop): MarEntryResult {
  if (closed(entry))
    return fail("entry_closed", "This entry has already been stopped or replaced.");
  if (blank(stop.reason)) return fail("reason_required", "Say why the medicine is stopped.");
  const source = checkSource(stop.source);
  if (source.length > 0) return { ok: false, issues: source };
  if (stop.effectiveAt.getTime() < stop.at.getTime()) {
    return fail(
      "stop_in_past",
      "A stop takes effect now or later. Doses before it stay on the MAR as recorded.",
    );
  }
  return { ok: true, entry: { ...entry, state: "stopped", stop } };
}

/** The first instant with no doses: the stop date, a stop, or the newer version taking over. */
export function marEntryEnd(entry: MarEntry): Date | null {
  const ends = [entry.stopsAt, entry.stop?.effectiveAt ?? null, entry.replacedFrom].filter(
    (d): d is Date => d !== null,
  );
  return ends.length === 0 ? null : new Date(Math.min(...ends.map((d) => d.getTime())));
}

/** The regular doses an entry has on the MAR in [from, to); none for a when-required medicine. */
export function marEntryDoses(
  entry: MarEntry,
  window: { readonly from: Date; readonly to: Date },
): readonly MarDose[] {
  if (entry.directions.kind !== "regular") return [];
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
    "Do not give: the check found a difference from the source document. Tell the nurse in charge, who records a corrected entry.",
} as const;

export interface MarEntryStatus {
  readonly words: string;
  readonly mayGive: boolean;
  readonly notice: string | null;
}

/**
 * What the MAR and the round say about an entry at an instant, in words (status is never shown
 * by colour alone), and whether a dose may be given from it.
 */
export function marEntryStatus(
  entry: MarEntry,
  now: Date,
  policy: UncheckedEntryPolicy,
): MarEntryStatus {
  const end = marEntryEnd(entry);
  if (end && now.getTime() >= end.getTime()) {
    const words =
      entry.state === "replaced"
        ? "Replaced by a newer entry"
        : entry.state === "stopped"
          ? "Stopped"
          : "Ended";
    return { words, mayGive: false, notice: null };
  }
  const ending =
    entry.state === "stopped" || entry.state === "replaced"
      ? `${entry.state === "stopped" ? "Stops" : "Replaced"} from ${formatUkDateTime(end as Date)}.`
      : null;
  const join = (notice: string | null) => [notice, ending].filter(Boolean).join(" ") || null;
  if (entry.secondCheck === null) {
    return policy === "give_with_notice"
      ? { words: "Not yet checked", mayGive: true, notice: join(MAR_ENTRY_NOTICES.notYetChecked) }
      : {
          words: "Not yet checked",
          mayGive: false,
          notice: join(MAR_ENTRY_NOTICES.holdUntilChecked),
        };
  }
  if (entry.secondCheck.outcome === "differs_from_source") {
    return {
      words: "Check found a difference",
      mayGive: false,
      notice: join(MAR_ENTRY_NOTICES.differenceFound),
    };
  }
  return { words: "Checked", mayGive: true, notice: join(null) };
}
