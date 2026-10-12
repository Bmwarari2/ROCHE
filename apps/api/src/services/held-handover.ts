/**
 * The hand-over of held entries (care.md section 6, Device integrity part 6; HZ-004, HZ-006,
 * HZ-040): a manager signed in on the device holding another member of staff's unsent entries
 * sends them on that person's behalf, or the owner sends their own from a device a manager
 * revoked. Each entry goes to its own endpoint with `x-harbour-handover-owner` (the owner),
 * `x-harbour-handover` (an id for the hand-over) and `x-harbour-device` (the device that held it).
 *
 * The API takes it only when the owner is staff of the organisation (whatever their status now)
 * bound to that device, and the sender is the owner or holds `care.held_entry.hand_over` (step-up
 * and MFA). The entry is written as the owner's, any task it completes is judged on the owner's
 * permission when the care was recorded (never the manager's), it is flagged against the owner's
 * deletions, and `sync.entry.handed_over` records the sender, the owner, the device and the
 * hand-over. A revoked device is accepted for a hand-over: that is how its entries leave it.
 */
import { HANDOVER_ID_HEADER, HANDOVER_OWNER_HEADER } from "@harbour/contracts";
import { type Transaction, tenantUser } from "@harbour/db";
import { eq } from "drizzle-orm";
import type { Context } from "hono";
import { auditInTx } from "../http/audit";
import { type AppEnv, requirePermission, type TenantAccess } from "../http/context";
import { problems } from "../http/problem";
import { boundToDevice, inSystemView } from "./devices";

/** The permission a manager needs to send another member's held entries (step-up). */
export const HANDOVER_PERMISSION = "care.held_entry.hand_over" as const;
/** The audit action on an entry sent by a hand-over. */
export const HANDED_OVER_ACTION = "sync.entry.handed_over";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface HeldHandover {
  readonly ownerTenantUserId: string;
  readonly handoverId: string;
  /** The device that held the entries. */
  readonly deviceId: string;
  /** True when the owner sends their own (from a revoked device). */
  readonly byOwner: boolean;
}

/**
 * The hand-over a request makes, checked (see the module comment), or null when it makes none.
 * Refusals are 422 (the owner, the device or the hand-over not as they must be) or the permission's
 * own 403 (`missing_permission`, `step_up_required`, `mfa_enrolment_required`).
 */
export async function heldHandoverOf(
  c: Context<AppEnv>,
  access: TenantAccess,
): Promise<HeldHandover | null> {
  const owner = c.req.header(HANDOVER_OWNER_HEADER);
  if (owner === undefined) return null;
  const handoverId = c.req.header(HANDOVER_ID_HEADER);
  if (!UUID.test(owner) || !handoverId || !UUID.test(handoverId)) {
    throw problems.invalid("A hand-over names its owner and has an id.");
  }
  const deviceId = access.deviceId;
  if (!deviceId) throw problems.invalid("A hand-over names the device that held the entries.");
  const ownerId = owner.toLowerCase();
  const byOwner = ownerId === access.tenantUserId;
  // A manager needs the hand-over permission, with a fresh sign-in; the owner sends their own.
  if (!byOwner) await requirePermission(c, HANDOVER_PERMISSION);
  const known = await inSystemView(c.get("services").db, access, async (tx) => {
    const [member] = await tx
      .select({ id: tenantUser.id })
      .from(tenantUser)
      .where(eq(tenantUser.id, ownerId));
    return member !== undefined && (await boundToDevice(tx, deviceId, ownerId));
  });
  if (!known) {
    throw problems.invalid(
      "That member of staff has not used this device, so its entries are not theirs to hand over.",
    );
  }
  return { ownerTenantUserId: ownerId, handoverId: handoverId.toLowerCase(), deviceId, byOwner };
}

/** Records that an entry reached the server by a hand-over, in the entry's transaction. */
export async function auditHandedOver(
  tx: Transaction,
  access: TenantAccess,
  handover: HeldHandover | null,
  entry: {
    readonly resourceType: string;
    readonly id: string;
    readonly requestId: string | undefined;
  },
): Promise<void> {
  if (!handover) return;
  await auditInTx(tx, access, {
    action: HANDED_OVER_ACTION,
    resourceType: entry.resourceType,
    resourceId: entry.id,
    scope: {
      ownerTenantUserId: handover.ownerTenantUserId,
      heldOnDeviceId: handover.deviceId,
      handoverId: handover.handoverId,
      byOwner: handover.byOwner,
    },
    requestId: entry.requestId,
  });
}
