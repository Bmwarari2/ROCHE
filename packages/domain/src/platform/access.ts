import { isPermission, type Permission, requiresStepUp } from "./permissions";
import { PORTAL_ONLY_PERMISSIONS, type ScopeKind } from "./roles";

/**
 * Effective access for one tenant user at one moment (section 4): RBAC for what they may do,
 * attribute-based scope for whom they may do it to. The result feeds both the API's permission
 * checks and the row-level security context (`app.scope`, `app.location_ids`).
 *
 * Staff and portal sessions never mix (comms.md section 3, ADR-0061): a portal session (a family
 * member, or the person in their own portal) is resolved from portal roles only, with no person
 * scope and no grants; a staff session never carries a portal-only permission. A role or grant
 * that mixes the two is refused when it is defined and ignored if one is ever stored.
 */

export type SessionKind = "staff" | "portal";

export type RolePermissionMix = "staff" | "portal" | "mixed" | "empty";

const isPortalOnly = (p: string) => (PORTAL_ONLY_PERMISSIONS as readonly string[]).includes(p);

/** Whether a set of permissions belongs to a portal role, a staff role, or wrongly to both. */
export function rolePermissionMix(permissions: readonly string[]): RolePermissionMix {
  if (permissions.length === 0) return "empty";
  const portal = permissions.filter(isPortalOnly).length;
  if (portal === 0) return "staff";
  return portal === permissions.length ? "portal" : "mixed";
}

export type RoleDefinitionProblem = "portal_and_staff_permissions_mixed" | "unknown_permission";

/** Checks a role (built-in, cloned or tenant-designed) before it is saved. */
export function checkRoleDefinition(permissions: readonly string[]): RoleDefinitionProblem[] {
  const problems: RoleDefinitionProblem[] = [];
  if (permissions.some((p) => !isPermission(p))) problems.push("unknown_permission");
  if (rolePermissionMix(permissions) === "mixed")
    problems.push("portal_and_staff_permissions_mixed");
  return problems;
}

export type GrantProblem = "portal_permission_in_grant" | "unknown_permission";

/** Grants are time-boxed delegation and acting-up for staff; they never carry portal access. */
export function checkGrantPermissions(permissions: readonly string[]): GrantProblem[] {
  const problems: GrantProblem[] = [];
  if (permissions.some((p) => !isPermission(p))) problems.push("unknown_permission");
  if (permissions.some(isPortalOnly)) problems.push("portal_permission_in_grant");
  return problems;
}

export interface RoleAssignmentInput {
  readonly roleKey: string;
  readonly scopeKind: ScopeKind;
  readonly permissions: readonly string[];
  /** NULL means every location in the tenant. */
  readonly locationId: string | null;
  readonly validFrom: Date;
  readonly validTo: Date | null;
}

export interface AccessGrantInput {
  readonly permissions: readonly string[];
  readonly locationId: string | null;
  readonly validFrom: Date;
  readonly validTo: Date;
  readonly revokedAt: Date | null;
}

export type DataScope = "tenant" | "locations" | "assigned" | "none";

export interface EffectiveAccess {
  readonly permissions: ReadonlySet<Permission>;
  readonly scope: DataScope;
  /** Locations the user may act on; for 'tenant' scope this is empty (meaning all). */
  readonly locationIds: readonly string[];
  readonly roleKeys: readonly string[];
  /** Portal sessions get no person scope: their rows come through the family policies (ADR-0061). */
  readonly session: SessionKind;
}

const SCOPE_RANK: Record<DataScope, number> = { none: 0, assigned: 1, locations: 2, tenant: 3 };

function isActive(validFrom: Date, validTo: Date | null, at: Date): boolean {
  return (
    validFrom.getTime() <= at.getTime() && (validTo === null || validTo.getTime() > at.getTime())
  );
}

function wider(a: DataScope, b: DataScope): DataScope {
  return SCOPE_RANK[a] >= SCOPE_RANK[b] ? a : b;
}

export function resolveAccess(
  assignments: readonly RoleAssignmentInput[],
  grants: readonly AccessGrantInput[],
  at: Date,
  session: SessionKind = "staff",
): EffectiveAccess {
  const permissions = new Set<Permission>();
  const locationIds = new Set<string>();
  const roleKeys = new Set<string>();
  let scope: DataScope = "none";

  for (const assignment of assignments) {
    if (!isActive(assignment.validFrom, assignment.validTo, at)) continue;
    const mix = rolePermissionMix(assignment.permissions);
    if (mix === "mixed") continue;
    if (session === "portal") {
      if (mix !== "portal") continue;
      roleKeys.add(assignment.roleKey);
      for (const p of assignment.permissions) if (isPermission(p)) permissions.add(p);
      continue;
    }
    if (mix === "portal") continue;
    roleKeys.add(assignment.roleKey);
    for (const p of assignment.permissions) if (isPermission(p)) permissions.add(p);

    switch (assignment.scopeKind) {
      case "tenant":
      case "location":
        if (assignment.locationId === null) {
          scope = wider(scope, "tenant");
        } else {
          scope = wider(scope, "locations");
          locationIds.add(assignment.locationId);
        }
        break;
      case "assigned":
      case "self":
        scope = wider(scope, "assigned");
        break;
      case "none":
        break;
    }
  }

  if (session === "staff") {
    for (const grant of grants) {
      if (grant.revokedAt !== null || !isActive(grant.validFrom, grant.validTo, at)) continue;
      for (const p of grant.permissions)
        if (isPermission(p) && !isPortalOnly(p)) permissions.add(p);
    }
  }

  return {
    permissions,
    scope,
    locationIds: scope === "tenant" ? [] : [...locationIds].sort(),
    roleKeys: [...roleKeys].sort(),
    session,
  };
}

/**
 * The staff permissions a user holds at one location now: roles assigned there or tenant-wide, and
 * grants for there or tenant-wide. Used to check that someone a task is given to may complete it
 * (a task's assignee may complete it, so assigning is itself a grant of that one task).
 */
export function permissionsAtLocation(
  assignments: readonly RoleAssignmentInput[],
  grants: readonly AccessGrantInput[],
  locationId: string | null,
  at: Date,
): ReadonlySet<Permission> {
  const here = (where: string | null) => where === null || where === locationId;
  return resolveAccess(
    assignments.filter((a) => here(a.locationId)),
    grants.filter((g) => here(g.locationId)),
    at,
  ).permissions;
}

export function can(access: EffectiveAccess, permission: Permission): boolean {
  return access.permissions.has(permission);
}

export type AuthorisationDecision =
  | { readonly allowed: true }
  | { readonly allowed: false; readonly reason: "missing_permission" | "step_up_required" };

/**
 * Decides whether an action may proceed. Step-up actions need an authentication event no older
 * than `stepUpWindowSeconds`.
 */
export function authorise(
  access: EffectiveAccess,
  permission: Permission,
  lastStrongAuthAt: Date | null,
  now: Date,
  stepUpWindowSeconds: number,
): AuthorisationDecision {
  if (!can(access, permission)) return { allowed: false, reason: "missing_permission" };
  if (requiresStepUp(permission)) {
    const fresh =
      lastStrongAuthAt !== null &&
      now.getTime() - lastStrongAuthAt.getTime() <= stepUpWindowSeconds * 1000;
    if (!fresh) return { allowed: false, reason: "step_up_required" };
  }
  return { allowed: true };
}
