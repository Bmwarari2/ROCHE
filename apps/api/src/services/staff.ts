import type { StaffName } from "@harbour/contracts";
import { type Transaction, tenantUser } from "@harbour/db";
import { NON_STAFF_ROLE_KEYS, PORTAL_ONLY_PERMISSIONS } from "@harbour/domain";
import { and, inArray, isNull, type SQL, sql } from "drizzle-orm";

/**
 * Staff names on records (care.md section 5, staff names; data-standards.md; records of
 * processing): where a response names a member of staff by id (who recorded, sent, published,
 * completed or acknowledged something), it also gives their display name and job title, for
 * Regulation 17 attribution. Read inside the caller's transaction, so row-level security keeps
 * them to the caller's organisation, and only for records the route has already let the caller
 * read. Never their email or anything else about them.
 */

export type StaffLookup = (id: string | null | undefined) => StaffName | null;

/** No names: for responses built where no staff were named. */
export const NO_STAFF: StaffLookup = () => null;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** Most ids read in one query; a response rarely names more than a few members. */
const CHUNK = 500;

/** Looks up the names of the staff ids given (nulls and repeats ignored). */
export async function staffNames(
  tx: Transaction,
  ids: Iterable<string | null | undefined>,
): Promise<StaffLookup> {
  const wanted = [
    ...new Set([...ids].filter((v): v is string => typeof v === "string" && UUID.test(v))),
  ];
  if (wanted.length === 0) return NO_STAFF;
  const byId = new Map<string, StaffName>();
  for (let i = 0; i < wanted.length; i += CHUNK) {
    const rows = await tx
      .select({
        id: tenantUser.id,
        displayName: tenantUser.displayName,
        jobTitle: tenantUser.jobTitle,
      })
      .from(tenantUser)
      .where(inArray(tenantUser.id, wanted.slice(i, i + CHUNK)));
    for (const row of rows) byId.set(row.id, row);
  }
  return (id) => (id ? (byId.get(id) ?? null) : null);
}

const PORTAL = sql.raw(`ARRAY[${PORTAL_ONLY_PERMISSIONS.map((p) => `'${p}'`).join(", ")}]::text[]`);
const NON_STAFF = sql.raw(`ARRAY[${NON_STAFF_ROLE_KEYS.map((k) => `'${k}'`).join(", ")}]::text[]`);

/**
 * Who is a colleague to choose (workforce.md section 5; plan slice 58): an invited or active
 * member, not deleted, holding a role now in force (started, not ended, not archived) that is
 * neither a portal role nor one for people who are not the provider's staff (inspectors, visiting
 * professionals, agency workers). The picker lists only these, and naming an interview panel or a
 * case member refuses anyone else, so a crafted request cannot reach past the picker.
 */
export function isColleague(): SQL {
  return and(
    inArray(tenantUser.status, ["invited", "active"]),
    isNull(tenantUser.deletedAt),
    sql`EXISTS (SELECT 1 FROM role_assignment ra
                  JOIN role r ON r.tenant_id = ra.tenant_id AND r.id = ra.role_id
                 WHERE ra.tenant_id = ${tenantUser.tenantId}
                   AND ra.tenant_user_id = ${tenantUser.id}
                   AND ra.deleted_at IS NULL
                   AND ra.valid_from <= now()
                   AND (ra.valid_to IS NULL OR ra.valid_to > now())
                   AND r.archived_at IS NULL
                   AND r.key <> ALL (${NON_STAFF})
                   AND NOT (r.permissions && ${PORTAL}))`,
  ) as SQL;
}

/** Whether every id given is a colleague (repeats ignored). */
export async function allColleagues(tx: Transaction, ids: readonly string[]): Promise<boolean> {
  const wanted = [...new Set(ids)];
  if (wanted.length === 0) return true;
  const found = await tx
    .select({ id: tenantUser.id })
    .from(tenantUser)
    .where(and(inArray(tenantUser.id, wanted), isColleague()));
  return found.length === wanted.length;
}
