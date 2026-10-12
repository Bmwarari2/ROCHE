import { DEVICE_HEADER, HANDOVER_OWNER_HEADER, TENANT_HEADER } from "@harbour/contracts";
import {
  accessGrant,
  authPasskey,
  type Database,
  deviceSession,
  type RequestContext,
  role,
  roleAssignment,
  type Transaction,
  tenantUser,
  withRequestContext,
} from "@harbour/db";
import {
  type AccessGrantInput,
  authorise,
  type DocumentStoragePort,
  type EffectiveAccess,
  type MalwareScanPort,
  type Permission,
  type RoleAssignmentInput,
  resolveAccess,
  type ScopeKind,
  touchesCareRecords,
} from "@harbour/domain";
import { and, count, eq, isNull, sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/node-postgres";
import type { Context, MiddlewareHandler } from "hono";
import type pg from "pg";
import type { Auth } from "../auth/better-auth";
import type { Config } from "../config";
import type { Logger } from "../logger";
import { bindSession, sessionOnRevokedDevice } from "../services/devices";
import { writeAudit } from "./audit";
import { problems } from "./problem";
import type { RateLimiter } from "./rate-limit";

// The device id is the PowerSync client id, a UUID. Anything else is not trusted into the audit
// trail or a task, and reads as no device (security review round 4; #21 S-L6).
const DEVICE_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function deviceIdOf(header: string | undefined): string | null {
  return header && DEVICE_ID.test(header) ? header.toLowerCase() : null;
}

export interface Services {
  readonly config: Config;
  readonly logger: Logger;
  readonly db: Database;
  readonly appPool: pg.Pool;
  readonly authPool: pg.Pool;
  readonly operatorPool: pg.Pool;
  readonly auth: Auth;
  readonly storage: DocumentStoragePort;
  readonly scanner: MalwareScanPort;
  /** Per-user limit on the transfer pack routes (S2). */
  readonly transferPackLimiter: RateLimiter;
  /** Per-user limit on compiling a handover through the API. */
  readonly handoverCompileLimiter: RateLimiter;
}

export interface SessionInfo {
  readonly authUserId: string;
  readonly sessionId: string;
  readonly name: string;
  readonly email: string;
  readonly twoFactorEnabled: boolean;
  readonly sessionCreatedAt: Date;
}

export interface Membership {
  readonly tenantId: string;
  readonly tenantUserId: string;
  readonly tenantName: string;
}

/** Everything the API knows about who is acting, for whom, on which tenant. */
export interface TenantAccess {
  readonly tenantId: string;
  readonly tenantUserId: string;
  readonly session: SessionInfo;
  readonly memberships: readonly Membership[];
  readonly effective: EffectiveAccess;
  readonly context: RequestContext;
  readonly mfaSatisfied: boolean;
  readonly deviceId: string | null;
  readonly ip: string | null;
  /**
   * True when the session is bound to a device a manager has revoked: only its device report gets
   * this far, and it may raise or hurry a task but never close one (#25 review round 3, M2).
   */
  readonly sessionOnRevokedDevice?: boolean;
}

/** A Thapsus operator, set only on /operator routes. */
export interface OperatorIdentity {
  readonly id: string;
  readonly authUserId: string;
  readonly role: "support" | "admin";
}

export type AppEnv = {
  Variables: {
    services: Services;
    requestId: string;
    session: SessionInfo | null;
    access: TenantAccess;
    operator: OperatorIdentity;
  };
};

export function clientIp(c: Context): string | null {
  const forwarded = c.req.header("x-forwarded-for")?.split(",")[0]?.trim();
  return forwarded && /^[0-9a-f.:]+$/i.test(forwarded) ? forwarded : null;
}

/** Resolves the Better Auth session from the cookie or the bearer token. */
export const sessionMiddleware: MiddlewareHandler<AppEnv> = async (c, next) => {
  const { auth } = c.get("services");
  const result = await auth.api.getSession({ headers: c.req.raw.headers });
  if (result) {
    const user = result.user as typeof result.user & { twoFactorEnabled?: boolean | null };
    c.set("session", {
      authUserId: user.id,
      sessionId: result.session.id,
      name: user.name,
      email: user.email,
      twoFactorEnabled: user.twoFactorEnabled === true,
      sessionCreatedAt: new Date(result.session.createdAt),
    });
  } else {
    c.set("session", null);
  }
  await next();
};

export async function membershipsFor(appPool: pg.Pool, authUserId: string): Promise<Membership[]> {
  const db = drizzle(appPool);
  const result = await db.execute<{
    tenant_id: string;
    tenant_user_id: string;
    tenant_name: string;
  }>(
    sql`SELECT tenant_id, tenant_user_id, tenant_name FROM app.memberships_for_auth_user(${authUserId})`,
  );
  return result.rows.map((r) => ({
    tenantId: r.tenant_id,
    tenantUserId: r.tenant_user_id,
    tenantName: r.tenant_name,
  }));
}

async function hasPasskey(authPool: pg.Pool, authUserId: string): Promise<boolean> {
  const db = drizzle(authPool);
  const [row] = await db
    .select({ n: count() })
    .from(authPasskey)
    .where(eq(authPasskey.userId, authUserId));
  return (row?.n ?? 0) > 0;
}

async function loadAccess(
  db: Database,
  tenantId: string,
  tenantUserId: string,
  sessionId: string,
  deviceId: string | null,
  now: Date,
) {
  // Context with scope 'none': enough to read the user's own role rows, nothing about people.
  const context: RequestContext = {
    tenantId,
    userId: tenantUserId,
    scope: "none",
    locationIds: [],
  };
  return withRequestContext(db, context, async (tx) => {
    const [user] = await tx
      .select({ mfaRequired: tenantUser.mfaRequired, status: tenantUser.status })
      .from(tenantUser)
      .where(eq(tenantUser.id, tenantUserId));
    const assignments = await tx
      .select({
        roleKey: role.key,
        scopeKind: role.scopeKind,
        permissions: role.permissions,
        locationId: roleAssignment.locationId,
        validFrom: roleAssignment.validFrom,
        validTo: roleAssignment.validTo,
      })
      .from(roleAssignment)
      .innerJoin(role, eq(role.id, roleAssignment.roleId))
      .where(
        and(
          eq(roleAssignment.tenantUserId, tenantUserId),
          isNull(roleAssignment.deletedAt),
          isNull(role.archivedAt),
        ),
      );
    const grants = await tx
      .select({
        permissions: accessGrant.permissions,
        locationId: accessGrant.locationId,
        validFrom: accessGrant.validFrom,
        validTo: accessGrant.validTo,
        revokedAt: accessGrant.revokedAt,
      })
      .from(accessGrant)
      .where(and(eq(accessGrant.tenantUserId, tenantUserId), isNull(accessGrant.deletedAt)));
    const effective = resolveAccess(
      assignments.map((a): RoleAssignmentInput => ({ ...a, scopeKind: a.scopeKind as ScopeKind })),
      grants as AccessGrantInput[],
      now,
    );
    // A session bound to a device a manager has since revoked is refused whatever device it names
    // (care.md section 6, Device integrity part 2; #25 review round 2, M1).
    const onRevokedDevice = await sessionOnRevokedDevice(tx, sessionId);
    const [bound] = deviceId
      ? await tx
          .select({ id: deviceSession.id })
          .from(deviceSession)
          .where(and(eq(deviceSession.sessionId, sessionId), eq(deviceSession.deviceId, deviceId)))
          .limit(1)
      : [];
    return {
      effective,
      mfaRequired: user?.mfaRequired ?? true,
      onRevokedDevice,
      sessionBound: bound !== undefined,
    };
  });
}

/** A device's report of its unsent work: the one request a session on a revoked device may make. */
const DEVICE_REPORT_PATH = "/v1/sync/device-report";

/**
 * Whether the middleware binds the session to the device the request names (#25 review round 3,
 * M2): every request but the device's report, which binds its reporter itself and is judged before
 * that (security review round 7, M1), and a hand-over, whose sender is bound by the report the
 * device sends from their sign-in first (#25 review round 2, H1).
 */
function bindsSession(c: Context): boolean {
  if (c.req.method === "POST" && c.req.path === DEVICE_REPORT_PATH) return false;
  return c.req.header(HANDOVER_OWNER_HEADER) === undefined;
}

/**
 * Requires a signed-in user who belongs to the tenant named in `x-harbour-tenant` (or their only
 * tenant), and resolves their effective access. Every route under /v1 except /v1/me runs behind it.
 */
export const tenantMiddleware: MiddlewareHandler<AppEnv> = async (c, next) => {
  const session = c.get("session");
  if (!session) throw problems.unauthenticated();
  const services = c.get("services");
  const memberships = await membershipsFor(services.appPool, session.authUserId);
  const requested = c.req.header(TENANT_HEADER);
  const membership = requested
    ? memberships.find((m) => m.tenantId === requested)
    : memberships.length === 1
      ? memberships[0]
      : undefined;
  if (!membership) {
    if (!requested && memberships.length > 1) throw problems.tenantRequired();
    if (requested) {
      // Record the refused attempt without naming the tenant the user is not part of.
      await writeAudit(services.appPool, null, {
        action: "platform.tenant.access",
        outcome: "denied",
        actorAuthUserId: session.authUserId,
        ip: clientIp(c),
        requestId: c.get("requestId"),
      });
    }
    throw problems.notAMember();
  }

  const now = new Date();
  const deviceId = deviceIdOf(c.req.header(DEVICE_HEADER));
  const { effective, mfaRequired, onRevokedDevice, sessionBound } = await loadAccess(
    services.db,
    membership.tenantId,
    membership.tenantUserId,
    session.sessionId,
    deviceId,
    now,
  );
  // A session bound to a device a manager has revoked is refused whatever it names (#25 review
  // rounds 2 and 3, M1 and M2), except its device's report, so the server still hears what the
  // device holds. Its sessions are never ended: a device given a 401 could not tell it was revoked.
  if (onRevokedDevice && !(c.req.method === "POST" && c.req.path === DEVICE_REPORT_PATH)) {
    throw problems.deviceRevoked();
  }
  // Any request naming a device binds the session to it, so a revocation covers a session that
  // never asked for a sync token (M2). Written once per session and device; nothing on a revoked one.
  if (deviceId && !sessionBound && !onRevokedDevice && bindsSession(c)) {
    await withRequestContext(
      services.db,
      {
        tenantId: membership.tenantId,
        userId: membership.tenantUserId,
        scope: "tenant",
        locationIds: [],
      },
      (tx) => bindSession(tx, deviceId, membership.tenantUserId, session.sessionId, now),
    );
  }
  const mfaSatisfied =
    !mfaRequired ||
    session.twoFactorEnabled ||
    (await hasPasskey(services.authPool, session.authUserId));

  c.set("access", {
    tenantId: membership.tenantId,
    tenantUserId: membership.tenantUserId,
    session,
    memberships,
    effective,
    context: {
      tenantId: membership.tenantId,
      userId: membership.tenantUserId,
      scope: effective.scope,
      locationIds: effective.locationIds,
    },
    mfaSatisfied,
    deviceId,
    ip: clientIp(c),
    ...(onRevokedDevice ? { sessionOnRevokedDevice: true } : {}),
  });
  await next();
};

/**
 * Checks a permission (and step-up freshness where the permission needs it), and MFA for anything
 * touching care records. Refusals are written to the audit log.
 */
export async function requirePermission(
  c: Context<AppEnv>,
  permission: Permission,
): Promise<TenantAccess> {
  const access = c.get("access");
  const services = c.get("services");
  if (touchesCareRecords(permission) && !access.mfaSatisfied) throw problems.mfaRequired();
  const decision = authorise(
    access.effective,
    permission,
    access.session.sessionCreatedAt,
    new Date(),
    services.config.STEP_UP_WINDOW_SECONDS,
  );
  if (!decision.allowed) {
    await writeAudit(services.appPool, access, {
      action: permission,
      outcome: "denied",
      reason: decision.reason,
      requestId: c.get("requestId"),
    });
    throw decision.reason === "step_up_required" ? problems.stepUp() : problems.forbidden();
  }
  return access;
}

/** Runs `fn` with row-level security set for this request's tenant, user and scope. */
export function withTenant<T>(c: Context<AppEnv>, fn: (tx: Transaction) => Promise<T>): Promise<T> {
  return withRequestContext(c.get("services").db, c.get("access").context, fn);
}
