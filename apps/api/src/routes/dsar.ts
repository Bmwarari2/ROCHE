import { createHash, randomUUID } from "node:crypto";
import {
  DsarBundle,
  DsarCase,
  DsarCaseList,
  DsarCollectResult,
  DsarErasureInput,
  DsarExtensionInput,
  DsarIdentityInput,
  DsarItem,
  DsarItemDecisionInput,
  DsarItemDetail,
  DsarItemList,
  DsarPauseEnd,
  DsarPauseStart,
  DsarRectificationInput,
  DsarRespondInput,
  NewDsarCase,
} from "@harbour/contracts";
import { dsarCase, dsarItem, type Transaction } from "@harbour/db";
import {
  applyRedactions,
  bundleReadiness,
  checkItemDecision,
  checkNewDsarCase,
  type DsarItemDecision,
  type DsarSubjectKind,
  dsarBundleStorageKey,
  dsarNotSearched,
  dsarNotSearchedOf,
  erasureAssessment,
  findThirdPartyNames,
  portabilityApplies,
} from "@harbour/domain";
import { createRoute, z } from "@hono/zod-openapi";
import { and, desc, eq, inArray } from "drizzle-orm";
import type { Context } from "hono";
import { auditInTx } from "../http/audit";
import {
  type AppEnv,
  requirePermission,
  stepUpRefusal,
  type TenantAccess,
  withTenant,
} from "../http/context";
import { HttpProblem, problems } from "../http/problem";
import {
  asOrganisation,
  type CaseRow,
  caseOf,
  caseProblem,
  clockContext,
  clockOf,
  collectRecords,
  DSAR_ITEM_LIMIT,
  disclosableColumns,
  erasureCandidates,
  type ItemRow,
  itemsOfCase,
  loadCase,
  pausesOf,
  recordsOf,
  requireClock,
  requireOpen,
  SUBJECT_MAP,
  subjectIdOf,
  subjectNames,
  summaryOf,
  thirdPartyNames,
} from "../services/dsar";
import { staffNames } from "../services/staff";
import {
  conflictResponse,
  createRouter,
  errorResponses,
  jsonBody,
  notFoundResponse,
  security,
} from "./openapi";

/**
 * The DSAR workbench (PLAT-022; platform.md, Phase 2: the DSAR workbench; ADR-0090; section 5.1).
 * Every route needs `quality.dsar.manage` with MFA (a care-record permission); row-level security
 * (migration 0077) checks it again. Writes send the case's `version` (409 when stale). Every read
 * and write is audited with the case id, counts and opaque ids, never a name or record content.
 */

const PERMISSION = "quality.dsar.manage" as const;

const A = {
  listed: "platform.dsar.listed",
  viewed: "platform.dsar.viewed",
  created: "platform.dsar.created",
  identity: "platform.dsar.identity_verified",
  paused: "platform.dsar.paused",
  resumed: "platform.dsar.resumed",
  extended: "platform.dsar.extended",
  collected: "platform.dsar.collected",
  itemsListed: "platform.dsar.items_listed",
  itemViewed: "platform.dsar.item_viewed",
  decided: "platform.dsar.item_decided",
  reset: "platform.dsar.items_reset",
  subjectViewed: "platform.dsar.subject_record_viewed",
  issuedFetched: "platform.dsar.issued_bundle_fetched",
  bundle: "platform.dsar.bundle_generated",
  responded: "platform.dsar.responded",
  rectification: "platform.dsar.rectification_recorded",
  erasure: "platform.dsar.erasure_assessed",
} as const;

const IdParam = z.object({ id: z.uuid() });
const ItemParam = z.object({ id: z.uuid(), itemId: z.uuid() });
const tags = ["platform"];

const audit = (
  c: Context<AppEnv>,
  tx: Transaction,
  access: TenantAccess,
  action: string,
  caseId: string | undefined,
  scope: Record<string, unknown> = {},
) =>
  auditInTx(tx, access, {
    action,
    resourceType: "dsar_case",
    ...(caseId ? { resourceId: caseId } : {}),
    scope,
    requestId: c.get("requestId"),
  });

/**
 * Requires quality.dsar.manage held across the whole organisation (#149 H1): a case reaches
 * every module and every person, so a location role never runs one. Routes that disclose
 * records (the item view, the bundle, the response) also need a fresh step-up (#149 H2).
 */
async function requireDsar(
  c: Context<AppEnv>,
  options: { stepUp?: boolean } = {},
): Promise<TenantAccess> {
  const access = await requirePermission(c, PERMISSION);
  if (access.context.scope !== "tenant") {
    throw new HttpProblem(
      403,
      "dsar_needs_organisation_role",
      "Data subject requests are handled by someone with an organisation-wide role.",
    );
  }
  if (options.stepUp && !access.stepUpFresh) throw stepUpRefusal(access);
  return access;
}

/** Nothing is disclosed or closed as done before the requester's identity is confirmed (#149 M4). */
function requireIdentity(row: CaseRow): void {
  if (row.identityRequired && !row.identityVerifiedOn) {
    throw new HttpProblem(
      409,
      "dsar_identity_not_verified",
      "Confirm the requester's identity before responding.",
    );
  }
}

/** Applies a change to an open case at the version read, or refuses it as stale. */
async function changeCase(
  tx: Transaction,
  row: CaseRow,
  expectedVersion: number,
  set: Partial<typeof dsarCase.$inferInsert>,
): Promise<CaseRow> {
  if (row.version !== expectedVersion) throw caseProblem.stale();
  const [saved] = await tx
    .update(dsarCase)
    .set(set)
    .where(and(eq(dsarCase.id, row.id), eq(dsarCase.version, expectedVersion)))
    .returning();
  if (!saved) throw caseProblem.stale();
  return saved;
}

const today = () => new Date().toISOString().slice(0, 10);

function requireNotFuture(day: string, after: string, what: string) {
  if (day > today()) throw problems.invalid(`The ${what} cannot be in the future.`);
  if (day < after) throw problems.invalid(`The ${what} cannot be before the request arrived.`);
}

const itemOf = (row: ItemRow, names: Awaited<ReturnType<typeof staffNames>>) => ({
  id: row.id,
  tableName: row.tableName,
  recordId: row.recordId,
  decision: row.decision as DsarItemDecision,
  redactedFields: row.redactedFields,
  reason: row.reason,
  reviewedBy: names(row.reviewedBy),
  reviewedAt: row.reviewedAt?.toISOString() ?? null,
  version: row.version,
});

/** Canonical JSON (sorted keys) so the bundle's hash is stable. */
export function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value !== null && typeof value === "object") {
    return `{${Object.keys(value)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${canonical((value as Record<string, unknown>)[k])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value ?? null);
}

/** SHA-256 of a record as the reviewer sees it (its disclosable columns), for #149 M3. */
export function recordSha256(record: Record<string, unknown>): string {
  return createHash("sha256").update(canonical(record)).digest("hex");
}

/** Every string in a field, with its path inside JSON (#149 M5: JSON fields are scanned too). */
export function stringsIn(value: unknown, path: string): { field: string; text: string }[] {
  if (typeof value === "string") return [{ field: path, text: value }];
  if (Array.isArray(value)) return value.flatMap((v, i) => stringsIn(v, `${path}[${i}]`));
  if (value !== null && typeof value === "object")
    return Object.entries(value).flatMap(([k, v]) => stringsIn(v, `${path}.${k}`));
  return [];
}

/** Builds the bundle from the decided items (rule 5); refuses until every item is decided. */
async function buildBundle(
  c: Context<AppEnv>,
  access: TenantAccess,
  row: CaseRow,
  items: readonly ItemRow[],
  format: "access" | "portable",
) {
  const readiness = bundleReadiness(
    items.map((i) => ({ decision: i.decision as DsarItemDecision })),
  );
  if (!readiness.ready) throw caseProblem.notReady(readiness.pending);
  requireIdentity(row);
  const shown = items.filter((i) => i.decision === "disclose" || i.decision === "redact");
  const byTable = new Map<string, ItemRow[]>();
  for (const i of items) byTable.set(i.tableName, [...(byTable.get(i.tableName) ?? []), i]);
  const records: { table: string; recordId: string; fields: Record<string, unknown> }[] = [];
  const changed: string[] = [];
  await asOrganisation(c, access, async (tx) => {
    for (const [table, list] of [...byTable].sort(([a], [b]) => a.localeCompare(b))) {
      const found = await recordsOf(
        tx,
        table,
        list.map((i) => i.recordId),
      );
      for (const i of list.sort((a, b) => a.recordId.localeCompare(b.recordId))) {
        const record = found.get(i.recordId);
        // A record changed or gone since it was decided goes back for review (#149 M3).
        if (!record || recordSha256(record) !== i.contentSha256) {
          changed.push(i.id);
          continue;
        }
        if (i.decision === "withhold") continue;
        records.push({
          table,
          recordId: i.recordId,
          fields: i.decision === "redact" ? applyRedactions(record, i.redactedFields) : record,
        });
      }
    }
  });
  if (changed.length > 0) {
    await withTenant(c, async (tx) => {
      await tx
        .update(dsarItem)
        .set({
          decision: "pending",
          redactedFields: [],
          reason: null,
          reviewedBy: null,
          reviewedAt: null,
          contentSha256: null,
        })
        .where(and(eq(dsarItem.caseId, row.id), inArray(dsarItem.id, changed)));
      await audit(c, tx, access, A.reset, row.id, { items: changed.length });
    });
    throw new HttpProblem(
      409,
      "dsar_records_changed",
      "Some records changed after they were reviewed.",
      `${changed.length} returned for review.`,
    );
  }
  const redactedCount = shown.filter((i) => i.decision === "redact").length;
  const withheldCount = readiness.withheld;
  const sha256 = createHash("sha256")
    .update(canonical({ records, redactedCount, withheldCount }))
    .digest("hex");
  return {
    caseId: row.id,
    format,
    generatedAt: new Date().toISOString(),
    subjectKind: row.subjectKind as DsarSubjectKind,
    records,
    redactedCount,
    withheldCount,
    notSearched: row.notSearched.map((t) => dsarNotSearchedOf(t)),
    sha256,
  };
}

export const dsarRouter = createRouter()
  .openapi(
    createRoute({
      method: "get",
      path: "/v1/dsar-cases",
      tags,
      summary: "Data subject requests, newest first, with each one's clock",
      description: `${PERMISSION} with MFA. Audited with the count.`,
      security,
      responses: { 200: jsonBody(DsarCaseList, "The requests"), ...errorResponses },
    }),
    async (c) => {
      const access = await requireDsar(c);
      const body = await withTenant(c, async (tx) => {
        const rows = await tx
          .select()
          .from(dsarCase)
          .orderBy(desc(dsarCase.receivedOn), desc(dsarCase.id))
          .limit(500);
        const ctx = await clockContext(tx, access.tenantId);
        const subject = await subjectNames(tx, rows);
        await audit(c, tx, access, A.listed, undefined, { count: rows.length });
        return { items: rows.map((r) => summaryOf(r, subject, ctx)) };
      });
      return c.json(body, 200);
    },
  )
  .openapi(
    createRoute({
      method: "post",
      path: "/v1/dsar-cases",
      tags,
      summary: "Record a data subject request",
      description: `${PERMISSION} with MFA. The subject must match its kind (a contact names its person too); a representative needs an authority. Audited.`,
      security,
      request: { body: { content: { "application/json": { schema: NewDsarCase } } } },
      responses: { 201: jsonBody(DsarCase, "Recorded"), ...errorResponses },
    }),
    async (c) => {
      const access = await requireDsar(c);
      const input = c.req.valid("json");
      const check = checkNewDsarCase({ ...input, today: today() });
      if (!check.ok) throw problems.invalid(check.problem);
      const body = await withTenant(c, async (tx) => {
        let row: CaseRow | undefined;
        try {
          [row] = await tx
            .insert(dsarCase)
            .values({
              requestKind: input.requestKind,
              subjectKind: input.subjectKind,
              subjectPersonId: input.subjectPersonId,
              subjectContactId: input.subjectContactId,
              subjectStaffId: input.subjectStaffId,
              requesterKind: input.requesterKind,
              requesterName: input.requesterName,
              requesterAddress: input.requesterAddress,
              authority: input.authority,
              channel: input.channel,
              receivedOn: input.receivedOn,
              identityRequired: input.identityRequired,
            })
            .returning();
        } catch (error) {
          // A subject outside the organisation fails its composite foreign key.
          const pgError = (error as { cause?: { code?: string } }).cause ?? error;
          const code = (pgError as { code?: string }).code;
          if (code === "23503") throw problems.invalid("subject_not_found");
          // A shape the checks refuse: answered in words, never with the query (#149 M6).
          if (code === "23514") throw problems.invalid("request_shape_refused");
          throw error;
        }
        if (!row) throw problems.conflict();
        await audit(c, tx, access, A.created, row.id, {
          requestKind: row.requestKind,
          subjectKind: row.subjectKind,
        });
        return caseOf(tx, row, await clockContext(tx, access.tenantId));
      });
      return c.json(body, 201);
    },
  )
  .openapi(
    createRoute({
      method: "get",
      path: "/v1/dsar-cases/{id}",
      tags,
      summary: "A data subject request, with its clock worked out now",
      description: `${PERMISSION} with MFA. Audited.`,
      security,
      request: { params: IdParam },
      responses: {
        200: jsonBody(DsarCase, "The request"),
        ...errorResponses,
        ...notFoundResponse,
      },
    }),
    async (c) => {
      const access = await requireDsar(c);
      const { id } = c.req.valid("param");
      const body = await withTenant(c, async (tx) => {
        const row = await loadCase(tx, id);
        await audit(c, tx, access, A.viewed, id);
        return caseOf(tx, row, await clockContext(tx, access.tenantId));
      });
      return c.json(body, 200);
    },
  )
  .openapi(
    createRoute({
      method: "post",
      path: "/v1/dsar-cases/{id}/identity",
      tags,
      summary: "Record that the requester's identity was confirmed (the clock starts that day)",
      description: `${PERMISSION} with MFA. Records how, never the document. Audited.`,
      security,
      request: {
        params: IdParam,
        body: { content: { "application/json": { schema: DsarIdentityInput } } },
      },
      responses: {
        200: jsonBody(DsarCase, "Recorded"),
        ...errorResponses,
        ...notFoundResponse,
        ...conflictResponse,
      },
    }),
    async (c) => {
      const access = await requireDsar(c);
      const { id } = c.req.valid("param");
      const input = c.req.valid("json");
      const body = await withTenant(c, async (tx) => {
        const row = await loadCase(tx, id);
        requireOpen(row);
        requireNotFuture(input.verifiedOn, row.receivedOn, "day identity was confirmed");
        const ctx = await clockContext(tx, access.tenantId);
        const change = { identityVerifiedOn: input.verifiedOn, identityMethod: input.method };
        requireClock(clockOf(row, ctx, change));
        const saved = await changeCase(tx, row, input.expectedVersion, change);
        await audit(c, tx, access, A.identity, id, { method: input.method });
        return caseOf(tx, saved, ctx);
      });
      return c.json(body, 200);
    },
  )
  .openapi(
    createRoute({
      method: "post",
      path: "/v1/dsar-cases/{id}/pauses",
      tags,
      summary: "Pause the clock while clarification is awaited",
      description: `${PERMISSION} with MFA. One pause open at a time. Audited.`,
      security,
      request: {
        params: IdParam,
        body: { content: { "application/json": { schema: DsarPauseStart } } },
      },
      responses: {
        200: jsonBody(DsarCase, "Paused"),
        ...errorResponses,
        ...notFoundResponse,
        ...conflictResponse,
      },
    }),
    async (c) => {
      const access = await requireDsar(c);
      const { id } = c.req.valid("param");
      const input = c.req.valid("json");
      const body = await withTenant(c, async (tx) => {
        const row = await loadCase(tx, id);
        requireOpen(row);
        requireNotFuture(input.from, row.receivedOn, "pause");
        const pauses = pausesOf(row);
        if (pauses.some((p) => p.to === null)) throw problems.invalid("A pause is already open.");
        const ctx = await clockContext(tx, access.tenantId);
        const change = { pauses: [...pauses, { from: input.from, to: null }] };
        requireClock(clockOf(row, ctx, change));
        const saved = await changeCase(tx, row, input.expectedVersion, change);
        await audit(c, tx, access, A.paused, id, { pauses: change.pauses.length });
        return caseOf(tx, saved, ctx);
      });
      return c.json(body, 200);
    },
  )
  .openapi(
    createRoute({
      method: "post",
      path: "/v1/dsar-cases/{id}/pauses/end",
      tags,
      summary: "Restart the clock when the clarification arrives",
      description: `${PERMISSION} with MFA. Audited.`,
      security,
      request: {
        params: IdParam,
        body: { content: { "application/json": { schema: DsarPauseEnd } } },
      },
      responses: {
        200: jsonBody(DsarCase, "Resumed"),
        ...errorResponses,
        ...notFoundResponse,
        ...conflictResponse,
      },
    }),
    async (c) => {
      const access = await requireDsar(c);
      const { id } = c.req.valid("param");
      const input = c.req.valid("json");
      const body = await withTenant(c, async (tx) => {
        const row = await loadCase(tx, id);
        requireOpen(row);
        requireNotFuture(input.to, row.receivedOn, "day the clarification arrived");
        const pauses = pausesOf(row);
        if (!pauses.some((p) => p.to === null)) throw problems.invalid("No pause is open.");
        const ctx = await clockContext(tx, access.tenantId);
        const change = { pauses: pauses.map((p) => (p.to === null ? { ...p, to: input.to } : p)) };
        requireClock(clockOf(row, ctx, change));
        const saved = await changeCase(tx, row, input.expectedVersion, change);
        await audit(c, tx, access, A.resumed, id, { pauses: pauses.length });
        return caseOf(tx, saved, ctx);
      });
      return c.json(body, 200);
    },
  )
  .openapi(
    createRoute({
      method: "post",
      path: "/v1/dsar-cases/{id}/extension",
      tags,
      summary: "Extend the deadline for a complex request or several requests",
      description: `${PERMISSION} with MFA. Decided before the original due date, by no more than the rate table allows, with a reason. Audited.`,
      security,
      request: {
        params: IdParam,
        body: { content: { "application/json": { schema: DsarExtensionInput } } },
      },
      responses: {
        200: jsonBody(DsarCase, "Extended"),
        ...errorResponses,
        ...notFoundResponse,
        ...conflictResponse,
      },
    }),
    async (c) => {
      const access = await requireDsar(c);
      const { id } = c.req.valid("param");
      const input = c.req.valid("json");
      const body = await withTenant(c, async (tx) => {
        const row = await loadCase(tx, id);
        requireOpen(row);
        requireNotFuture(input.decidedOn, row.receivedOn, "day the extension was decided");
        const ctx = await clockContext(tx, access.tenantId);
        const change = {
          extensionMonths: input.months,
          extensionGrounds: input.grounds,
          extensionReason: input.reason,
          extensionDecidedOn: input.decidedOn,
        };
        requireClock(clockOf(row, ctx, change));
        const saved = await changeCase(tx, row, input.expectedVersion, change);
        await audit(c, tx, access, A.extended, id, {
          months: input.months,
          grounds: input.grounds,
        });
        return caseOf(tx, saved, ctx);
      });
      return c.json(body, 200);
    },
  )
  .openapi(
    createRoute({
      method: "post",
      path: "/v1/dsar-cases/{id}/collect",
      tags,
      summary: "Find the subject's records across every module",
      description: `${PERMISSION} with MFA. Searches every exported table with personal data by its subject column (the export catalogue); lists those it cannot search. Collecting again adds only new records. Stops at ${DSAR_ITEM_LIMIT} records. Audited with counts.`,
      security,
      request: { params: IdParam },
      responses: {
        200: jsonBody(DsarCollectResult, "Collected"),
        ...errorResponses,
        ...notFoundResponse,
        ...conflictResponse,
      },
    }),
    async (c) => {
      const access = await requireDsar(c);
      const { id } = c.req.valid("param");
      const row = await withTenant(c, async (tx) => {
        const r = await loadCase(tx, id);
        requireOpen(r);
        return r;
      });
      const kind = row.subjectKind as DsarSubjectKind;
      // Named with reasons on the case and the bundle's cover, never a silent gap (rule 3).
      const notSearched = dsarNotSearched(SUBJECT_MAP, kind);
      const collected = await asOrganisation(c, access, (tx) =>
        collectRecords(tx, kind, subjectIdOf(row), DSAR_ITEM_LIMIT),
      );
      const body = await withTenant(c, async (tx) => {
        const fresh = await loadCase(tx, id);
        requireOpen(fresh);
        let added = 0;
        for (let i = 0; i < collected.found.length; i += 500) {
          const chunk = collected.found.slice(i, i + 500);
          const inserted = await tx
            .insert(dsarItem)
            .values(chunk.map(([tableName, recordId]) => ({ caseId: id, tableName, recordId })))
            .onConflictDoNothing()
            .returning({ id: dsarItem.id });
          added += inserted.length;
        }
        await tx
          .update(dsarCase)
          .set({ collectedAt: new Date(), notSearched: notSearched.map((e) => e.table) })
          .where(eq(dsarCase.id, id));
        const total = (await itemsOfCase(tx, id)).length;
        await audit(c, tx, access, A.collected, id, {
          added,
          total,
          tablesSearched: collected.tablesSearched,
          truncated: collected.truncated,
          read: "organisation",
        });
        return {
          added,
          total,
          tablesSearched: collected.tablesSearched,
          notSearched,
          truncated: collected.truncated,
        };
      });
      return c.json(body, 200);
    },
  )
  .openapi(
    createRoute({
      method: "get",
      path: "/v1/dsar-cases/{id}/items",
      tags,
      summary: "The records collected for a request and the decision on each",
      description: `${PERMISSION} with MFA. Tables and ids only, no content. Audited with the count.`,
      security,
      request: { params: IdParam },
      responses: {
        200: jsonBody(DsarItemList, "The records"),
        ...errorResponses,
        ...notFoundResponse,
      },
    }),
    async (c) => {
      const access = await requireDsar(c);
      const { id } = c.req.valid("param");
      const body = await withTenant(c, async (tx) => {
        await loadCase(tx, id);
        const rows = (await itemsOfCase(tx, id)).sort(
          (a, b) => a.tableName.localeCompare(b.tableName) || a.recordId.localeCompare(b.recordId),
        );
        const names = await staffNames(
          tx,
          rows.map((r) => r.reviewedBy),
        );
        await audit(c, tx, access, A.itemsListed, id, { count: rows.length });
        return { items: rows.map((r) => itemOf(r, names)), total: rows.length };
      });
      return c.json(body, 200);
    },
  )
  .openapi(
    createRoute({
      method: "get",
      path: "/v1/dsar-cases/{id}/items/{itemId}",
      tags,
      summary: "One collected record, with other people's names highlighted for review",
      description: `${PERMISSION} with MFA. The record as the export shows it; highlights redact nothing. Audited as a care-record view.`,
      security,
      request: { params: ItemParam },
      responses: {
        200: jsonBody(DsarItemDetail, "The record"),
        ...errorResponses,
        ...notFoundResponse,
      },
    }),
    async (c) => {
      const access = await requireDsar(c, { stepUp: true });
      const { id, itemId } = c.req.valid("param");
      const { row, item, names } = await withTenant(c, async (tx) => {
        const r = await loadCase(tx, id);
        const [i] = await tx
          .select()
          .from(dsarItem)
          .where(and(eq(dsarItem.id, itemId), eq(dsarItem.caseId, id)));
        if (!i) throw problems.notFound();
        await audit(c, tx, access, A.itemViewed, id, {
          itemId,
          table: i.tableName,
          recordId: i.recordId,
          read: "organisation",
        });
        // Also a view of the subject's records, in their own history (#149 L9).
        await auditInTx(tx, access, {
          action: A.subjectViewed,
          resourceType: r.subjectKind === "staff" ? "tenant_user" : r.subjectKind,
          resourceId: subjectIdOf(r),
          scope: { caseId: id, table: i.tableName, recordId: i.recordId, read: "organisation" },
          requestId: c.get("requestId"),
        });
        return { row: r, item: i, names: await staffNames(tx, [i.reviewedBy]) };
      });
      const { record, others } = await asOrganisation(c, access, async (tx) => ({
        record: (await recordsOf(tx, item.tableName, [item.recordId])).get(item.recordId) ?? null,
        others: await thirdPartyNames(tx, row),
      }));
      const highlights = record
        ? Object.entries(record).flatMap(([field, value]) =>
            stringsIn(value, field).flatMap((s) =>
              findThirdPartyNames(s.text, others).map((h) => ({ field: s.field, ...h })),
            ),
          )
        : [];
      return c.json(
        {
          ...itemOf(item, names),
          record,
          contentSha256: record ? recordSha256(record) : null,
          highlights,
        },
        200,
      );
    },
  )
  .openapi(
    createRoute({
      method: "post",
      path: "/v1/dsar-cases/{id}/items/{itemId}/decision",
      tags,
      summary: "Decide a record: disclose, redact named fields or withhold, with a reason",
      description: `${PERMISSION} with MFA. A redaction names the fields and a reason; withholding names a reason (the exemption). Send the item's version. Audited with the decision and the number of fields.`,
      security,
      request: {
        params: ItemParam,
        body: { content: { "application/json": { schema: DsarItemDecisionInput } } },
      },
      responses: {
        200: jsonBody(DsarItem, "Decided"),
        ...errorResponses,
        ...notFoundResponse,
        ...conflictResponse,
      },
    }),
    async (c) => {
      const access = await requireDsar(c);
      const { id, itemId } = c.req.valid("param");
      const input = c.req.valid("json");
      const body = await withTenant(c, async (tx) => {
        requireOpen(await loadCase(tx, id));
        const [item] = await tx
          .select()
          .from(dsarItem)
          .where(and(eq(dsarItem.id, itemId), eq(dsarItem.caseId, id)));
        if (!item) throw problems.notFound();
        const check = checkItemDecision(input, disclosableColumns(item.tableName));
        if (!check.ok) throw problems.invalid(check.problem);
        if (item.version !== input.expectedVersion) throw caseProblem.stale();
        // The decision is about the record the reviewer saw (#149 M3).
        const current = await asOrganisation(c, access, async (otx) =>
          (await recordsOf(otx, item.tableName, [item.recordId])).get(item.recordId),
        );
        if (!current || recordSha256(current) !== input.contentSha256) {
          throw new HttpProblem(
            409,
            "dsar_record_changed",
            "This record changed after you opened it.",
            "Open it again and review what it says now.",
          );
        }
        const [saved] = await tx
          .update(dsarItem)
          .set({
            decision: input.decision,
            redactedFields: input.decision === "redact" ? input.redactedFields : [],
            reason: input.decision === "disclose" ? null : input.reason,
            reviewedBy: access.tenantUserId,
            reviewedAt: new Date(),
            contentSha256: input.contentSha256,
          })
          .where(and(eq(dsarItem.id, itemId), eq(dsarItem.version, input.expectedVersion)))
          .returning();
        if (!saved) throw caseProblem.stale();
        await audit(c, tx, access, A.decided, id, {
          itemId,
          decision: saved.decision,
          fields: saved.redactedFields.length,
        });
        return itemOf(saved, await staffNames(tx, [saved.reviewedBy]));
      });
      return c.json(body, 200);
    },
  )
  .openapi(
    createRoute({
      method: "get",
      path: "/v1/dsar-cases/{id}/bundle",
      tags,
      summary: "The response bundle, once every record is decided",
      description: `${PERMISSION} with MFA. Redacted fields read [redacted]; withheld records are left out with a count. \`format=portable\` only where portability applies (staff records). Audited with counts and the hash.`,
      security,
      request: {
        params: IdParam,
        query: z.object({ format: z.enum(["access", "portable"]).default("access") }),
      },
      responses: {
        200: jsonBody(DsarBundle, "The bundle"),
        ...errorResponses,
        ...notFoundResponse,
        ...conflictResponse,
      },
    }),
    async (c) => {
      const access = await requireDsar(c, { stepUp: true });
      const { id } = c.req.valid("param");
      const { format } = c.req.valid("query");
      const { row, items } = await withTenant(c, async (tx) => ({
        row: await loadCase(tx, id),
        items: await itemsOfCase(tx, id),
      }));
      if (format === "portable" && !portabilityApplies(row.subjectKind as DsarSubjectKind).applies)
        throw caseProblem.noPortability();
      const bundle = await buildBundle(c, access, row, items, format);
      await withTenant(c, (tx) =>
        audit(c, tx, access, A.bundle, id, {
          format,
          records: bundle.records.length,
          redacted: bundle.redactedCount,
          withheld: bundle.withheldCount,
          sha256: bundle.sha256,
          read: "organisation",
        }),
      );
      c.header("cache-control", "private, no-store");
      return c.json(bundle, 200);
    },
  )
  .openapi(
    createRoute({
      method: "post",
      path: "/v1/dsar-cases/{id}/respond",
      tags,
      summary: "Record the response and close the request",
      description: `${PERMISSION} with MFA. Access and portability responses that disclose need every record decided, and record the bundle's SHA-256. A partial response or refusal needs reasons. A late response stays late. Audited.`,
      security,
      request: {
        params: IdParam,
        body: { content: { "application/json": { schema: DsarRespondInput } } },
      },
      responses: {
        200: jsonBody(DsarCase, "Closed"),
        ...errorResponses,
        ...notFoundResponse,
        ...conflictResponse,
      },
    }),
    async (c) => {
      const access = await requireDsar(c, { stepUp: true });
      const { id } = c.req.valid("param");
      const input = c.req.valid("json");
      if (
        (input.outcome === "partly_fulfilled" || input.outcome === "refused") &&
        !input.outcomeReason
      )
        throw problems.invalid("outcome_reason_required");
      const { row, items } = await withTenant(c, async (tx) => {
        const r = await loadCase(tx, id);
        requireOpen(r);
        return { row: r, items: await itemsOfCase(tx, id) };
      });
      requireNotFuture(input.respondedOn, row.receivedOn, "response");
      if (input.outcome === "fulfilled" || input.outcome === "partly_fulfilled")
        requireIdentity(row);
      const discloses =
        (row.requestKind === "access" || row.requestKind === "portability") &&
        (input.outcome === "fulfilled" || input.outcome === "partly_fulfilled");
      const bundle = discloses
        ? await buildBundle(
            c,
            access,
            row,
            items,
            row.requestKind === "portability" &&
              portabilityApplies(row.subjectKind as DsarSubjectKind).applies
              ? "portable"
              : "access",
          )
        : null;
      // The bundle as sent is kept (exports bucket, SSE-KMS, opaque key) and can be fetched again
      // exactly; it is removed if the response is not recorded (#149 M3).
      const storage = c.get("services").exportStorage;
      const storageKey = bundle ? dsarBundleStorageKey(access.tenantId, id, randomUUID()) : null;
      if (bundle && storageKey) {
        await storage.put(
          storageKey,
          new TextEncoder().encode(JSON.stringify(bundle)),
          "application/json",
        );
      }
      const body = await withTenant(c, async (tx) => {
        const ctx = await clockContext(tx, access.tenantId);
        const now = new Date();
        const saved = await changeCase(tx, await loadCase(tx, id), input.expectedVersion, {
          status: input.outcome === "withdrawn" ? "withdrawn" : "closed",
          outcome: input.outcome,
          outcomeReason: input.outcomeReason,
          respondedOn: input.respondedOn,
          // A pause still open ends on the day of the response.
          pauses: pausesOf(row).map((p) => (p.to === null ? { ...p, to: input.respondedOn } : p)),
          ...(bundle
            ? { bundleSha256: bundle.sha256, bundleIssuedAt: now, bundleStorageKey: storageKey }
            : {}),
        });
        const clock = clockOf(saved, ctx);
        await audit(c, tx, access, A.responded, id, {
          outcome: input.outcome,
          late: clock.ok ? clock.late : null,
          records: bundle?.records.length ?? 0,
          sha256: bundle?.sha256 ?? null,
        });
        return caseOf(tx, saved, ctx);
      }).catch(async (error: unknown) => {
        if (storageKey) await storage.destroy(storageKey).catch(() => undefined);
        throw error;
      });
      return c.json(body, 200);
    },
  )
  .openapi(
    createRoute({
      method: "post",
      path: "/v1/dsar-cases/{id}/rectification",
      tags,
      summary: "Record what was corrected, or why not, for a rectification request",
      description: `${PERMISSION} with MFA. Recorded only: the correction itself is made in the module as a new version or a superseding entry. Audited with the count.`,
      security,
      request: {
        params: IdParam,
        body: { content: { "application/json": { schema: DsarRectificationInput } } },
      },
      responses: {
        200: jsonBody(DsarCase, "Recorded"),
        ...errorResponses,
        ...notFoundResponse,
        ...conflictResponse,
      },
    }),
    async (c) => {
      const access = await requireDsar(c);
      const { id } = c.req.valid("param");
      const input = c.req.valid("json");
      const body = await withTenant(c, async (tx) => {
        const row = await loadCase(tx, id);
        requireOpen(row);
        if (row.requestKind !== "rectification") throw caseProblem.wrongKind("rectification");
        for (const d of input.decisions) requireNotFuture(d.decidedOn, row.receivedOn, "decision");
        const previous = Array.isArray(row.rectification) ? row.rectification : [];
        const saved = await changeCase(tx, row, input.expectedVersion, {
          rectification: [...previous, ...input.decisions],
        });
        await audit(c, tx, access, A.rectification, id, {
          added: input.decisions.length,
          corrected: input.decisions.filter((d) => d.decision === "corrected").length,
        });
        return caseOf(tx, saved, await clockContext(tx, access.tenantId));
      });
      return c.json(body, 200);
    },
  )
  .openapi(
    createRoute({
      method: "post",
      path: "/v1/dsar-cases/{id}/erasure",
      tags,
      summary: "Assess erasure of the collected records against retention, and record it",
      description: `${PERMISSION} with MFA. A record under a legal hold or within its retention period is kept; only what retention allows is listed as erasable. Recorded only: the retention engine destroys records, never the workbench. Audited with counts.`,
      security,
      request: {
        params: IdParam,
        body: { content: { "application/json": { schema: DsarErasureInput } } },
      },
      responses: {
        200: jsonBody(DsarCase, "Assessed"),
        ...errorResponses,
        ...notFoundResponse,
        ...conflictResponse,
      },
    }),
    async (c) => {
      const access = await requireDsar(c);
      const { id } = c.req.valid("param");
      const input = c.req.valid("json");
      const { row, items } = await withTenant(c, async (tx) => {
        const r = await loadCase(tx, id);
        requireOpen(r);
        if (r.requestKind !== "erasure") throw caseProblem.wrongKind("erasure");
        return { row: r, items: await itemsOfCase(tx, id) };
      });
      if (items.length === 0)
        throw new HttpProblem(409, "dsar_not_collected", "Collect the records first.");
      const now = new Date();
      const assessed = erasureAssessment(
        await asOrganisation(c, access, (tx) => erasureCandidates(tx, access.tenantId, row, items)),
        now,
      );
      const groups = new Map<
        string,
        { recordClass: string; outcome: string; count: number; until: string | null }
      >();
      for (const a of assessed) {
        const key = `${a.recordClass}:${a.outcome}`;
        const until = a.until?.toISOString().slice(0, 10) ?? null;
        const g = groups.get(key) ?? {
          recordClass: a.recordClass,
          outcome: a.outcome,
          count: 0,
          until: null,
        };
        g.count += 1;
        if (until && (!g.until || until > g.until)) g.until = until;
        groups.set(key, g);
      }
      const tally = (o: string) => assessed.filter((a) => a.outcome === o).length;
      const record = {
        assessedAt: now.toISOString(),
        held: tally("held"),
        retained: tally("retained"),
        erasable: tally("erasable"),
        byClass: [...groups.values()].sort(
          (a, b) =>
            a.recordClass.localeCompare(b.recordClass) || a.outcome.localeCompare(b.outcome),
        ),
      };
      const body = await withTenant(c, async (tx) => {
        const saved = await changeCase(tx, await loadCase(tx, id), input.expectedVersion, {
          erasure: record,
        });
        await audit(c, tx, access, A.erasure, id, {
          held: record.held,
          retained: record.retained,
          erasable: record.erasable,
          read: "organisation",
        });
        return caseOf(tx, saved, await clockContext(tx, access.tenantId));
      });
      return c.json(body, 200);
    },
  )
  .openapi(
    createRoute({
      method: "get",
      path: "/v1/dsar-cases/{id}/bundle/issued",
      tags,
      summary: "The bundle exactly as it was sent",
      description: `${PERMISSION} across the organisation, with step-up. The stored copy whose SHA-256 the response recorded. Audited.`,
      security,
      request: { params: IdParam },
      responses: {
        200: jsonBody(DsarBundle, "The bundle as sent"),
        ...errorResponses,
        ...notFoundResponse,
      },
    }),
    async (c) => {
      const access = await requireDsar(c, { stepUp: true });
      const { id } = c.req.valid("param");
      const row = await withTenant(c, async (tx) => {
        const r = await loadCase(tx, id);
        if (!r.bundleStorageKey) throw problems.notFound();
        await audit(c, tx, access, A.issuedFetched, id, { sha256: r.bundleSha256 });
        return r;
      });
      const bytes = await c.get("services").exportStorage.get(row.bundleStorageKey as string);
      if (!bytes) throw problems.notFound();
      c.header("cache-control", "private, no-store");
      return c.json(JSON.parse(new TextDecoder().decode(bytes)) as z.infer<typeof DsarBundle>, 200);
    },
  );
