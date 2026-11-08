/**
 * Destruction batches in propose mode (retention sweeps plan 5.4 and 5.5, slice 6; ADR-0135):
 * which records the nightly sweep proposes for destruction, and how they are grouped. A batch is
 * only a proposal: nothing here, or in slice 6, soft-deletes or destroys a record. A person
 * approves a batch in slice 9.
 *
 * Pure: the API reads each table's rows with the facts below and these functions decide each row
 * with the report's rules (`groupDecision`), so a proposal never disagrees with the report.
 */

import type { RetentionTableEntry, SubjectKind } from "./retention-registry";
import {
  groupDecision,
  groupFacts,
  type ReportGroup,
  type ReportPlan,
  reportPlan,
} from "./retention-report";
import { type ResolvedRule, type SweepRules, triggerDate } from "./retention-sweep";

export const BATCH_STATUSES = ["proposed", "cancelled"] as const;
export type BatchStatus = (typeof BATCH_STATUSES)[number];

/** Why a reviewer cancelled a batch: a code, never free text, so no personal data is kept. */
export const BATCH_CANCEL_REASONS = [
  "records_still_needed",
  "rule_under_review",
  "proposed_in_error",
  "other",
] as const;
export type BatchCancelReason = (typeof BATCH_CANCEL_REASONS)[number];

/** The subject an item names, for the holds re-checked at approval (slice 9). */
export type ItemSubjectKind = Exclude<SubjectKind, "staff">;

/** Why a registry table's records are never proposed in this slice. */
export const PROPOSAL_SKIP_REASONS = [
  /** The report does not decide it (never offered or not evaluated; H-1613). */
  "not_decided",
  /** About a member of staff: employee relations cases cannot be checked yet (H-1612). */
  "staff_subject",
  /** The subject is found only through the parent, so open cases cannot be checked (H-1612). */
  "subject_through_parent",
] as const;
export type ProposalSkipReason = (typeof PROPOSAL_SKIP_REASONS)[number];

export type ProposalPlan =
  | { readonly kind: "skip"; readonly reason: ProposalSkipReason }
  | {
      readonly kind: "propose";
      readonly read: Extract<ReportPlan, { kind: "read" }>;
      readonly subjectKind: ItemSubjectKind;
      /** The column naming the subject (one id or a list), or null for `none`. */
      readonly subjectColumn: string | null;
      /** Every column naming a person the record is about, for open cases about them. */
      readonly personColumns: readonly string[];
    };

/**
 * Whether a registry table's records may be proposed, and how its subject is read. Only tables the
 * report decides; never one whose record is about a member of staff, or whose subject cannot be
 * read from the row (provisional, H-1621, until slice 12 reads the open cases of H-1586).
 */
export function proposalPlan(entry: RetentionTableEntry): ProposalPlan {
  const read = reportPlan(entry);
  if (read.kind === "skip") return { kind: "skip", reason: "not_decided" };
  const subjects = [entry.subject, ...(entry.otherSubjects ?? [])];
  if (subjects.some((s) => s.kind === "staff")) return { kind: "skip", reason: "staff_subject" };
  if (subjects.some((s) => s.kind !== "none" && s.column === null)) {
    return { kind: "skip", reason: "subject_through_parent" };
  }
  const subjectKind = entry.subject.kind as ItemSubjectKind;
  return {
    kind: "propose",
    read,
    subjectKind,
    subjectColumn: entry.subject.column,
    personColumns: subjects
      .filter((s) => s.kind === "person" && s.column !== null)
      .map((s) => s.column as string),
  };
}

/** One row as the propose query returns it: the report's facts, the id, its subject and cases. */
export interface ProposalRow extends ReportGroup {
  readonly id: string;
  /** An open DSAR case, complaint or safeguarding concern about a person the record names. */
  readonly openCase: boolean;
  readonly subjectIds: readonly string[];
}

/** A record the sweep proposes, as one `destruction_batch_item`. */
export interface BatchCandidate {
  readonly table: string;
  readonly recordId: string;
  /** The class whose rule set the due date (the longest, retention.md). */
  readonly recordClass: string;
  readonly rule: ResolvedRule;
  readonly triggerOn: Date | null;
  readonly dueOn: Date;
  readonly subjectKind: ItemSubjectKind;
  readonly subjectIds: readonly string[];
}

export type ProposalOutcome =
  | { readonly kind: "propose"; readonly candidate: BatchCandidate }
  | {
      readonly kind: "skip";
      readonly reason: "held" | "open_case" | "retain" | "no_trigger_yet" | "tenant_policy";
    };

/**
 * Whether one record is proposed at `now`: a hold wins, then an open case about the person (as a
 * hold, until slice 12), then `sweepDecision`; only `due` is proposed, with its rule and dates.
 */
export function proposalOutcome(
  table: string,
  plan: Extract<ProposalPlan, { kind: "propose" }>,
  row: ProposalRow,
  rules: SweepRules,
  now: Date,
): ProposalOutcome {
  if (row.held) return { kind: "skip", reason: "held" };
  if (row.openCase) return { kind: "skip", reason: "open_case" };
  const decision = groupDecision(plan.read, row, rules, now);
  if (decision.status !== "due") {
    return { kind: "skip", reason: decision.status === "held" ? "held" : decision.status };
  }
  return {
    kind: "propose",
    candidate: {
      table,
      recordId: row.id,
      recordClass: decision.rule.recordClass,
      rule: decision.rule,
      triggerOn: triggerDate(decision.rule.trigger, groupFacts(plan.read, row)),
      dueOn: decision.since,
      subjectKind: plan.subjectKind,
      subjectIds: plan.subjectKind === "none" ? [] : row.subjectIds,
    },
  };
}

/** The key of a record across tables, for "already in a proposed batch". */
export const recordKey = (table: string, recordId: string) => `${table}\u0000${recordId}`;

export interface ProposedBatch {
  readonly recordClass: string;
  readonly rule: ResolvedRule;
  readonly items: readonly BatchCandidate[];
}

export interface BatchLimits {
  /** `retention.batch.max_records` from the rate table. */
  readonly maxRecords: number;
  /** Classes that already have a proposed batch: none is proposed for them until it is decided. */
  readonly openClasses: ReadonlySet<string>;
  /** Records already in a proposed batch (`recordKey`). */
  readonly inOpenBatch: ReadonlySet<string>;
}

const byDueThenRecord = (a: BatchCandidate, b: BatchCandidate) =>
  a.dueOn.getTime() - b.dueOn.getTime() ||
  a.table.localeCompare(b.table) ||
  a.recordId.localeCompare(b.recordId);

/**
 * One batch per class, oldest due first, at most `maxRecords` items each; a class with a proposed
 * batch, and a record already in one, are left out. A limit that is not a whole number above
 * zero proposes nothing (the rate table row is wrong, so doubt keeps the records).
 */
export function planBatches(
  candidates: readonly BatchCandidate[],
  limits: BatchLimits,
): ProposedBatch[] {
  if (!Number.isInteger(limits.maxRecords) || limits.maxRecords < 1) return [];
  const byClass = new Map<string, BatchCandidate[]>();
  for (const c of candidates) {
    if (limits.openClasses.has(c.recordClass)) continue;
    if (limits.inOpenBatch.has(recordKey(c.table, c.recordId))) continue;
    byClass.set(c.recordClass, [...(byClass.get(c.recordClass) ?? []), c]);
  }
  return [...byClass.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([recordClass, items]) => {
      const sorted = [...items].sort(byDueThenRecord).slice(0, limits.maxRecords);
      return { recordClass, rule: sorted[0]?.rule as ResolvedRule, items: sorted };
    });
}

/** Items per table, for the audit event and the list: counts only, never an id. */
export function countsByTable(items: readonly BatchCandidate[]): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const item of items) counts[item.table] = (counts[item.table] ?? 0) + 1;
  return counts;
}

/** Why a batch cannot be cancelled now, or null when it can. */
export function cancelProblem(
  batch: { readonly status: string; readonly version: number },
  expectedVersion: number,
): "not_proposed" | "version_conflict" | null {
  if (batch.status !== "proposed") return "not_proposed";
  if (batch.version !== expectedVersion) return "version_conflict";
  return null;
}
