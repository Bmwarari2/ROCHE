import type { OutageItem } from "@harbour/contracts";
import {
  activityRecord,
  bodyMapMark,
  careNote,
  observation,
  outage,
  type Transaction,
  visitLog,
} from "@harbour/db";
import type { OperationsRates, OutageEntryRecord, OutageKind, OutageWindow } from "@harbour/domain";
import { and, desc, eq, gte, lte } from "drizzle-orm";
import { withTenantWideScope } from "./safety";

/**
 * Outages through the API (operations.md rules 9 to 15; HZ-017): the row as the screens see it,
 * the window the domain rules read, and the entries near an outage for its reconciliation.
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

const ENTRY_TABLES = [
  ["care_note", careNote],
  ["observation", observation],
  ["body_map_mark", bodyMapMark],
  ["activity_record", activityRecord],
  ["visit_log", visitLog],
] as const;

/**
 * The entries at the outage's location from `downtime.duplicate_match_minutes` before it began
 * to the same after it ended (or now): its back-entries and the digital entries recorded at the
 * time, offline ones included; back-entries of another outage are left out. Read in the
 * organisation's view, so a back-entry about someone the reconciler can no longer see still counts
 * (rule 14); only ids, people, kinds and times leave this function.
 */
export async function outageEntries(
  tx: Transaction,
  row: OutageRow,
  rates: Pick<OperationsRates, "duplicateMatchMinutes">,
  now: Date,
): Promise<OutageEntryRecord[]> {
  const margin = rates.duplicateMatchMinutes * 60_000;
  const from = new Date(row.startedAt.getTime() - margin);
  const to = new Date((row.endedAt ?? now).getTime() + margin);
  return withTenantWideScope(tx, async () => {
    const records: OutageEntryRecord[] = [];
    for (const [kind, table] of ENTRY_TABLES) {
      const rows = await tx
        .select()
        .from(table)
        .where(
          and(
            eq(table.locationId, row.locationId),
            gte(table.occurredAt, from),
            lte(table.occurredAt, to),
          ),
        );
      for (const r of rows) {
        const backEntry = r.lateEntryReason === "downtime";
        if (backEntry && r.outageId !== row.id) continue;
        records.push({
          id: r.id,
          locationId: r.locationId,
          personId: r.personId,
          entryKind: "chart" in r ? `${kind}.${r.chart}` : kind,
          eventAt: r.occurredAt,
          source: backEntry ? "back_entry" : "digital",
          outageId: r.outageId,
          paperReference: r.paperReference,
          withinOutage: r.outsideOutageReason === null,
          enteredBy: r.createdBy ?? "",
        });
      }
    }
    return records;
  });
}
