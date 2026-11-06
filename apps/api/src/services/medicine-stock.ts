import {
  location,
  medicationAdministration,
  medicineOrder,
  medicineOrderCycle,
  medicineStockItem,
  medicineStockMovement,
  type Transaction,
  task,
} from "@harbour/db";
import {
  balanceAfter,
  correctionStockChange,
  crossedBelowZero,
  doseStockMove,
  ORDER_DUE_TASK_TITLE,
  orderDueFor,
  type RateNation,
  resolveStockRates,
  STOCK_COUNT_TASK_TITLE,
  STOCK_RATE_KEYS,
  type StockMovement,
  type StockRates,
  ukIsoDate,
} from "@harbour/domain";
import { and, desc, eq, inArray, isNull, ne, sql } from "drizzle-orm";
import { publish } from "../outbox";
import { rateRows } from "./rates";

/**
 * Medicines stock (medicines.md section 15; MEDS-008; slice 42; ADR-0103): movements in sequence
 * with their balance, slice 22's hook for doses and their corrections, and the stock tasks. A
 * controlled drug never reaches here: its stock is the register's (section 14).
 */

export type StockItemRow = typeof medicineStockItem.$inferSelect;
export type StockMovementRow = typeof medicineStockMovement.$inferSelect;
type AdministrationRow = typeof medicationAdministration.$inferSelect;

export const STOCK_COUNT_TASK = "medicines.stock.count_needed";
export const OUT_OF_STOCK_TASK = "medicines.stock.out_of_stock";
export const OUT_OF_STOCK_TASK_TITLE = "Medicine not available: check the stock and order";

/** Every stock figure for a location's nation on a date, as numbers (the table stores text). */
export async function stockRates(
  tx: Transaction,
  tenantId: string,
  nation: Exclude<RateNation, "uk" | "all">,
  on: string,
): Promise<StockRates> {
  const rows = await rateRows(tx, Object.values(STOCK_RATE_KEYS));
  const resolved = resolveStockRates(rows, nation, on, tenantId);
  return Object.fromEntries(
    Object.entries(resolved).map(([k, v]) => [k, Number(v)]),
  ) as unknown as StockRates;
}

/** The item's balance: its last movement's, or 0. Takes the item's lock first. */
export async function lockedBalance(
  tx: Transaction,
  itemId: string,
): Promise<{ seq: number; balance: number }> {
  await tx.execute(
    sql`SELECT pg_advisory_xact_lock(hashtextextended(${`medicine_stock:${itemId}`}, 0))`,
  );
  const [last] = await tx
    .select({ seq: medicineStockMovement.seq, balance: medicineStockMovement.balanceAfter })
    .from(medicineStockMovement)
    .where(eq(medicineStockMovement.itemId, itemId))
    .orderBy(desc(medicineStockMovement.seq))
    .limit(1);
  return { seq: last?.seq ?? 0, balance: Number(last?.balance ?? 0) };
}

/**
 * Writes one movement with the balance after it (rules 2 to 5). A balance that crosses below zero
 * raises one routine count task for the person in charge (rule 3).
 */
export async function writeMovement(
  tx: Transaction,
  input: {
    readonly item: StockItemRow;
    readonly locationId: string | null;
    readonly movement: StockMovement;
    readonly change: number;
    readonly recordedBy: string;
    readonly administrationId?: string | null;
    readonly orderLineId?: string | null;
    readonly disposalId?: string | null;
    readonly reason?: string | null;
  },
): Promise<StockMovementRow> {
  const { seq, balance } = await lockedBalance(tx, input.item.id);
  const after = balanceAfter(balance, input.change);
  const [row] = await tx
    .insert(medicineStockMovement)
    .values({
      itemId: input.item.id,
      personId: input.item.personId,
      seq: seq + 1,
      movement: input.movement,
      change: input.change,
      balanceAfter: after,
      administrationId: input.administrationId ?? null,
      orderLineId: input.orderLineId ?? null,
      disposalId: input.disposalId ?? null,
      reason: input.reason ?? null,
      recordedBy: input.recordedBy,
    })
    .returning();
  if (!row) throw new Error("stock movement not recorded");
  if (crossedBelowZero(balance, after)) {
    await tx.insert(task).values({
      kind: STOCK_COUNT_TASK,
      title: STOCK_COUNT_TASK_TITLE,
      requiredPermission: "medicines.stock.manage",
      personId: input.item.personId,
      locationId: input.locationId,
      sourceType: "medicine_stock_item",
      sourceId: input.item.id,
      assigneeRoleKey: "clinical_lead",
      dueAt: new Date(),
      priority: "routine",
      details: { reason: "below_zero" },
    });
    await publish(tx, {
      context: "medicines",
      aggregateType: "medicine_stock_item",
      aggregateId: input.item.id,
      type: "medicines.stock.below_zero",
      payload: { personId: input.item.personId },
    });
  }
  return row;
}

/** The person's item for a product, if one is open. */
export async function itemFor(
  tx: Transaction,
  personId: string,
  vmpId: string,
): Promise<StockItemRow | null> {
  const [row] = await tx
    .select()
    .from(medicineStockItem)
    .where(and(eq(medicineStockItem.personId, personId), eq(medicineStockItem.vmpId, vmpId)));
  return row ?? null;
}

const amountOf = (r: AdministrationRow) =>
  r.quantity !== null && r.unitCode !== null
    ? { quantity: Number(r.quantity), unitCode: r.unitCode }
    : null;

/**
 * Rule 3: "not available: out of stock" raises one urgent task per person and product (a further
 * dose not available joins the open one, HZ-008). Raised outside the stock hook's savepoint, so a
 * failure moving stock never takes it away (slice 42 clinical re-review 1).
 */
export async function raiseOutOfStockTask(
  tx: Transaction,
  input: {
    readonly record: AdministrationRow;
    readonly vmpId: string;
    readonly locationId: string | null;
  },
): Promise<void> {
  const reasonCode = (input.record.reasonCode ?? null) as string | null;
  if (input.record.outcome !== "not_available" || reasonCode !== "out_of_stock") return;
  const [open] = await tx
    .select({ id: task.id })
    .from(task)
    .where(
      and(
        eq(task.kind, OUT_OF_STOCK_TASK),
        eq(task.personId, input.record.personId),
        inArray(task.status, ["open", "in_progress"]),
        sql`${task.details}->>'vmpId' = ${input.vmpId}`,
      ),
    )
    .limit(1);
  if (open) return;
  await tx.insert(task).values({
    kind: OUT_OF_STOCK_TASK,
    title: OUT_OF_STOCK_TASK_TITLE,
    requiredPermission: "medicines.stock.manage",
    personId: input.record.personId,
    locationId: input.locationId,
    sourceType: "medication_administration",
    sourceId: input.record.id,
    assigneeRoleKey: "clinical_lead",
    dueAt: new Date(),
    priority: "urgent",
    details: { reason: "out_of_stock", vmpId: input.vmpId },
  });
}

/**
 * Slice 22's hook (rule 3): a dose recorded as given moves the person's stock of its product, in
 * the same transaction. A controlled drug, no item or another unit moves nothing; nothing here
 * ever refuses the dose.
 */
export async function stockOnDose(
  tx: Transaction,
  input: {
    readonly record: AdministrationRow;
    readonly vmpId: string;
    readonly isControlledDrug: boolean;
    readonly locationId: string | null;
    readonly recordedBy: string;
  },
): Promise<void> {
  if (input.isControlledDrug) return;
  const item = await itemFor(tx, input.record.personId, input.vmpId);
  const change = doseStockMove({
    outcome: input.record.outcome,
    isControlledDrug: input.isControlledDrug,
    item,
    amount: amountOf(input.record),
  });
  if (!item || change === null) return;
  await writeMovement(tx, {
    item,
    locationId: input.locationId,
    movement: "administration",
    change,
    recordedBy: input.recordedBy,
    administrationId: input.record.id,
  });
}

/**
 * Rule 3: a correction writes the difference between what the corrected record says left stock
 * and what has already left for its chain.
 */
export async function stockOnCorrection(
  tx: Transaction,
  input: {
    readonly record: AdministrationRow;
    /** Every earlier record of the dose, the one corrected first. */
    readonly chainIds: readonly string[];
    readonly vmpId: string;
    readonly isControlledDrug: boolean;
    readonly locationId: string | null;
    readonly recordedBy: string;
  },
): Promise<void> {
  if (input.isControlledDrug) return;
  const item = await itemFor(tx, input.record.personId, input.vmpId);
  if (!item) return;
  const moved = input.chainIds.length
    ? await tx
        .select({ change: medicineStockMovement.change })
        .from(medicineStockMovement)
        .where(
          and(
            eq(medicineStockMovement.itemId, item.id),
            inArray(medicineStockMovement.administrationId, [...input.chainIds]),
          ),
        )
    : [];
  // A dose first recorded before the item was opened was never counted in it: its corrections
  // move nothing either (slice 42 clinical review 2). One recorded after moves the difference,
  // a dose first refused and then corrected to given included (clinical re-review 2).
  const [first] = await tx
    .select({ at: sql<Date>`min(${medicationAdministration.recordedAt})` })
    .from(medicationAdministration)
    .where(inArray(medicationAdministration.id, [...input.chainIds]));
  if (first?.at && new Date(first.at) < item.openedAt) return;
  const alreadyMoved = moved.reduce((sum, m) => balanceAfter(sum, Number(m.change)), 0);
  const should =
    doseStockMove({
      outcome: input.record.outcome,
      isControlledDrug: false,
      item,
      amount: amountOf(input.record),
    }) ?? 0;
  const change = correctionStockChange({ shouldHaveLeft: should, alreadyMoved });
  if (change === null) return;
  await writeMovement(tx, {
    item,
    locationId: input.locationId,
    movement: "administration_correction",
    change,
    recordedBy: input.recordedBy,
    administrationId: input.record.id,
    reason: "Corrected dose",
  });
}

export const ORDER_DUE_TASK = "medicines.order.due";

/**
 * Rule 6: one "medicines order due" task per location and cycle, raised
 * `medicines.order.prompt_days_before` days before the cycle starts, unless the location already
 * has an order for it. Run daily by the worker for each organisation.
 */
export async function raiseReorderPrompts(
  tx: Transaction,
  tenantId: string,
  now: Date,
): Promise<number> {
  const cycles = await tx
    .select({
      id: medicineOrderCycle.id,
      locationId: medicineOrderCycle.locationId,
      anchorOn: medicineOrderCycle.anchorOn,
      nation: location.nation,
    })
    .from(medicineOrderCycle)
    .innerJoin(location, eq(location.id, medicineOrderCycle.locationId))
    .where(isNull(medicineOrderCycle.deletedAt));
  const today = ukIsoDate(now);
  let raised = 0;
  for (const cycle of cycles) {
    const rates = await stockRates(
      tx,
      tenantId,
      cycle.nation as Exclude<RateNation, "uk" | "all">,
      today,
    );
    const due = orderDueFor(cycle.anchorOn, today, rates);
    if (!due) continue;
    const [ordered] = await tx
      .select({ id: medicineOrder.id })
      .from(medicineOrder)
      .where(
        and(
          eq(medicineOrder.locationId, cycle.locationId),
          eq(medicineOrder.cycleStartsOn, due),
          ne(medicineOrder.status, "cancelled"),
        ),
      )
      .limit(1);
    if (ordered) continue;
    const [prompted] = await tx
      .select({ id: task.id })
      .from(task)
      .where(
        and(
          eq(task.kind, ORDER_DUE_TASK),
          eq(task.sourceType, "medicine_order_cycle"),
          eq(task.sourceId, cycle.id),
          sql`${task.details}->>'cycleStartsOn' = ${due}`,
        ),
      )
      .limit(1);
    if (prompted) continue;
    await tx.insert(task).values({
      kind: ORDER_DUE_TASK,
      title: ORDER_DUE_TASK_TITLE,
      requiredPermission: "medicines.stock.manage",
      locationId: cycle.locationId,
      sourceType: "medicine_order_cycle",
      sourceId: cycle.id,
      assigneeRoleKey: "clinical_lead",
      dueAt: now,
      priority: "routine",
      details: { cycleStartsOn: due },
    });
    raised += 1;
  }
  return raised;
}

/**
 * Runs a stock hook so it can never fail the dose it follows (HZ-003; slice 42 clinical review 1):
 * in a savepoint; if it fails, the savepoint is undone, a routine count task asks the person in
 * charge to check the stock, and the dose stands.
 */
export async function neverFailingTheDose(
  tx: Transaction,
  input: {
    readonly personId: string;
    readonly locationId: string | null;
    readonly sourceId: string;
  },
  hook: (sp: Transaction) => Promise<void>,
  onFailure: (error: unknown) => void,
): Promise<void> {
  try {
    await tx.transaction(async (sp) => hook(sp as unknown as Transaction));
  } catch (error) {
    onFailure(error);
    await tx.insert(task).values({
      kind: STOCK_COUNT_TASK,
      title: STOCK_COUNT_TASK_TITLE,
      requiredPermission: "medicines.stock.manage",
      personId: input.personId,
      locationId: input.locationId,
      sourceType: "medication_administration",
      sourceId: input.sourceId,
      assigneeRoleKey: "clinical_lead",
      dueAt: new Date(),
      priority: "routine",
      details: { reason: "stock_not_moved" },
    });
  }
}
