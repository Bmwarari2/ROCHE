/**
 * Care mode devices (care.md section 6, Device integrity; hazards HZ-010, HZ-011 and HZ-040).
 *
 * Part 1, binding: `device_binding` records which member of staff has used which device (the
 * PowerSync client id), written by the sync token route and by a device report from the device, in
 * the system's view. A hold report's named owner counts only when bound to the device, and the
 * earliest first sighting of a device floors a hold's start. These replace reads of the audit
 * trail.
 */
import { deviceBinding, type Transaction, withRequestContext } from "@harbour/db";
import { and, eq, sql } from "drizzle-orm";
import type { TenantAccess } from "../http/context";

type Db = Parameters<typeof withRequestContext>[0];

/** Runs `fn` in the system's view of the tenant (tenant scope), acting for the request's member. */
export function inSystemView<T>(
  db: Db,
  access: TenantAccess,
  fn: (tx: Transaction) => Promise<T>,
): Promise<T> {
  return withRequestContext(
    db,
    { tenantId: access.tenantId, userId: access.tenantUserId, scope: "tenant", locationIds: [] },
    fn,
  );
}

/**
 * Records that the member used the device now: a new binding, or the existing one's last sighting
 * moved on (never back). Call in the system's view (tenant scope): row-level security lets no one
 * else write a binding.
 */
export async function bindDevice(
  tx: Transaction,
  deviceId: string,
  tenantUserId: string,
  now: Date,
): Promise<void> {
  await tx
    .insert(deviceBinding)
    .values({ deviceId, tenantUserId, firstSeenAt: now, lastSeenAt: now })
    .onConflictDoUpdate({
      target: [deviceBinding.tenantId, deviceBinding.deviceId, deviceBinding.tenantUserId],
      set: { lastSeenAt: sql`greatest(${deviceBinding.lastSeenAt}, excluded.last_seen_at)` },
    });
}

/**
 * True when the member is bound to the device: a sync token was issued to it in their session, or
 * they sent a report from it (security review round 7, M1). A revoked binding still counts: it
 * proves they used the device.
 */
export async function boundToDevice(
  tx: Transaction,
  deviceId: string,
  tenantUserId: string,
): Promise<boolean> {
  const [row] = await tx
    .select({ id: deviceBinding.id })
    .from(deviceBinding)
    .where(and(eq(deviceBinding.deviceId, deviceId), eq(deviceBinding.tenantUserId, tenantUserId)))
    .limit(1);
  return row !== undefined;
}

/** When the server first saw the device, with anyone; null when it never has. */
export async function deviceFirstSeen(tx: Transaction, deviceId: string): Promise<Date | null> {
  const [row] = await tx
    .select({ at: sql<Date | string | null>`min(${deviceBinding.firstSeenAt})` })
    .from(deviceBinding)
    .where(eq(deviceBinding.deviceId, deviceId));
  return row?.at ? new Date(row.at) : null;
}
