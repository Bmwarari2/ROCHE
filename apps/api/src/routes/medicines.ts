import { randomUUID } from "node:crypto";
import {
  AddReconciliationItem,
  AddReconciliationSource,
  ChangeMedicine,
  CheckMedicine,
  CompleteReconciliation,
  MarChart,
  MedicineChanged,
  MedicineEntry,
  MedicineHistory,
  MedicineProductSearch,
  MedicineProducts,
  MedicinesRecord,
  PutReconciliationDecisions,
  ReconciliationOut,
  StartReconciliation,
  StopMedicine,
  TranscribeMedicine,
} from "@harbour/contracts";
import {
  document,
  hospitalTransfer,
  medication,
  medicationReconciliation,
  medicationReconciliationDecision,
  medicationReconciliationItem,
  medicationReconciliationSource,
  placement,
  type Transaction,
  task,
} from "@harbour/db";
import {
  changeMarEntry,
  clockChangesIn,
  completeReconciliation,
  type DmdProductFacts,
  type DmdProductRef,
  type EntryDecision,
  entriesToReconcile,
  formatDose,
  type ItemDecision,
  isDmdProduct,
  type MarEntry,
  type MarEntryDraft,
  type MarEntryIssue,
  MEDICINES_RATE_KEYS,
  marCycle,
  marEntryDoses,
  marEntryStatus,
  marEntryTimesBeforeRecorded,
  outstandingReconciliations,
  type Reconciliation,
  type ReconciliationDraft,
  type ReconciliationIssue,
  type ReconciliationSource,
  type ReconciliationTriggerEvent,
  recordSecondCheck,
  stopMarEntry,
  transcribeMarEntry,
  ukStartOfDay,
} from "@harbour/domain";
import { createRoute, z } from "@hono/zod-openapi";
import { and, asc, eq, inArray, isNotNull, isNull, sql } from "drizzle-orm";
import type { Context } from "hono";
import { AuditedRefusal, auditInTx, withAuditedRefusal } from "../http/audit";
import {
  type AppEnv,
  requireAnyPermission,
  requirePermission,
  type TenantAccess,
  withTenant,
} from "../http/context";
import { HttpProblem, problems } from "../http/problem";
import { publish } from "../outbox";
import {
  entryOut,
  insertEntry,
  personEntries,
  type StoredEntry,
  UNCHECKED_POLICY,
  updateEntry,
} from "../services/medicines";
import { loadPerson, returnCheckTaskKind } from "../services/people";
import { rateNumber } from "../services/rates";
import {
  conflictResponse,
  createRouter,
  errorResponses,
  jsonBody,
  notFoundResponse,
  security,
} from "./openapi";

/**
 * The medicines record and reconciliation (Phase 2 slice 16; MEDS-001; medicines.md sections 4.1
 * and 5). The slice 2 domain decides every rule; these routes load every version the person has,
 * try the rules at the time of recording (HZ-010), write what the rules return, and audit by id
 * only. Reading needs a permission that reads the MAR; writing needs `medicines.record.manage`.
 * Competence and dm+d facts come from their ports (section 3), never from the request.
 */

const tags = ["medicines"];
const READERS = ["medicines.record.manage", "medicines.emar.administer", "care.plan.read"] as const;
const WRITER = "medicines.record.manage" as const;
const PersonParam = z.object({ id: z.uuid() });
const EntryParam = z.object({ entryId: z.uuid() });
const RecParam = z.object({ id: z.uuid(), recId: z.uuid() });
const MarQuery = z.object({ cycleStart: z.iso.date() });
const RETURN_CHECK = "medicines_reconciled";

function audit(
  c: Context<AppEnv>,
  tx: Transaction,
  access: TenantAccess,
  input: Parameters<typeof auditInTx>[2],
) {
  return auditInTx(tx, access, { ...input, requestId: c.get("requestId") });
}

/** The rules' refusal, every problem in words (422). */
function refusal(issues: readonly (MarEntryIssue | ReconciliationIssue)[]): HttpProblem {
  return new HttpProblem(
    422,
    `medicine_${issues[0]?.problem ?? "refused"}`,
    "The medicines record cannot be changed like this.",
    issues.map((i) => i.message).join(" "),
  );
}

const dmdUnknown = (loaded: boolean) =>
  new HttpProblem(
    422,
    "dmd_product_unknown",
    "Choose the medicine from dm+d.",
    loaded
      ? "dm+d does not hold this product. Choose it from the dm+d list."
      : "The dm+d reference data is not loaded yet, so no medicine can be recorded. Ask Harbour support.",
  );

type DmdFacts = DmdProductFacts & { readonly name: string };

async function factsFor(c: Context<AppEnv>, product: DmdProductRef): Promise<DmdFacts> {
  if (!isDmdProduct(product)) {
    throw new HttpProblem(
      422,
      "medicine_product_not_dmd",
      "Choose the medicine from dm+d.",
      "Choose the medicine from dm+d. A typed name cannot be used.",
    );
  }
  const port = c.get("services").medicines.dmd;
  const facts = await port.facts(product);
  if (!facts) throw dmdUnknown(port.loaded);
  return facts;
}

type DraftBody = z.infer<typeof TranscribeMedicine> | z.infer<typeof ChangeMedicine>;

function draftOf(personId: string, body: DraftBody): MarEntryDraft {
  return {
    personId,
    product: body.product,
    route: body.route,
    directions: body.directions,
    indication: body.indication,
    specialInstructions: body.specialInstructions,
    prescriber: body.prescriber,
    startsAt: new Date(body.startsAt),
    stopsAt: body.stopsAt ? new Date(body.stopsAt) : null,
    reviewOn: body.reviewOn,
    source: body.source,
  };
}

function reconciliationDraftOf(d: z.infer<typeof ReconciliationDraftShape>): ReconciliationDraft {
  return {
    product: d.product,
    route: d.route,
    directions: d.directions,
    indication: d.indication,
    specialInstructions: d.specialInstructions,
    prescriber: d.prescriber,
    startsAt: new Date(d.startsAt),
    stopsAt: d.stopsAt ? new Date(d.stopsAt) : null,
    reviewOn: d.reviewOn,
  };
}
const ReconciliationDraftShape =
  PutReconciliationDecisions.shape.itemDecisions.element.options[0].shape.draft;

/**
 * What is stored is dm+d's own words: the product's name, the route's and each unit's, taken from
 * the reference data by code, never from the request (security review, finding 3).
 */
type BodyDraft = Pick<z.infer<typeof TranscribeMedicine>, "product" | "route" | "directions">;

function canonical<T extends BodyDraft>(body: T, facts: DmdFacts): T {
  const unit = (u: { code: string; name: string }) => ({
    code: u.code,
    name: facts.permittedDoseUnits.find((x) => x.code === u.code)?.name ?? u.name,
  });
  const dose = <D extends { unit: { code: string; name: string } }>(d: D): D => ({
    ...d,
    unit: unit(d.unit),
  });
  const directions: BodyDraft["directions"] =
    body.directions.kind === "regular"
      ? {
          ...body.directions,
          schedule: {
            ...body.directions.schedule,
            times: body.directions.schedule.times.map((t) => ({ ...t, dose: dose(t.dose) })),
          },
        }
      : { ...body.directions, dose: dose(body.directions.dose) };
  return {
    ...body,
    product: { ...body.product, name: facts.name },
    route: {
      code: body.route.code,
      name: facts.permittedRoutes.find((r) => r.code === body.route.code)?.name ?? body.route.name,
    },
    directions,
  };
}

/**
 * Medicines writes for one person run one at a time (a transaction-scoped advisory lock), so two
 * people transcribing the same product at once cannot both pass rule 6's one entry per product
 * (security review, finding 1).
 */
async function lockPerson(tx: Transaction, personId: string) {
  await tx.execute(
    sql`SELECT pg_advisory_xact_lock(hashtextextended(${`medicines:${personId}`}, 0))`,
  );
}

/**
 * A source document must be this person's, available (scanned clean, not removed): never another
 * person's letter or one outside the caller's scope (RLS applies here, unlike a foreign key;
 * security review, finding 2).
 */
async function requireDocuments(
  tx: Transaction,
  personId: string,
  ids: readonly (string | null | undefined)[],
) {
  for (const documentId of ids) {
    if (!documentId) continue;
    const [doc] = await tx
      .select({ id: document.id })
      .from(document)
      .where(
        and(
          eq(document.id, documentId),
          eq(document.personId, personId),
          eq(document.status, "available"),
          isNull(document.deletedAt),
        ),
      );
    if (!doc) throw problems.invalid("Choose a document from this person's record.");
  }
}

/** One stored version, by id, within the caller's scope (RLS), with every version of the person. */
async function loadEntry(tx: Transaction, entryId: string, opts: { lock?: boolean } = {}) {
  const [row] = await tx
    .select({ personId: medication.personId, medicineId: medication.medicineId })
    .from(medication)
    .where(and(eq(medication.id, entryId), isNull(medication.deletedAt)));
  if (!row) throw problems.notFound();
  // Writes serialise on the person; a read (history) does not wait behind them.
  if (opts.lock !== false) await lockPerson(tx, row.personId);
  const all = await personEntries(tx, row.personId);
  const chain = all.filter((s) => s.medicineId === row.medicineId);
  const stored = chain.find((s) => s.entry.id === entryId) as StoredEntry;
  return { all, chain, stored, medicineId: row.medicineId, personId: row.personId };
}

function latestVersion(chain: readonly StoredEntry[]): number {
  return chain.reduce((m, s) => Math.max(m, s.entry.version), 0);
}

function requireLatest(chain: readonly StoredEntry[], expected: number) {
  if (latestVersion(chain) !== expected) {
    throw problems.conflict("The medicine has a newer version. Read it again before changing it.");
  }
}

function dbCode(error: unknown): string | undefined {
  return (error as { code?: string }).code ?? (error as { cause?: { code?: string } }).cause?.code;
}

/** A second change from the same version lands on the unique (medicine, version) key. */
async function guardConcurrent<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (error) {
    const code = dbCode(error);
    if (code === "23505") {
      throw problems.conflict("The medicine changed while you were working on it. Read it again.");
    }
    // A database rule refusing what the domain allowed: said as a refusal, never a conflict.
    if (code === "23514" || code === "23503") {
      throw new HttpProblem(
        422,
        "medicine_refused_by_record",
        "The medicines record cannot be changed like this.",
        "The record's own rules refused this change. Read the medicine again and check what you entered.",
      );
    }
    throw error;
  }
}

/**
 * Writes what a change returns, in the order the database's rules need: the withdrawn later
 * versions first (so the replaced version's replacement may move to the new one), then the new
 * version (the replaced one refers to it), then the replaced version.
 */
async function applyChange(
  tx: Transaction,
  result: Extract<ReturnType<typeof changeMarEntry>, { ok: true }>,
  medicineId: string,
  reconciliationId: string | null,
) {
  for (const w of result.withdrawn) await updateEntry(tx, w);
  await insertEntry(tx, result.next, medicineId, { reconciliationId });
  await updateEntry(tx, result.replaced);
}

async function applyStop(
  tx: Transaction,
  result: Extract<ReturnType<typeof stopMarEntry>, { ok: true }>,
) {
  for (const w of result.withdrawn) await updateEntry(tx, w);
  if (result.stopped) await updateEntry(tx, result.stopped);
}

async function changed(tx: Transaction, entry: MarEntry, type: "changed" | "stopped") {
  await publish(tx, {
    context: "medicines",
    aggregateType: "medication",
    aggregateId: entry.id,
    type: `medicines.entry.${type}`,
    payload: { personId: entry.personId, entryId: entry.id },
  });
}

/** Admissions (placements) and returns from hospital: the events a reconciliation answers. */
async function triggerEvents(
  tx: Transaction,
  personId: string,
): Promise<ReconciliationTriggerEvent[]> {
  const placements = await tx
    .select({ id: placement.id, startDate: placement.startDate })
    .from(placement)
    .where(and(eq(placement.personId, personId), isNull(placement.deletedAt)));
  const returns = await tx
    .select({ id: hospitalTransfer.id, returnedAt: hospitalTransfer.returnedAt })
    .from(hospitalTransfer)
    .where(
      and(
        eq(hospitalTransfer.personId, personId),
        isNotNull(hospitalTransfer.returnedAt),
        isNull(hospitalTransfer.deletedAt),
      ),
    );
  return [
    ...placements.map((p) => ({
      id: p.id,
      personId,
      kind: "admission" as const,
      at: ukStartOfDay(p.startDate),
    })),
    ...returns.map((r) => ({
      id: r.id,
      personId,
      kind: "return_from_hospital" as const,
      at: r.returnedAt as Date,
    })),
  ];
}

type RecRow = typeof medicationReconciliation.$inferSelect;

async function loadReconciliation(tx: Transaction, personId: string, recId: string) {
  const [rec] = await tx
    .select()
    .from(medicationReconciliation)
    .where(
      and(
        eq(medicationReconciliation.id, recId),
        eq(medicationReconciliation.personId, personId),
        isNull(medicationReconciliation.deletedAt),
      ),
    );
  if (!rec) throw problems.notFound();
  const sources = await tx
    .select()
    .from(medicationReconciliationSource)
    .where(eq(medicationReconciliationSource.reconciliationId, recId))
    .orderBy(asc(medicationReconciliationSource.createdAt));
  const items = await tx
    .select()
    .from(medicationReconciliationItem)
    .where(eq(medicationReconciliationItem.reconciliationId, recId))
    .orderBy(asc(medicationReconciliationItem.createdAt));
  const decisions = await tx
    .select()
    .from(medicationReconciliationDecision)
    .where(
      and(
        eq(medicationReconciliationDecision.reconciliationId, recId),
        isNull(medicationReconciliationDecision.deletedAt),
      ),
    );
  return { rec, sources, items, decisions };
}

type Loaded = Awaited<ReturnType<typeof loadReconciliation>>;

function recOut({ rec, sources, items, decisions }: Loaded): z.infer<typeof ReconciliationOut> {
  return {
    id: rec.id,
    personId: rec.personId,
    trigger: rec.trigger as z.infer<typeof ReconciliationOut>["trigger"],
    eventId: rec.placementId ?? rec.hospitalTransferId,
    triggeredAt: rec.triggeredAt.toISOString(),
    status: rec.status as "open" | "completed",
    started: { id: rec.startedBy, at: rec.startedAt.toISOString() },
    completed:
      rec.completedBy && rec.completedAt
        ? { id: rec.completedBy, at: rec.completedAt.toISOString() }
        : null,
    entriesAtStart: rec.entriesAtStart as { entryId: string; version: number }[],
    sources: sources.map((s) => ({
      id: s.id,
      kind: s.kind as z.infer<typeof AddReconciliationSource>["kind"],
      reference: s.reference,
      documentId: s.documentId,
      receivedAt: s.receivedAt.toISOString(),
      currentBecause: s.currentBecause,
    })),
    items: items.map((i) => ({
      id: i.id,
      sourceId: i.sourceId,
      asWritten: i.asWritten,
      product:
        i.vmpId && i.productName ? { vmpId: i.vmpId, ampId: i.ampId, name: i.productName } : null,
      says: i.says as "start" | "continue" | "change" | "stop" | "unclear",
    })),
    entryDecisions: decisions
      .filter((d) => d.entryId)
      .map((d) => d.decision as z.infer<typeof ReconciliationOut>["entryDecisions"][number]),
    itemDecisions: decisions
      .filter((d) => d.itemId)
      .map((d) => d.decision as z.infer<typeof ReconciliationOut>["itemDecisions"][number]),
    version: rec.version,
  };
}

function requireOpen(rec: RecRow) {
  if (rec.status !== "open") {
    throw new HttpProblem(
      409,
      "reconciliation_completed",
      "This reconciliation is completed.",
      "A completed reconciliation is the record of what was decided. Start a new one for a new change.",
    );
  }
}

function sourceOf(row: Loaded["sources"][number]): ReconciliationSource {
  return {
    id: row.id,
    kind: row.kind as ReconciliationSource["kind"],
    reference: row.reference,
    documentId: row.documentId,
    receivedAt: row.receivedAt,
    currentBecause: row.currentBecause,
  };
}

function entryDecisionOf(
  d: z.infer<typeof PutReconciliationDecisions>["entryDecisions"][number],
): EntryDecision {
  return d.kind === "change" ? { ...d, draft: reconciliationDraftOf(d.draft) } : d;
}

function itemDecisionOf(
  d: z.infer<typeof PutReconciliationDecisions>["itemDecisions"][number],
): ItemDecision {
  return d.kind === "start" ? { ...d, draft: reconciliationDraftOf(d.draft) } : d;
}

export const medicinesRouter = createRouter()
  .openapi(
    createRoute({
      method: "get",
      path: "/v1/medicines/products",
      tags,
      summary: "Search dm+d for a product to transcribe",
      description:
        "Products whose dm+d name holds every word searched for, with the routes and dose units dm+d permits for each (at most 20). Until slice 10's reference data, the dm+d port answers: the invented fixture outside production, nothing in production (`loaded` false). Not audited: no person is read.",
      security,
      request: { query: MedicineProductSearch },
      responses: { 200: jsonBody(MedicineProducts, "Products"), ...errorResponses },
    }),
    async (c) => {
      await requirePermission(c, WRITER);
      const { q } = c.req.valid("query");
      const dmd = c.get("services").medicines.dmd;
      const items = await dmd.search(q, 20);
      return c.json(
        {
          loaded: dmd.loaded,
          items: items.map((i) => ({
            vmpId: i.vmpId,
            name: i.name,
            permittedRoutes: [...i.permittedRoutes],
            permittedDoseUnits: [...i.permittedDoseUnits],
          })),
        },
        200,
      );
    },
  )
  .openapi(
    createRoute({
      method: "get",
      path: "/v1/people/{id}/medicines",
      tags,
      summary:
        "The person's medicines record: entries in force or scheduled, and reconciliations due",
      description:
        "Each medicine's version in force now, or the first scheduled to start, with its status in words and whether a dose may be given; the admissions and returns from hospital not yet reconciled. Audited by the person's id.",
      security,
      request: { params: PersonParam },
      responses: {
        200: jsonBody(MedicinesRecord, "The record"),
        ...errorResponses,
        ...notFoundResponse,
      },
    }),
    async (c) => {
      const access = await requireAnyPermission(c, [...READERS]);
      const { id } = c.req.valid("param");
      const now = new Date();
      const body = await withTenant(c, async (tx) => {
        await loadPerson(tx, id);
        const all = await personEntries(tx, id);
        const byId = new Map(all.map((s) => [s.entry.id, s]));
        const current = entriesToReconcile(
          all.map((s) => s.entry),
          now,
        ).flatMap((r) => byId.get(r.entryId) ?? []);
        const recs = await tx
          .select({
            id: medicationReconciliation.id,
            status: medicationReconciliation.status,
            placementId: medicationReconciliation.placementId,
            hospitalTransferId: medicationReconciliation.hospitalTransferId,
          })
          .from(medicationReconciliation)
          .where(
            and(
              eq(medicationReconciliation.personId, id),
              isNull(medicationReconciliation.deletedAt),
            ),
          );
        const outstanding = outstandingReconciliations(
          await triggerEvents(tx, id),
          recs
            .filter((r) => r.status === "completed")
            .map((r) => ({ personId: id, triggerEventId: r.placementId ?? r.hospitalTransferId })),
        );
        await audit(c, tx, access, {
          action: "medicines.entry.viewed",
          resourceType: "person",
          resourceId: id,
          scope: { entries: current.length },
        });
        return {
          entries: current.map((s) => entryOut(s, now)),
          outstandingReconciliations: outstanding.map((o) => ({
            kind: o.event.kind,
            eventId: o.event.id,
            at: o.event.at.toISOString(),
            notice: o.notice,
          })),
          openReconciliationId: recs.find((r) => r.status === "open")?.id ?? null,
        };
      });
      return c.json(body, 200);
    },
  )
  .openapi(
    createRoute({
      method: "get",
      path: "/v1/medicines/{entryId}/history",
      tags,
      summary: "Every version of a medicine, with its check, stop, replacement and withdrawal",
      description: "Audited by the entry's id.",
      security,
      request: { params: EntryParam },
      responses: {
        200: jsonBody(MedicineHistory, "The versions"),
        ...errorResponses,
        ...notFoundResponse,
      },
    }),
    async (c) => {
      const access = await requireAnyPermission(c, [...READERS]);
      const { entryId } = c.req.valid("param");
      const now = new Date();
      const body = await withTenant(c, async (tx) => {
        const { chain } = await loadEntry(tx, entryId, { lock: false });
        await audit(c, tx, access, {
          action: "medicines.entry.viewed",
          resourceType: "medication",
          resourceId: entryId,
          scope: { history: true },
        });
        return { versions: chain.map((s) => entryOut(s, now)) };
      });
      return c.json(body, 200);
    },
  )
  .openapi(
    createRoute({
      method: "get",
      path: "/v1/people/{id}/mar",
      tags,
      summary: "The MAR for a cycle: every regular dose with its day name and clock-change flags",
      description:
        "The cycle runs `medicines.ordering_cycle_days` days (rate table) from `cycleStart`. Times before an entry was recorded are shown as not due. Audited by the person's id.",
      security,
      request: { params: PersonParam, query: MarQuery },
      responses: { 200: jsonBody(MarChart, "The MAR"), ...errorResponses, ...notFoundResponse },
    }),
    async (c) => {
      const access = await requireAnyPermission(c, [...READERS]);
      const { id } = c.req.valid("param");
      const { cycleStart } = c.req.valid("query");
      const body = await withTenant(c, async (tx) => {
        const person = await loadPerson(tx, id);
        const days = await rateNumber(
          tx,
          access.tenantId,
          MEDICINES_RATE_KEYS.orderingCycleDays,
          person.nation,
          cycleStart,
        );
        const cycle = marCycle(cycleStart, { orderingCycleDays: days });
        const all = await personEntries(tx, id);
        const now = new Date();
        const doses = all.flatMap(({ entry }) => {
          const entryStatus = marEntryStatus(entry, now, UNCHECKED_POLICY);
          return [
            ...marEntryDoses(entry, cycle).map((d) => ({ d, notDue: false })),
            ...marEntryTimesBeforeRecorded(entry, cycle).map((d) => ({ d, notDue: true })),
          ].map(({ d, notDue }) => ({
            medicineEntryId: entry.id,
            dueAt: d.dueAt.toISOString(),
            date: d.date,
            time: d.time,
            dayName: d.dayName,
            doseInWords: formatDose(d.dose),
            clockChange: d.clockChange,
            sameInstantAs: d.sameInstantAs,
            lastDayOfShorterMonth: d.lastDayOfShorterMonth,
            notDue,
            entryStatus,
          }));
        });
        doses.sort((a, b) => a.dueAt.localeCompare(b.dueAt));
        await audit(c, tx, access, {
          action: "medicines.entry.viewed",
          resourceType: "person",
          resourceId: id,
          scope: { mar: cycleStart },
        });
        return {
          cycle: { startsOn: cycle.startsOn, endsOn: cycle.endsOn, days: cycle.days },
          clockChanges: [...clockChangesIn(cycle)],
          doses,
        };
      });
      return c.json(body, 200);
    },
  )
  .openapi(
    createRoute({
      method: "post",
      path: "/v1/people/{id}/medicines",
      tags,
      summary: "Transcribe a new MAR entry from its source document",
      description:
        "A dm+d product, a route and units dm+d gives, a schedule or a when-required dose, the prescriber and the source document. It is not yet checked until a second person checks it. One entry per dm+d product (rule 6). Audited.",
      security,
      request: {
        params: PersonParam,
        body: { content: { "application/json": { schema: TranscribeMedicine } } },
      },
      responses: {
        201: jsonBody(MedicineEntry, "Transcribed"),
        ...errorResponses,
        ...notFoundResponse,
      },
    }),
    async (c) => {
      const access = await requirePermission(c, WRITER);
      const { id } = c.req.valid("param");
      const body = c.req.valid("json");
      const now = new Date();
      const facts = await factsFor(c, body.product);
      const named = canonical(body, facts);
      const out = await withTenant(c, async (tx) => {
        await loadPerson(tx, id);
        await lockPerson(tx, id);
        await requireDocuments(tx, id, [body.source.documentId]);
        const all = await personEntries(tx, id);
        const result = transcribeMarEntry(draftOf(id, named), facts, {
          id: randomUUID(),
          by: access.tenantUserId,
          at: now,
          origin: "transcribed",
          earlierEntries: all
            .map((s) => s.entry)
            .filter((e) => e.product.vmpId === body.product.vmpId),
          reanchorReason: body.reanchorReason,
          earlierDosesDueReason: body.earlierDosesDueReason,
        });
        if (!result.ok) throw refusal(result.issues);
        await guardConcurrent(() => insertEntry(tx, result.entry, result.entry.id));
        await audit(c, tx, access, {
          action: "medicines.entry.transcribed",
          resourceType: "medication",
          resourceId: result.entry.id,
          scope: { personId: id },
        });
        await changed(tx, result.entry, "changed");
        return entryOut({ entry: result.entry, medicineId: result.entry.id }, now);
      });
      return c.json(out, 201);
    },
  )
  .openapi(
    createRoute({
      method: "post",
      path: "/v1/medicines/{entryId}/versions",
      tags,
      summary: "Change a medicine: a new version, not yet checked",
      description:
        "The same dm+d product; now or later, while a version is in force; never part-way through a day with doses (except a correction after a check found a difference). `expectedVersion` is the latest version read. Audited.",
      security,
      request: {
        params: EntryParam,
        body: { content: { "application/json": { schema: ChangeMedicine } } },
      },
      responses: {
        201: jsonBody(MedicineChanged, "Changed"),
        ...errorResponses,
        ...notFoundResponse,
        ...conflictResponse,
      },
    }),
    async (c) => {
      const access = await requirePermission(c, WRITER);
      const { entryId } = c.req.valid("param");
      const body = c.req.valid("json");
      const now = new Date();
      const facts = await factsFor(c, body.product);
      const named = canonical(body, facts);
      const out = await withTenant(c, async (tx) => {
        const { chain, medicineId, personId } = await loadEntry(tx, entryId);
        requireLatest(chain, body.expectedVersion);
        await requireDocuments(tx, personId, [body.source.documentId]);
        const result = changeMarEntry(
          chain.map((s) => s.entry),
          draftOf(personId, named),
          facts,
          {
            id: randomUUID(),
            by: access.tenantUserId,
            at: now,
            origin: "transcribed",
            reanchorReason: body.reanchorReason,
            withdrawLaterReason: body.withdrawLaterReason,
          },
        );
        if (!result.ok) throw refusal(result.issues);
        await guardConcurrent(() => applyChange(tx, result, medicineId, null));
        await audit(c, tx, access, {
          action: "medicines.entry.changed",
          resourceType: "medication",
          resourceId: result.next.id,
          scope: {
            personId,
            replaces: result.replaced.id,
            withdrawn: result.withdrawn.map((w) => w.id),
          },
        });
        await changed(tx, result.next, "changed");
        return {
          entry: entryOut({ entry: result.next, medicineId }, now),
          withdrawn: result.withdrawn.map((w) => w.id),
        };
      });
      return c.json(out, 201);
    },
  )
  .openapi(
    createRoute({
      method: "post",
      path: "/v1/medicines/{entryId}/check",
      tags,
      summary: "Record the second check of an entry against its source document",
      description:
        "By someone other than the transcriber, with current medicines competence (read on the server from the workforce port, never from the request). Audited.",
      security,
      request: {
        params: EntryParam,
        body: { content: { "application/json": { schema: CheckMedicine } } },
      },
      responses: {
        200: jsonBody(MedicineEntry, "Checked"),
        ...errorResponses,
        ...notFoundResponse,
        ...conflictResponse,
      },
    }),
    async (c) => {
      const access = await requirePermission(c, WRITER);
      const { entryId } = c.req.valid("param");
      const body = c.req.valid("json");
      const now = new Date();
      const competence = await c
        .get("services")
        .medicines.competence.forMember(access.tenantId, access.tenantUserId, now);
      const out = await withAuditedRefusal(c, access, () =>
        withTenant(c, async (tx) => {
          const { stored, medicineId } = await loadEntry(tx, entryId);
          const result = recordSecondCheck(stored.entry, {
            by: access.tenantUserId,
            at: now,
            competence,
            comparedWithSource: body.comparedWithSource,
            outcome: body.outcome,
            difference: body.difference,
          });
          if (!result.ok) {
            throw new AuditedRefusal(refusal(result.issues), {
              action: "medicines.entry.checked",
              outcome: "denied",
              resourceType: "medication",
              resourceId: entryId,
              scope: {
                personId: stored.entry.personId,
                problems: [...new Set(result.issues.map((i) => i.problem))],
              },
            });
          }
          await guardConcurrent(() => updateEntry(tx, result.entry));
          await audit(c, tx, access, {
            action:
              body.outcome === "matches_source"
                ? "medicines.entry.checked"
                : "medicines.entry.check_found_difference",
            resourceType: "medication",
            resourceId: entryId,
            scope: { personId: stored.entry.personId },
          });
          return entryOut({ entry: result.entry, medicineId }, now);
        }),
      );
      return c.json(out, 200);
    },
  )
  .openapi(
    createRoute({
      method: "post",
      path: "/v1/medicines/{entryId}/stop",
      tags,
      summary: "Stop a medicine now or later, with the reason and the document that says so",
      description:
        "Doses before the stop stay. `expectedVersion` is the latest version read. Audited.",
      security,
      request: {
        params: EntryParam,
        body: { content: { "application/json": { schema: StopMedicine } } },
      },
      responses: {
        200: jsonBody(MedicineChanged, "Stopped"),
        ...errorResponses,
        ...notFoundResponse,
        ...conflictResponse,
      },
    }),
    async (c) => {
      const access = await requirePermission(c, WRITER);
      const { entryId } = c.req.valid("param");
      const body = c.req.valid("json");
      const now = new Date();
      const out = await withTenant(c, async (tx) => {
        const { chain, medicineId, stored, personId } = await loadEntry(tx, entryId);
        requireLatest(chain, body.expectedVersion);
        await requireDocuments(tx, personId, [body.source.documentId]);
        const result = stopMarEntry(
          chain.map((s) => s.entry),
          {
            by: access.tenantUserId,
            at: now,
            effectiveAt: new Date(body.effectiveAt),
            reason: body.reason,
            source: body.source,
          },
          { withdrawLaterReason: body.withdrawLaterReason },
        );
        if (!result.ok) throw refusal(result.issues);
        await guardConcurrent(() => applyStop(tx, result));
        const target = result.stopped ?? stored.entry;
        await audit(c, tx, access, {
          action: "medicines.entry.stopped",
          resourceType: "medication",
          resourceId: target.id,
          scope: { personId: target.personId, withdrawn: result.withdrawn.map((w) => w.id) },
        });
        await changed(tx, target, "stopped");
        return {
          entry: entryOut({ entry: result.stopped ?? stored.entry, medicineId }, now),
          withdrawn: result.withdrawn.map((w) => w.id),
        };
      });
      return c.json(out, 200);
    },
  )
  .openapi(
    createRoute({
      method: "post",
      path: "/v1/people/{id}/medicine-reconciliations",
      tags,
      summary:
        "Start a medicines reconciliation for an admission, transfer, return from hospital or change",
      description:
        "Records the entries to decide on now (`entriesToReconcile`, from dates, never by state). One open reconciliation per person. Audited.",
      security,
      request: {
        params: PersonParam,
        body: { content: { "application/json": { schema: StartReconciliation } } },
      },
      responses: {
        201: jsonBody(ReconciliationOut, "Started"),
        ...errorResponses,
        ...notFoundResponse,
        ...conflictResponse,
      },
    }),
    async (c) => {
      const access = await requirePermission(c, WRITER);
      const { id } = c.req.valid("param");
      const body = c.req.valid("json");
      const now = new Date();
      const out = await withTenant(c, async (tx) => {
        await loadPerson(tx, id);
        await lockPerson(tx, id);
        let triggeredAt = body.triggeredAt ? new Date(body.triggeredAt) : now;
        let placementId: string | null = null;
        let hospitalTransferId: string | null = null;
        if (body.trigger === "admission" || body.trigger === "return_from_hospital") {
          const event = (await triggerEvents(tx, id)).find(
            (e) => e.id === body.eventId && e.kind === body.trigger,
          );
          if (!event) {
            throw problems.invalid(
              body.trigger === "admission"
                ? "Choose the admission this reconciliation is for."
                : "Choose the return from hospital this reconciliation is for.",
            );
          }
          triggeredAt = event.at;
          if (body.trigger === "admission") placementId = event.id;
          else hospitalTransferId = event.id;
        } else if (body.eventId) {
          throw problems.invalid("A transfer or a change names no admission or return.");
        }
        if (triggeredAt.getTime() > now.getTime()) {
          throw problems.invalid("A reconciliation answers something that has happened.");
        }
        const all = await personEntries(tx, id);
        const entriesAtStart = entriesToReconcile(
          all.map((s) => s.entry),
          now,
        ).map((e) => ({ entryId: e.entryId, version: e.version }));
        const recId = randomUUID();
        await guardConcurrent(() =>
          tx.insert(medicationReconciliation).values({
            id: recId,
            personId: id,
            trigger: body.trigger,
            placementId,
            hospitalTransferId,
            triggeredAt,
            startedBy: access.tenantUserId,
            startedAt: now,
            entriesAtStart,
          }),
        );
        await audit(c, tx, access, {
          action: "medicines.reconciliation.started",
          resourceType: "medication_reconciliation",
          resourceId: recId,
          scope: { personId: id, trigger: body.trigger },
        });
        return recOut(await loadReconciliation(tx, id, recId));
      });
      return c.json(out, 201);
    },
  )
  .openapi(
    createRoute({
      method: "get",
      path: "/v1/people/{id}/medicine-reconciliations/{recId}",
      tags,
      summary: "A reconciliation with its sources, lines and decisions",
      description: "Audited by its id.",
      security,
      request: { params: RecParam },
      responses: {
        200: jsonBody(ReconciliationOut, "The reconciliation"),
        ...errorResponses,
        ...notFoundResponse,
      },
    }),
    async (c) => {
      const access = await requireAnyPermission(c, [...READERS]);
      const { id, recId } = c.req.valid("param");
      const out = await withTenant(c, async (tx) => {
        const loaded = await loadReconciliation(tx, id, recId);
        await audit(c, tx, access, {
          action: "medicines.reconciliation.viewed",
          resourceType: "medication_reconciliation",
          resourceId: recId,
        });
        return recOut(loaded);
      });
      return c.json(out, 200);
    },
  )
  .openapi(
    createRoute({
      method: "post",
      path: "/v1/people/{id}/medicine-reconciliations/{recId}/sources",
      tags,
      summary: "Add a source document to an open reconciliation",
      description: "Append-only. Audited.",
      security,
      request: {
        params: RecParam,
        body: { content: { "application/json": { schema: AddReconciliationSource } } },
      },
      responses: {
        201: jsonBody(ReconciliationOut, "Added"),
        ...errorResponses,
        ...notFoundResponse,
        ...conflictResponse,
      },
    }),
    async (c) => {
      const access = await requirePermission(c, WRITER);
      const { id, recId } = c.req.valid("param");
      const body = c.req.valid("json");
      const out = await withTenant(c, async (tx) => {
        // Serialised with completion, so nothing is added to a reconciliation being completed.
        await lockPerson(tx, id);
        const { rec } = await loadReconciliation(tx, id, recId);
        requireOpen(rec);
        if (new Date(body.receivedAt).getTime() > Date.now()) {
          throw problems.invalid("A source is received now or earlier.");
        }
        await requireDocuments(tx, id, [body.documentId]);
        const [row] = await tx
          .insert(medicationReconciliationSource)
          .values({
            personId: id,
            reconciliationId: recId,
            kind: body.kind,
            reference: body.reference,
            documentId: body.documentId,
            receivedAt: new Date(body.receivedAt),
            currentBecause: body.currentBecause,
          })
          .returning({ id: medicationReconciliationSource.id });
        await audit(c, tx, access, {
          action: "medicines.reconciliation.source_added",
          resourceType: "medication_reconciliation",
          resourceId: recId,
          scope: { sourceId: row?.id, kind: body.kind },
        });
        return recOut(await loadReconciliation(tx, id, recId));
      });
      return c.json(out, 201);
    },
  )
  .openapi(
    createRoute({
      method: "post",
      path: "/v1/people/{id}/medicine-reconciliations/{recId}/items",
      tags,
      summary: "Add a line from a source, as written, with its dm+d product and what it says",
      description: "Append-only. Audited.",
      security,
      request: {
        params: RecParam,
        body: { content: { "application/json": { schema: AddReconciliationItem } } },
      },
      responses: {
        201: jsonBody(ReconciliationOut, "Added"),
        ...errorResponses,
        ...notFoundResponse,
        ...conflictResponse,
      },
    }),
    async (c) => {
      const access = await requirePermission(c, WRITER);
      const { id, recId } = c.req.valid("param");
      const body = c.req.valid("json");
      if (body.product && !isDmdProduct(body.product)) {
        throw problems.invalid("Choose the line's medicine from dm+d, or leave it uncoded.");
      }
      // dm+d's own name for the line's product, never the request's.
      const productName = body.product ? (await factsFor(c, body.product)).name : null;
      const out = await withTenant(c, async (tx) => {
        // Serialised with completion, so no undecided line arrives while it completes.
        await lockPerson(tx, id);
        const { rec, sources } = await loadReconciliation(tx, id, recId);
        requireOpen(rec);
        if (!sources.some((s) => s.id === body.sourceId)) throw problems.notFound();
        const [row] = await tx
          .insert(medicationReconciliationItem)
          .values({
            personId: id,
            reconciliationId: recId,
            sourceId: body.sourceId,
            asWritten: body.asWritten,
            vmpId: body.product?.vmpId ?? null,
            ampId: body.product?.ampId ?? null,
            productName,
            says: body.says,
          })
          .returning({ id: medicationReconciliationItem.id });
        await audit(c, tx, access, {
          action: "medicines.reconciliation.item_added",
          resourceType: "medication_reconciliation",
          resourceId: recId,
          scope: { itemId: row?.id },
        });
        return recOut(await loadReconciliation(tx, id, recId));
      });
      return c.json(out, 201);
    },
  )
  .openapi(
    createRoute({
      method: "put",
      path: "/v1/people/{id}/medicine-reconciliations/{recId}/decisions",
      tags,
      summary: "Replace the decisions made so far on an open reconciliation",
      description:
        "Each decision names an entry the reconciliation decides on or a line from its sources. The rules are tried when it completes. Audited with counts.",
      security,
      request: {
        params: RecParam,
        body: { content: { "application/json": { schema: PutReconciliationDecisions } } },
      },
      responses: {
        200: jsonBody(ReconciliationOut, "Saved"),
        ...errorResponses,
        ...notFoundResponse,
        ...conflictResponse,
      },
    }),
    async (c) => {
      const access = await requirePermission(c, WRITER);
      const { id, recId } = c.req.valid("param");
      const body = c.req.valid("json");
      const now = new Date();
      // Each draft is stored with dm+d's own names for its product, route and units.
      const named = async <T extends { draft: BodyDraft }>(d: T): Promise<T> => ({
        ...d,
        draft: canonical(d.draft, await factsFor(c, d.draft.product)),
      });
      const entryDecisionsIn = await Promise.all(
        body.entryDecisions.map((d) => (d.kind === "change" ? named(d) : d)),
      );
      const itemDecisionsIn = await Promise.all(
        body.itemDecisions.map((d) => (d.kind === "start" ? named(d) : d)),
      );
      const out = await withTenant(c, async (tx) => {
        await lockPerson(tx, id);
        const { rec, items } = await loadReconciliation(tx, id, recId);
        requireOpen(rec);
        if (rec.version !== body.expectedVersion) throw problems.conflict();
        const itemIds = new Set(items.map((i) => i.id));
        const entryIds = new Set((await personEntries(tx, id)).map((s) => s.entry.id));
        for (const d of body.entryDecisions) {
          if (!entryIds.has(d.entryId))
            throw problems.invalid("A decision names an entry this person does not have.");
          if ("itemIds" in d && d.itemIds.some((i) => !itemIds.has(i))) {
            throw problems.invalid("A decision links a line that is not in this reconciliation.");
          }
        }
        for (const d of body.itemDecisions) {
          if (!itemIds.has(d.itemId))
            throw problems.invalid("A decision names a line that is not in this reconciliation.");
        }
        await tx
          .update(medicationReconciliationDecision)
          .set({ deletedAt: now })
          .where(
            and(
              eq(medicationReconciliationDecision.reconciliationId, recId),
              isNull(medicationReconciliationDecision.deletedAt),
            ),
          );
        const rows = [
          ...entryDecisionsIn.map((d) => ({
            entryId: d.entryId,
            itemId: null,
            kind: d.kind,
            decision: d,
          })),
          ...itemDecisionsIn.map((d) => ({
            entryId: null,
            itemId: d.itemId,
            kind: d.kind,
            decision: d,
          })),
        ];
        if (rows.length > 0) {
          await guardConcurrent(() =>
            tx.insert(medicationReconciliationDecision).values(
              rows.map((r) => ({
                ...r,
                personId: id,
                reconciliationId: recId,
                decidedBy: access.tenantUserId,
                decidedAt: now,
              })),
            ),
          );
        }
        const [bumped] = await tx
          .update(medicationReconciliation)
          .set({ updatedAt: now })
          .where(
            and(
              eq(medicationReconciliation.id, recId),
              eq(medicationReconciliation.version, body.expectedVersion),
            ),
          )
          .returning({ id: medicationReconciliation.id });
        if (!bumped) throw problems.conflict();
        await audit(c, tx, access, {
          action: "medicines.reconciliation.decided",
          resourceType: "medication_reconciliation",
          resourceId: recId,
          scope: {
            entryDecisions: body.entryDecisions.length,
            itemDecisions: body.itemDecisions.length,
          },
        });
        return recOut(await loadReconciliation(tx, id, recId));
      });
      return c.json(out, 200);
    },
  )
  .openapi(
    createRoute({
      method: "post",
      path: "/v1/people/{id}/medicine-reconciliations/{recId}/complete",
      tags,
      summary: "Complete a reconciliation and apply its plan in one transaction",
      description:
        "Runs `completeReconciliation` (every entry and line decided, supported by its lines, the MAR rules tried, allergies compared, the person involved, the completer's competence from the workforce port) and, when it passes, records every continue, change, stop and start, at the time of completion. Completes the return from hospital's medicines check. Audited.",
      security,
      request: {
        params: RecParam,
        body: { content: { "application/json": { schema: CompleteReconciliation } } },
      },
      responses: {
        200: jsonBody(ReconciliationOut, "Completed"),
        ...errorResponses,
        ...notFoundResponse,
        ...conflictResponse,
      },
    }),
    async (c) => {
      const access = await requirePermission(c, WRITER);
      const { id, recId } = c.req.valid("param");
      const body = c.req.valid("json");
      const now = new Date();
      const services = c.get("services").medicines;
      const competence = await services.competence.forMember(
        access.tenantId,
        access.tenantUserId,
        now,
      );
      const out = await withAuditedRefusal(c, access, () =>
        withTenant(c, async (tx) => {
          await lockPerson(tx, id);
          const loaded = await loadReconciliation(tx, id, recId);
          const { rec, sources, items, decisions } = loaded;
          requireOpen(rec);
          if (rec.version !== body.expectedVersion) throw problems.conflict();
          // A source's letter may have been quarantined or removed since it was added; the plan
          // is never applied on a document the record no longer holds.
          await requireDocuments(
            tx,
            id,
            sources.map((s) => s.documentId),
          );
          const all = await personEntries(tx, id);
          const entries = all.map((s) => s.entry);
          const medicineOf = new Map(all.map((s) => [s.entry.id, s.medicineId]));
          const chainOf = (entryId: string) =>
            all.filter((s) => s.medicineId === medicineOf.get(entryId)).map((s) => s.entry);
          const entryDecisions = decisions
            .filter((d) => d.entryId)
            .map((d) =>
              entryDecisionOf(
                d.decision as z.infer<typeof PutReconciliationDecisions>["entryDecisions"][number],
              ),
            );
          const itemDecisions = decisions
            .filter((d) => d.itemId)
            .map((d) =>
              itemDecisionOf(
                d.decision as z.infer<typeof PutReconciliationDecisions>["itemDecisions"][number],
              ),
            );
          // dm+d facts for every product a draft names, read before the rules run.
          const products = [
            ...entryDecisions.flatMap((d) => (d.kind === "change" ? [d.draft.product] : [])),
            ...itemDecisions.flatMap((d) => (d.kind === "start" ? [d.draft.product] : [])),
          ];
          const facts = new Map<string, DmdProductFacts>();
          for (const p of products) {
            const f = isDmdProduct(p) ? await services.dmd.facts(p) : null;
            // A product dm+d does not hold is refused in those words, not as a route problem.
            if (!f) throw dmdUnknown(services.dmd.loaded);
            facts.set(`${p.vmpId}:${p.ampId ?? ""}`, f);
          }
          const dmdFacts = (p: DmdProductRef) =>
            facts.get(`${p.vmpId}:${p.ampId ?? ""}`) ?? {
              permittedRoutes: [],
              permittedDoseUnits: [],
            };
          const reconciliation: Reconciliation = {
            id: rec.id,
            personId: id,
            trigger: rec.trigger as Reconciliation["trigger"],
            triggeredAt: rec.triggeredAt,
            entriesAtStart: rec.entriesAtStart as Reconciliation["entriesAtStart"],
            sources: sources.map(sourceOf),
            items: items.map((i) => ({
              id: i.id,
              sourceId: i.sourceId,
              asWritten: i.asWritten,
              product:
                i.vmpId && i.productName
                  ? { vmpId: i.vmpId, ampId: i.ampId, name: i.productName }
                  : null,
              says: i.says as "start" | "continue" | "change" | "stop" | "unclear",
            })),
          };
          const outcome = completeReconciliation({
            reconciliation,
            currentEntries: entriesToReconcile(entries, now),
            entryVersions: chainOf,
            earlierEntries: (p) => entries.filter((e) => e.product.vmpId === p.vmpId),
            entryDecisions,
            itemDecisions,
            completer: { id: access.tenantUserId, competence },
            completedAt: now,
            allergiesCompared: body.allergiesCompared,
            personInvolvement: body.personInvolvement,
            noDischargeLetterReason: body.noDischargeLetterReason,
            dmdFacts,
          });
          if (!outcome.ok) {
            // Recorded outside this transaction, so the refusal is kept (section 5.5).
            throw new AuditedRefusal(refusal(outcome.issues), {
              action: "medicines.reconciliation.completed",
              outcome: "denied",
              resourceType: "medication_reconciliation",
              resourceId: recId,
              scope: {
                personId: id,
                problems: [...new Set(outcome.issues.map((i) => i.problem))],
              },
            });
          }
          const plan = outcome.plan;
          const made = new Map<string, string>();
          // Apply the plan with the time it was tried at (completedAt), never a later one (HZ-010).
          for (const ch of plan.changes) {
            const versions = chainOf(ch.entryId);
            const latest = await personEntries(tx, id);
            const fresh = latest
              .filter((s) => s.medicineId === medicineOf.get(ch.entryId))
              .map((s) => s.entry);
            const result = changeMarEntry(
              fresh.length > 0 ? fresh : versions,
              ch.draft,
              dmdFacts(ch.draft.product),
              {
                id: randomUUID(),
                by: access.tenantUserId,
                at: plan.completedAt,
                origin: "reconciliation",
                reanchorReason: ch.reanchorReason,
                withdrawLaterReason: ch.withdrawLaterReason,
              },
            );
            if (!result.ok) throw refusal(result.issues);
            await guardConcurrent(() =>
              applyChange(tx, result, medicineOf.get(ch.entryId) as string, recId),
            );
            made.set(`entry:${ch.entryId}`, result.next.id);
            await audit(c, tx, access, {
              action: "medicines.entry.changed",
              resourceType: "medication",
              resourceId: result.next.id,
              scope: { personId: id, reconciliationId: recId, replaces: result.replaced.id },
            });
            await changed(tx, result.next, "changed");
          }
          for (const st of plan.stops) {
            const latest = await personEntries(tx, id);
            const fresh = latest
              .filter((s) => s.medicineId === medicineOf.get(st.entryId))
              .map((s) => s.entry);
            const result = stopMarEntry(
              fresh,
              {
                by: access.tenantUserId,
                at: plan.completedAt,
                effectiveAt: plan.completedAt,
                reason: st.reason,
                source: st.source,
              },
              { withdrawLaterReason: st.withdrawLaterReason },
            );
            if (!result.ok) throw refusal(result.issues);
            await guardConcurrent(() => applyStop(tx, result));
            const target = result.stopped ?? (fresh[0] as MarEntry);
            await audit(c, tx, access, {
              action: "medicines.entry.stopped",
              resourceType: "medication",
              resourceId: target.id,
              scope: { personId: id, reconciliationId: recId },
            });
            await changed(tx, target, "stopped");
          }
          for (const s of plan.starts) {
            const latest = await personEntries(tx, id);
            const result = transcribeMarEntry(s.draft, dmdFacts(s.draft.product), {
              id: randomUUID(),
              by: access.tenantUserId,
              at: plan.completedAt,
              origin: "reconciliation",
              earlierEntries: latest
                .map((x) => x.entry)
                .filter((e) => e.product.vmpId === s.draft.product.vmpId),
              reanchorReason: s.reanchorReason,
              earlierDosesDueReason: s.earlierDosesDueReason,
            });
            if (!result.ok) throw refusal(result.issues);
            await guardConcurrent(() =>
              insertEntry(tx, result.entry, result.entry.id, { reconciliationId: recId }),
            );
            made.set(`item:${s.itemId}`, result.entry.id);
            await audit(c, tx, access, {
              action: "medicines.entry.transcribed",
              resourceType: "medication",
              resourceId: result.entry.id,
              scope: { personId: id, reconciliationId: recId },
            });
            await changed(tx, result.entry, "changed");
          }
          for (const d of decisions) {
            const key = d.entryId ? `entry:${d.entryId}` : `item:${d.itemId}`;
            const entryId = made.get(key);
            if (entryId) {
              await tx
                .update(medicationReconciliationDecision)
                .set({ madeEntryId: entryId })
                .where(eq(medicationReconciliationDecision.id, d.id));
            }
          }
          const [done] = await tx
            .update(medicationReconciliation)
            .set({
              status: "completed",
              completedBy: access.tenantUserId,
              completedAt: plan.completedAt,
              allergiesCompared: body.allergiesCompared ? "yes" : "no",
              personInvolved: body.personInvolvement.involved ? "yes" : "no",
              notInvolvedReason: body.personInvolvement.involved
                ? null
                : body.personInvolvement.reason,
              noDischargeLetterReason: body.noDischargeLetterReason,
            })
            .where(
              and(
                eq(medicationReconciliation.id, recId),
                eq(medicationReconciliation.version, body.expectedVersion),
              ),
            )
            .returning({ id: medicationReconciliation.id });
          if (!done) throw problems.conflict();
          if (rec.hospitalTransferId)
            await completeReturnCheck(tx, access, rec.hospitalTransferId, plan.completedAt);
          await audit(c, tx, access, {
            action: "medicines.reconciliation.completed",
            resourceType: "medication_reconciliation",
            resourceId: recId,
            scope: {
              personId: id,
              continued: plan.continued.length,
              changes: plan.changes.length,
              stops: plan.stops.length,
              starts: plan.starts.length,
            },
          });
          await publish(tx, {
            context: "medicines",
            aggregateType: "medication_reconciliation",
            aggregateId: recId,
            type: "medicines.reconciliation.completed",
            payload: { personId: id, trigger: rec.trigger },
          });
          return recOut(await loadReconciliation(tx, id, recId));
        }),
      );
      return c.json(out, 200);
    },
  );

/**
 * The return from hospital's medicines check (PEOP-010, `medicines_reconciled`) is completed by
 * the reconciliation for that return, with its task, never ticked on its own.
 */
async function completeReturnCheck(
  tx: Transaction,
  access: TenantAccess,
  transferId: string,
  at: Date,
) {
  const [row] = await tx
    .select({ returnChecks: hospitalTransfer.returnChecks })
    .from(hospitalTransfer)
    .where(eq(hospitalTransfer.id, transferId))
    // Locked, so a check recorded at the same moment is never written over.
    .for("update");
  const checks = { ...((row?.returnChecks ?? {}) as Record<string, Record<string, unknown>>) };
  const check = checks[RETURN_CHECK];
  if (check && !check.doneAt) {
    checks[RETURN_CHECK] = { ...check, doneBy: access.tenantUserId, doneAt: at.toISOString() };
    await tx
      .update(hospitalTransfer)
      .set({ returnChecks: checks })
      .where(eq(hospitalTransfer.id, transferId));
  }
  await tx
    .update(task)
    .set({
      status: "done",
      completedAt: at,
      completedBy: access.tenantUserId,
      evidenceType: "hospital_transfer",
      evidenceId: transferId,
    })
    .where(
      and(
        eq(task.sourceType, "hospital_transfer"),
        eq(task.sourceId, transferId),
        eq(task.kind, returnCheckTaskKind(RETURN_CHECK)),
        inArray(task.status, ["open", "in_progress"]),
      ),
    );
}
