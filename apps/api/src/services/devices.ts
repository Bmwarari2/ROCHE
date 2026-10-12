/**
 * Care mode devices (care.md section 6, Device integrity; hazards HZ-010, HZ-011 and HZ-040).
 *
 * Part 1, binding: `device_binding` records which member of staff has used which device (the
 * PowerSync client id), written by the sync token route and by a device report from the device, in
 * the system's view. A hold report's named owner counts only when bound to the device, and the
 * earliest first sighting of a device floors a hold's start. These replace reads of the audit
 * trail.
 *
 * Part 2, revocation: a manager holding `platform.device.revoke` (step-up) revokes a lost or
 * withdrawn device with a coded reason; every binding of the device is marked, and the sync token
 * and upload routes then refuse the device with 403 `device_revoked`, each refusal audited. A
 * location role reaches only devices used by staff whose live, or else most recent, located role
 * assignment is at one of its locations; anything else reads as not found.
 */
import type { DeviceBindingItem, DeviceRevocationReason } from "@harbour/contracts";
import {
  deviceBinding,
  roleAssignment,
  type Transaction,
  tenantUser,
  withRequestContext,
} from "@harbour/db";
import { and, asc, desc, eq, inArray, isNotNull, isNull, sql } from "drizzle-orm";
import { auditInTx, writeAudit } from "../http/audit";
import type { Services, TenantAccess } from "../http/context";
import { problems } from "../http/problem";

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

/** True when a manager has revoked the device (part 2). */
export async function deviceRevoked(tx: Transaction, deviceId: string): Promise<boolean> {
  const [row] = await tx
    .select({ id: deviceBinding.id })
    .from(deviceBinding)
    .where(and(eq(deviceBinding.deviceId, deviceId), isNotNull(deviceBinding.revokedAt)))
    .limit(1);
  return row !== undefined;
}

/** The audit action of a request refused because its device was revoked. */
export const DEVICE_REFUSED_ACTION = "sync.device.refused_revoked";
/** The audit action of a revocation. */
export const DEVICE_REVOKED_ACTION = "platform.device.revoked";

/**
 * Refuses the request with 403 `device_revoked` when the device it names has been revoked, after
 * auditing the refusal in its own transaction (it must be kept although the request fails). A
 * request that names no device is not a device's request and passes.
 */
export async function refuseRevokedDevice(
  services: Pick<Services, "db" | "appPool">,
  access: TenantAccess,
  route: string,
  requestId: string | undefined,
): Promise<void> {
  const deviceId = access.deviceId;
  if (!deviceId) return;
  if (!(await inSystemView(services.db, access, (tx) => deviceRevoked(tx, deviceId)))) return;
  await writeAudit(services.appPool, access, {
    action: DEVICE_REFUSED_ACTION,
    outcome: "denied",
    resourceType: "device",
    resourceId: deviceId,
    reason: "device_revoked",
    scope: { route },
    requestId,
  });
  throw problems.deviceRevoked();
}

/**
 * The locations each member works at, for a manager's reach (part 2): their live located role
 * assignments, or else the location of their most recent one (staff who have left keep the home
 * they last worked at). Organisation-wide assignments name no location.
 */
export async function memberLocations(
  tx: Transaction,
  memberIds: readonly string[],
  now: Date,
): Promise<Map<string, string[]>> {
  const result = new Map<string, string[]>();
  if (memberIds.length === 0) return result;
  const rows = await tx
    .select({
      tenantUserId: roleAssignment.tenantUserId,
      locationId: roleAssignment.locationId,
      validFrom: roleAssignment.validFrom,
      validTo: roleAssignment.validTo,
      deletedAt: roleAssignment.deletedAt,
      updatedAt: roleAssignment.updatedAt,
    })
    .from(roleAssignment)
    .where(
      and(
        inArray(roleAssignment.tenantUserId, [...memberIds]),
        isNotNull(roleAssignment.locationId),
      ),
    );
  type Row = (typeof rows)[number];
  const live = (r: Row) =>
    r.deletedAt === null &&
    r.validFrom.getTime() <= now.getTime() &&
    (r.validTo === null || r.validTo.getTime() > now.getTime());
  const ended = (r: Row) =>
    Math.min(
      (r.deletedAt ?? r.updatedAt).getTime(),
      r.validTo?.getTime() ?? Number.POSITIVE_INFINITY,
    );
  for (const id of memberIds) {
    const own = rows.filter((r) => r.tenantUserId === id);
    const current = [...new Set(own.filter(live).map((r) => r.locationId as string))];
    if (current.length > 0) {
      result.set(id, current.sort());
      continue;
    }
    const recent = [...own].sort((a, b) => ended(b) - ended(a))[0];
    result.set(id, recent?.locationId ? [recent.locationId] : []);
  }
  return result;
}

/**
 * The members whose devices a manager reaches: a tenant-wide role reaches everyone; a location
 * role only staff working, or who last worked, at one of its locations.
 */
export async function reachedMembers(
  tx: Transaction,
  access: TenantAccess,
  memberIds: readonly string[],
  now: Date,
): Promise<Set<string>> {
  if (access.effective.scope === "tenant") return new Set(memberIds);
  const mine = new Set(access.effective.scope === "locations" ? access.effective.locationIds : []);
  const where = await memberLocations(tx, memberIds, now);
  return new Set(memberIds.filter((id) => (where.get(id) ?? []).some((l) => mine.has(l))));
}

/** At most this many bindings are listed. */
const DEVICE_LIST_LIMIT = 500;

/** The devices staff have used, newest sighting first, that the manager reaches (part 2). */
export async function listDevices(
  db: Db,
  access: TenantAccess,
  filter: { readonly tenantUserId?: string | undefined },
  now: Date,
): Promise<DeviceBindingItem[]> {
  return inSystemView(db, access, async (tx) => {
    const rows = await tx
      .select({
        deviceId: deviceBinding.deviceId,
        tenantUserId: deviceBinding.tenantUserId,
        memberName: tenantUser.displayName,
        firstSeenAt: deviceBinding.firstSeenAt,
        lastSeenAt: deviceBinding.lastSeenAt,
        revokedAt: deviceBinding.revokedAt,
        revokedBy: deviceBinding.revokedBy,
        revocationReason: deviceBinding.revocationReason,
      })
      .from(deviceBinding)
      .innerJoin(tenantUser, eq(tenantUser.id, deviceBinding.tenantUserId))
      .where(filter.tenantUserId ? eq(deviceBinding.tenantUserId, filter.tenantUserId) : undefined)
      .orderBy(desc(deviceBinding.lastSeenAt), asc(deviceBinding.deviceId))
      .limit(DEVICE_LIST_LIMIT);
    const reached = await reachedMembers(
      tx,
      access,
      [...new Set(rows.map((r) => r.tenantUserId))],
      now,
    );
    return rows
      .filter((r) => reached.has(r.tenantUserId))
      .map((r) => ({
        deviceId: r.deviceId,
        tenantUserId: r.tenantUserId,
        memberName: r.memberName,
        firstSeenAt: r.firstSeenAt.toISOString(),
        lastSeenAt: r.lastSeenAt.toISOString(),
        revokedAt: r.revokedAt?.toISOString() ?? null,
        revokedBy: r.revokedBy,
        revocationReason: (r.revocationReason as DeviceRevocationReason | null) ?? null,
      }));
  });
}

/**
 * Revokes a device (part 2): every binding of the device not yet revoked is marked with the
 * manager, the time and the coded reason, and the revocation is audited. Null when the manager does
 * not reach anyone who used the device (or it was never seen here), which the route answers as not
 * found. A device already revoked changes nothing and says so.
 */
export async function revokeDevice(
  db: Db,
  access: TenantAccess,
  input: {
    readonly deviceId: string;
    readonly reasonCode: DeviceRevocationReason;
    readonly now: Date;
    readonly requestId: string | undefined;
  },
): Promise<{ revokedAt: Date; replay: boolean; bindings: number } | null> {
  return inSystemView(db, access, async (tx) => {
    await tx.execute(
      sql`SELECT pg_advisory_xact_lock(hashtext(${`${access.tenantId}:device_revoke:${input.deviceId}`}))`,
    );
    const rows = await tx
      .select({ tenantUserId: deviceBinding.tenantUserId, revokedAt: deviceBinding.revokedAt })
      .from(deviceBinding)
      .where(eq(deviceBinding.deviceId, input.deviceId));
    const members = [...new Set(rows.map((r) => r.tenantUserId))].sort();
    if ((await reachedMembers(tx, access, members, input.now)).size === 0) return null;
    const earliest = rows
      .map((r) => r.revokedAt)
      .filter((at): at is Date => at !== null)
      .sort((a, b) => a.getTime() - b.getTime())[0];
    if (earliest && rows.every((r) => r.revokedAt !== null)) {
      return { revokedAt: earliest, replay: true, bindings: rows.length };
    }
    await tx
      .update(deviceBinding)
      .set({
        revokedAt: input.now,
        revokedBy: access.tenantUserId,
        revocationReason: input.reasonCode,
      })
      .where(and(eq(deviceBinding.deviceId, input.deviceId), isNull(deviceBinding.revokedAt)));
    await auditInTx(tx, access, {
      action: DEVICE_REVOKED_ACTION,
      resourceType: "device",
      resourceId: input.deviceId,
      reason: input.reasonCode,
      scope: { reasonCode: input.reasonCode, bindings: rows.length, memberIds: members },
      requestId: input.requestId,
    });
    return { revokedAt: earliest ?? input.now, replay: false, bindings: rows.length };
  });
}
