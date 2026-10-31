import {
  CancelOutage,
  CloseOutage,
  CorrectOutage,
  DeclareOutage,
  OutageItem,
  OutageList,
  OutageReconciliation,
  type OutageReconciliation as OutageReconciliationT,
  ReconcileOutage,
} from "@harbour/contracts";
import { outage, type Transaction } from "@harbour/db";
import {
  checkOutageClosure,
  checkOutageDeclaration,
  checkOutageReconciliation,
  type OperationsRates,
  OUTAGE_CLOSURE_MESSAGES,
  OUTAGE_DECLARATION_MESSAGES,
  OUTAGE_RECONCILIATION_MESSAGES,
  OUTAGE_WORKFLOW,
  type OutageKind,
  type OutageReconciliationSummary,
  type OutageState,
  type Permission,
  type RateNation,
} from "@harbour/domain";
import { createRoute, z } from "@hono/zod-openapi";
import { and, eq, sql } from "drizzle-orm";
import type { Context } from "hono";
import { type AppEnv, requirePermission, type TenantAccess, withTenant } from "../http/context";
import { HttpProblem, problems } from "../http/problem";
import { publish } from "../outbox";
import { operationsRates, packLocation } from "../services/downtime-pack";
import {
  completeBackEntryTask,
  type OutageRow,
  outageAuthors,
  outageEntries,
  outageItem,
  outagesAt,
  outageTooLong,
  outageWindow,
  raiseBackEntryTask,
} from "../services/outages";
import { withTenantWideScope } from "../services/safety";
import { startWorkflow } from "../services/workflow";
import {
  conflictResponse,
  createRouter,
  errorResponses,
  jsonBody,
  notFoundResponse,
  security,
} from "./openapi";
import { requireReach } from "./operations";
import { audit } from "./people-shared";
import { moveOrRefuse } from "./workflow-shared";

/**
 * Outages (operations.md rules 9 to 15 and section 5; OPS-028; HZ-017). Declaring, closing,
 * reconciling, cancelling and correcting need `operations.downtime.manage` where the outage is,
 * in that permission's scope (ADR-0071); the database enforces the same rules again
 * (`app.outage_guard`), and its refusals come back as 422 in its words. Listing needs
 * `people.person.read`: an outage is shown to anyone who can see someone at its location, so a
 * care worker can enter a paper record against it (`app.outage_visible`).
 */

const MANAGE: Permission = "operations.downtime.manage";
const LIST: Permission = "people.person.read";
type Nation = Exclude<RateNation, "uk" | "all">;

const LocationParams = z.object({ id: z.uuid() });
const OutageParams = z.object({ id: z.uuid() });

const ALREADY_RECONCILED = "This outage is already reconciled.";
const CANCELLED = "This outage was cancelled, so there is nothing to reconcile.";
const tooLong = (hours: number) =>
  `An outage can last at most ${hours} hours. Check the start and end dates.`;

const OUTSIDE_UNREVIEWED =
  "Review each paper record entered against the outage with a time outside it before confirming the outage reconciled.";

function pgError(error: unknown): { code?: string; message?: string } {
  const e = error as {
    code?: string;
    message?: string;
    cause?: { code?: string; message?: string };
  };
  return e.code ? e : (e.cause ?? {});
}

/** The database's refusals in its own words; an overlap at the same moment is a conflict. */
function onOutageError(error: unknown): never {
  const { code, message } = pgError(error);
  if (code === "23P01") {
    throw new HttpProblem(
      409,
      "outage_overlap",
      "This outage overlaps another at the location.",
      OUTAGE_DECLARATION_MESSAGES.overlaps_another_outage,
    );
  }
  if (code === "23000" && message) throw problems.invalid(message);
  throw error;
}

/**
 * The outage, where the caller's manage permission reaches its location, locked for a change.
 * One the caller cannot see is not found; when it exists elsewhere in the organisation, the
 * attempt is audited as denied first (only its location id is read in the organisation's view).
 */
async function managedOutage(
  c: Context<AppEnv>,
  tx: Transaction,
  access: TenantAccess,
  id: string,
  action: string,
  lock = true,
): Promise<OutageRow> {
  const query = tx.select().from(outage).where(eq(outage.id, id));
  const [row] = lock ? await query.for("update") : await query;
  if (!row) {
    const [elsewhere] = await withTenantWideScope(tx, () =>
      tx.select({ locationId: outage.locationId }).from(outage).where(eq(outage.id, id)),
    );
    if (elsewhere) await requireReach(c, access, MANAGE, elsewhere.locationId, action);
    throw problems.notFound();
  }
  await requireReach(c, access, MANAGE, row.locationId, action);
  return row;
}

/**
 * Closes the outage at its true end (rule 10): the back-entry deadline, the workflow, the task for
 * the Registered Manager, the audit and the `operations.outage.closed` event.
 */
async function closeOutage(
  c: Context<AppEnv>,
  tx: Transaction,
  access: TenantAccess,
  row: OutageRow,
  version: number,
  endedAt: Date,
  rates: OperationsRates,
  now: Date,
): Promise<OutageRow> {
  if (outageTooLong(row.startedAt, endedAt, now, rates)) {
    throw problems.invalid(tooLong(rates.maxOutageHours));
  }
  const check = checkOutageClosure(outageWindow(row), { endedAt, closedAt: now }, rates);
  if (!check.ok) {
    throw problems.invalid(check.problems.map((p) => OUTAGE_CLOSURE_MESSAGES[p]).join(" "));
  }
  const closed = await changeOutage(tx, row, version, {
    state: "closed",
    endedAt,
    closedAt: now,
    closedBy: access.tenantUserId,
    backEntryDueAt: check.backEntryDueAt,
  });
  await moveWorkflow(c, tx, row, "closed", null, now);
  await raiseBackEntryTask(tx, closed);
  await audit(c, tx, access, {
    action: "operations.outage.closed",
    resourceType: "outage",
    resourceId: row.id,
    scope: { locationId: closed.locationId },
  });
  await publish(tx, {
    context: "operations",
    aggregateType: "outage",
    aggregateId: row.id,
    type: "operations.outage.closed",
    payload: {
      locationId: closed.locationId,
      outageId: row.id,
      backEntryDueAt: check.backEntryDueAt.toISOString(),
    },
  });
  return closed;
}

async function ratesAt(tx: Transaction, access: TenantAccess, locationId: string, now: Date) {
  const place = await packLocation(tx, locationId);
  if (!place) throw problems.notFound();
  return operationsRates(tx, access.tenantId, place.nation as Nation, now);
}

/** Changes the outage at the version the caller saw, or refuses as a conflict. */
async function changeOutage(
  tx: Transaction,
  row: OutageRow,
  version: number,
  values: Partial<typeof outage.$inferInsert>,
): Promise<OutageRow> {
  if (row.version !== version) throw problems.conflict();
  const [updated] = await tx
    .update(outage)
    .set(values)
    .where(and(eq(outage.id, row.id), eq(outage.version, version)))
    .returning()
    .catch(onOutageError);
  if (!updated) throw problems.conflict();
  return updated;
}

async function moveWorkflow(
  c: Context<AppEnv>,
  tx: Transaction,
  row: OutageRow,
  to: OutageState,
  reason: string | null,
  now: Date,
): Promise<void> {
  if (!row.workflowInstanceId) return;
  await moveOrRefuse(
    c,
    tx,
    OUTAGE_WORKFLOW,
    { subjectType: "outage", subjectId: row.id },
    to,
    reason,
    now,
  );
}

/** What stops reconciling, in words, given the entries reviewed so far (rule 14; H-203, H-207). */
function blockers(
  row: OutageRow,
  summary: OutageReconciliationSummary,
  outsideUnexplained: readonly string[],
  enteredByYou: boolean,
  reviewed: ReadonlySet<string>,
): string[] {
  const out: string[] = [];
  if (row.state === "reconciled") out.push(ALREADY_RECONCILED);
  else if (row.state === "cancelled") out.push(CANCELLED);
  else if (row.state !== "closed") out.push(OUTAGE_RECONCILIATION_MESSAGES.not_closed);
  if (summary.duplicateGroups.some((group) => group.some((id) => !reviewed.has(id)))) {
    out.push(OUTAGE_RECONCILIATION_MESSAGES.duplicates_unreviewed);
  }
  if (outsideUnexplained.some((id) => !reviewed.has(id))) out.push(OUTSIDE_UNREVIEWED);
  if (enteredByYou) out.push(OUTAGE_RECONCILIATION_MESSAGES.reconciler_entered_records);
  return out;
}

async function reconciliation(
  tx: Transaction,
  access: TenantAccess,
  row: OutageRow,
  confirmation: { readonly statement: string | null; readonly reviewedEntryIds: readonly string[] },
  now: Date,
) {
  const rates = await ratesAt(tx, access, row.locationId, now);
  const entries = await outageEntries(tx, row, rates, now);
  const enteredByYou = (await outageAuthors(tx, row.id)).has(access.tenantUserId);
  const check = checkOutageReconciliation(
    outageWindow(row),
    entries.records,
    { by: access.tenantUserId, ...confirmation },
    rates,
  );
  const reviewed = new Set(confirmation.reviewedEntryIds);
  const stops = blockers(row, check.summary, entries.outsideUnexplained, enteredByYou, reviewed);
  if (!check.ok && check.problems.includes("statement_required")) {
    stops.push(OUTAGE_RECONCILIATION_MESSAGES.statement_required);
  }
  return { summary: check.summary, entries, enteredByYou, stops };
}

const outageRoute = <P extends string>(route: {
  readonly method: "post";
  readonly path: P;
  readonly summary: string;
  readonly body: z.ZodType;
}) =>
  createRoute({
    method: route.method,
    path: route.path,
    tags: ["operations"],
    summary: route.summary,
    security,
    request: {
      params: OutageParams,
      body: { content: { "application/json": { schema: route.body } } },
    },
    responses: {
      200: jsonBody(OutageItem, "The outage"),
      ...errorResponses,
      ...notFoundResponse,
      ...conflictResponse,
    },
  });

export const outagesRouter = createRouter()
  .openapi(
    createRoute({
      method: "get",
      path: "/v1/locations/{id}/outages",
      tags: ["operations"],
      summary: "The outages at a location, newest first",
      description:
        "Shown to anyone who can see someone at the location, so a paper record can be entered against its outage.",
      security,
      request: { params: LocationParams },
      responses: { 200: jsonBody(OutageList, "The outages"), ...errorResponses },
    }),
    async (c) => {
      await requirePermission(c, LIST);
      const { id } = c.req.valid("param");
      const items = await withTenant(c, async (tx) => (await outagesAt(tx, id)).map(outageItem));
      return c.json({ items }, 200);
    },
  )
  .openapi(
    createRoute({
      method: "post",
      path: "/v1/locations/{id}/outages",
      tags: ["operations"],
      summary: "Declare an outage at a location",
      description:
        "Declared now, in your name, open (or with its end when declared after it ended). Its start may be earlier; a declaration made more than `care_note.late_entry_hours` after it is flagged late. Outages at a location never overlap (rule 9).",
      security,
      request: {
        params: LocationParams,
        body: { content: { "application/json": { schema: DeclareOutage } } },
      },
      responses: {
        201: jsonBody(OutageItem, "Declared"),
        ...errorResponses,
        ...notFoundResponse,
        ...conflictResponse,
      },
    }),
    async (c) => {
      const access = await requirePermission(c, MANAGE);
      const { id } = c.req.valid("param");
      const body = c.req.valid("json");
      await requireReach(c, access, MANAGE, id, "operations.outage.declared");
      const now = new Date();
      const item = await withTenant(c, async (tx) => {
        const rates = await ratesAt(tx, access, id, now);
        const existing = (await outagesAt(tx, id)).map(outageWindow);
        const check = checkOutageDeclaration(
          {
            locationId: id,
            kind: body.kind,
            startedAt: new Date(body.startedAt),
            endedAt: body.endedAt ? new Date(body.endedAt) : null,
            declaredAt: now,
            description: body.description,
          },
          existing,
          rates,
        );
        if (!check.ok) {
          throw problems.invalid(
            check.problems.map((p) => OUTAGE_DECLARATION_MESSAGES[p]).join(" "),
          );
        }
        const startedAt = new Date(body.startedAt);
        const endedAt = body.endedAt ? new Date(body.endedAt) : null;
        if (outageTooLong(startedAt, endedAt, now, rates)) {
          throw problems.invalid(tooLong(rates.maxOutageHours));
        }
        const { rows } = await tx.execute<{ id: string }>(sql`SELECT app.uuid_v7() AS id`);
        const outageId = rows[0]?.id as string;
        const instance = await startWorkflow(
          tx,
          access.tenantId,
          OUTAGE_WORKFLOW,
          { subjectType: "outage", subjectId: outageId },
          now,
        );
        const [row] = await tx
          .insert(outage)
          .values({
            id: outageId,
            locationId: id,
            kind: body.kind,
            description: body.description,
            startedAt,
            endedAt,
            declaredBy: access.tenantUserId,
            workflowInstanceId: instance.id,
          })
          .returning()
          .catch(onOutageError);
        if (!row) throw problems.conflict();
        await audit(c, tx, access, {
          action: "operations.outage.declared",
          resourceType: "outage",
          resourceId: row.id,
          scope: { locationId: id, declaredLate: row.declaredLate },
        });
        await publish(tx, {
          context: "operations",
          aggregateType: "outage",
          aggregateId: row.id,
          type: "operations.outage.declared",
          payload: { locationId: id, outageId: row.id, declaredLate: row.declaredLate },
        });
        // Declared after it ended: closed at once, so the back-entry task is raised (HZ-017).
        if (endedAt === null) return outageItem(row);
        return outageItem(await closeOutage(c, tx, access, row, row.version, endedAt, rates, now));
      });
      return c.json(item, 201);
    },
  )
  .openapi(
    outageRoute({
      method: "post",
      path: "/v1/outages/{id}/close",
      summary: "Close an outage when systems are back",
      body: CloseOutage,
    }),
    async (c) => {
      const access = await requirePermission(c, MANAGE);
      const { id } = c.req.valid("param");
      const body = c.req.valid("json") as z.infer<typeof CloseOutage>;
      const now = new Date();
      const item = await withTenant(c, async (tx) => {
        const row = await managedOutage(c, tx, access, id, "operations.outage.closed");
        const rates = await ratesAt(tx, access, row.locationId, now);
        const closed = await closeOutage(
          c,
          tx,
          access,
          row,
          body.version,
          new Date(body.endedAt),
          rates,
          now,
        );
        return outageItem(closed);
      });
      return c.json(item, 200);
    },
  )
  .openapi(
    createRoute({
      method: "get",
      path: "/v1/outages/{id}/reconciliation",
      tags: ["operations"],
      summary: "What reconciling the outage needs: the counts, possible duplicates and blockers",
      description:
        "Counted in the organisation's view, so a paper record about someone you can no longer see still counts (rule 14). Ids, people and counts only.",
      security,
      request: { params: OutageParams },
      responses: {
        200: jsonBody(OutageReconciliation, "The reconciliation"),
        ...errorResponses,
        ...notFoundResponse,
      },
    }),
    async (c) => {
      const access = await requirePermission(c, MANAGE);
      const { id } = c.req.valid("param");
      const now = new Date();
      const out = await withTenant(c, async (tx): Promise<OutageReconciliationT> => {
        const row = await managedOutage(
          c,
          tx,
          access,
          id,
          "operations.outage.reconciliation_viewed",
          false,
        );
        const r = await reconciliation(
          tx,
          access,
          row,
          { statement: null, reviewedEntryIds: [] },
          now,
        );
        await audit(c, tx, access, {
          action: "operations.outage.reconciliation_viewed",
          resourceType: "outage",
          resourceId: id,
          scope: { locationId: row.locationId, backEntries: r.summary.backEntries },
        });
        return {
          outage: outageItem(row),
          backEntries: r.summary.backEntries,
          formsEntered: r.summary.formsEntered,
          entriesWithoutReference: r.summary.entriesWithoutReference,
          outsideWindow: r.summary.outsideWindow,
          people: r.summary.people,
          digitalEntriesInWindow: r.summary.digitalEntriesInWindow,
          duplicateGroups: r.summary.duplicateGroups.map((g) => [...g]),
          outsideWindowEntryIds: [...r.entries.outsideUnexplained],
          enteredByYou: r.enteredByYou,
          blockers: r.stops,
        };
      });
      return c.json(out, 200);
    },
  )
  .openapi(
    outageRoute({
      method: "post",
      path: "/v1/outages/{id}/reconcile",
      summary: "Confirm every paper record from the outage is entered and checked",
      body: ReconcileOutage,
    }),
    async (c) => {
      const access = await requirePermission(c, MANAGE);
      const { id } = c.req.valid("param");
      const body = c.req.valid("json") as z.infer<typeof ReconcileOutage>;
      const now = new Date();
      const item = await withTenant(c, async (tx) => {
        const row = await managedOutage(c, tx, access, id, "operations.outage.reconciled");
        const r = await reconciliation(tx, access, row, body, now);
        if (r.stops.length > 0) throw problems.invalid(r.stops.join(" "));
        const reconciled = await changeOutage(tx, row, body.version, {
          state: "reconciled",
          reconciledAt: now,
          reconciledBy: access.tenantUserId,
          reconciliationStatement: body.statement,
          reviewedEntryIds: [...new Set(body.reviewedEntryIds)],
          formsEntered: r.summary.formsEntered,
        });
        await moveWorkflow(c, tx, row, "reconciled", body.statement, now);
        await completeBackEntryTask(tx, id, access.tenantUserId, now);
        await audit(c, tx, access, {
          action: "operations.outage.reconciled",
          resourceType: "outage",
          resourceId: id,
          scope: {
            locationId: row.locationId,
            backEntries: r.summary.backEntries,
            formsEntered: r.summary.formsEntered,
          },
        });
        await publish(tx, {
          context: "operations",
          aggregateType: "outage",
          aggregateId: id,
          type: "operations.outage.reconciled",
          payload: { locationId: row.locationId, outageId: id },
        });
        return outageItem(reconciled);
      });
      return c.json(item, 200);
    },
  )
  .openapi(
    outageRoute({
      method: "post",
      path: "/v1/outages/{id}/cancel",
      summary: "Cancel an outage declared in error",
      body: CancelOutage,
    }),
    async (c) => {
      const access = await requirePermission(c, MANAGE);
      const { id } = c.req.valid("param");
      const body = c.req.valid("json") as z.infer<typeof CancelOutage>;
      const now = new Date();
      const item = await withTenant(c, async (tx) => {
        const row = await managedOutage(c, tx, access, id, "operations.outage.cancelled");
        if (row.state !== "declared") {
          throw problems.invalid("Only an open outage declared in error can be cancelled.");
        }
        const cancelled = await changeOutage(tx, row, body.version, {
          state: "cancelled",
          cancelledAt: now,
          cancelledBy: access.tenantUserId,
          cancellationReason: body.reason,
        });
        await moveWorkflow(c, tx, row, "cancelled", body.reason, now);
        await audit(c, tx, access, {
          action: "operations.outage.cancelled",
          resourceType: "outage",
          resourceId: id,
          scope: { locationId: row.locationId },
        });
        await publish(tx, {
          context: "operations",
          aggregateType: "outage",
          aggregateId: id,
          type: "operations.outage.cancelled",
          payload: { locationId: row.locationId, outageId: id },
        });
        return outageItem(cancelled);
      });
      return c.json(item, 200);
    },
  )
  .openapi(
    outageRoute({
      method: "post",
      path: "/v1/outages/{id}/correct",
      summary: "Correct an outage's start or end, with a reason, before it is reconciled",
      body: CorrectOutage,
    }),
    async (c) => {
      const access = await requirePermission(c, MANAGE);
      const { id } = c.req.valid("param");
      const body = c.req.valid("json") as z.infer<typeof CorrectOutage>;
      const now = new Date();
      const item = await withTenant(c, async (tx) => {
        const row = await managedOutage(c, tx, access, id, "operations.outage.corrected");
        if (row.state === "reconciled" || row.state === "cancelled") {
          throw problems.invalid("A reconciled or cancelled outage is final.");
        }
        if ((row.endedAt === null) !== (body.endedAt === null)) {
          throw problems.invalid(
            row.endedAt === null
              ? "An open outage stays open: close it to give its end."
              : "An outage that has ended keeps an end.",
          );
        }
        const startedAt = new Date(body.startedAt);
        const endedAt = body.endedAt ? new Date(body.endedAt) : null;
        const rates = await ratesAt(tx, access, row.locationId, now);
        const others = (await outagesAt(tx, row.locationId))
          .filter((o) => o.id !== id)
          .map(outageWindow);
        const check = checkOutageDeclaration(
          {
            locationId: row.locationId,
            kind: row.kind as OutageKind,
            startedAt,
            endedAt,
            declaredAt: now,
            description: row.description,
          },
          others,
          rates,
        );
        const stops: string[] = (
          check.ok ? [] : check.problems.filter((p) => p !== "description_required")
        ).map((p) => OUTAGE_DECLARATION_MESSAGES[p]);
        if (outageTooLong(startedAt, endedAt, now, rates))
          stops.push(tooLong(rates.maxOutageHours));
        const drift = rates.clockDriftMinutes * 60_000;
        if (row.closedAt && endedAt && endedAt.getTime() > row.closedAt.getTime() + drift) {
          stops.push("The outage cannot end after it was closed. Check the end time.");
        }
        if (stops.length > 0) {
          throw problems.invalid(stops.join(" "));
        }
        const corrected = await changeOutage(tx, row, body.version, {
          startedAt,
          endedAt,
          correctionReason: body.reason,
        });
        await audit(c, tx, access, {
          action: "operations.outage.corrected",
          resourceType: "outage",
          resourceId: id,
          scope: { locationId: row.locationId },
        });
        await publish(tx, {
          context: "operations",
          aggregateType: "outage",
          aggregateId: id,
          type: "operations.outage.corrected",
          payload: {
            locationId: row.locationId,
            outageId: id,
            startedAt: startedAt.toISOString(),
            endedAt: endedAt ? endedAt.toISOString() : null,
          },
        });
        return outageItem(corrected);
      });
      return c.json(item, 200);
    },
  );
