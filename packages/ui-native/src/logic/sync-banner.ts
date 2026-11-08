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
import { DAY_MS, formatDate, formatTime, HOUR_MS, MINUTE_MS } from "./time";

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
  /**
   * Entries kept on the device as "needs attention" (refused by the server, or still held). Null
   * when they could not be counted, which needs attention too (clinical review round 4, M4).
   */
  readonly refusedEntries?: number | null;
  /**
   * Why sync is refused, when the API said: `scope_too_large`, the member's access reaches more
   * homes and people than a phone can hold offline (ADR-0134).
   */
  readonly failureReason?: "scope_too_large" | null;
}

export interface SyncBannerContent {
  readonly tone: Tone;
  readonly icon: SyncBannerIcon;
  readonly title: string;
  readonly detail: string;
  /** Present when the data may be out of date. */
  readonly warning: string | null;
  /** Why sync is refused and what to do, when the API said (shown beside any warning). */
  readonly reason: string | null;
  /** The Retry button's hint for screen readers. */
  readonly retryHint: string;
  readonly stale: boolean;
  readonly showRetry: boolean;
  /** Announce changes assertively (failure or stale data) rather than politely. */
  readonly urgent: boolean;
  readonly accessibilityLabel: string;
}

/**
 * The banner's words, from the app's catalogue (`mobile.syncBanner.*`; section 5.4: every string
 * through i18n). Build them with `syncBannerWords(t)`; the logic here only chooses among them.
 */
export interface SyncBannerWords {
  readonly title: (state: SyncConnectionState) => string;
  /** Shown instead of "Up to date" while refused entries are on the device. */
  readonly refusedTitle: string;
  /**
   * Shown when the API refuses this phone because the member's access is too wide (ADR-0134;
   * HZ-138), beside the stale-data warning, never instead of it (accessibility review, blocker 1).
   */
  readonly scopeTitle: string;
  readonly scopeReason: string;
  readonly staleWarning: string;
  readonly neverSyncedWarning: string;
  readonly retryHint: string;
  readonly scopeRetryHint: string;
  /** The Retry button's words and its accessible name. */
  readonly retry: string;
  readonly retryLabel: string;
  /** "Last synced 4 minutes ago", or "Not synced yet". */
  readonly lastSynced: (lastSyncedAt: Date | null, now: Date) => string;
  /** "3 changes waiting to upload.", or null for none. */
  readonly queued: (count: number) => string | null;
  /** Entries needing attention, "could not be counted" for null, or null for none. */
  readonly refused: (count: number | null) => string | null;
}

/** A translator: the app's `t`, typed loosely so this package needs no catalogue at run time. */
export type Translate = (key: never, values?: Record<string, string | number>) => string;

/** A moment this far in the future (a wrong device clock) is said as a date, not "ago". */
const FUTURE_TOLERANCE_MS = MINUTE_MS;

/** The banner's words from the catalogue (`mobile.syncBanner.*`). */
export function syncBannerWords(translate: Translate): SyncBannerWords {
  const t = translate as unknown as (
    key: string,
    values?: Record<string, string | number>,
  ) => string;
  return {
    title: (state) => t("mobile.syncBanner.title", { state }),
    refusedTitle: t("mobile.syncBanner.refusedTitle"),
    scopeTitle: t("mobile.syncBanner.scopeTitle"),
    scopeReason: t("mobile.syncBanner.scopeReason"),
    staleWarning: t("mobile.syncBanner.stale"),
    neverSyncedWarning: t("mobile.syncBanner.neverSynced"),
    retryHint: t("mobile.syncBanner.retryHint"),
    scopeRetryHint: t("mobile.syncBanner.scopeRetryHint"),
    retry: t("mobile.syncBanner.retry"),
    retryLabel: t("mobile.syncBanner.retryLabel"),
    lastSynced: (at, now) => {
      if (!at) return t("mobile.syncBanner.lastSynced", { when: "never" });
      const diff = now.getTime() - at.getTime();
      const date = formatDate(at);
      const time = formatTime(at);
      if (diff < -FUTURE_TOLERANCE_MS || diff >= DAY_MS) {
        return t("mobile.syncBanner.lastSynced", { when: "on", date, time });
      }
      if (diff < MINUTE_MS) return t("mobile.syncBanner.lastSynced", { when: "now" });
      if (diff < HOUR_MS) {
        return t("mobile.syncBanner.lastSynced", {
          when: "minutes",
          count: Math.floor(diff / MINUTE_MS),
        });
      }
      return t("mobile.syncBanner.lastSynced", {
        when: "hours",
        count: Math.floor(diff / HOUR_MS),
      });
    },
    queued: (count) => (count > 0 ? t("mobile.syncBanner.queued", { count }) : null),
    refused: (count) =>
      count === null
        ? t("mobile.syncBanner.uncounted")
        : count > 0
          ? t("mobile.syncBanner.refused", { count })
          : null,
  };
}

export function describeSyncBanner(
  input: SyncBannerInput,
  words: SyncBannerWords,
): SyncBannerContent {
  const { state, lastSyncedAt, now, staleAfterMs } = input;
  const stale = isStale(lastSyncedAt, now, staleAfterMs);
  // While a first sync is in progress there is nothing stale on screen yet, only an empty list.
  const neverSynced = lastSyncedAt === null;

  const detailParts = [`${words.lastSynced(lastSyncedAt, now)}.`];
  const queued = words.queued(input.queuedChanges ?? 0);
  if (queued) detailParts.push(queued);
  const refused = words.refused(input.refusedEntries === undefined ? 0 : input.refusedEntries);
  if (refused) detailParts.push(refused);
  const detail = detailParts.join(" ");

  let warning: string | null = null;
  if (neverSynced && state !== "syncing") warning = words.neverSyncedWarning;
  else if (stale && !neverSynced) warning = words.staleWarning;

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
  const scopeTooLarge = input.failureReason === "scope_too_large";
  const reason = scopeTooLarge ? words.scopeReason : null;
  if (scopeTooLarge) {
    tone = "danger";
    icon = "cloud-alert";
  }
  const title = scopeTooLarge
    ? words.scopeTitle
    : refused && state === "synced"
      ? words.refusedTitle
      : words.title(state);
  const urgent = state === "failed" || warning !== null || refused !== null || scopeTooLarge;
  const accessibilityLabel = [`${title}.`, reason, detail, warning].filter(Boolean).join(" ");

  return {
    tone,
    icon,
    title,
    detail,
    warning,
    reason,
    retryHint: scopeTooLarge ? words.scopeRetryHint : words.retryHint,
    stale,
    showRetry: state === "failed" || scopeTooLarge,
    urgent,
    accessibilityLabel,
  };
}
