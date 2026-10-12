import { accessGrant, role, roleAssignment, type Transaction } from "@harbour/db";
import {
  type AccessGrantInput,
  type Permission,
  type PermissionPlaces,
  placesHoldingPermission,
  type RoleAssignmentInput,
  type ScopeKind,
} from "@harbour/domain";
import { and, eq, isNull } from "drizzle-orm";

/**
 * Where a member holds one permission now, read from their live role assignments and grants
 * (`placesHoldingPermission`; #26 review round 2, S1). The request's merged scope is wider than
 * any one permission when a member holds several roles, so a change that must stay where the
 * permission is held (an escalation policy link, a coded discard reason) reads this. Row-level
 * security repeats it (`app.holds_permission_at`, migration 0046). Rows the caller cannot read
 * count as nothing held.
 */
export async function permissionPlaces(
  tx: Transaction,
  tenantUserId: string,
  permission: Permission,
  now: Date,
): Promise<PermissionPlaces> {
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
  return placesHoldingPermission(
    assignments.map((a): RoleAssignmentInput => ({ ...a, scopeKind: a.scopeKind as ScopeKind })),
    grants as AccessGrantInput[],
    permission,
    now,
  );
}
