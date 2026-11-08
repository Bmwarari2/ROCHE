import {
  auditEvent,
  featureFlag,
  retentionClass,
  retentionReport,
  type Transaction,
  tenant,
} from "@harbour/db";
import {
  countsByClass,
  EXPORT_TABLES,
  evaluateFlag,
  groupStatus,
  LIVE_PERSON_STATUSES,
  RETENTION_REGISTRY,
  type ReadableSource,
  type ReportGroup,
  type ReportLine,
  type ReportPlan,
  type RetentionSweepMode,
  type RetentionTableEntry,
  reportPlan,
  reportTotals,
  STAFF_FILE_OPTIONS,
  type StaffFileOption,
  type SweepRules,
  sweepModeOf,
  tally,
} from "@harbour/domain";
import { eq, isNull, type SQL, sql } from "drizzle-orm";
import { rateNumber } from "./rates";

/**
 * The retention sweep in report mode (retention sweeps plan 5.4 and 5.9, slice 4; ADR-0135). For
 * each table in the retention registry it reads, as the application role in the organisation's
 * context, one grouped count of the rows by the facts the decision needs, decides each group with
 * `sweepDecision` and writes one `retention_report` row and one `platform.retention.sweep_reported`
 * audit event, counts only. It never updates or deletes a record: its only writes are those two.
 */

export const RETENTION_SWEEP_FLAG = "platform.retention.sweep_report";
/** Propose mode (slice 6): on top of the report flag, one step at a time (`sweepModeOf`). */
export const RETENTION_PROPOSE_FLAG = "platform.retention.sweep_propose";
export const SWEEP_REPORTED_ACTION = "platform.retention.sweep_reported";
const BIRTHDAY_AGE_KEY = "retention.staff_file.birthday_age";

/**
 * The organisation's sweep mode from its flags: `off` (the default), `report`, or `propose` when
 * the propose flag is on as well (never propose without report).
 */
export async function retentionSweepMode(tx: Transaction): Promise<RetentionSweepMode> {
  const rows = await tx
    .select({
      flagKey: featureFlag.flagKey,
      locationId: featureFlag.locationId,
      enabled: featureFlag.enabled,
    })
    .from(featureFlag)
    .where(isNull(featureFlag.deletedAt));
  return sweepModeOf({
    report: evaluateFlag(RETENTION_SWEEP_FLAG, rows, null),
    propose: evaluateFlag(RETENTION_PROPOSE_FLAG, rows, null),
  });
}

export const id = (name: string) => sql.identifier(name);
export const ref = (column: string) => sql`t.${id(column)}`;

/** One date source as a SQL expression over the row `t` (one level of lookup, never a loop). */
function dateOf(source: ReadableSource): SQL {
  switch (source.from) {
    case "column":
      return ref(source.column);
    case "first_of":
      return sql`COALESCE(${sql.join(source.columns.map(ref), sql`, `)})`;
    case "person_care_ended":
      return sql`(SELECT COALESCE(p.deceased_at, p.discharged_at) FROM person p WHERE p.id = ${ref(source.column)})`;
    case "staff_leaving":
      return source.via === "staff_profile"
        ? sql`(SELECT l.leaving_on FROM leaver_record l WHERE l.staff_profile_id = ${ref(source.column)})`
        : sql`(SELECT l.leaving_on FROM leaver_record l JOIN staff_profile s ON s.id = l.staff_profile_id
               WHERE s.tenant_user_id = ${ref(source.column)})`;
    case "lookup":
      return sql`(SELECT x.${id(source.column)} FROM ${id(source.table)} x WHERE x.id = ${ref(source.key)})`;
    case "latest_child":
      return sql`(SELECT max(x.${id(source.column)}) FROM ${id(source.table)} x
                  WHERE x.${id(source.foreignKey)} = t.id)`;
  }
}

/** A day as text, so no driver or session time zone moves it (the transaction runs in UTC). */
const day = (source: ReadableSource | undefined) =>
  source ? sql`to_char((${dateOf(source)})::date, 'YYYY-MM-DD')` : sql`NULL::text`;

const LIVE = sql.join(
  LIVE_PERSON_STATUSES.map((s) => sql`${s}`),
  sql`, `,
);

/**
 * The facts of one table's rows under a read plan, as the select list of a query over `t`: the
 * class, the hold, whether the person is in care and each trigger date (the report groups by
 * them; propose mode reads them per row).
 */
export function factColumns(
  entry: RetentionTableEntry,
  plan: Extract<ReportPlan, { kind: "read" }>,
): SQL {
  const f = plan.facts;
  const hasId = "id" in (EXPORT_TABLES[`public.${entry.table}`]?.columns ?? {});
  const holdTargets: SQL[] = [];
  if (hasId)
    holdTargets.push(sql`(h.subject_type = ${entry.table} AND h.subject_id::text = t.id::text)`);
  // The person column may be one id or a list of them (an incident's `person_ids`).
  if (plan.personColumn)
    holdTargets.push(sql`to_jsonb(${ref(plan.personColumn)}) @> to_jsonb(h.person_id)`);
  const held =
    holdTargets.length === 0
      ? sql`false`
      : sql`EXISTS (SELECT 1 FROM legal_hold h WHERE h.released_at IS NULL
                    AND (${sql.join(holdTargets, sql` OR `)}))`;
  const care = f.careEnded?.from === "person_care_ended" ? f.careEnded.column : null;
  const receiving = care
    ? sql`COALESCE((SELECT p.status::text IN (${LIVE}) FROM person p WHERE p.id = ${ref(care)}), false)`
    : sql`false`;
  const leaving = f.employmentEndedAt?.from === "staff_leaving" ? f.employmentEndedAt : null;
  const dateOfBirth = leaving
    ? sql`to_char((SELECT s.date_of_birth FROM staff_profile s
          WHERE ${leaving.via === "staff_profile" ? sql`s.id` : sql`s.tenant_user_id`} = ${ref(leaving.column)}), 'YYYY-MM-DD')`
    : sql`NULL::text`;
  const recordClass = plan.classColumn ? sql`${ref(plan.classColumn)}::text` : sql`NULL::text`;
  return sql`${recordClass} AS record_class, ${held} AS held, ${receiving} AS receiving_care,
      ${day(f.careEnded)} AS care_ended, ${day(f.entryDates)} AS entry_date,
      ${day(f.closedAt)} AS closed_at, ${day(f.employmentEndedAt)} AS employment_ended_at,
      ${dateOfBirth} AS date_of_birth, ${day(f.createdAt)} AS created_at,
      ${day(f.periodEndsAt)} AS period_ends_at`;
}

/** The grouped count of one table's rows under a read plan. */
function groupQuery(entry: RetentionTableEntry, plan: Extract<ReportPlan, { kind: "read" }>) {
  return sql`SELECT ${factColumns(entry, plan)}, count(*)::int AS n
    FROM ${id(entry.table)} t GROUP BY 1, 2, 3, 4, 5, 6, 7, 8, 9, 10`;
}

export interface GroupRow extends Record<string, unknown> {
  record_class: string | null;
  held: boolean;
  receiving_care: boolean;
  care_ended: string | null;
  entry_date: string | null;
  closed_at: string | null;
  employment_ended_at: string | null;
  date_of_birth: string | null;
  created_at: string | null;
  period_ends_at: string | null;
  n: number;
}

const asDate = (s: string | null) => (s ? new Date(`${s}T00:00:00Z`) : null);

export function toGroup(r: GroupRow): ReportGroup {
  return {
    recordClass: r.record_class,
    held: r.held,
    receivingCare: r.receiving_care,
    careEnded: asDate(r.care_ended),
    entryDate: asDate(r.entry_date),
    closedAt: asDate(r.closed_at),
    employmentEndedAt: asDate(r.employment_ended_at),
    dateOfBirth: asDate(r.date_of_birth),
    createdAt: asDate(r.created_at),
    periodEndsAt: asDate(r.period_ends_at),
    count: r.n,
  };
}

export async function sweepRules(
  tx: Transaction,
  tenantId: string,
  now: Date,
): Promise<SweepRules> {
  const rows = await tx.select().from(retentionClass);
  const [own] = await tx
    .select({ option: tenant.staffFileOption })
    .from(tenant)
    .where(eq(tenant.id, tenantId));
  const option = (STAFF_FILE_OPTIONS as readonly string[]).includes(own?.option ?? "")
    ? (own?.option as StaffFileOption)
    : null;
  return {
    rows: rows.map((r) => ({
      tenantId: r.tenantId,
      recordClass: r.recordClass,
      period: r.period,
      unit: r.unit,
      trigger: r.trigger,
    })),
    tenant: { tenantId, staffFileOption: option },
    staffFileBirthdayAge: await rateNumber(
      tx,
      tenantId,
      BIRTHDAY_AGE_KEY,
      "england",
      now.toISOString().slice(0, 10),
    ),
  };
}

/** The registry tables the application role may read (equality monitoring, for one, it may not). */
export async function readableTables(
  tx: Transaction,
  tables: readonly string[],
): Promise<Set<string>> {
  const result = await tx.execute<{ name: string }>(
    sql`SELECT name FROM unnest(${`{${tables.join(",")}}`}::text[]) AS name
        WHERE to_regclass('public.' || quote_ident(name)) IS NOT NULL
          AND has_table_privilege(to_regclass('public.' || quote_ident(name)), 'SELECT')`,
  );
  return new Set(result.rows.map((r) => r.name));
}

export interface ReportResult {
  readonly id: string;
  readonly mode: Exclude<RetentionSweepMode, "off">;
  readonly lines: readonly ReportLine[];
}

/**
 * Writes the organisation's retention report as at `now` when its sweep is in report or propose
 * mode, or does nothing (null) when it is off. Runs in the organisation's context as the system.
 * Propose mode's batches follow it (`proposeBatches`), from the same report.
 */
export async function reportRetention(
  tx: Transaction,
  tenantId: string,
  now: Date,
  clock: () => number = Date.now,
): Promise<ReportResult | null> {
  const mode = await retentionSweepMode(tx);
  if (mode === "off") return null;
  const started = clock();
  // Days are read in UTC, whatever the server's time zone (transaction-local).
  await tx.execute(sql`SELECT set_config('TimeZone', 'UTC', true)`);
  const rules = await sweepRules(tx, tenantId, now);
  const publicTables = RETENTION_REGISTRY.map((e) => e.table).filter((t) => !t.includes("."));
  const readable = await readableTables(tx, publicTables);
  const lines = new Map<string, ReportLine>();
  let tablesRead = 0;
  let tablesSkipped = 0;
  for (const entry of RETENTION_REGISTRY) {
    const plan = reportPlan(entry);
    if (plan.kind === "skip" && plan.reason === "outside_tenant_tables") {
      tally(lines, entry.table, null, plan.reason, plan.status, 0);
      tablesSkipped++;
      continue;
    }
    if (!readable.has(entry.table)) {
      tally(lines, entry.table, null, "not_readable", "not_evaluated", 0);
      tablesSkipped++;
      continue;
    }
    if (plan.kind === "skip") {
      const counted = await tx.execute<{ n: number }>(
        sql`SELECT count(*)::int AS n FROM ${id(entry.table)}`,
      );
      tally(lines, entry.table, null, plan.reason, plan.status, counted.rows[0]?.n ?? 0);
      tablesSkipped++;
      continue;
    }
    const groups = await tx.execute<GroupRow>(groupQuery(entry, plan));
    for (const row of groups.rows) {
      const group = toGroup(row);
      const classes = plan.classColumn ? [group.recordClass ?? "none"] : plan.classes;
      const status = groupStatus(plan, group, rules, now);
      tally(lines, entry.table, classes.join(","), null, status, group.count);
    }
    tablesRead++;
  }
  const all = [...lines.values()];
  const totals = reportTotals(all);
  const [saved] = await tx
    .insert(retentionReport)
    .values({
      mode,
      asOf: now,
      durationMs: Math.max(0, Math.round(clock() - started)),
      tablesRead,
      tablesSkipped,
      lines: all,
      totals,
    })
    .returning({ id: retentionReport.id });
  const reportId = saved?.id ?? "";
  // Counts per class and status only (plan 5.8): no record id, subject or date.
  await tx.insert(auditEvent).values({
    tenantId,
    action: SWEEP_REPORTED_ACTION,
    resourceType: "retention_report",
    resourceId: reportId,
    scope: { mode, tablesRead, tablesSkipped, totals, byClass: countsByClass(all) },
  });
  return { id: reportId, mode, lines: all };
}
