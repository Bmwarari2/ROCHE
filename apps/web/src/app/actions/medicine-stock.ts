"use server";

import {
  MedicineOrderVersion,
  NewMedicineOrder,
  NewMedicineStorage,
  NewTemperatureReading,
  OpenStockItem,
  PutOrderCycle,
  RecordDisposal,
  StockCount,
  StockQuantity,
  SubmitMedicineOrder,
} from "@harbour/contracts";
import type { components } from "@harbour/contracts/client";
import { revalidatePath } from "next/cache";
import { unstable_rethrow } from "next/navigation";
import { tenantApi } from "@/lib/api";
import { isUuid } from "@/lib/context-cookies";
import { t } from "@/lib/i18n";
import {
  locationStockHref,
  personStockHref,
  STOCK_FIELD_FOR_PROBLEM,
  STOCK_PROBLEMS,
} from "@/lib/medicine-stock";
import { medicinesHref } from "@/lib/medicines";
import { type ActionResult, problemMessage, refused } from "@/lib/outcome";

/**
 * Medicines stock, ordering, disposal and temperatures (slice 55; MEDS-008; medicines.md
 * section 15). Each body is checked against the contract and holds only the form's fields. The
 * API runs every stock rule (the witness, the order's steps, the count under a lock) and decides
 * whether a reading is out of range from the rate table (HZ-132); its refusals are shown in its
 * own words, at the field they belong to. The web keeps nothing and logs nothing.
 */

type Schemas = components["schemas"];
type Api = Awaited<ReturnType<typeof tenantApi>>;

/** A stock refusal in the API's own words (its detail, or its one-sentence title). */
function stockProblem(error: unknown) {
  const problem = (error ?? {}) as { code?: unknown; detail?: unknown; title?: unknown };
  const code = typeof problem.code === "string" ? problem.code : "";
  const detail = typeof problem.detail === "string" ? problem.detail.trim() : "";
  const title = typeof problem.title === "string" ? problem.title.trim() : "";
  const words = detail || title;
  if (!words || !STOCK_PROBLEMS.has(code)) return problemMessage(error, t);
  const field = STOCK_FIELD_FOR_PROBLEM[code];
  return field ? { code, message: words, fields: { [field]: words } } : { code, message: words };
}

async function send<T>(
  paths: readonly string[],
  call: (api: Api) => Promise<{ data?: T; error?: unknown; response: Response }>,
): Promise<ActionResult<T | null>> {
  try {
    const { data, error, response } = await call(await tenantApi());
    if (!response.ok) return { ok: false, ...stockProblem(error) };
    for (const path of paths) revalidatePath(path, "layout");
    return { ok: true, data: data ?? null };
  } catch (error) {
    unstable_rethrow(error);
    return { ok: false, ...problemMessage(undefined, t) };
  }
}

const notFound = () => refused(t("errors.notFound"), "not_found");
const invalid = () => refused(t("errors.generic"), "invalid");
const personPaths = (personId: string) => [medicinesHref(personId), personStockHref(personId)];

/** Opens a stock item from one of the person's MAR entries. */
export async function openStockItem(
  personId: string,
  body: Schemas["OpenStockItem"],
): Promise<ActionResult<Schemas["StockMoved"] | null>> {
  if (!isUuid(personId)) return notFound();
  const parsed = OpenStockItem.safeParse({ medicationId: body.medicationId });
  if (!parsed.success) return invalid();
  return send(personPaths(personId), (api) =>
    api.POST("/v1/people/{id}/medicine-stock", {
      params: { path: { id: personId } },
      body: parsed.data,
    }),
  );
}

/** Records medicines received (naming the order line they fill) or returned to the pharmacy. */
export async function moveStock(
  personId: string,
  itemId: string,
  kind: "receipt" | "return",
  body: Schemas["StockQuantity"],
): Promise<ActionResult<Schemas["StockMoved"] | null>> {
  if (!isUuid(personId) || !isUuid(itemId)) return notFound();
  const parsed = StockQuantity.safeParse({
    quantity: body.quantity,
    orderLineId: kind === "receipt" ? body.orderLineId : null,
  });
  if (!parsed.success) return invalid();
  return send(personPaths(personId), (api) =>
    kind === "receipt"
      ? api.POST("/v1/medicine-stock/{itemId}/receipts", {
          params: { path: { itemId } },
          body: parsed.data,
        })
      : api.POST("/v1/medicine-stock/{itemId}/returns", {
          params: { path: { itemId } },
          body: parsed.data,
        }),
  );
}

/** Records a count; one that differs from the balance adjusts it, with the reason. */
export async function countStock(
  personId: string,
  itemId: string,
  body: Schemas["StockCount"],
): Promise<ActionResult<Schemas["StockMoved"] | null>> {
  if (!isUuid(personId) || !isUuid(itemId)) return notFound();
  const parsed = StockCount.safeParse({ counted: body.counted, reason: body.reason });
  if (!parsed.success) return invalid();
  return send(personPaths(personId), (api) =>
    api.POST("/v1/medicine-stock/{itemId}/counts", {
      params: { path: { itemId } },
      body: parsed.data,
    }),
  );
}

/** Records a disposal; a named witness is asked by a task to confirm it themselves. */
export async function disposeStock(
  personId: string,
  itemId: string,
  body: Schemas["RecordDisposal"],
): Promise<ActionResult<Schemas["StockMoved"] | null>> {
  if (!isUuid(personId) || !isUuid(itemId)) return notFound();
  const parsed = RecordDisposal.safeParse({
    quantity: body.quantity,
    reason: body.reason,
    note: body.note,
    witnessId: body.witnessId,
    noWitnessReason: body.noWitnessReason,
  });
  if (!parsed.success) return invalid();
  return send(personPaths(personId), (api) =>
    api.POST("/v1/medicine-stock/{itemId}/disposals", {
      params: { path: { itemId } },
      body: parsed.data,
    }),
  );
}

/** Confirms a disposal as its named witness, from the witness's own session. */
export async function witnessDisposal(
  personId: string,
  disposalId: string,
): Promise<ActionResult<Schemas["DisposalOut"] | null>> {
  if (!isUuid(personId) || !isUuid(disposalId)) return notFound();
  return send(personPaths(personId), (api) =>
    api.POST("/v1/medicine-disposals/{id}/witness", { params: { path: { id: disposalId } } }),
  );
}

/** Sets the location's 28-day cycle, against the version read. */
export async function setOrderCycle(
  locationId: string,
  body: Schemas["PutOrderCycle"],
): Promise<ActionResult<Schemas["OrderCycleOut"] | null>> {
  if (!isUuid(locationId)) return notFound();
  const parsed = PutOrderCycle.safeParse({ anchorOn: body.anchorOn, version: body.version });
  if (!parsed.success) return invalid();
  return send([locationStockHref(locationId)], (api) =>
    api.PUT("/v1/locations/{id}/medicine-cycle", {
      params: { path: { id: locationId } },
      body: parsed.data,
    }),
  );
}

/** Starts a draft order for a cycle with its lines. */
export async function createOrder(
  locationId: string,
  body: Schemas["NewMedicineOrder"],
): Promise<ActionResult<Schemas["MedicineOrderOut"] | null>> {
  if (!isUuid(locationId)) return notFound();
  const parsed = NewMedicineOrder.safeParse({
    cycleStartsOn: body.cycleStartsOn,
    lines: body.lines.map((l) => ({
      personId: l.personId,
      medicationId: l.medicationId,
      quantity: l.quantity,
    })),
  });
  if (!parsed.success) return invalid();
  return send([locationStockHref(locationId)], (api) =>
    api.POST("/v1/locations/{id}/medicine-orders", {
      params: { path: { id: locationId } },
      body: parsed.data,
    }),
  );
}

/** Submits a draft order by hand or through the pharmacy, against the version read. */
export async function submitOrder(
  locationId: string,
  orderId: string,
  body: Schemas["SubmitMedicineOrder"],
): Promise<ActionResult<Schemas["MedicineOrderOut"] | null>> {
  if (!isUuid(locationId) || !isUuid(orderId)) return notFound();
  const parsed = SubmitMedicineOrder.safeParse({ version: body.version, via: body.via });
  if (!parsed.success) return invalid();
  return send([locationStockHref(locationId)], (api) =>
    api.POST("/v1/medicine-orders/{id}/submit", {
      params: { path: { id: orderId } },
      body: parsed.data,
    }),
  );
}

/** Cancels an order not yet received, against the version read. */
export async function cancelOrder(
  locationId: string,
  orderId: string,
  body: Schemas["MedicineOrderVersion"],
): Promise<ActionResult<Schemas["MedicineOrderOut"] | null>> {
  if (!isUuid(locationId) || !isUuid(orderId)) return notFound();
  const parsed = MedicineOrderVersion.safeParse({ version: body.version });
  if (!parsed.success) return invalid();
  return send([locationStockHref(locationId)], (api) =>
    api.POST("/v1/medicine-orders/{id}/cancel", {
      params: { path: { id: orderId } },
      body: parsed.data,
    }),
  );
}

/** Adds a fridge or a medicines room or cupboard at the location. */
export async function addStorage(
  locationId: string,
  body: Schemas["NewMedicineStorage"],
): Promise<ActionResult<Schemas["MedicineStorageOut"] | null>> {
  if (!isUuid(locationId)) return notFound();
  const parsed = NewMedicineStorage.safeParse({ kind: body.kind, name: body.name });
  if (!parsed.success) return invalid();
  return send([locationStockHref(locationId)], (api) =>
    api.POST("/v1/locations/{id}/medicine-storage", {
      params: { path: { id: locationId } },
      body: parsed.data,
    }),
  );
}

/**
 * Records a temperature reading. The answer says whether the database found it out of range and,
 * in the API's words, what happens next (HZ-132).
 */
export async function recordReading(
  locationId: string,
  storageId: string,
  body: Schemas["NewTemperatureReading"],
): Promise<ActionResult<Schemas["TemperatureReadingRecorded"] | null>> {
  if (!isUuid(locationId) || !isUuid(storageId)) return notFound();
  const parsed = NewTemperatureReading.safeParse({
    celsius: body.celsius,
    minCelsius: body.minCelsius,
    maxCelsius: body.maxCelsius,
  });
  if (!parsed.success) return invalid();
  return send([locationStockHref(locationId)], (api) =>
    api.POST("/v1/medicine-storage/{id}/readings", {
      params: { path: { id: storageId } },
      body: parsed.data,
    }),
  );
}
