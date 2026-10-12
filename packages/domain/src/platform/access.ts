import { isPermission, type Permission, requiresStepUp } from "./permissions";
import { PORTAL_ONLY_PERMISSIONS, type ScopeKind } from "./roles";

/**
 * Effective access for one tenant user at one moment (section 4): RBAC for what they may do,
 * attribute-based scope for whom they may do it to. The result feeds both the API's permission
 * checks and the row-level security context (`app.scope`, `app.location_ids`).
 *
 * Data scope is per permission (ADR-0071): each permission reaches only the people the roles and
 * grants that carry it reach (`scopeFor`), never the widest scope of anything else the user holds.
 * A care worker at one home who is also a finance viewer across the organisation writes care notes
 * at that home only. A request runs under the scope of the permission it uses, or the narrowest of
 * several (`narrowestScope`).
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

/**
 * Whom one permission reaches (ADR-0071): `tenant` everyone; `locations` the people at
 * `locationIds` (and, in row-level security, anyone the user is assigned to or holds break-glass
 * for); `assigned` the people the user is assigned to (and break-glass); `none` no one.
 */
export interface PermissionScope {
  readonly scope: DataScope;
  /** Sorted location ids for `locations`; empty for every other scope. */
  readonly locationIds: readonly string[];
}

/** No one: the scope of a permission not held, and of a request that has required none. */
export const NO_SCOPE: PermissionScope = Object.freeze({ scope: "none", locationIds: [] });

export interface EffectiveAccess {
  readonly permissions: ReadonlySet<Permission>;
  /**
   * The scope each held permission carries, from the roles and grants that give it only. Read it
   * with `scopeFor`; a permission not held reaches no one.
   */
  readonly scopes: ReadonlyMap<Permission, PermissionScope>;
  readonly roleKeys: readonly string[];
  /** Portal sessions get no person scope: their rows come through the family policies (ADR-0061). */
  readonly session: SessionKind;
}

function isActive(validFrom: Date, validTo: Date | null, at: Date): boolean {
  return (
    validFrom.getTime() <= at.getTime() && (validTo === null || validTo.getTime() > at.getTime())
  );
}

const TENANT: PermissionScope = Object.freeze({ scope: "tenant", locationIds: [] });
const ASSIGNED: PermissionScope = Object.freeze({ scope: "assigned", locationIds: [] });
const atLocations = (ids: Iterable<string>): PermissionScope => {
  const locationIds = [...new Set(ids)].sort();
  return locationIds.length === 0 ? ASSIGNED : { scope: "locations", locationIds };
};

/** What one role assignment or grant reaches for the permissions it carries. */
function placeScope(scopeKind: ScopeKind, locationId: string | null): PermissionScope {
  switch (scopeKind) {
    case "tenant":
    case "location":
      return locationId === null ? TENANT : atLocations([locationId]);
    case "assigned":
    case "self":
      return ASSIGNED;
    case "none":
      return NO_SCOPE;
  }
}

/**
 * The union of scopes: whom any one of them reaches. `tenant` wins; locations add up; `assigned`
 * is inside every location scope (row-level security shows assigned people under both); `none`
 * adds nothing. Used to combine the roles and grants carrying one permission, and alternatives of
 * which a route needs any one.
 */
export function widestScope(scopes: readonly PermissionScope[]): PermissionScope {
  if (scopes.some((s) => s.scope === "tenant")) return TENANT;
  const located = scopes.filter((s) => s.scope === "locations");
  if (located.length > 0) return atLocations(located.flatMap((s) => s.locationIds));
  return scopes.some((s) => s.scope === "assigned") ? ASSIGNED : NO_SCOPE;
}

/**
 * The intersection of scopes: whom every one of them reaches, for a request that needs several
 * permissions at once (ADR-0071). Nothing required, or `none` among them, reaches no one; `tenant`
 * narrows to the other; two location scopes keep the locations they share, and assigned people
 * only when they share none (both show assigned people); `assigned` with any location scope or
 * `tenant` is `assigned`, which every one of them includes.
 */
export function narrowestScope(scopes: readonly PermissionScope[]): PermissionScope {
  if (scopes.length === 0 || scopes.some((s) => s.scope === "none")) return NO_SCOPE;
  if (scopes.some((s) => s.scope === "assigned")) return ASSIGNED;
  const located = scopes.filter((s) => s.scope === "locations");
  if (located.length === 0) return TENANT;
  const [first, ...rest] = located.map((s) => s.locationIds);
  return atLocations((first ?? []).filter((id) => rest.every((ids) => ids.includes(id))));
}

/** Whom the user may act on with one permission: no one when it is not held. */
export function scopeFor(access: EffectiveAccess, permission: Permission): PermissionScope {
  return access.scopes.get(permission) ?? NO_SCOPE;
}

export function resolveAccess(
  assignments: readonly RoleAssignmentInput[],
  grants: readonly AccessGrantInput[],
  at: Date,
  session: SessionKind = "staff",
): EffectiveAccess {
  const sources = new Map<Permission, PermissionScope[]>();
  const roleKeys = new Set<string>();
  const add = (p: string, place: PermissionScope) => {
    if (!isPermission(p)) return;
    const list = sources.get(p);
    if (list) list.push(place);
    else sources.set(p, [place]);
  };

  for (const assignment of assignments) {
    if (!isActive(assignment.validFrom, assignment.validTo, at)) continue;
    const mix = rolePermissionMix(assignment.permissions);
    if (mix === "mixed") continue;
    // A portal session takes portal roles only, with no person scope (ADR-0061); a staff session
    // never takes a portal role.
    if (mix === "portal" ? session !== "portal" : session === "portal") continue;
    roleKeys.add(assignment.roleKey);
    const place =
      session === "portal" ? NO_SCOPE : placeScope(assignment.scopeKind, assignment.locationId);
    for (const p of assignment.permissions) add(p, place);
  }

  if (session === "staff") {
    for (const grant of grants) {
      if (grant.revokedAt !== null || !isActive(grant.validFrom, grant.validTo, at)) continue;
      // A grant reaches where it is given: its location, or the whole organisation without one.
      const place = grant.locationId === null ? TENANT : atLocations([grant.locationId]);
      for (const p of grant.permissions) if (!isPortalOnly(p)) add(p, place);
    }
  }

  const scopes = new Map<Permission, PermissionScope>(
    [...sources].map(([p, places]) => [p, widestScope(places)]),
  );
  return {
    permissions: new Set(scopes.keys()),
    scopes,
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

/** Where a member may use one permission: across the organisation, or at these locations. */
export interface PermissionPlaces {
  readonly organisationWide: boolean;
  readonly locationIds: readonly string[];
}

/**
 * Where a member holds one permission now, from the roles and grants that carry it only (#26
 * review round 2, S1): a change that must stay where the permission is held reads this. Unlike
 * `scopeFor`, it never counts a role scoped to assigned people, so it answers "at this home, or
 * across the organisation" for settings rather than "whom". A role carrying the permission counts
 * across the organisation when assigned with no location (scope `tenant` or `location`), and at
 * its location otherwise; roles scoped to assigned people or to none give no place. A grant counts
 * across the organisation with no location. Staff sessions only: a role mixing portal and staff
 * permissions is ignored, as `resolveAccess` does.
 */
export function placesHoldingPermission(
  assignments: readonly RoleAssignmentInput[],
  grants: readonly AccessGrantInput[],
  permission: Permission,
  at: Date,
): PermissionPlaces {
  let organisationWide = false;
  const locationIds = new Set<string>();
  const place = (locationId: string | null) => {
    if (locationId === null) organisationWide = true;
    else locationIds.add(locationId);
  };
  for (const assignment of assignments) {
    if (!isActive(assignment.validFrom, assignment.validTo, at)) continue;
    if (rolePermissionMix(assignment.permissions) !== "staff") continue;
    if (!assignment.permissions.includes(permission)) continue;
    if (assignment.scopeKind !== "tenant" && assignment.scopeKind !== "location") continue;
    place(assignment.locationId);
  }
  for (const grant of grants) {
    if (grant.revokedAt !== null || !isActive(grant.validFrom, grant.validTo, at)) continue;
    if (!grant.permissions.includes(permission)) continue;
    place(grant.locationId);
  }
  return {
    organisationWide,
    locationIds: organisationWide ? [] : [...locationIds].sort(),
  };
}

/** Whether the places cover a location, or the whole organisation when `locationId` is null. */
export function placesCover(places: PermissionPlaces, locationId: string | null): boolean {
  if (places.organisationWide) return true;
  return locationId !== null && places.locationIds.includes(locationId);
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
