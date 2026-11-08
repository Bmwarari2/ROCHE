import type { RetentionDue, RetentionReportCounts, RetentionReportLine } from "@harbour/contracts";
import type { Translator } from "@harbour/i18n";

/**
 * The retention report on `/settings/retention` (retention sweeps plan slice 5; 5.4 report mode and
 * 5.9): the counts of the latest nightly report, per kind of record. Pure and unit tested. The
 * report counts only: nothing on this screen destroys or changes a record.
 */

export type DueView =
  | { readonly kind: "off" }
  | { readonly kind: "waiting" }
  | { readonly kind: "report"; readonly report: NonNullable<RetentionDue["report"]> };

/** Off says so (even if a report from an earlier run is kept); on, the latest report or none yet. */
export function dueView(due: RetentionDue): DueView {
  if (due.mode === "off") return { kind: "off" };
  return due.report ? { kind: "report", report: due.report } : { kind: "waiting" };
}

/** The columns the screen shows: the report's seven counts, folded into five plus a total. */
export const DUE_COLUMNS = [
  "due",
  "held",
  "notYetDue",
  "neverOffered",
  "notEvaluated",
  "total",
] as const;
export type DueColumn = (typeof DUE_COLUMNS)[number];
export type DueCounts = Readonly<Record<DueColumn, number>>;

/**
 * `retain` and `no_trigger_yet` are both not yet due; `tenant_policy` (no period set by the
 * organisation) and `never_offered` (kept while current, permanently, or removed by another sweep)
 * are both never offered for destruction.
 */
export function dueCounts(c: RetentionReportCounts): DueCounts {
  const counts = {
    due: c.due,
    held: c.held,
    notYetDue: c.retain + c.no_trigger_yet,
    neverOffered: c.tenant_policy + c.never_offered,
    notEvaluated: c.not_evaluated,
  };
  return {
    ...counts,
    total: counts.due + counts.held + counts.notYetDue + counts.neverOffered + counts.notEvaluated,
  };
}

export interface DueRow {
  /** The classes, comma separated as the report has them, or null for tables not read by class. */
  readonly recordClass: string | null;
  readonly counts: DueCounts;
}

/**
 * One row per kind of record (the report's lines added up across tables), most due first, then by
 * class; the tables counted without reading their class come last, in one row.
 */
export function dueRows(lines: readonly RetentionReportLine[]): DueRow[] {
  const byClass = new Map<string | null, RetentionReportCounts>();
  for (const line of lines) {
    const sum = byClass.get(line.recordClass);
    if (!sum) {
      byClass.set(line.recordClass, { ...line.counts });
      continue;
    }
    for (const key of Object.keys(sum) as (keyof RetentionReportCounts)[]) {
      sum[key] += line.counts[key];
    }
  }
  return [...byClass]
    .map(([recordClass, counts]) => ({ recordClass, counts: dueCounts(counts) }))
    .sort((a, b) => {
      if (a.recordClass === null) return 1;
      if (b.recordClass === null) return -1;
      return b.counts.due - a.counts.due || a.recordClass.localeCompare(b.recordClass, "en-GB");
    });
}

/** A kind of record in words: each class named, or its code where the catalogue has no name. */
export function classWords(recordClass: string | null, t: Translator): string {
  if (recordClass === null) return t("retention.due.notReadByClass");
  return recordClass
    .split(",")
    .map((code) => t("retention.due.class", { recordClass: code.replaceAll(".", "_"), code }))
    .join(t("retention.due.classJoin"));
}
