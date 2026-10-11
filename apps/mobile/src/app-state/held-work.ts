/**
 * Entries held on the device when the session ends (hazard HZ-006, loss of offline records; the
 * security review S2 to S5 and the clinical review C8).
 *
 * The API answers 401 both when a session is revoked and when it simply expired (sessions last 12
 * hours, while a device may work offline for the whole offline window). Wiping on every 401 would
 * destroy notes and observations written overnight. So when the session ends:
 *
 * - nothing waiting to upload (queue, refused and held entries all empty): sign out and wipe;
 * - entries waiting: copy PowerSync's upload queue into the local-only `held_entry` table, keep
 *   the refused entries in `upload_issue`, and clear everything else synced (identities, NHS
 *   numbers, resuscitation decisions, care plans), so only the unsent work stays, encrypted, for a
 *   limited time (`mobile.held_entries_max_days`). Uploads stop and the sign-in screen names whose
 *   entries they are and how many.
 *
 * Ownership fails closed (S3): the owner (tenant_user) is written inside the encrypted database
 * and checked before the device connects; a keystore error reads as "held, owner unknown"; a
 * database without a recorded owner is never opened for the next person. Only the owner resumes,
 * and their entries go back into the queue. Anyone else is refused, so entries are never sent under
 * someone else's name.
 *
 * Deleting held entries needs device authentication and a reason, leaves a tombstone (S4), and is
 * checked: the marker is cleared only once the file and its key are gone (S5).
 *
 * Pure apart from the injected dependencies, so the rules are unit-tested.
 */
import { AppSchema, DEVICE_WRITABLE_TABLES } from "@harbour/sync/client";
import type { Me } from "../auth/auth-client";
import type { FieldError } from "../care/entries";
import { t } from "../i18n/t";
import { databaseFilename } from "../security/db-key";
import type { Tombstone } from "./tombstones";

// -------------------------------------------------------------------------------------------------
// The marker in the keystore: who owns the held entries, how many, and until when
// -------------------------------------------------------------------------------------------------

/** Who owns the held entries, how many there were when the session ended, and until when. */
export interface HeldWork {
  readonly tenantId: string;
  /** The owner's tenant_user id, when known. */
  readonly tenantUserId: string | null;
  /** The owner's sign-in (auth user) id, compared when the tenant_user id is not known. */
  readonly userId: string;
  /** The owner's name, so the sign-in screen can say whose entries are waiting (C8). */
  readonly ownerName: string | null;
  /** Queued, refused and held entries when the session ended; null if they could not be counted. */
  readonly entries: number | null;
  readonly heldAt: string;
  /** When the hold ends and the entries are deleted; null when unknown (never automatic). */
  readonly expiresAt: string | null;
}

/** Held, with nobody able to resume: a damaged marker or a keystore that could not be read. */
export const UNKNOWN_OWNER: HeldWork = {
  tenantId: "",
  tenantUserId: null,
  userId: "",
  ownerName: null,
  entries: null,
  heldAt: "",
  expiresAt: null,
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

const text = (value: unknown): string | null => (typeof value === "string" && value ? value : null);

export function serialiseHeldWork(held: HeldWork): string {
  return JSON.stringify(held);
}

/** Reads the stored marker; anything unreadable is treated as held with an unknown owner. */
export function parseHeldWork(raw: string | null | undefined): HeldWork | null {
  if (!raw) return null;
  try {
    const value: unknown = JSON.parse(raw);
    if (!isRecord(value)) throw new Error("not an object");
    return {
      tenantId: typeof value.tenantId === "string" ? value.tenantId : "",
      tenantUserId: text(value.tenantUserId),
      userId: typeof value.userId === "string" ? value.userId : "",
      ownerName: text(value.ownerName),
      entries:
        typeof value.entries === "number" && Number.isInteger(value.entries) && value.entries >= 0
          ? value.entries
          : null,
      heldAt: typeof value.heldAt === "string" ? value.heldAt : "",
      expiresAt: text(value.expiresAt),
    };
  } catch {
    // Never let a damaged marker release entries to whoever signs in next.
    return UNKNOWN_OWNER;
  }
}

/**
 * Reads the marker, failing closed (S3): when the keystore cannot be read, the entries are held
 * with an unknown owner, unless the keystore says there is no database at all.
 */
export async function readHeldMarker(deps: {
  readonly readMarker: () => Promise<string | null>;
  readonly readDatabaseId: () => Promise<string | null>;
}): Promise<HeldWork | null> {
  try {
    return parseHeldWork(await deps.readMarker());
  } catch {
    try {
      if ((await deps.readDatabaseId()) === null) return null;
    } catch {
      // Nothing can be read: assume the worst.
    }
    return UNKNOWN_OWNER;
  }
}

// -------------------------------------------------------------------------------------------------
// Counting the unsent work
// -------------------------------------------------------------------------------------------------

export interface PendingCounts {
  /** Changes in PowerSync's upload queue. */
  readonly queued: number;
  /** Entries the server refused, kept in `upload_issue`. */
  readonly refused: number;
  /** Entries copied out of the queue when a session ended, kept in `held_entry`. */
  readonly held: number;
}

export function totalPending(counts: PendingCounts): number {
  return counts.queued + counts.refused + counts.held;
}

/** Counts the unsent work on the device: the upload queue, refused entries and held entries. */
export async function countPendingWork(db: {
  getUploadQueueStats(): Promise<{ count: number }>;
  getOptional<T>(sql: string, params?: unknown[]): Promise<T | null>;
}): Promise<PendingCounts> {
  const [stats, refused, held] = await Promise.all([
    db.getUploadQueueStats(),
    db.getOptional<{ count: number }>("SELECT COUNT(*) AS count FROM upload_issue"),
    db.getOptional<{ count: number }>("SELECT COUNT(*) AS count FROM held_entry"),
  ]);
  return {
    queued: stats.count,
    refused: Number(refused?.count ?? 0),
    held: Number(held?.count ?? 0),
  };
}

// -------------------------------------------------------------------------------------------------
// The owner inside the encrypted database (S3)
// -------------------------------------------------------------------------------------------------

/** `sync_meta` row naming the member of staff the database belongs to. */
export const OWNER_META_ID = "meta:owner";
const OWNER_META_KEY = "owner";

export interface DeviceOwner {
  readonly tenantId: string;
  readonly tenantUserId: string | null;
  readonly userId: string;
  readonly name: string | null;
}

export function ownerOf(me: Me): DeviceOwner {
  return {
    tenantId: me.tenant.id,
    tenantUserId: me.tenantUserId,
    userId: me.user.id,
    name: me.user.name || null,
  };
}

type MetaDb = {
  getOptional<T>(sql: string, params?: unknown[]): Promise<T | null>;
  execute(sql: string, params?: unknown[]): Promise<unknown>;
};

/**
 * The owner recorded in the database: null when none is recorded; "unreadable" when the row is
 * there but damaged or the read fails (treated as someone else's, never as the reader's).
 */
export async function readDeviceOwner(db: MetaDb): Promise<DeviceOwner | null | "unreadable"> {
  let row: { value: string | null } | null;
  try {
    row = await db.getOptional<{ value: string | null }>(
      "SELECT value FROM sync_meta WHERE id = ?",
      [OWNER_META_ID],
    );
  } catch {
    return "unreadable";
  }
  if (!row) return null;
  try {
    const value: unknown = JSON.parse(row.value ?? "");
    if (!isRecord(value) || typeof value.tenantId !== "string" || typeof value.userId !== "string")
      return "unreadable";
    return {
      tenantId: value.tenantId,
      tenantUserId: text(value.tenantUserId),
      userId: value.userId,
      name: text(value.name),
    };
  } catch {
    return "unreadable";
  }
}

export async function writeDeviceOwner(db: MetaDb, owner: DeviceOwner): Promise<void> {
  await db.execute("DELETE FROM sync_meta WHERE id = ?", [OWNER_META_ID]);
  await db.execute("INSERT INTO sync_meta (id, key, value) VALUES (?, ?, ?)", [
    OWNER_META_ID,
    OWNER_META_KEY,
    JSON.stringify(owner),
  ]);
}

interface OwnerLike {
  readonly tenantId: string;
  readonly tenantUserId: string | null;
  readonly userId: string;
}

/** True when `me` is the owner: same tenant, then the tenant_user id, else the sign-in id. */
export function isSameOwner(owner: OwnerLike, me: Me): boolean {
  if (!owner.tenantId || owner.tenantId !== me.tenant.id) return false;
  if (owner.tenantUserId && me.tenantUserId) return owner.tenantUserId === me.tenantUserId;
  return owner.userId !== "" && owner.userId === me.user.id;
}

/** True when the person signing in owns the held entries. */
export function isHeldWorkOwner(held: HeldWork, me: Me): boolean {
  return isSameOwner(held, me);
}

/**
 * Before the device connects (S3): "owner" carries on; "claim" records the signed-in person on a
 * database just created for them; "other" is a database that belongs to someone else, or to nobody
 * known, and is never opened for this person: its unsent work is held for its owner, or it is
 * wiped when there is none.
 */
export function checkDeviceOwner(
  stored: DeviceOwner | null | "unreadable",
  me: Me,
  createdNow: boolean,
): "owner" | "claim" | "other" {
  if (stored === "unreadable") return "other";
  if (stored === null) return createdNow ? "claim" : "other";
  return isSameOwner(stored, me) ? "owner" : "other";
}

// -------------------------------------------------------------------------------------------------
// Holding only the unsent work (S2) and putting it back for its owner
// -------------------------------------------------------------------------------------------------

export interface CrudLike {
  readonly op: string;
  readonly table: string;
  readonly id: string;
  readonly opData?: Record<string, unknown> | undefined;
}

interface TxLike {
  execute(sql: string, params?: unknown[]): Promise<unknown>;
  getOptional<T>(sql: string, params?: unknown[]): Promise<T | null>;
}

export interface HoldDb extends MetaDb {
  getCrudBatch(limit?: number): Promise<{ readonly crud: readonly CrudLike[] } | null>;
  getAll<T>(sql: string, params?: unknown[]): Promise<T[]>;
  writeTransaction<T>(callback: (tx: TxLike) => Promise<T>): Promise<T>;
  disconnectAndClear(options?: { clearLocal?: boolean }): Promise<void>;
}

/** Large enough for any queue a device builds offline; the whole queue is copied in one batch. */
const WHOLE_QUEUE = 1_000_000;

/** Bookkeeping rows that stay when the device is cleared: the owner and the hold's time limit. */
export const KEPT_META_IDS = [OWNER_META_ID, "meta:held-entries-max-days"] as const;

/**
 * Copies the upload queue into `held_entry`, then clears every synced table and the queue
 * (`disconnectAndClear` without the local-only tables) and the bookkeeping except the owner. What
 * is left is the unsent work only: held entries and refused entries. Idempotent: a copy repeated
 * after a crash replaces the same rows.
 */
export async function holdUnsentWork(db: HoldDb, now: Date): Promise<number> {
  const batch = await db.getCrudBatch(WHOLE_QUEUE);
  const crud = batch?.crud ?? [];
  const existing = await db.getOptional<{ position: number | null }>(
    "SELECT MAX(position) AS position FROM held_entry",
  );
  const start = Number(existing?.position ?? 0);
  await db.writeTransaction(async (tx) => {
    let position = start;
    for (const entry of crud) {
      position += 1;
      const data = entry.opData ?? {};
      await tx.execute("DELETE FROM held_entry WHERE id = ?", [entry.id]);
      await tx.execute(
        `INSERT INTO held_entry (id, tenant_id, person_id, record_table, op, payload, position,
          held_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          entry.id,
          text(data.tenant_id),
          text(data.person_id),
          entry.table,
          entry.op,
          JSON.stringify(data),
          position,
          now.toISOString(),
        ],
      );
    }
  });
  await db.disconnectAndClear({ clearLocal: false });
  await db.execute(
    `DELETE FROM sync_meta WHERE id NOT IN (${KEPT_META_IDS.map(() => "?").join(", ")})`,
    [...KEPT_META_IDS],
  );
  return crud.length;
}

const WRITABLE = new Set<string>(DEVICE_WRITABLE_TABLES);

function columnsOf(table: string): ReadonlySet<string> {
  const definition = AppSchema.tables.find((t) => t.name === table);
  return new Set(definition ? definition.columns.map((c) => c.name) : []);
}

export interface HeldEntryRow {
  readonly id: string;
  readonly tenant_id: string | null;
  readonly person_id: string | null;
  readonly record_table: string | null;
  readonly op: string | null;
  readonly payload: string | null;
}

/**
 * The owner is back: every held entry goes back into its table, which puts it into the upload
 * queue again with the same id (the API ignores a replay), in the order it was written. An entry
 * already on the device is left alone. Anything that cannot go back (not a new care entry) moves to
 * "needs attention" with its content, so nothing is dropped. Returns how many went back.
 */
export async function restoreHeldWork(
  db: HoldDb,
  now: Date,
): Promise<{ readonly restored: number; readonly parked: number }> {
  const rows = await db.getAll<HeldEntryRow>(
    "SELECT id, tenant_id, person_id, record_table, op, payload FROM held_entry ORDER BY position, id",
  );
  let restored = 0;
  let parked = 0;
  await db.writeTransaction(async (tx) => {
    for (const row of rows) {
      const table = row.record_table ?? "";
      let data: Record<string, unknown> = {};
      try {
        const parsed: unknown = JSON.parse(row.payload ?? "{}");
        if (isRecord(parsed)) data = parsed;
      } catch {
        data = {};
      }
      if (row.op === "PUT" && WRITABLE.has(table)) {
        // Table names come from the fixed list above and columns from the schema, never from data.
        const present = await tx.getOptional<{ id: string }>(
          `SELECT id FROM ${table} WHERE id = ?`,
          [row.id],
        );
        if (!present) {
          const allowed = columnsOf(table);
          const columns = Object.keys(data).filter((c) => allowed.has(c));
          await tx.execute(
            `INSERT INTO ${table} (id${columns.map((c) => `, ${c}`).join("")}) VALUES (?${columns
              .map(() => ", ?")
              .join("")})`,
            [row.id, ...columns.map((c) => toSql(data[c]))],
          );
        }
        restored += 1;
      } else {
        await tx.execute("DELETE FROM upload_issue WHERE id = ?", [row.id]);
        await tx.execute(
          `INSERT INTO upload_issue (id, tenant_id, person_id, record_table, http_status, code,
            message, payload, rejected_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          [
            row.id,
            row.tenant_id,
            row.person_id,
            table || null,
            null,
            "held_not_restored",
            t("mobile.held.notRestored"),
            row.payload,
            now.toISOString(),
          ],
        );
        parked += 1;
      }
      await tx.execute("DELETE FROM held_entry WHERE id = ?", [row.id]);
    }
  });
  return { restored, parked };
}

function toSql(value: unknown): string | number | null {
  if (value === null || value === undefined) return null;
  if (typeof value === "number" || typeof value === "string") return value;
  if (typeof value === "boolean") return value ? 1 : 0;
  return JSON.stringify(value);
}

// -------------------------------------------------------------------------------------------------
// The session ended
// -------------------------------------------------------------------------------------------------

export interface SessionEndedDeps {
  /** Null when no database is open, so nothing can be counted. */
  readonly countPending: () => Promise<PendingCounts | null>;
  /** Who was signed in. */
  readonly owner: Me | null;
  readonly now: Date;
  /** When the hold would end (from `mobile.held_entries_max_days`). */
  readonly expiresAt: Date | null;
  readonly wipe: () => Promise<void>;
  readonly hold: (held: HeldWork) => Promise<void>;
}

/**
 * The session ended (401 or 403 from the sync token, an upload or `/v1/me`). Wipes only when the
 * device holds nothing unsent; otherwise holds it for its owner. When the count fails, the entries
 * are kept: losing care records is the worse outcome.
 */
export async function handleSessionEnded(deps: SessionEndedDeps): Promise<"wiped" | "held"> {
  let counts: PendingCounts | null;
  try {
    counts = await deps.countPending();
  } catch {
    counts = null;
  }
  if (counts && totalPending(counts) === 0) {
    await deps.wipe();
    return "wiped";
  }
  await deps.hold({
    tenantId: deps.owner?.tenant.id ?? "",
    tenantUserId: deps.owner?.tenantUserId ?? null,
    userId: deps.owner?.user.id ?? "",
    ownerName: deps.owner?.user.name || null,
    entries: counts ? totalPending(counts) : null,
    heldAt: deps.now.toISOString(),
    expiresAt: deps.expiresAt ? deps.expiresAt.toISOString() : null,
  });
  return "held";
}

// -------------------------------------------------------------------------------------------------
// Signing in while entries are held
// -------------------------------------------------------------------------------------------------

/** Someone other than the owner tried to sign in while entries are held. */
export class HeldWorkOwnerError extends Error {
  constructor() {
    super(t("mobile.held.otherUser"));
    this.name = "HeldWorkOwnerError";
  }
}

export interface SignInDeps {
  readonly held: HeldWork | null;
  readonly me: Me;
  readonly token: string;
  /** Ends the new session on the server; best effort. */
  readonly signOut: (token: string) => Promise<void>;
}

/**
 * Admits a sign-in. With held entries, only their owner gets in (and resumes the uploads); the
 * new session of anyone else is ended and refused with a message.
 */
export async function admitSignIn(deps: SignInDeps): Promise<"continue" | "resume"> {
  if (!deps.held) return "continue";
  if (isHeldWorkOwner(deps.held, deps.me)) return "resume";
  await deps.signOut(deps.token).catch(() => undefined);
  throw new HeldWorkOwnerError();
}

// -------------------------------------------------------------------------------------------------
// Deleting unsent entries (S4, S5)
// -------------------------------------------------------------------------------------------------

/** API-style limits for the reason, like a correction's. */
export const DISCARD_REASON_LIMITS = { min: 3, max: 500 } as const;

/** Deleting entries that never reached the server always says why (S4, C2). */
export function checkDiscardReason(reason: string): FieldError | null {
  const length = reason.trim().length;
  if (length < DISCARD_REASON_LIMITS.min) {
    return { key: "mobile.discard.reasonRequired", values: { min: DISCARD_REASON_LIMITS.min } };
  }
  if (length > DISCARD_REASON_LIMITS.max) {
    return { key: "mobile.discard.reasonTooLong", values: { max: DISCARD_REASON_LIMITS.max } };
  }
  return null;
}

/** The file or its key was still there after deleting: the entries stay held (S5). */
export class DiscardIncompleteError extends Error {
  constructor() {
    super(t("mobile.held.discardIncomplete"));
    this.name = "DiscardIncompleteError";
  }
}

export interface DiscardDeps {
  /** The database id from the keystore's plain bookkeeping (no biometric prompt needed). */
  readonly readDatabaseId: () => Promise<string | null>;
  readonly deleteDatabaseFile: (filename: string) => void;
  readonly destroyKey: () => Promise<void>;
  /** True once nothing of the file is left. */
  readonly databaseGone: (filename: string) => Promise<boolean>;
  /** True while any of the key or its bookkeeping is still in the keystore. */
  readonly keyRemains: () => Promise<boolean>;
  readonly recordTombstone: (tombstone: Tombstone) => Promise<unknown>;
  readonly tombstone: Tombstone;
  readonly clearHeld: () => Promise<void>;
  readonly demo: boolean;
}

/**
 * Deletes the database file and checks it is gone, keeps the tombstone (S4), then destroys the key
 * and checks that too; only then is the marker cleared (S5). If the file or the key remains, the
 * entries stay held and the error says so, and a retry finds the same file again.
 */
export async function discardHeldWork(deps: DiscardDeps): Promise<void> {
  const id = await deps.readDatabaseId().catch(() => null);
  let filename: string | null = null;
  if (id) {
    try {
      filename = databaseFilename(id, deps.demo);
    } catch {
      // An id that is not a database id names no file; the key is destroyed below all the same.
    }
  }
  // The file first, checked, while its id is still known, so a retry can find it again.
  if (filename) {
    deps.deleteDatabaseFile(filename);
    if (!(await deps.databaseGone(filename).catch(() => false))) {
      throw new DiscardIncompleteError();
    }
  }
  // The entries are gone: on record (S4), then the key, checked too (S5).
  await deps.recordTombstone(deps.tombstone);
  await deps.destroyKey();
  if (await deps.keyRemains().catch(() => true)) throw new DiscardIncompleteError();
  await deps.clearHeld();
}
