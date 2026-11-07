import { z } from "zod";
import { CdWitness } from "./controlled-drugs";
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
  /**
   * For a controlled drug whose stock this moves (slice 34): the witness's signature for this
   * administration, or where policy allows why there was none. The register entry is written with
   * the record.
   */
  controlledDrug: CdWitness.nullable().default(null),
  /** Given covertly, under the person's covert record for the medicine (slice 38). */
  covert: z.boolean().default(false),
};

/**
 * How the person was identified and the pack checked at the point of care (ADR-0081; HZ-001,
 * HZ-113): sent by the phone with each record. A dose given needs both; an outcome that gives
 * nothing needs neither. Kept as the record's barcode evidence. No pack serial: it is not needed.
 */
export const PointOfCare = z
  .object({
    identity: z.enum(["photo", "wristband"]).nullable(),
    pack: z
      .object({
        method: z.enum(["scanned", "override"]),
        gtin: z
          .string()
          .regex(/^\d{14}$/)
          .nullable()
          .default(null),
        batch: text(20).nullable().default(null),
        expiry: ukDate.nullable().default(null),
        amppId: z
          .string()
          .regex(/^[1-9]\d{5,17}$/)
          .nullable()
          .default(null),
        override: z
          .object({
            code: z.enum([
              "no_barcode_on_pack",
              "barcode_unreadable",
              "pack_not_in_reference_data",
              "patient_own_supply",
              "other",
            ]),
            note: text(500).nullable().default(null),
          })
          .nullable()
          .default(null),
      })
      .nullable(),
  })
  .meta({ id: "PointOfCare" });
export type PointOfCare = z.infer<typeof PointOfCare>;

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
    /** Who gave it, when someone else records it after it was given; the recorder otherwise. */
    givenBy: uuid.nullable().default(null),
    /** Identity and pack checks, sent by the phone (ADR-0081). */
    pointOfCare: PointOfCare.nullable().default(null),
    /**
     * When the phone recorded it, by its clock: a phone's upload only (it names its device), within
     * the clock-drift figure of the time in its UUIDv7 id. The rules judge the record at this time,
     * so a dose recorded offline and sent later is judged as recorded on the round, never as
     * "recorded after a delay" (clinical review of slice 69, B1).
     */
    deviceRecordedAt: isoDateTime.nullable().default(null),
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
    /** Who gave it, when the correction names someone other than the record did. */
    givenBy: uuid.nullable().default(null),
    /**
     * Given covertly, as corrected. Left out, the original's mark carries forward while the dose
     * is still given, so a correction never quietly drops it (HZ-026, clinical review).
     */
    covert: z.boolean().optional(),
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
    administeredBy: uuid,
    recorded: Actor,
    flags: z.array(z.string()),
    /** Given covertly: marked on the MAR (slice 38). */
    covert: z.boolean(),
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
        /** The medicine as dm+d words it. */
        productName: z.string(),
        dueAt: isoDateTime,
        date: ukDate,
        time: z.string(),
        /** The weekday, for a pattern that is not every day. */
        dayName: z.string().nullable(),
        /** A clock change moved this time (skipped) or it happens twice (repeated). */
        clockChange: z.enum(["time_skipped", "time_repeated"]).nullable(),
        doseInWords: z.string(),
        timeCritical: z.boolean(),
        state: z.enum(["not_yet_due", "due", "late", "recorded"]),
        stateInWords: z.string(),
        /** Recorded twice on different devices, with the review still open. */
        reviewPending: z.boolean(),
        reviewInWords: z.string().nullable(),
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
        productName: z.string(),
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
export type MedicineRound = z.infer<typeof MedicineRound>;

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

/** A device's second record of a dose, kept for review (medicines.md 15.4; slice 48). */
export const ConflictRaised = z
  .object({
    conflictId: uuid,
    /** The record that stands on the server. */
    standingId: uuid,
    message: z.string(),
  })
  .meta({ id: "AdministrationConflictRaised" });

/** A record a device uploaded for a dose already recorded, as it sent it (medicines.md 15.4). */
export const UploadedAdministration = z
  .object({
    id: uuid,
    outcome: AdministrationOutcome,
    amount: z.object({ quantity: z.number(), unitCode: z.string() }).nullable(),
    reason: z.object({ code: z.string(), note: z.string().nullable() }).nullable(),
    givenAt: isoDateTime.nullable(),
    timingReason: z.string().nullable(),
    amountDifferenceReason: z.string().nullable(),
    givenBy: uuid.nullable(),
    givenBeforeRecordedReason: z.string().nullable(),
    /** What the server found wrong with it when it arrived (problem codes). */
    problems: z.array(z.string()),
    deviceAt: isoDateTime.nullable(),
    uploadedBy: uuid,
    receivedAt: isoDateTime,
  })
  .meta({ id: "UploadedAdministration" });

export const AdministrationConflictOut = z
  .object({
    id: uuid,
    personId: uuid,
    entryId: uuid,
    dueAt: isoDateTime,
    /** The record that stands, as stored. */
    standing: AdministrationOut,
    /** The uploaded record as the device sent it. */
    uploaded: UploadedAdministration,
    /** Further uploads of the same dose by the same person, resolved with this one. */
    joined: z.array(UploadedAdministration),
    /** What the server found wrong with the upload when it arrived (problem codes). */
    problems: z.array(z.string()),
    deviceAt: isoDateTime.nullable(),
    uploadedBy: uuid,
    receivedAt: isoDateTime,
    resolution: z
      .object({
        outcome: z.enum(["first_stands", "corrected", "both_given"]),
        correctionId: uuid.nullable(),
        note: z.string(),
        by: uuid,
        at: isoDateTime,
      })
      .nullable(),
  })
  .meta({ id: "AdministrationConflict" });

export const AdministrationConflictList = z
  .object({
    conflicts: z.array(AdministrationConflictOut),
    /** More conflicts match than are listed (at most 200). */
    truncated: z.boolean(),
  })
  .meta({ id: "AdministrationConflictList" });

/** One of locationId or personId is required (checked by the route). */
export const ConflictsQuery = z.object({
  locationId: uuid.optional(),
  personId: uuid.optional(),
  /** Include resolved conflicts; open ones only by default. */
  all: z.enum(["true", "false"]).default("false"),
});

export const ResolveConflict = z
  .object({
    /**
     * first_stands: the same dose sent twice; corrected: the MAR was corrected; both_given: the dose
     * was given twice, which raises a medication incident.
     */
    outcome: z.enum(["first_stands", "corrected", "both_given"]),
    /** The correction made through the corrections route, when corrected. */
    correctionId: uuid.nullable().default(null),
    note: reason,
  })
  .meta({ id: "ResolveAdministrationConflict" });

export const LocationRoundQuery = z.object({ from: isoDateTime, to: isoDateTime });

export const LocationRound = z
  .object({
    from: isoDateTime,
    to: isoDateTime,
    people: z.array(
      z.object({
        personId: uuid,
        room: z.string().nullable(),
        doses: MedicineRound.shape.doses,
        whenRequired: MedicineRound.shape.whenRequired,
        /** Why this person's round could not be worked out, in words; null when it was. */
        unavailable: z.string().nullable(),
      }),
    ),
  })
  .meta({ id: "LocationMedicineRound" });
