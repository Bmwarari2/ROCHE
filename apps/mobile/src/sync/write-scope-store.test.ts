import { afterEach, describe, expect, it, vi } from "vitest";

const stored = new Map<string, string>();
/** How many of the next writes fail. */
let failWrites = 0;
let failDeletes = false;
let failReads = false;

vi.mock("../platform/secure-store", () => ({
  WRITE_SCOPE_ITEM: "harbour.write-scope.v1",
  readPlain: async (key: string) => {
    if (failReads) throw new Error("keystore unavailable");
    return stored.get(key) ?? null;
  },
  writePlain: async (key: string, value: string) => {
    if (failWrites > 0) {
      failWrites -= 1;
      throw new Error("keystore unavailable");
    }
    stored.set(key, value);
  },
  deletePlain: async (key: string) => {
    if (failDeletes) throw new Error("keystore unavailable");
    stored.delete(key);
  },
}));

type Store = typeof import("./write-scope-store");
const { mayRecordFor } = await import("./write-scope");

/** The store as a fresh start of the app finds it (module state is lost on a restart). */
async function restart(): Promise<Store> {
  vi.resetModules();
  return import("./write-scope-store");
}

/**
 * Hazard HZ-073 (ADR-0071 review rounds 4 and 5): where the phone may record is kept across a
 * restart; when it cannot be kept, removed or read, the failure is logged by the item's name only
 * and the phone records about no one until a token's scope is kept, so it never falls back to an
 * older, wider scope or to a guess from the user's permissions.
 */
describe("hazard HZ-073 keeping where the phone may record (review rounds 4 and 5)", () => {
  const nurse = {
    locationIds: ["loc-north"],
    assigned: false,
    personIds: null,
    peopleLocationIds: ["loc-north"],
  };
  const wider = { ...nurse, locationIds: ["loc-north", "loc-south"] };
  const ada = { id: "person-ada", locationId: "loc-north" };

  afterEach(async () => {
    failWrites = 0;
    failDeletes = false;
    failReads = false;
    stored.clear();
    vi.restoreAllMocks();
  });

  it("keeps the scope a token carries, and finds it again after a restart", async () => {
    const store = await restart();
    await store.setWriteScope(nurse);
    expect(store.currentWriteScope()).toEqual(nurse);
    expect(JSON.parse(stored.get("harbour.write-scope.v1") ?? "null")).toEqual(nurse);
    const again = await restart();
    expect(await again.loadWriteScope()).toEqual(nurse);
  });

  it("logs a scope it cannot keep, by the item's name only, and records about no one until the next token", async () => {
    const store = await restart();
    stored.set("harbour.write-scope.v1", JSON.stringify(wider));
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    failWrites = 1;
    await store.setWriteScope(nurse);
    // No scope is known: the phone records about no one, and the person screen says why.
    expect(store.currentWriteScope()).toBeNull();
    expect(mayRecordFor(ada, store.currentWriteScope())).toBe(false);
    expect(warn).toHaveBeenCalledWith("write scope could not be stored", {
      item: "harbour.write-scope.v1",
      error: "Error",
    });
    // The older, wider scope is gone, so a restart does not bring it back.
    expect(stored.has("harbour.write-scope.v1")).toBe(false);
    expect(await (await restart()).loadWriteScope()).toBeNull();
    await store.setWriteScope(nurse);
    expect(store.currentWriteScope()).toEqual(nurse);
  });

  it("fails closed when the stored scope cannot be removed either (review round 5)", async () => {
    const store = await restart();
    stored.set("harbour.write-scope.v1", JSON.stringify(wider));
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    // The new scope cannot be written and the old one cannot be deleted: it is overwritten with a
    // value naming no scope, so a restart finds none.
    failWrites = 1;
    failDeletes = true;
    await store.setWriteScope(nurse);
    expect(store.currentWriteScope()).toBeNull();
    expect(warn).toHaveBeenCalledWith("write scope could not be removed", {
      item: "harbour.write-scope.v1",
      error: "Error",
    });
    expect(await (await restart()).loadWriteScope()).toBeNull();
  });

  it("never throws when the session ends and the scope cannot be removed, and the next start records about no one", async () => {
    const store = await restart();
    await store.setWriteScope(wider);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    failDeletes = true;
    await expect(store.clearWriteScope()).resolves.toBeUndefined();
    expect(store.currentWriteScope()).toBeNull();
    expect(warn).toHaveBeenCalledWith("write scope could not be removed", {
      item: "harbour.write-scope.v1",
      error: "Error",
    });
    // The next person to sign in on the phone never inherits the scope.
    expect(await (await restart()).loadWriteScope()).toBeNull();
  });

  it("records about no one when the stored scope cannot be read after a restart", async () => {
    const store = await restart();
    await store.setWriteScope(nurse);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    failReads = true;
    const again = await restart();
    expect(await again.loadWriteScope()).toBeNull();
    expect(mayRecordFor(ada, again.currentWriteScope())).toBe(false);
    expect(warn).toHaveBeenCalledWith("write scope could not be read", {
      item: "harbour.write-scope.v1",
      error: "Error",
    });
  });
});
