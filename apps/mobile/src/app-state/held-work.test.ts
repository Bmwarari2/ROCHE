import { AppSchema } from "@harbour/sync/client";
import { describe, expect, it } from "vitest";
import type { Me } from "../auth/auth-client";
import type { FetchLike } from "../auth/http";
import { DEMO_TENANT_ID, demoPeople } from "../demo/demo-data";
import { t } from "../i18n/t";
import {
  DB_ID_ITEM,
  databaseFilename,
  databaseKeyRemains,
  destroyDatabaseKey,
  type KeyOptions,
  type KeyProtection,
  loadOrCreateDatabaseKey,
  type SecretStore,
} from "../security/db-key";
import { type CrudEntryLike, HarbourConnector, SessionRevokedError } from "../sync/connector";
import {
  FINAL_WARNING_MS,
  HELD_FAIL_SAFE_DAYS,
  HELD_MAX_META_ID,
  heldDeadline,
  heldTimeState,
  resolveHeldMaxDays,
} from "../sync/held-limit";
import type { MetaStore } from "../sync/offline-window";
import { all, openLocalDatabase, type SqliteDatabase } from "../test-support/local-db";
import {
  admitSignIn,
  checkDeviceOwner,
  checkDiscardReason,
  countPendingWork,
  DiscardIncompleteError,
  discardHeldWork,
  type HeldWork,
  HeldWorkOwnerError,
  type HoldDb,
  handleSessionEnded,
  holdUnsentWork,
  isHeldWorkOwner,
  OWNER_META_ID,
  ownerOf,
  parseHeldWork,
  readDeviceOwner,
  readHeldMarker,
  restoreHeldWork,
  serialiseHeldWork,
  totalPending,
  UNKNOWN_OWNER,
  writeDeviceOwner,
} from "./held-work";
import { readTombstones, recordTombstone, type Tombstone } from "./tombstones";

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

const json = (status: number) =>
  new Response("{}", { status, headers: { "content-type": "application/json" } });

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
 * NHS numbers, resuscitation decisions, care plans), PowerSync's behaviour around it (an insert
 * into an entry table joins the upload queue; `disconnectAndClear` empties the synced tables and
 * the queue), the database file by name, its key in the keystore, and the held marker.
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
    });
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
    expect(await restoreHeldWork(dev.holdDb, NOW)).toEqual({ restored: 1, parked: 0 });
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
    expect(await restoreHeldWork(dev.holdDb, NOW)).toEqual({ restored: 0, parked: 1 });
    const [issue] = all<{ id: string; code: string }>(
      dev.sql,
      "SELECT id, code FROM upload_issue",
      [],
    );
    expect(issue).toEqual({ id: "odd-1", code: "held_not_restored" });
  });

  const heldFor: HeldWork = {
    tenantId: DEMO_TENANT_ID,
    tenantUserId: sam.tenantUserId,
    userId: sam.user.id,
    ownerName: "Sam Example",
    entries: 1,
    heldAt: NOW.toISOString(),
    expiresAt: null,
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

describe("Sign out and delete N unsent entries (S4, S5)", () => {
  const tombstone: Tombstone = {
    kind: "held_deleted",
    tenantId: DEMO_TENANT_ID,
    ownerTenantUserId: sam.tenantUserId,
    count: 2,
    recordIds: [],
    reason: "Recorded again on paper",
    at: NOW.toISOString(),
  };

  function discardDeps(dev: Device, overrides: { databaseGone?: boolean } = {}) {
    const tombstones = memoryTombstones();
    return {
      tombstones,
      deps: {
        readDatabaseId: () => dev.store.getItem(DB_ID_ITEM, keyOptions.plainOptions),
        deleteDatabaseFile: (name: string) => {
          dev.files.delete(name);
        },
        destroyKey: () => destroyDatabaseKey(dev.store, keyOptions),
        databaseGone: async (name: string) => overrides.databaseGone ?? !dev.files.has(name),
        keyRemains: () => databaseKeyRemains(dev.store, keyOptions),
        recordTombstone: (stone: Tombstone) => recordTombstone(tombstones.store, stone, "t1"),
        tombstone,
        clearHeld: async () => {
          dev.marker.value = null;
        },
        demo: false,
      },
    };
  }

  it("hazard HZ-006 hazard HZ-040 the explicit discard wipes", async () => {
    const { dev } = await heldDevice();
    const filename = databaseFilename(dev.key.id);
    const { deps, tombstones } = discardDeps(dev);
    await discardHeldWork(deps);

    expect(dev.files.has(filename)).toBe(false);
    expect(dev.marker.value).toBeNull();
    // The key is gone, so even a copy of the file could not be read.
    const reopened = await dev.reopen();
    expect(reopened.created).toBe(true);
    expect(reopened.key.id).not.toBe(dev.key.id);
    // On record: whose, how many, why and when (S4).
    expect(await readTombstones(tombstones.store)).toEqual([tombstone]);
  });

  it("hazard HZ-006 hazard HZ-040 stays held and says so when the file is still there (S5)", async () => {
    const { dev } = await heldDevice();
    const before = dev.marker.value;
    const { deps, tombstones } = discardDeps(dev, { databaseGone: false });
    await expect(discardHeldWork(deps)).rejects.toBeInstanceOf(DiscardIncompleteError);
    // A retry finds the same file again: the key and its id are kept until the file is gone.
    await expect(discardHeldWork(deps)).rejects.toThrow(t("mobile.held.discardIncomplete"));
    expect(dev.marker.value).toBe(before);
    expect((await dev.reopen()).created).toBe(false);
    // Nothing was deleted, so there is no deletion to record yet.
    expect(await readTombstones(tombstones.store)).toEqual([]);
  });

  it("hazard HZ-006 hazard HZ-040 stays held when the key is still in the keystore (S5)", async () => {
    const { dev } = await heldDevice();
    const before = dev.marker.value;
    const { deps } = discardDeps(dev);
    await expect(
      discardHeldWork({ ...deps, destroyKey: async () => undefined }),
    ).rejects.toBeInstanceOf(DiscardIncompleteError);
    expect(dev.marker.value).toBe(before);
  });

  it.each([
    ["", "mobile.discard.reasonRequired"],
    ["  ok ", "mobile.discard.reasonRequired"],
    ["x".repeat(501), "mobile.discard.reasonTooLong"],
  ])("hazard HZ-040 a deletion needs a reason (%j)", (reason, key) => {
    expect(checkDiscardReason(reason)?.key).toBe(key);
  });

  it("hazard HZ-040 accepts a reason the staff member gives", () => {
    expect(checkDiscardReason("Recorded again on paper")).toBeNull();
  });

  it("hazard HZ-006 the button and its confirmation name the count", () => {
    expect(t("mobile.held.discard", { count: 1 })).toBe("Sign out and delete 1 unsent entry");
    expect(t("mobile.held.discard", { count: 3 })).toBe("Sign out and delete 3 unsent entries");
    expect(t("mobile.held.discardTitle", { count: 3 })).toBe("Delete 3 unsent entries?");
    expect(t("mobile.held.title", { count: 3 })).toBe("Sign in again to send 3 entries");
    expect(t("mobile.signOut.unsent", { count: 2 })).toBe(
      "2 entries have not reached the server and will be deleted.",
    );
  });

  it("hazard HZ-040 says whose entries are waiting (C8)", () => {
    expect(t("mobile.held.owner", { name: "Sam Example" })).toBe(
      "Entries from Sam Example are waiting to be sent.",
    );
  });
});

describe("tombstones (S4)", () => {
  it("keeps each deletion as its own small keystore item, newest kept when full", async () => {
    const { store, size } = memoryTombstones();
    for (let i = 0; i < 45; i += 1) {
      await recordTombstone(
        store,
        {
          kind: "refused_removed",
          tenantId: DEMO_TENANT_ID,
          ownerTenantUserId: null,
          count: 1,
          recordIds: [`id-${i}`],
          reason: "r".repeat(900),
          at: NOW.toISOString(),
        },
        `t${i}`,
      );
    }
    const kept = await readTombstones(store);
    expect(kept).toHaveLength(40);
    expect(kept[0]?.recordIds).toEqual(["id-5"]);
    expect(kept[0]?.reason).toHaveLength(500);
    expect(size()).toBeGreaterThan(40);
  });
});

describe("the time limit on a hold (S2)", () => {
  it.each([
    [null, "2026-10-11T08:00:00Z", "open"],
    ["2026-10-18T07:30:00.000Z", "2026-10-11T08:00:00Z", "open"],
    ["2026-10-18T07:30:00.000Z", "2026-10-17T08:00:00Z", "final"],
    ["2026-10-18T07:30:00.000Z", "2026-10-18T07:30:00Z", "expired"],
    ["not a date", "2026-10-18T07:30:00Z", "open"],
  ])("a hold ending %s reads at %s as %s", (expiresAt, now, state) => {
    expect(heldTimeState(expiresAt, new Date(now))).toBe(state);
  });

  it("gives the final warning during the last day only", () => {
    const deadline = heldDeadline(NOW, 7);
    expect(
      heldTimeState(deadline.toISOString(), new Date(deadline.getTime() - FINAL_WARNING_MS - 1)),
    ).toBe("open");
    expect(
      heldTimeState(deadline.toISOString(), new Date(deadline.getTime() - FINAL_WARNING_MS)),
    ).toBe("final");
  });

  it("reads the tenant's figure, caches it, and holds for one day until it is known", async () => {
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

function memoryTombstones() {
  const items = new Map<string, string>();
  return {
    store: {
      read: async (key: string) => items.get(key) ?? null,
      write: async (key: string, value: string) => {
        items.set(key, value);
      },
    },
    size: () => items.size,
  };
}
