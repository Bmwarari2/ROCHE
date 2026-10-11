import { SyncDiscard } from "@harbour/contracts";
import { describe, expect, it } from "vitest";
import { readTombstones, recordTombstone, type Tombstone } from "../app-state/tombstones";
import type { FetchLike } from "../auth/http";
import { t } from "../i18n/t";
import { DEVICE_HEADER, TENANT_HEADER } from "./connector";
import {
  type ApiOptions,
  DiscardNotSentError,
  discardBody,
  flushTombstones,
  putDiscardOnRecord,
  sendDiscard,
} from "./discards";

const API = "https://api.example.invalid";
const TENANT = "00000000-0000-4000-8000-0000000000a1";
const OTHER_TENANT = "00000000-0000-4000-8000-0000000000a2";
const id = (n: number) => `0199d000-0000-7000-8000-${n.toString(16).padStart(12, "0")}`;

const stone = (n: number, overrides: Partial<Tombstone> = {}): Tombstone => ({
  id: id(n),
  kind: "held_deleted",
  reasonCode: "staff_left",
  tenantId: TENANT,
  ownerTenantUserId: "00000000-0000-4000-8000-0000000000c1",
  deletedByTenantUserId: "00000000-0000-4000-8000-0000000000c3",
  entryIds: [id(1000 + n)],
  personIds: ["00000000-0000-4000-8000-0000000000b1"],
  count: 2,
  at: "2026-10-11T07:30:00.000Z",
  ...overrides,
});

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
  return { fetch, calls };
}

const options = (fetch: FetchLike): ApiOptions => ({
  apiUrl: API,
  fetch,
  token: "tok-mo",
  tenantId: TENANT,
  deviceId: "client-1",
});

describe("hazard HZ-040 deletions go to the API as audit events (security review M2)", () => {
  it("sends the contract's body, with the words only in the request", async () => {
    const { fetch, calls } = server([200]);
    expect(await sendDiscard(options(fetch), stone(1), "  Left last week  ")).toBe("acknowledged");
    const call = calls[0];
    expect(call?.url).toBe(`${API}/v1/sync/discards`);
    const headers = new Headers(call?.init?.headers);
    expect(headers.get("authorization")).toBe("Bearer tok-mo");
    expect(headers.get(TENANT_HEADER)).toBe(TENANT);
    expect(headers.get(DEVICE_HEADER)).toBe("client-1");
    const body = JSON.parse(String(call?.init?.body));
    expect(SyncDiscard.safeParse(body).success).toBe(true);
    expect(body).toMatchObject({ id: id(1), reasonCode: "staff_left", reason: "Left last week" });
    expect(discardBody(stone(1), null)).not.toHaveProperty("reason");
  });

  it.each([
    [200, "acknowledged"],
    [422, "rejected"],
    [400, "rejected"],
    [401, "retry"],
    [403, "retry"],
    [429, "retry"],
    [503, "retry"],
  ] as const)("reads a %i as %s", async (status, result) => {
    expect(await sendDiscard(options(server([status]).fetch), stone(1))).toBe(result);
  });

  it("reads no network as try again later", async () => {
    expect(await sendDiscard(options(server([new Error("offline")]).fetch), stone(1))).toBe(
      "retry",
    );
  });

  it("puts a deletion on record and drops the tombstone once the server has it", async () => {
    const store = memoryStore();
    const { fetch } = server([200]);
    const result = await putDiscardOnRecord({
      store,
      tombstone: stone(1),
      reason: null,
      send: (s, r) => sendDiscard(options(fetch), s, r),
    });
    expect(result).toBe("sent");
    expect(await readTombstones(store)).toEqual([]);
  });

  it("keeps a coded deletion to send again when the server cannot take it now", async () => {
    const store = memoryStore();
    const result = await putDiscardOnRecord({
      store,
      tombstone: stone(1),
      reason: "Left last week",
      send: async () => "retry",
    });
    expect(result).toBe("queued");
    expect(await readTombstones(store)).toEqual([stone(1)]);
  });

  it("refuses an 'other' deletion the server cannot take now: its words are never kept", async () => {
    const store = memoryStore();
    const attempt = putDiscardOnRecord({
      store,
      tombstone: stone(1, { reasonCode: "other" }),
      reason: "Duplicate device",
      send: async () => "retry",
    });
    await expect(attempt).rejects.toBeInstanceOf(DiscardNotSentError);
    await expect(attempt).rejects.toThrow(t("mobile.discard.needsConnection"));
    expect(await readTombstones(store)).toEqual([]);
  });

  it("refuses a deletion the server rejects", async () => {
    const store = memoryStore();
    await expect(
      putDiscardOnRecord({
        store,
        tombstone: stone(1),
        reason: null,
        send: async () => "rejected",
      }),
    ).rejects.toThrow(t("mobile.discard.notRecorded"));
    expect(await readTombstones(store)).toEqual([]);
  });

  it("sends waiting deletions at the next sync until the server has them, for this tenant only", async () => {
    const store = memoryStore();
    await recordTombstone(store, stone(1));
    await recordTombstone(store, stone(2, { tenantId: OTHER_TENANT }));
    await recordTombstone(store, stone(3));
    // The first goes; the third meets no network and waits with the other tenant's.
    const { fetch, calls } = server([200, new Error("offline")]);
    expect(await flushTombstones(store, options(fetch))).toEqual({ sent: 1, waiting: 2 });
    expect(calls).toHaveLength(2);
    expect((await readTombstones(store)).map((s) => s.id)).toEqual([id(2), id(3)]);
    // Later, online: the third goes; the other tenant's waits for a session there.
    const online = server([200]);
    expect(await flushTombstones(store, options(online.fetch))).toEqual({ sent: 1, waiting: 1 });
    expect(JSON.parse(String(online.calls[0]?.init?.body))).not.toHaveProperty("reason");
    expect((await readTombstones(store)).map((s) => s.id)).toEqual([id(2)]);
  });

  it("drops a waiting deletion the server will never take", async () => {
    const store = memoryStore();
    await recordTombstone(store, stone(1, { reasonCode: "other" }));
    expect(await flushTombstones(store, options(server([422]).fetch))).toEqual({
      sent: 1,
      waiting: 0,
    });
    expect(await readTombstones(store)).toEqual([]);
  });
});
