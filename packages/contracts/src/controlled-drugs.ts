import { z } from "zod";

/**
 * The controlled drugs register (MEDS-005; medicines.md section 14; slice 34; ADR-0083). Requests
 * carry what moved; the API runs slice 3's rules (`checkCdEntry`, `cdStockCheck`) on the page as
 * it stands and answers with every problem in words. The witness signs first, with their own
 * session and step-up (ADR-0084), and the entry names that signature.
 */

const uuid = z.uuid();
const isoDateTime = z.iso.datetime({ offset: true });
const text = (max: number) => z.string().trim().min(1).max(max);
const reason = text(2000);

export const CdMovement = z
  .enum(["receipt", "administration", "disposal", "transfer_out", "destruction", "correction"])
  .meta({ id: "CdMovement" });

/** How the second signature is given: a witness's assertion, or (where policy allows) why none. */
/** One signature made on a phone with a member's own PIN-unlocked key (ADR-0084; slice 70). */
export const DeviceSignature = z
  .object({
    /** The member_device_key that signed. */
    keyId: uuid,
    /** ECDSA P-256 over the dose statement (`cdDoseStatementText`), r||s, base64. */
    signature: z.string().regex(/^[A-Za-z0-9+/]{86}==$/),
    /** When they signed, by the phone's clock. */
    signedAt: isoDateTime,
  })
  .meta({ id: "DeviceSignature" });

export const CdWitness = z
  .union([z.object({ witnessAssertionId: uuid }), z.object({ noWitnessReason: reason })])
  .meta({ id: "CdWitness" });

/**
 * A dose's second signature: as the register's, or, offline on one phone, the recorder's own
 * signature standing for their step-up and the witness's on the same phone; the server verifies
 * both (ADR-0084; slice 70).
 */
export const DoseCdWitness = z
  .union([
    z.object({ witnessAssertionId: uuid }),
    z.object({ noWitnessReason: reason }),
    z.object({
      deviceSignatures: z.object({
        recorder: DeviceSignature,
        witness: DeviceSignature.extend({ witnessId: uuid }),
      }),
    }),
  ])
  .meta({ id: "DoseCdWitness" });

export const EnrolDeviceKey = z
  .object({
    /** The uncompressed P-256 public key (65 bytes), base64. */
    publicKey: z.string().regex(/^[A-Za-z0-9+/]{86}[AEIMQUYcgkosw048]=$/),
  })
  .meta({ id: "EnrolDeviceKey" });

export const DeviceKeyOut = z
  .object({ id: uuid, deviceId: uuid, enrolledAt: isoDateTime })
  .meta({ id: "DeviceKey" });

export const OpenCdPage = z
  .object({ /** The MAR entry whose dm+d product is a controlled drug. */ entryId: uuid })
  .meta({ id: "OpenCdPage" });

export const AssertWitness = z
  .object({
    /** What the witness saw: a movement, or `stock_check` for a count. */
    movement: z.union([CdMovement, z.literal("stock_check")]),
    /** The quantity they saw moved or counted; a quantity correction's signed change. */
    quantity: z.number().min(-10_000_000).max(10_000_000),
    /** The administration they saw given (its client id), for a dose. */
    administrationId: uuid.nullable().default(null),
    /** The member they watched record it: only that member's entry may use the signature. */
    recorderId: uuid,
  })
  .meta({ id: "AssertWitness" });

export const WitnessAssertionOut = z
  .object({ id: uuid, pageId: uuid, witnessId: uuid, expiresAt: isoDateTime })
  .meta({ id: "WitnessAssertion" });

export const RecordCdEntry = z
  .object({
    movement: z.enum(["receipt", "disposal", "transfer_out", "destruction", "correction"]),
    /** The amount moved; for a quantity correction, the signed change; 0 for a detail correction. */
    quantity: z.number().min(-10_000_000).max(10_000_000),
    /** When it happened; the server's time when not given. */
    occurredAt: isoDateTime.nullable().default(null),
    counterparty: text(300).nullable().default(null),
    reference: text(300).nullable().default(null),
    correctsId: uuid.nullable().default(null),
    corrects: z.enum(["quantity", "detail"]).nullable().default(null),
    reason: reason.nullable().default(null),
    witness: CdWitness,
  })
  .meta({ id: "RecordCdEntry" });

export const RecordStockCheck = z
  .object({
    counted: z.number().min(0).max(10_000_000),
    reason: reason.nullable().default(null),
    witness: CdWitness,
  })
  .meta({ id: "RecordStockCheck" });

const Actor = z.object({ id: uuid, at: isoDateTime });

export const CdEntryOut = z
  .object({
    id: uuid,
    seq: z.number().int(),
    movement: CdMovement,
    quantity: z.number(),
    balanceAfter: z.number(),
    correctsId: uuid.nullable(),
    corrects: z.enum(["quantity", "detail"]).nullable(),
    reason: z.string().nullable(),
    counterparty: z.string().nullable(),
    reference: z.string().nullable(),
    occurredAt: isoDateTime,
    recorded: Actor,
    witnessId: uuid.nullable(),
    noWitnessReason: z.string().nullable(),
    flags: z.array(z.string()),
    administrationId: uuid.nullable(),
    /** The corrections that put this entry right, shown beside it (margin corrections). */
    correctedBy: z.array(uuid),
  })
  .meta({ id: "CdEntry" });

export const StockCheckOut = z
  .object({
    id: uuid,
    counted: z.number(),
    expected: z.number(),
    difference: z.number(),
    /** "Balanced", or how many over or short, in words; never colour alone. */
    resultInWords: z.string(),
    /** A count that does not balance raised a medication incident when it was recorded (HZ-115). */
    incidentRaised: z.boolean(),
    reason: z.string().nullable(),
    checked: Actor,
    witnessId: uuid.nullable(),
    noWitnessReason: z.string().nullable(),
  })
  .meta({ id: "StockCheck" });
export type StockCheckOut = z.infer<typeof StockCheckOut>;

export const CdPageSummary = z
  .object({
    id: uuid,
    personId: uuid,
    vmpId: z.string(),
    productName: z.string(),
    unit: z.object({ code: z.string(), name: z.string() }),
    balance: z.number(),
    lastStockCheck: StockCheckOut.nullable(),
    nextStockCheckDueAt: isoDateTime.nullable(),
    witnessPolicy: z.enum(["required", "where_available"]),
  })
  .meta({ id: "CdPageSummary" });

export const CdPageList = z.object({ pages: z.array(CdPageSummary) }).meta({ id: "CdPageList" });

export const CdPageDetail = CdPageSummary.extend({
  entries: z.array(CdEntryOut),
  stockChecks: z.array(StockCheckOut),
  /** Everyone who recorded, witnessed or counted on the page, by name (slice 54). */
  people: z.array(z.object({ id: uuid, name: z.string() })),
}).meta({ id: "CdPageDetail" });

export const StockCheckRecorded = z
  .object({ stockCheck: StockCheckOut, incidentRaised: z.boolean() })
  .meta({ id: "StockCheckRecorded" });

/** Who a witness may sign for on a page: members who may record there, not the witness (slice 54). */
export const CdRecorderList = z
  .object({ recorders: z.array(z.object({ id: uuid, name: z.string() })) })
  .meta({ id: "CdRecorderList" });

/**
 * The witness signatures waiting for the signed-in recorder on a page: unused and unexpired, named
 * for this recorder only (slice 54; ADR-0084 on the web).
 */
export const CdWaitingAssertions = z
  .object({
    assertions: z.array(
      z.object({
        id: uuid,
        movement: z.union([CdMovement, z.literal("stock_check")]),
        quantity: z.number(),
        witnessName: z.string(),
        expiresAt: isoDateTime,
      }),
    ),
  })
  .meta({ id: "CdWaitingAssertions" });
