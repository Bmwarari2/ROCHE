import { SYNC_DISCARD_MAX_ENTRY_IDS, SyncDiscard } from "@harbour/contracts";
import { describe, expect, it } from "vitest";
import {
  MAX_TOMBSTONE_ENTRY_IDS,
  readTombstones,
  recordTombstone,
  type Tombstone,
} from "../app-state/tombstones";
import type { FetchLike } from "../auth/http";
import { t } from "../i18n/t";
import { DEVICE_HEADER, TENANT_HEADER } from "./connector";
import {
  type ApiOptions,
  DiscardNotSentError,
  discardBody,
  finishDiscard,
  flushTombstones,
  MAX_SENT_ENTRY_IDS,
  putDiscardOnRecord,
  requested,
  sendDiscard,
  senderFor,
} from "./discards";

const API = "https://api.example.invalid";
const TENANT = "00000000-0000-4000-8000-0000000000a1";
const OTHER_TENANT = "00000000-0000-4000-8000-0000000000a2";
const CARER = "00000000-0000-4000-8000-0000000000c1";
const MANAGER = "00000000-0000-4000-8000-0000000000c3";
const id = (n: number) => `0199d000-0000-7000-8000-${n.toString(16).padStart(12, "0")}`;

/** A carer deleting their own entries, at the "requested" stage. */
const own = (n: number, overrides: Partial<Tombstone> = {}): Tombstone =>
  requested({
    id: id(n),
    kind: "signed_out_with_unsent",
    reasonCode: "staff_left",
    tenantId: TENANT,
    ownerTenantUserId: CARER,
    deletedByTenantUserId: CARER,
    entryIds: [id(1000 + n)],
    personIds: ["00000000-0000-4000-8000-0000000000b1"],
    count: 2,
    at: "2026-10-11T07:30:00.000Z",
    ...overrides,
  });

/** A deletion that has finished on the device, with both stages still to send. */
const finished = (tombstone: Tombstone): Tombstone => ({
  ...tombstone,
  stage: "deleted",
  unsent: ["requested", "deleted"],
});

/** A manager deleting a carer's held entries. */
const others = (n: number, overrides: Partial<Tombstone> = {}): Tombstone =>
  own(n, { kind: "held_deleted", deletedByTenantUserId: MANAGER, ...overrides });

function memoryStore() {
  const items = new Map<string, string>();
  return {
    read: async (key: string) => items.get(key) ?? null,
    write: async (key: string, value: string) => {
      items.set(key, value);
    },
    remove: async (key: string) => {
      items.delete(key);
    },
  };
}

function server(statuses: Array<number | Error>) {
  const calls: Array<{ url: string; init: RequestInit | undefined }> = [];
  const fetch: FetchLike = async (url, init) => {
    calls.push({ url, init });
    const next = statuses.shift() ?? 200;
    if (next instanceof Error) throw next;
    return new Response(next === 200 ? "{}" : "", { status: next });
  };
  const bodies = () =>
    calls.map((c) => JSON.parse(String(c.init?.body)) as Record<string, unknown>);
  return { fetch, calls, bodies };
}

const options = (fetch: FetchLike): ApiOptions => ({
  apiUrl: API,
  fetch,
  token: "tok-mo",
  tenantId: TENANT,
  deviceId: "0199d000-0000-4000-8000-00000000de01",
});

describe("hazard HZ-040 deletions go to the API as audit events, one per stage", () => {
  it("sends the contract's body with its stage and the coded reason only (round 4, M3)", async () => {
    const { fetch, calls, bodies } = server([200]);
    expect(await sendDiscard(options(fetch), own(1), "requested")).toBe("acknowledged");
    const call = calls[0];
    expect(call?.url).toBe(`${API}/v1/sync/discards`);
    const headers = new Headers(call?.init?.headers);
    expect(headers.get("authorization")).toBe("Bearer tok-mo");
    expect(headers.get(TENANT_HEADER)).toBe(TENANT);
    expect(headers.get(DEVICE_HEADER)).toBe("0199d000-0000-4000-8000-00000000de01");
    const [body] = bodies();
    expect(SyncDiscard.safeParse(body).success).toBe(true);
    expect(body).toMatchObject({ id: id(1), stage: "requested", reasonCode: "staff_left" });
    expect(body).not.toHaveProperty("reason");
  });

  it("sends a sample of a large hold's ids, never more than the API takes or than its count (round 4, low)", () => {
    expect(MAX_SENT_ENTRY_IDS).toBe(SYNC_DISCARD_MAX_ENTRY_IDS);
    const many = Array.from({ length: 600 }, (_, i) => id(5000 + i));
    const body = discardBody(own(1, { entryIds: many, count: 600 }), "requested");
    expect(body.entryIds).toHaveLength(SYNC_DISCARD_MAX_ENTRY_IDS);
    expect(SyncDiscard.safeParse(body).success).toBe(true);
    // A count lower than the ids it carries is raised to them, so the request is never refused.
    const short = discardBody(own(1, { entryIds: [id(1), id(2), id(3)], count: 1 }), "deleted");
    expect(short.count).toBe(3);
    expect(SyncDiscard.safeParse(short).success).toBe(true);
  });

  it.each([
    [200, "acknowledged"],
    [400, "rejected"],
    [413, "rejected"],
    [422, "rejected"],
    [403, "forbidden"],
    [401, "retry"],
    [429, "retry"],
    [503, "retry"],
  ] as const)("reads a %i as %s", async (status, result) => {
    expect(await sendDiscard(options(server([status]).fetch), own(1), "requested")).toBe(result);
  });

  it("reads no network as try again later", async () => {
    const offline = server([new Error("offline")]);
    expect(await sendDiscard(options(offline.fetch), own(1), "requested")).toBe("retry");
  });
});

describe("hazard HZ-040 putting a deletion on record before anything is deleted (round 4, M2)", () => {
  it("keeps an acknowledged request until the deletion's outcome is known", async () => {
    const store = memoryStore();
    const { fetch } = server([200]);
    const result = await putDiscardOnRecord({
      store,
      tombstone: own(1),
      send: senderFor(options(fetch)),
    });
    expect(result).toBe("sent");
    expect(await readTombstones(store)).toEqual([{ ...own(1), unsent: [] }]);
  });

  it("lets a carer's own deletion wait to be sent when the server cannot take it now", async () => {
    const store = memoryStore();
    const result = await putDiscardOnRecord({
      store,
      tombstone: own(1),
      send: async () => "retry",
    });
    expect(result).toBe("queued");
    expect(await readTombstones(store)).toEqual([own(1)]);
  });

  it.each([
    ["another member of staff's entries", others(1)],
    ["entries whose owner is not known", own(1, { ownerTenantUserId: null })],
  ])("deletes %s only once the server has acknowledged the request", async (_case, tombstone) => {
    const store = memoryStore();
    const attempt = putDiscardOnRecord({ store, tombstone, send: async () => "retry" });
    await expect(attempt).rejects.toBeInstanceOf(DiscardNotSentError);
    await expect(attempt).rejects.toThrow(t("mobile.discard.needsConnection"));
    expect(await readTombstones(store)).toEqual([]);
  });

  it.each([
    ["forbidden", "mobile.discard.notAllowed"],
    ["rejected", "mobile.discard.notRecorded"],
  ] as const)("refuses a deletion the server answers %s, deleting nothing", async (answer, key) => {
    const store = memoryStore();
    await expect(
      putDiscardOnRecord({ store, tombstone: own(1), send: async () => answer }),
    ).rejects.toThrow(t(key));
    expect(await readTombstones(store)).toEqual([]);
  });
});

describe("hazard HZ-040 how a deletion ended (clinical review round 4, H1)", () => {
  it("sends deleted after an acknowledged request, then forgets the record", async () => {
    const store = memoryStore();
    const { fetch, bodies } = server([200, 200]);
    const send = senderFor(options(fetch));
    await putDiscardOnRecord({ store, tombstone: others(1), send });
    expect(await finishDiscard({ store, tombstone: others(1), outcome: "deleted", send })).toBe(
      "acknowledged",
    );
    expect(bodies().map((b) => b.stage)).toEqual(["requested", "deleted"]);
    expect(await readTombstones(store)).toEqual([]);
  });

  it("supersedes an acknowledged request with failed when the file remains", async () => {
    const store = memoryStore();
    const { fetch, bodies } = server([200, 200]);
    const send = senderFor(options(fetch));
    await putDiscardOnRecord({ store, tombstone: others(1), send });
    await finishDiscard({ store, tombstone: others(1), outcome: "failed", send });
    expect(bodies().map((b) => b.stage)).toEqual(["requested", "failed"]);
    expect(bodies().every((b) => SyncDiscard.safeParse(b).success)).toBe(true);
    expect(await readTombstones(store)).toEqual([]);
  });

  it("sends a queued request before its outcome, in order, and keeps both until the server has them", async () => {
    const store = memoryStore();
    await putDiscardOnRecord({ store, tombstone: own(1), send: async () => "retry" });
    const offline = server([new Error("offline")]);
    await finishDiscard({
      store,
      tombstone: own(1),
      outcome: "deleted",
      send: senderFor(options(offline.fetch)),
    });
    expect(await readTombstones(store)).toEqual([
      { ...own(1), stage: "deleted", unsent: ["requested", "deleted"] },
    ]);
    const online = server([200, 200]);
    expect(await flushTombstones(store, options(online.fetch))).toEqual({
      sent: 1,
      skipped: 0,
      waiting: 0,
    });
    expect(online.bodies().map((b) => b.stage)).toEqual(["requested", "deleted"]);
    expect(await readTombstones(store)).toEqual([]);
  });
});

describe("hazard HZ-040 sending waiting deletions at each sync (round 4, M2)", () => {
  it("sends this tenant's only, and stops at a network failure", async () => {
    const store = memoryStore();
    await recordTombstone(store, finished(own(1)));
    await recordTombstone(store, finished(own(2, { tenantId: OTHER_TENANT })));
    await recordTombstone(store, finished(own(3)));
    const { fetch, calls } = server([200, 200, new Error("offline")]);
    expect(await flushTombstones(store, options(fetch))).toEqual({
      sent: 1,
      skipped: 0,
      waiting: 2,
    });
    expect(calls).toHaveLength(3);
    expect((await readTombstones(store)).map((s) => s.id)).toEqual([id(2), id(3)]);
  });

  it("skips and keeps a record this session may not send (403), and carries on with the next", async () => {
    const store = memoryStore();
    await recordTombstone(store, finished(others(1)));
    await recordTombstone(store, finished(own(2)));
    const skip = new Set<string>();
    const first = server([403, 200, 200]);
    expect(await flushTombstones(store, options(first.fetch), skip)).toEqual({
      sent: 1,
      skipped: 1,
      waiting: 1,
    });
    expect((await readTombstones(store)).map((s) => s.id)).toEqual([id(1)]);
    // Not tried again in the same session.
    const again = server([]);
    await flushTombstones(store, options(again.fetch), skip);
    expect(again.calls).toHaveLength(0);
    // A manager's session sends it.
    const manager = server([200, 200]);
    expect(await flushTombstones(store, options(manager.fetch))).toMatchObject({ sent: 1 });
    expect(await readTombstones(store)).toEqual([]);
  });

  it("never drops a record the server refuses: it is kept and skipped", async () => {
    const store = memoryStore();
    await recordTombstone(store, own(1));
    expect(await flushTombstones(store, options(server([422]).fetch))).toEqual({
      sent: 0,
      skipped: 1,
      waiting: 1,
    });
    expect(await readTombstones(store)).toEqual([own(1)]);
  });

  it("sends the keystore's sample of a large hold's ids, which the API takes", async () => {
    const store = memoryStore();
    const many = Array.from({ length: 600 }, (_, i) => id(5000 + i));
    await recordTombstone(store, own(1, { entryIds: many, count: 600 }));
    const { fetch, bodies } = server([200]);
    await flushTombstones(store, options(fetch));
    expect(bodies()[0]?.entryIds).toHaveLength(MAX_TOMBSTONE_ENTRY_IDS);
    expect(bodies()[0]?.count).toBe(600);
    expect(SyncDiscard.safeParse(bodies()[0]).success).toBe(true);
  });
});
