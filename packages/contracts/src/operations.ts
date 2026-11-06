import { z } from "zod";

/**
 * Operations: the downtime pack (operations.md sections 2 and 5; OPS-028; hazard HZ-021). The
 * pack's pages are returned as the domain built them (`assembleDowntimePack`), with the freshness
 * words worked out when they are read. Times are ISO 8601 with offset.
 */

const uuid = z.uuid();
const isoDateTime = z.iso.datetime({ offset: true });

export const DowntimePackSource = z
  .enum(["server_nightly", "server_rebuild", "server_on_demand", "kiosk_cache"])
  .meta({ id: "DowntimePackSource" });

export const DowntimeFreshnessState = z
  .enum(["current", "out_of_date", "outage", "clock_behind"])
  .meta({ id: "DowntimeFreshnessState" });

export const DowntimePackOut = z
  .object({
    id: uuid,
    locationId: uuid,
    source: DowntimePackSource,
    generatedAt: isoDateTime,
    asAt: isoDateTime.meta({ description: "When its information was read" }),
    validUntil: isoDateTime.meta({ description: "After this the pack says it is out of date" }),
    generatedBy: uuid.nullable().meta({ description: "Null for the nightly job" }),
    freshness: z.object({
      state: DowntimeFreshnessState,
      notice: z.string().meta({ description: "The words at the top of every page, now" }),
      hoursOld: z.number().int(),
    }),
    /** The header lines every printed page carries (operations.md rule 2). */
    header: z.array(z.string()),
    /** Whether this request built the pack, because none was current for the people here now. */
    built: z.boolean(),
    /**
     * A build was needed and failed, so this is the latest pack there was; the header says so and
     * when it was made (#45 review round 1).
     */
    rebuildFailed: z.boolean(),
    pages: z.array(z.record(z.string(), z.unknown())).meta({
      description: "One page per person receiving care, in room order (DowntimePersonPage)",
    }),
    warnings: z.array(z.record(z.string(), z.unknown())),
  })
  .meta({
    id: "DowntimePackOut",
    description: "A location's downtime pack, with its freshness worked out now (HZ-021)",
  });
export type DowntimePackOut = z.infer<typeof DowntimePackOut>;

const place = z.string().trim().min(1).max(200);

export const SetDowntimePlaces = z
  .object({
    marLocation: place.meta({ description: "Where the paper MAR is kept, worded for the page" }),
    peepLocation: place.meta({ description: "Where the PEEPs are kept, worded for the page" }),
    /** Confirms both places in your name; changing a place without confirming leaves it unconfirmed. */
    confirm: z.boolean(),
    /** The location's version you read; a stale one is refused with 409. */
    version: z.number().int().min(1),
  })
  .meta({ id: "SetDowntimePlaces" });
export type SetDowntimePlaces = z.infer<typeof SetDowntimePlaces>;

export const DowntimePlaces = z
  .object({
    locationId: uuid,
    marLocation: z.string(),
    peepLocation: z.string(),
    confirmedAt: isoDateTime.nullable(),
    confirmedBy: uuid.nullable(),
    version: z.number().int(),
  })
  .meta({
    id: "DowntimePlaces",
    description:
      "Where a location keeps the paper MAR and the PEEPs (location settings downtime.mar_location and downtime.peep_location); unconfirmed places print as not set (H-201)",
  });
export type DowntimePlaces = z.infer<typeof DowntimePlaces>;

// ------------------------------------------------------------------------------------------------
// Outages (operations.md rules 9 to 15; HZ-017)
// ------------------------------------------------------------------------------------------------

export const OutageKind = z
  .enum([
    "power",
    "network",
    "harbour_unavailable",
    "device_failure",
    "planned_maintenance",
    "other",
  ])
  .meta({ id: "OutageKind" });

export const OutageItem = z
  .object({
    id: uuid,
    locationId: uuid,
    kind: OutageKind,
    description: z.string(),
    state: z.enum(["declared", "closed", "reconciled", "cancelled"]),
    startedAt: isoDateTime,
    endedAt: isoDateTime.nullable(),
    declaredAt: isoDateTime,
    declaredBy: uuid,
    declaredLate: z.boolean(),
    closedAt: isoDateTime.nullable(),
    closedBy: uuid.nullable(),
    backEntryDueAt: isoDateTime.nullable(),
    reconciledAt: isoDateTime.nullable(),
    reconciledBy: uuid.nullable(),
    reconciliationStatement: z.string().nullable(),
    formsEntered: z.number().int().nullable(),
    cancelledAt: isoDateTime.nullable(),
    cancelledBy: uuid.nullable(),
    cancellationReason: z.string().nullable(),
    correctionReason: z.string().nullable(),
    version: z.number().int(),
  })
  .meta({ id: "OutageItem", description: "An outage at a location and where its workflow stands" });
export type OutageItem = z.infer<typeof OutageItem>;

export const OutageList = z.object({ items: z.array(OutageItem) }).meta({ id: "OutageList" });

const words = (max: number) => z.string().trim().min(1).max(max);
/** The version the change is based on; a stale one is refused with 409. */
const version = z.number().int().min(1);

export const DeclareOutage = z
  .object({
    kind: OutageKind,
    description: words(1000),
    startedAt: isoDateTime,
    /** When declaring an outage after it ended. */
    endedAt: isoDateTime.optional(),
  })
  .meta({ id: "DeclareOutage" });
export type DeclareOutage = z.infer<typeof DeclareOutage>;

export const CloseOutage = z
  .object({ endedAt: isoDateTime.meta({ description: "When systems came back" }), version })
  .meta({ id: "CloseOutage" });

export const ReconcileOutage = z
  .object({
    statement: words(2000).meta({ description: "What was checked" }),
    /**
     * Every entry in the possible duplicates and every back-entry outside the window with no
     * reason, once reviewed (kept, or corrected by supersession).
     */
    reviewedEntryIds: z.array(uuid).max(1000),
    version,
  })
  .meta({ id: "ReconcileOutage" });

export const CancelOutage = z.object({ reason: words(1000), version }).meta({ id: "CancelOutage" });

export const CorrectOutage = z
  .object({
    startedAt: isoDateTime,
    /** Null only for an outage still open, which stays open. */
    endedAt: isoDateTime.nullable(),
    reason: words(500),
    version,
  })
  .meta({ id: "CorrectOutage" });

/**
 * One entry to review before reconciling (H-267, HZ-092): who it is about, what kind of record and
 * when, so the reviewer can find it, with no text or values of the entry. `person` is null when the
 * reader cannot see that person (counted in the organisation's view, rule 14): the web then says
 * so and offers no link.
 */
export const ReconcileEntry = z
  .object({
    id: uuid,
    personId: uuid,
    person: z
      .object({
        givenName: z.string(),
        familyName: z.string(),
        preferredName: z.string().nullable(),
      })
      .nullable(),
    /** The record's kind: `care_note`, `observation.<chart>`, `body_map_mark`, `activity_record`, `visit_log`. */
    kind: z.string(),
    occurredAt: isoDateTime,
    source: z.enum(["back_entry", "digital"]),
    paperReference: z.string().nullable(),
  })
  .meta({ id: "ReconcileEntry" });
export type ReconcileEntry = z.infer<typeof ReconcileEntry>;

export const OutageReconciliation = z
  .object({
    outage: OutageItem,
    backEntries: z.number().int(),
    formsEntered: z.number().int(),
    entriesWithoutReference: z.number().int(),
    outsideWindow: z.number().int(),
    people: z.number().int(),
    digitalEntriesInWindow: z.number().int(),
    /** Entry ids that may be the same care recorded twice; review each before reconciling. */
    duplicateGroups: z.array(z.array(uuid)),
    /** Back-entries outside the window with no reason for it; review each before reconciling. */
    outsideWindowEntryIds: z.array(uuid),
    /** Every entry in `duplicateGroups` and `outsideWindowEntryIds`, with its person, kind and time. */
    reviewEntries: z.array(ReconcileEntry),
    /** Whether you entered or sent any of its paper records, so cannot reconcile it (H-203). */
    enteredByYou: z.boolean(),
    /** What stops reconciling now, in words; empty when only the statement is needed. */
    blockers: z.array(z.string()),
  })
  .meta({ id: "OutageReconciliation" });
export type OutageReconciliation = z.infer<typeof OutageReconciliation>;
