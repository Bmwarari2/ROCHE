import { isPermission, type Permission, requiresStepUp } from "./permissions";
import type { ScopeKind } from "./roles";

/**
 * Effective access for one tenant user at one moment (section 4): RBAC for what they may do,
 * attribute-based scope for whom they may do it to. The result feeds both the API's permission
 * checks and the row-level security context (`app.scope`, `app.location_ids`).
 */

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
): EffectiveAccess {
  const permissions = new Set<Permission>();
  const locationIds = new Set<string>();
  const roleKeys = new Set<string>();
  let scope: DataScope = "none";

  for (const assignment of assignments) {
    if (!isActive(assignment.validFrom, assignment.validTo, at)) continue;
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

  for (const grant of grants) {
    if (grant.revokedAt !== null || !isActive(grant.validFrom, grant.validTo, at)) continue;
    for (const p of grant.permissions) if (isPermission(p)) permissions.add(p);
  }

  return {
    permissions,
    scope,
    locationIds: scope === "tenant" ? [] : [...locationIds].sort(),
    roleKeys: [...roleKeys].sort(),
  };
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
