/**
 * The training list on the phone (mobile slice 72): every course the member may take, from the
 * API when there is a connection and from the phone when there is not, each with what it is on
 * this phone, in words. Pure apart from the translator.
 */
import {
  type CourseState,
  courseStatusWords,
  type DownloadedCourse,
  formatBytes,
  type OfflineAttempt,
} from "./offline-plan";

const STATE_ICONS: Record<CourseState, string> = {
  online: "circle-minus",
  downloading: "refresh-cw",
  on_phone: "circle-check",
  finished_waiting: "cloud-upload",
  finished: "circle-check",
};

export interface OnlineCourse {
  readonly id: string;
  readonly title: string;
  readonly status: string;
}

export interface CourseItem {
  readonly courseId: string;
  readonly title: string;
  readonly state: CourseState;
  readonly stateWords: string;
  /** A Lucide icon name shown beside the words (never colour alone). */
  readonly stateIcon: string;
  /** "12 MB" for a course on the phone, else null (known once downloaded). */
  readonly size: string | null;
  readonly canDownload: boolean;
  readonly canOpen: boolean;
  readonly canRemove: boolean;
}

export function courseItems(input: {
  readonly online: readonly OnlineCourse[] | null;
  readonly downloaded: readonly DownloadedCourse[];
  readonly attempts: readonly OfflineAttempt[];
  /** Attempts with work still in the upload queue. */
  readonly waitingAttemptIds: ReadonlySet<string>;
  readonly downloading: string | null;
}): CourseItem[] {
  const byId = new Map<string, { title: string; offered: boolean }>();
  for (const c of input.online ?? []) {
    if (c.status === "active") byId.set(c.id, { title: c.title, offered: true });
  }
  for (const d of input.downloaded) {
    if (!byId.has(d.manifest.courseId)) {
      // Kept on the phone: offered while offline, or until the member removes it.
      byId.set(d.manifest.courseId, { title: d.manifest.title, offered: input.online === null });
    }
  }
  const items: CourseItem[] = [];
  for (const [courseId, { title, offered }] of byId) {
    const kept = input.downloaded.find((d) => d.manifest.courseId === courseId) ?? null;
    const attempt = input.attempts.find((a) => a.courseId === courseId) ?? null;
    const settled = attempt !== null && attempt.status !== "in_progress";
    const state: CourseState =
      input.downloading === courseId
        ? "downloading"
        : settled
          ? input.waitingAttemptIds.has(attempt.attemptId)
            ? "finished_waiting"
            : "finished"
          : kept
            ? "on_phone"
            : "online";
    items.push({
      courseId,
      title,
      state,
      stateWords: courseStatusWords(state),
      stateIcon: STATE_ICONS[state],
      size: kept ? formatBytes(kept.manifest.totalBytes) : null,
      canDownload: !kept && offered && input.online !== null && input.downloading === null,
      canOpen: kept !== null && !settled && input.downloading !== courseId,
      canRemove: kept !== null && input.downloading !== courseId,
    });
  }
  // Work waiting to send first, so it is never off the screen; then by title.
  return items.sort(
    (a, b) =>
      Number(b.state === "finished_waiting") - Number(a.state === "finished_waiting") ||
      a.title.localeCompare(b.title, "en-GB"),
  );
}
