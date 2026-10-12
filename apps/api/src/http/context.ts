import { DEVICE_HEADER, HANDOVER_OWNER_HEADER, TENANT_HEADER } from "@harbour/contracts";
import {
  accessGrant,
  authPasskey,
  type Database,
  deviceSession,
  person,
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
  can,
  type DocumentStoragePort,
  type EffectiveAccess,
  type MalwareScanPort,
  narrowestScope,
  type Permission,
  type PermissionScope,
  type RoleAssignmentInput,
  resolveAccess,
  type ScopeKind,
  scopeFor,
  touchesCareRecords,
  widestScope,
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
  /**
   * The row-level security context the request runs under (ADR-0071): the scope of the permission
   * it has required, or the narrowest of several (`requirePermission`); scope 'none' until it
   * requires one, so a route that never asks for a permission sees no one.
   */
  readonly context: RequestContext;
  /** The scopes of the permissions this request has required so far, narrowed into `context`. */
  readonly required: readonly PermissionScope[];
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
    // No one until the route requires a permission (ADR-0071).
    context: {
      tenantId: membership.tenantId,
      userId: membership.tenantUserId,
      scope: "none",
      locationIds: [],
    },
    required: [],
    mfaSatisfied,
    deviceId,
    ip: clientIp(c),
    ...(onRevokedDevice ? { sessionOnRevokedDevice: true } : {}),
  });
  await next();
};

/**
 * Narrows the rest of the request to one more scope: the narrowest of every scope it has asked for
 * (`narrowestScope`, ADR-0071). Later `withTenant` calls run under it; a transaction already open
 * keeps the scope it started with.
 */
function narrowTo(c: Context<AppEnv>, scope: PermissionScope): TenantAccess {
  const access = c.get("access");
  const required = [...access.required, scope];
  const narrowed = narrowestScope(required);
  const next: TenantAccess = {
    ...access,
    required,
    context: { ...access.context, scope: narrowed.scope, locationIds: narrowed.locationIds },
  };
  c.set("access", next);
  return next;
}

/** Why the session may not use a permission now (MFA, held, step-up), or null when it may. */
function refusal(
  c: Context<AppEnv>,
  permission: Permission,
): "mfa_enrolment_required" | "missing_permission" | "step_up_required" | null {
  const access = c.get("access");
  if (touchesCareRecords(permission) && !access.mfaSatisfied) return "mfa_enrolment_required";
  const decision = authorise(
    access.effective,
    permission,
    access.session.sessionCreatedAt,
    new Date(),
    c.get("services").config.STEP_UP_WINDOW_SECONDS,
  );
  return decision.allowed ? null : decision.reason;
}

/** Refuses the request when the session may not use the permission; refusals are audited. */
async function authoriseOrRefuse(c: Context<AppEnv>, permission: Permission): Promise<void> {
  const reason = refusal(c, permission);
  if (reason === null) return;
  if (reason === "mfa_enrolment_required") throw problems.mfaRequired();
  await writeAudit(c.get("services").appPool, c.get("access"), {
    action: permission,
    outcome: "denied",
    reason,
    requestId: c.get("requestId"),
  });
  throw reason === "step_up_required" ? problems.stepUp() : problems.forbidden();
}

/**
 * Checks a permission (and step-up freshness where the permission needs it), and MFA for anything
 * touching care records. Refusals are written to the audit log. The request then runs in the scope
 * of that permission only (`scopeFor`), narrowed with any it required before (ADR-0071), so a role
 * that reaches further for something else never widens what this permission reaches.
 */
export async function requirePermission(
  c: Context<AppEnv>,
  permission: Permission,
): Promise<TenantAccess> {
  await authoriseOrRefuse(c, permission);
  return narrowTo(c, scopeFor(c.get("access").effective, permission));
}

/**
 * Requires the first of `permissions` the user holds (MFA, step-up and refusal audit as usual), for
 * a route that any one of them lets the user use. The request then reaches wherever any of them
 * that the session may use now reaches (`widestScope`): one whose MFA or step-up the session does
 * not meet adds nothing.
 */
export async function requireAnyPermission(
  c: Context<AppEnv>,
  permissions: readonly [Permission, ...Permission[]],
): Promise<TenantAccess> {
  const { effective } = c.get("access");
  const held = permissions.filter((p) => can(effective, p));
  await authoriseOrRefuse(c, held[0] ?? permissions[0]);
  const usable = held.filter((p) => refusal(c, p) === null);
  return narrowTo(c, widestScope(usable.map((p) => scopeFor(effective, p))));
}

/**
 * Routes every member of the organisation may use that show more to holders of one permission:
 * they run in that permission's scope without requiring it (no one's when it is not held), and
 * apply their own checks to what they show (ADR-0071). Keyed by method and route path. Every other
 * route reaches people only through `requirePermission`; one that requires nothing runs with scope
 * 'none'.
 */
export const SCOPE_WITHOUT_PERMISSION: Readonly<Record<string, Permission>> = {
  // Tasks: a task about a person follows whether the reader may open that person's record; one
  // about nobody, the reader's own or at a location that permission reaches. Completing one needs
  // its own permission where it is, or being its assignee (routes/tasks.ts).
  "GET /v1/tasks": "people.person.read",
  "POST /v1/tasks/:id/transition": "people.person.read",
  // Documents: the row is found first, then a document about a person needs people.person.read
  // (an organisation's document needs nothing); a new version needs its category's permission too.
  "GET /v1/documents/:id": "people.person.read",
  "GET /v1/documents/:id/content": "people.person.read",
  "POST /v1/documents/:id/signatures": "people.person.read",
  "POST /v1/documents/:id/versions": "people.person.read",
};

/**
 * Runs the rest of the request in one permission's scope without requiring the permission, on a
 * route listed in `SCOPE_WITHOUT_PERMISSION` only (anything else is a programming error).
 */
export function useScopeOf(c: Context<AppEnv>, permission: Permission): TenantAccess {
  const route = `${c.req.method} ${c.req.routePath}`;
  if (SCOPE_WITHOUT_PERMISSION[route] !== permission) {
    throw new Error(`${route} may not run in the scope of ${permission} without requiring it`);
  }
  return narrowTo(c, scopeFor(c.get("access").effective, permission));
}

/**
 * Runs `fn` in the caller's transaction under another permission's scope, then puts the request's
 * own back: to ask whether a row the request can see is also within that permission's reach
 * (ADR-0071). Use it only for such checks; what `fn` reads never widens what the request shows.
 */
export async function inScopeOf<T>(
  tx: Transaction,
  access: TenantAccess,
  scope: PermissionScope,
  fn: () => Promise<T>,
): Promise<T> {
  const set = (s: { readonly scope: string; readonly locationIds: readonly string[] }) =>
    tx.execute(
      sql`SELECT set_config('app.scope', ${s.scope}, true),
                 set_config('app.location_ids', ${s.locationIds.join(",")}, true)`,
    );
  await set(scope);
  let result: T;
  try {
    result = await fn();
  } catch (error) {
    // Put the request's scope back while the transaction can still run; an aborted one rolls back.
    await set(access.context).catch(() => undefined);
    throw error;
  }
  await set(access.context);
  return result;
}

/**
 * The permissions the user may use on one person's record: those whose roles and grants reach the
 * person (ADR-0071), as row-level security judges it in the caller's transaction. For the domain's
 * own checks on that record (a status change, a task an entry completes, a return check), which
 * would otherwise count a permission the user holds only somewhere else.
 */
export async function permissionsReaching(
  tx: Transaction,
  access: TenantAccess,
  personId: string,
): Promise<ReadonlySet<Permission>> {
  const reached = new Set<Permission>();
  const verdicts = new Map<string, boolean>();
  for (const permission of access.effective.permissions) {
    const scope = scopeFor(access.effective, permission);
    const key = `${scope.scope}:${scope.locationIds.join(",")}`;
    let sees = verdicts.get(key);
    if (sees === undefined) {
      sees =
        scope.scope !== "none" &&
        (await inScopeOf(tx, access, scope, async () => {
          const [row] = await tx
            .select({ id: person.id })
            .from(person)
            .where(eq(person.id, personId));
          return row !== undefined;
        }));
      verdicts.set(key, sees);
    }
    if (sees) reached.add(permission);
  }
  return reached;
}

/** Runs `fn` with row-level security set for this request's tenant, user and scope. */
export function withTenant<T>(c: Context<AppEnv>, fn: (tx: Transaction) => Promise<T>): Promise<T> {
  return withRequestContext(c.get("services").db, c.get("access").context, fn);
}
