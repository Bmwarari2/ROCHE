import { auditEvent, destructionBatch, destructionBatchItem, type Transaction } from "@harbour/db";
import {
  type BatchCandidate,
  countsByTable,
  EXPORT_TABLES,
  type ProposalPlan,
  planBatches,
  proposalOutcome,
  proposalPlan,
  RETENTION_REGISTRY,
  type ReportLine,
  type RetentionTableEntry,
  recheckedBatch,
  recordKey,
  trimToLimit,
} from "@harbour/domain";
import { eq, type SQL, sql } from "drizzle-orm";
import { rateNumber } from "./rates";
import {
  factColumns,
  type GroupRow,
  heldCondition,
  id,
  readableTables,
  ref,
  sweepRules,
  toGroup,
} from "./retention-report";

/**
 * The retention sweep in propose mode (retention sweeps plan 5.4 and 5.5, slice 6; ADR-0135):
 * after the report, for each table whose records the report found due, it scans those rows a page
 * at a time with the same facts, decides each with `proposalOutcome` and writes, per class, one
 * `destruction_batch` (proposed) with its append-only `destruction_batch_item` rows and the audit
 * event `platform.retention.batch_proposed`. It never updates, hides or deletes a record: a batch is
 * only a proposal for a person to review (approval is slice 9).
 */

export const BATCH_PROPOSED_ACTION = "platform.retention.batch_proposed";
const MAX_RECORDS_KEY = "retention.batch.max_records";
/** Items written, or re-checked, per statement. */
const INSERT_CHUNK = 500;
/** Rows read per page while scanning a table. */
const SCAN_PAGE = 1000;

/**
 * The people with an open case that holds their records until slice 12 reads them as holds
 * (provisional, H-1612 and H-1621): a DSAR case about them or one of their contacts, a complaint
 * about them, or a safeguarding concern about them, not yet closed.
 */
const OPEN_CASE_PEOPLE = sql`
  SELECT subject_person_id AS id FROM dsar_case WHERE status = 'open' AND subject_person_id IS NOT NULL
  UNION SELECT person_id FROM complaint WHERE closed_at IS NULL AND person_id IS NOT NULL
  UNION SELECT person_id FROM safeguarding_concern WHERE closed_at IS NULL`;

/** A column naming one id or a list of them, as a JSON array. */
const asArray = (column: string) => sql`CASE WHEN ${ref(column)} IS NULL THEN '[]'::jsonb
  WHEN jsonb_typeof(to_jsonb(${ref(column)})) = 'array' THEN to_jsonb(${ref(column)})
  ELSE jsonb_build_array(to_jsonb(${ref(column)})) END`;

/** Whether a person the row names has an open case (`open_case` CTE), as a boolean expression. */
function openCaseCondition(plan: Extract<ProposalPlan, { kind: "propose" }>): SQL {
  return plan.personColumns.length === 0
    ? sql`false`
    : sql`EXISTS (SELECT 1 FROM open_case oc WHERE ${sql.join(
        plan.personColumns.map((c) => sql`${asArray(c)} @> to_jsonb(oc.id)`),
        sql` OR `,
      )})`;
}

/**
 * One page of a table's rows that could be proposed, in id order after `after`: the held ones,
 * those with an open case and those already in a proposed batch are left out in the database;
 * the rest come with the report's facts and the subject's ids for `proposalOutcome`.
 */
function scanPage(
  entry: RetentionTableEntry,
  plan: Extract<ProposalPlan, { kind: "propose" }>,
  after: string | null,
) {
  const subjectIds = plan.subjectColumn
    ? sql`ARRAY(SELECT x FROM jsonb_array_elements_text(${asArray(plan.subjectColumn)}) x
               WHERE x IS NOT NULL)`
    : sql`'{}'::text[]`;
  return sql`WITH open_case AS (${OPEN_CASE_PEOPLE})
    SELECT t.id::text AS id, ${factColumns(entry, plan.read)}, false AS open_case,
      ${subjectIds} AS subject_ids, 1 AS n
    FROM ${id(entry.table)} t
    WHERE ${after === null ? sql`true` : sql`t.id > ${after}::uuid`}
      AND NOT ${heldCondition(entry, plan.read)}
      AND NOT ${openCaseCondition(plan)}
      AND NOT EXISTS (SELECT 1 FROM destruction_batch_item i
        JOIN destruction_batch b ON b.id = i.batch_id AND b.status = 'proposed'
        WHERE i.table_name = ${entry.table} AND i.record_id = t.id)
    ORDER BY t.id LIMIT ${SCAN_PAGE}`;
}

/** Of `ids`, those still free of a hold and an open case: re-checked under the retention lock. */
function recheckQuery(
  entry: RetentionTableEntry,
  plan: Extract<ProposalPlan, { kind: "propose" }>,
  ids: readonly string[],
) {
  return sql`WITH open_case AS (${OPEN_CASE_PEOPLE})
    SELECT t.id::text AS id FROM ${id(entry.table)} t
    WHERE t.id = ANY(${`{${ids.join(",")}}`}::uuid[])
      AND NOT ${heldCondition(entry, plan.read)}
      AND NOT ${openCaseCondition(plan)}`;
}

interface Row extends GroupRow {
  id: string;
  open_case: boolean;
  subject_ids: string[];
}

export interface ProposeResult {
  readonly batches: readonly {
    readonly id: string;
    readonly recordClass: string;
    readonly count: number;
  }[];
}

export interface ProposeOptions {
  /** Runs between the scan and the lock (tests place a hold here). */
  readonly afterScan?: (candidates: number) => Promise<void>;
}

const openBatches = async (tx: Transaction) => {
  const open = await tx
    .select({ recordClass: destructionBatch.recordClass })
    .from(destructionBatch)
    .where(eq(destructionBatch.status, "proposed"));
  const inOpen = await tx
    .select({ tableName: destructionBatchItem.tableName, recordId: destructionBatchItem.recordId })
    .from(destructionBatchItem)
    .innerJoin(destructionBatch, eq(destructionBatch.id, destructionBatchItem.batchId))
    .where(eq(destructionBatch.status, "proposed"));
  return {
    openClasses: new Set(open.map((b) => b.recordClass)),
    inOpenBatch: new Set(inOpen.map((i) => recordKey(i.tableName, i.recordId))),
  };
};

/**
 * Proposes destruction batches as at `now` from the report's lines, in the organisation's context
 * as the system. The scan runs without the retention lock, a page at a time, keeping per class
 * only the oldest due a batch could take, so neither memory nor the lock grows with a table.
 * Then, under the organisation's retention lock (the key the hold, documents and shred routes
 * take), it re-reads the proposed batches, plans, and re-checks holds and open cases for the
 * chosen records only, so a hold placed during the scan is respected (security review, M1).
 */
export async function proposeBatches(
  tx: Transaction,
  tenantId: string,
  now: Date,
  lines: readonly ReportLine[],
  options: ProposeOptions = {},
): Promise<ProposeResult> {
  const today = now.toISOString().slice(0, 10);
  const maxRecords = await rateNumber(tx, tenantId, MAX_RECORDS_KEY, "england", today);
  if (!Number.isInteger(maxRecords) || maxRecords < 1) return { batches: [] };
  const rules = await sweepRules(tx, tenantId, now);
  const dueTables = new Set(lines.filter((l) => l.counts.due > 0).map((l) => l.table));
  const readable = await readableTables(tx, [...dueTables]);
  const before = await openBatches(tx);

  const plans = new Map<
    string,
    [RetentionTableEntry, Extract<ProposalPlan, { kind: "propose" }>]
  >();
  let candidates: BatchCandidate[] = [];
  for (const entry of RETENTION_REGISTRY) {
    if (!dueTables.has(entry.table) || !readable.has(entry.table)) continue;
    // An item names its record by id; a table without one is never proposed.
    if (!("id" in (EXPORT_TABLES[`public.${entry.table}`]?.columns ?? {}))) continue;
    const plan = proposalPlan(entry);
    if (plan.kind !== "propose") continue;
    // Fixed classes that all have a proposed batch: nothing of this table can be proposed now.
    const fixed = plan.read.classColumn === null ? plan.read.classes : [];
    if (fixed.length > 0 && fixed.every((c) => before.openClasses.has(c))) continue;
    plans.set(entry.table, [entry, plan]);
    let after: string | null = null;
    let found = 0;
    while (found < maxRecords) {
      const page: { rows: Row[] } = await tx.execute<Row>(scanPage(entry, plan, after));
      for (const r of page.rows) {
        const outcome = proposalOutcome(
          entry.table,
          plan,
          { ...toGroup(r), id: r.id, openCase: false, subjectIds: r.subject_ids },
          rules,
          now,
        );
        if (outcome.kind !== "propose") continue;
        candidates.push(outcome.candidate);
        found++;
      }
      if (page.rows.length < SCAN_PAGE) break;
      after = page.rows.at(-1)?.id ?? null;
    }
    candidates = trimToLimit(candidates, maxRecords);
  }
  await options.afterScan?.(candidates.length);

  await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${`retention:${tenantId}`}))`);
  const planned = planBatches(candidates, { maxRecords, ...(await openBatches(tx)) });
  const byTable = new Map<string, string[]>();
  for (const batch of planned) {
    for (const item of batch.items) {
      const ids = byTable.get(item.table);
      if (ids) ids.push(item.recordId);
      else byTable.set(item.table, [item.recordId]);
    }
  }
  const stillProposable = new Set<string>();
  for (const [table, ids] of byTable) {
    const [entry, plan] = plans.get(table) ?? [];
    if (!entry || !plan) continue;
    for (let i = 0; i < ids.length; i += INSERT_CHUNK) {
      const kept = await tx.execute<{ id: string }>(
        recheckQuery(entry, plan, ids.slice(i, i + INSERT_CHUNK)),
      );
      for (const r of kept.rows) stillProposable.add(recordKey(table, r.id));
    }
  }

  const batches: { id: string; recordClass: string; count: number }[] = [];
  for (const proposed of planned) {
    const batch = recheckedBatch(proposed, stillProposable);
    if (!batch) continue;
    const tables = countsByTable(batch.items);
    const { recordClass, period, unit, trigger, origin } = batch.rule;
    const [saved] = await tx
      .insert(destructionBatch)
      .values({
        recordClass: batch.recordClass,
        rule: { recordClass, period, unit, trigger, origin },
        itemCount: batch.items.length,
        tables,
        proposedAt: now,
      })
      .returning({ id: destructionBatch.id });
    const batchId = saved?.id ?? "";
    for (let i = 0; i < batch.items.length; i += INSERT_CHUNK) {
      await tx.insert(destructionBatchItem).values(
        batch.items.slice(i, i + INSERT_CHUNK).map((item) => ({
          batchId,
          tableName: item.table,
          recordId: item.recordId,
          recordClass: item.recordClass,
          triggerOn: item.triggerOn ? item.triggerOn.toISOString().slice(0, 10) : null,
          dueOn: item.dueOn.toISOString().slice(0, 10),
          subjectKind: item.subjectKind,
          subjectIds: [...item.subjectIds],
        })),
      );
    }
    // The batch id, class and counts per table only (plan 5.8): no record or subject id.
    await tx.insert(auditEvent).values({
      tenantId,
      action: BATCH_PROPOSED_ACTION,
      resourceType: "destruction_batch",
      resourceId: batchId,
      scope: { recordClass: batch.recordClass, itemCount: batch.items.length, tables },
    });
    batches.push({ id: batchId, recordClass: batch.recordClass, count: batch.items.length });
  }
  return { batches };
}
