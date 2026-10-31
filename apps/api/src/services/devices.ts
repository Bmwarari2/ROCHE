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
 * and upload routes then refuse the device with 403 `device_revoked` (audited at most once an hour
 * per device). The sessions bound to it stay (a device that gets a 401 cannot tell it was
 * revoked), but every request from one is refused with 403 `device_revoked` whatever device it
 * names, except its report, which may raise or hurry its task but never close it (#25 review rounds
 * 2 and 3, M1 and M2). A location role
 * reaches only devices used by staff whose live, or else most recent, located role assignment is at
 * one of its locations, and revokes only a device every member bound to it is such staff; anything
 * it reaches nobody on reads as not found.
 */
import type { DeviceBindingItem, DeviceRevocationReason } from "@harbour/contracts";
import {
  auditEvent,
  deviceBinding,
  deviceSession,
  featureFlag,
  roleAssignment,
  type Transaction,
  tenantUser,
  withRequestContext,
} from "@harbour/db";
import {
  CARE_MODE_FLAG,
  evaluateFlag,
  type Permission,
  PORTAL_ONLY_PERMISSIONS,
  scopeFor,
} from "@harbour/domain";
import { isValidWindowDays, OFFLINE_WINDOW_RATE_KEY } from "@harbour/sync/streams";
import { and, asc, desc, eq, gt, inArray, isNotNull, isNull, sql } from "drizzle-orm";
import { auditInTx, writeAudit } from "../http/audit";
import type { Services, TenantAccess } from "../http/context";
import { HttpProblem, problems } from "../http/problem";
import { rateNumber } from "./rates";

type Db = Parameters<typeof withRequestContext>[0];

/**
 * The permission point-of-care entries are written under (notes, charts, body-map marks,
 * activities and visits: `entryWriteAccess`), so the one a copy's or a hand-over's author must have
 * held for the person (`personReachedBy`).
 */
export const ENTRY_PERMISSION: Permission = "care.note.write";

/** The portal-only permissions as a SQL array, for leaving out roles that mix them with staff's. */
const PORTAL_ONLY_ARRAY = sql`ARRAY[${sql.join(
  PORTAL_ONLY_PERMISSIONS.map((p) => sql`${p}`),
  sql`, `,
)}]::text[]`;

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

/** The device's revocation (the earliest), or null while it is not revoked. */
async function revocationOf(
  tx: Transaction,
  deviceId: string,
): Promise<{ revokedAt: Date; revokedBy: string; revocationReason: string } | null> {
  const [row] = await tx
    .select({
      revokedAt: deviceBinding.revokedAt,
      revokedBy: deviceBinding.revokedBy,
      revocationReason: deviceBinding.revocationReason,
    })
    .from(deviceBinding)
    .where(and(eq(deviceBinding.deviceId, deviceId), isNotNull(deviceBinding.revokedAt)))
    .orderBy(asc(deviceBinding.revokedAt))
    .limit(1);
  return row?.revokedAt && row.revokedBy && row.revocationReason
    ? { revokedAt: row.revokedAt, revokedBy: row.revokedBy, revocationReason: row.revocationReason }
    : null;
}

/**
 * Records that the member used the device now: a new binding, or the existing one's last sighting
 * moved on (never back), and the session that did so (part 2). On a revoked device a new binding
 * is revoked with the rest, so the device stays revoked as a whole, and no session is bound: a
 * revocation ends the sessions bound before it, and a sign-in afterwards is a hand-over's or a
 * report's. Call in the system's view (tenant scope): row-level security lets no one else write.
 */
export async function bindDevice(
  tx: Transaction,
  deviceId: string,
  tenantUserId: string,
  now: Date,
  sessionId: string | null = null,
): Promise<void> {
  const revocation = await revocationOf(tx, deviceId);
  await tx
    .insert(deviceBinding)
    .values({ deviceId, tenantUserId, firstSeenAt: now, lastSeenAt: now, ...(revocation ?? {}) })
    .onConflictDoUpdate({
      target: [deviceBinding.tenantId, deviceBinding.deviceId, deviceBinding.tenantUserId],
      set: { lastSeenAt: sql`greatest(${deviceBinding.lastSeenAt}, excluded.last_seen_at)` },
    });
  if (!revocation && sessionId) {
    await tx
      .insert(deviceSession)
      .values({ deviceId, tenantUserId, sessionId, boundAt: now })
      .onConflictDoNothing();
  }
}

/**
 * True when the session was bound to a device a manager has since revoked (#25 review round 2,
 * M1): the API refuses every request from it, whatever device it names. Reads the member's own
 * rows, so it runs in the member's own view.
 */
export async function sessionOnRevokedDevice(tx: Transaction, sessionId: string): Promise<boolean> {
  const [row] = await tx
    .select({ id: deviceSession.id })
    .from(deviceSession)
    .innerJoin(
      deviceBinding,
      and(
        eq(deviceBinding.tenantId, deviceSession.tenantId),
        eq(deviceBinding.deviceId, deviceSession.deviceId),
        eq(deviceBinding.tenantUserId, deviceSession.tenantUserId),
      ),
    )
    .where(and(eq(deviceSession.sessionId, sessionId), isNotNull(deviceBinding.revokedAt)))
    .limit(1);
  return row !== undefined;
}

/**
 * Binds the session to the device on any request that names it (#25 review round 3, M2), so a
 * session that never asked for a sync token is covered too: the member's binding when they have
 * none (first and last seen now), and the session. Nothing on a revoked device. Writes only what is
 * missing; call in the system's view acting for the member.
 */
export async function bindSession(
  tx: Transaction,
  deviceId: string,
  tenantUserId: string,
  sessionId: string,
  now: Date,
): Promise<void> {
  if (await revocationOf(tx, deviceId)) return;
  await tx
    .insert(deviceBinding)
    .values({ deviceId, tenantUserId, firstSeenAt: now, lastSeenAt: now })
    .onConflictDoNothing();
  await tx
    .insert(deviceSession)
    .values({ deviceId, tenantUserId, sessionId, boundAt: now })
    .onConflictDoNothing();
}

/** The member's binding to the device: when first seen there, and any revocation. */
export async function bindingOf(
  tx: Transaction,
  deviceId: string,
  tenantUserId: string,
): Promise<{ firstSeenAt: Date; revokedAt: Date | null } | null> {
  const [row] = await tx
    .select({ firstSeenAt: deviceBinding.firstSeenAt, revokedAt: deviceBinding.revokedAt })
    .from(deviceBinding)
    .where(and(eq(deviceBinding.deviceId, deviceId), eq(deviceBinding.tenantUserId, tenantUserId)))
    .limit(1);
  return row ?? null;
}

/** The offline window in days from the rate table (a day when it is missing or out of range). */
export async function offlineWindowDaysOf(tx: Transaction, tenantId: string): Promise<number> {
  const days = await rateNumber(tx, tenantId, OFFLINE_WINDOW_RATE_KEY).catch(() => null);
  return isValidWindowDays(days) ? days : 1;
}

/**
 * True when the member could act on the person with `permission` at some time in `[since, until]`
 * (#25 review rounds 2 and 3): assigned to them while a role scoped to assigned people carried the
 * permission (ADR-0071 review round 1, S-M1), or holding the permission there by a role scoped to
 * the organisation (at the person's location when assigned at one; L2), a location role at the
 * person's location or marked organisation-wide, or a grant for there or marked
 * organisation-wide (L1), in force then (an assignment, role or grant ended or deleted since
 * counts up to its end; a revoked grant or an archived role never counts, and an assignment
 * counts only while the role was in force with it; review round 2). Only the roles
 * and grants carrying the permission count, never another role's reach (ADR-0071), and a role
 * mixing portal and staff permissions gives none. A break-glass record never counts: it opens
 * reading only. For an entry the window runs back from the entry's own time, so an owner
 * whose access ended after the entry was written still counts. Call in the system's view. False
 * for a person who does not exist, so a refusal never says which.
 */
export async function personReachedBy(
  tx: Transaction,
  tenantUserId: string,
  personId: string,
  since: Date,
  until: Date,
  permission: Permission,
): Promise<boolean> {
  const result = await tx.execute<{ reached: boolean }>(sql`
    SELECT EXISTS (
      SELECT 1 FROM public.person p
      WHERE p.id = ${personId} AND (
        EXISTS (
          -- The assignment and a role scoped to assigned people carrying the permission were in
          -- force together at some time in the window (review round 2).
          SELECT 1 FROM public.person_assignment pa
          JOIN public.role_assignment ra
            ON ra.tenant_user_id = pa.tenant_user_id AND ra.tenant_id = pa.tenant_id
          JOIN public.role r ON r.id = ra.role_id AND r.tenant_id = ra.tenant_id
          WHERE pa.person_id = p.id AND pa.tenant_user_id = ${tenantUserId}
            AND r.archived_at IS NULL
            AND ${permission} = ANY (r.permissions)
            AND NOT (r.permissions && ${PORTAL_ONLY_ARRAY})
            AND r.scope_kind IN ('assigned', 'self')
            AND greatest(pa.valid_from, ra.valid_from, ${since}::timestamptz)
              <= least(
                coalesce(least(pa.valid_to, pa.deleted_at), 'infinity'::timestamptz),
                coalesce(least(ra.valid_to, ra.deleted_at), 'infinity'::timestamptz),
                ${until}::timestamptz))
        OR EXISTS (
          SELECT 1 FROM public.role_assignment ra
          JOIN public.role r ON r.id = ra.role_id AND r.tenant_id = ra.tenant_id
          WHERE ra.tenant_user_id = ${tenantUserId}
            AND r.archived_at IS NULL
            AND ra.valid_from <= ${until}
            AND coalesce(least(ra.valid_to, ra.deleted_at), 'infinity'::timestamptz) >= ${since}
            AND ${permission} = ANY (r.permissions)
            AND NOT (r.permissions && ${PORTAL_ONLY_ARRAY})
            AND r.scope_kind IN ('tenant', 'location')
            AND (ra.location_id = p.location_id
              OR (ra.location_id IS NULL
                AND (r.scope_kind = 'tenant' OR ra.organisation_wide))))
        OR EXISTS (
          SELECT 1 FROM public.access_grant g
          WHERE g.tenant_user_id = ${tenantUserId}
            AND ${permission} = ANY (g.permissions)
            AND g.revoked_at IS NULL
            AND g.valid_from <= ${until}
            AND coalesce(least(g.valid_to, g.deleted_at), 'infinity'::timestamptz) >= ${since}
            AND (g.location_id = p.location_id
              OR (g.location_id IS NULL AND g.organisation_wide)))
      )
    ) AS reached`);
  return result.rows[0]?.reached === true;
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

/** A revoked device's refusals are audited at most once in this many milliseconds. */
const REFUSAL_AUDIT_MS = 3_600_000;

/**
 * Refuses the request with 403 `device_revoked` when the device it names has been revoked, after
 * auditing the refusal in its own transaction (it must be kept although the request fails), at most
 * once an hour per device so a device retrying does not fill the audit trail (#25 review round 2,
 * low). A request that names no device passes here: a session bound to a revoked device is refused
 * by the tenant middleware whatever it names.
 */
export async function refuseRevokedDevice(
  services: Pick<Services, "db" | "appPool">,
  access: TenantAccess,
  route: string,
  requestId: string | undefined,
): Promise<void> {
  const deviceId = access.deviceId;
  if (!deviceId) return;
  const now = new Date();
  const state = await inSystemView(services.db, access, async (tx) => {
    if (!(await deviceRevoked(tx, deviceId))) return "open" as const;
    const [recent] = await tx
      .select({ id: auditEvent.id })
      .from(auditEvent)
      .where(
        and(
          eq(auditEvent.resourceType, "device"),
          eq(auditEvent.resourceId, deviceId),
          eq(auditEvent.action, DEVICE_REFUSED_ACTION),
          gt(auditEvent.occurredAt, new Date(now.getTime() - REFUSAL_AUDIT_MS)),
        ),
      )
      .limit(1);
    return recent ? ("revoked" as const) : ("revoked_unaudited" as const);
  });
  if (state === "open") return;
  if (state === "revoked") throw problems.deviceRevoked();
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
 * Refuses a phone's sync token or upload with 403 `feature_disabled` while the organisation has not
 * switched Care mode on (`care.mobile_care_mode`, off by default; H-381): the mobile exclusion from
 * the clinical safety case is a control, not an instruction. The flag is organisation-wide (a
 * location row does not switch it on). The phone reads the refusal as access withdrawn: it stops
 * syncing and holds any unsent entries under the hold rules, never deleting them, and a manager's
 * hand-over of held entries is not refused here.
 */
export async function refuseCareModeOff(
  services: Pick<Services, "db">,
  access: TenantAccess,
): Promise<void> {
  const rows = await inSystemView(services.db, access, (tx) =>
    tx
      .select({
        flagKey: featureFlag.flagKey,
        locationId: featureFlag.locationId,
        enabled: featureFlag.enabled,
      })
      .from(featureFlag)
      .where(and(eq(featureFlag.flagKey, CARE_MODE_FLAG), isNull(featureFlag.deletedAt))),
  );
  if (evaluateFlag(CARE_MODE_FLAG, rows, null)) return;
  throw problems.featureDisabled(
    "Care mode on the phone is switched off for your organisation until a clinical safety case covers the app. Ask your manager.",
  );
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
 * The members whose devices a manager reaches with one permission (ADR-0071): where the roles and
 * grants carrying it reach everyone, everyone; where they reach locations, only staff working, or
 * who last worked, at one of them.
 */
export async function reachedMembers(
  tx: Transaction,
  access: TenantAccess,
  permission: Permission,
  memberIds: readonly string[],
  now: Date,
): Promise<Set<string>> {
  const { scope, locationIds } = scopeFor(access.effective, permission);
  if (scope === "tenant") return new Set(memberIds);
  const mine = new Set(scope === "locations" ? locationIds : []);
  const where = await memberLocations(tx, memberIds, now);
  return new Set(memberIds.filter((id) => (where.get(id) ?? []).some((l) => mine.has(l))));
}

/** At most this many bindings are listed. */
const DEVICE_LIST_LIMIT = 500;

/**
 * The devices staff have used, newest sighting first, that the manager reaches (part 2). The
 * members the manager reaches are worked out first and the limit applied to their bindings, so a
 * location role is never short of its own staff's devices (#25 review round 2, low). The waiting
 * counts are the caller's to add.
 */
export async function listDevices(
  db: Db,
  access: TenantAccess,
  filter: { readonly tenantUserId?: string | undefined },
  now: Date,
): Promise<Omit<DeviceBindingItem, "entriesWaiting" | "lastReportedAt">[]> {
  return inSystemView(db, access, async (tx) => {
    const members = await tx
      .selectDistinct({ id: deviceBinding.tenantUserId })
      .from(deviceBinding)
      .where(filter.tenantUserId ? eq(deviceBinding.tenantUserId, filter.tenantUserId) : undefined);
    const reached = await reachedMembers(
      tx,
      access,
      "platform.device.read",
      members.map((m) => m.id),
      now,
    );
    if (reached.size === 0) return [];
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
      .where(inArray(deviceBinding.tenantUserId, [...reached]))
      .orderBy(desc(deviceBinding.lastSeenAt), asc(deviceBinding.deviceId))
      .limit(DEVICE_LIST_LIMIT);
    return rows.map((r) => ({
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

/** A location role reaches some, but not all, of the members bound to the device. */
export function partlyReached(): HttpProblem {
  return new HttpProblem(
    403,
    "missing_permission",
    "Staff you do not manage have also used this device.",
    "Ask a manager who covers the whole organisation to withdraw it.",
  );
}

/**
 * Revokes a device (part 2): every binding of the device not yet revoked is marked with the
 * manager, the time and the coded reason, and the revocation is audited. Null when the manager does
 * not reach anyone who used the device (or it was never seen here), which the route answers as not
 * found; a location role reaching only some of them is refused, so nobody withdraws another home's
 * device by binding a member of their own to it (#25 review round 2, low). A device already revoked
 * changes nothing and says so. The sessions bound to the device are not ended: the tenant
 * middleware refuses them with `device_revoked`, which the device reads as a revocation.
 */
export async function revokeDevice(
  db: Db,
  access: TenantAccess,
  input: {
    readonly deviceId: string;
    readonly reasonCode: DeviceRevocationReason;
    readonly now: Date;
    readonly requestId: string | undefined;
    /** Entries the device last reported waiting that the manager has not confirmed seeing. */
    readonly unconfirmedWaiting?: number;
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
    const reached = await reachedMembers(tx, access, "platform.device.revoke", members, input.now);
    if (reached.size === 0) return null;
    if (reached.size < members.length) throw partlyReached();
    const earliest = rows
      .map((r) => r.revokedAt)
      .filter((at): at is Date => at !== null)
      .sort((a, b) => a.getTime() - b.getTime())[0];
    if (earliest && rows.every((r) => r.revokedAt !== null)) {
      return { revokedAt: earliest, replay: true, bindings: rows.length };
    }
    // Told first how many entries the device last reported waiting (#25 review round 2, M4).
    if ((input.unconfirmedWaiting ?? 0) > 0) {
      throw problems.entriesWaiting(input.unconfirmedWaiting ?? 0);
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
