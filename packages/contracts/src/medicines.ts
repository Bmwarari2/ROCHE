import { z } from "zod";

/**
 * The medicines record and reconciliation (MEDS-001; medicines.md sections 4.1 and 5; slice 16).
 * Requests carry what was transcribed; the API runs the slice 2 domain rules and answers with
 * every problem in words. Doses are structured (a number and a dm+d unit), never free text.
 */

const uuid = z.uuid();
const isoDateTime = z.iso.datetime({ offset: true });
const ukDate = z.iso.date();
const text = (max: number) => z.string().trim().min(1).max(max);
const dmdId = z.string().regex(/^[0-9]{6,18}$/);
const reason = text(2000);
const expectedVersion = z.number().int().min(1);

export const DmdProductRef = z
  .object({ vmpId: dmdId, ampId: dmdId.nullable().default(null), name: text(500) })
  .meta({ id: "DmdProductRef" });
export const DmdRoute = z.object({ code: text(40), name: text(200) }).meta({ id: "DmdRoute" });
export const DoseUnit = z.object({ code: text(40), name: text(200) }).meta({ id: "DoseUnit" });

/** A dose quantity as a number; the API refuses more than 3 decimal places and zero or less. */
const quantity = z.number().min(0.001).max(10_000_000);
export const Dose = z
  .discriminatedUnion("kind", [
    z.object({ kind: z.literal("amount"), quantity, unit: DoseUnit }),
    z.object({ kind: z.literal("range"), from: quantity, to: quantity, unit: DoseUnit }),
    z.object({ kind: z.literal("variable"), unit: DoseUnit }),
  ])
  .meta({ id: "Dose" });

/** The domain's weekday codes, as the schedule rules match them (full names never matched). */
const Weekday = z.enum(["mon", "tue", "wed", "thu", "fri", "sat", "sun"]);
export const SchedulePattern = z
  .discriminatedUnion("kind", [
    z.object({ kind: z.literal("every_day") }),
    z.object({
      kind: z.literal("every_n_days"),
      intervalDays: z.number().int().min(2).max(366),
      anchorOn: ukDate,
    }),
    z.object({
      kind: z.literal("weekly"),
      weekdays: z.array(Weekday).min(1).max(7),
      intervalWeeks: z.number().int().min(1).max(52),
      anchorOn: ukDate,
    }),
    z.object({ kind: z.literal("monthly"), dayOfMonth: z.number().int().min(1).max(31) }),
  ])
  .meta({ id: "SchedulePattern" });

export const MarDirections = z
  .discriminatedUnion("kind", [
    z.object({
      kind: z.literal("regular"),
      schedule: z.object({
        pattern: SchedulePattern,
        times: z
          .array(
            z.object({ time: z.string().regex(/^([01][0-9]|2[0-3]):[0-5][0-9]$/), dose: Dose }),
          )
          .min(1)
          .max(24),
      }),
    }),
    z.object({ kind: z.literal("when_required"), dose: Dose }),
  ])
  .meta({ id: "MarDirections" });

export const MarSourceKind = z
  .enum([
    "prescription",
    "pharmacy_label",
    "pharmacy_mar",
    "discharge_letter",
    "transfer_letter",
    "gp_record",
    "clinic_letter",
    "prescriber_instruction",
    "previous_mar",
  ])
  .meta({ id: "MarSourceKind" });
export const MarSourceDocument = z
  .object({ kind: MarSourceKind, reference: text(500), documentId: uuid.nullable().default(null) })
  .meta({ id: "MarSourceDocument" });

/** What a version says: the product, route, directions, dates, prescriber and source. */
const DraftFields = {
  product: DmdProductRef,
  route: DmdRoute,
  directions: MarDirections,
  indication: text(1000).nullable().default(null),
  specialInstructions: text(2000).nullable().default(null),
  prescriber: text(300),
  startsAt: isoDateTime,
  stopsAt: isoDateTime.nullable().default(null),
  reviewOn: ukDate.nullable().default(null),
};
export const MarEntryDraftInput = z
  .object({ ...DraftFields, source: MarSourceDocument })
  .meta({ id: "MarEntryDraftInput" });
/** A reconciliation's draft: the person and the source come from the reconciliation. */
export const ReconciliationDraftInput = z
  .object(DraftFields)
  .meta({ id: "ReconciliationDraftInput" });

export const TranscribeMedicine = MarEntryDraftInput.extend({
  /** Why a restart of a product the person had before starts a new day count (rule 6a). */
  reanchorReason: reason.nullable().default(null),
  /** Why the doses earlier on the day it is recorded may still be needed (the same-day route). */
  earlierDosesDueReason: reason.nullable().default(null),
}).meta({ id: "TranscribeMedicine" });

export const ChangeMedicine = MarEntryDraftInput.extend({
  /** The latest version number of this medicine as read; a stale one is refused. */
  expectedVersion,
  reanchorReason: reason.nullable().default(null),
  withdrawLaterReason: reason.nullable().default(null),
}).meta({ id: "ChangeMedicine" });

export const CheckMedicine = z
  .object({
    outcome: z.enum(["matches_source", "differs_from_source"]),
    difference: reason.nullable().default(null),
    /** The checker compared the entry with the source document itself. */
    comparedWithSource: z.literal(true),
  })
  .meta({ id: "CheckMedicine" });

export const StopMedicine = z
  .object({
    effectiveAt: isoDateTime,
    reason,
    source: MarSourceDocument,
    expectedVersion,
    withdrawLaterReason: reason.nullable().default(null),
  })
  .meta({ id: "StopMedicine" });

const Actor = z.object({ id: uuid, at: isoDateTime });

export const MedicineEntry = z
  .object({
    id: uuid,
    medicineId: uuid,
    personId: uuid,
    version: z.number().int(),
    replacesId: uuid.nullable(),
    state: z.enum([
      "not_yet_checked",
      "checked",
      "difference_found",
      "stopped",
      "replaced",
      "withdrawn",
    ]),
    origin: z.enum(["transcribed", "reconciliation", "import"]),
    product: DmdProductRef,
    route: DmdRoute,
    directions: MarDirections,
    /** The directions in words ("2 tablets every day at 08:00"), from the domain. */
    directionsInWords: z.string(),
    indication: z.string().nullable(),
    specialInstructions: z.string().nullable(),
    prescriber: z.string(),
    startsAt: isoDateTime,
    stopsAt: isoDateTime.nullable(),
    reviewOn: ukDate.nullable(),
    source: MarSourceDocument,
    transcribed: Actor,
    secondCheck: Actor.extend({
      outcome: z.enum(["matches_source", "differs_from_source"]),
      difference: z.string().nullable(),
    }).nullable(),
    stop: Actor.extend({
      effectiveAt: isoDateTime,
      reason: z.string(),
      source: MarSourceDocument,
    }).nullable(),
    replacedById: uuid.nullable(),
    replacedFrom: isoDateTime.nullable(),
    reanchor: Actor.extend({ reason: z.string() }).nullable(),
    withdrawn: Actor.extend({ reason: z.string() }).nullable(),
    /** What the MAR says now, in words (never colour alone), and whether a dose may be given. */
    status: z.object({ words: z.string(), mayGive: z.boolean(), notice: z.string().nullable() }),
  })
  .meta({ id: "MedicineEntry" });
export type MedicineEntry = z.infer<typeof MedicineEntry>;

export const OutstandingReconciliation = z
  .object({
    kind: z.enum(["admission", "transfer", "return_from_hospital"]),
    eventId: uuid,
    at: isoDateTime,
    notice: z.string(),
  })
  .meta({ id: "OutstandingReconciliation" });

export const MedicinesRecord = z
  .object({
    /** The entries in force now or scheduled to start, one per medicine. */
    entries: z.array(MedicineEntry),
    outstandingReconciliations: z.array(OutstandingReconciliation),
    openReconciliationId: uuid.nullable(),
  })
  .meta({ id: "MedicinesRecord" });

export const MedicineHistory = z
  .object({ versions: z.array(MedicineEntry) })
  .meta({ id: "MedicineHistory" });

export const MedicineChanged = z
  .object({ entry: MedicineEntry, withdrawn: z.array(uuid) })
  .meta({ id: "MedicineChanged" });

export const MarDoseOut = z
  .object({
    medicineEntryId: uuid,
    dueAt: isoDateTime,
    date: ukDate,
    time: z.string(),
    dayName: z.string().nullable(),
    doseInWords: z.string(),
    clockChange: z.enum(["time_skipped", "time_repeated"]).nullable(),
    sameInstantAs: z.string().nullable(),
    lastDayOfShorterMonth: z.boolean(),
    /** "Before this entry was recorded: not due". */
    notDue: z.boolean(),
    /**
     * The entry's status now, in words with whether it may be given, so a chart cell never shows
     * a dose without its not-yet-checked or stopped notice (slice 16 clinical review M6; HZ-002).
     */
    entryStatus: z.object({
      words: z.string(),
      mayGive: z.boolean(),
      notice: z.string().nullable(),
    }),
  })
  .meta({ id: "MarDose" });

export const MarChart = z
  .object({
    cycle: z.object({ startsOn: ukDate, endsOn: ukDate, days: z.number().int() }),
    clockChanges: z.array(z.object({ date: ukDate, change: z.enum(["forward", "back"]) })),
    doses: z.array(MarDoseOut),
  })
  .meta({ id: "MarChart" });

export const MedicineProblem = z
  .object({ problem: z.string(), message: z.string() })
  .meta({ id: "MedicineProblem" });

// Reconciliation

export const ReconciliationTriggerKind = z
  .enum(["admission", "transfer", "return_from_hospital", "change"])
  .meta({ id: "ReconciliationTrigger" });

export const StartReconciliation = z
  .object({
    trigger: ReconciliationTriggerKind,
    /** The admission (placement) or the return from hospital it answers. */
    eventId: uuid.nullable().default(null),
    /** When a change was known (a change or a transfer); an admission or return uses its own time. */
    triggeredAt: isoDateTime.nullable().default(null),
  })
  .meta({ id: "StartReconciliation" });

export const AddReconciliationSource = z
  .object({
    kind: z.union([MarSourceKind, z.literal("person_or_family")]),
    reference: text(500),
    documentId: uuid.nullable().default(null),
    receivedAt: isoDateTime,
    currentBecause: reason.nullable().default(null),
  })
  .meta({ id: "AddReconciliationSource" });

export const AddReconciliationItem = z
  .object({
    sourceId: uuid,
    asWritten: text(2000),
    product: DmdProductRef.nullable().default(null),
    says: z.enum(["start", "continue", "change", "stop", "unclear"]),
  })
  .meta({ id: "AddReconciliationItem" });

const ids = z.array(uuid).max(50);
export const EntryDecisionInput = z
  .discriminatedUnion("kind", [
    z.object({
      kind: z.literal("continue"),
      entryId: uuid,
      itemIds: ids,
      note: reason.nullable().default(null),
      confirmedWith: reason.nullable().default(null),
      scheduledStillStands: reason.nullable().default(null),
    }),
    z.object({
      kind: z.literal("change"),
      entryId: uuid,
      itemIds: ids,
      draft: ReconciliationDraftInput,
      reanchorReason: reason.nullable().default(null),
      withdrawLaterReason: reason.nullable().default(null),
      scheduledStillStands: reason.nullable().default(null),
    }),
    z.object({
      kind: z.literal("stop"),
      entryId: uuid,
      itemIds: ids,
      reason,
      withdrawLaterReason: reason.nullable().default(null),
    }),
    z.object({ kind: z.literal("query"), entryId: uuid, question: reason }),
  ])
  .meta({ id: "EntryDecision" });

export const ItemDecisionInput = z
  .discriminatedUnion("kind", [
    z.object({
      kind: z.literal("start"),
      itemId: uuid,
      draft: ReconciliationDraftInput,
      reanchorReason: reason.nullable().default(null),
      earlierDosesDueReason: reason.nullable().default(null),
    }),
    z.object({ kind: z.literal("not_started"), itemId: uuid, reason }),
    z.object({ kind: z.literal("query"), itemId: uuid, question: reason }),
  ])
  .meta({ id: "ItemDecision" });

export const PutReconciliationDecisions = z
  .object({
    expectedVersion,
    /** Every decision so far; replaces the earlier set while the reconciliation is open. */
    entryDecisions: z.array(EntryDecisionInput).max(200),
    itemDecisions: z.array(ItemDecisionInput).max(200),
  })
  .meta({ id: "PutReconciliationDecisions" });

export const CompleteReconciliation = z
  .object({
    expectedVersion,
    allergiesCompared: z.boolean(),
    personInvolvement: z.discriminatedUnion("involved", [
      z.object({ involved: z.literal(true) }),
      z.object({ involved: z.literal(false), reason }),
    ]),
    noDischargeLetterReason: reason.nullable().default(null),
  })
  .meta({ id: "CompleteReconciliation" });

export const ReconciliationOut = z
  .object({
    id: uuid,
    personId: uuid,
    trigger: ReconciliationTriggerKind,
    eventId: uuid.nullable(),
    triggeredAt: isoDateTime,
    status: z.enum(["open", "completed"]),
    started: Actor,
    completed: Actor.nullable(),
    entriesAtStart: z.array(z.object({ entryId: uuid, version: z.number().int() })),
    sources: z.array(
      AddReconciliationSource.extend({
        id: uuid,
        documentId: uuid.nullable(),
        currentBecause: z.string().nullable(),
      }),
    ),
    items: z.array(
      z.object({
        id: uuid,
        sourceId: uuid,
        asWritten: z.string(),
        product: DmdProductRef.nullable(),
        says: z.enum(["start", "continue", "change", "stop", "unclear"]),
      }),
    ),
    entryDecisions: z.array(EntryDecisionInput),
    itemDecisions: z.array(ItemDecisionInput),
    version: z.number().int(),
  })
  .meta({ id: "MedicineReconciliation" });

export const ReconciliationRefused = z
  .object({
    issues: z.array(
      z.object({
        problem: z.string(),
        message: z.string(),
        entryId: z.string().nullable(),
        itemId: z.string().nullable(),
      }),
    ),
  })
  .meta({ id: "ReconciliationRefused" });
