import { checkEntryTime } from "../care/entries";
import { defineWorkflow } from "../platform/workflow";
import { formatUkDateTime } from "../shared/time";
import type { OperationsRates } from "./rates";

/**
 * Outages and back-entry (master prompt 13.4: "downtime forms and a back-entry workflow";
 * operations.md section 4 rules 5 to 9; hazards HZ-017 and HZ-021).
 *
 * The nurse or senior in charge declares an outage for a location (it can be declared after it
 * began, even after it ended) and closes it when systems return. Care given on paper during the
 * outage is entered later: the entry keeps the time written on paper as its event time, carries
 * the late-entry reason "downtime" and the outage it belongs to, and is refused when that time is
 * outside the outage unless a reason is given. A manager then reconciles the outage, after
 * reviewing any possible duplicates, to confirm every paper form was entered.
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

// ------------------------------------------------------------------------------------------------
// Declaring and closing an outage
// ------------------------------------------------------------------------------------------------

export interface OutageDeclaration {
  readonly locationId: string;
  readonly kind: OutageKind;
  readonly startedAt: Date;
  /** Server time of the declaration. */
  readonly declaredAt: Date;
  readonly description: string | null;
}

export type OutageDeclarationProblem =
  | "start_in_future"
  | "description_required"
  | "already_open"
  | "overlaps_earlier_outage";

export const OUTAGE_DECLARATION_MESSAGES: Readonly<Record<OutageDeclarationProblem, string>> = {
  start_in_future: "The outage cannot start in the future. Check the time and the device clock.",
  description_required: "Say what has failed, for example 'Power cut, whole building'.",
  already_open: "An outage is already open for this location. Use that one.",
  overlaps_earlier_outage:
    "This time overlaps an earlier outage at this location. Check the times, or use that outage.",
};

export type OutageDeclarationCheck =
  | {
      readonly ok: true;
      /** Declared more than the late-entry threshold after it began: shown on the outage. */
      readonly declaredLate: boolean;
    }
  | { readonly ok: false; readonly problems: readonly OutageDeclarationProblem[] };

/** Checks a new outage against the location's other outages (cancelled ones are ignored). */
export function checkOutageDeclaration(
  declaration: OutageDeclaration,
  existing: readonly OutageWindow[],
  rates: Pick<OperationsRates, "lateEntryHours" | "clockDriftMinutes">,
): OutageDeclarationCheck {
  const problems: OutageDeclarationProblem[] = [];
  const start = declaration.startedAt.getTime();
  if (start - declaration.declaredAt.getTime() > rates.clockDriftMinutes * MS_PER_MINUTE) {
    problems.push("start_in_future");
  }
  if (!hasText(declaration.description, MIN_OUTAGE_DESCRIPTION_LENGTH)) {
    problems.push("description_required");
  }
  const others = existing.filter(
    (o) => o.locationId === declaration.locationId && o.state !== "cancelled",
  );
  if (others.some((o) => o.state === "declared")) problems.push("already_open");
  else if (others.some((o) => o.endedAt !== null && o.endedAt.getTime() > start)) {
    problems.push("overlaps_earlier_outage");
  }
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
// Back-entry
// ------------------------------------------------------------------------------------------------

export interface BackEntryInput {
  readonly personId: string;
  /** The person's location when the care was given. */
  readonly locationId: string;
  /** The time written on the paper form: stored as the entry's event time. */
  readonly eventAt: Date;
  /** When it was typed into Harbour (device time; the server time for the web). */
  readonly recordedAt: Date;
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
  | "future_entry"
  | "entered_before_outage"
  | "outside_outage_window";

export const BACK_ENTRY_MESSAGES: Readonly<Record<BackEntryProblem, string>> = {
  outage_required:
    "Choose the outage this paper record belongs to. If none was declared, declare it first: it can be declared after it ended.",
  unknown_outage: "That outage was not found.",
  outage_cancelled: "That outage was cancelled. Choose the right one.",
  other_location: "That outage was at a different location.",
  future_entry: "The time on the paper is in the future. Check the time and the device clock.",
  entered_before_outage: "A record cannot be entered from paper before the outage began.",
  outside_outage_window:
    "The time on the paper is outside the outage. Check the time, or say why it was written on paper.",
};

export interface BackEntryAccepted {
  readonly ok: true;
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

/** The words shown with a back-entered record. */
export function backEntryLabel(entry: {
  readonly eventAt: Date;
  readonly recordedAt: Date;
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
  return `${written} ${context}. Entered in Harbour ${formatUkDateTime(entry.recordedAt)}.`;
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
  const time = checkEntryTime(input.eventAt, input.recordedAt, rates);
  if (!time.ok) problems.push("future_entry");
  if (input.recordedAt.getTime() < outage.startedAt.getTime()) {
    problems.push("entered_before_outage");
  }
  const end = outage.endedAt ?? input.recordedAt;
  const withinOutage =
    input.eventAt.getTime() >= outage.startedAt.getTime() &&
    input.eventAt.getTime() <= end.getTime();
  const reason = hasText(input.reason, MIN_BACK_ENTRY_REASON_LENGTH)
    ? (input.reason as string).trim()
    : null;
  if (!withinOutage && reason === null) problems.push("outside_outage_window");
  if (problems.length > 0) return { ok: false, problems };
  const outsideReason = withinOutage ? null : reason;
  return {
    ok: true,
    lateEntryReason: "downtime",
    lateEntry: time.ok && time.lateEntry,
    outageId: outage.id,
    withinOutage,
    outsideReason,
    paperReference: input.paperReference?.trim() ? input.paperReference.trim() : null,
    label: backEntryLabel({
      eventAt: input.eventAt,
      recordedAt: input.recordedAt,
      outage,
      withinOutage,
      outsideReason,
    }),
  };
}

// ------------------------------------------------------------------------------------------------
// Duplicates and reconciliation
// ------------------------------------------------------------------------------------------------

export interface BackEntryRecord {
  readonly id: string;
  readonly outageId: string;
  readonly personId: string;
  /** The kind of record, for example `care_note` or `observation.fluid`. */
  readonly entryKind: string;
  readonly eventAt: Date;
  readonly paperReference: string | null;
  readonly withinOutage: boolean;
}

/**
 * Groups of back-entries that may be the same paper record entered twice: same person, kind and
 * minute, where the form references do not show them to be different forms.
 */
export function possibleDuplicateBackEntries(
  entries: readonly BackEntryRecord[],
): readonly (readonly string[])[] {
  const groups = new Map<string, BackEntryRecord[]>();
  for (const entry of entries) {
    const minute = Math.floor(entry.eventAt.getTime() / MS_PER_MINUTE);
    const key = `${entry.personId}|${entry.entryKind}|${minute}`;
    const group = groups.get(key);
    if (group) group.push(entry);
    else groups.set(key, [entry]);
  }
  const flagged: string[][] = [];
  for (const group of groups.values()) {
    if (group.length < 2) continue;
    const references = group.map((e) => e.paperReference?.trim().toLowerCase() || null);
    const named = references.filter((r): r is string => r !== null);
    const repeatsReference = new Set(named).size < named.length;
    const hasUnnamed = named.length < references.length;
    if (repeatsReference || hasUnnamed) flagged.push(group.map((e) => e.id));
  }
  return flagged;
}

export type OutageReconciliationProblem =
  | "not_closed"
  | "statement_required"
  | "duplicates_unreviewed";

export const OUTAGE_RECONCILIATION_MESSAGES: Readonly<Record<OutageReconciliationProblem, string>> =
  {
    not_closed: "Close the outage before confirming that the paper records are entered.",
    statement_required: "Say what was checked, for example 'All 14 forms entered and checked'.",
    duplicates_unreviewed: "Some records may have been entered twice. Review them first.",
  };

export interface OutageReconciliationSummary {
  readonly backEntries: number;
  readonly outsideWindow: number;
  readonly people: number;
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
 * Confirming every paper form from an outage has been entered. Possible duplicates must each be
 * reviewed (kept, or one of them corrected by supersession) before the outage is reconciled.
 */
export function checkOutageReconciliation(
  outage: Pick<OutageWindow, "id" | "state">,
  entries: readonly BackEntryRecord[],
  confirmation: { readonly statement: string | null; readonly reviewedEntryIds: readonly string[] },
): OutageReconciliationCheck {
  const own = entries.filter((e) => e.outageId === outage.id);
  const duplicateGroups = possibleDuplicateBackEntries(own);
  const summary: OutageReconciliationSummary = {
    backEntries: own.length,
    outsideWindow: own.filter((e) => !e.withinOutage).length,
    people: new Set(own.map((e) => e.personId)).size,
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
  return problems.length === 0 ? { ok: true, summary } : { ok: false, problems, summary };
}
