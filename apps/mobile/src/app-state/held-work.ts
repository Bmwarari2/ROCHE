/**
 * Entries held on the device when the session ends (hazard HZ-006, loss of offline records; hazard
 * HZ-040, held entries deleted; the security reviews S2 to S5 and M1 to M3, and the clinical
 * reviews C8 and H2).
 *
 * The API answers 401 both when a session is revoked and when it simply expired (sessions last 12
 * hours, while a device may work offline for the whole offline window). Wiping on every 401 would
 * destroy notes and observations written overnight. So when the session ends:
 *
 * - nothing waiting to upload (queue, refused and held entries all empty): sign out and wipe;
 * - entries waiting: copy PowerSync's upload queue into the local-only `held_entry` table, keep
 *   the refused entries in `upload_issue`, and clear everything else synced (identities, NHS
 *   numbers, resuscitation decisions, care plans), so only the unsent work stays, encrypted. Uploads
 *   stop and the sign-in screen names whose entries they are and how many.
 *
 * Held entries are never deleted automatically. They stay encrypted until their owner signs in and
 * sends them, or until the owner or a manager signs in on the device and deletes them with a
 * reason. After `mobile.held_entries_max_days` the hold escalates: the device says a manager must
 * resolve it (`held-limit.ts`).
 *
 * Ownership fails closed (S3): the owner (tenant_user) is written inside the encrypted database
 * and checked before the device connects; a keystore error reads as "held, owner unknown"; a
 * database without a recorded owner is never opened for the next person. Only the owner resumes,
 * and their entries go back into the queue. Anyone else is refused, so entries are never sent under
 * someone else's name.
 *
 * Deleting held entries needs the owner's or a manager's sign-in (not only the device passcode),
 * device authentication and a coded reason; it is put on record as requested before anything is
 * deleted (a tombstone, sent to the API) and is checked: only once the file and its key are gone is
 * it recorded as deleted and the marker cleared (S5). A deletion that does not finish is recorded
 * as failed, and the entries left behind are never uploaded (clinical review round 4, H1).
 *
 * Pure apart from the injected dependencies, so the rules are unit-tested.
 */
import type { SyncDeviceReport } from "@harbour/contracts";
import { AppSchema, DEVICE_WRITABLE_TABLES } from "@harbour/sync/client";
import type { Me } from "../auth/auth-client";
import type { FieldError } from "../care/entries";
import { parseQueuedMove } from "../care/round-actions";
import { type MessageKey, t } from "../i18n/t";
import { type DatabaseKey, databaseFilename } from "../security/db-key";
import { buildDeviceReport, reportLocationIds } from "../sync/device-report";
import { HELD_FAIL_SAFE_DAYS, heldDeadline } from "../sync/held-limit";
import {
  type DiscardOutcome,
  type DiscardReasonCode,
  type IdsMissing,
  type Leftover,
  readTombstoneIndex,
  type TombstoneStore,
} from "./tombstones";

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
  /** When the hold escalates to a manager (nothing is deleted then). Never left open-ended (L2). */
  readonly expiresAt: string | null;
  /** The last time the device heard from the server before the hold, when known (clock sanity). */
  readonly lastServerTime: string | null;
  /**
   * A deletion of these entries was put on record but did not finish (clinical review round 4,
   * H1): they are never uploaded. When their owner signs in they move to "needs attention".
   */
  readonly uploadBlocked?: boolean;
  /**
   * A manager revoked this device (403 `device_revoked`; care.md section 6, Device integrity part
   * 2): everything else synced has gone, and the entries leave only by the hand-over (their owner's
   * or a manager's sign-in for that alone) or a recorded deletion. Nobody resumes syncing here.
   */
  readonly revoked?: boolean;
  /**
   * The locations of the owner's sync scope (opaque ids), which the hold's report names so the
   * manager's task goes where the owner works (clinical review round 6, M2).
   */
  readonly locationIds?: readonly string[];
}

/** The opaque ids of the locations in a person's sync scope, as a report carries them. */
export function locationIdsOf(me: Pick<Me, "locations"> | null): string[] {
  return reportLocationIds(me?.locations.map((l) => l.id) ?? []);
}

/** A list of location ids in a marker or owner record, or nothing when there are none. */
function storedLocations(value: unknown): { readonly locationIds?: readonly string[] } {
  const ids = reportLocationIds(value);
  return ids.length > 0 ? { locationIds: ids } : {};
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
  lastServerTime: null,
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

const text = (value: unknown): string | null => (typeof value === "string" && value ? value : null);

const isInstant = (value: string | null | undefined): value is string =>
  typeof value === "string" && value !== "" && !Number.isNaN(Date.parse(value));

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
      lastServerTime: text(value.lastServerTime),
      ...(value.uploadBlocked === true ? { uploadBlocked: true } : {}),
      ...(value.revoked === true ? { revoked: true } : {}),
      ...storedLocations(value.locationIds),
    };
  } catch {
    // Never let a damaged marker release entries to whoever signs in next.
    return UNKNOWN_OWNER;
  }
}

/**
 * A hold always has a deadline (L2): a marker without a usable one (an older marker, a damaged
 * one, or an unknown owner) gets now plus the fail-safe days. Returns the same object when nothing
 * changed.
 */
export function withDeadline(held: HeldWork, now: Date): HeldWork {
  if (isInstant(held.expiresAt) && isInstant(held.heldAt)) return held;
  return {
    ...held,
    heldAt: isInstant(held.heldAt) ? held.heldAt : now.toISOString(),
    expiresAt: isInstant(held.expiresAt)
      ? held.expiresAt
      : heldDeadline(now, HELD_FAIL_SAFE_DAYS).toISOString(),
  };
}

interface MarkerReaders {
  readonly readMarker: () => Promise<string | null>;
  readonly readDatabaseId: () => Promise<string | null>;
}

/**
 * Reads the marker, failing closed (S3): when the keystore cannot be read, the entries are held
 * with an unknown owner, unless the keystore says there is no database at all.
 */
export async function readHeldMarker(deps: MarkerReaders): Promise<HeldWork | null> {
  return (await loadHeldMarker(deps, null)).held;
}

/**
 * Reads the marker and gives it a deadline when it has none (L2). `save` says whether the marker
 * with its new deadline should be written back: only when the marker was actually read (or found
 * damaged), never after a keystore error, so a passing error cannot overwrite the real marker.
 */
export async function loadHeldMarker(
  deps: MarkerReaders,
  now: Date | null,
): Promise<{ readonly held: HeldWork | null; readonly save: boolean }> {
  let raw: string | null;
  try {
    raw = await deps.readMarker();
  } catch {
    let noDatabase = false;
    try {
      noDatabase = (await deps.readDatabaseId()) === null;
    } catch {
      // Nothing can be read: assume the worst.
    }
    if (noDatabase) return { held: null, save: false };
    return { held: now ? withDeadline(UNKNOWN_OWNER, now) : UNKNOWN_OWNER, save: false };
  }
  const parsed = parseHeldWork(raw);
  if (!parsed || !now) return { held: parsed, save: false };
  const held = withDeadline(parsed, now);
  return { held, save: held !== parsed };
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

export interface UnsentIds {
  readonly entryIds: string[];
  readonly personIds: string[];
  /** The organisations the entries belong to, as written in them. */
  readonly tenantIds: string[];
}

/**
 * The ids of the unsent work (opaque UUIDs only), of the people it was about and of their
 * organisations, for the record of a deletion: the upload queue, refused entries and held entries.
 */
export async function readUnsentIds(db: {
  getAll<T>(sql: string, params?: unknown[]): Promise<T[]>;
  getCrudBatch(limit?: number): Promise<{ readonly crud: readonly CrudLike[] } | null>;
}): Promise<UnsentIds> {
  type Row = { id: string; person_id: string | null; tenant_id: string | null };
  const [held, refused, batch] = await Promise.all([
    db.getAll<Row>("SELECT id, person_id, tenant_id FROM held_entry ORDER BY position, id"),
    db.getAll<Row>("SELECT id, person_id, tenant_id FROM upload_issue ORDER BY rejected_at, id"),
    db.getCrudBatch(WHOLE_QUEUE),
  ]);
  const queued: Row[] = (batch?.crud ?? []).map((entry) => ({
    id: entry.id,
    person_id: text(entry.opData?.person_id),
    tenant_id: text(entry.opData?.tenant_id),
  }));
  const rows = [...queued, ...held, ...refused];
  const present = (values: (string | null)[]) => [
    ...new Set(values.filter((v): v is string => !!v)),
  ];
  return {
    entryIds: [...new Set(rows.map((r) => r.id))],
    personIds: present(rows.map((r) => r.person_id)),
    tenantIds: present(rows.map((r) => r.tenant_id)),
  };
}

/**
 * Before a manager deletes entries whose owner is unknown (security review round 4, low): the
 * entries must name the manager's organisation, and no other. Nothing to delete passes.
 */
export function heldEntriesInTenant(ids: UnsentIds, tenantId: string): boolean {
  if (ids.entryIds.length === 0) return true;
  return ids.tenantIds.length > 0 && ids.tenantIds.every((id) => id === tenantId);
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
  /** The locations of the owner's sync scope when last opened (clinical review round 6, M2). */
  readonly locationIds?: readonly string[];
}

export function ownerOf(me: Me): DeviceOwner {
  const locations = locationIdsOf(me);
  return {
    tenantId: me.tenant.id,
    tenantUserId: me.tenantUserId,
    userId: me.user.id,
    name: me.user.name || null,
    ...(locations.length > 0 ? { locationIds: locations } : {}),
  };
}

/** True when the stored owner record names the same locations as the person's scope now. */
function sameLocations(stored: DeviceOwner, me: Me): boolean {
  const now = locationIdsOf(me);
  const before = stored.locationIds ?? [];
  return now.length === before.length && now.every((id, i) => id === before[i]);
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
      ...storedLocations(value.locationIds),
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
  getUploadQueueStats(): Promise<{ count: number }>;
  writeTransaction<T>(callback: (tx: TxLike) => Promise<T>): Promise<T>;
  disconnectAndClear(options?: { clearLocal?: boolean }): Promise<void>;
}

/** Large enough for any queue a device builds offline; the whole queue is copied in one batch. */
const WHOLE_QUEUE = 1_000_000;

/** Bookkeeping rows that stay when the device is cleared: the owner and the hold's time limit. */
export const KEPT_META_IDS = [OWNER_META_ID, "meta:held-entries-max-days"] as const;

/**
 * `sync_meta` rows keeping the person's own words for a deletion, which never leave the device
 * (security review round 4, M3); they stay when the device is cleared, until it is wiped.
 */
export const DISCARD_NOTE_PREFIX = "discard-note:";

/**
 * Deletes the words kept for deletions the server now has in full: their tombstones have left the
 * keystore (security review round 5, S-L4; retention class in docs/specs/data-standards.md). Words
 * for a deletion still waiting stay. Nothing is deleted when the keystore cannot be read.
 */
export async function forgetDiscardNotes(
  db: {
    getAll<T>(sql: string, params?: unknown[]): Promise<T[]>;
    execute(sql: string, params?: unknown[]): Promise<unknown>;
  },
  store: TombstoneStore,
): Promise<number> {
  const kept = new Set(await readTombstoneIndex(store));
  const notes = await db.getAll<{ id: string }>("SELECT id FROM sync_meta WHERE id LIKE ?", [
    `${DISCARD_NOTE_PREFIX}%`,
  ]);
  let forgotten = 0;
  for (const note of notes) {
    if (kept.has(note.id.slice(DISCARD_NOTE_PREFIX.length))) continue;
    await db.execute("DELETE FROM sync_meta WHERE id = ?", [note.id]);
    forgotten += 1;
  }
  return forgotten;
}

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
      const held = heldRecordOf(entry);
      await tx.execute("DELETE FROM held_entry WHERE id = ?", [held.id]);
      await tx.execute(
        `INSERT INTO held_entry (id, tenant_id, person_id, record_table, op, payload, position,
          held_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          held.id,
          held.tenantId,
          held.personId,
          entry.table,
          entry.op,
          JSON.stringify(held.payload),
          position,
          now.toISOString(),
        ],
      );
    }
  });
  await db.disconnectAndClear({ clearLocal: false });
  await db.execute(
    `DELETE FROM sync_meta WHERE id NOT IN (${KEPT_META_IDS.map(() => "?").join(", ")}) AND id NOT LIKE ?`,
    [...KEPT_META_IDS, `${DISCARD_NOTE_PREFIX}%`],
  );
  return crud.length;
}

const WRITABLE = new Set<string>(DEVICE_WRITABLE_TABLES);

/**
 * How a queued change is held: an entry or an acknowledgement under its own id; a task's move
 * under the move's own id (never the task's), with the task's id kept in the payload, so a move
 * never replaces another held or parked record for the same task (#36 review round 1, M1). The
 * move carries its tenant and person, which the update itself does not.
 */
function heldRecordOf(entry: {
  readonly table: string;
  readonly id: string;
  readonly opData?: Record<string, unknown> | undefined;
}): {
  readonly id: string;
  readonly tenantId: string | null;
  readonly personId: string | null;
  readonly payload: Record<string, unknown>;
} {
  const data = entry.opData ?? {};
  const move = entry.table === "task" ? parseQueuedMove(data.queued_transition) : null;
  if (move) {
    return {
      id: move.id,
      tenantId: move.tenantId,
      personId: move.personId,
      payload: { ...data, task_id: entry.id },
    };
  }
  return {
    id: entry.id,
    tenantId: text(data.tenant_id),
    personId: text(data.person_id),
    payload: data,
  };
}

/**
 * Whether a held change goes back into the queue for its owner (#36 review round 1, clinical M1):
 * a new care entry or acknowledgement, and a task's move whose task is named, exactly as entries
 * are. Anything else moves to "needs attention".
 */
function resendable(row: HeldEntryRow): boolean {
  const table = row.record_table ?? "";
  if (row.op === "PUT" && (WRITABLE.has(table) || table === "handover_acknowledgement"))
    return true;
  if (table !== "task" || row.op !== "PATCH") return false;
  const data = payloadOf(row);
  return typeof data.task_id === "string" && parseQueuedMove(data.queued_transition) !== null;
}

function payloadOf(row: HeldEntryRow): Record<string, unknown> {
  try {
    const parsed: unknown = JSON.parse(row.payload ?? "{}");
    return isRecord(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

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

export interface RestoreResult {
  /** Put back into the upload queue. */
  readonly restored: number;
  /** Moved to "needs attention" with their content (cannot be resent, or putting back failed). */
  readonly parked: number;
  /** Still held: neither put back nor moved, so the marker stays (clinical review M2). */
  readonly remaining: number;
}

/** Why a held entry moved to "needs attention" instead of going back into the queue. */
export type ParkCode = "held_not_restored" | "held_restore_failed" | "held_discard_failed";

const PARK_MESSAGE_KEYS: Record<ParkCode, MessageKey> = {
  held_not_restored: "mobile.held.notRestored",
  held_restore_failed: "mobile.held.notRestored",
  held_discard_failed: "mobile.held.discardFailedEntry",
};

async function park(tx: TxLike, row: HeldEntryRow, code: ParkCode, now: Date): Promise<void> {
  await tx.execute("DELETE FROM upload_issue WHERE id = ?", [row.id]);
  await tx.execute(
    `INSERT INTO upload_issue (id, tenant_id, person_id, record_table, http_status, code,
      message, payload, rejected_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      row.id,
      row.tenant_id,
      row.person_id,
      row.record_table || null,
      null,
      code,
      t(PARK_MESSAGE_KEYS[code]),
      row.payload,
      now.toISOString(),
    ],
  );
  await tx.execute("DELETE FROM held_entry WHERE id = ?", [row.id]);
}

async function putBack(tx: TxLike, row: HeldEntryRow): Promise<void> {
  const table = row.record_table ?? "";
  const data = payloadOf(row);
  if (table === "task") {
    await putBackMove(tx, row, data);
    return;
  }
  // Table names come from the fixed list of writable tables and columns from the schema, never
  // from the data.
  const present = await tx.getOptional<{ id: string }>(`SELECT id FROM ${table} WHERE id = ?`, [
    row.id,
  ]);
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
  await tx.execute("DELETE FROM held_entry WHERE id = ?", [row.id]);
}

/**
 * A held move goes back on its task: the same update when the task is on the device again, or the
 * task's row with the move when it is not (the session's end cleared it), either of which puts the
 * move into the upload queue again with its own id.
 */
async function putBackMove(
  tx: TxLike,
  row: HeldEntryRow,
  data: Record<string, unknown>,
): Promise<void> {
  const taskId = String(data.task_id);
  const status = toSql(data.status);
  const queued = toSql(data.queued_transition);
  const present = await tx.getOptional<{ id: string }>("SELECT id FROM task WHERE id = ?", [
    taskId,
  ]);
  if (present) {
    await tx.execute("UPDATE task SET status = ?, queued_transition = ? WHERE id = ?", [
      status,
      queued,
      taskId,
    ]);
  } else {
    await tx.execute(
      "INSERT INTO task (id, tenant_id, person_id, status, queued_transition) VALUES (?, ?, ?, ?, ?)",
      [taskId, row.tenant_id, row.person_id, status, queued],
    );
  }
  await tx.execute("DELETE FROM held_entry WHERE id = ?", [row.id]);
}

/**
 * The owner is back: every held entry goes back into its table, which puts it into the upload
 * queue again with the same id (the API ignores a replay), in the order it was written. An entry
 * already on the device is left alone. Each entry goes back in its own transaction. One that
 * cannot go back (not a new care entry, or putting it back fails) moves to "needs attention" with
 * its content; one that cannot even be moved stays held and is counted, so nothing is dropped and
 * nothing is hidden (clinical review M2).
 *
 * After a deletion that did not finish (`blocked`), nothing goes back into the queue: every entry
 * moves to "needs attention", to be checked and removed with a reason (clinical review round 4,
 * H1).
 */
export async function restoreHeldWork(
  db: HoldDb,
  now: Date,
  blocked = false,
): Promise<RestoreResult> {
  const rows = await db.getAll<HeldEntryRow>(
    "SELECT id, tenant_id, person_id, record_table, op, payload FROM held_entry ORDER BY position, id",
  );
  let restored = 0;
  let parked = 0;
  let remaining = 0;
  for (const row of rows) {
    if (blocked) {
      try {
        await db.writeTransaction((tx) => park(tx, row, "held_discard_failed", now));
        parked += 1;
      } catch {
        remaining += 1;
      }
      continue;
    }
    const goesBack = resendable(row);
    try {
      await db.writeTransaction((tx) =>
        goesBack ? putBack(tx, row) : park(tx, row, "held_not_restored", now),
      );
      if (goesBack) restored += 1;
      else parked += 1;
    } catch {
      try {
        await db.writeTransaction((tx) => park(tx, row, "held_restore_failed", now));
        parked += 1;
      } catch {
        remaining += 1;
      }
    }
  }
  return { restored, parked, remaining };
}

function toSql(value: unknown): string | number | null {
  if (value === null || value === undefined) return null;
  if (typeof value === "number" || typeof value === "string") return value;
  if (typeof value === "boolean") return value ? 1 : 0;
  return JSON.stringify(value);
}

// -------------------------------------------------------------------------------------------------
// Opening the database: the owner check before the device connects (S3, L4)
// -------------------------------------------------------------------------------------------------

export interface OpenCheckDeps {
  readonly db: HoldDb;
  /** Who is signing in. */
  readonly me: Me | null;
  /** True when the key, and so the database, was made just now. */
  readonly created: boolean;
  /** True when this is already the second attempt after deleting someone's empty database. */
  readonly afterReset: boolean;
  readonly now: Date;
  /** The tenant's `mobile.held_entries_max_days` from the database's bookkeeping, if cached. */
  readonly cachedHeldMaxDays: () => Promise<number | null>;
  /** The held marker says a deletion did not finish: nothing here is ever uploaded (round 4, H1). */
  readonly uploadBlocked?: boolean;
  /** The held marker says a manager revoked this device: kept on any new marker. */
  readonly revoked?: boolean;
  /** Closes and deletes this database and destroys its key, so a new one is made. */
  readonly reset: () => Promise<void>;
  /** Closes the database, keeping the file and its key. */
  readonly closeKeeping: () => Promise<void>;
}

export type OpenOutcome =
  /** The owner (or a new database's first user): connect, after putting held entries back. */
  | { readonly kind: "connect"; readonly restore: RestoreResult | "failed" }
  /** Someone else's database with nothing unsent: deleted, so open a new one. */
  | { readonly kind: "reopen" }
  /** Someone else's unsent work: held for them, and this sign-in is refused. */
  | {
      readonly kind: "refused";
      readonly held: HeldWork;
      /** The hold's counts and oldest age for the server, when they could be read. */
      readonly report: SyncDeviceReport | null;
    };

/** Opening a database for someone else went wrong twice: refuse rather than loop. */
export class VaultResetError extends Error {
  constructor() {
    super(t("mobile.vault.resetFailed"));
    this.name = "VaultResetError";
  }
}

/**
 * Decides what happens to a database just opened, before anything connects. The database names its
 * owner; it is never opened for anyone else. Someone else's database is deleted when nothing in it
 * is unsent, and otherwise only its unsent work is kept, held for its owner. The owner's held
 * entries go back into the upload queue; a failure there is reported, never swallowed.
 */
export async function admitToDatabase(deps: OpenCheckDeps): Promise<OpenOutcome> {
  if (!deps.me) throw new HeldWorkOwnerError();
  const stored = await readDeviceOwner(deps.db);
  const check = checkDeviceOwner(stored, deps.me, deps.created);
  if (check === "other") {
    const counts = await countPendingWork(deps.db).catch(() => null);
    if (counts && totalPending(counts) === 0) {
      await deps.reset();
      if (deps.afterReset) throw new VaultResetError();
      return { kind: "reopen" };
    }
    const days = (await deps.cachedHeldMaxDays().catch(() => null)) ?? HELD_FAIL_SAFE_DAYS;
    // Only the unsent work stays (S2). If the copy fails, the whole database stays encrypted
    // rather than losing entries.
    await holdUnsentWork(deps.db, deps.now).catch(() => 0);
    const report = await buildDeviceReport(deps.db, deps.now).catch(() => null);
    await deps.closeKeeping();
    const owner = stored && stored !== "unreadable" ? stored : null;
    return {
      kind: "refused",
      report,
      held: {
        tenantId: owner?.tenantId ?? "",
        tenantUserId: owner?.tenantUserId ?? null,
        userId: owner?.userId ?? "",
        ownerName: owner?.name ?? null,
        entries: counts ? totalPending(counts) : null,
        heldAt: deps.now.toISOString(),
        expiresAt: heldDeadline(deps.now, days).toISOString(),
        lastServerTime: null,
        ...(deps.uploadBlocked ? { uploadBlocked: true } : {}),
        ...(deps.revoked ? { revoked: true } : {}),
        ...storedLocations(owner?.locationIds),
      },
    };
  }
  if (check === "claim") await writeDeviceOwner(deps.db, ownerOf(deps.me));
  // The owner's locations as they are now, for a hold's report later (clinical review round 6,
  // M2). Best effort: the owner check above does not depend on them.
  if (check === "owner" && stored && stored !== "unreadable" && !sameLocations(stored, deps.me)) {
    await writeDeviceOwner(deps.db, ownerOf(deps.me)).catch(() => undefined);
  }
  if (deps.uploadBlocked) {
    // Anything still in the upload queue is held first, so that nothing of it is sent either.
    const held = await holdUnsentWork(deps.db, deps.now).then(
      () => true,
      () => false,
    );
    if (!held) return { kind: "connect", restore: "failed" };
  }
  const restore = await restoreHeldWork(deps.db, deps.now, deps.uploadBlocked === true).catch(
    () => "failed" as const,
  );
  return { kind: "connect", restore };
}

/**
 * Held entries from a deletion that did not finish could not all be moved to "needs attention",
 * so the device does not connect (clinical review round 4, H1 and M4).
 */
export class RestoreFailedError extends Error {
  constructor() {
    // Its own words: these entries will never be sent (clinical review round 5, C-L6).
    super(t("mobile.vault.restoreBlockedFailed"));
    this.name = "RestoreFailedError";
  }
}

/**
 * What the person sees when held entries could not all be put back (clinical review round 4, M4):
 * a whole restore that failed, or entries still held. Null when everything is back. Entries a
 * failed deletion left are never sent, so their failure says so (clinical review round 5, C-L6).
 */
export function restoreProblem(restore: RestoreResult | "failed", blocked = false): string | null {
  if (blocked && !restoreComplete(restore)) return t("mobile.vault.restoreBlockedFailed");
  if (restore === "failed") return t("mobile.vault.restoreFailed");
  if (restore.remaining > 0) {
    return t("mobile.vault.restoreIncomplete", { count: restore.remaining });
  }
  return null;
}

/** True when the owner's held entries are all back (or parked), so the marker can go. */
export function restoreComplete(restore: RestoreResult | "failed"): boolean {
  return restore !== "failed" && restore.remaining === 0;
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
  /** When the hold escalates (from `mobile.held_entries_max_days`); null for the fail-safe. */
  readonly expiresAt: Date | null;
  /** The last time the device heard from the server, when known. */
  readonly lastServerTime: Date | null;
  readonly wipe: () => Promise<void>;
  readonly hold: (held: HeldWork) => Promise<void>;
  /**
   * A manager revoked the device (403 `device_revoked`), rather than the session ending: the same
   * remote wipe, and a hold is marked revoked (care.md section 6, Device integrity part 2).
   */
  readonly revoked?: boolean;
}

/**
 * The session ended (401 or a session-level 403 from the sync token, an upload or `/v1/me`), or a
 * manager revoked the device. Wipes only when the device holds nothing unsent; otherwise holds it
 * for its owner (marked revoked when it was). When the count fails, the entries are kept: losing
 * care records is the worse outcome.
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
    expiresAt: (deps.expiresAt ?? heldDeadline(deps.now, HELD_FAIL_SAFE_DAYS)).toISOString(),
    lastServerTime: deps.lastServerTime ? deps.lastServerTime.toISOString() : null,
    ...(deps.revoked ? { revoked: true } : {}),
    ...storedLocations(locationIdsOf(deps.owner)),
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
 * A manager revoked this device: nobody resumes syncing on it, not even the entries' owner. The
 * entries leave by the hand-over or a recorded deletion (care.md section 6, Device integrity).
 */
export class HeldRevokedError extends Error {
  constructor() {
    super(t("mobile.held.revokedSignIn"));
    this.name = "HeldRevokedError";
  }
}

/**
 * Admits a sign-in. With held entries, only their owner gets in (and resumes the uploads); the
 * new session of anyone else is ended and refused with a message. The marker stays until the vault
 * has put the entries back. On a revoked device nobody resumes: the sign-in is ended and refused,
 * and the entries wait for the hand-over or a recorded deletion.
 */
export async function admitSignIn(deps: SignInDeps): Promise<"continue" | "resume"> {
  if (!deps.held) return "continue";
  if (!deps.held.revoked && isHeldWorkOwner(deps.held, deps.me)) return "resume";
  await deps.signOut(deps.token).catch(() => undefined);
  throw deps.held.revoked ? new HeldRevokedError() : new HeldWorkOwnerError();
}

// -------------------------------------------------------------------------------------------------
// Deleting unsent entries (S4, S5, M1 to M3)
// -------------------------------------------------------------------------------------------------

/**
 * The permission that lets a manager delete another member of staff's unsent entries, the same
 * one the API asks for (`apps/api/src/routes/sync.ts`): Registered Manager, deputy, clinical lead
 * and owner.
 */
export const DISCARD_OTHERS_PERMISSION = "safety.incident.manage";

/**
 * Who may delete held entries on a shared device (M2): the member of staff who wrote them, or a
 * manager in the same tenant, signed in on the device. The device passcode alone is not enough.
 * When the owner is unknown (a damaged marker), only a manager may.
 */
export function canDiscardHeld(held: HeldWork, signer: Me): boolean {
  if (isHeldWorkOwner(held, signer)) return true;
  if (!signer.permissions.includes(DISCARD_OTHERS_PERMISSION)) return false;
  return held.tenantId === "" || held.tenantId === signer.tenant.id;
}

/** The person who signed in to delete held entries is neither their owner nor a manager. */
export class HeldDiscardNotAllowedError extends Error {
  constructor() {
    super(t("mobile.held.discardNotAllowed"));
    this.name = "HeldDiscardNotAllowedError";
  }
}

/** A reason for deleting: a code from the list, and words where they are allowed. */
export interface DiscardReason {
  readonly reasonCode: DiscardReasonCode | null;
  readonly reason: string;
}

/** Limits for the words, like a correction's at the API. */
export const DISCARD_REASON_LIMITS = { min: 3, max: 500 } as const;

/**
 * Deleting entries that never reached the server always says why (S4, C2, M1). The person's own
 * words never leave the device (security review round 4, M3): they are kept in the encrypted
 * database, so they are allowed only where that database stays (`withWords`, removing a refused
 * entry). Deleting held entries, or signing out, deletes the database too, so there the reason is
 * one of the listed codes, never "Other".
 */
export function checkDiscardReason(
  choice: DiscardReason,
  options: { readonly withWords?: boolean } = {},
): FieldError | null {
  if (!choice.reasonCode) return { key: "mobile.discard.reasonCodeRequired" };
  if (!options.withWords) {
    return choice.reasonCode === "other" ? { key: "mobile.discard.reasonCodeRequired" } : null;
  }
  const length = choice.reason.trim().length;
  if (choice.reasonCode === "other" && length < DISCARD_REASON_LIMITS.min) {
    return { key: "mobile.discard.reasonRequired", values: { min: DISCARD_REASON_LIMITS.min } };
  }
  if (length > 0 && length < DISCARD_REASON_LIMITS.min) {
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

/**
 * The key could be read but the entries could not, so the record of the deletion could not say
 * which entries it removed: nothing is deleted (clinical reviews round 4 M3 and round 5 C-M2).
 */
export class HeldIdsUnreadableError extends Error {
  constructor() {
    super(t("mobile.held.idsUnreadable"));
    this.name = "HeldIdsUnreadableError";
  }
}

/**
 * The key is there but could not be read this time (for example the face or fingerprint prompt was
 * cancelled): nothing is deleted, and the person is asked to try again (clinical review round 5,
 * C-M2).
 */
export class KeyNotReadError extends Error {
  constructor() {
    super(t("mobile.held.keyNotRead"));
    this.name = "KeyNotReadError";
  }
}

/**
 * The entries could not be marked never to be uploaded, so nothing is deleted (clinical review
 * round 5, C-L1).
 */
export class UploadBlockError extends Error {
  constructor() {
    super(t("mobile.discard.blockFailed"));
    this.name = "UploadBlockError";
  }
}

/** The ids a deletion records, or why there are none (clinical review round 5, C-M2). */
export type HeldIds =
  | { readonly kind: "ids"; readonly ids: UnsentIds }
  | { readonly kind: "none"; readonly reason: IdsMissing };

export interface HeldIdsDeps {
  /** The key's plain bookkeeping (database id and protection), read without a prompt. */
  readonly readBookkeeping: () => Promise<{
    readonly id: string | null;
    readonly protection: string | null;
  }>;
  /** Reads the key, which shows the face or fingerprint prompt; null when it is not a valid key. */
  readonly readKey: () => Promise<DatabaseKey | null>;
  /** Device authentication when reading the key did not prompt (passcode keys, or no key). */
  readonly confirmIdentity: () => Promise<void>;
  /** Opens the database with the key and reads the unsent entries' ids. */
  readonly readIds: (key: DatabaseKey) => Promise<UnsentIds>;
}

/**
 * The ids of the entries a deletion removes, read before anything is deleted (clinical reviews
 * round 4 M3 and round 5 C-M2). Reading the key is the device authentication; a key that could not
 * be read this time refuses the deletion and asks to try again, and so does a key that was read
 * when the entries could not be. A deletion goes ahead without ids only when nothing could ever be
 * read: there is no key at all, or the key kept is not a valid one; the reason is recorded.
 */
export async function readHeldIds(deps: HeldIdsDeps): Promise<HeldIds> {
  let book: { readonly id: string | null; readonly protection: string | null };
  try {
    book = await deps.readBookkeeping();
  } catch {
    throw new KeyNotReadError();
  }
  if (book.id === null && book.protection === null) {
    await deps.confirmIdentity();
    return { kind: "none", reason: "key_absent" };
  }
  let key: DatabaseKey | null;
  try {
    key = await deps.readKey();
  } catch {
    throw new KeyNotReadError();
  }
  if (!key) {
    await deps.confirmIdentity();
    return { kind: "none", reason: "key_invalid" };
  }
  if (key.protection === "passcode") await deps.confirmIdentity();
  try {
    return { kind: "ids", ids: await deps.readIds(key) };
  } catch {
    throw new HeldIdsUnreadableError();
  }
}

/** How a deletion ended, and what of the database it left on the device. */
export interface DeletionOutcome {
  readonly outcome: DiscardOutcome;
  readonly leftover: readonly Leftover[];
}

/**
 * "failed" only while the entries can still be read: the file, its key and the rows inside all
 * remain. Otherwise the entries are gone for good, so "deleted", naming any part of the database
 * left behind, which is reported as a security event of its own (clinical review round 5, C-M1).
 */
export function deletionOutcome(state: {
  readonly fileRemains: boolean;
  readonly keyRemains: boolean;
  readonly rowsRemain: boolean;
}): DeletionOutcome {
  const leftover: Leftover[] = [];
  if (state.fileRemains) leftover.push("file");
  if (state.keyRemains) leftover.push("key");
  const readable = state.fileRemains && state.keyRemains && state.rowsRemain;
  return { outcome: readable ? "failed" : "deleted", leftover };
}

export interface DiscardDeps {
  /** The database id from the keystore's plain bookkeeping (no biometric prompt needed). */
  readonly readDatabaseId: () => Promise<string | null>;
  /**
   * Clears the rows inside the open database and closes it, before its file goes; true when the
   * rows were cleared. Absent for held entries, whose database is already closed and whose rows go
   * with the file.
   */
  readonly clearRows?: () => Promise<boolean>;
  readonly deleteDatabaseFile: (filename: string) => void;
  readonly destroyKey: () => Promise<void>;
  /** True once nothing of the file is left. */
  readonly databaseGone: (filename: string) => Promise<boolean>;
  /** True while any of the key or its bookkeeping is still in the keystore. */
  readonly keyRemains: () => Promise<boolean>;
  /**
   * Puts the deletion on record as requested (the tombstone, and the request to the API). Throws
   * when it cannot, and then nothing is deleted.
   */
  readonly putOnRecord: () => Promise<unknown>;
  /** Records how the deletion ended, with what it left behind. Never throws. */
  readonly recordOutcome: (
    outcome: DiscardOutcome,
    leftover: readonly Leftover[],
  ) => Promise<unknown>;
  /**
   * Marks the entries as never to be uploaded (the held marker), before anything is deleted, so a
   * deletion cut short never uploads what it left. Throws when the marker cannot be written.
   */
  readonly blockUploads: () => Promise<void>;
  readonly clearHeld: () => Promise<void>;
  readonly demo: boolean;
}

/**
 * Deletes unsent entries for good, checked at each step (S5; clinical reviews round 4 H1 and round
 * 5 C-M1 and C-L1). Used for held entries and for signing out with entries unsent:
 *
 * 1. the database id is read; if it cannot be, nothing is deleted (L4: the file is never skipped);
 * 2. the deletion is put on record as requested; if it cannot be, nothing is deleted (M1, M2);
 * 3. the entries are marked never to be uploaded; if they cannot be, "failed" is recorded and
 *    nothing is deleted;
 * 4. the rows are cleared (when the database is open), the file deleted and the key destroyed,
 *    each checked;
 * 5. while the file, the key and the rows all remain, the entries can still be read: "failed" is
 *    recorded, superseding the request, and the entries stay held and blocked for a retry.
 *    Otherwise "deleted" is recorded, with any part of the database left behind, and the marker
 *    clears.
 */
export async function discardHeldWork(deps: DiscardDeps): Promise<DeletionOutcome> {
  let id: string | null;
  try {
    id = await deps.readDatabaseId();
  } catch {
    throw new DiscardIncompleteError();
  }
  let filename: string | null = null;
  if (id) {
    try {
      filename = databaseFilename(id, deps.demo);
    } catch {
      // An id that is not a database id names no file; the key is destroyed below all the same.
    }
  }
  await deps.putOnRecord();
  try {
    await deps.blockUploads();
  } catch {
    await deps.recordOutcome("failed", []).catch(() => undefined);
    throw new UploadBlockError();
  }
  const rowsCleared = deps.clearRows ? await deps.clearRows().catch(() => false) : false;
  let fileRemains = false;
  if (filename) {
    try {
      deps.deleteDatabaseFile(filename);
    } catch {
      // Checked below.
    }
    fileRemains = !(await deps.databaseGone(filename).catch(() => false));
  }
  // The key goes even when the file stays: without it the file cannot be read (S5).
  await deps.destroyKey().catch(() => undefined);
  const keyRemains = await deps.keyRemains().catch(() => true);
  const result = deletionOutcome({ fileRemains, keyRemains, rowsRemain: !rowsCleared });
  await deps.recordOutcome(result.outcome, result.leftover).catch(() => undefined);
  if (result.outcome === "failed") throw new DiscardIncompleteError();
  await deps.clearHeld();
  return result;
}
