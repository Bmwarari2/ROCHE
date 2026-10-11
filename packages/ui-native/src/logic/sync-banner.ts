/**
 * Wording and severity of the sync banner shown on every screen of the mobile app.
 *
 * Hazards: HZ-002 (stale offline data shown as current) is mitigated by an explicit "may be out of
 * date" warning once the last successful sync is older than the threshold; HZ-006 (silent sync
 * failure) by a "Sync failed" state with a retry action that is announced to screen readers, and
 * by the count of entries the server refused: while any is on the device the banner says so on
 * every screen and never reads "Up to date" (clinical review C1).
 */
import { isStale } from "./staleness";
import type { Tone } from "./theme";
import { formatLastSynced } from "./time";

export type SyncConnectionState = "offline" | "syncing" | "synced" | "failed";

/** Lucide icon names used by the banner. */
export type SyncBannerIcon =
  | "wifi-off"
  | "refresh-cw"
  | "circle-check"
  | "cloud-alert"
  | "triangle-alert";

export interface SyncBannerInput {
  readonly state: SyncConnectionState;
  readonly lastSyncedAt: Date | null;
  readonly now: Date;
  /** Data older than this is flagged as possibly out of date. */
  readonly staleAfterMs: number;
  /** Local changes waiting to upload. */
  readonly queuedChanges?: number;
  /** Entries the server refused, kept on the device as "needs attention". */
  readonly refusedEntries?: number;
}

export interface SyncBannerContent {
  readonly tone: Tone;
  readonly icon: SyncBannerIcon;
  readonly title: string;
  readonly detail: string;
  /** Present when the data may be out of date. */
  readonly warning: string | null;
  readonly stale: boolean;
  readonly showRetry: boolean;
  /** Announce changes assertively (failure or stale data) rather than politely. */
  readonly urgent: boolean;
  readonly accessibilityLabel: string;
}

const titles: Record<SyncConnectionState, string> = {
  offline: "Offline",
  syncing: "Syncing",
  synced: "Up to date",
  failed: "Sync failed",
};

export const STALE_WARNING = "Data may be out of date. Check important details before you act.";
export const NEVER_SYNCED_WARNING =
  "No data has been downloaded yet. Connect to the internet to sync.";

function queuedText(count: number): string | null {
  if (count <= 0) return null;
  return count === 1 ? "1 change waiting to upload." : `${count} changes waiting to upload.`;
}

/** Title shown instead of "Up to date" while refused entries are on the device. */
export const REFUSED_TITLE = "Not all saved";

export function refusedText(count: number): string | null {
  if (count <= 0) return null;
  return count === 1
    ? "1 entry was not saved and needs attention."
    : `${count} entries were not saved and need attention.`;
}

export function describeSyncBanner(input: SyncBannerInput): SyncBannerContent {
  const { state, lastSyncedAt, now, staleAfterMs } = input;
  const stale = isStale(lastSyncedAt, now, staleAfterMs);
  // While a first sync is in progress there is nothing stale on screen yet, only an empty list.
  const neverSynced = lastSyncedAt === null;

  const detailParts = [`${formatLastSynced(lastSyncedAt, now)}.`];
  const queued = queuedText(input.queuedChanges ?? 0);
  if (queued) detailParts.push(queued);
  const refused = refusedText(input.refusedEntries ?? 0);
  if (refused) detailParts.push(refused);
  const detail = detailParts.join(" ");

  let warning: string | null = null;
  if (neverSynced && state !== "syncing") warning = NEVER_SYNCED_WARNING;
  else if (stale && !neverSynced) warning = STALE_WARNING;

  let tone: Tone;
  let icon: SyncBannerIcon;
  switch (state) {
    case "failed":
      tone = "danger";
      icon = "cloud-alert";
      break;
    case "offline":
      tone = warning ? "warning" : "neutral";
      icon = warning ? "triangle-alert" : "wifi-off";
      break;
    case "syncing":
      tone = warning ? "warning" : "info";
      icon = warning ? "triangle-alert" : "refresh-cw";
      break;
    case "synced":
      tone = warning ? "warning" : "success";
      icon = warning ? "triangle-alert" : "circle-check";
      break;
  }

  // Refused entries outrank every calm state: never "Up to date" while one is on the device.
  if (refused) {
    tone = "danger";
    icon = "cloud-alert";
  }
  const title = refused && state === "synced" ? REFUSED_TITLE : titles[state];
  const urgent = state === "failed" || warning !== null || refused !== null;
  const accessibilityLabel = [`${title}.`, detail, warning].filter(Boolean).join(" ");

  return {
    tone,
    icon,
    title,
    detail,
    warning,
    stale,
    showRetry: state === "failed",
    urgent,
    accessibilityLabel,
  };
}
