import { createHash } from "node:crypto";
import {
  DisposalOut,
  MedicineOrderList,
  MedicineOrderOut,
  MedicineOrderVersion,
  MedicineStorageList,
  MedicineStorageOut,
  NewMedicineOrder,
  NewMedicineStorage,
  NewTemperatureReading,
  OpenStockItem,
  OrderCycleOut,
  PersonStock,
  PutOrderCycle,
  RecordDisposal,
  StockCount,
  StockMoved,
  StockQuantity,
  SubmitMedicineOrder,
  TemperatureReadingList,
  TemperatureReadingRecorded,
} from "@harbour/contracts";
import {
  controlledDrugEntry,
  controlledDrugPage,
  location,
  medication,
  medicineDisposal,
  medicineOrder,
  medicineOrderCycle,
  medicineOrderLine,
  medicineStockItem,
  medicineStockMovement,
  medicineStorage,
  medicineTemperatureReading,
  type Transaction,
  task,
} from "@harbour/db";
import {
  canMoveOrder,
  checkDisposalWitness,
  countAdjustment,
  DISPOSAL_WITNESS_TASK_TITLE,
  nextCycleStart,
  type OrderStatus,
  orderStatusFromReceipts,
  readingOutOfRange,
  type StorageKind,
  stockChange,
  storageRange,
  TEMPERATURE_TASK_TITLE,
  ukIsoDate,
} from "@harbour/domain";
import { createRoute, z } from "@hono/zod-openapi";
import { and, asc, desc, eq, inArray, isNull, sql } from "drizzle-orm";
import type { Context } from "hono";
import { auditInTx, withAuditedRefusal } from "../http/audit";
import {
  type AppEnv,
  requireAnyPermission,
  requirePermission,
  type TenantAccess,
  withTenant,
} from "../http/context";
import { HttpProblem, problems } from "../http/problem";
import { PharmacyUnavailable, submitToPharmacy } from "../integrations/pharmacy";
import { publish } from "../outbox";
import {
  lockedBalance,
  type StockItemRow,
  stockRates,
  writeMovement,
} from "../services/medicine-stock";
import { personEntries } from "../services/medicines";
import { loadPerson } from "../services/people";
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
 * Medicines stock, ordering, disposal and storage temperatures (medicines.md section 15;
 * MEDS-008; slice 42; ADR-0103). Stock per person and product; a controlled drug's stock is its
 * register's, shown here and never moved. Person routes follow the person's scope and location
 * routes the location's (the database enforces both, migration 0138). Audit events carry ids,
 * movements and counts, never a product or a figure. Nothing here says whether a medicine can
 * still be used after a temperature out of range: the task says to ask the pharmacist.
 */

const tags = ["medicines"];
const STOCK = "medicines.stock.manage" as const;
const ADMINISTER = "medicines.emar.administer" as const;
const READERS = ["medicines.record.manage", ADMINISTER, STOCK] as const;
/** Who records a temperature reading. */
const RECORDERS = [STOCK, ADMINISTER] as const;
export const TEMPERATURE_TASK = "medicines.temperature.out_of_range";
export const DISPOSAL_WITNESS_TASK = "medicines.disposal.witness";

type ItemRow = StockItemRow;
type OrderRow = typeof medicineOrder.$inferSelect;
type DisposalRow = typeof medicineDisposal.$inferSelect;
type ReadingRow = typeof medicineTemperatureReading.$inferSelect;

const audit = (
  c: Context<AppEnv>,
  tx: Transaction,
  access: TenantAccess,
  input: Parameters<typeof auditInTx>[2],
) => auditInTx(tx, access, { ...input, requestId: c.get("requestId") });

/** The database's own words for a refusal (a RAISE): never a failed query's message. */
function raisedMessage(error: unknown): string | undefined {
  const e = error as { message?: string; cause?: { message?: string } };
  return e.cause?.message ?? e.message;
}

const RAISED: Readonly<Record<string, HttpProblem>> = {
  medicine_stock_item_controlled_drug: new HttpProblem(
    422,
    "controlled_drug_register",
    "A controlled drug's stock is kept in its register, not here.",
  ),
  medicine_disposal_witness_required: new HttpProblem(
    422,
    "witness_required",
    "Your organisation's policy needs a witness for every disposal.",
  ),
  medicine_disposal_witness_cannot: new HttpProblem(
    422,
    "witness_cannot_confirm",
    "Name a witness who manages medicines stock at this home.",
  ),
  medicine_disposal_witness: new HttpProblem(
    403,
    "not_the_witness",
    "Only the member named as the witness can confirm it, once.",
  ),
  medicine_order_step: new HttpProblem(409, "order_step", "The order cannot move to that step."),
  medicine_order_line_entry: new HttpProblem(
    422,
    "order_line_entry",
    "Each line must be from a person's own medicine at this home, and never a controlled drug.",
  ),
  medicine_stock_movement_order_line: new HttpProblem(
    422,
    "order_line",
    "That order line is not for this medicine, or its order is not open for receipts.",
  ),
};

/** Runs a change; the database's refusals are said plainly and audited as denied. */
async function change<T>(
  c: Context<AppEnv>,
  access: TenantAccess,
  action: string,
  resourceType: string,
  id: string,
  fn: (tx: Transaction) => Promise<T>,
): Promise<T> {
  try {
    return await withAuditedRefusal(c, access, () => withTenant(c, fn));
  } catch (error) {
    const code = dbCode(error);
    if (!["42501", "23505", "23503", "23514"].includes(code ?? "")) throw error;
    await withTenant(c, (tx) =>
      audit(c, tx, access, {
        action,
        outcome: "denied",
        resourceType,
        resourceId: id,
        reason: code === "42501" ? "refused_by_database" : `invalid_${code}`,
      }),
    );
    if (code === "42501") throw problems.forbidden();
    if (code === "23505") throw problems.conflict("That is already recorded.");
    if (code === "23503") throw problems.notFound();
    throw RAISED[raisedMessage(error) ?? ""] ?? problems.invalid("That cannot be recorded.");
  }
}

const num = (v: unknown) => Number(v);
const iso = (d: Date | null) => (d ? d.toISOString() : null);

async function itemOut(tx: Transaction, item: ItemRow) {
  const movements = await tx
    .select()
    .from(medicineStockMovement)
    .where(eq(medicineStockMovement.itemId, item.id))
    .orderBy(desc(medicineStockMovement.seq))
    .limit(10);
  return {
    id: item.id,
    medicationId: item.medicationId,
    vmpId: item.vmpId,
    productName: item.productName,
    unitCode: item.unitCode,
    unitName: item.unitName,
    balance: num(movements[0]?.balanceAfter ?? 0),
    movements: movements.map((m) => ({
      id: m.id,
      seq: m.seq,
      movement: m.movement as z.infer<typeof StockMoved>["item"]["movements"][number]["movement"],
      change: num(m.change),
      balanceAfter: num(m.balanceAfter),
      administrationId: m.administrationId,
      orderLineId: m.orderLineId,
      disposalId: m.disposalId,
      recordedBy: m.recordedBy,
      recordedAt: m.recordedAt.toISOString(),
    })),
  };
}

const disposalOut = (d: DisposalRow): z.infer<typeof DisposalOut> => ({
  id: d.id,
  itemId: d.itemId,
  quantity: num(d.quantity),
  reason: d.reason,
  status: d.noWitnessReason ? "no_witness" : d.witnessedAt ? "witnessed" : "awaiting_witness",
  witnessId: d.witnessId,
  witnessedAt: iso(d.witnessedAt),
  recordedBy: d.recordedBy,
  recordedAt: d.recordedAt.toISOString(),
});

async function itemById(tx: Transaction, itemId: string): Promise<ItemRow> {
  const [item] = await tx.select().from(medicineStockItem).where(eq(medicineStockItem.id, itemId));
  if (!item) throw problems.notFound();
  return item;
}

async function orderOut(
  tx: Transaction,
  order: OrderRow,
): Promise<z.infer<typeof MedicineOrderOut>> {
  const lines = await tx
    .select()
    .from(medicineOrderLine)
    .where(and(eq(medicineOrderLine.orderId, order.id), isNull(medicineOrderLine.deletedAt)))
    .orderBy(asc(medicineOrderLine.createdAt));
  const receipts = lines.length
    ? await tx
        .select({ lineId: medicineStockMovement.orderLineId, change: medicineStockMovement.change })
        .from(medicineStockMovement)
        .where(
          inArray(
            medicineStockMovement.orderLineId,
            lines.map((l) => l.id),
          ),
        )
    : [];
  const received = new Map<string, number>();
  for (const r of receipts) {
    if (r.lineId) received.set(r.lineId, (received.get(r.lineId) ?? 0) + num(r.change));
  }
  return {
    id: order.id,
    version: order.version,
    cycleStartsOn: order.cycleStartsOn,
    status: order.status as OrderStatus,
    sentVia: order.sentVia as "manual" | "pharmacy_port" | null,
    pharmacyReference: order.pharmacyReference,
    submittedAt: iso(order.submittedAt),
    lines: lines.map((l) => ({
      id: l.id,
      personId: l.personId,
      medicationId: l.medicationId,
      productName: l.productName,
      quantity: num(l.quantity),
      unitCode: l.unitCode,
      received: received.get(l.id) ?? 0,
    })),
  };
}

const readingOut = (r: ReadingRow) => ({
  id: r.id,
  celsius: r.readingTenths / 10,
  minCelsius: r.minTenths === null ? null : r.minTenths / 10,
  maxCelsius: r.maxTenths === null ? null : r.maxTenths / 10,
  lowCelsius: r.lowTenths === null ? null : r.lowTenths / 10,
  highCelsius: r.highTenths / 10,
  outOfRange: r.outOfRange,
  taskId: r.taskId,
  recordedBy: r.recordedBy,
  recordedAt: r.recordedAt.toISOString(),
});

async function locationOf(tx: Transaction, locationId: string) {
  const [row] = await tx
    .select({ id: location.id, nation: location.nation })
    .from(location)
    .where(eq(location.id, locationId));
  if (!row) throw problems.notFound();
  return row as { id: string; nation: "england" | "wales" | "scotland" | "northern_ireland" };
}

const PersonParam = z.object({ id: z.uuid() });
const ItemParam = z.object({ itemId: z.uuid() });
const IdParam = z.object({ id: z.uuid() });
const ok = <T extends z.ZodType>(schema: T, description: string) => ({
  200: jsonBody(schema, description),
  ...errorResponses,
  ...notFoundResponse,
  ...conflictResponse,
});
const created = <T extends z.ZodType>(schema: T, description: string) => ({
  201: jsonBody(schema, description),
  ...errorResponses,
  ...notFoundResponse,
  ...conflictResponse,
});

/** Rules 2 and 4: a receipt, return or count on an item, with its audit. */
async function moveStock(
  c: Context<AppEnv>,
  kind: "receipt" | "returned" | "count",
  itemId: string,
  body: {
    quantity?: number;
    orderLineId?: string | null;
    counted?: number;
    reason?: string | null;
  },
) {
  const access = await requirePermission(c, STOCK);
  const action =
    kind === "receipt"
      ? "medicines.stock.received"
      : kind === "returned"
        ? "medicines.stock.returned"
        : "medicines.stock.counted";
  return change(c, access, action, "medicine_stock_item", itemId, async (tx) => {
    const item = await itemById(tx, itemId);
    const person = await loadPerson(tx, item.personId);
    let moved = null as Awaited<ReturnType<typeof writeMovement>> | null;
    // Rule 7: a receipt beyond what its line asked for is allowed, and flagged in the audit.
    let overReceipt = false;
    if (kind === "count") {
      const { balance } = await lockedBalance(tx, item.id);
      const adjust = countAdjustment(balance, body.counted ?? Number.NaN);
      if (adjust !== null && Number.isNaN(adjust)) throw problems.invalid("Give the count.");
      if (adjust !== null) {
        if (!body.reason) {
          throw problems.invalid("The count differs from the balance: say why.");
        }
        moved = await writeMovement(tx, {
          item,
          locationId: person.locationId,
          movement: "count_adjustment",
          change: adjust,
          recordedBy: access.tenantUserId,
          reason: body.reason,
        });
      }
    } else {
      const sign = stockChange(kind, body.quantity ?? 0);
      if (!sign.ok) throw problems.invalid("Give a quantity above nought.");
      moved = await writeMovement(tx, {
        item,
        locationId: person.locationId,
        movement: kind,
        change: sign.change,
        recordedBy: access.tenantUserId,
        orderLineId: kind === "receipt" ? (body.orderLineId ?? null) : null,
      });
      if (kind === "receipt" && body.orderLineId) {
        overReceipt = await settleOrder(tx, body.orderLineId);
      }
    }
    await audit(c, tx, access, {
      action,
      resourceType: "medicine_stock_item",
      resourceId: item.id,
      scopeExtra: {
        personId: item.personId,
        movementId: moved?.id ?? null,
        matched: !moved,
        overReceipt,
      },
    });
    return { item: await itemOut(tx, item), disposal: null };
  });
}

/** Rule 7: an order's status follows its receipts; says whether the line is now over-received. */
async function settleOrder(tx: Transaction, orderLineId: string): Promise<boolean> {
  const [line] = await tx
    .select({ orderId: medicineOrderLine.orderId })
    .from(medicineOrderLine)
    .where(eq(medicineOrderLine.id, orderLineId));
  if (!line) return false;
  const [order] = await tx.select().from(medicineOrder).where(eq(medicineOrder.id, line.orderId));
  if (!order) return false;
  const out = await orderOut(tx, order);
  const filled = out.lines.find((l) => l.id === orderLineId);
  const over = Boolean(filled && filled.received > filled.quantity);
  const status = orderStatusFromReceipts(out.lines);
  if (status !== order.status && canMoveOrder(order.status as OrderStatus, status)) {
    await tx.update(medicineOrder).set({ status }).where(eq(medicineOrder.id, order.id));
  }
  return over;
}

export const medicineStockRouter = createRouter()
  .openapi(
    createRoute({
      method: "get",
      path: "/v1/people/{id}/medicine-stock",
      tags,
      summary: "A person's medicines stock",
      description:
        "medicines.record.manage, medicines.emar.administer or medicines.stock.manage, for a person in scope. Each item with its balance and latest movements; each controlled drug from its register (never counted here).",
      security,
      request: { params: PersonParam },
      responses: ok(PersonStock, "Stock"),
    }),
    async (c) => {
      await requireAnyPermission(c, [...READERS]);
      const { id } = c.req.valid("param");
      const out = await withTenant(c, async (tx) => {
        await loadPerson(tx, id);
        const items = await tx
          .select()
          .from(medicineStockItem)
          .where(eq(medicineStockItem.personId, id))
          .orderBy(asc(medicineStockItem.productName));
        const pages = await tx
          .select()
          .from(controlledDrugPage)
          .where(eq(controlledDrugPage.personId, id));
        const controlledDrugs = [];
        for (const page of pages) {
          const [last] = await tx
            .select({ balance: controlledDrugEntry.balanceAfter })
            .from(controlledDrugEntry)
            .where(eq(controlledDrugEntry.pageId, page.id))
            .orderBy(desc(controlledDrugEntry.seq))
            .limit(1);
          controlledDrugs.push({
            pageId: page.id,
            productName: page.productName,
            unitName: page.unitName,
            balance: num(last?.balance ?? 0),
            source: "controlled_drugs_register" as const,
          });
        }
        return { items: await Promise.all(items.map((i) => itemOut(tx, i))), controlledDrugs };
      });
      return c.json(out, 200);
    },
  )
  .openapi(
    createRoute({
      method: "post",
      path: "/v1/people/{id}/medicine-stock",
      tags,
      summary: "Open a stock item from a MAR entry",
      description:
        "medicines.stock.manage. One per person and product, in the entry's dose unit; never a controlled drug (its register keeps its stock). Audited.",
      security,
      request: {
        params: PersonParam,
        body: { content: { "application/json": { schema: OpenStockItem } } },
      },
      responses: created(StockMoved, "Opened"),
    }),
    async (c) => {
      const access = await requirePermission(c, STOCK);
      const { id } = c.req.valid("param");
      const { medicationId } = c.req.valid("json");
      const out = await change(
        c,
        access,
        "medicines.stock.item_opened",
        "person",
        id,
        async (tx) => {
          await loadPerson(tx, id);
          const stored = (await personEntries(tx, id)).find((s) => s.entry.id === medicationId);
          if (!stored) throw problems.notFound();
          const entry = stored.entry;
          const [row] = await tx
            .select({ cd: medication.cdSchedule })
            .from(medication)
            .where(eq(medication.id, medicationId));
          if (row?.cd) throw RAISED.medicine_stock_item_controlled_drug as HttpProblem;
          const unit =
            entry.directions.kind === "when_required"
              ? entry.directions.dose.unit
              : entry.directions.schedule.times[0]?.dose.unit;
          if (!unit) throw problems.invalid("This medicine has no dose unit to count in.");
          const [item] = await tx
            .insert(medicineStockItem)
            .values({
              personId: id,
              medicationId,
              vmpId: entry.product.vmpId,
              productName: entry.product.name,
              unitCode: unit.code,
              unitName: unit.name,
              openedBy: access.tenantUserId,
            })
            .returning();
          if (!item) throw new Error("stock item not opened");
          await audit(c, tx, access, {
            action: "medicines.stock.item_opened",
            resourceType: "medicine_stock_item",
            resourceId: item.id,
            scopeExtra: { personId: id },
          });
          return { item: await itemOut(tx, item), disposal: null };
        },
      );
      return c.json(out, 201);
    },
  )
  .openapi(
    createRoute({
      method: "post",
      path: "/v1/medicine-stock/{itemId}/receipts",
      tags,
      summary: "Record medicines received",
      description:
        "medicines.stock.manage. A positive quantity, naming the order line it fills when there is one (the order's status follows). Audited.",
      security,
      request: {
        params: ItemParam,
        body: { content: { "application/json": { schema: StockQuantity } } },
      },
      responses: created(StockMoved, "Received"),
    }),
    async (c) =>
      c.json(await moveStock(c, "receipt", c.req.valid("param").itemId, c.req.valid("json")), 201),
  )
  .openapi(
    createRoute({
      method: "post",
      path: "/v1/medicine-stock/{itemId}/returns",
      tags,
      summary: "Record medicines returned to the pharmacy",
      description: "medicines.stock.manage. A positive quantity, taken off. Audited.",
      security,
      request: {
        params: ItemParam,
        body: { content: { "application/json": { schema: StockQuantity } } },
      },
      responses: created(StockMoved, "Returned"),
    }),
    async (c) =>
      c.json(await moveStock(c, "returned", c.req.valid("param").itemId, c.req.valid("json")), 201),
  )
  .openapi(
    createRoute({
      method: "post",
      path: "/v1/medicine-stock/{itemId}/counts",
      tags,
      summary: "Record a stock count",
      description:
        "medicines.stock.manage. A count that matches writes nothing but the audit; one that differs writes an adjustment to it, with a reason. Audited.",
      security,
      request: {
        params: ItemParam,
        body: { content: { "application/json": { schema: StockCount } } },
      },
      responses: ok(StockMoved, "Counted"),
    }),
    async (c) =>
      c.json(await moveStock(c, "count", c.req.valid("param").itemId, c.req.valid("json")), 200),
  )
  .openapi(
    createRoute({
      method: "post",
      path: "/v1/medicine-stock/{itemId}/disposals",
      tags,
      summary: "Record a disposal",
      description:
        "medicines.stock.manage. Witnessed by a second member who confirms it themselves (a task asks them), or, where the organisation's policy allows (medicines.disposal.witness_required is 0), with why no one could. The stock leaves now. Never a controlled drug's destruction (its register). Audited.",
      security,
      request: {
        params: ItemParam,
        body: { content: { "application/json": { schema: RecordDisposal } } },
      },
      responses: created(StockMoved, "Disposed of"),
    }),
    async (c) => {
      const access = await requirePermission(c, STOCK);
      const { itemId } = c.req.valid("param");
      const body = c.req.valid("json");
      const out = await change(
        c,
        access,
        "medicines.stock.disposed",
        "medicine_stock_item",
        itemId,
        async (tx) => {
          const item = await itemById(tx, itemId);
          const person = await loadPerson(tx, item.personId);
          const rates = await stockRates(tx, access.tenantId, person.nation, ukIsoDate(new Date()));
          const problem = checkDisposalWitness({
            witnessRequired: rates.disposalWitnessRequired !== 0,
            recorderId: access.tenantUserId,
            witnessId: body.witnessId,
            noWitnessReason: body.noWitnessReason,
          });
          if (problem) {
            throw new HttpProblem(
              422,
              problem,
              problem === "witness_required"
                ? "Your organisation's policy needs a witness for every disposal."
                : problem === "witness_is_recorder"
                  ? "The witness is someone other than you."
                  : problem === "witness_and_reason"
                    ? "Name a witness, or say why no one could witness it, not both."
                    : "Say why no one could witness it, in a sentence.",
            );
          }
          // The witness must be able to confirm it: an active member holding medicines.stock.manage
          // (security review M4; clinical review 6), checked again by the database.
          if (body.witnessId) {
            const held = await tx.execute<{ ok: boolean }>(
              sql`SELECT app.member_holds_role_permission(${body.witnessId}::uuid, ${STOCK}) AS ok`,
            );
            if (held.rows[0]?.ok !== true) {
              throw new HttpProblem(
                422,
                "witness_cannot_confirm",
                "Name a witness who manages medicines stock at this home.",
              );
            }
          }
          const [disposal] = await tx
            .insert(medicineDisposal)
            .values({
              itemId: item.id,
              personId: item.personId,
              locationId: person.locationId,
              quantity: body.quantity,
              reason: body.reason,
              note: body.note,
              recordedBy: access.tenantUserId,
              witnessId: body.witnessId,
              noWitnessReason: body.noWitnessReason,
            })
            .returning();
          if (!disposal) throw new Error("disposal not recorded");
          const sign = stockChange("disposal", body.quantity);
          if (!sign.ok) throw problems.invalid("Give a quantity above nought.");
          await writeMovement(tx, {
            item,
            locationId: person.locationId,
            movement: "disposal",
            change: sign.change,
            recordedBy: access.tenantUserId,
            disposalId: disposal.id,
          });
          if (disposal.witnessId) {
            await tx.insert(task).values({
              kind: DISPOSAL_WITNESS_TASK,
              title: DISPOSAL_WITNESS_TASK_TITLE,
              requiredPermission: STOCK,
              personId: item.personId,
              locationId: person.locationId,
              sourceType: "medicine_disposal",
              sourceId: disposal.id,
              assigneeTenantUserId: disposal.witnessId,
              dueAt: new Date(),
              priority: "routine",
              details: { reason: "disposal_witness" },
            });
          }
          await audit(c, tx, access, {
            action: "medicines.stock.disposed",
            resourceType: "medicine_disposal",
            resourceId: disposal.id,
            scopeExtra: {
              personId: item.personId,
              itemId: item.id,
              witnessed: Boolean(disposal.witnessId),
            },
          });
          return { item: await itemOut(tx, item), disposal: disposalOut(disposal) };
        },
      );
      return c.json(out, 201);
    },
  )
  .openapi(
    createRoute({
      method: "post",
      path: "/v1/medicine-disposals/{id}/witness",
      tags,
      summary: "Confirm a disposal as its witness",
      description:
        "medicines.stock.manage, by the member named as the witness, from their own session, once. Only this ends the witness task. Audited.",
      security,
      request: { params: IdParam },
      responses: ok(DisposalOut, "Witnessed"),
    }),
    async (c) => {
      const access = await requirePermission(c, STOCK);
      const { id } = c.req.valid("param");
      const out = await change(
        c,
        access,
        "medicines.stock.disposal_witnessed",
        "medicine_disposal",
        id,
        async (tx) => {
          const [found] = await tx
            .select()
            .from(medicineDisposal)
            .where(eq(medicineDisposal.id, id));
          if (!found) throw problems.notFound();
          if (found.witnessId !== access.tenantUserId || found.witnessedAt) {
            throw RAISED.medicine_disposal_witness as HttpProblem;
          }
          const [row] = await tx
            .update(medicineDisposal)
            .set({ witnessedAt: new Date() })
            .where(eq(medicineDisposal.id, id))
            .returning();
          if (!row) throw new Error("disposal not witnessed");
          await tx
            .update(task)
            .set({ status: "done", statusReason: "Witnessed" })
            .where(
              and(
                eq(task.kind, DISPOSAL_WITNESS_TASK),
                eq(task.sourceType, "medicine_disposal"),
                eq(task.sourceId, id),
                inArray(task.status, ["open", "in_progress"]),
              ),
            );
          await audit(c, tx, access, {
            action: "medicines.stock.disposal_witnessed",
            resourceType: "medicine_disposal",
            resourceId: id,
            scopeExtra: { personId: row.personId },
          });
          return disposalOut(row);
        },
      );
      return c.json(out, 200);
    },
  )
  .openapi(
    createRoute({
      method: "get",
      path: "/v1/locations/{id}/medicine-cycle",
      tags,
      summary: "A location's 28-day medicines cycle",
      description:
        "medicines.record.manage, medicines.emar.administer or medicines.stock.manage, at a location in scope. The cycle's length is medicines.ordering_cycle_days from the rate table.",
      security,
      request: { params: IdParam },
      responses: ok(OrderCycleOut, "The cycle"),
    }),
    async (c) => {
      const access = await requireAnyPermission(c, [...READERS]);
      const { id } = c.req.valid("param");
      return c.json(await withTenant(c, (tx) => cycleOut(tx, access, id)), 200);
    },
  )
  .openapi(
    createRoute({
      method: "put",
      path: "/v1/locations/{id}/medicine-cycle",
      tags,
      summary: "Set a location's 28-day medicines cycle",
      description:
        "medicines.stock.manage, by the first day of one cycle, against version (null to set it the first time). Audited.",
      security,
      request: {
        params: IdParam,
        body: { content: { "application/json": { schema: PutOrderCycle } } },
      },
      responses: ok(OrderCycleOut, "Set"),
    }),
    async (c) => {
      const access = await requirePermission(c, STOCK);
      const { id } = c.req.valid("param");
      const body = c.req.valid("json");
      const out = await change(c, access, "medicines.cycle.set", "location", id, async (tx) => {
        await locationOf(tx, id);
        const [current] = await tx
          .select()
          .from(medicineOrderCycle)
          .where(eq(medicineOrderCycle.locationId, id));
        if (current) {
          const [row] = await tx
            .update(medicineOrderCycle)
            .set({ anchorOn: body.anchorOn })
            .where(
              and(
                eq(medicineOrderCycle.id, current.id),
                eq(medicineOrderCycle.version, body.version ?? -1),
              ),
            )
            .returning();
          if (!row) throw problems.conflict();
        } else {
          if (body.version !== null) throw problems.conflict();
          await tx.insert(medicineOrderCycle).values({ locationId: id, anchorOn: body.anchorOn });
        }
        await audit(c, tx, access, {
          action: "medicines.cycle.set",
          resourceType: "location",
          resourceId: id,
        });
        return cycleOut(tx, access, id);
      });
      return c.json(out, 200);
    },
  )
  .openapi(
    createRoute({
      method: "get",
      path: "/v1/locations/{id}/medicine-orders",
      tags,
      summary: "A location's medicines orders",
      description:
        "medicines.record.manage, medicines.emar.administer or medicines.stock.manage, at a location in scope. Newest cycle first; lines for people in scope.",
      security,
      request: { params: IdParam },
      responses: ok(MedicineOrderList, "Orders"),
    }),
    async (c) => {
      await requireAnyPermission(c, [...READERS]);
      const { id } = c.req.valid("param");
      const items = await withTenant(c, async (tx) => {
        await locationOf(tx, id);
        const orders = await tx
          .select()
          .from(medicineOrder)
          .where(eq(medicineOrder.locationId, id))
          .orderBy(desc(medicineOrder.cycleStartsOn));
        return Promise.all(orders.map((o) => orderOut(tx, o)));
      });
      return c.json({ items }, 200);
    },
  )
  .openapi(
    createRoute({
      method: "post",
      path: "/v1/locations/{id}/medicine-orders",
      tags,
      summary: "Start a medicines order for a cycle",
      description:
        "medicines.stock.manage. A draft with its lines, each from a person's own MAR entry at this home, never a controlled drug; one order per cycle at a time. Audited with the count of lines.",
      security,
      request: {
        params: IdParam,
        body: { content: { "application/json": { schema: NewMedicineOrder } } },
      },
      responses: created(MedicineOrderOut, "Started"),
    }),
    async (c) => {
      const access = await requirePermission(c, STOCK);
      const { id } = c.req.valid("param");
      const body = c.req.valid("json");
      const out = await change(c, access, "medicines.order.created", "location", id, async (tx) => {
        await locationOf(tx, id);
        const [order] = await tx
          .insert(medicineOrder)
          .values({ locationId: id, cycleStartsOn: body.cycleStartsOn })
          .returning();
        if (!order) throw new Error("order not started");
        const meds = await tx
          .select()
          .from(medication)
          .where(
            inArray(
              medication.id,
              body.lines.map((l) => l.medicationId),
            ),
          );
        const byId = new Map(meds.map((m) => [m.id, m]));
        for (const line of body.lines) {
          const m = byId.get(line.medicationId);
          if (!m || m.personId !== line.personId) throw problems.notFound();
          const unit = await unitOf(tx, m.personId, m.id);
          await tx.insert(medicineOrderLine).values({
            orderId: order.id,
            personId: line.personId,
            medicationId: m.id,
            vmpId: m.vmpId,
            productName: m.productName,
            quantity: line.quantity,
            unitCode: unit,
          });
        }
        await audit(c, tx, access, {
          action: "medicines.order.created",
          resourceType: "medicine_order",
          resourceId: order.id,
          scopeExtra: { locationId: id, lines: body.lines.length },
        });
        return orderOut(tx, order);
      });
      return c.json(out, 201);
    },
  )
  .openapi(
    createRoute({
      method: "get",
      path: "/v1/medicine-orders/{id}",
      tags,
      summary: "A medicines order",
      description:
        "medicines.record.manage, medicines.emar.administer or medicines.stock.manage, at a location in scope.",
      security,
      request: { params: IdParam },
      responses: ok(MedicineOrderOut, "The order"),
    }),
    async (c) => {
      await requireAnyPermission(c, [...READERS]);
      const { id } = c.req.valid("param");
      const out = await withTenant(c, async (tx) => {
        const [order] = await tx.select().from(medicineOrder).where(eq(medicineOrder.id, id));
        if (!order) throw problems.notFound();
        return orderOut(tx, order);
      });
      return c.json(out, 200);
    },
  )
  .openapi(
    createRoute({
      method: "post",
      path: "/v1/medicine-orders/{id}/submit",
      tags,
      summary: "Submit a medicines order",
      description:
        "medicines.stock.manage, against version. By hand, or through the pharmacy port (a mock until H-1321; 409 pharmacy_not_connected while it is off; 502 pharmacy_unavailable when it refuses). The pharmacy gets each line's product, quantity and unit with an opaque person id, never a name. Audited.",
      security,
      request: {
        params: IdParam,
        body: { content: { "application/json": { schema: SubmitMedicineOrder } } },
      },
      responses: ok(MedicineOrderOut, "Submitted"),
    }),
    async (c) => {
      const access = await requirePermission(c, STOCK);
      const { id } = c.req.valid("param");
      const { version, via } = c.req.valid("json");
      const pharmacy = c.get("services").pharmacy;
      if (via === "pharmacy_port" && !pharmacy) {
        throw new HttpProblem(
          409,
          "pharmacy_not_connected",
          "Ordering through the pharmacy is not connected. Submit the order by hand.",
        );
      }
      // A submitter sees the whole order: an order is the location's, so a scope narrower than
      // the location could send it without the lines they cannot see (security review M3).
      if (!["tenant", "locations"].includes(access.context.scope)) {
        throw new HttpProblem(
          403,
          "order_needs_location_scope",
          "Submitting an order needs access to everyone at the home.",
        );
      }
      // One submission at a time: the order stays locked while the pharmacy is called, so two at
      // once never send it twice (security review M2); the port also receives the order's id to
      // treat as idempotent (H-1321).
      const out = await change(
        c,
        access,
        "medicines.order.submitted",
        "medicine_order",
        id,
        async (tx) => {
          const [order] = await tx
            .select()
            .from(medicineOrder)
            .where(eq(medicineOrder.id, id))
            .for("update");
          if (!order) throw problems.notFound();
          if (order.status !== "draft" || order.version !== version) throw problems.conflict();
          let reference: string | null = null;
          if (via === "pharmacy_port" && pharmacy) {
            const lines = await tx
              .select()
              .from(medicineOrderLine)
              .where(and(eq(medicineOrderLine.orderId, id), isNull(medicineOrderLine.deletedAt)));
            try {
              reference = await submitToPharmacy(pharmacy, {
                orderId: order.id,
                cycleStartsOn: order.cycleStartsOn,
                lines: lines.map((l) => ({
                  lineId: l.id,
                  personRef: pharmacyPersonRef(access.tenantId, l.personId),
                  vmpId: l.vmpId,
                  quantity: num(l.quantity),
                  unitCode: l.unitCode,
                })),
              });
            } catch (error) {
              if (!(error instanceof PharmacyUnavailable)) throw error;
              throw new HttpProblem(
                502,
                "pharmacy_unavailable",
                "The pharmacy did not take the order. Try again, or submit it by hand.",
              );
            }
          }
          const [row] = await tx
            .update(medicineOrder)
            .set({ status: "submitted", sentVia: via, pharmacyReference: reference })
            .where(and(eq(medicineOrder.id, id), eq(medicineOrder.version, version)))
            .returning();
          if (!row) throw problems.conflict();
          await audit(c, tx, access, {
            action: "medicines.order.submitted",
            resourceType: "medicine_order",
            resourceId: id,
            scopeExtra: { via },
          });
          return orderOut(tx, row);
        },
      );
      return c.json(out, 200);
    },
  )
  .openapi(
    createRoute({
      method: "post",
      path: "/v1/medicine-orders/{id}/cancel",
      tags,
      summary: "Cancel a medicines order",
      description: "medicines.stock.manage, against version, while not yet received. Audited.",
      security,
      request: {
        params: IdParam,
        body: { content: { "application/json": { schema: MedicineOrderVersion } } },
      },
      responses: ok(MedicineOrderOut, "Cancelled"),
    }),
    async (c) => {
      const access = await requirePermission(c, STOCK);
      const { id } = c.req.valid("param");
      const { version } = c.req.valid("json");
      const out = await change(
        c,
        access,
        "medicines.order.cancelled",
        "medicine_order",
        id,
        async (tx) => {
          const [row] = await tx
            .update(medicineOrder)
            .set({ status: "cancelled" })
            .where(and(eq(medicineOrder.id, id), eq(medicineOrder.version, version)))
            .returning();
          if (!row) throw problems.conflict();
          await audit(c, tx, access, {
            action: "medicines.order.cancelled",
            resourceType: "medicine_order",
            resourceId: id,
          });
          return orderOut(tx, row);
        },
      );
      return c.json(out, 200);
    },
  )
  .openapi(
    createRoute({
      method: "get",
      path: "/v1/locations/{id}/medicine-storage",
      tags,
      summary: "A location's medicines fridges and rooms",
      description:
        "medicines.record.manage, medicines.emar.administer or medicines.stock.manage, at a location in scope.",
      security,
      request: { params: IdParam },
      responses: ok(MedicineStorageList, "Storage"),
    }),
    async (c) => {
      await requireAnyPermission(c, [...READERS]);
      const { id } = c.req.valid("param");
      const items = await withTenant(c, async (tx) => {
        await locationOf(tx, id);
        return (
          await tx
            .select()
            .from(medicineStorage)
            .where(and(eq(medicineStorage.locationId, id), isNull(medicineStorage.deletedAt)))
            .orderBy(asc(medicineStorage.name))
        ).map((s) => ({ id: s.id, version: s.version, kind: s.kind as StorageKind, name: s.name }));
      });
      return c.json({ items }, 200);
    },
  )
  .openapi(
    createRoute({
      method: "post",
      path: "/v1/locations/{id}/medicine-storage",
      tags,
      summary: "Add a medicines fridge or room",
      description: "medicines.stock.manage. Audited.",
      security,
      request: {
        params: IdParam,
        body: { content: { "application/json": { schema: NewMedicineStorage } } },
      },
      responses: created(MedicineStorageOut, "Added"),
    }),
    async (c) => {
      const access = await requirePermission(c, STOCK);
      const { id } = c.req.valid("param");
      const body = c.req.valid("json");
      const out = await change(c, access, "medicines.storage.added", "location", id, async (tx) => {
        await locationOf(tx, id);
        const [row] = await tx
          .insert(medicineStorage)
          .values({ locationId: id, kind: body.kind, name: body.name })
          .returning();
        if (!row) throw new Error("storage not added");
        await audit(c, tx, access, {
          action: "medicines.storage.added",
          resourceType: "medicine_storage",
          resourceId: row.id,
          scopeExtra: { locationId: id, kind: row.kind },
        });
        return { id: row.id, version: row.version, kind: row.kind as StorageKind, name: row.name };
      });
      return c.json(out, 201);
    },
  )
  .openapi(
    createRoute({
      method: "get",
      path: "/v1/medicine-storage/{id}/readings",
      tags,
      summary: "A fridge's or room's temperature readings",
      description:
        "medicines.record.manage, medicines.emar.administer or medicines.stock.manage, at a location in scope. Newest first, the last 100.",
      security,
      request: { params: IdParam },
      responses: ok(TemperatureReadingList, "Readings"),
    }),
    async (c) => {
      await requireAnyPermission(c, [...READERS]);
      const { id } = c.req.valid("param");
      const items = await withTenant(c, async (tx) =>
        (
          await tx
            .select()
            .from(medicineTemperatureReading)
            .where(eq(medicineTemperatureReading.storageId, id))
            .orderBy(desc(medicineTemperatureReading.recordedAt))
            .limit(100)
        ).map(readingOut),
      );
      return c.json({ items }, 200);
    },
  )
  .openapi(
    createRoute({
      method: "post",
      path: "/v1/medicine-storage/{id}/readings",
      tags,
      summary: "Record a temperature reading",
      description:
        "medicines.stock.manage or medicines.emar.administer. The range comes from the rate table for the storage's kind; the database decides whether the reading is out of range. At most one decimal place. One out of range raises an urgent task for the person in charge, due at once and escalated by the task engine after task.overdue_escalation_minutes; further readings out of range join the open task; its words never say whether the medicines can be used. Audited.",
      security,
      request: {
        params: IdParam,
        body: { content: { "application/json": { schema: NewTemperatureReading } } },
      },
      responses: created(TemperatureReadingRecorded, "Recorded"),
    }),
    async (c) => {
      const access = await requireAnyPermission(c, [...RECORDERS]);
      const { id } = c.req.valid("param");
      const body = c.req.valid("json");
      const tenths = (v: number | null) => (v === null ? null : Math.round(v * 10));
      const out = await change(
        c,
        access,
        "medicines.temperature.recorded",
        "medicine_storage",
        id,
        async (tx) => {
          const [storage] = await tx
            .select()
            .from(medicineStorage)
            .where(and(eq(medicineStorage.id, id), isNull(medicineStorage.deletedAt)));
          if (!storage) throw problems.notFound();
          const place = await locationOf(tx, storage.locationId);
          const now = new Date();
          const rates = await stockRates(tx, access.tenantId, place.nation, ukIsoDate(now));
          const reading = {
            tenths: Math.round(body.celsius * 10),
            minTenths: tenths(body.minCelsius),
            maxTenths: tenths(body.maxCelsius),
          };
          const outOfRange = readingOutOfRange(
            reading,
            storageRange(storage.kind as StorageKind, rates),
          );
          let taskId: string | null = null;
          // One open task per fridge or room: a further reading out of range joins it (HZ-008).
          const [open] = outOfRange
            ? await tx
                .select({ id: task.id })
                .from(task)
                .where(
                  and(
                    eq(task.kind, TEMPERATURE_TASK),
                    eq(task.sourceType, "medicine_storage"),
                    eq(task.sourceId, storage.id),
                    inArray(task.status, ["open", "in_progress"]),
                  ),
                )
                .limit(1)
            : [];
          if (open) taskId = open.id;
          if (outOfRange && !open) {
            const [raised] = await tx
              .insert(task)
              .values({
                kind: TEMPERATURE_TASK,
                title: TEMPERATURE_TASK_TITLE,
                requiredPermission: STOCK,
                locationId: storage.locationId,
                sourceType: "medicine_storage",
                sourceId: storage.id,
                assigneeRoleKey: "clinical_lead",
                // Due now: the task engine escalates it after task.overdue_escalation_minutes.
                dueAt: now,
                priority: "urgent",
                details: { reason: "out_of_range", kind: storage.kind },
              })
              .returning({ id: task.id });
            taskId = raised?.id ?? null;
          }
          const [row] = await tx
            .insert(medicineTemperatureReading)
            .values({
              storageId: storage.id,
              locationId: storage.locationId,
              readingTenths: reading.tenths,
              minTenths: reading.minTenths,
              maxTenths: reading.maxTenths,
              taskId,
              recordedBy: access.tenantUserId,
            })
            .returning();
          if (!row) throw new Error("reading not recorded");
          if (row.outOfRange) {
            await publish(tx, {
              context: "medicines",
              aggregateType: "medicine_storage",
              aggregateId: storage.id,
              type: "medicines.temperature.out_of_range",
              payload: { readingId: row.id, locationId: storage.locationId },
            });
          }
          await audit(c, tx, access, {
            action: "medicines.temperature.recorded",
            resourceType: "medicine_temperature_reading",
            resourceId: row.id,
            scopeExtra: { storageId: storage.id, outOfRange: row.outOfRange },
          });
          return {
            reading: readingOut(row),
            message: row.outOfRange
              ? "Out of range. The person in charge has been asked to check the storage and ask the pharmacist."
              : "Recorded.",
          };
        },
      );
      return c.json(out, 201);
    },
  );

async function cycleOut(tx: Transaction, access: TenantAccess, locationId: string) {
  const place = await locationOf(tx, locationId);
  const today = ukIsoDate(new Date());
  const rates = await stockRates(tx, access.tenantId, place.nation, today);
  const [cycle] = await tx
    .select()
    .from(medicineOrderCycle)
    .where(eq(medicineOrderCycle.locationId, locationId));
  return {
    anchorOn: cycle?.anchorOn ?? null,
    version: cycle?.version ?? null,
    cycleDays: rates.orderingCycleDays,
    nextCycleStartsOn: cycle
      ? nextCycleStart(cycle.anchorOn, today, rates.orderingCycleDays)
      : null,
  };
}

/**
 * The pharmacy's id for a person: a pseudonym stable within the organisation, never Harbour's own
 * id or a name (security review L5; H-1321).
 */
function pharmacyPersonRef(tenantId: string, personId: string): string {
  return createHash("sha256")
    .update(`pharmacy:${tenantId}:${personId}`, "utf8")
    .digest("hex")
    .slice(0, 32);
}

/** The dose unit a person's entry is counted in. */
async function unitOf(tx: Transaction, personId: string, medicationId: string): Promise<string> {
  const stored = (await personEntries(tx, personId)).find((s) => s.entry.id === medicationId);
  if (!stored) throw problems.notFound();
  const e = stored.entry;
  const unit =
    e.directions.kind === "when_required"
      ? e.directions.dose.unit
      : e.directions.schedule.times[0]?.dose.unit;
  if (!unit) throw problems.invalid("A medicine on the order has no dose unit.");
  return unit.code;
}
