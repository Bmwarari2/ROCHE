import type { ExportItem } from "@harbour/contracts";
import type { Translator } from "@harbour/i18n";
import type { SafetyChip } from "./incidents";

/**
 * The organisation's full export page (PLAT-015; platform-completions.md rules 12 to 15; HZ-070).
 * Pure and unit tested. Every state is the API's; the page says it with an icon and a word, and a
 * state it does not know warns rather than reading as calm.
 */

export const EXPORT_PERMISSION = "platform.export.create";
export const EXPORT_PAGE = "/settings/export";

export function exportShown(permissions: readonly string[]): boolean {
  return permissions.includes(EXPORT_PERMISSION);
}

export type ExportState =
  | "queued"
  | "running"
  | "ready"
  | "downloaded"
  | "expired"
  | "failed"
  | "cancelled";

/** Where an export stands, as the page says it: a ready export already fetched is downloaded. */
export function exportStateOf(item: Pick<ExportItem, "status" | "downloadedAt">): ExportState {
  if (item.status === "ready" && item.downloadedAt) return "downloaded";
  if (item.status === "revoked") return "cancelled";
  return item.status;
}

const CHIPS: Record<ExportState, Omit<SafetyChip, "label">> = {
  queued: { status: "due", icon: "clock" },
  running: { status: "due", icon: "clock" },
  ready: { status: "done", icon: "circle-check" },
  downloaded: { status: "done", icon: "send" },
  expired: { status: "notApplicable", icon: "circle-minus" },
  failed: { status: "overdue", icon: "triangle-alert" },
  cancelled: { status: "notApplicable", icon: "circle-minus" },
};

export function exportChip(state: string, t: Translator): SafetyChip {
  const known = CHIPS[state as ExportState];
  return {
    ...(known ?? { status: "overdue", icon: "circle-alert" }),
    label: t("export.state", { state: known ? state : "unknown" }),
  };
}

/** Cancelling deletes the archive: offered while one is being made or waiting to be fetched. */
export function mayCancel(state: ExportState): boolean {
  return state === "queued" || state === "running" || state === "ready";
}

/** One export at a time: a new one is offered when none is being made. */
export function mayRequest(items: readonly Pick<ExportItem, "status">[]): boolean {
  return !items.some((i) => i.status === "queued" || i.status === "running");
}

/** "12.4 MB", for the archive's size. */
export function sizeWords(bytes: number | null, t: Translator): string | null {
  if (bytes === null) return null;
  const mb = bytes / 1_000_000;
  return mb < 0.1 ? t("export.size.small") : t("export.size.mb", { mb: mb.toFixed(1) });
}

/** Download refusals the page has words for, from the API's codes. */
export const DOWNLOAD_PROBLEMS = [
  "export_already_downloaded",
  "export_expired",
  "export_revoked",
  "export_not_ready",
  "export_failed",
  "not_requester",
  "failed",
] as const;
export type DownloadProblem = (typeof DOWNLOAD_PROBLEMS)[number];

export function downloadProblem(value: unknown): DownloadProblem | null {
  return typeof value === "string" && (DOWNLOAD_PROBLEMS as readonly string[]).includes(value)
    ? (value as DownloadProblem)
    : null;
}

/**
 * Where a download the API refused goes: to sign in again (step-up, with the way back), or back to
 * the export page with what happened in words, a new `at` each time so it is said again.
 */
export function downloadFailureTarget(code: string | undefined, now: Date = new Date()): string {
  if (code === "step_up_required" || code === "unauthenticated") {
    const params: Record<string, string> =
      code === "step_up_required"
        ? { reason: "step-up", next: EXPORT_PAGE }
        : { next: EXPORT_PAGE };
    return `/sign-in?${new URLSearchParams(params).toString()}`;
  }
  const problem = downloadProblem(code) ?? "failed";
  return `${EXPORT_PAGE}?${new URLSearchParams({ problem, at: String(now.getTime()) }).toString()}`;
}
