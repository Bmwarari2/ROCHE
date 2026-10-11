import { SyncBanner } from "@harbour/ui-native";
import { usePowerSync, useStatus } from "@powersync/react";
import { useNetworkState } from "expo-network";
import { useEffect, useState } from "react";
import { useVault } from "../app-state/vault";
import { appEnv } from "../config/app-env";
import { STALE_AFTER_MS } from "../config/constants";
import { deriveConnectionState, lastSyncedAtOf } from "../sync/sync-state";

/**
 * PowerSync status for every signed-in screen: connection, last successful sync, changes waiting
 * to upload, failures with a retry, and the stale-data warning (HZ-002, HZ-006).
 */
export function AppSyncBanner() {
  const db = usePowerSync();
  const status = useStatus();
  const network = useNetworkState();
  const vault = useVault();
  const [queued, setQueued] = useState(0);

  // Re-count queued uploads now and whenever the sync status changes (uploads start or finish).
  useEffect(() => {
    let active = true;
    const refresh = () => {
      db.getUploadQueueStats()
        .then((stats) => {
          if (active) setQueued(stats.count);
        })
        .catch(() => undefined);
    };
    refresh();
    const dispose = db.registerListener({ statusChanged: refresh });
    return () => {
      active = false;
      dispose();
    };
  }, [db]);

  const state = appEnv.demoMode ? "offline" : deriveConnectionState(status, network);
  const lastSyncedAt = appEnv.demoMode ? vault.demoSeededAt : lastSyncedAtOf(status);

  return (
    <SyncBanner
      state={state}
      lastSyncedAt={lastSyncedAt}
      staleAfterMs={STALE_AFTER_MS}
      queuedChanges={queued}
      onRetry={() => {
        void vault.retrySync();
      }}
    />
  );
}
