/**
 * Entries held on the device when the session ends (hazard HZ-006, loss of offline records).
 *
 * The API answers 401 both when a session is revoked and when it simply expired (Better Auth
 * sessions last 12 hours, while a device may work offline for the whole offline window). Wiping on
 * every 401 would destroy notes and observations written overnight without signal. So when the
 * session ends:
 *
 * - nothing waiting to upload (queue empty, no refused entries): sign out and wipe, as before;
 * - entries waiting: keep the encrypted database (SQLCipher, key behind device authentication),
 *   stop uploading, and ask for sign-in again. Only the member of staff who owns the entries (the
 *   same tenant_user) can resume; anyone else is refused, so entries are never sent under someone
 *   else's name. "Sign out and delete N unsent entries", after a confirmation naming the count,
 *   clears a lost device or a leaver's entries.
 *
 * Pure apart from the injected dependencies, so the rules are unit-tested.
 */
import type { Me } from "../auth/auth-client";
import { t } from "../i18n/t";
import { databaseFilename } from "../security/db-key";

/** Who owns the held entries, and how many there were when the session ended. */
export interface HeldWork {
  readonly tenantId: string;
  /** The owner's tenant_user id, when known. */
  readonly tenantUserId: string | null;
  /** The owner's sign-in (auth user) id, compared when the tenant_user id is not known. */
  readonly userId: string;
  /** Queued plus refused entries when the session ended; null if they could not be counted. */
  readonly entries: number | null;
  readonly heldAt: string;
}

export interface PendingCounts {
  /** Changes in PowerSync's upload queue. */
  readonly queued: number;
  /** Entries the server refused, kept in `upload_issue`. */
  readonly refused: number;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

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
      tenantUserId: typeof value.tenantUserId === "string" ? value.tenantUserId : null,
      userId: typeof value.userId === "string" ? value.userId : "",
      entries:
        typeof value.entries === "number" && Number.isInteger(value.entries) && value.entries >= 0
          ? value.entries
          : null,
      heldAt: typeof value.heldAt === "string" ? value.heldAt : "",
    };
  } catch {
    // Never let a damaged marker release entries to whoever signs in next.
    return { tenantId: "", tenantUserId: null, userId: "", entries: null, heldAt: "" };
  }
}

/** Counts the unsent work on the device: the upload queue and the refused entries. */
export async function countPendingWork(db: {
  getUploadQueueStats(): Promise<{ count: number }>;
  getOptional<T>(sql: string, params?: unknown[]): Promise<T | null>;
}): Promise<PendingCounts> {
  const [stats, refused] = await Promise.all([
    db.getUploadQueueStats(),
    db.getOptional<{ count: number }>("SELECT COUNT(*) AS count FROM upload_issue"),
  ]);
  return { queued: stats.count, refused: Number(refused?.count ?? 0) };
}

export interface SessionEndedDeps {
  /** Null when no database is open, so nothing can be counted. */
  readonly countPending: () => Promise<PendingCounts | null>;
  /** Who was signed in. */
  readonly owner: Me | null;
  readonly now: Date;
  readonly wipe: () => Promise<void>;
  readonly hold: (held: HeldWork) => Promise<void>;
}

/**
 * The session ended (401 or 403 from the sync token, an upload or `/v1/me`). Wipes only when the
 * device holds nothing unsent; otherwise keeps it for its owner. When the count fails, the entries
 * are kept: losing care records is the worse outcome.
 */
export async function handleSessionEnded(deps: SessionEndedDeps): Promise<"wiped" | "held"> {
  let counts: PendingCounts | null;
  try {
    counts = await deps.countPending();
  } catch {
    counts = null;
  }
  if (counts && counts.queued + counts.refused === 0) {
    await deps.wipe();
    return "wiped";
  }
  await deps.hold({
    tenantId: deps.owner?.tenant.id ?? "",
    tenantUserId: deps.owner?.tenantUserId ?? null,
    userId: deps.owner?.user.id ?? "",
    entries: counts ? counts.queued + counts.refused : null,
    heldAt: deps.now.toISOString(),
  });
  return "held";
}

/** True when the person signing in owns the held entries. */
export function isHeldWorkOwner(held: HeldWork, me: Me): boolean {
  if (!held.tenantId || held.tenantId !== me.tenant.id) return false;
  if (held.tenantUserId && me.tenantUserId) return held.tenantUserId === me.tenantUserId;
  return held.userId !== "" && held.userId === me.user.id;
}

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

export interface DiscardDeps {
  /** The database id from the keystore's plain bookkeeping (no biometric prompt needed). */
  readonly readDatabaseId: () => Promise<string | null>;
  readonly deleteDatabaseFile: (filename: string) => void;
  readonly destroyKey: () => Promise<void>;
  readonly clearHeld: () => Promise<void>;
  readonly demo: boolean;
}

/**
 * "Sign out and delete N unsent entries": deletes the database file and destroys its key, so the
 * entries are gone for good, then clears the marker. Only after a confirmation naming the count.
 */
export async function discardHeldWork(deps: DiscardDeps): Promise<void> {
  const id = await deps.readDatabaseId();
  if (id) {
    try {
      deps.deleteDatabaseFile(databaseFilename(id, deps.demo));
    } catch {
      // An unknown id means no file to delete; destroying the key still makes any file unreadable.
    }
  }
  await deps.destroyKey();
  await deps.clearHeld();
}
