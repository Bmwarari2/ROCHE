import type { Transaction } from "@harbour/db";
import { type Permission, type PermissionPlaces, placesHoldingPermission } from "@harbour/domain";
import { accessRowsOfMember } from "./access-rows";

/**
 * Where a member holds one permission now, read from their live role assignments and grants
 * (`placesHoldingPermission`; #26 review round 2, S1). The request's merged scope is wider than
 * any one permission when a member holds several roles, so a change that must stay where the
 * permission is held (an escalation policy link, a coded discard reason) reads this. Row-level
 * security repeats it (`app.holds_permission_at`, migrations 0046 and 0049). Rows the caller
 * cannot read count as nothing held.
 */
export async function permissionPlaces(
  tx: Transaction,
  tenantUserId: string,
  permission: Permission,
  now: Date,
): Promise<PermissionPlaces> {
  const rows = await accessRowsOfMember(tx, tenantUserId);
  return placesHoldingPermission(rows.assignments, rows.grants, permission, now);
}
