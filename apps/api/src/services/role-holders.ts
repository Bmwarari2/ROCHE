import { role, roleAssignment, type Transaction, tenantUser } from "@harbour/db";
import { and, eq, gt, inArray, isNull, lte, or, type SQL, sql } from "drizzle-orm";

/** The staff statuses that are on the staff: invited (not yet signed in) or active. */
export const ON_STAFF = ["invited", "active"] as const;

/**
 * A role assignment in force now, of a role not archived, held by someone still on the staff
 * (ADR-0071 review round 2): an ended or future assignment, an archived role, or a suspended or
 * departed member of staff is never told or given anything. Needs `role` and `tenant_user` joined.
 */
export function roleInForce(now: Date): SQL {
  return and(
    isNull(roleAssignment.deletedAt),
    isNull(role.archivedAt),
    lte(roleAssignment.validFrom, now),
    or(isNull(roleAssignment.validTo), gt(roleAssignment.validTo, now)),
    inArray(tenantUser.status, [...ON_STAFF]),
  ) as SQL;
}

/**
 * The assignment reaches one of the locations: assigned there, or assigned with no location for a
 * role scoped to the organisation or marked organisation-wide (ADR-0071 review round 1, L1 and
 * L2). Needs `role` joined.
 */
export function roleReaches(locationIds: readonly string[]): SQL {
  return or(
    inArray(roleAssignment.locationId, [...locationIds]),
    and(
      isNull(roleAssignment.locationId),
      or(eq(role.scopeKind, "tenant"), eq(roleAssignment.organisationWide, true)),
    ),
  ) as SQL;
}

/**
 * Members holding one of the role keys in force now (`roleInForce`) where it reaches one of the
 * locations, or anywhere when `locationIds` is null; longest-serving first (the earliest start of
 * an assignment in force, then the id), so the first is chosen the same way every time.
 */
export async function roleHolders(
  tx: Transaction,
  keys: readonly string[],
  locationIds: readonly string[] | null,
  now: Date,
): Promise<string[]> {
  if (keys.length === 0 || (locationIds !== null && locationIds.length === 0)) return [];
  const rows = await tx
    .select({ id: roleAssignment.tenantUserId })
    .from(roleAssignment)
    .innerJoin(role, eq(role.id, roleAssignment.roleId))
    .innerJoin(tenantUser, eq(tenantUser.id, roleAssignment.tenantUserId))
    .where(
      and(
        inArray(role.key, [...keys]),
        roleInForce(now),
        locationIds === null ? undefined : roleReaches(locationIds),
      ),
    )
    .groupBy(roleAssignment.tenantUserId)
    .orderBy(sql`min(${roleAssignment.validFrom})`, roleAssignment.tenantUserId);
  return rows.map((r) => r.id);
}
