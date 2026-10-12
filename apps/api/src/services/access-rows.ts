import { accessGrant, role, roleAssignment, type Transaction, tenantUser } from "@harbour/db";
import {
  type AccessGrantInput,
  type RoleAssignmentInput,
  rolePermissionMix,
  type ScopeKind,
} from "@harbour/domain";
import { and, eq, inArray, isNull } from "drizzle-orm";
import { ON_STAFF } from "./role-holders";

/** One member's role assignments and grants, as the domain's access functions read them. */
export interface AccessRows {
  readonly assignments: readonly RoleAssignmentInput[];
  readonly grants: readonly AccessGrantInput[];
}

const NO_ROWS: AccessRows = { assignments: [], grants: [] };

/**
 * The role assignments (of roles neither archived nor deleted) and grants of each member, not
 * deleted; the domain drops ended, future and revoked ones for the time it is asked about. A
 * member who is suspended, has left or is deleted holds nothing (`ON_STAFF`; ADR-0071 review
 * round 3). Every reader of who holds what goes through here, so a field the domain needs (such
 * as `organisationWide`, ADR-0071 review round 1) is never left out of one of them. Rows the
 * caller cannot read count as nothing held.
 */
export async function accessRowsOf(
  tx: Transaction,
  tenantUserIds: readonly string[],
): Promise<Map<string, AccessRows>> {
  const ids = [...new Set(tenantUserIds)];
  const result = new Map<string, AccessRows>(ids.map((id) => [id, NO_ROWS]));
  if (ids.length === 0) return result;
  const assignments = await tx
    .select({
      tenantUserId: roleAssignment.tenantUserId,
      roleKey: role.key,
      scopeKind: role.scopeKind,
      permissions: role.permissions,
      locationId: roleAssignment.locationId,
      organisationWide: roleAssignment.organisationWide,
      validFrom: roleAssignment.validFrom,
      validTo: roleAssignment.validTo,
    })
    .from(roleAssignment)
    .innerJoin(
      role,
      and(eq(role.id, roleAssignment.roleId), eq(role.tenantId, roleAssignment.tenantId)),
    )
    .innerJoin(
      tenantUser,
      and(
        eq(tenantUser.id, roleAssignment.tenantUserId),
        eq(tenantUser.tenantId, roleAssignment.tenantId),
      ),
    )
    .where(
      and(
        inArray(roleAssignment.tenantUserId, ids),
        isNull(roleAssignment.deletedAt),
        isNull(role.archivedAt),
        isNull(role.deletedAt),
        inArray(tenantUser.status, [...ON_STAFF]),
        isNull(tenantUser.deletedAt),
      ),
    );
  const grants = await tx
    .select({
      tenantUserId: accessGrant.tenantUserId,
      permissions: accessGrant.permissions,
      locationId: accessGrant.locationId,
      organisationWide: accessGrant.organisationWide,
      validFrom: accessGrant.validFrom,
      validTo: accessGrant.validTo,
      revokedAt: accessGrant.revokedAt,
    })
    .from(accessGrant)
    .innerJoin(
      tenantUser,
      and(
        eq(tenantUser.id, accessGrant.tenantUserId),
        eq(tenantUser.tenantId, accessGrant.tenantId),
      ),
    )
    .where(
      and(
        inArray(accessGrant.tenantUserId, ids),
        isNull(accessGrant.deletedAt),
        inArray(tenantUser.status, [...ON_STAFF]),
        isNull(tenantUser.deletedAt),
      ),
    );
  for (const id of ids) {
    result.set(id, {
      assignments: assignments
        .filter((a) => a.tenantUserId === id)
        .map(
          ({ tenantUserId: _, ...a }): RoleAssignmentInput => ({
            ...a,
            scopeKind: a.scopeKind as ScopeKind,
          }),
        ),
      grants: grants
        .filter((g) => g.tenantUserId === id)
        .map(({ tenantUserId: _, ...g }): AccessGrantInput => g),
    });
  }
  return result;
}

/**
 * Where a member works (the location switcher and the sync token's `location_ids`): their role
 * assignments in force at `now`, at a location, or across the organisation for a role scoped to it
 * or marked organisation-wide (ADR-0071 review round 2); a role scoped to assigned people names
 * its location only. A role mixing portal and staff permissions, or a portal role, names none, as
 * at sign-in (review round 3). Never a reach for data: each permission's scope decides that.
 */
export function workLocationIds(
  rows: AccessRows,
  allLocationIds: readonly string[],
  now: Date,
): string[] {
  const inForce = rows.assignments.filter(
    (a) =>
      a.validFrom <= now &&
      (a.validTo === null || a.validTo > now) &&
      rolePermissionMix(a.permissions) === "staff",
  );
  if (
    inForce.some((a) => a.locationId === null && (a.scopeKind === "tenant" || a.organisationWide))
  )
    return [...allLocationIds];
  return allLocationIds.filter((id) => inForce.some((a) => a.locationId === id));
}

/** One member's rows (`accessRowsOf`). */
export async function accessRowsOfMember(
  tx: Transaction,
  tenantUserId: string,
): Promise<AccessRows> {
  return (await accessRowsOf(tx, [tenantUserId])).get(tenantUserId) ?? NO_ROWS;
}
