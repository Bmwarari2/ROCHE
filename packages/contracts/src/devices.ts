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
