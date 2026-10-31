import { ALL_PERMISSIONS, isPermission, type Permission, requiresStepUp } from "./permissions";
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
 * several (`narrowestScope`). People the user is assigned to count only for a permission a role
 * scoped to assigned people carries, and people the user opened by break-glass only for the read
 * permissions in `BREAK_GLASS_PERMISSIONS` (review round 1, S-M1).
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
  /**
   * The location the role is held at. NULL means every location only for a role scoped to the
   * organisation, or for a location role assigned with `organisationWide` set; a location role with
   * neither reaches no one (fails closed; the database refuses it, review round 1, L2).
   */
  readonly locationId: string | null;
  /** Set only on a location role deliberately assigned across the organisation. */
  readonly organisationWide: boolean;
  readonly validFrom: Date;
  readonly validTo: Date | null;
}

export interface AccessGrantInput {
  readonly permissions: readonly string[];
  /**
   * The location the grant is for. NULL counts as the whole organisation only when
   * `organisationWide` is set; otherwise the grant gives nothing (fails closed; the database
   * refuses it, review round 1, L1).
   */
  readonly locationId: string | null;
  readonly organisationWide: boolean;
  readonly validFrom: Date;
  readonly validTo: Date;
  readonly revokedAt: Date | null;
}

export type DataScope = "tenant" | "locations" | "assigned" | "none";

/**
 * Whom one permission reaches (ADR-0071): `tenant` everyone; `locations` the people at
 * `locationIds`; `assigned` the people the user is assigned to; `none` no one. A `locations` scope
 * also reaches the people the user is assigned to only when `includesAssigned` is set, and any
 * scope reaches the people the user opened by break-glass only when `includesBreakGlass` is set
 * (row-level security reads both from the request context, review round 1, S-M1).
 */
export interface PermissionScope {
  readonly scope: DataScope;
  /** Sorted location ids for `locations`; empty for every other scope. */
  readonly locationIds: readonly string[];
  /** A role scoped to assigned people carries the permission (always true for `assigned`). */
  readonly includesAssigned: boolean;
  /** The permission is one a break-glass record opens (`BREAK_GLASS_PERMISSIONS`). */
  readonly includesBreakGlass: boolean;
}

/** No one: the scope of a permission not held, and of a request that has required none. */
export const NO_SCOPE: PermissionScope = Object.freeze({
  scope: "none",
  locationIds: [],
  includesAssigned: false,
  includesBreakGlass: false,
});

/**
 * The permissions a break-glass record opens on the person it names, for its hour: reading the
 * person and their care record only (`people.person.read`, and the `care.*.read` and
 * `medicines.*.read` permissions that exist). Never a write, a discharge or death, money, ReSPECT or
 * admission (review round 1, S-M1; ADR-0071; the CSO and data protection lead confirm it, H-168).
 */
export const BREAK_GLASS_PERMISSIONS: readonly Permission[] = ALL_PERMISSIONS.filter(
  (p) =>
    p === "people.person.read" ||
    /^care\.[a-z_]+\.read$/.test(p) ||
    /^medicines\.[a-z_]+\.read$/.test(p),
);

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

/** Everyone: so it includes the people assigned to the user and those opened by break-glass. */
const TENANT: PermissionScope = Object.freeze({
  scope: "tenant",
  locationIds: [],
  includesAssigned: true,
  includesBreakGlass: true,
});
const ASSIGNED: PermissionScope = Object.freeze({
  scope: "assigned",
  locationIds: [],
  includesAssigned: true,
  includesBreakGlass: false,
});

/**
 * A scope from its parts: locations if any, else the people assigned to the user if included,
 * else no one (people opened by break-glass alone are never a scope of their own).
 */
function scopeOf(
  ids: Iterable<string>,
  includesAssigned: boolean,
  includesBreakGlass: boolean,
): PermissionScope {
  const locationIds = [...new Set(ids)].sort();
  if (locationIds.length > 0) {
    return { scope: "locations", locationIds, includesAssigned, includesBreakGlass };
  }
  if (includesAssigned) return { ...ASSIGNED, includesBreakGlass };
  return NO_SCOPE;
}

/** What one role assignment reaches for the permissions it carries. */
function placeScope(assignment: RoleAssignmentInput): PermissionScope {
  switch (assignment.scopeKind) {
    case "tenant":
      return assignment.locationId === null
        ? TENANT
        : scopeOf([assignment.locationId], false, false);
    case "location":
      if (assignment.locationId !== null) return scopeOf([assignment.locationId], false, false);
      // A location role with no location reaches every location only when that was meant.
      return assignment.organisationWide ? TENANT : NO_SCOPE;
    case "assigned":
    case "self":
      return ASSIGNED;
    case "none":
      return NO_SCOPE;
  }
}

/** What one grant reaches: its location, or the whole organisation when marked so. */
function grantScope(grant: AccessGrantInput): PermissionScope {
  if (grant.locationId !== null) return scopeOf([grant.locationId], false, false);
  return grant.organisationWide ? TENANT : NO_SCOPE;
}

/**
 * The union of scopes: whom any one of them reaches. `tenant` wins; locations add up; the people
 * assigned to the user and those opened by break-glass count when any of them counts them; `none`
 * adds nothing. Used to combine the roles and grants carrying one permission, and alternatives of
 * which a route needs any one.
 */
export function widestScope(scopes: readonly PermissionScope[]): PermissionScope {
  if (scopes.some((s) => s.scope === "tenant")) return TENANT;
  const live = scopes.filter((s) => s.scope !== "none");
  return scopeOf(
    live.flatMap((s) => s.locationIds),
    live.some((s) => s.includesAssigned),
    live.some((s) => s.includesBreakGlass),
  );
}

/**
 * The intersection of scopes: whom every one of them reaches, for a request that needs several
 * permissions at once (ADR-0071). Nothing required, or `none` among them, reaches no one; `tenant`
 * narrows to the others; the people assigned to the user, and those opened by break-glass, count
 * only when every one of them counts them. `assigned` with a location scope that does not count
 * assigned people reaches no one (the database cannot say "assigned and at these locations", so it
 * fails closed); two location scopes keep the locations they share, or the assigned people when
 * they share none and both count them, or no one.
 */
export function narrowestScope(scopes: readonly PermissionScope[]): PermissionScope {
  if (scopes.length === 0 || scopes.some((s) => s.scope === "none")) return NO_SCOPE;
  const narrowing = scopes.filter((s) => s.scope !== "tenant");
  if (narrowing.length === 0) return TENANT;
  const includesAssigned = narrowing.every((s) => s.includesAssigned);
  const includesBreakGlass = narrowing.every((s) => s.includesBreakGlass);
  if (narrowing.some((s) => s.scope === "assigned")) {
    return includesAssigned ? { ...ASSIGNED, includesBreakGlass } : NO_SCOPE;
  }
  const [first, ...rest] = narrowing.map((s) => s.locationIds);
  return scopeOf(
    (first ?? []).filter((id) => rest.every((ids) => ids.includes(id))),
    includesAssigned,
    includesBreakGlass,
  );
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
    const place = session === "portal" ? NO_SCOPE : placeScope(assignment);
    for (const p of assignment.permissions) add(p, place);
  }

  if (session === "staff") {
    for (const grant of grants) {
      if (grant.revokedAt !== null || !isActive(grant.validFrom, grant.validTo, at)) continue;
      // A grant reaches where it is given: its location, or the whole organisation when marked so.
      const place = grantScope(grant);
      for (const p of grant.permissions) if (!isPortalOnly(p)) add(p, place);
    }
  }

  // People opened by break-glass count for the read permissions it opens, wherever else they reach.
  const withBreakGlass = (p: Permission, scope: PermissionScope): PermissionScope =>
    scope.scope === "none" || scope.scope === "tenant"
      ? scope
      : { ...scope, includesBreakGlass: BREAK_GLASS_PERMISSIONS.includes(p) };
  const scopes = new Map<Permission, PermissionScope>(
    [...sources].map(([p, places]) => [p, withBreakGlass(p, widestScope(places))]),
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
  // A role or grant with no location counts here only when it reaches the whole organisation (a
  // role scoped to the organisation or to assigned people, or one marked organisation-wide).
  const roleHere = (a: RoleAssignmentInput) =>
    a.locationId === null
      ? a.scopeKind !== "location" || a.organisationWide
      : a.locationId === locationId;
  const grantHere = (g: AccessGrantInput) =>
    g.locationId === null ? g.organisationWide : g.locationId === locationId;
  return resolveAccess(assignments.filter(roleHere), grants.filter(grantHere), at).permissions;
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
 * across the organisation when assigned with no location (scope `tenant`, or `location` marked
 * organisation-wide), and at its location otherwise; roles scoped to assigned people or to none
 * give no place. A grant counts across the organisation only when marked so. Staff sessions only: a
 * role mixing portal and staff permissions is ignored, as `resolveAccess` does.
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
    if (
      assignment.locationId === null &&
      assignment.scopeKind === "location" &&
      !assignment.organisationWide
    ) {
      continue;
    }
    place(assignment.locationId);
  }
  for (const grant of grants) {
    if (grant.revokedAt !== null || !isActive(grant.validFrom, grant.validTo, at)) continue;
    if (!grant.permissions.includes(permission)) continue;
    if (grant.locationId === null && !grant.organisationWide) continue;
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

/**
 * Whether one permission's scope reaches a home: across the organisation, or at that location.
 * A scope of assigned people, or of none, reaches no home. Deciding by the record's location, not
 * by whether row-level security shows it, keeps a permission from acting where it is not held
 * (an incident shows to its raiser anywhere; #130 review round 2, M1).
 */
export function scopeReachesLocation(scope: PermissionScope, locationId: string): boolean {
  if (scope.scope === "tenant") return true;
  return scope.scope === "locations" && scope.locationIds.includes(locationId);
}

export function can(access: EffectiveAccess, permission: Permission): boolean {
  return access.permissions.has(permission);
}

export type AuthorisationDecision =
  | { readonly allowed: true }
  | { readonly allowed: false; readonly reason: "missing_permission" | "step_up_required" };

/**
 * Decides whether an action may proceed. Step-up actions need a second factor used on the session
 * (`stepUpAt`, never a password sign-in time; ADR-0072 amendment) no older than
 * `stepUpWindowSeconds`.
 */
export function authorise(
  access: EffectiveAccess,
  permission: Permission,
  stepUpAt: Date | null,
  now: Date,
  stepUpWindowSeconds: number,
): AuthorisationDecision {
  if (!can(access, permission)) return { allowed: false, reason: "missing_permission" };
  if (requiresStepUp(permission)) {
    const fresh =
      stepUpAt !== null && now.getTime() - stepUpAt.getTime() <= stepUpWindowSeconds * 1000;
    if (!fresh) return { allowed: false, reason: "step_up_required" };
  }
  return { allowed: true };
}
