/**
 * Maps PowerSync's status and the device's network state to the four banner states. Pure so the
 * rules are tested: an error always wins (no silent failure, HZ-006), then no network, then
 * activity.
 */
import type { SyncConnectionState } from "@harbour/ui-native/logic";

export interface SyncStatusLike {
  readonly connected: boolean;
  readonly connecting: boolean;
  readonly hasSynced?: boolean | undefined;
  readonly lastSyncedAt?: Date | undefined;
  readonly dataFlowStatus: {
    readonly downloading: boolean;
    readonly uploading: boolean;
    readonly downloadError?: Error | undefined;
    readonly uploadError?: Error | undefined;
  };
}

export interface NetworkLike {
  /** null while unknown (first render). */
  readonly isConnected?: boolean | null | undefined;
  readonly isInternetReachable?: boolean | null | undefined;
}

export function deriveConnectionState(
  status: SyncStatusLike,
  network: NetworkLike,
): SyncConnectionState {
  const { downloadError, uploadError, downloading, uploading } = status.dataFlowStatus;
  const offline = network.isConnected === false || network.isInternetReachable === false;

  if (offline) return "offline";
  if (downloadError || uploadError) return "failed";
  if (status.connecting) return "syncing";
  if (status.connected) {
    return downloading || uploading || status.hasSynced !== true ? "syncing" : "synced";
  }
  // Not connected, not trying, network present: treat as offline from the sync service's view.
  return "offline";
}

/** The last successful sync, or null if never. */
export function lastSyncedAtOf(status: SyncStatusLike): Date | null {
  return status.lastSyncedAt ?? null;
}
