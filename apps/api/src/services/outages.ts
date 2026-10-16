import type { OutageItem } from "@harbour/contracts";
import {
  activityRecord,
  bodyMapMark,
  careNote,
  observation,
  outage,
  type Transaction,
  task,
  visitLog,
} from "@harbour/db";
import type { OperationsRates, OutageEntryRecord, OutageKind, OutageWindow } from "@harbour/domain";
import { and, desc, eq, gte, inArray, lte, or, sql } from "drizzle-orm";
import { withTenantWideScope } from "./safety";

/**
 * Outages through the API (operations.md rules 9 to 15; HZ-017): the row as the screens see it,
 * the window the domain rules read, the entries near an outage for its reconciliation, who entered
 * its paper records, and the back-entry task raised when it closes.
 */

export type OutageRow = typeof outage.$inferSelect;

/** The task asking for an outage's paper records to be entered, raised when it closes. */
export const OUTAGE_BACK_ENTRY_TASK = "operations.outage_back_entry";

const iso = (d: Date | null) => (d ? d.toISOString() : null);

export function outageItem(row: OutageRow): OutageItem {
  return {
    id: row.id,
    locationId: row.locationId,
    kind: row.kind as OutageItem["kind"],
    description: row.description,
    state: row.state as OutageItem["state"],
    startedAt: row.startedAt.toISOString(),
    endedAt: iso(row.endedAt),
    declaredAt: row.declaredAt.toISOString(),
    declaredBy: row.declaredBy,
    declaredLate: row.declaredLate,
    closedAt: iso(row.closedAt),
    closedBy: row.closedBy,
    backEntryDueAt: iso(row.backEntryDueAt),
    reconciledAt: iso(row.reconciledAt),
    reconciledBy: row.reconciledBy,
    reconciliationStatement: row.reconciliationStatement,
    formsEntered: row.formsEntered,
    cancelledAt: iso(row.cancelledAt),
    cancelledBy: row.cancelledBy,
    cancellationReason: row.cancellationReason,
    correctionReason: row.correctionReason,
    version: row.version,
  };
}

export function outageWindow(row: OutageRow): OutageWindow {
  return {
    id: row.id,
    locationId: row.locationId,
    kind: row.kind as OutageKind,
    state: row.state as OutageWindow["state"],
    startedAt: row.startedAt,
    endedAt: row.endedAt,
    declaredAt: row.declaredAt,
    declaredBy: row.declaredBy,
  };
}

/** The location's outages the caller can see, newest first. */
export function outagesAt(tx: Transaction, locationId: string): Promise<OutageRow[]> {
  return tx
    .select()
    .from(outage)
    .where(eq(outage.locationId, locationId))
    .orderBy(desc(outage.startedAt));
}

/** Whether an instant is inside the outage window `[start, end)` (an open outage runs on). */
export function inOutageWindow(row: Pick<OutageRow, "startedAt" | "endedAt">, at: Date): boolean {
  return (
    at.getTime() >= row.startedAt.getTime() &&
    (row.endedAt === null || at.getTime() < row.endedAt.getTime())
  );
}

/**
 * Whether the outage would run longer than `downtime.max_outage_hours` from its start to its end,
 * or to now while open, so a mistyped date cannot open a window of months (#51 review round 1).
 */
export function outageTooLong(
  startedAt: Date,
  endedAt: Date | null,
  now: Date,
  rates: Pick<OperationsRates, "maxOutageHours">,
): boolean {
  return (endedAt ?? now).getTime() - startedAt.getTime() > rates.maxOutageHours * 3_600_000;
}

const ENTRY_TABLES = [
  ["care_note", careNote],
  ["observation", observation],
  ["body_map_mark", bodyMapMark],
  ["activity_record", activityRecord],
  ["visit_log", visitLog],
] as const;

export interface OutageEntries {
  /** Current versions only: the outage's back-entries and the location's entries near it. */
  readonly records: readonly OutageEntryRecord[];
  /** Back-entries outside the window with no reason for it, reviewed before reconciling. */
  readonly outsideUnexplained: readonly string[];
}

/**
 * The current version of every back-entry citing the outage, and of every entry at its location
 * from `downtime.duplicate_match_minutes` before it began to the same after it ended (or now),
 * offline ones included; back-entries of another outage are left out, and so is any entry a later
 * one corrects. Read in the organisation's view, so a back-entry about someone the reconciler can
 * no longer see still counts (rule 14); only ids, people, kinds and times leave this function.
 */
export async function outageEntries(
  tx: Transaction,
  row: OutageRow,
  rates: Pick<OperationsRates, "duplicateMatchMinutes">,
  now: Date,
): Promise<OutageEntries> {
  const margin = rates.duplicateMatchMinutes * 60_000;
  const from = new Date(row.startedAt.getTime() - margin);
  const to = new Date((row.endedAt ?? now).getTime() + margin);
  return withTenantWideScope(tx, async () => {
    const records: OutageEntryRecord[] = [];
    const outsideUnexplained: string[] = [];
    for (const [kind, table] of ENTRY_TABLES) {
      // Only the columns the reconciliation needs: never the entry's text or values.
      const rows = await tx
        .select({
          id: table.id,
          locationId: table.locationId,
          personId: table.personId,
          occurredAt: table.occurredAt,
          lateEntryReason: table.lateEntryReason,
          outageId: table.outageId,
          paperReference: table.paperReference,
          outsideOutageReason: table.outsideOutageReason,
          createdBy: table.createdBy,
          chart: "chart" in table ? table.chart : sql<string | null>`NULL`,
        })
        .from(table)
        .where(
          and(
            sql`NOT EXISTS (SELECT 1 FROM ${table} AS later WHERE later.supersedes_id = ${table.id})`,
            or(
              and(eq(table.outageId, row.id), eq(table.lateEntryReason, "downtime")),
              and(
                eq(table.locationId, row.locationId),
                gte(table.occurredAt, from),
                lte(table.occurredAt, to),
              ),
            ),
          ),
        );
      for (const r of rows) {
        const backEntry = r.lateEntryReason === "downtime";
        if (backEntry && r.outageId !== row.id) continue;
        const within = inOutageWindow(row, r.occurredAt);
        if (backEntry && !within && r.outsideOutageReason === null) outsideUnexplained.push(r.id);
        records.push({
          id: r.id,
          locationId: r.locationId,
          personId: r.personId,
          entryKind: r.chart ? `${kind}.${r.chart}` : kind,
          eventAt: r.occurredAt,
          source: backEntry ? "back_entry" : "digital",
          outageId: r.outageId,
          paperReference: r.paperReference,
          withinOutage: within,
          enteredBy: r.createdBy ?? "",
        });
      }
    }
    return { records, outsideUnexplained };
  });
}

/**
 * Who entered or sent the outage's original paper records (not someone who only corrected one,
 * H-203), in the organisation's view, as the database's reconciler check counts them.
 */
export async function outageAuthors(tx: Transaction, outageId: string): Promise<Set<string>> {
  return withTenantWideScope(tx, async () => {
    const { rows } = await tx.execute<{ id: string }>(
      sql`SELECT DISTINCT a AS id FROM app.outage_back_entries(${outageId}) e,
            unnest(ARRAY[e.created_by, e.handed_over_by]) AS a
          WHERE NOT e.is_correction AND a IS NOT NULL`,
    );
    return new Set(rows.map((r) => r.id));
  });
}

/** Asks for the outage's paper records to be entered by when they are due (rule 10). */
export async function raiseBackEntryTask(tx: Transaction, row: OutageRow): Promise<void> {
  await tx.insert(task).values({
    kind: OUTAGE_BACK_ENTRY_TASK,
    title: "Enter the paper records from the outage",
    requiredPermission: "operations.downtime.manage",
    locationId: row.locationId,
    sourceType: "outage",
    sourceId: row.id,
    assigneeRoleKey: "registered_manager",
    dueAt: row.backEntryDueAt ?? new Date(),
  });
}

/** Completes the back-entry task when the outage is reconciled. */
export async function completeBackEntryTask(
  tx: Transaction,
  outageId: string,
  by: string,
  now: Date,
): Promise<void> {
  await tx
    .update(task)
    .set({ status: "done", completedAt: now, completedBy: by })
    .where(
      and(
        eq(task.kind, OUTAGE_BACK_ENTRY_TASK),
        eq(task.sourceId, outageId),
        inArray(task.status, ["open", "in_progress"]),
      ),
    );
}
