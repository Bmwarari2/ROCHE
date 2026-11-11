/**
 * The retention report (retention sweeps plan, sections 5.4 report mode and 5.9; ADR-0135): for
 * each table in the retention registry, how many records are due for destruction, held, kept
 * until a later date, waiting for their trigger, kept by the organisation's own policy, never
 * offered (configuration, proof, or removed by another sweep) or not yet evaluated. Counts only:
 * no record id, subject or date leaves the database in a report.
 *
 * Pure: the API reads each table once, grouping rows by the facts below, and these functions
 * decide each group with `sweepDecision` and add up the counts. Nothing here destroys anything.
 */

import type { DateSource, RetentionTableEntry, TriggerSources } from "./retention-registry";
import { PERIOD_END_CLASSES } from "./retention-registry";
import {
  type SweepDecision,
  type SweepRules,
  sweepDecision,
  type TriggerFacts,
} from "./retention-sweep";

export const REPORT_STATUSES = [
  "due",
  "held",
  "retain",
  "no_trigger_yet",
  "tenant_policy",
  "never_offered",
  "not_evaluated",
] as const;
export type ReportStatus = (typeof REPORT_STATUSES)[number];
export type ReportCounts = Record<ReportStatus, number>;

/** The modes of plan 5.4 built so far: `destroy` comes with slice 10. */
export const RETENTION_SWEEP_MODES = ["off", "report", "propose"] as const;
export type RetentionSweepMode = (typeof RETENTION_SWEEP_MODES)[number];

/**
 * The organisation's mode from its two flags, one step at a time: report on gives `report`, report
 * and propose on give `propose`; propose on without report gives `off`, never a skipped step.
 */
export function sweepModeOf(flags: {
  readonly report: boolean;
  readonly propose: boolean;
}): RetentionSweepMode {
  if (!flags.report) return "off";
  return flags.propose ? "propose" : "report";
}

/** The date sources the report reads in the same query as the row (one level of lookup). */
export type ReadableSource = Extract<
  DateSource,
  {
    from: "column" | "first_of" | "person_care_ended" | "staff_leaving" | "lookup" | "latest_child";
  }
>;

const READABLE: ReadonlySet<DateSource["from"]> = new Set([
  "column",
  "first_of",
  "person_care_ended",
  "staff_leaving",
  "lookup",
  "latest_child",
]);

/** Why a table's rows are counted but not decided, as a code. */
export const SKIP_REASONS = [
  "kept_while_current",
  "kept_permanently",
  "removed_by_other_sweep",
  "follows_parent",
  "follows_linked_record",
  "class_by_value",
  "date_not_readable_yet",
  "outside_tenant_tables",
  "not_readable",
] as const;
export type SkipReason = (typeof SKIP_REASONS)[number];

export type ReportPlan =
  | {
      readonly kind: "skip";
      readonly status: "never_offered" | "not_evaluated";
      readonly reason: SkipReason;
    }
  | {
      readonly kind: "read";
      /** The row's own class column, or null when the entry's classes are fixed. */
      readonly classColumn: string | null;
      /** The fixed classes (empty when read from the row). */
      readonly classes: readonly string[];
      readonly facts: Partial<Record<keyof TriggerSources, ReadableSource>>;
      /** The column naming the person, for a legal hold on them. */
      readonly personColumn: string | null;
    };

const skip = (
  status: "never_offered" | "not_evaluated",
  reason: SkipReason,
): Extract<ReportPlan, { kind: "skip" }> => ({ kind: "skip", status, reason });

/**
 * How the report reads a registry entry. Tables outside `public`, rows that take their class or
 * dates from a parent, a linked record or another table's value, and dates worked out by a rule
 * are counted as `not_evaluated` with the reason, until later slices read them; configuration,
 * proof and rows another sweep removes are `never_offered`.
 */
export function reportPlan(entry: RetentionTableEntry): ReportPlan {
  if (entry.table.includes(".")) return skip("not_evaluated", "outside_tenant_tables");
  const r = entry.retention;
  switch (r.kind) {
    case "while_current":
      return skip("never_offered", "kept_while_current");
    case "permanent":
      return skip("never_offered", "kept_permanently");
    case "not_retained":
      return skip("never_offered", "removed_by_other_sweep");
    case "as_parent":
      return skip("not_evaluated", "follows_parent");
    case "as_linked":
      return skip("not_evaluated", "follows_linked_record");
    case "by_value":
      return skip("not_evaluated", "class_by_value");
    case "classes":
    case "row_class":
      break;
  }
  const facts: Partial<Record<keyof TriggerSources, ReadableSource>> = {};
  for (const [fact, source] of Object.entries(entry.facts) as [
    keyof TriggerSources,
    DateSource,
  ][]) {
    if (!READABLE.has(source.from)) return skip("not_evaluated", "date_not_readable_yet");
    facts[fact] = source as ReadableSource;
  }
  const subjects = [entry.subject, ...(entry.otherSubjects ?? [])];
  const personColumn = subjects.find((s) => s.kind === "person" && s.column)?.column ?? null;
  return r.kind === "row_class"
    ? { kind: "read", classColumn: r.column, classes: [], facts, personColumn }
    : { kind: "read", classColumn: null, classes: r.classes, facts, personColumn };
}

/** One group of rows that share every fact the decision reads, as the query returns it. */
export interface ReportGroup {
  /** The row's class, where the plan reads it from the row. */
  readonly recordClass: string | null;
  /** Under an unreleased legal hold on the record or the person. */
  readonly held: boolean;
  /** The person is receiving care now (care_ended). */
  readonly receivingCare: boolean;
  /** Death, else discharge (care_ended). */
  readonly careEnded: Date | null;
  readonly entryDate: Date | null;
  readonly closedAt: Date | null;
  readonly employmentEndedAt: Date | null;
  readonly dateOfBirth: Date | null;
  readonly createdAt: Date | null;
  readonly periodEndsAt: Date | null;
  readonly count: number;
}

/** The classes a group's rows belong to under a read plan. */
export function groupClasses(
  plan: Extract<ReportPlan, { kind: "read" }>,
  group: ReportGroup,
): readonly string[] {
  if (plan.classColumn === null) return plan.classes;
  return group.recordClass ? [group.recordClass] : [];
}

/**
 * The status of a group at `now`: `held` first (a hold always wins), then `sweepDecision`. The
 * hold is found by the query (`isUnderLegalHold`: on the record or the person); the scopes and
 * implicit holds of plan slice 12 are not yet read.
 */
export function groupStatus(
  plan: Extract<ReportPlan, { kind: "read" }>,
  group: ReportGroup,
  rules: SweepRules,
  now: Date,
): ReportStatus {
  if (group.held) return "held";
  return groupDecision(plan, group, rules, now).status;
}

/** The trigger facts of a group, as `sweepDecision` reads them. */
export function groupFacts(
  plan: Extract<ReportPlan, { kind: "read" }>,
  group: ReportGroup,
): TriggerFacts {
  const recordClasses = groupClasses(plan, group);
  return {
    diedAt: group.careEnded,
    receivingCare: group.receivingCare,
    entryDates: group.entryDate ? [group.entryDate] : [],
    closedAt: group.closedAt,
    employmentEndedAt: group.employmentEndedAt,
    createdAt: group.createdAt,
    periodEndsAt: group.periodEndsAt,
    countsFromPeriodEnd: recordClasses.some((c) => PERIOD_END_CLASSES.includes(c)),
  };
}

/**
 * `sweepDecision` for a group, its hold left to the caller (the query found it). The decision
 * carries the rule and, when due, the date it fell due.
 */
export function groupDecision(
  plan: Extract<ReportPlan, { kind: "read" }>,
  group: ReportGroup,
  rules: SweepRules,
  now: Date,
): SweepDecision {
  return sweepDecision(
    {
      subjectType: "report",
      subjectId: "report",
      recordClasses: groupClasses(plan, group),
      facts: groupFacts(plan, group),
      dateOfBirth: group.dateOfBirth,
    },
    rules,
    { legalHolds: [], openCases: [] },
    now,
  );
}

/** One line of the report: a table and a class, with its counts. */
export interface ReportLine {
  readonly table: string;
  /** The classes, comma separated; null for a table counted without deciding. */
  readonly recordClass: string | null;
  readonly reason: SkipReason | null;
  readonly counts: ReportCounts;
}

export function emptyCounts(): ReportCounts {
  return Object.fromEntries(REPORT_STATUSES.map((s) => [s, 0])) as ReportCounts;
}

/** Adds `count` records of `status` to the table and class's line. */
export function tally(
  lines: Map<string, ReportLine>,
  table: string,
  recordClass: string | null,
  reason: SkipReason | null,
  status: ReportStatus,
  count: number,
): void {
  const key = `${table}\u0000${recordClass ?? ""}`;
  let line = lines.get(key);
  if (!line) {
    line = { table, recordClass, reason, counts: emptyCounts() };
    lines.set(key, line);
  }
  line.counts[status] += count;
}

/** Every status added up over the lines. */
export function reportTotals(lines: Iterable<ReportLine>): ReportCounts {
  const totals = emptyCounts();
  for (const line of lines) for (const s of REPORT_STATUSES) totals[s] += line.counts[s];
  return totals;
}

/** Counts per class (lines without a class left out), for the audit event. */
export function countsByClass(lines: Iterable<ReportLine>): Record<string, ReportCounts> {
  const byClass: Record<string, ReportCounts> = {};
  for (const line of lines) {
    if (line.recordClass === null) continue;
    const counts = byClass[line.recordClass] ?? emptyCounts();
    byClass[line.recordClass] = counts;
    for (const s of REPORT_STATUSES) counts[s] += line.counts[s];
  }
  return byClass;
}
