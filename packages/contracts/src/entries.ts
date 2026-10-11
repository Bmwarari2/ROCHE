import { z } from "zod";

/**
 * Fields every append-only point-of-care entry shares (notes, observations, body-map marks,
 * assessments, activities and visits). Internal to the contracts package: not re-exported.
 */

const uuid = z.uuid();
const isoDateTime = z.iso.datetime({ offset: true });

/** Written by the client. */
export const entryInput = {
  /** Device-generated UUIDv7; a replayed upload with the same id is ignored. */
  id: uuid.optional(),
  occurredAt: isoDateTime,
  /** The device clock when the entry was made (for late-entry and clock-drift flags). */
  deviceTime: isoDateTime.optional(),
  supersedesId: uuid.optional(),
  correctionReason: z.string().trim().min(3).max(500).optional(),
  /** A task this entry completes (for example the 02:00 turn), as its evidence. */
  taskId: uuid.optional(),
};

/** Returned by the API. */
export const entryOutput = {
  id: uuid,
  personId: uuid,
  locationId: uuid,
  occurredAt: isoDateTime,
  recordedAt: isoDateTime,
  deviceTime: isoDateTime.nullable(),
  lateEntry: z.boolean(),
  clockDrift: z.boolean(),
  supersedesId: uuid.nullable(),
  correctionReason: z.string().nullable(),
  /** True when a later entry supersedes this one. */
  superseded: z.boolean(),
  recordedBy: uuid.nullable(),
};
