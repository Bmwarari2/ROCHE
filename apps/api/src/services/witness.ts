import { familyPortalUser, type Transaction } from "@harbour/db";
import {
  type Permission,
  placesCover,
  placesHoldingPermission,
  type RoleAssignmentInput,
  rolePermissionMix,
} from "@harbour/domain";
import { and, eq, isNull } from "drizzle-orm";
import { accessRowsOfMember } from "./access-rows";
import { toldOf } from "./role-holders";

const inForce = (a: RoleAssignmentInput, at: Date) =>
  a.validFrom <= at && (a.validTo === null || a.validTo > at);

const portalRole = (a: RoleAssignmentInput) => {
  const mix = rolePermissionMix(a.permissions);
  return mix === "portal" || mix === "mixed";
};

/**
 * Whether a member may witness, at a location, what a permission there allows: a second member
 * of staff named on a record, such as a property witness (people.md rule 7), where the foreign
 * key alone proves only that the id is a member of the organisation (security reviews, 31
 * October 2026 and of #134, M3, L1 and L2).
 *
 * - Active now (`toldOf`: active, not deleted), whenever the witnessing was.
 * - Holding the permission at the location when they witnessed (`at`), through a staff role in
 *   force then or an in-force, unrevoked acting-up grant (`placesHoldingPermission`, as
 *   `submitHolders` reads it), so a visiting professional's or an inspector's role, which never
 *   carries it, does not count.
 * - Holding no portal role, then or now, and with no open family portal link the caller can see,
 *   since such an account signs in to the portal only (ADR-0061). The link is read under the
 *   caller's row-level security, so a link to someone outside their scope is not seen: checking
 *   it in a definer function needs a migration (follow-up).
 */
export async function mayWitnessAt(
  tx: Transaction,
  tenantUserId: string,
  permission: Permission,
  locationId: string,
  at: Date,
  now: Date,
): Promise<boolean> {
  if (!(await toldOf(tx, [tenantUserId])).has(tenantUserId)) return false;
  const rows = await accessRowsOfMember(tx, tenantUserId);
  if (rows.assignments.some((a) => portalRole(a) && (inForce(a, at) || inForce(a, now)))) {
    return false;
  }
  const places = placesHoldingPermission(rows.assignments, rows.grants, permission, at);
  if (!placesCover(places, locationId)) return false;
  const [portal] = await tx
    .select({ id: familyPortalUser.id })
    .from(familyPortalUser)
    .where(
      and(
        eq(familyPortalUser.tenantUserId, tenantUserId),
        isNull(familyPortalUser.revokedAt),
        isNull(familyPortalUser.deletedAt),
      ),
    )
    .limit(1);
  return portal === undefined;
}
