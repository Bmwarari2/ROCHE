import {
  accessGrant,
  person,
  role,
  roleAssignment,
  type Transaction,
  tenantUser,
} from "@harbour/db";
import {
  type AccessGrantInput,
  type Permission,
  type RoleAssignmentInput,
  resolveAccess,
  type ScopeKind,
  scopeFor,
} from "@harbour/domain";
import { and, eq, inArray, isNull, sql } from "drizzle-orm";

/**
 * What one member of staff may see and do now with one permission: the people, where they see a
 * handover whole, and the permissions their roles and grants in force give them.
 */
export interface StaffView {
  readonly people: ReadonlySet<string>;
  readonly scope: string;
  readonly locationIds: readonly string[];
  readonly permissions: ReadonlySet<Permission>;
}

const NO_VIEW: StaffView = {
  people: new Set(),
  scope: "none",
  locationIds: [],
  permissions: new Set(),
};

/**
 * What each member of staff may see now with `permission`, by the database's own person-scope
 * policy (`app.person_in_scope`): each member's scope for that permission is resolved from the
 * roles and grants that carry it, as the API does for a request that requires it (ADR-0071), set
 * on the transaction while their view of these people is read, and the caller's context is put
 * back afterwards. Used with `care.handover.manage`, the permission a handover is read under, to
 * say who still has to acknowledge a handover and who hears about a late addition, so nobody is
 * asked about, or told of, items they cannot see (HZ-011, HZ-008); and with `people.person.read`,
 * the one the person's record is opened with, to send an urgent result alert only to someone who
 * can open it (#26 review round 3; HZ-014, HZ-016).
 */
export async function staffViews(
  tx: Transaction,
  tenantUserIds: readonly string[],
  personIds: readonly string[],
  now: Date,
  permission: Permission,
): Promise<Map<string, StaffView>> {
  const result = new Map<string, StaffView>(tenantUserIds.map((id) => [id, NO_VIEW]));
  const people = [...new Set(personIds)];
  if (tenantUserIds.length === 0) return result;
  // A suspended or departed member of staff sees nobody, whatever their roles still say.
  const current = await tx
    .select({ id: tenantUser.id })
    .from(tenantUser)
    .where(
      and(
        inArray(tenantUser.id, [...tenantUserIds]),
        inArray(tenantUser.status, ["invited", "active"]),
      ),
    );
  const onStaff = new Set(current.map((u) => u.id));
  const assignments = await tx
    .select({
      tenantUserId: roleAssignment.tenantUserId,
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
        inArray(roleAssignment.tenantUserId, [...tenantUserIds]),
        isNull(roleAssignment.deletedAt),
        isNull(role.archivedAt),
      ),
    );
  const grants = await tx
    .select({
      tenantUserId: accessGrant.tenantUserId,
      permissions: accessGrant.permissions,
      locationId: accessGrant.locationId,
      validFrom: accessGrant.validFrom,
      validTo: accessGrant.validTo,
      revokedAt: accessGrant.revokedAt,
    })
    .from(accessGrant)
    .where(
      and(inArray(accessGrant.tenantUserId, [...tenantUserIds]), isNull(accessGrant.deletedAt)),
    );
  const saved = await tx.execute<{ user_id: string; scope: string; location_ids: string }>(
    sql`SELECT current_setting('app.user_id', true) AS user_id,
               current_setting('app.scope', true) AS scope,
               current_setting('app.location_ids', true) AS location_ids`,
  );
  const before = saved.rows[0];
  try {
    for (const userId of tenantUserIds) {
      if (!onStaff.has(userId)) continue;
      // Roles and grants in force now only: resolveAccess drops ended and future ones.
      const access = resolveAccess(
        assignments
          .filter((a) => a.tenantUserId === userId)
          .map((a): RoleAssignmentInput => ({ ...a, scopeKind: a.scopeKind as ScopeKind })),
        grants.filter((g) => g.tenantUserId === userId) as AccessGrantInput[],
        now,
      );
      const { scope, locationIds } = scopeFor(access, permission);
      let seen: { id: string }[] = [];
      if (people.length > 0) {
        await tx.execute(
          sql`SELECT set_config('app.user_id', ${userId}, true),
                     set_config('app.scope', ${scope}, true),
                     set_config('app.location_ids', ${locationIds.join(",")}, true)`,
        );
        seen = await tx
          .select({ id: person.id })
          .from(person)
          .where(and(inArray(person.id, people), isNull(person.deletedAt)));
      }
      result.set(userId, {
        people: new Set(seen.map((r) => r.id)),
        scope,
        locationIds,
        permissions: access.permissions,
      });
    }
  } finally {
    await tx.execute(
      sql`SELECT set_config('app.user_id', ${before?.user_id ?? ""}, true),
                 set_config('app.scope', ${before?.scope ?? "none"}, true),
                 set_config('app.location_ids', ${before?.location_ids ?? ""}, true)`,
    );
  }
  return result;
}
