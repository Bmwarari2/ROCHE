import { z } from "zod";

/**
 * Medicines stock, ordering, disposal and storage temperatures (medicines.md section 15;
 * MEDS-008; slice 42; ADR-0103). Quantities are in the item's unit, to thousandths;
 * temperatures in degrees Celsius to one decimal place.
 */

const uuid = z.uuid();
const isoDate = z.iso.date();
const isoDateTime = z.iso.datetime({ offset: true });
const version = z.number().int().min(1);
const quantity = z.number().min(0.001).max(1_000_000);
/** One decimal place at most, so a reading at a range's edge is never rounded into it (HZ-132). */
const celsius = z
  .number()
  .min(-50)
  .max(60)
  .refine((v) => Math.abs(v * 10 - Math.round(v * 10)) < 1e-6, "One decimal place at most");
const note = z.string().trim().min(3).max(500);

export const StockMovementOut = z
  .object({
    id: uuid,
    seq: z.number().int(),
    movement: z.enum([
      "receipt",
      "carried_forward",
      "administration",
      "returned",
      "disposal",
      "administration_correction",
      "count_adjustment",
    ]),
    change: z.number(),
    balanceAfter: z.number(),
    administrationId: uuid.nullable(),
    orderLineId: uuid.nullable(),
    disposalId: uuid.nullable(),
    recordedBy: uuid,
    recordedAt: isoDateTime,
  })
  .meta({ id: "StockMovementOut" });

export const StockItemOut = z
  .object({
    id: uuid,
    medicationId: uuid,
    vmpId: z.string(),
    productName: z.string(),
    unitCode: z.string(),
    unitName: z.string(),
    balance: z.number(),
    /** The latest movements, newest first. */
    movements: z.array(StockMovementOut),
  })
  .meta({ id: "StockItemOut" });

export const PersonStock = z
  .object({
    items: z.array(StockItemOut),
    /** Controlled drugs, from their register (section 14): never counted here. */
    controlledDrugs: z.array(
      z.object({
        pageId: uuid,
        productName: z.string(),
        unitName: z.string(),
        balance: z.number(),
        source: z.literal("controlled_drugs_register"),
      }),
    ),
  })
  .meta({ id: "PersonStock" });

export const OpenStockItem = z.object({ medicationId: uuid }).meta({ id: "OpenStockItem" });

export const StockQuantity = z
  .object({ quantity, orderLineId: uuid.nullable().default(null) })
  .meta({ id: "StockQuantity" });

export const StockCount = z
  .object({
    counted: z.number().min(0).max(1_000_000),
    /** Needed when the count differs from the balance. */
    reason: note.nullable().default(null),
  })
  .meta({ id: "StockCount" });

export const RecordDisposal = z
  .object({
    quantity,
    reason: z.enum([
      "refused_dose",
      "dropped_or_spoilt",
      "out_of_date",
      "discontinued",
      "person_left",
      "other",
    ]),
    note: note.nullable().default(null),
    /** A second member, who confirms it themselves. */
    witnessId: uuid.nullable().default(null),
    /** Where the organisation's policy allows: why no one could witness it. */
    noWitnessReason: z.string().trim().min(10).max(500).nullable().default(null),
  })
  .meta({ id: "RecordDisposal" });

export const DisposalOut = z
  .object({
    id: uuid,
    itemId: uuid,
    quantity: z.number(),
    reason: z.string(),
    status: z.enum(["awaiting_witness", "witnessed", "no_witness"]),
    witnessId: uuid.nullable(),
    witnessedAt: isoDateTime.nullable(),
    recordedBy: uuid,
    recordedAt: isoDateTime,
  })
  .meta({ id: "DisposalOut" });

export const StockMoved = z
  .object({ item: StockItemOut, disposal: DisposalOut.nullable() })
  .meta({ id: "StockMoved" });

export const PutOrderCycle = z
  .object({ anchorOn: isoDate, version: z.number().int().nullable() })
  .meta({ id: "PutOrderCycle" });

export const OrderCycleOut = z
  .object({
    anchorOn: isoDate.nullable(),
    version: z.number().int().nullable(),
    cycleDays: z.number().int(),
    nextCycleStartsOn: isoDate.nullable(),
  })
  .meta({ id: "OrderCycleOut" });

export const NewMedicineOrder = z
  .object({
    cycleStartsOn: isoDate,
    lines: z
      .array(z.object({ personId: uuid, medicationId: uuid, quantity }))
      .min(1)
      .max(2000),
  })
  .meta({ id: "NewMedicineOrder" });

export const MedicineOrderOut = z
  .object({
    id: uuid,
    version,
    cycleStartsOn: isoDate,
    status: z.enum(["draft", "submitted", "part_received", "received", "cancelled"]),
    sentVia: z.enum(["manual", "pharmacy_port"]).nullable(),
    pharmacyReference: z.string().nullable(),
    submittedAt: isoDateTime.nullable(),
    lines: z.array(
      z.object({
        id: uuid,
        personId: uuid,
        medicationId: uuid,
        productName: z.string(),
        quantity: z.number(),
        unitCode: z.string(),
        received: z.number(),
      }),
    ),
  })
  .meta({ id: "MedicineOrderOut" });

export const MedicineOrderList = z
  .object({ items: z.array(MedicineOrderOut) })
  .meta({ id: "MedicineOrderList" });

export const SubmitMedicineOrder = z
  .object({ version, via: z.enum(["manual", "pharmacy_port"]) })
  .meta({ id: "SubmitMedicineOrder" });

export const MedicineOrderVersion = z.object({ version }).meta({ id: "MedicineOrderVersion" });

export const NewMedicineStorage = z
  .object({ kind: z.enum(["fridge", "room"]), name: z.string().trim().min(2).max(80) })
  .meta({ id: "NewMedicineStorage" });

export const MedicineStorageOut = z
  .object({ id: uuid, version, kind: z.enum(["fridge", "room"]), name: z.string() })
  .meta({ id: "MedicineStorageOut" });

export const MedicineStorageList = z
  .object({ items: z.array(MedicineStorageOut) })
  .meta({ id: "MedicineStorageList" });

export const NewTemperatureReading = z
  .object({
    celsius,
    /** The thermometer's minimum and maximum since the last reading, when it has them. */
    minCelsius: celsius.nullable().default(null),
    maxCelsius: celsius.nullable().default(null),
  })
  .meta({ id: "NewTemperatureReading" });

export const TemperatureReadingOut = z
  .object({
    id: uuid,
    celsius: z.number(),
    minCelsius: z.number().nullable(),
    maxCelsius: z.number().nullable(),
    /** The range that applied, from the rate table. */
    lowCelsius: z.number().nullable(),
    highCelsius: z.number(),
    outOfRange: z.boolean(),
    taskId: uuid.nullable(),
    recordedBy: uuid,
    recordedAt: isoDateTime,
  })
  .meta({ id: "TemperatureReadingOut" });

export const TemperatureReadingRecorded = z
  .object({ reading: TemperatureReadingOut, message: z.string() })
  .meta({ id: "TemperatureReadingRecorded" });

export const TemperatureReadingList = z
  .object({ items: z.array(TemperatureReadingOut) })
  .meta({ id: "TemperatureReadingList" });
