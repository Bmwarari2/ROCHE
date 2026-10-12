import { AppSchema } from "@harbour/sync/client";
import { describe, expect, it } from "vitest";
import type { Me } from "../auth/auth-client";
import type { FetchLike } from "../auth/http";
import { DEMO_TENANT_ID, demoPeople } from "../demo/demo-data";
import { t } from "../i18n/t";
import {
  DB_ID_ITEM,
  DB_KEY_PROTECTION_ITEM,
  databaseFilename,
  databaseKeyRemains,
  destroyDatabaseKey,
  type KeyOptions,
  type KeyProtection,
  loadOrCreateDatabaseKey,
  readDatabaseKey,
  type SecretStore,
} from "../security/db-key";
import { type CrudEntryLike, HarbourConnector, SessionRevokedError } from "../sync/connector";
import {
  DiscardNotSentError,
  type DiscardSender,
  type DiscardSendResult,
  discardBody,
  finishDiscard,
  putDiscardOnRecord,
  requested,
} from "../sync/discards";
import {
  HELD_FAIL_SAFE_DAYS,
  HELD_MAX_META_ID,
  heldDeadline,
  readCachedHeldMaxDays,
  resolveHeldMaxDays,
} from "../sync/held-limit";
import type { MetaStore } from "../sync/offline-window";
import { all, openLocalDatabase, type SqliteDatabase } from "../test-support/local-db";
import {
  admitSignIn,
  admitToDatabase,
  canDiscardHeld,
  checkDeviceOwner,
  checkDiscardReason,
  countPendingWork,
  DISCARD_NOTE_PREFIX,
  DISCARD_OTHERS_PERMISSION,
  type DiscardDeps,
  DiscardIncompleteError,
  deletionOutcome,
  discardHeldWork,
  forgetDiscardNotes,
  type HeldIdsDeps,
  HeldIdsUnreadableError,
  type HeldWork,
  HeldWorkOwnerError,
  type HoldDb,
  handleSessionEnded,
  heldEntriesInTenant,
  holdUnsentWork,
  isHeldWorkOwner,
  KeyNotReadError,
  loadHeldMarker,
  locationIdsOf,
  type OpenCheckDeps,
  OWNER_META_ID,
  ownerOf,
  parseHeldWork,
  RestoreFailedError,
  readDeviceOwner,
  readHeldIds,
  readHeldMarker,
  readUnsentIds,
  restoreComplete,
  restoreHeldWork,
  restoreProblem,
  serialiseHeldWork,
  totalPending,
  UNKNOWN_OWNER,
  UploadBlockError,
  VaultResetError,
  withDeadline,
  writeDeviceOwner,
} from "./held-work";
import { readTombstones, recordTombstone, type Tombstone, TombstoneWriteError } from "./tombstones";

const API = "https://api.example.invalid";
const OTHER_TENANT = "00000000-0000-4000-8000-0000000000a2";
const [ADA_PERSON, BEA_PERSON] = demoPeople.map((p) => p.id) as [string, string];
const NOW = new Date("2026-10-11T07:30:00.000Z");

/** Invented staff: Sam Example wrote the entries overnight; Kit Sample signs in next. */
const sam: Me = {
  user: { id: "user-sam", name: "Sam Example" },
  tenant: { id: DEMO_TENANT_ID, name: "Example Care" },
  tenantUserId: "00000000-0000-4000-8000-0000000000c1",
  locations: [{ id: "loc-1", name: "Example House" }],
  permissions: ["care.note.create"],
};
const kit: Me = {
  ...sam,
  user: { id: "user-kit", name: "Kit Sample" },
  tenantUserId: "00000000-0000-4000-8000-0000000000c2",
};

const NOTE_ID = "0199d000-0000-7000-8000-0000000000e1";

/** A note written offline at 03:10 by the device clock, as the form writes it. */
const noteRow = (id = NOTE_ID): Record<string, string | number | null> => ({
  id,
  tenant_id: DEMO_TENANT_ID,
  person_id: ADA_PERSON,
  location_id: null,
  occurred_at: "2026-10-11T03:00:00.000Z",
  device_time: "2026-10-11T03:10:00.000Z",
  recorded_at: null,
  late_entry: 0,
  clock_drift: 0,
  supersedes_id: null,
  correction_reason: null,
  created_by: sam.user.id,
  category: "personal_care",
  body: "Settled; checked at 03:00.",
  tags: "[]",
});

/** A 403 ends the session only with one of the API's session codes (security review H1). */
const json = (status: number) =>
  new Response(status === 403 ? JSON.stringify({ status, code: "not_a_member" }) : "{}", {
    status,
    headers: { "content-type": status === 403 ? "application/problem+json" : "application/json" },
  });

function fakeFetch(statuses: number[]) {
  const calls: Array<{ url: string; init: RequestInit | undefined }> = [];
  const fetch: FetchLike = async (url, init) => {
    calls.push({ url, init });
    const status = statuses.shift();
    if (status === undefined) throw new Error("No more fake responses");
    return json(status);
  };
  return { fetch, calls };
}

/** In-memory keystore that, like expo-secure-store, keeps authenticated items apart. */
function memoryStore(): SecretStore & { readonly size: () => number } {
  const items = new Map<string, string>();
  const slot = (key: string, options?: { requireAuthentication?: boolean }) =>
    `${options?.requireAuthentication ? "auth" : "plain"}:${key}`;
  return {
    async getItem(key, options) {
      return items.get(slot(key, options)) ?? null;
    },
    async setItem(key, value, options) {
      items.set(slot(key, options), value);
    },
    async deleteItem(key, options) {
      items.delete(slot(key, options));
    },
    size: () => items.size,
  };
}

const keyOptions: KeyOptions = {
  protectedOptions: (p: KeyProtection) => ({
    requireAuthentication: p === "biometric",
    keychainAccessible: 6,
    authenticationPrompt: "Unlock Harbour",
  }),
  plainOptions: { keychainAccessible: 6 },
};

let counter = 0;
const randomBytes = (n: number) => new Uint8Array(n).map(() => (counter++ * 73 + 5) % 256);

const SYNCED_TABLES = AppSchema.tables.filter((t) => !t.localOnly).map((t) => t.name);
const WRITABLE = new Set([
  "care_note",
  "observation",
  "body_map_mark",
  "activity_record",
  "visit_log",
]);

/**
 * A device: a real SQLite engine with the app's tables and the invented demo records (identities,
 * NHS numbers, resuscitation decisions, care plans), PowerSync's behaviour around it, the database
 * file by name, its key in the keystore, and the held marker.
 *
 * What the PowerSync stand-in models (security review L4). PowerSync's own engine is the native
 * powersync-sqlite-core extension, which only loads in the app, so these tests cannot run it:
 *
 * - An insert into an entry table joins the upload queue (PowerSync's triggers write `ps_crud`).
 * - `disconnectAndClear({ clearLocal: false })` is PowerSync 2.3's `SELECT powersync_clear(0)`
 *   (`@powersync/shared-internals` BasePowerSyncDatabase): a hard clear, because `soft` is not
 *   set, so the internal copies (`ps_oplog`, `ps_buckets`, `ps_untyped`) go as well as every synced
 *   table and the upload queue (`ps_crud`), while local-only tables (`held_entry`, `upload_issue`,
 *   `sync_meta`) stay. The stand-in empties the synced tables and the queue and keeps the
 *   local-only tables; it has no internal copies to clear. `clearLocal: true` empties those too.
 * - What it does not model: the client id PowerSync keeps across a clear, sync itself, and SQLCipher
 *   (the key and the file are modelled by name).
 *
 * Whether the native clear removes the internal copies on a real device is checked in the device
 * test plan (`docs/plans/human-actions.md`, H-68).
 */
async function device(options: { queued?: number; refused?: number } = {}) {
  const sql: SqliteDatabase = await openLocalDatabase({
    seedDemo: new Date("2026-10-11T00:00:00Z"),
  });
  const store = memoryStore();
  const { key } = await loadOrCreateDatabaseKey({
    store,
    randomBytes,
    options: keyOptions,
    preferredProtection: "biometric",
  });
  const files = new Set([databaseFilename(key.id)]);
  const queue: CrudEntryLike[] = [];
  const marker: { value: string | null } = { value: null };

  const execute = async (query: string, params: unknown[] = []) => {
    sql.prepare(query).run(...params);
    const table = query.startsWith("INSERT INTO ") ? (query.slice(12).split(" ")[0] ?? "") : "";
    if (WRITABLE.has(table)) {
      // PowerSync's triggers: a new row in a synced table joins the upload queue.
      const columns = query
        .slice(query.indexOf("(") + 1, query.indexOf(")"))
        .split(",")
        .map((c) => c.trim());
      const opData = Object.fromEntries(columns.map((c, i) => [c, params[i] ?? null]));
      queue.push({ op: "PUT", table, id: String(opData.id), opData });
    }
    return { rowsAffected: 1 };
  };
  const getOptional = async <T>(query: string, params: unknown[] = []) =>
    (all<T>(sql, query, params)[0] ?? null) as T | null;
  const getAll = async <T>(query: string, params: unknown[] = []) => all<T>(sql, query, params);

  const db = {
    execute,
    getOptional,
    getAll,
    getClientId: async () => "client-1",
    getUploadQueueStats: async () => ({ count: queue.length }),
    getCrudBatch: async () => (queue.length > 0 ? { crud: [...queue] } : null),
    writeTransaction: async <T>(
      callback: (tx: { execute: typeof execute; getOptional: typeof getOptional }) => Promise<T>,
    ) => callback({ execute, getOptional }),
    getNextCrudTransaction: async () =>
      queue.length > 0
        ? {
            crud: [...queue],
            transactionId: 7,
            haveMore: false,
            complete: async () => {
              queue.length = 0;
            },
          }
        : null,
    disconnectAndClear: async (clear?: { clearLocal?: boolean }) => {
      for (const table of SYNCED_TABLES) sql.prepare(`DELETE FROM ${table}`).run();
      if (clear?.clearLocal) {
        for (const table of ["sync_meta", "upload_issue", "held_entry"]) {
          sql.prepare(`DELETE FROM ${table}`).run();
        }
      }
      queue.length = 0;
    },
  };

  await writeDeviceOwner(db, ownerOf(sam));
  // The tenant's hold limit, read from the rate table when last online (7 days here).
  await execute("INSERT INTO sync_meta (id, key, value) VALUES (?, ?, ?)", [
    HELD_MAX_META_ID,
    "held_entries_max_days",
    "7",
  ]);
  await execute("INSERT INTO sync_meta (id, key, value) VALUES (?, ?, ?)", [
    "meta:offline-window-days",
    "offline_window_days",
    "7",
  ]);
  for (let i = 0; i < (options.queued ?? 0); i += 1) {
    const row = noteRow(i === 0 ? NOTE_ID : `0199d000-0000-7000-8000-0000000000f${i}`);
    const columns = Object.keys(row);
    await execute(
      `INSERT INTO care_note (${columns.join(", ")}) VALUES (${columns.map(() => "?").join(", ")})`,
      columns.map((c) => row[c]),
    );
  }
  for (let i = 0; i < (options.refused ?? 0); i += 1) {
    await execute(
      "INSERT INTO upload_issue (id, tenant_id, person_id, record_table, code, message, payload, rejected_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
      [
        `refused-${i}`,
        DEMO_TENANT_ID,
        BEA_PERSON,
        "care_note",
        "invalid",
        "Closed",
        '{"body":"x"}',
        NOW.toISOString(),
      ],
    );
  }

  const holdDb = db as unknown as HoldDb;
  const count = (table: string) =>
    Number(all<{ n: number }>(sql, `SELECT COUNT(*) AS n FROM ${table}`, [])[0]?.n ?? 0);
  const wipe = async () => {
    files.delete(databaseFilename(key.id));
    await destroyDatabaseKey(store, keyOptions);
    marker.value = null;
  };
  const hold = async (held: HeldWork) => {
    await holdUnsentWork(holdDb, NOW);
    marker.value = serialiseHeldWork(held);
  };
  const reopen = () =>
    loadOrCreateDatabaseKey({
      store,
      randomBytes,
      options: keyOptions,
      preferredProtection: "biometric",
    });

  return { sql, key, store, files, queue, marker, db, holdDb, execute, count, wipe, hold, reopen };
}

type Device = Awaited<ReturnType<typeof device>>;

/** The vault's wiring: the connector reports an ended session, the hold-or-wipe rule decides. */
function connectorFor(dev: Device, fetch: FetchLike, token: string, owner: Me) {
  const ended: Array<Promise<"wiped" | "held">> = [];
  const instance = new HarbourConnector({
    apiUrl: API,
    fetch,
    getToken: async () => token,
    onSessionRevoked: () => {
      ended.push(
        handleSessionEnded({
          countPending: () => countPendingWork(dev.db),
          owner,
          now: NOW,
          expiresAt: heldDeadline(NOW, 7),
          lastServerTime: null,
          wipe: dev.wipe,
          hold: dev.hold,
        }),
      );
    },
    backoff: { baseDelayMs: 1, maxDelayMs: 1, maxAttempts: 1 },
    random: () => 0.5,
    sleep: async () => undefined,
    now: () => NOW,
  });
  return { instance, ended };
}

const asSource = (dev: Device) =>
  dev.db as unknown as Parameters<HarbourConnector["uploadData"]>[0];

/** Sam's session expires overnight with one note and one refused entry still on the device. */
async function heldDevice() {
  const dev = await device({ queued: 1, refused: 1 });
  const { instance, ended } = connectorFor(dev, fakeFetch([401]).fetch, "tok-1", sam);
  await expect(instance.uploadData(asSource(dev))).rejects.toBeInstanceOf(SessionRevokedError);
  await expect(ended[0]).resolves.toBe("held");
  const held = parseHeldWork(dev.marker.value);
  if (!held) throw new Error("expected held entries");
  return { dev, held };
}

describe("when the API ends the session (401 or 403)", () => {
  it("hazard HZ-006 a 401 with pending entries keeps them", async () => {
    const { dev, held } = await heldDevice();
    // The unsent work stays: the note (held) and the refused entry, with the file and its key.
    expect(dev.count("held_entry")).toBe(1);
    expect(dev.count("upload_issue")).toBe(1);
    expect(totalPending(await countPendingWork(dev.db))).toBe(2);
    expect(dev.files.has(databaseFilename(dev.key.id))).toBe(true);
    const reopened = await dev.reopen();
    expect(reopened.created).toBe(false);
    expect(reopened.key.id).toBe(dev.key.id);
    // Whose they are and until when (C8, S2).
    expect(held).toEqual({
      tenantId: DEMO_TENANT_ID,
      tenantUserId: sam.tenantUserId,
      userId: sam.user.id,
      ownerName: "Sam Example",
      entries: 2,
      heldAt: NOW.toISOString(),
      expiresAt: "2026-10-18T07:30:00.000Z",
      lastServerTime: null,
    });
  });

  it("hazard HZ-040 keeps the words given for a removed entry, which never leave the device (round 4, M3)", async () => {
    const dev = await device({ queued: 1 });
    const note = `${DISCARD_NOTE_PREFIX}0199d000-0000-7000-8000-0000000000d9`;
    await dev.execute("INSERT INTO sync_meta (id, key, value) VALUES (?, ?, ?)", [
      note,
      "discard_note",
      '{"reasonCode":"other","words":"Recorded twice by mistake"}',
    ]);
    await holdUnsentWork(dev.holdDb, NOW);
    const meta = all<{ id: string }>(dev.sql, "SELECT id FROM sync_meta ORDER BY id", []);
    expect(meta.map((m) => m.id)).toContain(note);
  });

  it("hazard HZ-006 keeps only the unsent work: identities and the care record leave the device (S2)", async () => {
    const before = await device({ queued: 1 });
    expect(before.count("person")).toBeGreaterThan(0);
    expect(before.count("advance_care_record")).toBeGreaterThan(0);
    const { dev } = await heldDevice();
    for (const table of SYNCED_TABLES) expect(dev.count(table), table).toBe(0);
    expect(dev.queue).toHaveLength(0);
    // Bookkeeping goes too, except the owner and the hold's time limit.
    const meta = all<{ id: string }>(dev.sql, "SELECT id FROM sync_meta ORDER BY id", []);
    expect(meta.map((m) => m.id)).toEqual([HELD_MAX_META_ID, OWNER_META_ID]);
    // What is held is the entry as written, nothing more.
    const [row] = all<{ id: string; payload: string }>(
      dev.sql,
      "SELECT id, payload FROM held_entry",
      [],
    );
    expect(row?.id).toBe(NOTE_ID);
    expect(JSON.parse(row?.payload ?? "{}")).toMatchObject({ body: "Settled; checked at 03:00." });
  });

  it.each([401, 403])(
    "hazard HZ-006 a %i from the sync token with pending entries keeps them too",
    async (status) => {
      const dev = await device({ queued: 1 });
      const { instance, ended } = connectorFor(dev, fakeFetch([status]).fetch, "tok-1", sam);
      await expect(instance.fetchCredentials()).resolves.toBeNull();
      await expect(ended[0]).resolves.toBe("held");
      expect(dev.files.size).toBe(1);
      expect(dev.count("held_entry")).toBe(1);
      expect(parseHeldWork(dev.marker.value)?.entries).toBe(1);
    },
  );

  it("hazard HZ-006 a 401 with no pending entries wipes", async () => {
    const dev = await device();
    const { instance, ended } = connectorFor(dev, fakeFetch([401]).fetch, "tok-1", sam);
    await expect(instance.fetchCredentials()).resolves.toBeNull();
    await expect(ended[0]).resolves.toBe("wiped");
    expect(dev.files.size).toBe(0);
    expect(await dev.store.getItem(DB_ID_ITEM, keyOptions.plainOptions)).toBeNull();
    expect((await dev.reopen()).created).toBe(true);
    expect(dev.marker.value).toBeNull();
  });

  it("hazard HZ-006 refused entries alone are enough to keep the device", async () => {
    const dev = await device({ refused: 1 });
    const { instance, ended } = connectorFor(dev, fakeFetch([401]).fetch, "tok-1", sam);
    await instance.fetchCredentials();
    await expect(ended[0]).resolves.toBe("held");
    expect(dev.files.size).toBe(1);
    expect(dev.count("upload_issue")).toBe(1);
  });

  it("hazard HZ-006 keeps the entries when they cannot be counted", async () => {
    const calls = { wipe: 0, held: [] as HeldWork[] };
    const result = await handleSessionEnded({
      countPending: async () => {
        throw new Error("database busy");
      },
      owner: sam,
      now: NOW,
      expiresAt: null,
      lastServerTime: null,
      wipe: async () => {
        calls.wipe += 1;
      },
      hold: async (held) => {
        calls.held.push(held);
      },
    });
    expect(result).toBe("held");
    expect(calls.wipe).toBe(0);
    expect(calls.held[0]?.entries).toBeNull();
    // Never open-ended (L2): with no figure the hold escalates after the fail-safe day.
    expect(calls.held[0]?.expiresAt).toBe(heldDeadline(NOW, HELD_FAIL_SAFE_DAYS).toISOString());
  });

  it("hazard HZ-006 a hold repeated after a crash keeps one copy of each entry", async () => {
    const dev = await device({ queued: 2 });
    await holdUnsentWork(dev.holdDb, NOW);
    await holdUnsentWork(dev.holdDb, NOW);
    expect(dev.count("held_entry")).toBe(2);
  });
});

describe("signing in again while entries are held", () => {
  it("hazard HZ-006 the same user resumes and the queue drains", async () => {
    const { dev, held } = await heldDevice();
    const signedOut: string[] = [];
    const admitted = await admitSignIn({
      held,
      me: sam,
      token: "tok-2",
      signOut: async (token) => {
        signedOut.push(token);
      },
    });
    expect(admitted).toBe("resume");
    expect(signedOut).toEqual([]);

    // The vault reopens the same file with the same key, checks the owner inside it before it
    // connects (S3), and puts the held entry back into the upload queue.
    expect((await dev.reopen()).created).toBe(false);
    expect(checkDeviceOwner(await readDeviceOwner(dev.db), sam, false)).toBe("owner");
    expect(await restoreHeldWork(dev.holdDb, NOW)).toEqual({
      restored: 1,
      parked: 0,
      remaining: 0,
    });
    expect(dev.count("held_entry")).toBe(0);
    expect(dev.queue.map((e) => e.id)).toEqual([NOTE_ID]);

    const { fetch, calls } = fakeFetch([201]);
    const { instance } = connectorFor(dev, fetch, "tok-2", sam);
    await instance.uploadData(asSource(dev));

    expect(totalPending(await countPendingWork(dev.db))).toBe(1); // the refused entry stays listed
    expect(dev.queue).toHaveLength(0);
    const headers = new Headers(calls[0]?.init?.headers);
    expect(calls[0]?.url).toBe(`${API}/v1/people/${ADA_PERSON}/notes`);
    expect(headers.get("authorization")).toBe("Bearer tok-2");
    // The same id as when it was written, so a replay is ignored.
    expect(headers.get("idempotency-key")).toBe(NOTE_ID);
    expect(JSON.parse(String(calls[0]?.init?.body))).toMatchObject({
      deviceTime: "2026-10-11T03:10:00.000Z",
      occurredAt: "2026-10-11T03:00:00.000Z",
    });
  });

  it("hazard HZ-006 a different user is refused", async () => {
    const { dev, held } = await heldDevice();
    const signedOut: string[] = [];
    const attempt = admitSignIn({
      held,
      me: kit,
      token: "tok-kit",
      signOut: async (token) => {
        signedOut.push(token);
      },
    });
    await expect(attempt).rejects.toBeInstanceOf(HeldWorkOwnerError);
    await expect(attempt).rejects.toThrow(
      "Entries from another member of staff are waiting. They need to sign in to send them.",
    );
    // The refused session is ended on the server, and the entries stay for their owner.
    expect(signedOut).toEqual(["tok-kit"]);
    expect(dev.count("held_entry")).toBe(1);
    expect(dev.files.size).toBe(1);
    expect(parseHeldWork(dev.marker.value)).toEqual(held);
    // Even without the marker, the database itself refuses Kit before connecting (S3).
    expect(checkDeviceOwner(await readDeviceOwner(dev.db), kit, false)).toBe("other");
  });

  it("hazard HZ-006 puts back what cannot be resent as needing attention, never dropped", async () => {
    const dev = await device();
    await dev.execute(
      `INSERT INTO held_entry (id, tenant_id, person_id, record_table, op, payload, position, held_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        "odd-1",
        DEMO_TENANT_ID,
        ADA_PERSON,
        "person",
        "PATCH",
        '{"given_name":"X"}',
        1,
        NOW.toISOString(),
      ],
    );
    expect(await restoreHeldWork(dev.holdDb, NOW)).toEqual({
      restored: 0,
      parked: 1,
      remaining: 0,
    });
    const [issue] = all<{ id: string; code: string }>(
      dev.sql,
      "SELECT id, code FROM upload_issue",
      [],
    );
    expect(issue).toEqual({ id: "odd-1", code: "held_not_restored" });
  });

  it("hazard HZ-006 moves an entry that cannot go back to needing attention, with its content (clinical review M2)", async () => {
    const { dev } = await heldDevice();
    // Putting the note back fails (for example a full disk); moving it to "needs attention" works.
    let failing = true;
    const flaky = {
      ...dev.holdDb,
      writeTransaction: <T>(callback: (tx: never) => Promise<T>) => {
        if (failing) {
          failing = false;
          return Promise.reject(new Error("disk full"));
        }
        return dev.holdDb.writeTransaction(callback as never) as Promise<T>;
      },
    } as unknown as HoldDb;
    expect(await restoreHeldWork(flaky, NOW)).toEqual({ restored: 0, parked: 1, remaining: 0 });
    const [issue] = all<{ code: string; payload: string }>(
      dev.sql,
      "SELECT code, payload FROM upload_issue WHERE id = ?",
      [NOTE_ID],
    );
    expect(issue?.code).toBe("held_restore_failed");
    expect(JSON.parse(issue?.payload ?? "{}")).toMatchObject({
      body: "Settled; checked at 03:00.",
    });
    expect(dev.count("held_entry")).toBe(0);
  });

  it("hazard HZ-006 keeps an entry held, and counted, when it can neither go back nor be moved", async () => {
    const { dev } = await heldDevice();
    const broken = {
      ...dev.holdDb,
      writeTransaction: () => Promise.reject(new Error("disk full")),
    } as unknown as HoldDb;
    expect(await restoreHeldWork(broken, NOW)).toEqual({ restored: 0, parked: 0, remaining: 1 });
    expect(dev.count("held_entry")).toBe(1);
    expect(restoreComplete({ restored: 0, parked: 0, remaining: 1 })).toBe(false);
  });

  const heldFor: HeldWork = {
    tenantId: DEMO_TENANT_ID,
    tenantUserId: sam.tenantUserId,
    userId: sam.user.id,
    ownerName: "Sam Example",
    entries: 1,
    heldAt: NOW.toISOString(),
    expiresAt: null,
    lastServerTime: null,
  };

  // An "older marker" lacks the tenant_user id, so the sign-in (auth user) id is compared instead.
  it.each([
    { case: "the same member of staff", held: heldFor, me: sam, owner: true },
    { case: "another member of staff", held: heldFor, me: kit, owner: false },
    {
      case: "same sign-in, other tenant",
      held: heldFor,
      me: { ...sam, tenant: { id: OTHER_TENANT, name: "Other Care" } },
      owner: false,
    },
    {
      case: "older marker, same sign-in",
      held: { ...heldFor, tenantUserId: null },
      me: sam,
      owner: true,
    },
    {
      case: "older marker, another sign-in",
      held: { ...heldFor, tenantUserId: null },
      me: kit,
      owner: false,
    },
    { case: "a marker with no owner", held: UNKNOWN_OWNER, me: sam, owner: false },
  ])("hazard HZ-006 owner check: $case", ({ held, me, owner }) => {
    expect(isHeldWorkOwner(held, me)).toBe(owner);
  });

  it.each([
    { case: "the recorded owner", stored: ownerOf(sam), created: false, result: "owner" },
    { case: "someone else's database", stored: ownerOf(kit), created: false, result: "other" },
    {
      case: "an owner that cannot be read",
      stored: "unreadable" as const,
      created: false,
      result: "other",
    },
    { case: "no owner on a database made before", stored: null, created: false, result: "other" },
    { case: "no owner on a database just made", stored: null, created: true, result: "claim" },
  ])(
    "hazard HZ-006 the database is checked before it connects (S3): $case",
    ({ stored, created, result }) => {
      expect(checkDeviceOwner(stored, sam, created)).toBe(result);
    },
  );

  it("hazard HZ-006 a damaged owner row in the database reads as unreadable, never as the reader's", async () => {
    const dev = await device();
    await dev.execute("UPDATE sync_meta SET value = ? WHERE id = ?", ["{not json", OWNER_META_ID]);
    expect(await readDeviceOwner(dev.db)).toBe("unreadable");
  });

  it("hazard HZ-006 a keystore read error means held with an unknown owner (S3)", async () => {
    const fail = async (): Promise<string | null> => {
      throw new Error("keystore unavailable");
    };
    await expect(
      readHeldMarker({ readMarker: fail, readDatabaseId: async () => "abc" }),
    ).resolves.toEqual(UNKNOWN_OWNER);
    await expect(readHeldMarker({ readMarker: fail, readDatabaseId: fail })).resolves.toEqual(
      UNKNOWN_OWNER,
    );
    // With no database on the device there is nothing to hold.
    await expect(
      readHeldMarker({ readMarker: fail, readDatabaseId: async () => null }),
    ).resolves.toBeNull();
    await expect(
      readHeldMarker({ readMarker: async () => null, readDatabaseId: fail }),
    ).resolves.toBeNull();
  });

  it("hazard HZ-006 a damaged marker releases the entries to nobody", () => {
    const damaged = parseHeldWork("{not json");
    expect(damaged).toEqual(UNKNOWN_OWNER);
    if (!damaged) return;
    expect(isHeldWorkOwner(damaged, sam)).toBe(false);
    expect(isHeldWorkOwner(damaged, kit)).toBe(false);
    expect(parseHeldWork(null)).toBeNull();
  });

  it("lets anyone in when nothing is held", async () => {
    await expect(
      admitSignIn({ held: null, me: kit, token: "tok-kit", signOut: async () => undefined }),
    ).resolves.toBe("continue");
  });
});

describe("opening the database: the owner check before the device connects (S3, L4)", () => {
  function openDeps(dev: Device, overrides: Partial<OpenCheckDeps> = {}) {
    const calls = { reset: 0, closeKeeping: 0 };
    const deps: OpenCheckDeps = {
      db: dev.holdDb,
      me: sam,
      created: false,
      afterReset: false,
      now: NOW,
      cachedHeldMaxDays: () => readCachedHeldMaxDays(dev.db as unknown as MetaStore),
      reset: async () => {
        calls.reset += 1;
        await dev.wipe();
      },
      closeKeeping: async () => {
        calls.closeKeeping += 1;
      },
      ...overrides,
    };
    return { deps, calls };
  }

  it("hazard HZ-006 the owner connects after their held entries go back into the queue", async () => {
    const { dev } = await heldDevice();
    const { deps, calls } = openDeps(dev);
    const outcome = await admitToDatabase(deps);
    expect(outcome).toEqual({
      kind: "connect",
      restore: { restored: 1, parked: 0, remaining: 0 },
    });
    expect(restoreComplete(outcome.kind === "connect" ? outcome.restore : "failed")).toBe(true);
    expect(dev.queue.map((e) => e.id)).toEqual([NOTE_ID]);
    expect(calls).toEqual({ reset: 0, closeKeeping: 0 });
  });

  it("hazard HZ-006 a new database is claimed for the person who made it", async () => {
    const dev = await device();
    await dev.execute("DELETE FROM sync_meta WHERE id = ?", [OWNER_META_ID]);
    const { deps } = openDeps(dev, { me: kit, created: true });
    expect((await admitToDatabase(deps)).kind).toBe("connect");
    expect(await readDeviceOwner(dev.db)).toEqual(ownerOf(kit));
  });

  it("hazard HZ-006 someone else's database with nothing unsent is deleted and made again", async () => {
    const dev = await device();
    const { deps, calls } = openDeps(dev, { me: kit });
    expect(await admitToDatabase(deps)).toEqual({ kind: "reopen" });
    expect(calls.reset).toBe(1);
    expect(dev.files.size).toBe(0);
    // A second attempt that meets someone else's database again refuses rather than loops.
    const again = await device();
    await expect(
      admitToDatabase(openDeps(again, { me: kit, afterReset: true }).deps),
    ).rejects.toBeInstanceOf(VaultResetError);
  });

  it("hazard HZ-006 someone else's unsent work is held for them and this sign-in refused", async () => {
    const dev = await device({ queued: 1, refused: 1 });
    const { deps, calls } = openDeps(dev, { me: kit });
    const outcome = await admitToDatabase(deps);
    if (outcome.kind !== "refused") throw new Error("expected a refusal");
    expect(outcome.held).toEqual({
      tenantId: DEMO_TENANT_ID,
      tenantUserId: sam.tenantUserId,
      userId: sam.user.id,
      ownerName: "Sam Example",
      entries: 2,
      heldAt: NOW.toISOString(),
      expiresAt: "2026-10-18T07:30:00.000Z",
      lastServerTime: null,
    });
    // Only the unsent work stays (S2); the database is closed, never connected for Kit.
    expect(dev.count("held_entry")).toBe(1);
    expect(dev.count("person")).toBe(0);
    expect(calls).toEqual({ reset: 0, closeKeeping: 1 });
    // The hold's counts for the server, without names or ids.
    expect(outcome.report).toMatchObject({ unsent: 0, refused: 1, held: 1 });
  });

  it("hazard HZ-006 an owner that cannot be read is never treated as the reader", async () => {
    const dev = await device({ queued: 1 });
    await dev.execute("UPDATE sync_meta SET value = ? WHERE id = ?", ["{not json", OWNER_META_ID]);
    const outcome = await admitToDatabase(openDeps(dev).deps);
    expect(outcome.kind).toBe("refused");
    if (outcome.kind === "refused") expect(outcome.held.tenantId).toBe("");
  });

  it("hazard HZ-006 refuses to open anything when nobody is signed in", async () => {
    const dev = await device();
    await expect(admitToDatabase(openDeps(dev, { me: null }).deps)).rejects.toBeInstanceOf(
      HeldWorkOwnerError,
    );
  });

  it("hazard HZ-006 reports a restore that failed instead of swallowing it (clinical review M2)", async () => {
    const { dev } = await heldDevice();
    const broken = {
      ...dev.holdDb,
      getAll: async () => {
        throw new Error("disk I/O error");
      },
    } as unknown as HoldDb;
    const outcome = await admitToDatabase({ ...openDeps(dev).deps, db: broken });
    expect(outcome).toEqual({ kind: "connect", restore: "failed" });
    expect(restoreComplete("failed")).toBe(false);
    // The entry is still held, so the marker stays and the banner counts it.
    expect(dev.count("held_entry")).toBe(1);
    // What the person sees on every screen (clinical review round 4, M4).
    expect(restoreProblem(outcome.kind === "connect" ? outcome.restore : "failed")).toBe(
      "Your unsent entries could not be put back to be sent. They are still on this device. Close Harbour, open it again and unlock to try again. If this keeps happening, tell the nurse in charge.",
    );
  });

  it("hazard HZ-006 says how many entries are still held when only some could not go back (round 4, M4)", () => {
    expect(restoreProblem({ restored: 2, parked: 0, remaining: 1 })).toBe(
      "1 unsent entry could not be put back to be sent. It is still on this device. Close Harbour, open it again and unlock to try again. If this keeps happening, tell the nurse in charge.",
    );
    expect(restoreProblem({ restored: 2, parked: 1, remaining: 0 })).toBeNull();
  });

  it("hazard HZ-040 after a deletion that did not finish, nothing is uploaded: every entry moves to needs attention (round 4, H1)", async () => {
    const { dev } = await heldDevice();
    // Something in the upload queue too, as after a sign-out whose deletion failed.
    await dev.execute(
      `INSERT INTO care_note (${Object.keys(noteRow()).join(", ")}) VALUES (${Object.keys(noteRow())
        .map(() => "?")
        .join(", ")})`,
      Object.values(noteRow("0199d000-0000-7000-8000-0000000000e2")),
    );
    const outcome = await admitToDatabase(openDeps(dev, { uploadBlocked: true }).deps);
    expect(outcome).toEqual({
      kind: "connect",
      restore: { restored: 0, parked: 2, remaining: 0 },
    });
    expect(dev.queue).toEqual([]);
    expect(dev.count("held_entry")).toBe(0);
    const parked = all<{ id: string; code: string; message: string }>(
      dev.sql,
      "SELECT id, code, message FROM upload_issue WHERE code = 'held_discard_failed' ORDER BY id",
      [],
    );
    expect(parked.map((p) => p.id)).toEqual([NOTE_ID, "0199d000-0000-7000-8000-0000000000e2"]);
    expect(parked[0]?.message).toBe(t("mobile.held.discardFailedEntry"));
  });

  it("hazard HZ-040 someone else's refused sign-in keeps the entries blocked (round 4, H1)", async () => {
    const dev = await device({ queued: 1 });
    const outcome = await admitToDatabase(openDeps(dev, { me: kit, uploadBlocked: true }).deps);
    if (outcome.kind !== "refused") throw new Error("expected a refusal");
    expect(outcome.held.uploadBlocked).toBe(true);
  });
});

describe("who may delete held entries on a shared device (M2)", () => {
  const manager: Me = {
    ...kit,
    user: { id: "user-mo", name: "Mo Manager" },
    tenantUserId: "00000000-0000-4000-8000-0000000000c3",
    permissions: ["care.note.create", DISCARD_OTHERS_PERMISSION],
  };
  const held: HeldWork = {
    tenantId: DEMO_TENANT_ID,
    tenantUserId: sam.tenantUserId,
    userId: sam.user.id,
    ownerName: "Sam Example",
    entries: 2,
    heldAt: NOW.toISOString(),
    expiresAt: "2026-10-18T07:30:00.000Z",
    lastServerTime: null,
  };

  it.each([
    { case: "the member of staff who wrote them", held, signer: sam, allowed: true },
    { case: "a manager in the same tenant", held, signer: manager, allowed: true },
    { case: "another member of staff", held, signer: kit, allowed: false },
    {
      case: "a manager in another tenant",
      held,
      signer: { ...manager, tenant: { id: OTHER_TENANT, name: "Other Care" } },
      allowed: false,
    },
    { case: "a manager, owner unknown", held: UNKNOWN_OWNER, signer: manager, allowed: true },
    { case: "anyone else, owner unknown", held: UNKNOWN_OWNER, signer: kit, allowed: false },
  ])("hazard HZ-040 $case: $allowed", ({ held: h, signer, allowed }) => {
    expect(canDiscardHeld(h, signer)).toBe(allowed);
  });
});

describe("deleting held entries (S4, S5, M1, M2, L4; clinical review round 4, H1)", () => {
  const TOMBSTONE_ID = "0199d000-0000-7000-8000-0000000000d1";
  /** A manager deleting Sam's held entries. */
  const tombstone: Tombstone = requested({
    id: TOMBSTONE_ID,
    kind: "held_deleted",
    reasonCode: "recorded_elsewhere",
    tenantId: DEMO_TENANT_ID,
    ownerTenantUserId: sam.tenantUserId,
    deletedByTenantUserId: "00000000-0000-4000-8000-0000000000c3",
    entryIds: [NOTE_ID],
    personIds: [ADA_PERSON],
    count: 2,
    at: NOW.toISOString(),
  });

  function discardDeps(
    dev: Device,
    overrides: Partial<DiscardDeps> & {
      gone?: boolean;
      keyStays?: boolean;
      answers?: DiscardSendResult[];
    } = {},
  ) {
    const tombstones = memoryTombstones();
    const sent: Array<Record<string, unknown>> = [];
    const events: string[] = [];
    const { gone, keyStays, answers = [], ...rest } = overrides;
    const send: DiscardSender = async (stone, stage) => {
      sent.push(discardBody(stone, stage));
      return answers.shift() ?? "acknowledged";
    };
    const blocked = { value: false };
    const deps: DiscardDeps = {
      readDatabaseId: () => dev.store.getItem(DB_ID_ITEM, keyOptions.plainOptions),
      deleteDatabaseFile: (name: string) => {
        events.push("delete file");
        dev.files.delete(name);
      },
      destroyKey: async () => {
        events.push("destroy key");
        if (!keyStays) await destroyDatabaseKey(dev.store, keyOptions);
      },
      databaseGone: async (name: string) => gone ?? !dev.files.has(name),
      keyRemains: () => databaseKeyRemains(dev.store, keyOptions),
      putOnRecord: async () => {
        events.push("requested");
        return putDiscardOnRecord({ store: tombstones.store, tombstone, send });
      },
      recordOutcome: (outcome, leftover) => {
        events.push(outcome);
        return finishDiscard({ store: tombstones.store, tombstone, outcome, leftover, send });
      },
      blockUploads: async () => {
        events.push("block uploads");
        blocked.value = true;
      },
      clearHeld: async () => {
        dev.marker.value = null;
      },
      demo: false,
      ...rest,
    };
    return { deps, tombstones, sent, blocked, events };
  }

  it("hazard HZ-006 hazard HZ-040 the explicit discard wipes: requested and blocked first, deleted only once the entries cannot be read", async () => {
    const { dev } = await heldDevice();
    const filename = databaseFilename(dev.key.id);
    const { deps, tombstones, sent, events } = discardDeps(dev);
    expect(await discardHeldWork(deps)).toEqual({ outcome: "deleted", leftover: [] });

    expect(dev.files.has(filename)).toBe(false);
    expect(dev.marker.value).toBeNull();
    // The key is gone, so even a copy of the file could not be read.
    const reopened = await dev.reopen();
    expect(reopened.created).toBe(true);
    expect(reopened.key.id).not.toBe(dev.key.id);
    // The uploads are blocked together with the request, before anything is deleted (C-L1).
    expect(events).toEqual(["requested", "block uploads", "delete file", "destroy key", "deleted"]);
    expect(sent.map((b) => b.stage)).toEqual(["requested", "deleted"]);
    // Only the coded reason is sent; no words anywhere (round 4, M3).
    expect(sent.some((b) => "reason" in b)).toBe(false);
    // The server has the whole deletion, so its record leaves the keystore.
    expect(await readTombstones(tombstones.store)).toEqual([]);
  });

  it("hazard HZ-040 records failed only while the entries can still be read: the file and its key both remain (round 5, C-M1)", async () => {
    const { dev } = await heldDevice();
    const before = dev.marker.value;
    const { deps, tombstones, sent, blocked } = discardDeps(dev, { gone: false, keyStays: true });
    await expect(discardHeldWork(deps)).rejects.toBeInstanceOf(DiscardIncompleteError);
    // The server acknowledged the request, then heard that it failed.
    expect(sent.map((b) => b.stage)).toEqual(["requested", "failed"]);
    expect(blocked.value).toBe(true);
    expect(dev.marker.value).toBe(before);
    expect((await dev.reopen()).created).toBe(false);
    expect(await readTombstones(tombstones.store)).toEqual([]);
  });

  it.each([
    ["the file, with its key gone", { gone: false }, ["file"]],
    ["the key, with its file gone", { keyStays: true }, ["key"]],
  ] as const)(
    "hazard HZ-040 records deleted when the entries cannot be read, reporting %s left behind (round 5, C-M1)",
    async (_case, state, leftover) => {
      const { dev } = await heldDevice();
      const { deps, sent } = discardDeps(dev, state);
      expect(await discardHeldWork(deps)).toEqual({ outcome: "deleted", leftover });
      expect(sent.map((b) => [b.stage, b.leftover])).toEqual([
        ["requested", undefined],
        ["deleted", leftover],
      ]);
      expect(dev.marker.value).toBeNull();
    },
  );

  it("hazard HZ-040 records failed, and keeps it to send, when the entries remain readable and the server cannot be reached", async () => {
    const { dev } = await heldDevice();
    const own = { ...tombstone, deletedByTenantUserId: sam.tenantUserId };
    const tombstones = memoryTombstones();
    const { deps } = discardDeps(dev, {
      gone: false,
      keyStays: true,
      putOnRecord: () =>
        putDiscardOnRecord({ store: tombstones.store, tombstone: own, send: async () => "retry" }),
      recordOutcome: (outcome, leftover) =>
        finishDiscard({
          store: tombstones.store,
          tombstone: own,
          outcome,
          leftover,
          send: async () => "retry",
        }),
    });
    await expect(discardHeldWork(deps)).rejects.toBeInstanceOf(DiscardIncompleteError);
    expect(await readTombstones(tombstones.store)).toEqual([
      { ...own, stage: "failed", unsent: ["requested", "failed"] },
    ]);
  });

  it("hazard HZ-040 deletes nothing when the entries cannot be marked never to be uploaded (round 5, C-L1)", async () => {
    const { dev } = await heldDevice();
    const { deps, sent, events } = discardDeps(dev, {
      blockUploads: async () => {
        throw new Error("keystore full");
      },
    });
    await expect(discardHeldWork(deps)).rejects.toBeInstanceOf(UploadBlockError);
    expect(events).toEqual(["requested", "failed"]);
    expect(sent.map((b) => b.stage)).toEqual(["requested", "failed"]);
    expect(dev.files.size).toBe(1);
    expect((await dev.reopen()).created).toBe(false);
  });

  it("hazard HZ-040 signing out clears the rows before the file, so a file left behind holds no readable entries (round 5, C-M1)", async () => {
    // Signed in, with two notes not yet uploaded.
    const dev = await device({ queued: 2 });
    const { deps, sent, events } = discardDeps(dev, {
      gone: false,
      keyStays: true,
      clearRows: async () => {
        events.push("clear rows");
        await dev.db.disconnectAndClear({ clearLocal: true });
        return true;
      },
    });
    expect(await discardHeldWork(deps)).toEqual({ outcome: "deleted", leftover: ["file", "key"] });
    expect(dev.count("care_note")).toBe(0);
    expect(dev.queue).toEqual([]);
    expect(events.slice(0, 3)).toEqual(["requested", "block uploads", "clear rows"]);
    expect(sent.map((b) => b.stage)).toEqual(["requested", "deleted"]);
  });

  it("hazard HZ-040 signing out records failed when the rows could not be cleared and the file and key remain (round 5, C-M1)", async () => {
    const dev = await device({ queued: 1 });
    const { deps, sent } = discardDeps(dev, {
      gone: false,
      keyStays: true,
      clearRows: async () => false,
    });
    await expect(discardHeldWork(deps)).rejects.toBeInstanceOf(DiscardIncompleteError);
    expect(sent.map((b) => b.stage)).toEqual(["requested", "failed"]);
  });

  it.each([
    [{ fileRemains: true, keyRemains: true, rowsRemain: true }, "failed", ["file", "key"]],
    [{ fileRemains: true, keyRemains: true, rowsRemain: false }, "deleted", ["file", "key"]],
    [{ fileRemains: true, keyRemains: false, rowsRemain: true }, "deleted", ["file"]],
    [{ fileRemains: false, keyRemains: true, rowsRemain: true }, "deleted", ["key"]],
    [{ fileRemains: false, keyRemains: false, rowsRemain: true }, "deleted", []],
  ] as const)(
    "hazard HZ-040 a deletion of %j ends %s (round 5, C-M1)",
    (state, outcome, leftover) => {
      expect(deletionOutcome(state)).toEqual({ outcome, leftover });
    },
  );

  it("hazard HZ-040 deletes nothing when the database id cannot be read (L4)", async () => {
    const { dev } = await heldDevice();
    const { deps, tombstones, sent } = discardDeps(dev, {
      readDatabaseId: async () => {
        throw new Error("keystore unavailable");
      },
    });
    await expect(discardHeldWork(deps)).rejects.toBeInstanceOf(DiscardIncompleteError);
    expect(dev.files.size).toBe(1);
    expect((await dev.reopen()).created).toBe(false);
    expect(await readTombstones(tombstones.store)).toEqual([]);
    expect(sent).toEqual([]);
  });

  it("hazard HZ-040 deletes nothing when the deletion cannot be put on record (L4)", async () => {
    const { dev } = await heldDevice();
    const before = dev.marker.value;
    const refusing = memoryTombstones({ failWrites: true });
    const { deps } = discardDeps(dev, {
      putOnRecord: () =>
        putDiscardOnRecord({ store: refusing.store, tombstone, send: async () => "acknowledged" }),
    });
    await expect(discardHeldWork(deps)).rejects.toBeInstanceOf(TombstoneWriteError);
    expect(dev.files.size).toBe(1);
    expect(dev.marker.value).toBe(before);
  });

  it("hazard HZ-040 deletes nothing of someone else's until the server has the request (round 4, M2)", async () => {
    const { dev } = await heldDevice();
    const { deps, tombstones } = discardDeps(dev, { answers: ["retry"] });
    const attempt = discardHeldWork(deps);
    await expect(attempt).rejects.toBeInstanceOf(DiscardNotSentError);
    await expect(attempt).rejects.toThrow(t("mobile.discard.needsConnection"));
    expect(dev.files.size).toBe(1);
    expect(await readTombstones(tombstones.store)).toEqual([]);
  });

  it.each([
    [{ reasonCode: null, reason: "" }, "mobile.discard.reasonCodeRequired"],
    [{ reasonCode: "other", reason: "" }, "mobile.discard.reasonRequired"],
    [{ reasonCode: "other", reason: " ok " }, "mobile.discard.reasonRequired"],
    [{ reasonCode: "staff_left", reason: "x".repeat(501) }, "mobile.discard.reasonTooLong"],
    [{ reasonCode: "staff_left", reason: "no" }, "mobile.discard.reasonRequired"],
  ] as const)("hazard HZ-040 a deletion with words needs a coded reason (%j)", (choice, key) => {
    expect(checkDiscardReason(choice, { withWords: true })?.key).toBe(key);
  });

  it.each([
    { reasonCode: "recorded_elsewhere", reason: "" },
    { reasonCode: "other", reason: "Duplicate device" },
  ] as const)("hazard HZ-040 accepts %j where words are kept", (choice) => {
    expect(checkDiscardReason(choice, { withWords: true })).toBeNull();
  });

  it("hazard HZ-040 offers no words, and no Other, where the database is deleted (round 4, M3)", () => {
    expect(checkDiscardReason({ reasonCode: "other", reason: "Duplicate device" })?.key).toBe(
      "mobile.discard.reasonCodeRequired",
    );
    // Words given anyway are ignored, never checked or kept.
    expect(checkDiscardReason({ reasonCode: "staff_left", reason: "x".repeat(501) })).toBeNull();
  });

  it("hazard HZ-040 checks the entries are the manager's organisation's when the owner is unknown (round 4, low)", () => {
    const ids = (tenantIds: string[], entryIds = [NOTE_ID]) => ({
      entryIds,
      personIds: [],
      tenantIds,
    });
    expect(heldEntriesInTenant(ids([DEMO_TENANT_ID]), DEMO_TENANT_ID)).toBe(true);
    expect(heldEntriesInTenant(ids([DEMO_TENANT_ID, OTHER_TENANT]), DEMO_TENANT_ID)).toBe(false);
    expect(heldEntriesInTenant(ids([OTHER_TENANT]), DEMO_TENANT_ID)).toBe(false);
    expect(heldEntriesInTenant(ids([]), DEMO_TENANT_ID)).toBe(false);
    expect(heldEntriesInTenant(ids([], []), DEMO_TENANT_ID)).toBe(true);
  });

  it("reads the organisation of every unsent entry for that check", async () => {
    const dev = await device({ queued: 1, refused: 1 });
    expect(await readUnsentIds(dev.holdDb)).toMatchObject({
      entryIds: [NOTE_ID, "refused-0"],
      tenantIds: [DEMO_TENANT_ID],
    });
  });

  it("hazard HZ-006 the button and its confirmation name the count", () => {
    expect(t("mobile.held.discard", { count: 1 })).toBe("Sign out and delete 1 unsent entry");
    expect(t("mobile.held.discard", { count: 3 })).toBe("Sign out and delete 3 unsent entries");
    expect(t("mobile.held.discardTitle", { count: 3 })).toBe("Delete 3 unsent entries?");
    expect(t("mobile.held.discardStart", { count: 3 })).toBe("Delete 3 unsent entries");
    expect(t("mobile.held.title", { count: 3 })).toBe("Sign in again to send 3 entries");
    expect(t("mobile.signOut.unsent", { count: 2 })).toBe(
      "2 entries have not reached the server and will be deleted.",
    );
  });

  it("hazard HZ-040 says whose entries are waiting, in whole sentences (C8)", () => {
    expect(t("mobile.held.owner", { named: "yes", name: "Sam Example" })).toBe(
      "Entries from Sam Example are waiting to be sent.",
    );
    expect(t("mobile.held.owner", { named: "no", name: "" })).toBe(
      "Entries from another member of staff are waiting to be sent.",
    );
  });
});

describe("hazard HZ-040 which entries a deletion removes, read before anything is deleted (round 5, C-M2)", () => {
  async function idsDeps(
    dev: Device,
    overrides: Partial<HeldIdsDeps> = {},
  ): Promise<{ deps: HeldIdsDeps; asked: { identity: number } }> {
    const asked = { identity: 0 };
    const deps: HeldIdsDeps = {
      readBookkeeping: async () => ({
        id: await dev.store.getItem(DB_ID_ITEM, keyOptions.plainOptions),
        protection: await dev.store.getItem(DB_KEY_PROTECTION_ITEM, keyOptions.plainOptions),
      }),
      readKey: () => readDatabaseKey(dev.store, keyOptions),
      confirmIdentity: async () => {
        asked.identity += 1;
      },
      readIds: () => readUnsentIds(dev.holdDb),
      ...overrides,
    };
    return { deps, asked };
  }

  it("hazard HZ-040 reads the entry ids with the key, the prompt being the device authentication", async () => {
    const { dev } = await heldDevice();
    const { deps, asked } = await idsDeps(dev);
    const ids = await readHeldIds(deps);
    expect(ids.kind === "ids" ? ids.ids.entryIds : []).toContain(NOTE_ID);
    expect(asked.identity).toBe(0);
  });

  it("hazard HZ-040 refuses, and asks to try again, when the key is there but could not be read (a cancelled prompt)", async () => {
    const { dev } = await heldDevice();
    const { deps, asked } = await idsDeps(dev, {
      readKey: async () => {
        throw new Error("User cancelled the authentication");
      },
    });
    const attempt = readHeldIds(deps);
    await expect(attempt).rejects.toBeInstanceOf(KeyNotReadError);
    await expect(attempt).rejects.toThrow(t("mobile.held.keyNotRead"));
    // The passcode is not offered instead: without the ids nothing may be deleted.
    expect(asked.identity).toBe(0);
  });

  it("hazard HZ-040 refuses with HeldIdsUnreadableError when the key was read but the entries could not be", async () => {
    const { dev } = await heldDevice();
    const { deps } = await idsDeps(dev, {
      readIds: async () => {
        throw new Error("file is not a database");
      },
    });
    const attempt = readHeldIds(deps);
    await expect(attempt).rejects.toBeInstanceOf(HeldIdsUnreadableError);
    await expect(attempt).rejects.toThrow(t("mobile.held.idsUnreadable"));
  });

  it("hazard HZ-040 goes ahead without ids only when nothing could ever be read, saying why", async () => {
    const { dev } = await heldDevice();
    // No key at all: device authentication, then no ids, recorded as key_absent.
    const absent = await idsDeps(dev, {
      readBookkeeping: async () => ({ id: null, protection: null }),
    });
    expect(await readHeldIds(absent.deps)).toEqual({ kind: "none", reason: "key_absent" });
    expect(absent.asked.identity).toBe(1);
    // A key kept that is not a valid key: recorded as key_invalid.
    const invalid = await idsDeps(dev, { readKey: async () => null });
    expect(await readHeldIds(invalid.deps)).toEqual({ kind: "none", reason: "key_invalid" });
    expect(invalid.asked.identity).toBe(1);
  });

  it("hazard HZ-040 refuses when the keystore cannot be read at all", async () => {
    const { dev } = await heldDevice();
    const { deps } = await idsDeps(dev, {
      readBookkeeping: async () => {
        throw new Error("keystore unavailable");
      },
    });
    await expect(readHeldIds(deps)).rejects.toBeInstanceOf(KeyNotReadError);
  });
});

describe("hazard HZ-040 the words kept for a removed entry (round 5, S-L4)", () => {
  it("are deleted once the server has the whole deletion, and kept while it waits", async () => {
    const dev = await device();
    const tombstones = memoryTombstones();
    const waiting = requested({
      id: "0199d000-0000-7000-8000-0000000000d7",
      kind: "refused_removed",
      reasonCode: "other",
      tenantId: DEMO_TENANT_ID,
      ownerTenantUserId: sam.tenantUserId,
      deletedByTenantUserId: sam.tenantUserId,
      entryIds: [],
      personIds: [],
      count: 1,
      at: NOW.toISOString(),
    });
    await recordTombstone(tombstones.store, waiting);
    for (const id of [waiting.id, "0199d000-0000-7000-8000-0000000000d8"]) {
      await dev.execute("INSERT INTO sync_meta (id, key, value) VALUES (?, ?, ?)", [
        `${DISCARD_NOTE_PREFIX}${id}`,
        "discard_note",
        '{"reasonCode":"other","words":"Recorded twice by mistake"}',
      ]);
    }
    expect(await forgetDiscardNotes(dev.holdDb, tombstones.store)).toBe(1);
    const left = all<{ id: string }>(
      dev.sql,
      "SELECT id FROM sync_meta WHERE id LIKE 'discard-note:%'",
      [],
    );
    expect(left.map((r) => r.id)).toEqual([`${DISCARD_NOTE_PREFIX}${waiting.id}`]);
    // A keystore that cannot be read deletes nothing.
    const broken = {
      ...tombstones.store,
      read: async () => {
        throw new Error("keystore unavailable");
      },
    };
    await expect(forgetDiscardNotes(dev.holdDb, broken)).rejects.toThrow();
  });
});

describe("hazard HZ-040 entries a failed deletion left, which could not be moved (round 5, C-L6)", () => {
  it("say they will never be sent, apart from an ordinary restore", () => {
    expect(restoreProblem("failed", true)).toBe(t("mobile.vault.restoreBlockedFailed"));
    expect(restoreProblem({ restored: 0, parked: 1, remaining: 1 }, true)).toBe(
      t("mobile.vault.restoreBlockedFailed"),
    );
    expect(restoreProblem({ restored: 0, parked: 2, remaining: 0 }, true)).toBeNull();
    expect(restoreProblem("failed")).toBe(t("mobile.vault.restoreFailed"));
    expect(new RestoreFailedError().message).toBe(t("mobile.vault.restoreBlockedFailed"));
  });
});

describe("the hold marker always has a deadline (L2)", () => {
  const LATER = new Date("2026-10-12T09:00:00.000Z");
  const marker = (value: Record<string, unknown>) => async () => JSON.stringify(value);
  const dbId = async () => "abc";

  it("gives a marker without a deadline one of now plus the fail-safe days, to be saved", async () => {
    const loaded = await loadHeldMarker(
      {
        readMarker: marker({ tenantId: DEMO_TENANT_ID, userId: "u", heldAt: NOW.toISOString() }),
        readDatabaseId: dbId,
      },
      LATER,
    );
    expect(loaded.save).toBe(true);
    expect(loaded.held?.heldAt).toBe(NOW.toISOString());
    expect(loaded.held?.expiresAt).toBe(heldDeadline(LATER, HELD_FAIL_SAFE_DAYS).toISOString());
  });

  it("gives a damaged marker an unknown owner and a deadline, to be saved", async () => {
    const loaded = await loadHeldMarker(
      { readMarker: async () => "{not json", readDatabaseId: dbId },
      LATER,
    );
    expect(loaded).toEqual({ held: withDeadline(UNKNOWN_OWNER, LATER), save: true });
    expect(loaded.held?.expiresAt).toBe(heldDeadline(LATER, HELD_FAIL_SAFE_DAYS).toISOString());
  });

  it("never writes after a keystore error, so a passing error cannot replace the real marker", async () => {
    const loaded = await loadHeldMarker(
      {
        readMarker: async () => {
          throw new Error("keystore unavailable");
        },
        readDatabaseId: dbId,
      },
      LATER,
    );
    expect(loaded.save).toBe(false);
    expect(loaded.held?.tenantId).toBe("");
    expect(loaded.held?.expiresAt).toBe(heldDeadline(LATER, HELD_FAIL_SAFE_DAYS).toISOString());
  });

  it("leaves a marker with a deadline as it is", async () => {
    const stored = {
      tenantId: DEMO_TENANT_ID,
      userId: "u",
      heldAt: NOW.toISOString(),
      expiresAt: "2026-10-18T07:30:00.000Z",
    };
    const loaded = await loadHeldMarker(
      { readMarker: marker(stored), readDatabaseId: dbId },
      LATER,
    );
    expect(loaded.save).toBe(false);
    expect(loaded.held?.expiresAt).toBe(stored.expiresAt);
  });
});

describe("the time limit on a hold reads the tenant's figure (S2)", () => {
  it("reads the tenant's figure, caches it, and escalates after one day until it is known", async () => {
    const dev = await device();
    const rate = (value: number) =>
      new Response(JSON.stringify({ key: "mobile.held_entries_max_days", value, unit: "days" }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    const fetch: FetchLike = async () => rate(5);
    expect(
      await resolveHeldMaxDays(dev.db as unknown as MetaStore, {
        apiUrl: API,
        fetch,
        token: "tok",
        tenantId: DEMO_TENANT_ID,
      }),
    ).toBe(5);
    expect(await resolveHeldMaxDays(dev.db as unknown as MetaStore, null)).toBe(5);
    await dev.execute("DELETE FROM sync_meta WHERE id = ?", [HELD_MAX_META_ID]);
    expect(await resolveHeldMaxDays(dev.db as unknown as MetaStore, null)).toBe(
      HELD_FAIL_SAFE_DAYS,
    );
  });
});

function memoryTombstones(options: { failWrites?: boolean } = {}) {
  const items = new Map<string, string>();
  return {
    store: {
      read: async (key: string) => items.get(key) ?? null,
      write: async (key: string, value: string) => {
        if (options.failWrites) throw new Error("keystore full");
        items.set(key, value);
      },
      remove: async (key: string) => {
        items.delete(key);
      },
    },
    dump: () => [...items.values()].join("\n"),
  };
}

describe("hazard HZ-040 a hold names where its owner works, so the manager's task goes there (clinical review round 6, M2)", () => {
  const HOME = "0194d000-0000-7000-8000-000000000101";
  const LODGE = "0194d000-0000-7000-8000-000000000102";
  const samAtHome: Me = { ...sam, locations: [{ id: HOME, name: "Example House" }] };

  it("takes the opaque ids of the owner's sync scope, and nothing that is not an id", () => {
    expect(locationIdsOf(samAtHome)).toEqual([HOME]);
    expect(locationIdsOf(sam)).toEqual([]);
    expect(locationIdsOf(null)).toEqual([]);
    const marker: HeldWork = { ...withDeadline(UNKNOWN_OWNER, NOW), locationIds: [HOME, LODGE] };
    expect(parseHeldWork(serialiseHeldWork(marker))?.locationIds).toEqual([HOME, LODGE]);
    expect(
      parseHeldWork(JSON.stringify({ ...marker, locationIds: ["Example House"] })),
    ).not.toHaveProperty("locationIds");
  });

  it("holds the owner's locations when the session ends", async () => {
    let held: HeldWork | null = null;
    await handleSessionEnded({
      countPending: async () => ({ queued: 1, refused: 0, held: 0 }),
      owner: samAtHome,
      now: NOW,
      expiresAt: null,
      lastServerTime: null,
      wipe: async () => undefined,
      hold: async (next) => {
        held = next;
      },
    });
    expect(held).toMatchObject({ tenantUserId: sam.tenantUserId, locationIds: [HOME] });
  });

  it("holds the database owner's locations when someone else's sign-in is refused, and keeps them current for the owner", async () => {
    const dev = await device({ queued: 1 });
    await writeDeviceOwner(dev.db, ownerOf(samAtHome));
    const deps = (me: Me): OpenCheckDeps => ({
      db: dev.holdDb,
      me,
      created: false,
      afterReset: false,
      now: NOW,
      cachedHeldMaxDays: async () => null,
      reset: async () => undefined,
      closeKeeping: async () => undefined,
    });
    const refused = await admitToDatabase(deps(kit));
    if (refused.kind !== "refused") throw new Error("expected a refusal");
    expect(refused.held).toMatchObject({ tenantUserId: sam.tenantUserId, locationIds: [HOME] });
    // The owner now works at the Lodge too: the record follows.
    const moved: Me = {
      ...sam,
      locations: [
        { id: HOME, name: "Example House" },
        { id: LODGE, name: "Example Lodge" },
      ],
    };
    await admitToDatabase(deps(moved));
    expect(await readDeviceOwner(dev.db)).toMatchObject({ locationIds: [HOME, LODGE] });
  });
});
