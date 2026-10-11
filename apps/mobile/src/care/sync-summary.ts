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
  readonly demo: boolean;
  /** The offline window in days, when known. */
  readonly windowDays: number | null;
  readonly now: Date;
  readonly staleAfterMs: number;
}

export interface SyncSummary {
  readonly tone: "success" | "info" | "warning" | "danger";
  readonly icon: string;
  readonly lines: readonly string[];
  readonly stale: boolean;
  readonly needsAttention: boolean;
}

export function syncSummary(input: SyncSummaryInput): SyncSummary {
  const lines: string[] = [];
  if (input.demo) {
    lines.push(t("mobile.sync.demo"));
  } else if (input.lastSyncedAt) {
    const { date, time } = ukDateTimeParts(input.lastSyncedAt);
    lines.push(t("mobile.sync.lastSuccess", { when: t("mobile.common.dateTime", { date, time }) }));
  } else {
    lines.push(t("mobile.sync.neverSynced"));
  }
  if (!input.demo) lines.push(t("mobile.sync.queued", { count: input.queued }));
  const needsAttention = input.issues > 0;
  if (needsAttention) lines.push(t("mobile.sync.issues", { count: input.issues }));
  if (!input.demo && input.windowDays !== null) {
    lines.push(t("mobile.sync.window", { days: input.windowDays }));
  }

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
  return { tone, icon, lines, stale, needsAttention };
}
