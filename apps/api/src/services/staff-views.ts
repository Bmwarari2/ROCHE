import { person, type Transaction, tenantUser } from "@harbour/db";
import { type Permission, resolveAccess, scopeFor } from "@harbour/domain";
import { and, inArray, isNull, sql } from "drizzle-orm";
import { accessRowsOf } from "./access-rows";
import { ON_STAFF } from "./role-holders";

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
        inArray(tenantUser.status, [...ON_STAFF]),
        isNull(tenantUser.deletedAt),
      ),
    );
  const onStaff = new Set(current.map((u) => u.id));
  const rows = await accessRowsOf(tx, tenantUserIds);
  const saved = await tx.execute<{
    user_id: string;
    scope: string;
    location_ids: string;
    assigned: string;
    break_glass: string;
  }>(
    sql`SELECT current_setting('app.user_id', true) AS user_id,
               current_setting('app.scope', true) AS scope,
               current_setting('app.location_ids', true) AS location_ids,
               current_setting('app.scope_assigned', true) AS assigned,
               current_setting('app.scope_break_glass', true) AS break_glass`,
  );
  const before = saved.rows[0];
  try {
    for (const userId of tenantUserIds) {
      if (!onStaff.has(userId)) continue;
      // Roles and grants in force now only: resolveAccess drops ended and future ones.
      const mine = rows.get(userId);
      const access = resolveAccess(mine?.assignments ?? [], mine?.grants ?? [], now);
      // The member's assigned and break-glass people count only as their scope for this
      // permission says (ADR-0071 review round 1, S-M1).
      const { scope, locationIds, includesAssigned, includesBreakGlass } = scopeFor(
        access,
        permission,
      );
      let seen: { id: string }[] = [];
      if (people.length > 0) {
        await tx.execute(
          sql`SELECT set_config('app.user_id', ${userId}, true),
                     set_config('app.scope', ${scope}, true),
                     set_config('app.location_ids', ${locationIds.join(",")}, true),
                     set_config('app.scope_assigned', ${includesAssigned ? "true" : ""}, true),
                     set_config('app.scope_break_glass', ${includesBreakGlass ? "true" : ""}, true)`,
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
                 set_config('app.scope', ${before?.scope || "none"}, true),
                 set_config('app.location_ids', ${before?.location_ids ?? ""}, true),
                 set_config('app.scope_assigned', ${before?.assigned ?? ""}, true),
                 set_config('app.scope_break_glass', ${before?.break_glass ?? ""}, true)`,
    );
  }
  return result;
}

/** The permission a person's record, and so a task about them, is opened with. */
export const RECORD_READ_PERMISSION: Permission = "people.person.read";

/**
 * Of `tenantUserIds`, in their order, those who can see `personId` both with
 * `people.person.read` (to open the person, and a task about them) and with `permission` (to act
 * on it), each under their own scope for that permission (`staffViews`; ADR-0071 review round 1,
 * C-M4). A task about a person is only ever given to, or routed to, one of them: being its
 * assignee does not let anyone see a person their scope does not reach (`app.task_visible`).
 */
export async function membersSeeingPerson(
  tx: Transaction,
  tenantUserIds: readonly string[],
  personId: string,
  permission: Permission,
  now: Date,
): Promise<string[]> {
  if (tenantUserIds.length === 0) return [];
  const reads = await staffViews(tx, tenantUserIds, [personId], now, RECORD_READ_PERMISSION);
  const acts =
    permission === RECORD_READ_PERMISSION
      ? reads
      : await staffViews(tx, tenantUserIds, [personId], now, permission);
  return tenantUserIds.filter(
    (id) => reads.get(id)?.people.has(personId) && acts.get(id)?.people.has(personId),
  );
}
