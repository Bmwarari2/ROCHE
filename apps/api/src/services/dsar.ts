import type { DsarCase } from "@harbour/contracts";
import {
  contact,
  dsarCase,
  dsarItem,
  person,
  retentionClass,
  type Transaction,
  tenant,
  tenantUser,
  withRequestContext,
} from "@harbour/db";
import {
  DATA_RIGHTS_RATE_KEYS,
  type DsarClock,
  type DsarPause,
  type DsarRates,
  type DsarSubjectKind,
  dsarClock,
  dsarNotSearchedOf,
  dsarSubjectMap,
  type ErasureCandidate,
  EXPORT_TABLES,
  isUnderLegalHold,
  portabilityApplies,
  type RetentionRule,
  resolveDataRightsRates,
} from "@harbour/domain";
import { and, eq, inArray, isNull, or, sql } from "drizzle-orm";
import type { Context } from "hono";
import type { AppEnv, TenantAccess } from "../http/context";
import { HttpProblem, problems } from "../http/problem";
import { activeHolds, careEndedOn } from "./documents";
import { bankHolidays, rateRows } from "./rates";

/**
 * The DSAR workbench's reads (PLAT-022; ADR-0090): the clock on read, the subject's name, the
 * collector over the export catalogue and the record views. Records are read in the
 * organisation's own context (no member, the whole organisation), as the full export reads them,
 * and only after the route has required `quality.dsar.manage` with MFA: a case is the data
 * protection lead's work across every module, and module permissions do not narrow it.
 */

export type CaseRow = typeof dsarCase.$inferSelect;
export type ItemRow = typeof dsarItem.$inferSelect;

/** Most records one case collects at a time (a technical limit; collect again after review). */
export const DSAR_ITEM_LIMIT = 5000;

export const SUBJECT_MAP = dsarSubjectMap(EXPORT_TABLES);

const today = () => new Date().toISOString().slice(0, 10);

export interface ClockContext {
  readonly rates: DsarRates;
  readonly holidays: ReadonlySet<string>;
  readonly today: string;
}

/** The tenant's DSAR figures from the rate table and its nation's bank holidays. */
export async function clockContext(tx: Transaction, tenantId: string): Promise<ClockContext> {
  const [t] = await tx
    .select({ nation: tenant.nation })
    .from(tenant)
    .where(eq(tenant.id, tenantId));
  const nation = t?.nation ?? "england";
  const on = today();
  const rates = resolveDataRightsRates(
    await rateRows(tx, Object.values(DATA_RIGHTS_RATE_KEYS)),
    nation,
    on,
    tenantId,
  );
  return {
    rates: {
      responseMonths: rates.dsarResponseMonths,
      extensionMonths: rates.dsarExtensionMonths,
      dueSoonDays: rates.dsarDueSoonDays,
    },
    holidays: await bankHolidays(tx, nation),
    today: on,
  };
}

export const pausesOf = (row: Pick<CaseRow, "pauses">): DsarPause[] =>
  Array.isArray(row.pauses) ? (row.pauses as DsarPause[]) : [];

export function clockOf(row: CaseRow, ctx: ClockContext, change: Partial<CaseRow> = {}): DsarClock {
  const r = { ...row, ...change };
  return dsarClock(
    {
      receivedOn: r.receivedOn,
      identity: { required: r.identityRequired, receivedOn: r.identityVerifiedOn },
      pauses: pausesOf(r),
      extension:
        r.extensionMonths !== null && r.extensionGrounds !== null && r.extensionDecidedOn !== null
          ? {
              months: r.extensionMonths,
              grounds: r.extensionGrounds as "complex" | "multiple_requests",
              reason: r.extensionReason ?? "",
              decidedOn: r.extensionDecidedOn,
            }
          : null,
      respondedOn: r.respondedOn,
    },
    ctx.rates,
    ctx.holidays,
    ctx.today,
  );
}

export function clockView(clock: DsarClock) {
  if (!clock.ok) return null;
  const { ok: _ok, ...view } = clock;
  return view;
}

/** Refuses a change the clock does not accept, in the slice 9 rule's words. */
export function requireClock(clock: DsarClock): void {
  if (!clock.ok) throw new HttpProblem(422, clock.problem, clock.message);
}

export const caseProblem = {
  notOpen: () =>
    new HttpProblem(409, "dsar_case_not_open", "This request is closed and cannot change."),
  wrongKind: (kind: string) =>
    new HttpProblem(409, "dsar_wrong_request_kind", `This is not a request for ${kind}.`),
  notReady: (pending: number) =>
    new HttpProblem(
      409,
      "dsar_bundle_not_ready",
      "Every record needs a decision before the bundle is issued.",
      `${pending} still to review.`,
    ),
  noPortability: () =>
    new HttpProblem(
      409,
      "dsar_portability_not_applicable",
      "Portability does not apply to these records.",
      "Care records are not held on consent or contract; give access instead.",
    ),
  stale: () => problems.conflict("Reload the request and try again."),
};

export async function loadCase(tx: Transaction, id: string): Promise<CaseRow> {
  const [row] = await tx.select().from(dsarCase).where(eq(dsarCase.id, id));
  if (!row) throw problems.notFound();
  return row;
}

export function requireOpen(row: CaseRow): void {
  if (row.status !== "open") throw caseProblem.notOpen();
}

/** The subjects' names, for the case list and detail. */
export async function subjectNames(tx: Transaction, rows: readonly CaseRow[]) {
  const names = new Map<string, string>();
  const people = rows.flatMap((r) => (r.subjectPersonId ? [r.subjectPersonId] : []));
  const contacts = rows.flatMap((r) => (r.subjectContactId ? [r.subjectContactId] : []));
  const staff = rows.flatMap((r) => (r.subjectStaffId ? [r.subjectStaffId] : []));
  if (people.length > 0) {
    for (const p of await tx
      .select({ id: person.id, given: person.givenName, family: person.familyName })
      .from(person)
      .where(inArray(person.id, people)))
      names.set(p.id, `${p.given} ${p.family}`);
  }
  if (contacts.length > 0) {
    for (const p of await tx
      .select({ id: contact.id, given: contact.givenName, family: contact.familyName })
      .from(contact)
      .where(inArray(contact.id, contacts)))
      names.set(p.id, `${p.given} ${p.family}`);
  }
  if (staff.length > 0) {
    for (const s of await tx
      .select({ id: tenantUser.id, name: tenantUser.displayName })
      .from(tenantUser)
      .where(inArray(tenantUser.id, staff)))
      names.set(s.id, s.name);
  }
  return (row: CaseRow) => {
    const id = row.subjectContactId ?? row.subjectPersonId ?? row.subjectStaffId ?? "";
    return {
      kind: row.subjectKind as DsarSubjectKind,
      personId: row.subjectPersonId,
      contactId: row.subjectContactId,
      staffId: row.subjectStaffId,
      name: names.get(id) ?? "",
    };
  };
}

export function subjectIdOf(row: CaseRow): string {
  return (
    row.subjectKind === "contact"
      ? row.subjectContactId
      : row.subjectKind === "staff"
        ? row.subjectStaffId
        : row.subjectPersonId
  ) as string;
}

export function summaryOf(
  row: CaseRow,
  subject: Awaited<ReturnType<typeof subjectNames>>,
  ctx: ClockContext,
) {
  return {
    id: row.id,
    requestKind: row.requestKind as DsarCase["requestKind"],
    subject: subject(row),
    receivedOn: row.receivedOn,
    status: row.status as DsarCase["status"],
    clock: clockView(clockOf(row, ctx)),
    version: row.version,
  };
}

export async function caseOf(tx: Transaction, row: CaseRow, ctx: ClockContext): Promise<DsarCase> {
  const subject = await subjectNames(tx, [row]);
  const counts = await tx
    .select({ decision: dsarItem.decision, n: sql<number>`count(*)::int` })
    .from(dsarItem)
    .where(eq(dsarItem.caseId, row.id))
    .groupBy(dsarItem.decision);
  const count = (...d: string[]) =>
    counts.filter((c) => d.includes(c.decision)).reduce((n, c) => n + c.n, 0);
  const clock = clockOf(row, ctx);
  return {
    ...summaryOf(row, subject, ctx),
    requesterKind: row.requesterKind as DsarCase["requesterKind"],
    requesterName: row.requesterName,
    requesterAddress: row.requesterAddress,
    authority: row.authority as DsarCase["authority"],
    channel: row.channel as DsarCase["channel"],
    identityRequired: row.identityRequired,
    identityVerifiedOn: row.identityVerifiedOn,
    identityMethod: row.identityMethod as DsarCase["identityMethod"],
    pauses: pausesOf(row),
    extension:
      row.extensionMonths !== null && row.extensionDecidedOn !== null
        ? {
            months: row.extensionMonths,
            grounds: row.extensionGrounds as "complex" | "multiple_requests",
            reason: row.extensionReason ?? "",
            decidedOn: row.extensionDecidedOn,
          }
        : null,
    clockProblem: clock.ok ? null : clock.message,
    respondedOn: row.respondedOn,
    outcome: row.outcome as DsarCase["outcome"],
    outcomeReason: row.outcomeReason,
    collectedAt: row.collectedAt?.toISOString() ?? null,
    notSearched: row.notSearched.map((t) => dsarNotSearchedOf(t)),
    items: {
      total: counts.reduce((n, c) => n + c.n, 0),
      pending: count("pending"),
      disclosed: count("disclose", "redact"),
      withheld: count("withhold"),
    },
    portability: portabilityApplies(row.subjectKind as DsarSubjectKind),
    rectification: (row.rectification as DsarCase["rectification"]) ?? [],
    erasure: (row.erasure as DsarCase["erasure"]) ?? null,
    bundleSha256: row.bundleSha256,
    bundleIssuedAt: row.bundleIssuedAt?.toISOString() ?? null,
    bundleStored: row.bundleStorageKey !== null,
  };
}

/** Runs `fn` in the organisation's own context, after the route has authorised the member. */
export function asOrganisation<T>(
  c: Context<AppEnv>,
  access: TenantAccess,
  fn: (tx: Transaction) => Promise<T>,
): Promise<T> {
  return withRequestContext(
    c.get("services").db,
    { tenantId: access.tenantId, userId: null, scope: "tenant", locationIds: [] },
    fn,
  );
}

/** The columns of a table a subject sees: those the export gives, never internal or secret ones. */
export function disclosableColumns(table: string): string[] {
  const def = EXPORT_TABLES[`public.${table}`];
  if (!def) return [];
  return Object.entries(def.columns)
    .filter(([, spec]) =>
      typeof spec === "string" ? spec === "exported" : (spec.class ?? "exported") === "exported",
    )
    .map(([column]) => column);
}

const hasId = (table: string) => "id" in (EXPORT_TABLES[`public.${table}`]?.columns ?? {});

/** Finds the subject's records across the catalogue (rule 3); returns `[table, id]` pairs. */
export async function collectRecords(
  tx: Transaction,
  kind: DsarSubjectKind,
  subjectId: string,
  limit: number,
): Promise<{ found: [string, string][]; tablesSearched: number; truncated: boolean }> {
  const found: [string, string][] = [];
  const tables = new Set<string>();
  for (const { table, column } of SUBJECT_MAP[kind]) {
    if (!hasId(table)) continue;
    tables.add(table);
    const left = limit - found.length;
    if (left <= 0) return { found, tablesSearched: tables.size, truncated: true };
    const result = await tx.execute<{ id: string }>(
      sql`SELECT t.id::text AS id FROM ${sql.identifier(table)} t
          WHERE t.${sql.identifier(column)}::text = ${subjectId}
          ORDER BY t.id LIMIT ${left + 1}`,
    );
    for (const r of result.rows.slice(0, left)) found.push([table, r.id]);
    if (result.rows.length > left) return { found, tablesSearched: tables.size, truncated: true };
  }
  return { found, tablesSearched: tables.size, truncated: false };
}

/** The records of one table by id, as the export shows them (disclosable columns only). */
export async function recordsOf(
  tx: Transaction,
  table: string,
  ids: readonly string[],
): Promise<Map<string, Record<string, unknown>>> {
  const out = new Map<string, Record<string, unknown>>();
  if (ids.length === 0 || !hasId(table)) return out;
  const columns = disclosableColumns(table);
  const result = await tx.execute<{ id: string; row: Record<string, unknown> }>(
    sql`SELECT t.id::text AS id, to_jsonb(t) AS row FROM ${sql.identifier(table)} t
        WHERE t.id::text IN (${sql.join(
          [...ids].map((i) => sql`${i}`),
          sql`, `,
        )})`,
  );
  for (const r of result.rows) {
    out.set(r.id, Object.fromEntries(columns.filter((k) => k in r.row).map((k) => [k, r.row[k]])));
  }
  return out;
}

/** Most names of each kind offered as highlights (a technical limit). */
const NAME_LIMIT = 5000;

/**
 * Names that are not the subject's, for the reviewer's highlights (rule 4): every member of staff,
 * person supported and contact the organisation records, except the subject. Records collected
 * for one subject routinely name others (a staff member's handover names residents; a resident's
 * note names visitors), so nobody is left out by kind (#149 M5).
 */
export async function thirdPartyNames(tx: Transaction, row: CaseRow): Promise<string[]> {
  const names: string[] = [];
  const staff = await tx
    .select({ id: tenantUser.id, name: tenantUser.displayName })
    .from(tenantUser)
    .limit(NAME_LIMIT);
  for (const s of staff) if (s.id !== row.subjectStaffId) names.push(s.name);
  const people = await tx
    .select({
      id: person.id,
      given: person.givenName,
      family: person.familyName,
      preferred: person.preferredName,
    })
    .from(person)
    .limit(NAME_LIMIT);
  for (const p of people) {
    if (row.subjectKind === "person" && p.id === row.subjectPersonId) continue;
    names.push(`${p.given} ${p.family}`, p.given, p.family);
    if (p.preferred) names.push(p.preferred);
  }
  const contacts = await tx
    .select({ id: contact.id, given: contact.givenName, family: contact.familyName })
    .from(contact)
    .limit(NAME_LIMIT);
  for (const c of contacts) {
    if (c.id === row.subjectContactId) continue;
    names.push(`${c.given} ${c.family}`, c.given);
  }
  return names;
}

/** What retention says of each collected record (rule 6), read in the organisation's context. */
export async function erasureCandidates(
  tx: Transaction,
  tenantId: string,
  row: CaseRow,
  items: readonly Pick<ItemRow, "tableName" | "recordId">[],
): Promise<ErasureCandidate[]> {
  const classes = await tx
    .select()
    .from(retentionClass)
    .where(or(isNull(retentionClass.tenantId), eq(retentionClass.tenantId, tenantId)));
  const ruleFor = (recordClass: string): RetentionRule => {
    const r =
      classes.find((x) => x.recordClass === recordClass && x.tenantId === tenantId) ??
      classes.find((x) => x.recordClass === recordClass && x.tenantId === null);
    // A class with no row of its own (by subject, by category, configuration) is the
    // organisation's to set: kept until it does.
    return r
      ? {
          recordClass,
          period: r.period,
          unit: r.unit as "years" | "months",
          trigger: r.trigger as RetentionRule["trigger"],
        }
      : { recordClass, period: 0, unit: "years", trigger: "tenant_policy" };
  };
  const holds = await activeHolds(tx);
  const ended = row.subjectPersonId
    ? ((await careEndedOn(tx, [row.subjectPersonId])).get(row.subjectPersonId) ?? null)
    : null;
  const byTable = new Map<string, string[]>();
  for (const i of items)
    byTable.set(i.tableName, [...(byTable.get(i.tableName) ?? []), i.recordId]);
  const created = new Map<string, Date>();
  for (const [table, ids] of byTable) {
    if (!("created_at" in (EXPORT_TABLES[`public.${table}`]?.columns ?? {}))) continue;
    const result = await tx.execute<{ id: string; created_at: string }>(
      sql`SELECT t.id::text AS id, t.created_at FROM ${sql.identifier(table)} t
          WHERE t.id::text IN (${sql.join(
            ids.map((i) => sql`${i}`),
            sql`, `,
          )})`,
    );
    for (const r of result.rows) created.set(`${table}:${r.id}`, new Date(r.created_at));
  }
  return items.map((i) => {
    const recordClass = EXPORT_TABLES[`public.${i.tableName}`]?.retention ?? "tenant_configuration";
    const rule = ruleFor(recordClass === "as_subject" ? "care_record" : recordClass);
    const triggerDate =
      rule.trigger === "care_ended"
        ? ended
        : rule.trigger === "created"
          ? (created.get(`${i.tableName}:${i.recordId}`) ?? null)
          : null;
    return {
      table: i.tableName,
      recordId: i.recordId,
      rule,
      triggerDate,
      legalHold: isUnderLegalHold(
        { personId: row.subjectPersonId, subjectType: i.tableName, subjectId: i.recordId },
        holds,
      ),
    };
  });
}

export const itemsOfCase = (tx: Transaction, caseId: string) =>
  tx
    .select()
    .from(dsarItem)
    .where(and(eq(dsarItem.caseId, caseId), isNull(dsarItem.deletedAt)));
