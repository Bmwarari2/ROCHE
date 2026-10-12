import { afterEach, describe, expect, it, vi } from "vitest";

const stored = new Map<string, string>();
let failWrites = false;

vi.mock("../platform/secure-store", () => ({
  WRITE_SCOPE_ITEM: "harbour.write-scope.v1",
  readPlain: async (key: string) => stored.get(key) ?? null,
  writePlain: async (key: string, value: string) => {
    if (failWrites) throw new Error("keystore unavailable");
    stored.set(key, value);
  },
  deletePlain: async (key: string) => {
    stored.delete(key);
  },
}));

const { clearWriteScope, currentWriteScope, setWriteScope } = await import("./write-scope-store");
const { NO_WRITE_SCOPE } = await import("./write-scope");

/**
 * Hazard HZ-073 (ADR-0071 review round 4): where the phone may record is kept across a restart;
 * when it cannot be kept, the failure is logged and the phone records about no one until the next
 * token, so it never falls back to an older, wider scope.
 */
describe("hazard HZ-073 keeping where the phone may record (review round 4)", () => {
  const nurse = {
    locationIds: ["loc-north"],
    assigned: false,
    personIds: null,
    peopleLocationIds: ["loc-north"],
  };

  afterEach(async () => {
    failWrites = false;
    await clearWriteScope();
    vi.restoreAllMocks();
  });

  it("keeps the scope a token carries", async () => {
    await setWriteScope(nurse);
    expect(currentWriteScope()).toEqual(nurse);
    expect(JSON.parse(stored.get("harbour.write-scope.v1") ?? "null")).toEqual(nurse);
  });

  it("logs a scope it cannot keep, by the item's name only, and records about no one until the next token", async () => {
    stored.set(
      "harbour.write-scope.v1",
      JSON.stringify({ ...nurse, locationIds: ["loc-north", "loc-south"] }),
    );
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    failWrites = true;
    await setWriteScope(nurse);
    expect(currentWriteScope()).toEqual(NO_WRITE_SCOPE);
    expect(warn).toHaveBeenCalledWith("write scope could not be stored", {
      item: "harbour.write-scope.v1",
      error: "Error",
    });
    // The older, wider scope is gone, so a restart does not bring it back.
    expect(stored.has("harbour.write-scope.v1")).toBe(false);
    failWrites = false;
    await setWriteScope(nurse);
    expect(currentWriteScope()).toEqual(nurse);
  });
});
