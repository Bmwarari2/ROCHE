/**
 * Tombstones (security review S4): a record that entries which had not reached the server were
 * deleted from this device, with whose they were, how many, why and when. They are kept in the
 * keystore, outside the database the deletion removes, until they can be sent to the API as audit
 * events at the next sign-in.
 *
 * The API has no endpoint for audit events written on a device yet, so tombstones stay on the
 * device for now; the missing endpoint is listed as an API follow-up (care.md section 6). Each is
 * a separate keystore item, because some keystores refuse values over 2 KB, and the reason is
 * capped for the same reason. Only opaque ids and the staff member's own words are stored; logs
 * never carry them.
 */

export type TombstoneKind =
  /** "Sign out and delete N unsent entries" on held entries. */
  | "held_deleted"
  /** Held entries deleted when the hold reached `mobile.held_entries_max_days`. */
  | "held_expired"
  /** Sign-out from Settings or the lock screen with unsent entries on the device. */
  | "signed_out_with_unsent"
  /** One refused entry removed from "needs attention". */
  | "refused_removed";

export interface Tombstone {
  readonly kind: TombstoneKind;
  readonly tenantId: string | null;
  /** Who wrote the entries (tenant_user id), when known. */
  readonly ownerTenantUserId: string | null;
  /** How many entries were deleted; null when they could not be counted. */
  readonly count: number | null;
  /** Ids of the entries, when known (opaque UUIDs only). */
  readonly recordIds: readonly string[];
  readonly reason: string;
  readonly at: string;
}

export interface TombstoneStore {
  read(key: string): Promise<string | null>;
  write(key: string, value: string): Promise<void>;
}

export const TOMBSTONE_INDEX_ITEM = "harbour.tombstones.v1";
const ITEM_PREFIX = "harbour.tombstone.v1.";
/** Oldest first; the newest are kept when the list is full. */
export const MAX_TOMBSTONES = 40;
export const TOMBSTONE_REASON_MAX = 500;
const MAX_RECORD_IDS = 20;

function parseIndex(raw: string | null): string[] {
  if (!raw) return [];
  try {
    const value: unknown = JSON.parse(raw);
    return Array.isArray(value) ? value.filter((v): v is string => typeof v === "string") : [];
  } catch {
    return [];
  }
}

/** Keeps a tombstone; never throws, because a failed record must not block the deletion's report. */
export async function recordTombstone(
  store: TombstoneStore,
  tombstone: Tombstone,
  id: string,
): Promise<boolean> {
  try {
    const stored: Tombstone = {
      ...tombstone,
      reason: tombstone.reason.trim().slice(0, TOMBSTONE_REASON_MAX),
      recordIds: tombstone.recordIds.slice(0, MAX_RECORD_IDS),
    };
    await store.write(`${ITEM_PREFIX}${id}`, JSON.stringify(stored));
    const index = parseIndex(await store.read(TOMBSTONE_INDEX_ITEM));
    const next = [...index.filter((k) => k !== id), id].slice(-MAX_TOMBSTONES);
    await store.write(TOMBSTONE_INDEX_ITEM, JSON.stringify(next));
    return true;
  } catch {
    return false;
  }
}

/** The tombstones waiting to be sent, oldest first. */
export async function readTombstones(store: TombstoneStore): Promise<Tombstone[]> {
  const index = parseIndex(await store.read(TOMBSTONE_INDEX_ITEM).catch(() => null));
  const out: Tombstone[] = [];
  for (const id of index) {
    const raw = await store.read(`${ITEM_PREFIX}${id}`).catch(() => null);
    if (!raw) continue;
    try {
      out.push(JSON.parse(raw) as Tombstone);
    } catch {
      // A damaged item is skipped, never guessed.
    }
  }
  return out;
}
