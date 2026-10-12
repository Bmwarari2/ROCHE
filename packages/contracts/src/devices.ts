import { z } from "zod";
import { CreateBodyMapMark, CreateCareNote, CreateObservation } from "./care";
import { CreateActivityRecord, CreateVisit } from "./care-planning";

/**
 * Care mode devices (care.md section 6, Device integrity): which member has used which device, a
 * manager's revocation of a lost or withdrawn device, and the signal that tells a revoked device.
 */

const uuid = z.uuid();
const isoDateTime = z.iso.datetime({ offset: true });

/**
 * The problem code a revoked device gets (403) from the sync token and upload routes, distinct
 * from an expired session (401) and from `not_a_member`, `mfa_enrolment_required` and
 * `step_up_required`. The device wipes, keeping unsent entries under the hold rules.
 */
export const DEVICE_REVOKED_CODE = "device_revoked";

/**
 * Headers of a hand-over of held entries (care.md section 6, Device integrity part 6): the owner
 * whose entries a manager (or the owner, on a revoked device) is sending, and an id for the
 * hand-over. The device that held them is `x-harbour-device`.
 */
export const HANDOVER_OWNER_HEADER = "x-harbour-handover-owner";
export const HANDOVER_ID_HEADER = "x-harbour-handover";

/**
 * The problem code (422) of a hand-over the server will not take as sent (care.md section 6, Device
 * integrity part 6): the sender has not used the device, the device has no open hold for that
 * owner, the hold's reported count is used up, the entry falls outside the owner's time on the
 * device, the person was never in the owner's care, or the hand-over id names someone else. The
 * device stops and keeps the entry held; it is never parked as refused.
 */
export const HANDOVER_REFUSED_CODE = "handover_refused";

/**
 * The problem code (409) of a revocation asked for without confirming that the device last
 * reported entries waiting (`confirmEntriesWaiting`): the screen warns with the count first.
 */
export const ENTRIES_WAITING_CODE = "entries_waiting";

/** The hand-over headers of a care entry upload, as the OpenAPI document describes them. */
export const HandoverHeaders = z.object({
  [HANDOVER_OWNER_HEADER]: uuid.optional().meta({
    description:
      "A hand-over of held entries: whose entries they are (tenant_user id). Needs care.held_entry.hand_over (step-up) unless the caller is the owner.",
  }),
  [HANDOVER_ID_HEADER]: uuid.optional().meta({
    description: "A hand-over of held entries: its id, made on the device, one owner per id.",
  }),
});

/** Why a manager revoked a device: a code, never words. */
export const DEVICE_REVOCATION_REASONS = [
  "lost_or_stolen",
  "staff_left",
  "access_withdrawn",
  "replaced",
  "other",
] as const;
export type DeviceRevocationReason = (typeof DEVICE_REVOCATION_REASONS)[number];

export const DeviceBindingItem = z
  .object({
    /** The device's opaque id (its database's sync client id). */
    deviceId: uuid,
    tenantUserId: uuid,
    /** The member of staff's display name, for the manager choosing the device. */
    memberName: z.string(),
    firstSeenAt: isoDateTime,
    lastSeenAt: isoDateTime,
    revokedAt: isoDateTime.nullable(),
    revokedBy: uuid.nullable(),
    revocationReason: z.enum(DEVICE_REVOCATION_REASONS).nullable(),
    /**
     * Entries the device last reported waiting (held, unsent, blocked, or refused with no server
     * copy); 0 when none.
     */
    entriesWaiting: z.number().int().min(0),
    /** When the device last reported, so an old count reads as old; null when it never has. */
    lastReportedAt: isoDateTime.nullable(),
  })
  .meta({
    id: "DeviceBindingItem",
    description: "A member of staff's use of a Care mode device, and whether it is revoked",
  });
export type DeviceBindingItem = z.infer<typeof DeviceBindingItem>;

export const DeviceBindingList = z
  .object({ items: z.array(DeviceBindingItem) })
  .meta({ id: "DeviceBindingList" });
export type DeviceBindingList = z.infer<typeof DeviceBindingList>;

export const RevokeDevice = z
  .object({
    reasonCode: z.enum(DEVICE_REVOCATION_REASONS),
    /**
     * True once the manager has been told how many entries the device last reported waiting; a
     * revocation of a device with entries waiting is refused (409 `entries_waiting`) without it.
     */
    confirmEntriesWaiting: z.boolean().optional(),
  })
  .strict()
  .meta({ id: "RevokeDevice" });
export type RevokeDevice = z.infer<typeof RevokeDevice>;

export const RevokeDeviceResult = z
  .object({
    deviceId: uuid,
    revokedAt: isoDateTime,
    /** True when the device had already been revoked: nothing changed. */
    replay: z.boolean(),
    /** How many members' bindings the revocation covers. */
    bindings: z.number().int().min(0),
    /** Entries the device last reported waiting; its hold's task is due at once when any are. */
    entriesWaiting: z.number().int().min(0),
    /** When the device last reported; null when it never has. */
    lastReportedAt: isoDateTime.nullable(),
  })
  .meta({ id: "RevokeDeviceResult" });
export type RevokeDeviceResult = z.infer<typeof RevokeDeviceResult>;

/** The tables a device writes care entries to: a refused one is copied to the server. */
export const REFUSED_ENTRY_TABLES = [
  "care_note",
  "observation",
  "body_map_mark",
  "activity_record",
  "visit_log",
] as const;

const refusedCopy = {
  /** The entry's own id, made on the device: one copy each. */
  entryId: uuid,
  personId: uuid.nullable(),
  /** The refusal's HTTP status; null when the device refused it before sending. */
  httpStatus: z.number().int().min(100).max(599).nullable(),
  code: z.string().regex(/^[a-z0-9_]{1,80}$/),
  message: z.string().max(500).nullable(),
  refusedAt: isoDateTime,
};

/**
 * A care entry the API refused from a device, sent so the server keeps a copy and the nurse in
 * charge reviews it (care.md section 6, Device integrity part 5; HZ-006). The content is the
 * request the device made for the entry, checked against that entry kind's own contract (#25
 * review round 2, M2); its `id`, if present, must be the entry's.
 */
export const SyncRefusedEntry = z
  .discriminatedUnion("table", [
    z
      .object({ ...refusedCopy, table: z.literal("care_note"), payload: CreateCareNote.strict() })
      .strict(),
    z
      .object({
        ...refusedCopy,
        table: z.literal("observation"),
        payload: CreateObservation.strict(),
      })
      .strict(),
    z
      .object({
        ...refusedCopy,
        table: z.literal("body_map_mark"),
        payload: CreateBodyMapMark.strict(),
      })
      .strict(),
    z
      .object({
        ...refusedCopy,
        table: z.literal("activity_record"),
        payload: CreateActivityRecord.strict(),
      })
      .strict(),
    z
      .object({ ...refusedCopy, table: z.literal("visit_log"), payload: CreateVisit.strict() })
      .strict(),
  ])
  .meta({ id: "SyncRefusedEntry" });
export type SyncRefusedEntry = z.infer<typeof SyncRefusedEntry>;

export const SyncRefusedEntryResult = z
  .object({
    id: uuid,
    entryId: uuid,
    /** The review task the copy joined. */
    taskId: uuid.nullable(),
    /** True when the server already had this copy. */
    replay: z.boolean(),
  })
  .meta({ id: "SyncRefusedEntryResult" });
export type SyncRefusedEntryResult = z.infer<typeof SyncRefusedEntryResult>;

export const RefusedEntryItem = z
  .object({
    id: uuid,
    entryId: uuid,
    table: z.enum(REFUSED_ENTRY_TABLES),
    personId: uuid.nullable(),
    locationId: uuid.nullable(),
    /** The entry as the device held it: read it as the device's record, not the care record. */
    payload: z.record(z.string(), z.unknown()),
    httpStatus: z.number().int().nullable(),
    code: z.string(),
    message: z.string().nullable(),
    refusedAt: isoDateTime,
    receivedAt: isoDateTime,
    authorTenantUserId: uuid,
    /** Who sent the copy: the author, or a manager handing over their entries. */
    sentByTenantUserId: uuid.nullable(),
    deviceId: uuid.nullable(),
    reviewTaskId: uuid.nullable(),
  })
  .meta({
    id: "RefusedEntryItem",
    description: "The server's copy of an entry a device could not save",
  });
export type RefusedEntryItem = z.infer<typeof RefusedEntryItem>;

export const RefusedEntryList = z
  .object({
    items: z.array(RefusedEntryItem),
    /** Pass as `before` for the next page; null on the last. */
    nextBefore: uuid.nullable(),
  })
  .meta({ id: "RefusedEntryList" });
export type RefusedEntryList = z.infer<typeof RefusedEntryList>;
