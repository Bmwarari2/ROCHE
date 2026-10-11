import { describe, expect, it } from "vitest";
import type { Me } from "../auth/auth-client";
import type { FetchLike } from "../auth/http";
import { t } from "../i18n/t";
import {
  DB_ID_ITEM,
  databaseFilename,
  destroyDatabaseKey,
  type KeyOptions,
  type KeyProtection,
  loadOrCreateDatabaseKey,
  type SecretStore,
} from "../security/db-key";
import {
  type CrudEntryLike,
  HarbourConnector,
  SessionRevokedError,
  type UploadSource,
} from "../sync/connector";
import {
  admitSignIn,
  countPendingWork,
  discardHeldWork,
  type HeldWork,
  HeldWorkOwnerError,
  handleSessionEnded,
  isHeldWorkOwner,
  parseHeldWork,
  serialiseHeldWork,
} from "./held-work";

const API = "https://api.example.invalid";
const TENANT = "00000000-0000-4000-8000-0000000000a1";
const OTHER_TENANT = "00000000-0000-4000-8000-0000000000a2";
const PERSON = "00000000-0000-4000-8000-0000000000b1";
const NOW = new Date("2026-10-11T07:30:00.000Z");

/** Invented staff: Ada Example wrote the entries overnight; Ben Sample signs in next. */
const ada: Me = {
  user: { id: "user-ada", name: "Ada Example" },
  tenant: { id: TENANT, name: "Example Care" },
  tenantUserId: "00000000-0000-4000-8000-0000000000c1",
  locations: [{ id: "loc-1", name: "Example House" }],
  permissions: ["care.note.create"],
};
const ben: Me = {
  ...ada,
  user: { id: "user-ben", name: "Ben Sample" },
  tenantUserId: "00000000-0000-4000-8000-0000000000c2",
};

/** A note written offline at 03:10 by the device clock. */
const note = (id: string): CrudEntryLike => ({
  op: "PUT",
  table: "care_note",
  id,
  opData: {
    tenant_id: TENANT,
    person_id: PERSON,
    location_id: "loc-1",
    category: "personal_care",
    body: "Settled; checked at 03:00.",
    tags: "[]",
    occurred_at: "2026-10-11T03:00:00.000Z",
    device_time: "2026-10-11T03:10:00.000Z",
    supersedes_id: null,
    correction_reason: null,
  },
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
function memoryStore(): SecretStore {
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

/**
 * A device: the encrypted database file (by name), its key in the keystore, PowerSync's upload
 * queue and the refused entries in `upload_issue`, plus the held marker in secure storage.
 */
async function device(options: { queued: CrudEntryLike[]; refused?: number }) {
  const store = memoryStore();
  const { key } = await loadOrCreateDatabaseKey({
    store,
    randomBytes,
    options: keyOptions,
    preferredProtection: "biometric",
  });
  const files = new Set([databaseFilename(key.id)]);
  const queue = [...options.queued];
  const refused = options.refused ?? 0;
  const marker: { value: string | null } = { value: null };

  const db = {
    getClientId: async () => "client-1",
    execute: async () => ({ rowsAffected: 1 }),
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
    getUploadQueueStats: async () => ({ count: queue.length }),
    getOptional: async <T>(sql: string) =>
      (sql.includes("upload_issue") ? { count: refused } : null) as T | null,
  };

  const wipe = async () => {
    files.delete(databaseFilename(key.id));
    await destroyDatabaseKey(store, keyOptions);
    marker.value = null;
  };
  const hold = async (held: HeldWork) => {
    marker.value = serialiseHeldWork(held);
  };
  /** What opening the vault again would find: the same key and file, or a fresh key. */
  const reopen = () =>
    loadOrCreateDatabaseKey({
      store,
      randomBytes,
      options: keyOptions,
      preferredProtection: "biometric",
    });

  return {
    key,
    store,
    files,
    queue,
    marker,
    db,
    source: db as unknown as UploadSource,
    wipe,
    hold,
    reopen,
  };
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

/** Ada's session expires overnight with her entries still on the device. */
async function heldDevice() {
  const dev = await device({ queued: [note("0199d000-0000-7000-8000-0000000000e1")] });
  const { instance, ended } = connectorFor(dev, fakeFetch([401]).fetch, "tok-1", ada);
  await expect(instance.uploadData(dev.source)).rejects.toBeInstanceOf(SessionRevokedError);
  await expect(ended[0]).resolves.toBe("held");
  const held = parseHeldWork(dev.marker.value);
  if (!held) throw new Error("expected held entries");
  return { dev, held };
}

describe("when the API ends the session (401 or 403)", () => {
  it("hazard HZ-006 a 401 with pending entries keeps them", async () => {
    const dev = await device({
      queued: [note("0199d000-0000-7000-8000-0000000000e1")],
      refused: 1,
    });
    const { instance, ended } = connectorFor(dev, fakeFetch([401]).fetch, "tok-1", ada);

    await expect(instance.uploadData(dev.source)).rejects.toBeInstanceOf(SessionRevokedError);
    await expect(ended[0]).resolves.toBe("held");

    // Nothing deleted: the file, its key and the queued and refused entries all remain.
    expect(dev.files.has(databaseFilename(dev.key.id))).toBe(true);
    expect(dev.queue).toHaveLength(1);
    expect(await countPendingWork(dev.db)).toEqual({ queued: 1, refused: 1 });
    const reopened = await dev.reopen();
    expect(reopened.created).toBe(false);
    expect(reopened.key.id).toBe(dev.key.id);
    // The owner is recorded, so only she can send them.
    expect(parseHeldWork(dev.marker.value)).toEqual({
      tenantId: TENANT,
      tenantUserId: ada.tenantUserId,
      userId: ada.user.id,
      entries: 2,
      heldAt: NOW.toISOString(),
    });
  });

  it.each([401, 403])(
    "hazard HZ-006 a %i from the sync token with pending entries keeps them too",
    async (status) => {
      const dev = await device({ queued: [note("0199d000-0000-7000-8000-0000000000e1")] });
      const { instance, ended } = connectorFor(dev, fakeFetch([status]).fetch, "tok-1", ada);
      await expect(instance.fetchCredentials()).resolves.toBeNull();
      await expect(ended[0]).resolves.toBe("held");
      expect(dev.files.size).toBe(1);
      expect(parseHeldWork(dev.marker.value)?.entries).toBe(1);
    },
  );

  it("hazard HZ-006 a 401 with no pending entries wipes", async () => {
    const dev = await device({ queued: [] });
    const { instance, ended } = connectorFor(dev, fakeFetch([401]).fetch, "tok-1", ada);

    await expect(instance.fetchCredentials()).resolves.toBeNull();
    await expect(ended[0]).resolves.toBe("wiped");

    expect(dev.files.size).toBe(0);
    expect(await dev.store.getItem(DB_ID_ITEM, keyOptions.plainOptions)).toBeNull();
    expect((await dev.reopen()).created).toBe(true);
    expect(dev.marker.value).toBeNull();
  });

  it("hazard HZ-006 refused entries alone are enough to keep the device", async () => {
    const dev = await device({ queued: [], refused: 1 });
    const { instance, ended } = connectorFor(dev, fakeFetch([401]).fetch, "tok-1", ada);
    await instance.fetchCredentials();
    await expect(ended[0]).resolves.toBe("held");
    expect(dev.files.size).toBe(1);
  });

  it("hazard HZ-006 keeps the entries when they cannot be counted", async () => {
    const calls = { wipe: 0, held: [] as HeldWork[] };
    const result = await handleSessionEnded({
      countPending: async () => {
        throw new Error("database busy");
      },
      owner: ada,
      now: NOW,
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
});

describe("signing in again while entries are held", () => {
  it("hazard HZ-006 the same user resumes and the queue drains", async () => {
    const { dev, held } = await heldDevice();
    const signedOut: string[] = [];

    const admitted = await admitSignIn({
      held,
      me: ada,
      token: "tok-2",
      signOut: async (token) => {
        signedOut.push(token);
      },
    });
    expect(admitted).toBe("resume");
    expect(signedOut).toEqual([]);

    // The vault reopens the same file with the same key and uploads with the new session.
    const reopened = await dev.reopen();
    expect(reopened.created).toBe(false);
    const { fetch, calls } = fakeFetch([201]);
    const { instance } = connectorFor(dev, fetch, "tok-2", ada);
    await instance.uploadData(dev.source);

    expect(await countPendingWork(dev.db)).toEqual({ queued: 0, refused: 0 });
    const headers = new Headers(calls[0]?.init?.headers);
    expect(calls[0]?.url).toBe(`${API}/v1/people/${PERSON}/notes`);
    expect(headers.get("authorization")).toBe("Bearer tok-2");
    // The same id as when it was written, so a replay is ignored.
    expect(headers.get("idempotency-key")).toBe("0199d000-0000-7000-8000-0000000000e1");
  });

  it("hazard HZ-006 a different user is refused", async () => {
    const { dev, held } = await heldDevice();
    const signedOut: string[] = [];

    const attempt = admitSignIn({
      held,
      me: ben,
      token: "tok-ben",
      signOut: async (token) => {
        signedOut.push(token);
      },
    });
    await expect(attempt).rejects.toBeInstanceOf(HeldWorkOwnerError);
    await expect(attempt).rejects.toThrow(
      "Entries from another member of staff are waiting. They need to sign in to send them.",
    );

    // The refused session is ended on the server, and the entries stay for their owner.
    expect(signedOut).toEqual(["tok-ben"]);
    expect(dev.queue).toHaveLength(1);
    expect(dev.files.size).toBe(1);
    expect(parseHeldWork(dev.marker.value)).toEqual(held);
  });

  const heldFor: HeldWork = {
    tenantId: TENANT,
    tenantUserId: ada.tenantUserId,
    userId: ada.user.id,
    entries: 1,
    heldAt: NOW.toISOString(),
  };

  // An "older marker" lacks the tenant_user id, so the sign-in (auth user) id is compared instead.
  it.each([
    { case: "the same member of staff", held: heldFor, me: ada, owner: true },
    { case: "another member of staff", held: heldFor, me: ben, owner: false },
    {
      case: "same sign-in, other tenant",
      held: heldFor,
      me: { ...ada, tenant: { id: OTHER_TENANT, name: "Other Care" } },
      owner: false,
    },
    {
      case: "older marker, same sign-in",
      held: { ...heldFor, tenantUserId: null },
      me: ada,
      owner: true,
    },
    {
      case: "older marker, another sign-in",
      held: { ...heldFor, tenantUserId: null },
      me: ben,
      owner: false,
    },
    {
      case: "a marker with no owner recorded",
      held: { ...heldFor, tenantUserId: null, userId: "" },
      me: ada,
      owner: false,
    },
  ])("hazard HZ-006 owner check: $case", ({ held, me, owner }) => {
    expect(isHeldWorkOwner(held, me)).toBe(owner);
  });

  it("hazard HZ-006 a damaged marker releases the entries to nobody", () => {
    const damaged = parseHeldWork("{not json");
    expect(damaged).not.toBeNull();
    if (!damaged) return;
    expect(isHeldWorkOwner(damaged, ada)).toBe(false);
    expect(isHeldWorkOwner(damaged, ben)).toBe(false);
    expect(parseHeldWork(null)).toBeNull();
  });

  it("lets anyone in when nothing is held", async () => {
    await expect(
      admitSignIn({ held: null, me: ben, token: "tok-ben", signOut: async () => undefined }),
    ).resolves.toBe("continue");
  });
});

describe("Sign out and delete N unsent entries", () => {
  it("hazard HZ-006 the explicit discard wipes", async () => {
    const { dev } = await heldDevice();
    const filename = databaseFilename(dev.key.id);

    await discardHeldWork({
      readDatabaseId: () => dev.store.getItem(DB_ID_ITEM, keyOptions.plainOptions),
      deleteDatabaseFile: (name) => {
        dev.files.delete(name);
      },
      destroyKey: () => destroyDatabaseKey(dev.store, keyOptions),
      clearHeld: async () => {
        dev.marker.value = null;
      },
      demo: false,
    });

    expect(dev.files.has(filename)).toBe(false);
    expect(dev.marker.value).toBeNull();
    // The key is gone, so even a copy of the file could not be read.
    const reopened = await dev.reopen();
    expect(reopened.created).toBe(true);
    expect(reopened.key.id).not.toBe(dev.key.id);
  });

  it("hazard HZ-006 the button and its confirmation name the count", () => {
    expect(t("mobile.held.discard", { count: 1 })).toBe("Sign out and delete 1 unsent entry");
    expect(t("mobile.held.discard", { count: 3 })).toBe("Sign out and delete 3 unsent entries");
    expect(t("mobile.held.discardTitle", { count: 3 })).toBe("Delete 3 unsent entries?");
    expect(t("mobile.held.title", { count: 3 })).toBe("Sign in again to send 3 entries");
  });
});
