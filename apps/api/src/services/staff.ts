import type { StaffName } from "@harbour/contracts";
import { type Transaction, tenantUser } from "@harbour/db";
import { inArray } from "drizzle-orm";

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
