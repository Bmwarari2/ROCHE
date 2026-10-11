import { SYNC_DISCARD_KINDS, SYNC_DISCARD_REASON_CODES } from "@harbour/contracts";
import { describe, expect, it } from "vitest";
import {
  acknowledgeTombstone,
  cleanTombstone,
  DISCARD_KINDS,
  DISCARD_REASON_CODES,
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
  it("uses the API's kinds and reason codes", () => {
    expect([...DISCARD_KINDS]).toEqual([...SYNC_DISCARD_KINDS]);
    expect([...DISCARD_REASON_CODES]).toEqual([...SYNC_DISCARD_REASON_CODES]);
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

  it("deletes the items that fall off the end of the list, keeping the newest", async () => {
    const { store, items } = memoryStore();
    for (let i = 0; i < MAX_TOMBSTONES + 5; i += 1) await recordTombstone(store, stone(i));
    const kept = await readTombstones(store);
    expect(kept).toHaveLength(MAX_TOMBSTONES);
    expect(kept[0]?.id).toBe(id(5));
    // The dropped items are gone from the keystore, not just from the index.
    expect(items.has(`${TOMBSTONE_ITEM_PREFIX}${id(0)}`)).toBe(false);
    expect(items.size).toBe(MAX_TOMBSTONES + 1);
  });

  it("deletes a tombstone once the server acknowledges it", async () => {
    const { store, items } = memoryStore();
    await recordTombstone(store, stone(1));
    await recordTombstone(store, stone(2));
    await acknowledgeTombstone(store, id(1));
    expect((await readTombstones(store)).map((s) => s.id)).toEqual([id(2)]);
    expect(items.has(`${TOMBSTONE_ITEM_PREFIX}${id(1)}`)).toBe(false);
    expect(JSON.parse(items.get(TOMBSTONE_INDEX_ITEM) ?? "[]")).toEqual([id(2)]);
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
