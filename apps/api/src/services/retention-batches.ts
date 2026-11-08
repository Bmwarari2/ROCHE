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
  recordKey,
} from "@harbour/domain";
import { eq, type SQL, sql } from "drizzle-orm";
import { rateNumber } from "./rates";
import {
  factColumns,
  type GroupRow,
  id,
  readableTables,
  ref,
  sweepRules,
  toGroup,
} from "./retention-report";

/**
 * The retention sweep in propose mode (retention sweeps plan 5.4 and 5.5, slice 6; ADR-0135):
 * after the report, for each table whose records the report found due, it reads those rows one by
 * one with the same facts, decides each with `proposalOutcome` and writes, per class, one
 * `destruction_batch` (proposed) with its append-only `destruction_batch_item` rows and the audit
 * event `platform.retention.batch_proposed`. It never updates, hides or deletes a record: a batch is
 * only a proposal for a person to review (approval is slice 9).
 */

export const BATCH_PROPOSED_ACTION = "platform.retention.batch_proposed";
const MAX_RECORDS_KEY = "retention.batch.max_records";
/** Items written per statement. */
const INSERT_CHUNK = 500;

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

/** One table's rows with their facts, id, subject and open cases (propose mode reads per row). */
function rowQuery(entry: RetentionTableEntry, plan: Extract<ProposalPlan, { kind: "propose" }>) {
  const openCase: SQL =
    plan.personColumns.length === 0
      ? sql`false`
      : sql`EXISTS (SELECT 1 FROM open_case oc WHERE ${sql.join(
          plan.personColumns.map((c) => sql`${asArray(c)} @> to_jsonb(oc.id)`),
          sql` OR `,
        )})`;
  const subjectIds = plan.subjectColumn
    ? sql`ARRAY(SELECT x FROM jsonb_array_elements_text(${asArray(plan.subjectColumn)}) x
               WHERE x IS NOT NULL)`
    : sql`'{}'::text[]`;
  return sql`WITH open_case AS (${OPEN_CASE_PEOPLE})
    SELECT t.id::text AS id, ${factColumns(entry, plan.read)}, ${openCase} AS open_case,
      ${subjectIds} AS subject_ids, 1 AS n
    FROM ${id(entry.table)} t`;
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

/**
 * Proposes destruction batches as at `now` from the report's lines. Runs in the organisation's
 * context as the system, under the organisation's retention lock (the key the hold and documents
 * routes take), so a hold placed meanwhile waits for this transaction and is seen by the next run.
 */
export async function proposeBatches(
  tx: Transaction,
  tenantId: string,
  now: Date,
  lines: readonly ReportLine[],
): Promise<ProposeResult> {
  await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${`retention:${tenantId}`}))`);
  const today = now.toISOString().slice(0, 10);
  const maxRecords = await rateNumber(tx, tenantId, MAX_RECORDS_KEY, "england", today);
  const rules = await sweepRules(tx, tenantId, now);
  const dueTables = new Set(lines.filter((l) => l.counts.due > 0).map((l) => l.table));
  const readable = await readableTables(tx, [...dueTables]);

  const candidates: BatchCandidate[] = [];
  for (const entry of RETENTION_REGISTRY) {
    if (!dueTables.has(entry.table) || !readable.has(entry.table)) continue;
    // An item names its record by id; a table without one is never proposed.
    if (!("id" in (EXPORT_TABLES[`public.${entry.table}`]?.columns ?? {}))) continue;
    const plan = proposalPlan(entry);
    if (plan.kind !== "propose") continue;
    const rows = await tx.execute<Row>(rowQuery(entry, plan));
    for (const r of rows.rows) {
      const outcome = proposalOutcome(
        entry.table,
        plan,
        { ...toGroup(r), id: r.id, openCase: r.open_case, subjectIds: r.subject_ids },
        rules,
        now,
      );
      if (outcome.kind === "propose") candidates.push(outcome.candidate);
    }
  }

  const open = await tx
    .select({ recordClass: destructionBatch.recordClass })
    .from(destructionBatch)
    .where(eq(destructionBatch.status, "proposed"));
  const inOpen = await tx
    .select({ tableName: destructionBatchItem.tableName, recordId: destructionBatchItem.recordId })
    .from(destructionBatchItem)
    .innerJoin(destructionBatch, eq(destructionBatch.id, destructionBatchItem.batchId))
    .where(eq(destructionBatch.status, "proposed"));
  const planned = planBatches(candidates, {
    maxRecords,
    openClasses: new Set(open.map((b) => b.recordClass)),
    inOpenBatch: new Set(inOpen.map((i) => recordKey(i.tableName, i.recordId))),
  });

  const batches: { id: string; recordClass: string; count: number }[] = [];
  for (const batch of planned) {
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
