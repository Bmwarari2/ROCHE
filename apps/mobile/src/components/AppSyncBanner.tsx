import { SyncBanner } from "@harbour/ui-native";
import { useStatus } from "@powersync/react";
import { useNetworkState } from "expo-network";
import { useVault } from "../app-state/vault";
import { useHeldEntryCount, useQueuedChanges, useUploadIssues } from "../care/hooks";
import { appEnv } from "../config/app-env";
import { STALE_AFTER_MS } from "../config/constants";
import { deriveConnectionState, lastSyncedAtOf } from "../sync/sync-state";

/**
 * PowerSync status for every signed-in screen: connection, last successful sync, changes waiting
 * to upload, refused entries, failures with a retry, and the stale-data warning (HZ-002, HZ-006).
 */
export function AppSyncBanner() {
  const status = useStatus();
  const network = useNetworkState();
  const vault = useVault();
  // Re-counted when the sync status changes and when an entry is written on this device.
  const queued = useQueuedChanges();
  // Refused entries (C1) and entries still held after sign-in (M2) show on every screen, and the
  // banner never reads "Up to date" while any exist, or while they cannot be counted (clinical
  // review round 4, M4).
  const issues = useUploadIssues().length;
  const held = useHeldEntryCount();
  const refused = held === null ? null : issues + held;

  const state = appEnv.demoMode ? "offline" : deriveConnectionState(status, network);
  const lastSyncedAt = appEnv.demoMode ? vault.demoSeededAt : lastSyncedAtOf(status);

  return (
    <SyncBanner
      state={state}
      lastSyncedAt={lastSyncedAt}
      staleAfterMs={STALE_AFTER_MS}
      queuedChanges={queued}
      refusedEntries={refused}
      onRetry={() => {
        void vault.retrySync();
      }}
    />
  );
}
