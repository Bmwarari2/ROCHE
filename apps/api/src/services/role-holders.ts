import { familyPortalUser, role, roleAssignment, type Transaction, tenantUser } from "@harbour/db";
import { rolePermissionMix } from "@harbour/domain";
import { and, eq, gt, inArray, isNull, lte, or, type SQL, sql } from "drizzle-orm";

/**
 * The staff statuses that may hold access or be given work: invited (not yet signed in) or
 * active. Never suspended or left (ADR-0071 review round 3).
 */
export const ON_STAFF = ["invited", "active"] as const;

/**
 * The staff status of anyone told about something (the nurse in charge, the fallbacks, an
 * escalation and its chain steps): active only. An invited member who has never signed in reads
 * nothing, so they are never the one told (ADR-0071 review round 3, C3-M3).
 */
export const TOLD = ["active"] as const;

/**
 * A role assignment in force now, of a role neither archived nor deleted, held by someone told
 * about things (`TOLD`, not deleted), each row of the same organisation (ADR-0071 review rounds 2
 * and 3): an ended or future assignment, an archived role, or an invited, suspended or departed
 * member of staff is never told or given anything this way. Needs `role` and `tenant_user`
 * joined by id; this adds the organisation to both joins.
 */
export function roleInForce(now: Date): SQL {
  return and(
    eq(role.tenantId, roleAssignment.tenantId),
    eq(tenantUser.tenantId, roleAssignment.tenantId),
    isNull(roleAssignment.deletedAt),
    isNull(role.archivedAt),
    isNull(role.deletedAt),
    lte(roleAssignment.validFrom, now),
    or(isNull(roleAssignment.validTo), gt(roleAssignment.validTo, now)),
    inArray(tenantUser.status, [...TOLD]),
    isNull(tenantUser.deletedAt),
  ) as SQL;
}

/** Of these members, those who may be told about something now (`TOLD`, not deleted). */
export async function toldOf(tx: Transaction, ids: readonly string[]): Promise<Set<string>> {
  if (ids.length === 0) return new Set();
  const rows = await tx
    .select({ id: tenantUser.id })
    .from(tenantUser)
    .where(
      and(
        inArray(tenantUser.id, [...ids]),
        inArray(tenantUser.status, [...TOLD]),
        isNull(tenantUser.deletedAt),
      ),
    );
  return new Set(rows.map((r) => r.id));
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

/**
 * Whether a member is working staff at a location now: active (`roleInForce`, not deleted), with
 * a staff role in force that reaches it (`roleReaches`; a role holding any portal permission
 * never counts), and no open family portal link the caller can see, since such an account signs
 * in to the portal only (ADR-0061). For a second member of staff named on a record, such as a
 * property witness (people.md rule 7): the foreign key alone proves only that the id is a member
 * of the organisation (security review, 31 October 2026).
 */
export async function isStaffAt(
  tx: Transaction,
  tenantUserId: string,
  locationId: string,
  now: Date,
): Promise<boolean> {
  const roles = await tx
    .select({ permissions: role.permissions })
    .from(roleAssignment)
    .innerJoin(role, eq(role.id, roleAssignment.roleId))
    .innerJoin(tenantUser, eq(tenantUser.id, roleAssignment.tenantUserId))
    .where(
      and(
        eq(roleAssignment.tenantUserId, tenantUserId),
        roleInForce(now),
        roleReaches([locationId]),
      ),
    );
  if (!roles.some((r) => rolePermissionMix(r.permissions) === "staff")) return false;
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
