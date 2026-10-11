/**
 * The sync status on Today (HZ-002 stale data shown as current; HZ-006 silent sync failure): the
 * exact time of the last successful sync, the changes waiting to upload, and any entry the server
 * refused, which stays on the device as "needs attention" until someone deals with it. The banner
 * on every screen says the same in short; Today spells it out.
 */
import { isStale } from "@harbour/ui-native/logic";
import { t } from "../i18n/t";
import { ukDateTimeParts } from "./time";

export interface SyncSummaryInput {
  readonly lastSyncedAt: Date | null;
  readonly queued: number;
  readonly issues: number;
  /**
   * Entries still held after the owner signed in again, not yet back in the queue (M2); null when
   * they could not be counted, which needs attention too (clinical review round 4, M4).
   */
  readonly held: number | null;
  readonly demo: boolean;
  /** The offline window in days, when known. */
  readonly windowDays: number | null;
  readonly now: Date;
  readonly staleAfterMs: number;
}

export interface SyncSummary {
  readonly tone: "success" | "info" | "warning" | "danger";
  readonly icon: string;
  /** The last successful sync (or never, or demo mode): shown first, with the icon. */
  readonly headline: string;
  /** Changes waiting to upload; null in demo mode, where nothing uploads. */
  readonly queued: string | null;
  readonly issues: string | null;
  readonly held: string | null;
  readonly window: string | null;
  readonly stale: boolean;
  readonly needsAttention: boolean;
}

export function syncSummary(input: SyncSummaryInput): SyncSummary {
  let headline: string;
  if (input.demo) {
    headline = t("mobile.sync.demo");
  } else if (input.lastSyncedAt) {
    const { date, time } = ukDateTimeParts(input.lastSyncedAt);
    headline = t("mobile.sync.lastSuccess", { when: t("mobile.common.dateTime", { date, time }) });
  } else {
    headline = t("mobile.sync.neverSynced");
  }
  const queued = input.demo ? null : t("mobile.sync.queued", { count: input.queued });
  // Held entries need attention as much as refused ones: Today never reads "Up to date" (M2).
  const needsAttention = input.issues > 0 || input.held === null || input.held > 0;
  const issues = input.issues > 0 ? t("mobile.sync.issues", { count: input.issues }) : null;
  const held =
    input.held === null
      ? t("mobile.sync.heldUnknown")
      : input.held > 0
        ? t("mobile.sync.held", { count: input.held })
        : null;
  const window =
    !input.demo && input.windowDays !== null
      ? t("mobile.sync.window", { days: input.windowDays })
      : null;

  const stale = !input.demo && isStale(input.lastSyncedAt, input.now, input.staleAfterMs);
  const tone = needsAttention
    ? "danger"
    : stale
      ? "warning"
      : input.queued > 0
        ? "info"
        : "success";
  const icon = needsAttention
    ? "cloud-alert"
    : stale
      ? "triangle-alert"
      : input.queued > 0
        ? "cloud-upload"
        : "circle-check";
  return { tone, icon, headline, queued, issues, held, window, stale, needsAttention };
}
