/**
 * Tombstones (security review S4 and M1): a record that entries which had not reached the server
 * were deleted from this device, kept in the keystore, outside the database the deletion removes,
 * until the API acknowledges it (`POST /v1/sync/discards`, `src/sync/discards.ts`).
 *
 * A tombstone holds no personal data: a coded reason, the kind of deletion, opaque ids (tenant,
 * tenant_user, entry and person UUIDs), a count and the time. Free text never enters the keystore:
 * the person's own words travel only in the request made at the time of the deletion. Each
 * tombstone is a separate keystore item, because some keystores refuse values over 2 KB; items that
 * fall off the end of the list are deleted, and a tombstone is deleted once the server has it.
 *
 * Writing a tombstone throws when the keystore refuses it, and the caller then refuses the
 * deletion: a deletion that cannot be put on record does not happen (L4).
 */

import { t } from "../i18n/t";

/** Mirrors `SYNC_DISCARD_KINDS` in `@harbour/contracts`; a test keeps them equal. */
export const DISCARD_KINDS = ["held_deleted", "signed_out_with_unsent", "refused_removed"] as const;
export type DiscardKind = (typeof DISCARD_KINDS)[number];

/** Mirrors `SYNC_DISCARD_REASON_CODES` in `@harbour/contracts`; a test keeps them equal. */
export const DISCARD_REASON_CODES = [
  "recorded_elsewhere",
  "entered_in_error",
  "staff_left",
  "nurse_in_charge_informed",
  "other",
] as const;
export type DiscardReasonCode = (typeof DISCARD_REASON_CODES)[number];

export interface Tombstone {
  /** A UUID: also the discard's id at the API, so a replay is recorded once. */
  readonly id: string;
  readonly kind: DiscardKind;
  readonly reasonCode: DiscardReasonCode;
  readonly tenantId: string | null;
  /** Who wrote the entries (tenant_user id), when known. */
  readonly ownerTenantUserId: string | null;
  /** Who deleted them (tenant_user id): the owner, a manager, or the person signing out. */
  readonly deletedByTenantUserId: string | null;
  /** Ids of the entries, when known. */
  readonly entryIds: readonly string[];
  /** Ids of the people the entries were about, when known. */
  readonly personIds: readonly string[];
  /** How many entries were deleted; null when they could not be counted. */
  readonly count: number | null;
  readonly at: string;
}

export interface TombstoneStore {
  read(key: string): Promise<string | null>;
  write(key: string, value: string): Promise<void>;
  remove(key: string): Promise<void>;
}

export const TOMBSTONE_INDEX_ITEM = "harbour.tombstones.v2";
export const TOMBSTONE_ITEM_PREFIX = "harbour.tombstone.v2.";
/** Oldest first; the newest are kept when the list is full. */
export const MAX_TOMBSTONES = 40;
/** Keeps each item under 2 KB. */
export const MAX_TOMBSTONE_ENTRY_IDS = 20;
export const MAX_TOMBSTONE_PERSON_IDS = 10;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ISO_TIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/;

export function isOpaqueId(value: unknown): value is string {
  return typeof value === "string" && UUID.test(value);
}

const opaqueOrNull = (value: unknown): string | null => (isOpaqueId(value) ? value : null);

function opaqueList(value: unknown, max: number): string[] {
  if (!Array.isArray(value)) return [];
  return [...new Set(value.filter(isOpaqueId))].slice(0, max);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Keeps only what a tombstone may hold. Anything that is not an opaque id, a known code, a count
 * or a UTC time is dropped, so no free text can reach the keystore by mistake. Null when the
 * tombstone cannot be used at all.
 */
export function cleanTombstone(value: unknown): Tombstone | null {
  if (!isRecord(value)) return null;
  const kind = DISCARD_KINDS.find((k) => k === value.kind);
  const reasonCode = DISCARD_REASON_CODES.find((c) => c === value.reasonCode);
  if (!isOpaqueId(value.id) || !kind || !reasonCode) return null;
  if (typeof value.at !== "string" || !ISO_TIME.test(value.at)) return null;
  const count =
    typeof value.count === "number" && Number.isInteger(value.count) && value.count >= 0
      ? value.count
      : null;
  return {
    id: value.id.toLowerCase(),
    kind,
    reasonCode,
    tenantId: opaqueOrNull(value.tenantId),
    ownerTenantUserId: opaqueOrNull(value.ownerTenantUserId),
    deletedByTenantUserId: opaqueOrNull(value.deletedByTenantUserId),
    entryIds: opaqueList(value.entryIds, MAX_TOMBSTONE_ENTRY_IDS),
    personIds: opaqueList(value.personIds, MAX_TOMBSTONE_PERSON_IDS),
    count,
    at: value.at,
  };
}

function parseIndex(raw: string | null): string[] {
  if (!raw) return [];
  try {
    const value: unknown = JSON.parse(raw);
    return Array.isArray(value) ? value.filter(isOpaqueId) : [];
  } catch {
    return [];
  }
}

/** Thrown when a tombstone cannot be kept; the deletion it was for is refused. */
export class TombstoneWriteError extends Error {
  constructor() {
    super(t("mobile.discard.notRecorded"));
    this.name = "TombstoneWriteError";
  }
}

/**
 * Keeps a tombstone. Throws `TombstoneWriteError` when it cannot be kept, so the caller refuses
 * the deletion. Items that fall off the end of the list are deleted from the keystore.
 */
export async function recordTombstone(store: TombstoneStore, tombstone: Tombstone): Promise<void> {
  const stored = cleanTombstone(tombstone);
  if (!stored) throw new TombstoneWriteError();
  try {
    await store.write(`${TOMBSTONE_ITEM_PREFIX}${stored.id}`, JSON.stringify(stored));
    const index = parseIndex(await store.read(TOMBSTONE_INDEX_ITEM));
    const all = [...index.filter((k) => k !== stored.id), stored.id];
    const kept = all.slice(-MAX_TOMBSTONES);
    await store.write(TOMBSTONE_INDEX_ITEM, JSON.stringify(kept));
    for (const dropped of all.slice(0, all.length - kept.length)) {
      await store.remove(`${TOMBSTONE_ITEM_PREFIX}${dropped}`).catch(() => undefined);
    }
  } catch {
    throw new TombstoneWriteError();
  }
}

/** The server has the tombstone (or will never accept it): it leaves the keystore. */
export async function acknowledgeTombstone(store: TombstoneStore, id: string): Promise<void> {
  const index = parseIndex(await store.read(TOMBSTONE_INDEX_ITEM));
  await store.write(TOMBSTONE_INDEX_ITEM, JSON.stringify(index.filter((k) => k !== id)));
  await store.remove(`${TOMBSTONE_ITEM_PREFIX}${id}`);
}

const LEGACY_INDEX_ITEM = "harbour.tombstones.v1";
const LEGACY_ITEM_PREFIX = "harbour.tombstone.v1.";

/** Deletes tombstones in the earlier format, which could hold the reason in words (M1). */
export async function purgeLegacyTombstones(store: TombstoneStore): Promise<void> {
  const index = parseIndex(await store.read(LEGACY_INDEX_ITEM).catch(() => null));
  for (const id of index) {
    await store.remove(`${LEGACY_ITEM_PREFIX}${id}`).catch(() => undefined);
  }
  await store.remove(LEGACY_INDEX_ITEM).catch(() => undefined);
}

/** The tombstones waiting to be sent, oldest first. A damaged item is skipped, never guessed. */
export async function readTombstones(store: TombstoneStore): Promise<Tombstone[]> {
  const index = parseIndex(await store.read(TOMBSTONE_INDEX_ITEM).catch(() => null));
  const out: Tombstone[] = [];
  for (const id of index) {
    const raw = await store.read(`${TOMBSTONE_ITEM_PREFIX}${id}`).catch(() => null);
    if (!raw) continue;
    try {
      const tombstone = cleanTombstone(JSON.parse(raw));
      if (tombstone) out.push(tombstone);
    } catch {
      // Skipped.
    }
  }
  return out;
}
