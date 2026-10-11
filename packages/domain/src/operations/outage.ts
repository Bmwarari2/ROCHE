import { checkEntryTime, isLateEntry } from "../care/entries";
import { defineWorkflow } from "../platform/workflow";
import { formatUkDateTime, resolveRecordedUkTime } from "../shared/time";
import type { OperationsRates } from "./rates";

/**
 * Outages and back-entry (master prompt 13.4: "downtime forms and a back-entry workflow";
 * operations.md section 4 rules 9 to 15; hazards HZ-009, HZ-017 and HZ-021).
 *
 * The nurse or senior in charge declares an outage for a location (it can be declared after it
 * began, even after it ended) and closes it when systems return. Care given on paper during the
 * outage is entered later: the time written on the form is resolved in UK time with the one rule
 * for typed event times (`resolveRecordedUkTime`, so a time in the skipped spring hour is refused
 * and one in the repeated autumn hour is asked about), and the entry carries the late-entry reason
 * "downtime" and the outage it belongs to; it is refused outside the outage unless a reason is
 * given. An entry typed through the normal route for a time inside an outage must say whether it
 * comes from paper. A manager who entered none of the paper records reconciles the outage, after
 * reviewing every possible duplicate, paper against paper and paper against digital.
 */

export const OUTAGE_KINDS = [
  "power",
  "network",
  "harbour_unavailable",
  "device_failure",
  "planned_maintenance",
  "other",
] as const;

export type OutageKind = (typeof OUTAGE_KINDS)[number];

export const OUTAGE_KIND_LABELS: Readonly<Record<OutageKind, string>> = {
  power: "Power cut",
  network: "Internet or network failure",
  harbour_unavailable: "Harbour unavailable",
  device_failure: "Devices not working",
  planned_maintenance: "Planned maintenance",
  other: "Other outage",
};

export type OutageState = "declared" | "closed" | "reconciled" | "cancelled";

/**
 * Declared (open) to closed (systems back, paper being entered) to reconciled (every paper form
 * entered and checked). A declaration made in error is cancelled with a reason; the API refuses
 * that once any back-entry cites the outage. The closed state's SLA is the back-entry deadline.
 */
export const OUTAGE_WORKFLOW = defineWorkflow<OutageState>({
  key: "operations.outage",
  version: 1,
  states: ["declared", "closed", "reconciled", "cancelled"],
  initial: "declared",
  terminal: ["reconciled", "cancelled"],
  transitions: [
    { from: "declared", to: "closed", permission: "operations.downtime.manage" },
    {
      from: "closed",
      to: "reconciled",
      permission: "operations.downtime.manage",
      requiresReason: true,
    },
    {
      from: "declared",
      to: "cancelled",
      permission: "operations.downtime.manage",
      requiresReason: true,
    },
  ],
  sla: { closed: { rateKey: "downtime.back_entry_due_hours", unit: "hours" } },
});

export interface OutageWindow {
  readonly id: string;
  readonly locationId: string;
  readonly kind: OutageKind;
  readonly state: OutageState;
  /** When the outage actually began (may be before it was declared). */
  readonly startedAt: Date;
  /** When systems came back; null while the outage is open. */
  readonly endedAt: Date | null;
  readonly declaredAt: Date;
  readonly declaredBy: string;
}

/** Why: long enough to say what failed ("Power cut, whole building"), short enough in a crisis. */
export const MIN_OUTAGE_DESCRIPTION_LENGTH = 10;
/** Why: a back-entry outside the outage must say why in words someone else can follow later. */
export const MIN_BACK_ENTRY_REASON_LENGTH = 10;
/** Why: a reconciliation statement names what was checked ("All 14 forms entered and checked"). */
export const MIN_RECONCILIATION_STATEMENT_LENGTH = 10;

const MS_PER_MINUTE = 60_000;
const MS_PER_HOUR = 60 * MS_PER_MINUTE;

function hasText(value: string | null | undefined, min: number): boolean {
  return (value?.trim().length ?? 0) >= min;
}

/** True when two windows share any instant; an open window (no end) runs on for ever. */
function overlaps(aStart: Date, aEnd: Date | null, bStart: Date, bEnd: Date | null): boolean {
  const aEndsAfterBStarts = aEnd === null || aEnd.getTime() > bStart.getTime();
  const bEndsAfterAStarts = bEnd === null || bEnd.getTime() > aStart.getTime();
  return aEndsAfterBStarts && bEndsAfterAStarts;
}

// ------------------------------------------------------------------------------------------------
// Declaring and closing an outage
// ------------------------------------------------------------------------------------------------

export interface OutageDeclaration {
  readonly locationId: string;
  readonly kind: OutageKind;
  readonly startedAt: Date;
  /** Set when the outage is declared after it ended; null while it is still going on. */
  readonly endedAt: Date | null;
  /** Server time of the declaration. */
  readonly declaredAt: Date;
  readonly description: string | null;
}

export type OutageDeclarationProblem =
  | "start_in_future"
  | "ends_before_start"
  | "ends_in_future"
  | "description_required"
  | "already_open"
  | "overlaps_another_outage";

export const OUTAGE_DECLARATION_MESSAGES: Readonly<Record<OutageDeclarationProblem, string>> = {
  start_in_future: "The outage cannot start in the future. Check the time and the device clock.",
  ends_before_start: "The outage cannot end before it started.",
  ends_in_future: "The outage cannot end in the future. Check the time and the device clock.",
  description_required: "Say what has failed, for example 'Power cut, whole building'.",
  already_open: "An outage is already open for this location at that time. Use that one.",
  overlaps_another_outage:
    "This time overlaps another outage at this location. Check the times, or use that outage.",
};

export type OutageDeclarationCheck =
  | {
      readonly ok: true;
      /** Declared more than the late-entry threshold after it began: shown on the outage. */
      readonly declaredLate: boolean;
    }
  | { readonly ok: false; readonly problems: readonly OutageDeclarationProblem[] };

/**
 * Checks a new outage against the location's other outages (cancelled ones are ignored). An
 * earlier outage can be declared late, even when a later one exists, as long as they do not overlap.
 */
export function checkOutageDeclaration(
  declaration: OutageDeclaration,
  existing: readonly OutageWindow[],
  rates: Pick<OperationsRates, "lateEntryHours" | "clockDriftMinutes">,
): OutageDeclarationCheck {
  const problems: OutageDeclarationProblem[] = [];
  const drift = rates.clockDriftMinutes * MS_PER_MINUTE;
  const start = declaration.startedAt.getTime();
  if (start - declaration.declaredAt.getTime() > drift) problems.push("start_in_future");
  if (declaration.endedAt !== null) {
    if (declaration.endedAt.getTime() < start) problems.push("ends_before_start");
    if (declaration.endedAt.getTime() - declaration.declaredAt.getTime() > drift) {
      problems.push("ends_in_future");
    }
  }
  if (!hasText(declaration.description, MIN_OUTAGE_DESCRIPTION_LENGTH)) {
    problems.push("description_required");
  }
  const clashing = existing.filter(
    (o) =>
      o.locationId === declaration.locationId &&
      o.state !== "cancelled" &&
      overlaps(o.startedAt, o.endedAt, declaration.startedAt, declaration.endedAt),
  );
  if (clashing.some((o) => o.state === "declared")) problems.push("already_open");
  else if (clashing.length > 0) problems.push("overlaps_another_outage");
  if (problems.length > 0) return { ok: false, problems };
  return {
    ok: true,
    declaredLate: declaration.declaredAt.getTime() - start > rates.lateEntryHours * MS_PER_HOUR,
  };
}

export type OutageClosureProblem = "not_open" | "ends_before_start" | "ends_in_future";

export const OUTAGE_CLOSURE_MESSAGES: Readonly<Record<OutageClosureProblem, string>> = {
  not_open: "This outage is not open.",
  ends_before_start: "The outage cannot end before it started.",
  ends_in_future: "The outage cannot end in the future. Check the time and the device clock.",
};

export type OutageClosureCheck =
  | {
      readonly ok: true;
      /** When the paper records should all be entered (`downtime.back_entry_due_hours`). */
      readonly backEntryDueAt: Date;
    }
  | { readonly ok: false; readonly problems: readonly OutageClosureProblem[] };

/** Closing an outage when systems are back; the back-entry task falls due from the closure. */
export function checkOutageClosure(
  outage: OutageWindow,
  closure: { readonly endedAt: Date; readonly closedAt: Date },
  rates: Pick<OperationsRates, "backEntryDueHours" | "clockDriftMinutes">,
): OutageClosureCheck {
  const problems: OutageClosureProblem[] = [];
  if (outage.state !== "declared") problems.push("not_open");
  if (closure.endedAt.getTime() < outage.startedAt.getTime()) problems.push("ends_before_start");
  if (
    closure.endedAt.getTime() - closure.closedAt.getTime() >
    rates.clockDriftMinutes * MS_PER_MINUTE
  ) {
    problems.push("ends_in_future");
  }
  if (problems.length > 0) return { ok: false, problems };
  return {
    ok: true,
    backEntryDueAt: new Date(closure.closedAt.getTime() + rates.backEntryDueHours * MS_PER_HOUR),
  };
}

// ------------------------------------------------------------------------------------------------
// Paper times (HZ-009, HZ-017)
// ------------------------------------------------------------------------------------------------

/** What is written on the form: the UK date (yyyy-mm-dd) and the 24-hour time (hh:mm). */
export interface PaperTimeWritten {
  readonly date: string;
  readonly time: string;
}

export type PaperTimeProblem = "invalid" | "skipped" | "ambiguous" | "future";

export type PaperTimeResolution =
  | {
      readonly ok: true;
      readonly instant: Date;
      readonly written: PaperTimeWritten;
      /** `only`, or which of the two occurrences of a repeated autumn hour the person chose. */
      readonly occurrence: "only" | "earlier" | "later";
    }
  | {
      readonly ok: false;
      readonly problem: PaperTimeProblem;
      readonly written: PaperTimeWritten;
      /** For `ambiguous`: the two instants to choose between. */
      readonly choices: { readonly earlier: Date; readonly later: Date } | null;
    };

function digits(text: string): number | null {
  if (text.length === 0) return null;
  let value = 0;
  for (const ch of text) {
    if (ch < "0" || ch > "9") return null;
    value = value * 10 + (ch.charCodeAt(0) - 48);
  }
  return value;
}

function parseWritten(written: PaperTimeWritten) {
  const d = written.date;
  const t = written.time.trim();
  if (d.length !== 10 || d[4] !== "-" || d[7] !== "-") return null;
  const timeParts = t.split(":");
  if (timeParts.length !== 2 || (timeParts[0]?.length ?? 0) > 2 || timeParts[1]?.length !== 2) {
    return null;
  }
  const year = digits(d.slice(0, 4));
  const month = digits(d.slice(5, 7));
  const day = digits(d.slice(8, 10));
  const hour = digits(timeParts[0] ?? "");
  const minute = digits(timeParts[1] ?? "");
  if (year === null || month === null || day === null || hour === null || minute === null) {
    return null;
  }
  return { year, month, day, hour, minute };
}

/**
 * Turns the date and time written on a paper form into an instant with the one rule for typed UK
 * times. A time in the hour the clocks skip in spring is refused; one in the hour repeated in
 * autumn needs `occurrence` (asked of the person, never guessed); a future time is refused.
 */
export function resolvePaperTime(
  written: PaperTimeWritten,
  options: {
    readonly now: Date;
    readonly clockDriftMinutes: number;
    readonly occurrence?: "earlier" | "later";
  },
): PaperTimeResolution {
  const refuse = (
    problem: PaperTimeProblem,
    choices: { earlier: Date; later: Date } | null = null,
  ): PaperTimeResolution => ({ ok: false, problem, written, choices });
  const parts = parseWritten(written);
  if (!parts) return refuse("invalid");
  let resolved: ReturnType<typeof resolveRecordedUkTime>;
  try {
    resolved = resolveRecordedUkTime(parts, {
      now: options.now,
      futureToleranceMinutes: options.clockDriftMinutes,
    });
  } catch {
    return refuse("invalid");
  }
  switch (resolved.kind) {
    case "exact":
      return { ok: true, instant: resolved.instant, written, occurrence: "only" };
    case "skipped":
      return refuse("skipped");
    case "future":
      return refuse("future");
    case "ambiguous": {
      const choices = { earlier: resolved.earlier, later: resolved.later };
      if (!options.occurrence) return refuse("ambiguous", choices);
      return {
        ok: true,
        instant: options.occurrence === "earlier" ? resolved.earlier : resolved.later,
        written,
        occurrence: options.occurrence,
      };
    }
  }
}

// ------------------------------------------------------------------------------------------------
// Back-entry
// ------------------------------------------------------------------------------------------------

export interface BackEntryInput {
  readonly personId: string;
  /** The person's location when the care was given. */
  readonly locationId: string;
  /** The time written on the paper form, resolved with `resolvePaperTime`. */
  readonly paperTime: PaperTimeResolution;
  /** When it was typed into Harbour (device time; the server time for the web). */
  readonly recordedAt: Date;
  /** When the server received it, shown beside the device time. */
  readonly receivedAt: Date;
  readonly outageId: string | null;
  /** Needed only when the paper time falls outside the outage. */
  readonly reason: string | null;
  /** The downtime form's reference, when the form has one. */
  readonly paperReference: string | null;
}

export type BackEntryProblem =
  | "outage_required"
  | "unknown_outage"
  | "outage_cancelled"
  | "other_location"
  | "paper_time_invalid"
  | "paper_time_skipped"
  | "paper_time_ambiguous"
  | "future_entry"
  | "entered_before_outage"
  | "outside_outage_window";

export const BACK_ENTRY_MESSAGES: Readonly<Record<BackEntryProblem, string>> = {
  outage_required:
    "Choose the outage this paper record belongs to. If none was declared, declare it first: it can be declared after it ended.",
  unknown_outage: "That outage was not found.",
  outage_cancelled: "That outage was cancelled. Choose the right one.",
  other_location: "That outage was at a different location.",
  paper_time_invalid:
    "Enter the date and time written on the paper form, as a date and a 24-hour time.",
  paper_time_skipped:
    "That time did not happen: the clocks went forward an hour that night. Check the paper form.",
  paper_time_ambiguous:
    "That time happened twice: the clocks went back an hour that night. Choose the first or the second time.",
  future_entry: "The time on the paper is in the future. Check the time and the device clock.",
  entered_before_outage: "A record cannot be entered from paper before the outage began.",
  outside_outage_window:
    "The time on the paper is outside the outage. Check the time, or say why it was written on paper.",
};

const PAPER_TIME_PROBLEMS: Readonly<Record<PaperTimeProblem, BackEntryProblem>> = {
  invalid: "paper_time_invalid",
  skipped: "paper_time_skipped",
  ambiguous: "paper_time_ambiguous",
  future: "future_entry",
};

export interface BackEntryAccepted {
  readonly ok: true;
  readonly eventAt: Date;
  readonly lateEntryReason: "downtime";
  /** The usual late-entry flag (care.md rule 3); a back-entry is always labelled as one as well. */
  readonly lateEntry: boolean;
  readonly outageId: string;
  readonly withinOutage: boolean;
  readonly outsideReason: string | null;
  readonly paperReference: string | null;
  /** Shown wherever the entry appears, so it never reads as written at the time (HZ-017). */
  readonly label: string;
}

export type BackEntryCheck =
  | BackEntryAccepted
  | { readonly ok: false; readonly problems: readonly BackEntryProblem[] };

/** The words shown with a back-entered record: paper time, outage, device and server times. */
export function backEntryLabel(entry: {
  readonly eventAt: Date;
  readonly recordedAt: Date;
  readonly receivedAt: Date;
  readonly outage: Pick<OutageWindow, "kind" | "startedAt">;
  readonly withinOutage: boolean;
  readonly outsideReason: string | null;
}): string {
  const written = `Written on paper ${formatUkDateTime(entry.eventAt)}`;
  const context = entry.withinOutage
    ? `during the outage (${OUTAGE_KIND_LABELS[entry.outage.kind].toLowerCase()}) from ${formatUkDateTime(entry.outage.startedAt)}`
    : entry.outsideReason
      ? `outside the declared outage (${entry.outsideReason})`
      : "outside the declared outage";
  return `${written} ${context}. Entered in Harbour ${formatUkDateTime(entry.recordedAt)} on the device, received ${formatUkDateTime(entry.receivedAt)}.`;
}

/** Checks a record entered from a paper downtime form. */
export function checkBackEntry(
  input: BackEntryInput,
  outages: readonly OutageWindow[],
  rates: Pick<OperationsRates, "lateEntryHours" | "clockDriftMinutes">,
): BackEntryCheck {
  if (input.outageId === null) return { ok: false, problems: ["outage_required"] };
  const outage = outages.find((o) => o.id === input.outageId);
  if (!outage) return { ok: false, problems: ["unknown_outage"] };
  const problems: BackEntryProblem[] = [];
  if (outage.state === "cancelled") problems.push("outage_cancelled");
  if (outage.locationId !== input.locationId) problems.push("other_location");
  if (input.recordedAt.getTime() < outage.startedAt.getTime()) {
    problems.push("entered_before_outage");
  }
  if (!input.paperTime.ok) {
    problems.push(PAPER_TIME_PROBLEMS[input.paperTime.problem]);
    return { ok: false, problems };
  }
  const eventAt = input.paperTime.instant;
  const time = checkEntryTime(eventAt, input.recordedAt, rates);
  if (!time.ok) problems.push("future_entry");
  const end = outage.endedAt ?? input.recordedAt;
  const withinOutage =
    eventAt.getTime() >= outage.startedAt.getTime() && eventAt.getTime() <= end.getTime();
  const reason = hasText(input.reason, MIN_BACK_ENTRY_REASON_LENGTH)
    ? (input.reason as string).trim()
    : null;
  if (!withinOutage && reason === null) problems.push("outside_outage_window");
  if (problems.length > 0) return { ok: false, problems };
  const outsideReason = withinOutage ? null : reason;
  return {
    ok: true,
    eventAt,
    lateEntryReason: "downtime",
    lateEntry: time.ok && time.lateEntry,
    outageId: outage.id,
    withinOutage,
    outsideReason,
    paperReference: input.paperReference?.trim() ? input.paperReference.trim() : null,
    label: backEntryLabel({
      eventAt,
      recordedAt: input.recordedAt,
      receivedAt: input.receivedAt,
      outage,
      withinOutage,
      outsideReason,
    }),
  };
}

// ------------------------------------------------------------------------------------------------
// Entries through the normal care routes for a time inside an outage (rule 12)
// ------------------------------------------------------------------------------------------------

export interface CareEntryOutageInput {
  readonly locationId: string;
  readonly eventAt: Date;
  /** Device time when the entry was written. */
  readonly recordedAt: Date;
  /** True when the entry carries back-entry details (then `checkBackEntry` applies). */
  readonly hasBackEntryDetails: boolean;
  /** Why an entry for a time inside an outage is not copied from paper (for example from memory). */
  readonly notFromPaperReason: string | null;
}

export type CareEntryOutageCheck =
  | { readonly ok: true; readonly outageId: string | null }
  | {
      readonly ok: false;
      readonly problem: "back_entry_details_required";
      readonly outageId: string;
      readonly message: string;
    };

/**
 * Every care write checks its event time against the location's declared outages. Written at the
 * time on a device that kept working (offline), it is ordinary. Written later for a time inside an
 * outage, it must either be entered as a back-entry from paper or say why it is not from paper,
 * so a copied paper record never goes in without its label (HZ-017).
 */
export function checkEntryAgainstOutages(
  input: CareEntryOutageInput,
  outages: readonly OutageWindow[],
  rates: Pick<OperationsRates, "lateEntryHours">,
): CareEntryOutageCheck {
  const outage = outages.find(
    (o) =>
      o.locationId === input.locationId &&
      o.state !== "cancelled" &&
      input.eventAt.getTime() >= o.startedAt.getTime() &&
      input.eventAt.getTime() <= (o.endedAt ?? input.recordedAt).getTime(),
  );
  if (!outage) return { ok: true, outageId: null };
  const writtenAfterOutage =
    outage.endedAt !== null && input.recordedAt.getTime() > outage.endedAt.getTime();
  const contemporaneous =
    !writtenAfterOutage && !isLateEntry(input.eventAt, input.recordedAt, rates);
  if (
    contemporaneous ||
    input.hasBackEntryDetails ||
    hasText(input.notFromPaperReason, MIN_BACK_ENTRY_REASON_LENGTH)
  ) {
    return { ok: true, outageId: outage.id };
  }
  return {
    ok: false,
    problem: "back_entry_details_required",
    outageId: outage.id,
    message: `This time falls in the outage from ${formatUkDateTime(outage.startedAt)}. If you are copying a paper form, enter it as a back-entry; if not, say why it was not written on paper.`,
  };
}

// ------------------------------------------------------------------------------------------------
// Duplicates and reconciliation
// ------------------------------------------------------------------------------------------------

export interface OutageEntryRecord {
  readonly id: string;
  readonly locationId: string;
  readonly personId: string;
  /** The kind of record, for example `care_note` or `observation.fluid`. */
  readonly entryKind: string;
  readonly eventAt: Date;
  /** `back_entry`: entered from paper; `digital`: recorded on a device, including offline. */
  readonly source: "back_entry" | "digital";
  /** The outage a back-entry belongs to; null for digital entries. */
  readonly outageId: string | null;
  readonly paperReference: string | null;
  readonly withinOutage: boolean;
  /** Who entered it. */
  readonly enteredBy: string;
}

function canDuplicate(a: OutageEntryRecord, b: OutageEntryRecord, windowMs: number): boolean {
  if (a.personId !== b.personId || a.entryKind !== b.entryKind) return false;
  if (a.source === "digital" && b.source === "digital") return false;
  if (Math.abs(a.eventAt.getTime() - b.eventAt.getTime()) > windowMs) return false;
  const refA = a.paperReference?.trim().toLowerCase() || null;
  const refB = b.paperReference?.trim().toLowerCase() || null;
  // Two different paper forms are two records; anything else may be the same care twice.
  return !(a.source === "back_entry" && b.source === "back_entry" && refA && refB && refA !== refB);
}

/**
 * Groups of entries that may be the same care recorded twice: a paper form entered twice, or a
 * paper form entered for care a device also recorded (offline). Same person and kind, within
 * `downtime.duplicate_match_minutes` of each other; every group holds at least one back-entry.
 */
export function possibleDuplicateBackEntries(
  entries: readonly OutageEntryRecord[],
  rates: Pick<OperationsRates, "duplicateMatchMinutes">,
): readonly (readonly string[])[] {
  const windowMs = rates.duplicateMatchMinutes * MS_PER_MINUTE;
  const ordered = [...entries].sort(
    (a, b) => a.eventAt.getTime() - b.eventAt.getTime() || a.id.localeCompare(b.id),
  );
  const parent = ordered.map((_, i) => i);
  const root = (i: number): number => {
    let r = i;
    while (parent[r] !== r) r = parent[r] as number;
    return r;
  };
  for (let i = 0; i < ordered.length; i += 1) {
    for (let j = i + 1; j < ordered.length; j += 1) {
      const a = ordered[i] as OutageEntryRecord;
      const b = ordered[j] as OutageEntryRecord;
      if (b.eventAt.getTime() - a.eventAt.getTime() > windowMs) break;
      if (canDuplicate(a, b, windowMs)) parent[root(j)] = root(i);
    }
  }
  const groups = new Map<number, string[]>();
  ordered.forEach((entry, i) => {
    const r = root(i);
    const group = groups.get(r);
    if (group) group.push(entry.id);
    else groups.set(r, [entry.id]);
  });
  return [...groups.values()].filter((g) => g.length > 1);
}

export type OutageReconciliationProblem =
  | "not_closed"
  | "statement_required"
  | "duplicates_unreviewed"
  | "reconciler_entered_records";

export const OUTAGE_RECONCILIATION_MESSAGES: Readonly<Record<OutageReconciliationProblem, string>> =
  {
    not_closed: "Close the outage before confirming that the paper records are entered.",
    statement_required: "Say what was checked, for example 'All 14 forms entered and checked'.",
    duplicates_unreviewed: "Some care may have been recorded twice. Review those records first.",
    reconciler_entered_records:
      "Someone who did not enter the paper records must check them and confirm the outage.",
  };

export interface OutageReconciliationSummary {
  readonly backEntries: number;
  /** Distinct paper form references entered. */
  readonly formsEntered: number;
  /** Back-entries whose form had no reference (each counted on its own). */
  readonly entriesWithoutReference: number;
  readonly outsideWindow: number;
  readonly people: number;
  /** Digital entries recorded on devices for times inside the outage. */
  readonly digitalEntriesInWindow: number;
  readonly duplicateGroups: readonly (readonly string[])[];
}

export type OutageReconciliationCheck =
  | { readonly ok: true; readonly summary: OutageReconciliationSummary }
  | {
      readonly ok: false;
      readonly problems: readonly OutageReconciliationProblem[];
      readonly summary: OutageReconciliationSummary;
    };

/**
 * Confirming every paper form from an outage has been entered (rule 14). `entries` holds the
 * outage's back-entries and the location's digital entries; those near the outage are compared.
 * Each possible duplicate is reviewed (kept, or one of them corrected by supersession) first, and
 * the confirmation comes from someone who entered none of the paper records.
 */
export function checkOutageReconciliation(
  outage: Pick<OutageWindow, "id" | "state" | "locationId" | "startedAt" | "endedAt">,
  entries: readonly OutageEntryRecord[],
  confirmation: {
    readonly by: string;
    readonly statement: string | null;
    readonly reviewedEntryIds: readonly string[];
  },
  rates: Pick<OperationsRates, "duplicateMatchMinutes">,
): OutageReconciliationCheck {
  const windowMs = rates.duplicateMatchMinutes * MS_PER_MINUTE;
  const from = outage.startedAt.getTime() - windowMs;
  const to =
    outage.endedAt === null ? Number.POSITIVE_INFINITY : outage.endedAt.getTime() + windowMs;
  const backEntries = entries.filter((e) => e.source === "back_entry" && e.outageId === outage.id);
  const digital = entries.filter(
    (e) =>
      e.source === "digital" &&
      e.locationId === outage.locationId &&
      e.eventAt.getTime() >= from &&
      e.eventAt.getTime() <= to,
  );
  const duplicateGroups = possibleDuplicateBackEntries([...backEntries, ...digital], rates);
  const references = backEntries
    .map((e) => e.paperReference?.trim().toLowerCase() || null)
    .filter((r): r is string => r !== null);
  const summary: OutageReconciliationSummary = {
    backEntries: backEntries.length,
    formsEntered: new Set(references).size,
    entriesWithoutReference: backEntries.length - references.length,
    outsideWindow: backEntries.filter((e) => !e.withinOutage).length,
    people: new Set(backEntries.map((e) => e.personId)).size,
    digitalEntriesInWindow: digital.filter(
      (e) =>
        e.eventAt.getTime() >= outage.startedAt.getTime() &&
        (outage.endedAt === null || e.eventAt.getTime() <= outage.endedAt.getTime()),
    ).length,
    duplicateGroups,
  };
  const problems: OutageReconciliationProblem[] = [];
  if (outage.state !== "closed") problems.push("not_closed");
  if (!hasText(confirmation.statement, MIN_RECONCILIATION_STATEMENT_LENGTH)) {
    problems.push("statement_required");
  }
  const reviewed = new Set(confirmation.reviewedEntryIds);
  if (duplicateGroups.some((group) => group.some((id) => !reviewed.has(id)))) {
    problems.push("duplicates_unreviewed");
  }
  if (backEntries.some((e) => e.enteredBy === confirmation.by)) {
    problems.push("reconciler_entered_records");
  }
  return problems.length === 0 ? { ok: true, summary } : { ok: false, problems, summary };
}
