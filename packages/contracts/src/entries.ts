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
