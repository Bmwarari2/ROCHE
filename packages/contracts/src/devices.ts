import { z } from "zod";

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
  .object({ reasonCode: z.enum(DEVICE_REVOCATION_REASONS) })
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

/**
 * A care entry the API refused from a device, sent so the server keeps a copy and the nurse in
 * charge reviews it (care.md section 6, Device integrity part 5; HZ-006). The content is the
 * entry's columns as the device held them.
 */
export const SyncRefusedEntry = z
  .object({
    /** The entry's own id, made on the device: one copy each. */
    entryId: uuid,
    table: z.enum(REFUSED_ENTRY_TABLES),
    personId: uuid.nullable(),
    /** The entry's columns as the device held them; `id` and `person_id`, if present, must match. */
    payload: z.record(z.string(), z.unknown()),
    /** The refusal's HTTP status; null when the device refused it before sending. */
    httpStatus: z.number().int().min(100).max(599).nullable(),
    code: z.string().regex(/^[a-z0-9_]{1,80}$/),
    message: z.string().max(500).nullable(),
    refusedAt: isoDateTime,
  })
  .strict()
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
  .object({ items: z.array(RefusedEntryItem) })
  .meta({ id: "RefusedEntryList" });
export type RefusedEntryList = z.infer<typeof RefusedEntryList>;
