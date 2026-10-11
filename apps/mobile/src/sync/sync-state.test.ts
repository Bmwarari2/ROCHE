import { describe, expect, it } from "vitest";
import { deriveConnectionState, lastSyncedAtOf, type SyncStatusLike } from "./sync-state";

function status(
  overrides: Partial<SyncStatusLike> = {},
  flow: Partial<SyncStatusLike["dataFlowStatus"]> = {},
) {
  return {
    connected: false,
    connecting: false,
    hasSynced: true,
    lastSyncedAt: new Date("2026-10-09T13:00:00Z"),
    ...overrides,
    dataFlowStatus: { downloading: false, uploading: false, ...flow },
  } satisfies SyncStatusLike;
}

const online = { isConnected: true, isInternetReachable: true };

describe("deriveConnectionState", () => {
  it.each([
    ["connected and idle", status({ connected: true }), online, "synced"],
    [
      "connected and downloading",
      status({ connected: true }, { downloading: true }),
      online,
      "syncing",
    ],
    [
      "connected and uploading",
      status({ connected: true }, { uploading: true }),
      online,
      "syncing",
    ],
    [
      "connected, first sync not finished",
      status({ connected: true, hasSynced: false }),
      online,
      "syncing",
    ],
    ["connecting", status({ connecting: true }), online, "syncing"],
    ["no network", status(), { isConnected: false }, "offline"],
    [
      "network but no internet",
      status(),
      { isConnected: true, isInternetReachable: false },
      "offline",
    ],
    ["network unknown, disconnected", status(), { isConnected: null }, "offline"],
    [
      "download error",
      status({ connected: true }, { downloadError: new Error("x") }),
      online,
      "failed",
    ],
    [
      "upload error while connected",
      status({ connected: true }, { uploadError: new Error("x") }),
      online,
      "failed",
    ],
    [
      "upload error while disconnected",
      status({}, { uploadError: new Error("x") }),
      online,
      "failed",
    ],
    [
      "offline beats a stale error",
      status({}, { downloadError: new Error("x") }),
      { isConnected: false },
      "offline",
    ],
  ] as const)("%s", (_label, input, network, expected) => {
    expect(deriveConnectionState(input, network)).toBe(expected);
  });
});

describe("lastSyncedAtOf", () => {
  it("returns null before the first sync", () => {
    expect(lastSyncedAtOf(status({ lastSyncedAt: undefined }))).toBeNull();
  });
});
