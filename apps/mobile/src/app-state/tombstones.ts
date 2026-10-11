/**
 * Tombstones (security reviews S4, M1 and round 4 M2, clinical review round 4 H1): a record that
 * entries which had not reached the server were deleted from this device, kept in the keystore,
 * outside the database the deletion removes, until the API has every stage of it
 * (`POST /v1/sync/discards`, `src/sync/discards.ts`).
 *
 * A deletion has stages: "requested" is recorded before anything is deleted; "deleted" only once
 * the file and its key are gone; "failed" when they are not, which supersedes the request. The
 * tombstone keeps the stage reached and the stages the server has not yet acknowledged.
 *
 * A tombstone holds no personal data: a coded reason, the kind and stage, opaque ids (tenant,
 * tenant_user, entry and person UUIDs), a count and the time. Free text never enters the keystore
 * and is never sent: Harbour records only the coded reason. Each tombstone is a separate keystore
 * item, because some keystores refuse values over 2 KB.
 *
 * A record the server has not acknowledged is never dropped. When the list is full, only records
 * the server already has make room; if none does, the new deletion is refused (round 4, M2). A
 * finished deletion leaves the keystore once the server has all of it.
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

/** Mirrors `SYNC_DISCARD_STAGES` in `@harbour/contracts`; a test keeps them equal. */
export const DISCARD_STAGES = ["requested", "deleted", "failed"] as const;
export type DiscardStage = (typeof DISCARD_STAGES)[number];
export type DiscardOutcome = Exclude<DiscardStage, "requested">;

export interface Tombstone {
  /** A UUID: also the discard's id at the API, so a replay of a stage is recorded once. */
  readonly id: string;
  readonly kind: DiscardKind;
  readonly reasonCode: DiscardReasonCode;
  /** The stage the deletion has reached on the device. */
  readonly stage: DiscardStage;
  /** Stages the server has not acknowledged yet, in the order they happened. */
  readonly unsent: readonly DiscardStage[];
  readonly tenantId: string | null;
  /** Who wrote the entries (tenant_user id), when known. */
  readonly ownerTenantUserId: string | null;
  /** Who deleted them (tenant_user id): the owner, a manager, or the person signing out. */
  readonly deletedByTenantUserId: string | null;
  /** Ids of the entries, when known (all of them in memory; a sample in the keystore). */
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
/** Oldest first. A new deletion is refused while this many wait for the server. */
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

const asStage = (value: unknown): DiscardStage | undefined =>
  DISCARD_STAGES.find((s) => s === value);

/**
 * The stages still to send. A record from before stages existed has only its request, which the
 * server may not have: it is sent again (a replay is harmless).
 */
function unsentStages(value: Record<string, unknown>, stage: DiscardStage): DiscardStage[] {
  if (!Array.isArray(value.unsent)) return [stage];
  const stages = value.unsent.map(asStage).filter((s): s is DiscardStage => s !== undefined);
  return DISCARD_STAGES.filter((s) => stages.includes(s));
}

/**
 * Keeps only what a tombstone may hold. Anything that is not an opaque id, a known code or stage,
 * a count or a UTC time is dropped, so no free text can reach the keystore by mistake. Null when
 * the tombstone cannot be used at all.
 */
export function cleanTombstone(value: unknown): Tombstone | null {
  if (!isRecord(value)) return null;
  const kind = DISCARD_KINDS.find((k) => k === value.kind);
  const reasonCode = DISCARD_REASON_CODES.find((c) => c === value.reasonCode);
  if (!isOpaqueId(value.id) || !kind || !reasonCode) return null;
  if (typeof value.at !== "string" || !ISO_TIME.test(value.at)) return null;
  if (value.stage !== undefined && asStage(value.stage) === undefined) return null;
  const stage = asStage(value.stage) ?? "requested";
  const count =
    typeof value.count === "number" && Number.isInteger(value.count) && value.count >= 0
      ? value.count
      : null;
  return {
    id: value.id.toLowerCase(),
    kind,
    reasonCode,
    stage,
    unsent: unsentStages(value, stage),
    tenantId: opaqueOrNull(value.tenantId),
    ownerTenantUserId: opaqueOrNull(value.ownerTenantUserId),
    deletedByTenantUserId: opaqueOrNull(value.deletedByTenantUserId),
    entryIds: opaqueList(value.entryIds, MAX_TOMBSTONE_ENTRY_IDS),
    personIds: opaqueList(value.personIds, MAX_TOMBSTONE_PERSON_IDS),
    count,
    at: value.at,
  };
}

/** True when the server has every stage the device reached. */
export function isAcknowledged(tombstone: Tombstone): boolean {
  return tombstone.unsent.length === 0;
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

const itemKey = (id: string) => `${TOMBSTONE_ITEM_PREFIX}${id}`;

/** Thrown when a tombstone cannot be kept; the deletion it was for is refused. */
export class TombstoneWriteError extends Error {
  /** True when the list is full of records the server does not have yet. */
  readonly full: boolean;

  constructor(full = false) {
    super(t(full ? "mobile.discard.tooManyWaiting" : "mobile.discard.notRecorded"));
    this.name = "TombstoneWriteError";
    this.full = full;
  }
}

/** One tombstone from the keystore: null when it is missing, "damaged" when it cannot be read. */
async function readItem(store: TombstoneStore, id: string): Promise<Tombstone | null | "damaged"> {
  const raw = await store.read(itemKey(id));
  if (raw === null) return null;
  try {
    return cleanTombstone(JSON.parse(raw)) ?? "damaged";
  } catch {
    return "damaged";
  }
}

/**
 * Keeps a tombstone, or updates one already kept (its next stage). Throws `TombstoneWriteError`
 * when it cannot be kept, so the caller refuses the deletion. A new tombstone on a full list makes
 * room only by dropping records the server already has, oldest first; otherwise it is refused.
 */
export async function recordTombstone(store: TombstoneStore, tombstone: Tombstone): Promise<void> {
  const stored = cleanTombstone(tombstone);
  if (!stored) throw new TombstoneWriteError();
  let full = false;
  try {
    const index = parseIndex(await store.read(TOMBSTONE_INDEX_ITEM));
    if (index.includes(stored.id)) {
      await store.write(itemKey(stored.id), JSON.stringify(stored));
      return;
    }
    let kept = index;
    const excess = index.length + 1 - MAX_TOMBSTONES;
    if (excess > 0) {
      const droppable: string[] = [];
      for (const id of index) {
        if (droppable.length >= excess) break;
        const item = await readItem(store, id).catch(() => "damaged" as const);
        // Only a record the server has (or an index entry with no record behind it) makes room.
        if (item === null || (item !== "damaged" && isAcknowledged(item))) droppable.push(id);
      }
      if (droppable.length < excess) {
        full = true;
        throw new TombstoneWriteError(true);
      }
      kept = index.filter((id) => !droppable.includes(id));
      for (const id of droppable) await store.remove(itemKey(id)).catch(() => undefined);
    }
    await store.write(itemKey(stored.id), JSON.stringify(stored));
    await store.write(TOMBSTONE_INDEX_ITEM, JSON.stringify([...kept, stored.id]));
  } catch {
    throw new TombstoneWriteError(full);
  }
}

/** Reads one tombstone; null when it is not kept or cannot be read. */
export async function readTombstone(store: TombstoneStore, id: string): Promise<Tombstone | null> {
  const item = await readItem(store, id).catch(() => null);
  return item === "damaged" ? null : item;
}

/** Removes a tombstone: the deletion was withdrawn before anything was deleted. */
export async function removeTombstone(store: TombstoneStore, id: string): Promise<void> {
  const index = parseIndex(await store.read(TOMBSTONE_INDEX_ITEM));
  await store.write(TOMBSTONE_INDEX_ITEM, JSON.stringify(index.filter((k) => k !== id)));
  await store.remove(itemKey(id));
}

/**
 * The server has one stage. A finished deletion (deleted or failed) that the server has entirely
 * leaves the keystore; a request the server has stays, acknowledged, until its outcome is known.
 */
export async function acknowledgeStage(
  store: TombstoneStore,
  id: string,
  stage: DiscardStage,
): Promise<void> {
  const current = await readTombstone(store, id);
  if (!current) return;
  const unsent = current.unsent.filter((s) => s !== stage);
  if (unsent.length === 0 && current.stage !== "requested") {
    await removeTombstone(store, id);
    return;
  }
  await store.write(itemKey(id), JSON.stringify({ ...current, unsent }));
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

/** The tombstones kept, oldest first. A damaged item is skipped, never guessed. */
export async function readTombstones(store: TombstoneStore): Promise<Tombstone[]> {
  const index = parseIndex(await store.read(TOMBSTONE_INDEX_ITEM).catch(() => null));
  const out: Tombstone[] = [];
  for (const id of index) {
    const item = await readItem(store, id).catch(() => null);
    if (item && item !== "damaged") out.push(item);
  }
  return out;
}
