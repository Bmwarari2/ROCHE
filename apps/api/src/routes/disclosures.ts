import { createHash, randomUUID } from "node:crypto";
import {
  DecideDisclosure,
  DisclosureCollectResult,
  DisclosureItemDetail,
  DisclosureItemList,
  DisclosureLog,
  DisclosurePack,
  DisclosureRequestOut,
  DisclosureVersioned,
  DsarItemDecisionInput,
  LogDisclosureRequest,
  RecordPreventionReport,
  WithdrawDisclosure,
} from "@harbour/contracts";
import {
  careNote,
  disclosureItem,
  disclosureRequest,
  person,
  rateTable,
  type Transaction,
  tenant,
} from "@harbour/db";
import {
  ahraDueAt,
  applyRedactions,
  bundleReadiness,
  checkItemDecision,
  type DisclosureType,
  type DsarItemDecision,
  disclosurePackStorageKey,
  disclosurePrepareProblems,
  dsarNotSearched,
  dsarNotSearchedOf,
  findThirdPartyNames,
  legalBasis,
  type Permission,
  type RateNation,
  resolveRate,
  resolveSafetyPhase2Rates,
  scopeFor,
  ukIsoDate,
} from "@harbour/domain";
import { createRoute, z } from "@hono/zod-openapi";
import { and, desc, eq, max } from "drizzle-orm";
import type { Context } from "hono";
import { auditInTx } from "../http/audit";
import {
  type AppEnv,
  requireAnyPermission,
  requirePermission,
  stepUpRefusal,
  type TenantAccess,
  withTenant,
} from "../http/context";
import { HttpProblem, problems } from "../http/problem";
import {
  asOrganisation,
  type CaseRow,
  collectRecords,
  DSAR_ITEM_LIMIT,
  disclosableColumns,
  recordsOf,
  SUBJECT_MAP,
  thirdPartyNames,
} from "../services/dsar";
import { canonical, recordSha256, stringsIn } from "./dsar";
import {
  conflictResponse,
  createRouter,
  errorResponses,
  jsonBody,
  notFoundResponse,
  security,
} from "./openapi";
import { dbCode } from "./people-shared";

/**
 * Disclosure requests (SAFE-016; safety.md section 11, rules 38 to 44): one person's records for a
 * coroner, a Safeguarding Adults Review, a Domestic Homicide Review, the police, a solicitor or an
 * Access to Health Records Act request, each with its legal basis. Collection reuses the DSAR
 * collector in the organisation's context after the route has authorised the member (ADR-0090);
 * every record is reviewed by a person; the approver is never the person who logged it; release
 * needs a fresh step-up and stores the pack as sent. The member's permission must reach the
 * person's location (or the whole organisation), as row-level security checks again. Audited with
 * ids, codes and counts only.
 */

type Tx = Transaction;
type RequestRow = typeof disclosureRequest.$inferSelect;
type ItemRow = typeof disclosureItem.$inferSelect;

const MANAGE: Permission = "safety.incident.manage";
const APPROVE: Permission = "safety.disclosure.approve";
const LOG_LIMIT = 1000;
const OWN_TABLES = new Set(["disclosure_request", "disclosure_item"]);
const tags = ["safety"];
const IdParam = z.object({ id: z.uuid() });
const ItemParam = z.object({ id: z.uuid(), itemId: z.uuid() });
const unprocessable = (code: string, title: string) => new HttpProblem(422, code, title);
const stale = () => problems.conflict();

/** The member holds `permission` across the organisation or at `locationId` (rule 38). */
function reaches(access: TenantAccess, permission: Permission, locationId: string): boolean {
  const scope = scopeFor(access.effective, permission);
  return (
    scope.scope === "tenant" ||
    (scope.scope === "locations" && scope.locationIds.includes(locationId))
  );
}

function requireReach(access: TenantAccess, permission: Permission, locationId: string) {
  if (!reaches(access, permission, locationId)) {
    throw new HttpProblem(
      403,
      "missing_permission",
      "This request is about someone at a home you do not manage.",
    );
  }
}

/** Either disclosure permission reaches the location (reads: the request, items, the pack). */
function requireReachAny(access: TenantAccess, locationId: string) {
  if (!reaches(access, MANAGE, locationId)) requireReach(access, APPROVE, locationId);
}

function requireStepUp(access: TenantAccess) {
  if (!access.stepUpFresh) throw stepUpRefusal(access);
}

const audit = (
  c: Context<AppEnv>,
  tx: Tx,
  access: TenantAccess,
  action: string,
  id: string | null,
  scope: Record<string, unknown> = {},
) =>
  auditInTx(tx, access, {
    action: `safety.disclosure.${action}`,
    resourceType: "disclosure_request",
    ...(id ? { resourceId: id } : {}),
    scope,
    requestId: c.get("requestId"),
  });

/** Database refusals said plainly; the database's message never passes on. */
async function inTx<T>(c: Context<AppEnv>, fn: (tx: Tx) => Promise<T>): Promise<T> {
  try {
    return await withTenant(c, fn);
  } catch (error) {
    const code = dbCode(error);
    const message = (error as { message?: string }).message ?? "";
    if (code === "23514") {
      const guard = /^disclosure_[a-z_]+$/.test(message) ? message : "not_allowed";
      throw unprocessable(guard, "That change is not allowed for this request.");
    }
    if (code === "42501") throw problems.forbidden();
    throw error;
  }
}

async function loadRequest(tx: Tx, id: string): Promise<RequestRow> {
  const [row] = await tx.select().from(disclosureRequest).where(eq(disclosureRequest.id, id));
  if (!row) throw problems.notFound();
  return row;
}

const itemsOf = (tx: Tx, requestId: string) =>
  tx.select().from(disclosureItem).where(eq(disclosureItem.requestId, requestId));

async function preventionDays(tx: Tx, tenantId: string, nation: string, on: string) {
  const rows = await tx
    .select()
    .from(rateTable)
    .where(eq(rateTable.key, "coroner.prevention_report_response_days"));
  return Number(
    resolveRate(
      rows.map((r) => ({
        key: r.key,
        value: r.value,
        unit: r.unit,
        nation: r.nation,
        validFrom: r.validFrom,
        validTo: r.validTo,
        tenantId: r.tenantId,
        verificationStatus: r.verificationStatus,
        source: r.source,
      })),
      "coroner.prevention_report_response_days",
      nation as Exclude<RateNation, "uk" | "all">,
      on,
      tenantId,
    ).value,
  );
}

const addDays = (day: string, n: number) =>
  new Date(Date.parse(`${day}T12:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);

async function requestOut(tx: Tx, access: TenantAccess, row: RequestRow) {
  const items = await itemsOf(tx, row.id);
  const count = (d: string) => items.filter((i) => i.decision === d).length;
  let prevention: z.infer<typeof DisclosureRequestOut>["prevention"] = null;
  if (row.preventionReportOn) {
    const [t] = await tx.select({ nation: tenant.nation }).from(tenant);
    const days = await preventionDays(
      tx,
      access.tenantId,
      t?.nation ?? "england",
      row.preventionReportOn,
    );
    const due = addDays(row.preventionReportOn, days);
    prevention = {
      reportOn: row.preventionReportOn,
      responseDueOn: due,
      respondedOn: row.preventionRespondedOn,
      state: row.preventionRespondedOn
        ? "responded"
        : ukIsoDate(new Date()) > due
          ? "overdue"
          : "due",
    };
  }
  return {
    id: row.id,
    personId: row.personId,
    locationId: row.locationId,
    type: row.type as z.infer<typeof DisclosureRequestOut>["type"],
    legalBasis: row.legalBasis,
    requester: {
      name: row.requesterName,
      organisation: row.requesterOrganisation,
      reference: row.requesterReference,
    },
    statedPurpose: row.statedPurpose,
    receivedAt: row.receivedAt.toISOString(),
    dueAt: row.dueAt?.toISOString() ?? null,
    state: row.state as z.infer<typeof DisclosureRequestOut>["state"],
    loggedBy: row.createdBy,
    preparedBy: row.preparedBy,
    decidedBy: row.decidedBy,
    decidedAt: row.decidedAt?.toISOString() ?? null,
    reason: row.reason,
    releasedBy: row.releasedBy,
    releasedAt: row.releasedAt?.toISOString() ?? null,
    packSha256: row.packSha256,
    collectedAt: row.collectedAt?.toISOString() ?? null,
    notSearched: row.notSearched.map((t) => dsarNotSearchedOf(t)),
    items: {
      total: items.length,
      pending: count("pending"),
      disclose: count("disclose"),
      redact: count("redact"),
      withhold: count("withhold"),
    },
    prevention,
    version: row.version,
  };
}

const itemOut = (r: ItemRow) => ({
  id: r.id,
  tableName: r.tableName,
  recordId: r.recordId,
  decision: r.decision as DsarItemDecision,
  redactedFields: r.redactedFields,
  reason: r.reason,
  reviewedBy: r.reviewedBy,
  reviewedAt: r.reviewedAt?.toISOString() ?? null,
  version: r.version,
});

/** A person's record as the DSAR collector's third-party names need it. */
const subjectCase = (personId: string) =>
  ({
    subjectKind: "person",
    subjectPersonId: personId,
    subjectContactId: null,
    subjectStaffId: null,
  }) as unknown as CaseRow;

/** When a record is about, for the chronology: the first date-like field it has. */
function whenOf(fields: Record<string, unknown>): string | null {
  for (const key of ["occurred_at", "recorded_at", "held_on", "received_on", "created_at"]) {
    const v = fields[key];
    if (typeof v === "string" && v.length > 0) return v;
  }
  return null;
}

/** Changes a request at the version read, still being worked when `states` says so. */
async function change(
  tx: Tx,
  row: RequestRow,
  expectedVersion: number,
  states: readonly string[],
  set: Partial<typeof disclosureRequest.$inferInsert>,
) {
  if (row.version !== expectedVersion) throw stale();
  if (!states.includes(row.state)) {
    throw new HttpProblem(409, "disclosure_wrong_state", `This request is ${row.state}.`);
  }
  const [saved] = await tx
    .update(disclosureRequest)
    .set(set)
    .where(and(eq(disclosureRequest.id, row.id), eq(disclosureRequest.version, expectedVersion)))
    .returning();
  if (!saved) throw stale();
  return saved;
}

const versioned = <S extends z.ZodType>(schema: S) => ({
  params: IdParam,
  body: { content: { "application/json": { schema } } },
});
const requestResponses = {
  200: jsonBody(DisclosureRequestOut, "The request"),
  ...errorResponses,
  ...notFoundResponse,
  ...conflictResponse,
};

export const disclosuresRouter = createRouter()
  .openapi(
    createRoute({
      method: "get",
      path: "/v1/disclosures",
      tags,
      summary: "The disclosure log: requests with their legal basis, approver and release",
      description:
        "safety.incident.manage or safety.disclosure.approve; row-level security shows the requests about people at homes the member reaches (or all, organisation-wide). Newest first, up to 1,000, saying when there are more. Audited (safety.disclosure.log_viewed) with the count.",
      security,
      responses: { 200: jsonBody(DisclosureLog, "The log"), ...errorResponses },
    }),
    async (c) => {
      const access = await requireAnyPermission(c, [MANAGE, APPROVE]);
      const body = await inTx(c, async (tx) => {
        const rows = await tx
          .select()
          .from(disclosureRequest)
          .orderBy(desc(disclosureRequest.receivedAt))
          .limit(LOG_LIMIT + 1);
        const shown = rows.slice(0, LOG_LIMIT);
        await audit(c, tx, access, "log_viewed", null, { count: shown.length });
        const items = [];
        for (const r of shown) items.push(await requestOut(tx, access, r));
        return { items, truncated: rows.length > LOG_LIMIT };
      });
      return c.json(body, 200);
    },
  )
  .openapi(
    createRoute({
      method: "post",
      path: "/v1/disclosures",
      tags,
      summary: "Log a disclosure request about a person",
      description:
        "safety.incident.manage at the person's location or across the organisation. Stores the legal basis for the type as stated now. An Access to Health Records Act request needs the person to have died, and its answer is due by ahraDueAt (ahra.* rates, counting from the person's latest care note). Audited (safety.disclosure.logged) with the type, never who asked or why.",
      security,
      request: { body: { content: { "application/json": { schema: LogDisclosureRequest } } } },
      responses: {
        201: jsonBody(DisclosureRequestOut, "Logged"),
        ...errorResponses,
        ...notFoundResponse,
      },
    }),
    async (c) => {
      const access = await requirePermission(c, MANAGE);
      const body = c.req.valid("json");
      const receivedAt = new Date(body.receivedAt);
      if (receivedAt > new Date()) {
        throw unprocessable("time_in_future", "When it arrived cannot be in the future.");
      }
      // The person's home and status, read as the organisation (the member's own care-record
      // scope does not decide this: their disclosure permission's reach does, checked next).
      const home = await asOrganisation(c, access, async (tx) => {
        const [p] = await tx
          .select({ locationId: person.locationId })
          .from(person)
          .where(eq(person.id, body.personId));
        return p ?? null;
      });
      // A person at a home the member does not reach reads as not found, as one who does not exist.
      if (!home) throw problems.notFound();
      if (!reaches(access, MANAGE, home.locationId)) throw problems.notFound();
      const subject = await asOrganisation(c, access, async (tx) => {
        const [p] = await tx
          .select({ locationId: person.locationId, status: person.status })
          .from(person)
          .where(eq(person.id, body.personId));
        if (!p) return null;
        const [latest] = await tx
          .select({ at: max(careNote.recordedAt) })
          .from(careNote)
          .where(eq(careNote.personId, body.personId));
        const [t] = await tx.select({ nation: tenant.nation }).from(tenant);
        return { ...p, latestNoteAt: latest?.at ?? null, nation: t?.nation ?? "england" };
      });
      if (!subject) throw problems.notFound();
      requireReach(access, MANAGE, subject.locationId);
      let dueAt: Date | null = null;
      if (body.type === "access_to_health_records") {
        if (subject.status !== "deceased") {
          throw unprocessable(
            "person_not_deceased",
            "The Access to Health Records Act covers people who have died. A living person asks through a subject access request.",
          );
        }
        const rates = await asOrganisation(c, access, async (tx) => {
          const rows = await tx.select().from(rateTable);
          return resolveSafetyPhase2Rates(
            rows.map((r) => ({
              key: r.key,
              value: r.value,
              unit: r.unit,
              nation: r.nation,
              validFrom: r.validFrom,
              validTo: r.validTo,
              tenantId: r.tenantId,
              verificationStatus: r.verificationStatus,
              source: r.source,
            })),
            subject.nation as Exclude<RateNation, "uk" | "all">,
            ukIsoDate(receivedAt),
            access.tenantId,
          );
        });
        dueAt = ahraDueAt(receivedAt, subject.latestNoteAt ?? new Date(0), rates).dueAt;
      }
      const out = await inTx(c, async (tx) => {
        const [row] = await tx
          .insert(disclosureRequest)
          .values({
            personId: body.personId,
            locationId: subject.locationId,
            type: body.type,
            legalBasis: legalBasis(body.type as DisclosureType),
            requesterName: body.requester.name,
            requesterOrganisation: body.requester.organisation,
            requesterReference: body.requester.reference ?? null,
            statedPurpose: body.statedPurpose ?? null,
            receivedAt,
            dueAt,
          })
          .returning();
        if (!row) throw stale();
        await audit(c, tx, access, "logged", row.id, { type: row.type, personId: row.personId });
        return requestOut(tx, access, row);
      });
      return c.json(out, 201);
    },
  )
  .openapi(
    createRoute({
      method: "get",
      path: "/v1/disclosures/{id}",
      tags,
      summary: "One disclosure request with its steps and item counts",
      description:
        "safety.incident.manage or safety.disclosure.approve, reaching the person's location. Audited (safety.disclosure.viewed).",
      security,
      request: { params: IdParam },
      responses: {
        200: jsonBody(DisclosureRequestOut, "The request"),
        ...errorResponses,
        ...notFoundResponse,
      },
    }),
    async (c) => {
      const access = await requireAnyPermission(c, [MANAGE, APPROVE]);
      const { id } = c.req.valid("param");
      const out = await inTx(c, async (tx) => {
        const row = await loadRequest(tx, id);
        requireReachAny(access, row.locationId);
        await audit(c, tx, access, "viewed", id);
        return requestOut(tx, access, row);
      });
      return c.json(out, 200);
    },
  )
  .openapi(
    createRoute({
      method: "post",
      path: "/v1/disclosures/{id}/collect",
      tags,
      summary: "Find the person's records across every module (the DSAR collector)",
      description: `safety.incident.manage reaching the person's location, while the request is being worked. Searches every exported table by its person column, in the organisation's context after the member is authorised (ADR-0090); lists the tables it cannot search; collecting again adds only new records; stops at ${DSAR_ITEM_LIMIT}. Audited (safety.disclosure.collected) with counts.`,
      security,
      request: { params: IdParam },
      responses: {
        200: jsonBody(DisclosureCollectResult, "Collected"),
        ...errorResponses,
        ...notFoundResponse,
        ...conflictResponse,
      },
    }),
    async (c) => {
      const access = await requirePermission(c, MANAGE);
      const { id } = c.req.valid("param");
      const row = await inTx(c, (tx) => loadRequest(tx, id));
      requireReach(access, MANAGE, row.locationId);
      if (row.state !== "requested") {
        throw new HttpProblem(409, "disclosure_wrong_state", `This request is ${row.state}.`);
      }
      const notSearched = dsarNotSearched(SUBJECT_MAP, "person");
      const collected = await asOrganisation(c, access, (tx) =>
        collectRecords(tx, "person", row.personId, DSAR_ITEM_LIMIT),
      );
      // The disclosure log is the organisation's correspondence about the person, not their record:
      // it is never part of a pack (a subject access request still finds it).
      collected.found = collected.found.filter(([table]) => !OWN_TABLES.has(table));
      const body = await inTx(c, async (tx) => {
        let added = 0;
        for (let i = 0; i < collected.found.length; i += 500) {
          const chunk = collected.found.slice(i, i + 500);
          const inserted = await tx
            .insert(disclosureItem)
            .values(chunk.map(([tableName, recordId]) => ({ requestId: id, tableName, recordId })))
            .onConflictDoNothing()
            .returning({ id: disclosureItem.id });
          added += inserted.length;
        }
        await tx
          .update(disclosureRequest)
          .set({ collectedAt: new Date(), notSearched: notSearched.map((e) => e.table) })
          .where(eq(disclosureRequest.id, id));
        const total = (await itemsOf(tx, id)).length;
        await audit(c, tx, access, "collected", id, {
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
      path: "/v1/disclosures/{id}/items",
      tags,
      summary: "The records collected and the decision on each",
      description:
        "safety.incident.manage or safety.disclosure.approve reaching the person's location. Tables and ids only. Audited with the count.",
      security,
      request: { params: IdParam },
      responses: {
        200: jsonBody(DisclosureItemList, "Items"),
        ...errorResponses,
        ...notFoundResponse,
      },
    }),
    async (c) => {
      const access = await requireAnyPermission(c, [MANAGE, APPROVE]);
      const { id } = c.req.valid("param");
      const body = await inTx(c, async (tx) => {
        requireReachAny(access, (await loadRequest(tx, id)).locationId);
        const rows = (await itemsOf(tx, id)).sort(
          (a, b) => a.tableName.localeCompare(b.tableName) || a.recordId.localeCompare(b.recordId),
        );
        await audit(c, tx, access, "items_listed", id, { count: rows.length });
        return { items: rows.map(itemOut), total: rows.length };
      });
      return c.json(body, 200);
    },
  )
  .openapi(
    createRoute({
      method: "get",
      path: "/v1/disclosures/{id}/items/{itemId}",
      tags,
      summary: "One collected record, with other people's names highlighted for review",
      description:
        "safety.incident.manage or safety.disclosure.approve reaching the person's location, with a fresh step-up. The record as the export shows it; highlights redact nothing. Audited as a care-record view, in the request's and the person's history.",
      security,
      request: { params: ItemParam },
      responses: {
        200: jsonBody(DisclosureItemDetail, "The record"),
        ...errorResponses,
        ...notFoundResponse,
      },
    }),
    async (c) => {
      const access = await requireAnyPermission(c, [MANAGE, APPROVE]);
      requireStepUp(access);
      const { id, itemId } = c.req.valid("param");
      const { row, item } = await inTx(c, async (tx) => {
        const r = await loadRequest(tx, id);
        requireReachAny(access, r.locationId);
        const [i] = await tx
          .select()
          .from(disclosureItem)
          .where(and(eq(disclosureItem.id, itemId), eq(disclosureItem.requestId, id)));
        if (!i) throw problems.notFound();
        await audit(c, tx, access, "item_viewed", id, {
          itemId,
          table: i.tableName,
          recordId: i.recordId,
          read: "organisation",
        });
        await auditInTx(tx, access, {
          action: "safety.disclosure.person_record_viewed",
          resourceType: "person",
          resourceId: r.personId,
          scope: { requestId: id, table: i.tableName, recordId: i.recordId, read: "organisation" },
          requestId: c.get("requestId"),
        });
        return { row: r, item: i };
      });
      const { record, others } = await asOrganisation(c, access, async (tx) => ({
        record: (await recordsOf(tx, item.tableName, [item.recordId])).get(item.recordId) ?? null,
        others: await thirdPartyNames(tx, subjectCase(row.personId)),
      }));
      const highlights = record
        ? Object.entries(record).flatMap(([field, value]) =>
            stringsIn(value, field).flatMap((s) =>
              findThirdPartyNames(s.text, others).map((h) => ({ field: s.field, ...h })),
            ),
          )
        : [];
      c.header("cache-control", "private, no-store");
      return c.json(
        {
          ...itemOut(item),
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
      path: "/v1/disclosures/{id}/items/{itemId}/decision",
      tags,
      summary:
        "Record a person's decision on one record: disclose, redact named fields or withhold",
      description:
        "safety.incident.manage reaching the person's location, while the request is being worked. Bound to the record as it was opened (409 disclosure_record_changed if it changed since). Nothing is redacted automatically. Audited with the decision code and the number of fields.",
      security,
      request: {
        params: ItemParam,
        body: { content: { "application/json": { schema: DsarItemDecisionInput } } },
      },
      responses: {
        200: jsonBody(DisclosureItemList.shape.items.element, "Decided"),
        ...errorResponses,
        ...notFoundResponse,
        ...conflictResponse,
      },
    }),
    async (c) => {
      const access = await requirePermission(c, MANAGE);
      const { id, itemId } = c.req.valid("param");
      const input = c.req.valid("json");
      const loaded = await inTx(c, async (tx) => {
        const row = await loadRequest(tx, id);
        requireReach(access, MANAGE, row.locationId);
        const [item] = await tx
          .select()
          .from(disclosureItem)
          .where(and(eq(disclosureItem.id, itemId), eq(disclosureItem.requestId, id)));
        if (!item) throw problems.notFound();
        return item;
      });
      const check = checkItemDecision(input, disclosableColumns(loaded.tableName));
      if (!check.ok) throw problems.invalid(check.problem);
      // The record as it is now, read as the organisation outside the member's transaction (one
      // connection at a time); the version check below binds the decision to the item read here.
      const current = await asOrganisation(c, access, async (otx) =>
        (await recordsOf(otx, loaded.tableName, [loaded.recordId])).get(loaded.recordId),
      );
      if (!current || recordSha256(current) !== input.contentSha256) {
        throw new HttpProblem(
          409,
          "disclosure_record_changed",
          "This record changed after you opened it.",
          "Open it again and review what it says now.",
        );
      }
      const out = await inTx(c, async (tx) => {
        const row = await loadRequest(tx, id);
        requireReach(access, MANAGE, row.locationId);
        if (row.state !== "requested") {
          throw new HttpProblem(409, "disclosure_wrong_state", `This request is ${row.state}.`);
        }
        if (loaded.version !== input.expectedVersion) throw stale();
        const [saved] = await tx
          .update(disclosureItem)
          .set({
            decision: input.decision,
            redactedFields: input.decision === "redact" ? input.redactedFields : [],
            reason: input.decision === "disclose" ? null : input.reason,
            reviewedBy: access.tenantUserId,
            reviewedAt: new Date(),
            contentSha256: input.contentSha256,
          })
          .where(
            and(eq(disclosureItem.id, itemId), eq(disclosureItem.version, input.expectedVersion)),
          )
          .returning();
        if (!saved) throw stale();
        await audit(c, tx, access, "item_decided", id, {
          itemId,
          decision: saved.decision,
          fields: saved.redactedFields.length,
        });
        return itemOut(saved);
      });
      return c.json(out, 200);
    },
  )
  .openapi(
    createRoute({
      method: "post",
      path: "/v1/disclosures/{id}/prepare",
      tags,
      summary: "Mark the request ready for approval",
      description:
        "safety.incident.manage reaching the person's location. Needs every record decided (409 disclosure_items_pending) and disclosurePrepareProblems clear: who asked, what for (police and solicitors), something to disclose (422 disclosure_not_ready with the problems). Audited (safety.disclosure.prepared).",
      security,
      request: versioned(DisclosureVersioned),
      responses: requestResponses,
    }),
    async (c) => {
      const access = await requirePermission(c, MANAGE);
      const { id } = c.req.valid("param");
      const { expectedVersion } = c.req.valid("json");
      const out = await inTx(c, async (tx) => {
        const row = await loadRequest(tx, id);
        requireReach(access, MANAGE, row.locationId);
        const items = await itemsOf(tx, id);
        const readiness = bundleReadiness(
          items.map((i) => ({ decision: i.decision as DsarItemDecision })),
        );
        if (!readiness.ready) {
          throw new HttpProblem(
            409,
            "disclosure_items_pending",
            "Decide every record first.",
            `${readiness.pending} still to review.`,
          );
        }
        const problemsFound = disclosurePrepareProblems({
          type: row.type as DisclosureType,
          requester: { name: row.requesterName, organisation: row.requesterOrganisation },
          statedPurpose: row.statedPurpose,
          itemsDocumentIds: items
            .filter((i) => i.decision === "disclose" || i.decision === "redact")
            .map((i) => i.id),
        });
        if (problemsFound.length > 0) {
          throw new HttpProblem(
            422,
            "disclosure_not_ready",
            "This request is not ready.",
            problemsFound.join(" "),
          );
        }
        const saved = await change(tx, row, expectedVersion, ["requested"], {
          state: "prepared",
          preparedBy: access.tenantUserId,
          preparedAt: new Date(),
        });
        await audit(c, tx, access, "prepared", id, { records: items.length });
        return requestOut(tx, access, saved);
      });
      return c.json(out, 200);
    },
  )
  .openapi(
    createRoute({
      method: "post",
      path: "/v1/disclosures/{id}/decision",
      tags,
      summary: "Approve or refuse a prepared request",
      description:
        "safety.disclosure.approve reaching the person's location, by someone who did not log the request (403 disclosure_approver_is_requester; the database refuses it too). Refusing needs a reason. Audited (safety.disclosure.approved or refused), never the reason.",
      security,
      request: versioned(DecideDisclosure),
      responses: requestResponses,
    }),
    async (c) => {
      const access = await requirePermission(c, APPROVE);
      const { id } = c.req.valid("param");
      const input = c.req.valid("json");
      if (input.decision === "refuse" && !input.reason) {
        throw unprocessable("reason_required", "Give the reason for refusing.");
      }
      const out = await inTx(c, async (tx) => {
        const row = await loadRequest(tx, id);
        requireReach(access, APPROVE, row.locationId);
        if (row.createdBy === access.tenantUserId) {
          throw new HttpProblem(
            403,
            "disclosure_approver_is_requester",
            "Someone other than the person who logged this request must decide it.",
          );
        }
        const saved = await change(
          tx,
          row,
          input.expectedVersion,
          input.decision === "approve" ? ["prepared"] : ["requested", "prepared"],
          {
            state: input.decision === "approve" ? "approved" : "refused",
            decidedBy: access.tenantUserId,
            decidedAt: new Date(),
            ...(input.decision === "refuse" ? { reason: input.reason ?? null } : {}),
          },
        );
        await audit(c, tx, access, input.decision === "approve" ? "approved" : "refused", id);
        return requestOut(tx, access, saved);
      });
      return c.json(out, 200);
    },
  )
  .openapi(
    createRoute({
      method: "post",
      path: "/v1/disclosures/{id}/release",
      tags,
      summary: "Issue the pack (with a fresh step-up)",
      description:
        "safety.incident.manage reaching the person's location, with a fresh step-up, once approved. Builds the pack from the decisions in date order (the chronology for a review), redacted fields reading [redacted] and withheld records counted, hashes it and stores it as sent (exports bucket, opaque key). A record changed since review stops the release (409 disclosure_records_changed): withdraw and log the request again. Audited (safety.disclosure.released) with counts and the hash.",
      security,
      request: versioned(DisclosureVersioned),
      responses: requestResponses,
    }),
    async (c) => {
      const access = await requirePermission(c, MANAGE);
      requireStepUp(access);
      const { id } = c.req.valid("param");
      const { expectedVersion } = c.req.valid("json");
      const { row, items } = await inTx(c, async (tx) => {
        const r = await loadRequest(tx, id);
        requireReach(access, MANAGE, r.locationId);
        if (r.state !== "approved") {
          throw new HttpProblem(409, "disclosure_wrong_state", `This request is ${r.state}.`);
        }
        return { row: r, items: await itemsOf(tx, id) };
      });
      // Read each record as the organisation and check it is what was reviewed.
      const records: {
        table: string;
        recordId: string;
        when: string | null;
        fields: Record<string, unknown>;
      }[] = [];
      const changed: string[] = [];
      await asOrganisation(c, access, async (tx) => {
        const byTable = new Map<string, ItemRow[]>();
        for (const i of items) byTable.set(i.tableName, [...(byTable.get(i.tableName) ?? []), i]);
        for (const [table, list] of byTable) {
          const found = await recordsOf(
            tx,
            table,
            list.map((i) => i.recordId),
          );
          for (const i of list) {
            const record = found.get(i.recordId);
            if (!record || recordSha256(record) !== i.contentSha256) {
              changed.push(i.id);
              continue;
            }
            if (i.decision === "withhold") continue;
            const fields =
              i.decision === "redact" ? applyRedactions(record, i.redactedFields) : record;
            records.push({ table, recordId: i.recordId, when: whenOf(record), fields });
          }
        }
      });
      // An approved request's decisions are fixed (row-level security), so nothing is reset here:
      // the approver approved what was reviewed, and a changed record needs a new request.
      if (changed.length > 0) {
        throw new HttpProblem(
          409,
          "disclosure_records_changed",
          "Some records changed after they were reviewed. Withdraw and log the request again, or ask the approver to refuse it.",
          `${changed.length} changed.`,
        );
      }
      records.sort(
        (a, b) =>
          (a.when ?? "").localeCompare(b.when ?? "") ||
          a.table.localeCompare(b.table) ||
          a.recordId.localeCompare(b.recordId),
      );
      const redactedCount = items.filter((i) => i.decision === "redact").length;
      const withheldCount = items.filter((i) => i.decision === "withhold").length;

      const sha256 = createHash("sha256")
        .update(canonical({ records, redactedCount, withheldCount }))
        .digest("hex");
      const pack = {
        requestId: id,
        type: row.type as z.infer<typeof DisclosurePack>["type"],
        legalBasis: row.legalBasis,
        generatedAt: new Date().toISOString(),
        records,
        redactedCount,
        withheldCount,
        notSearched: row.notSearched.map((t) => dsarNotSearchedOf(t)),
        sha256,
      };
      const storage = c.get("services").exportStorage;
      const storageKey = disclosurePackStorageKey(access.tenantId, id, randomUUID());
      await storage.put(
        storageKey,
        new TextEncoder().encode(JSON.stringify(pack)),
        "application/json",
      );
      const out = await inTx(c, async (tx) => {
        const saved = await change(tx, await loadRequest(tx, id), expectedVersion, ["approved"], {
          state: "released",
          releasedBy: access.tenantUserId,
          releasedAt: new Date(),
          packSha256: sha256,
          packStorageKey: storageKey,
        });
        await audit(c, tx, access, "released", id, {
          records: records.length,
          redacted: redactedCount,
          withheld: withheldCount,
          sha256,
          read: "organisation",
        });
        return requestOut(tx, access, saved);
      }).catch(async (error: unknown) => {
        await storage.destroy(storageKey).catch(() => undefined);
        throw error;
      });
      return c.json(out, 200);
    },
  )
  .openapi(
    createRoute({
      method: "get",
      path: "/v1/disclosures/{id}/pack",
      tags,
      summary: "The pack exactly as it was issued",
      description:
        "safety.incident.manage or safety.disclosure.approve reaching the person's location, with a fresh step-up. Audited (safety.disclosure.pack_fetched).",
      security,
      request: { params: IdParam },
      responses: {
        200: jsonBody(DisclosurePack, "The pack as issued"),
        ...errorResponses,
        ...notFoundResponse,
      },
    }),
    async (c) => {
      const access = await requireAnyPermission(c, [MANAGE, APPROVE]);
      requireStepUp(access);
      const { id } = c.req.valid("param");
      const row = await inTx(c, async (tx) => {
        const r = await loadRequest(tx, id);
        requireReachAny(access, r.locationId);
        if (!r.packStorageKey) throw problems.notFound();
        await audit(c, tx, access, "pack_fetched", id, { sha256: r.packSha256 });
        return r;
      });
      const bytes = await c.get("services").exportStorage.get(row.packStorageKey as string);
      if (!bytes) throw problems.notFound();
      c.header("cache-control", "private, no-store");
      return c.json(
        JSON.parse(new TextDecoder().decode(bytes)) as z.infer<typeof DisclosurePack>,
        200,
      );
    },
  )
  .openapi(
    createRoute({
      method: "post",
      path: "/v1/disclosures/{id}/withdraw",
      tags,
      summary: "Withdraw a request before it is released",
      description:
        "safety.incident.manage reaching the person's location, with a reason. Audited (safety.disclosure.withdrawn), never the reason.",
      security,
      request: versioned(WithdrawDisclosure),
      responses: requestResponses,
    }),
    async (c) => {
      const access = await requirePermission(c, MANAGE);
      const { id } = c.req.valid("param");
      const input = c.req.valid("json");
      const out = await inTx(c, async (tx) => {
        const row = await loadRequest(tx, id);
        requireReach(access, MANAGE, row.locationId);
        const saved = await change(
          tx,
          row,
          input.expectedVersion,
          ["requested", "prepared", "approved"],
          {
            state: "withdrawn",
            reason: input.reason,
          },
        );
        await audit(c, tx, access, "withdrawn", id);
        return requestOut(tx, access, saved);
      });
      return c.json(out, 200);
    },
  )
  .openapi(
    createRoute({
      method: "post",
      path: "/v1/disclosures/{id}/prevention-report",
      tags,
      summary: "Record a coroner's Regulation 28 report and the response",
      description:
        "safety.incident.manage reaching the person's location; coroner requests only (422 not_a_coroner_request). The response is due coroner.prevention_report_response_days after the report (rate table). Dates not in the future; the response not before the report. Audited (safety.disclosure.prevention_recorded).",
      security,
      request: versioned(RecordPreventionReport),
      responses: requestResponses,
    }),
    async (c) => {
      const access = await requirePermission(c, MANAGE);
      const { id } = c.req.valid("param");
      const input = c.req.valid("json");
      const today = ukIsoDate(new Date());
      if (input.reportOn > today || (input.respondedOn && input.respondedOn > today)) {
        throw unprocessable("date_in_future", "The dates cannot be in the future.");
      }
      if (input.respondedOn && input.respondedOn < input.reportOn) {
        throw unprocessable("response_before_report", "The response cannot be before the report.");
      }
      const out = await inTx(c, async (tx) => {
        const row = await loadRequest(tx, id);
        requireReach(access, MANAGE, row.locationId);
        if (row.type !== "coroner") {
          throw unprocessable(
            "not_a_coroner_request",
            "Only a coroner sends a Regulation 28 report.",
          );
        }
        if (row.version !== input.expectedVersion) throw stale();
        const [saved] = await tx
          .update(disclosureRequest)
          .set({
            preventionReportOn: input.reportOn,
            preventionRespondedOn: input.respondedOn ?? null,
          })
          .where(
            and(eq(disclosureRequest.id, id), eq(disclosureRequest.version, input.expectedVersion)),
          )
          .returning();
        if (!saved) throw stale();
        await audit(c, tx, access, "prevention_recorded", id, {
          responded: input.respondedOn !== undefined && input.respondedOn !== null,
        });
        return requestOut(tx, access, saved);
      });
      return c.json(out, 200);
    },
  );
