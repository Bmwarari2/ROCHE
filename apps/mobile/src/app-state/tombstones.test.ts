import {
  SYNC_DISCARD_IDS_MISSING,
  SYNC_DISCARD_KINDS,
  SYNC_DISCARD_LEFTOVERS,
  SYNC_DISCARD_REASON_CODES,
  SYNC_DISCARD_STAGES,
  SyncKeyLost,
} from "@harbour/contracts";
import { describe, expect, it } from "vitest";
import { keyLostBody } from "../sync/discards";
import {
  acknowledgeStage,
  cleanTombstone,
  DISCARD_IDS_MISSING,
  DISCARD_KINDS,
  DISCARD_LEFTOVERS,
  DISCARD_REASON_CODES,
  DISCARD_STAGES,
  keyLostTombstone,
  MAX_TOMBSTONE_ENTRY_IDS,
  MAX_TOMBSTONES,
  purgeLegacyTombstones,
  readTombstones,
  recordTombstone,
  TOMBSTONE_INDEX_ITEM,
  TOMBSTONE_ITEM_PREFIX,
  type Tombstone,
  TombstoneWriteError,
} from "./tombstones";

/** Invented ids only. */
const id = (n: number) => `0199d000-0000-7000-8000-${n.toString(16).padStart(12, "0")}`;

const stone = (n: number, overrides: Partial<Tombstone> = {}): Tombstone => ({
  id: id(n),
  kind: "refused_removed",
  reasonCode: "recorded_elsewhere",
  stage: "requested",
  unsent: ["requested"],
  tenantId: "00000000-0000-4000-8000-0000000000a1",
  ownerTenantUserId: "00000000-0000-4000-8000-0000000000c1",
  deletedByTenantUserId: "00000000-0000-4000-8000-0000000000c1",
  entryIds: [id(1000 + n)],
  personIds: ["00000000-0000-4000-8000-0000000000b1"],
  count: 1,
  at: "2026-10-11T07:30:00.000Z",
  ...overrides,
});

function memoryStore(options: { failWrites?: boolean } = {}) {
  const items = new Map<string, string>();
  return {
    items,
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
  };
}

describe("hazard HZ-040 tombstones hold no personal data (security review M1)", () => {
  it("uses the API's kinds, reason codes and stages", () => {
    // The staff route's kinds, and the lost key, which has its own route (H-1531).
    expect([...DISCARD_KINDS]).toEqual([...SYNC_DISCARD_KINDS, "key_invalidated"]);
    expect([...DISCARD_REASON_CODES]).toEqual([...SYNC_DISCARD_REASON_CODES]);
    expect([...DISCARD_STAGES]).toEqual([...SYNC_DISCARD_STAGES]);
    expect([...DISCARD_LEFTOVERS]).toEqual([...SYNC_DISCARD_LEFTOVERS]);
    expect([...DISCARD_IDS_MISSING]).toEqual([...SYNC_DISCARD_IDS_MISSING]);
  });

  it("keeps why ids are missing and what a deletion left, and nothing that is not a code (round 5)", () => {
    expect(
      cleanTombstone({ ...stone(1), idsMissing: "key_invalid", leftover: ["key", "photos"] }),
    ).toMatchObject({ idsMissing: "key_invalid", leftover: ["key"] });
    const odd = cleanTombstone({ ...stone(1), idsMissing: "cancelled", leftover: "file" });
    expect(odd).not.toHaveProperty("idsMissing");
    expect(odd).not.toHaveProperty("leftover");
  });

  it("keeps the opaque id of the device the entries were held on, and nothing else in its place (round 6, M1)", () => {
    const heldOn = "0199d000-0000-4000-8000-00000000DE01";
    expect(cleanTombstone({ ...stone(1), deviceId: heldOn })).toMatchObject({
      deviceId: heldOn.toLowerCase(),
    });
    expect(cleanTombstone({ ...stone(1), deviceId: "Cat's phone" })).not.toHaveProperty("deviceId");
  });

  it("keeps only codes, opaque ids, a count and a time", async () => {
    const { store, items } = memoryStore();
    const withExtras = {
      ...stone(1),
      reason: "Ada Example's note was recorded on paper",
      ownerName: "Sam Example",
      entryIds: [id(1001), "Ada's note"],
      personIds: ["not-an-id"],
    } as unknown as Tombstone;
    await recordTombstone(store, withExtras);
    const kept = items.get(`${TOMBSTONE_ITEM_PREFIX}${id(1)}`) ?? "";
    expect(kept).not.toContain("Ada");
    expect(kept).not.toContain("Sam");
    expect(kept).not.toContain("paper");
    expect(JSON.parse(kept)).toEqual({ ...stone(1), entryIds: [id(1001)], personIds: [] });
  });

  it.each([
    ["an unknown kind", { kind: "held_expired" }],
    ["an unknown reason code", { reasonCode: "because" }],
    ["an id that is not an id", { id: "tombstone-1" }],
    ["a time that is not UTC", { at: "11/10/2026 08:30" }],
    ["an unknown stage", { stage: "undone" }],
  ])("refuses %s, and so refuses the deletion", async (_case, change) => {
    const { store } = memoryStore();
    await expect(
      recordTombstone(store, { ...stone(1), ...change } as unknown as Tombstone),
    ).rejects.toBeInstanceOf(TombstoneWriteError);
    expect(cleanTombstone({ ...stone(1), ...change })).toBeNull();
  });

  it("caps the ids so each keystore item stays small", () => {
    const many = Array.from({ length: 30 }, (_, i) => id(2000 + i));
    expect(cleanTombstone(stone(1, { entryIds: many }))?.entryIds).toHaveLength(
      MAX_TOMBSTONE_ENTRY_IDS,
    );
    expect(JSON.stringify(cleanTombstone(stone(1, { entryIds: many }))).length).toBeLessThan(2048);
  });
});

describe("hazard HZ-040 tombstones in the keystore (S4, M1, L4)", () => {
  it("throws when the keystore refuses the write, so the deletion is refused (L4)", async () => {
    const { store } = memoryStore({ failWrites: true });
    await expect(recordTombstone(store, stone(1))).rejects.toBeInstanceOf(TombstoneWriteError);
  });

  it("never drops a record the server does not have: a full list refuses the new deletion (round 4, M2)", async () => {
    const { store } = memoryStore();
    for (let i = 0; i < MAX_TOMBSTONES; i += 1) await recordTombstone(store, stone(i));
    const attempt = recordTombstone(store, stone(MAX_TOMBSTONES));
    await expect(attempt).rejects.toBeInstanceOf(TombstoneWriteError);
    await expect(attempt).rejects.toMatchObject({ full: true });
    const kept = await readTombstones(store);
    expect(kept).toHaveLength(MAX_TOMBSTONES);
    expect(kept[0]?.id).toBe(id(0));
  });

  it("makes room only by dropping records the server already has, oldest first", async () => {
    const { store, items } = memoryStore();
    for (let i = 0; i < MAX_TOMBSTONES; i += 1) await recordTombstone(store, stone(i));
    // The server has the request of the third: that one may go, the first two may not.
    await acknowledgeStage(store, id(2), "requested");
    await recordTombstone(store, stone(MAX_TOMBSTONES));
    const kept = (await readTombstones(store)).map((s) => s.id);
    expect(kept).toHaveLength(MAX_TOMBSTONES);
    expect(kept).not.toContain(id(2));
    expect(kept.slice(0, 2)).toEqual([id(0), id(1)]);
    // The dropped item is gone from the keystore, not just from the index.
    expect(items.has(`${TOMBSTONE_ITEM_PREFIX}${id(2)}`)).toBe(false);
  });

  it("updates a kept record in place for its next stage, even on a full list", async () => {
    const { store } = memoryStore();
    for (let i = 0; i < MAX_TOMBSTONES; i += 1) await recordTombstone(store, stone(i));
    await recordTombstone(store, stone(0, { stage: "failed", unsent: ["requested", "failed"] }));
    const [first] = await readTombstones(store);
    expect(first).toMatchObject({ id: id(0), stage: "failed", unsent: ["requested", "failed"] });
  });

  it("keeps an acknowledged request until its outcome, and forgets a finished deletion the server has", async () => {
    const { store, items } = memoryStore();
    await recordTombstone(store, stone(1));
    await recordTombstone(store, stone(2));
    await acknowledgeStage(store, id(1), "requested");
    expect((await readTombstones(store))[0]).toMatchObject({ id: id(1), unsent: [] });
    await recordTombstone(store, stone(1, { stage: "deleted", unsent: ["deleted"] }));
    await acknowledgeStage(store, id(1), "deleted");
    expect((await readTombstones(store)).map((s) => s.id)).toEqual([id(2)]);
    expect(items.has(`${TOMBSTONE_ITEM_PREFIX}${id(1)}`)).toBe(false);
    expect(JSON.parse(items.get(TOMBSTONE_INDEX_ITEM) ?? "[]")).toEqual([id(2)]);
  });

  it("reads a record kept before stages existed as a request to send again", () => {
    const { stage: _stage, unsent: _unsent, ...older } = stone(1);
    expect(cleanTombstone(older)).toMatchObject({ stage: "requested", unsent: ["requested"] });
  });

  it("removes tombstones in the earlier format, which could hold words", async () => {
    const { store, items } = memoryStore();
    items.set("harbour.tombstones.v1", JSON.stringify([id(9)]));
    items.set(`harbour.tombstone.v1.${id(9)}`, JSON.stringify({ reason: "Recorded on paper" }));
    await purgeLegacyTombstones(store);
    expect(items.size).toBe(0);
  });

  it("skips a damaged item rather than guessing", async () => {
    const { store, items } = memoryStore();
    await recordTombstone(store, stone(1));
    items.set(`${TOMBSTONE_ITEM_PREFIX}${id(1)}`, "{not json");
    expect(await readTombstones(store)).toEqual([]);
  });
});

describe("hazard HZ-006 a database its key no longer opens is put on record (H-1531)", () => {
  const at = new Date("2026-11-08T10:00:00.000Z");
  const held = {
    tenantId: id(1),
    tenantUserId: id(2),
    entries: 4,
    locationIds: [id(3)],
    lastServerTime: "2026-11-08T09:15:00.000Z",
  };
  const signedIn = { tenantId: id(5), tenantUserId: id(6), locationIds: [id(8)] };
  const none = { tenantId: null, tenantUserId: null, locationIds: [] };

  it.each([
    ["the hold's organisation, owner, count and places", held, signedIn, id(1), id(2), 4, [id(3)]],
    ["the person signed in when nothing was held", null, signedIn, id(5), id(6), null, [id(8)]],
    ["no organisation, kept for the next session", null, none, null, null, null, undefined],
  ] as const)("names %s", (_label, h, who, tenant, owner, count, places) => {
    const t = keyLostTombstone({ id: id(9), at, held: h, signedIn: who, deviceId: id(7) });
    expect(t).toMatchObject({
      kind: "key_invalidated",
      reasonCode: null,
      stage: "deleted",
      unsent: ["deleted"],
      tenantId: tenant,
      ownerTenantUserId: owner,
      deletedByTenantUserId: null,
      entryIds: [],
      personIds: [],
      count,
      idsMissing: "key_invalid",
      deviceId: id(7),
    });
    expect(t?.locationIds).toEqual(places);
  });

  it("goes to the key-lost route in the shape the API takes, and survives the keystore", () => {
    const t = keyLostTombstone({ id: id(9), at, held, signedIn, deviceId: id(7) });
    if (!t) throw new Error("expected a record");
    const body = keyLostBody(t);
    expect(SyncKeyLost.safeParse(body).success).toBe(true);
    expect(body).toMatchObject({
      deviceId: id(7),
      count: 4,
      locationIds: [id(3)],
      lastSyncedAt: "2026-11-08T09:15:00.000Z",
    });
    expect(cleanTombstone(JSON.parse(JSON.stringify(t)))).toEqual(t);
  });

  it("keeps a lost key's record when the list is full", async () => {
    const { store } = memoryStore();
    for (let n = 0; n < MAX_TOMBSTONES; n += 1) await recordTombstone(store, stone(100 + n));
    const t = keyLostTombstone({ id: id(9), at, held, signedIn, deviceId: null });
    if (!t) throw new Error("expected a record");
    await recordTombstone(store, t);
    expect((await readTombstones(store)).map((r) => r.id)).toContain(id(9));
  });

  it.each([
    ["a lost key with a reason", { kind: "key_invalidated", reasonCode: "other" }],
    ["any other kind without one", { kind: "held_deleted", reasonCode: null }],
  ])("drops %s", (_label, fields) => {
    expect(cleanTombstone({ id: id(9), at: at.toISOString(), ...fields })).toBeNull();
  });
});
