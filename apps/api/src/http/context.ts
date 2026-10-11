import { DEVICE_HEADER, TENANT_HEADER } from "@harbour/contracts";
import {
  accessGrant,
  authPasskey,
  type Database,
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
import { writeAudit } from "./audit";
import { problems } from "./problem";
import type { RateLimiter } from "./rate-limit";

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

async function loadAccess(db: Database, tenantId: string, tenantUserId: string, now: Date) {
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
    return { effective, mfaRequired: user?.mfaRequired ?? true };
  });
}

/**
 * The device id a client sends (`x-harbour-device`), kept only when it is an opaque id: a UUID or a
 * short token of letters, digits, dots, colons, underscores and hyphens (at most 64). Anything else
 * is dropped, so free text never reaches the audit log or a review task (S-L6).
 */
export function deviceIdFrom(header: string | undefined): string | null {
  if (!header) return null;
  return /^[A-Za-z0-9._:-]{1,64}$/.test(header) ? header : null;
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
  const { effective, mfaRequired } = await loadAccess(
    services.db,
    membership.tenantId,
    membership.tenantUserId,
    now,
  );
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
    deviceId: deviceIdFrom(c.req.header(DEVICE_HEADER)),
    ip: clientIp(c),
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
