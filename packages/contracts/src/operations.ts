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
