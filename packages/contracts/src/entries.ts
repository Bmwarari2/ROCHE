import { z } from "zod";
import { StaffName } from "./staff";

/**
 * Fields every append-only point-of-care entry shares (notes, observations, body-map marks,
 * assessments, activities and visits). Internal to the contracts package: not re-exported.
 */

const uuid = z.uuid();
const isoDateTime = z.iso.datetime({ offset: true });

/**
 * The server's flag on an entry its device recorded deleting (care.md section 6, Device integrity
 * part 3; HZ-040): `uploaded_after_deletion`, it arrived after its owner's device recorded deleting
 * it; `deleted_after_upload`, it had already reached Harbour when the device recorded deleting it
 * (a reply lost on the way back). Either may be a duplicate or an entry its author meant to
 * withdraw: show it as a flag, an icon and words, and see the Registered Manager's review task.
 */
export const DeviceDeletionFlag = z
  .enum(["uploaded_after_deletion", "deleted_after_upload"])
  .meta({ id: "DeviceDeletionFlag" });
export type DeviceDeletionFlag = z.infer<typeof DeviceDeletionFlag>;

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
  /**
   * Accepted after the person left or died, for an event at or before then (people.md rule 3,
   * HZ-006); show it as recorded after the exit.
   */
  recordedAfterExit: z.boolean(),
  /** The task the entry named (for example the 02:00 turn), or null. */
  taskId: uuid.nullable(),
  /**
   * What the entry did to that task: `completed` it; kept as late evidence for a task that had
   * already been cancelled (`task_cancelled`, for example when the person went to hospital before
   * the upload: the task stays cancelled); or kept, not linked, after the task had closed or been
   * answered (`task_already_closed`) or for a task the user may not complete (`not_linked`), and
   * given to the nurse in charge to review. `medicines_conflict`: a medicines task the entry could
   * not complete, kept with an urgent conflict review; tell the user "Tell the nurse in charge now.
   * Only the person who gave a medicine records it." Show anything but `completed` as a flag, an
   * icon and words (HZ-004, HZ-006). Null when the entry named no task.
   */
  taskOutcome: z
    .enum([
      "completed",
      "task_cancelled",
      "task_already_closed",
      "not_linked",
      "medicines_conflict",
    ])
    .nullable(),
  supersedesId: uuid.nullable(),
  correctionReason: z.string().nullable(),
  /** True when a later entry supersedes this one. */
  superseded: z.boolean(),
  recordedBy: uuid.nullable(),
  /** The author's name and job title (`recordedBy`), for "Recorded by"; null when not known. */
  recordedByStaff: StaffName.nullable(),
  /**
   * Sent by: the manager who handed the entry over from a device for its author (`recordedBy`),
   * when one did (care.md section 6, Device integrity part 6). Show "Sent by" with their name
   * beside the author. Null when the author sent it.
   */
  handedOverBy: uuid.nullable(),
  /** The sender's name and job title (`handedOverBy`), for "Sent by"; null when none. */
  handedOverByStaff: StaffName.nullable(),
  /** Set when the entry's device recorded deleting it (`DeviceDeletionFlag`); null otherwise. */
  deviceDeletion: DeviceDeletionFlag.nullable(),
};

/**
 * A record entered from a paper downtime form (operations.md rules 11 and 12; HZ-009, HZ-017): the
 * outage it belongs to and the date and time as written on the form, in UK time. The entry's
 * `occurredAt` must be the instant they give. In the hour the clocks go back, say which of the two
 * times it was (`occurrence`); a time in the hour they go forward is refused. A paper time outside
 * the outage needs `outsideOutageReason`. A correction of a back-entry may leave this out: the
 * paper details are carried from the entry it corrects.
 */
export const BackEntryInput = z
  .object({
    outageId: uuid,
    /** The date written on the form (yyyy-mm-dd). */
    paperDate: z.iso.date(),
    /** The 24-hour time written on the form (hh:mm). */
    paperTime: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/),
    occurrence: z.enum(["earlier", "later"]).optional(),
    /** Why the paper time is outside the outage, when it is. */
    outsideOutageReason: z.string().trim().min(1).max(500).optional(),
    /** The form's own reference, when it has one. */
    paperReference: z.string().trim().min(1).max(80).optional(),
  })
  .strict()
  .meta({ id: "BackEntryInput" });
export type BackEntryInput = z.infer<typeof BackEntryInput>;

/**
 * The back-entry fields of the five entries a device or the web writes (notes, observations,
 * body-map marks, activities and visits). `notFromPaperReason`: an entry written later for a time
 * inside a declared outage that was not copied from a paper form says why (rule 13).
 */
export const entryDowntimeInput = {
  backEntry: BackEntryInput.optional(),
  notFromPaperReason: z.string().trim().min(1).max(500).optional(),
};

export const EntryBackEntry = z
  .object({
    outageId: uuid,
    paperDate: z.string(),
    paperTime: z.string(),
    occurrence: z.enum(["only", "earlier", "later"]),
    outsideOutageReason: z.string().nullable(),
    paperReference: z.string().nullable(),
    /**
     * Show wherever the entry appears, so it never reads as written at the time (rule 12;
     * HZ-017): the paper time, the outage, and when it was entered and received. Null when the
     * outage cannot be read.
     */
    label: z.string().nullable(),
  })
  .meta({ id: "EntryBackEntry" });
export type EntryBackEntry = z.infer<typeof EntryBackEntry>;

export const EntryNotFromPaper = z
  .object({ outageId: uuid, reason: z.string() })
  .meta({ id: "EntryNotFromPaper" });
export type EntryNotFromPaper = z.infer<typeof EntryNotFromPaper>;

/** Returned with the five entries: entered from paper, or written later and not from paper. */
export const entryDowntimeOutput = {
  backEntry: EntryBackEntry.nullable(),
  notFromPaper: EntryNotFromPaper.nullable(),
};
