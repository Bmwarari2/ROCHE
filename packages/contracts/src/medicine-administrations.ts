import { z } from "zod";
import { Dose, MarSourceKind } from "./medicines";

/**
 * Administrations, corrections, witnesses and dosing records (MEDS-002; medicines.md section 13;
 * slice 22). Requests carry what happened; the API runs slice 3's rules (`checkAdministration`,
 * `checkCorrection`) and answers with every problem in words.
 */

const uuid = z.uuid();
const isoDateTime = z.iso.datetime({ offset: true });
const ukDate = z.iso.date();
const text = (max: number) => z.string().trim().min(1).max(max);
const reason = text(2000);
const quantity = z.number().min(0.001).max(10_000_000);

export const AdministrationOutcome = z
  .enum([
    "given",
    "refused",
    "omitted",
    "not_available",
    "self_administered",
    "given_by_family",
    "withheld",
  ])
  .meta({ id: "AdministrationOutcome" });

/** What happened, as the rules read it: the same shape for a new record and a correction. */
const RecordFields = {
  /** The entry version the dose is recorded against. */
  entryId: uuid,
  /** The scheduled dose; null for a when-required dose. */
  dueAt: isoDateTime.nullable().default(null),
  outcome: AdministrationOutcome,
  reason: z
    .object({ code: text(60), note: text(2000).nullable().default(null) })
    .nullable()
    .default(null),
  amount: z
    .object({ quantity, unitCode: text(40) })
    .nullable()
    .default(null),
  amountDifferenceReason: reason.nullable().default(null),
  timingReason: reason.nullable().default(null),
  intervalOverrideReason: reason.nullable().default(null),
};

export const RecordAdministration = z
  .object({
    /** The client's UUID: a resend with the same id is the same record. */
    id: uuid,
    ...RecordFields,
    /**
     * When the dose was given, by the device's clock. Only for a dose recorded after it was given
     * (with `givenBeforeRecorded`) or sent from a device; on the round the server's time is used.
     */
    givenAt: isoDateTime.nullable().default(null),
    /** The device's offset from the server at its last sync (server minus device), when known. */
    deviceOffsetMs: z.number().int().min(-86_400_000).max(86_400_000).nullable().default(null),
    /** A dose already given, recorded now, with why (#162). */
    givenBeforeRecorded: z.object({ reason }).nullable().default(null),
  })
  .meta({ id: "RecordAdministration" });

export const CorrectAdministration = z
  .object({
    /** The correction's own client UUID. */
    id: uuid,
    ...RecordFields,
    /** Why the record is corrected. */
    correctionReason: reason,
    /** When the dose was given or the outcome happened, as corrected. */
    givenAt: isoDateTime,
  })
  .meta({ id: "CorrectAdministration" });

const Actor = z.object({ id: uuid, at: isoDateTime });

export const AdministrationOut = z
  .object({
    id: uuid,
    personId: uuid,
    entryId: uuid,
    dueAt: isoDateTime.nullable(),
    outcome: AdministrationOutcome,
    outcomeInWords: z.string(),
    reason: z
      .object({ code: z.string(), words: z.string(), note: z.string().nullable() })
      .nullable(),
    amount: z.object({ quantity: z.number(), unitCode: z.string() }).nullable(),
    prescribed: Dose.nullable(),
    dosingRecordId: uuid.nullable(),
    givenAt: isoDateTime,
    recorded: Actor,
    flags: z.array(z.string()),
    /** The flags in words, for the record and the review (never colour alone). */
    flagsInWords: z.array(z.string()),
    givenBeforeRecordedReason: z.string().nullable(),
    supersedesId: uuid.nullable(),
    correctionReason: z.string().nullable(),
    /** Set when a later record corrects this one: shown struck through beside it. */
    supersededById: uuid.nullable(),
    witness: Actor.extend({ method: z.enum(["step_up", "device_factor"]) }).nullable(),
  })
  .meta({ id: "Administration" });
export type AdministrationOut = z.infer<typeof AdministrationOut>;

export const AdministrationRecorded = z
  .object({
    administration: AdministrationOut,
    /** What was escalated to the nurse in charge, in words; empty for almost every record. */
    escalations: z.array(
      z.object({ severity: z.enum(["urgent", "warning"]), message: z.string(), taskId: uuid }),
    ),
  })
  .meta({ id: "AdministrationRecorded" });

export const AdministrationList = z
  .object({ administrations: z.array(AdministrationOut) })
  .meta({ id: "AdministrationList" });

export const AdministrationsQuery = z.object({ from: isoDateTime, to: isoDateTime });

export const RoundQuery = z.object({ at: isoDateTime.optional() });

export const MedicineRound = z
  .object({
    at: isoDateTime,
    doses: z.array(
      z.object({
        entryId: uuid,
        dueAt: isoDateTime,
        date: ukDate,
        time: z.string(),
        doseInWords: z.string(),
        timeCritical: z.boolean(),
        state: z.enum(["not_yet_due", "due", "late", "recorded"]),
        stateInWords: z.string(),
        opensAt: isoDateTime,
        lateAfter: isoDateTime,
        notices: z.array(z.string()),
        entryStatus: z.object({
          words: z.string(),
          mayGive: z.boolean(),
          notice: z.string().nullable(),
        }),
      }),
    ),
    whenRequired: z.array(
      z.object({
        entryId: uuid,
        lastGiven: z.object({ at: isoDateTime, by: uuid, synced: z.boolean() }).nullable(),
        givenInLast24Hours: z.number(),
        maxPer24Hours: z.number().nullable(),
        remaining: z.number().nullable(),
        nextAllowedAt: isoDateTime.nullable(),
        notices: z.array(z.string()),
      }),
    ),
  })
  .meta({ id: "MedicineRound" });

export const WitnessAdministration = z
  .object({
    /** The witness saw the dose given (or the outcome) themselves. */
    witnessed: z.literal(true),
  })
  .meta({ id: "WitnessAdministration" });

export const RecordDosingRecord = z
  .object({
    source: z.object({
      kind: MarSourceKind,
      reference: text(500),
      documentId: uuid.nullable().default(null),
    }),
    doses: z
      .array(
        z.object({
          date: ukDate,
          time: z.string().regex(/^([01][0-9]|2[0-3]):[0-5][0-9]$/),
          quantity,
        }),
      )
      .min(1)
      .max(400),
  })
  .meta({ id: "RecordDosingRecord" });

export const CheckDosingRecord = z
  .object({
    outcome: z.enum(["matches_source", "differs_from_source"]),
    difference: reason.nullable().default(null),
    comparedWithSource: z.literal(true),
  })
  .meta({ id: "CheckDosingRecord" });

export const DosingRecordOut = z
  .object({
    id: uuid,
    personId: uuid,
    entryId: uuid,
    source: z.object({
      kind: MarSourceKind,
      reference: z.string(),
      documentId: uuid.nullable(),
    }),
    doses: z.array(z.object({ date: ukDate, time: z.string(), quantity: z.number() })),
    recorded: Actor,
    secondCheck: Actor.extend({
      outcome: z.enum(["matches_source", "differs_from_source"]),
      difference: z.string().nullable(),
    }).nullable(),
  })
  .meta({ id: "DosingRecord" });
export type DosingRecordOut = z.infer<typeof DosingRecordOut>;

export const DosingRecordList = z
  .object({ dosingRecords: z.array(DosingRecordOut) })
  .meta({ id: "DosingRecordList" });
