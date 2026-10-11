import {
  SYNC_DISCARD_IDS_MISSING,
  SYNC_DISCARD_KINDS,
  SYNC_DISCARD_LEFTOVERS,
  SYNC_DISCARD_REASON_CODES,
  SYNC_DISCARD_STAGES,
} from "@harbour/contracts";
import { describe, expect, it } from "vitest";
import {
  acknowledgeStage,
  cleanTombstone,
  DISCARD_IDS_MISSING,
  DISCARD_KINDS,
  DISCARD_LEFTOVERS,
  DISCARD_REASON_CODES,
  DISCARD_STAGES,
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
    expect([...DISCARD_KINDS]).toEqual([...SYNC_DISCARD_KINDS]);
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
