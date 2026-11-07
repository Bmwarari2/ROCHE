import { SyncBanner } from "@harbour/ui-native";
import { useStatus } from "@powersync/react";
import { useNetworkState } from "expo-network";
import { useEffect } from "react";
import { useVault } from "../app-state/vault";
import { useHeldEntryCount, useQueuedChanges, useUploadIssueState } from "../care/hooks";
import { appEnv } from "../config/app-env";
import { STALE_AFTER_MS } from "../config/constants";
import {
  announceRefusalOnce,
  forgetRefusalAnnouncement,
  useScopeRefused,
} from "../sync/scope-refusal-store";
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
  // reviews round 4 M4 and round 5 C-L7).
  const issues = useUploadIssueState().count;
  const held = useHeldEntryCount();
  const refused = held === null || issues === null ? null : issues + held;

  // The API refused this phone because the member's access is too wide (ADR-0134; HZ-138).
  // Offline wins: the refusal is said again once the phone can reach the API (review, minor 7).
  const scopeRefused = useScopeRefused();
  const derived = appEnv.demoMode ? "offline" : deriveConnectionState(status, network);
  const showRefusal = scopeRefused && !appEnv.demoMode && derived !== "offline";
  const state = showRefusal ? "failed" : derived;
  // Said again after the phone has been offline, when the refusal shows once more (review, minor 2).
  useEffect(() => {
    if (!showRefusal) forgetRefusalAnnouncement();
  }, [showRefusal]);
  const lastSyncedAt = appEnv.demoMode ? vault.demoSeededAt : lastSyncedAtOf(status);

  return (
    <SyncBanner
      state={state}
      lastSyncedAt={lastSyncedAt}
      staleAfterMs={STALE_AFTER_MS}
      queuedChanges={queued}
      refusedEntries={refused}
      failureReason={showRefusal ? "scope_too_large" : null}
      announce={announceRefusalOnce}
      onRetry={() => {
        void vault.retrySync();
      }}
    />
  );
}
