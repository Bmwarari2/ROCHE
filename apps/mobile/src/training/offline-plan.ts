/**
 * Training courses taken offline on the phone (workforce.md section 14.5; MOB-007, WORK-006;
 * mobile slice 72): the storage check before a download, the safe place for each of a package's
 * files, and what the phone keeps about a downloaded course and its attempt. Pure apart from the
 * translator, so it is tested without a device.
 */
import { type MessageKey, t } from "../i18n/t";

/**
 * Room the phone keeps free after a download, so a course never fills it (a product setting, not
 * a statutory figure): 200 MB.
 */
export const STORAGE_RESERVE_BYTES = 200 * 1024 * 1024;

/** What `GET /v1/workforce/elearning/courses/{id}/offline` answers. */
export interface OfflineManifest {
  readonly courseId: string;
  readonly title: string;
  readonly standard: "scorm_1_2" | "scorm_2004" | "xapi";
  readonly launchPath: string;
  readonly launchQuery: string;
  readonly packageSha256: string;
  readonly files: readonly { readonly path: string; readonly size: number }[];
  readonly totalBytes: number;
}

/** A course on the phone, as kept in `sync_meta` once every file has downloaded. */
export interface DownloadedCourse {
  readonly manifest: OfflineManifest;
  readonly downloadedAt: string;
}

/** The phone's attempt at a downloaded course: where to resume and how it stands. */
export interface OfflineAttempt {
  readonly attemptId: string;
  readonly courseId: string;
  readonly status: "in_progress" | "completed" | "passed" | "failed";
  readonly location: string | null;
  readonly suspendData: string | null;
  /** Statements queued for this attempt: never more than the server keeps (5,000). */
  readonly statementsQueued?: number;
}

/** As the server keeps per attempt (`STATEMENTS_PER_ATTEMPT_MAX`). */
export const STATEMENTS_PER_ATTEMPT_MAX = 5000;

/** Commits are saved at most this often while a course runs; finishing saves at once. */
export const COMMIT_GAP_MS = 5000;

/** Sizes in words: "850 KB", "12 MB", "1.2 GB". */
export function formatBytes(bytes: number): string {
  const kb = 1024;
  const mb = kb * 1024;
  const gb = mb * 1024;
  if (bytes >= gb) return t("mobile.training.size.gb", { size: (bytes / gb).toFixed(1) });
  if (bytes >= mb) return t("mobile.training.size.mb", { size: String(Math.ceil(bytes / mb)) });
  return t("mobile.training.size.kb", { size: String(Math.max(1, Math.ceil(bytes / kb))) });
}

export type StorageCheck = { readonly ok: true } | { readonly ok: false; readonly words: string };

/** Whether the phone has room for a course and its reserve, said in words when it has not. */
export function storageCheck(totalBytes: number, availableBytes: number): StorageCheck {
  if (!Number.isFinite(availableBytes) || availableBytes < 0) {
    return { ok: false, words: t("mobile.training.roomUnknown") };
  }
  if (totalBytes + STORAGE_RESERVE_BYTES <= availableBytes) return { ok: true };
  return {
    ok: false,
    words: t("mobile.training.noRoom", {
      needed: formatBytes(totalBytes + STORAGE_RESERVE_BYTES),
      free: formatBytes(availableBytes),
    }),
  };
}

/**
 * A package file's path as folder names under the course's own folder, or null when it could
 * leave it or name something odd (the API has already checked the package; this is the phone's
 * own check before writing anything).
 */
export function safeSegments(path: string): string[] | null {
  if (path.length === 0 || path.length > 240 || path.startsWith("/") || path.endsWith("/")) {
    return null;
  }
  // biome-ignore lint/suspicious/noControlCharactersInRegex: control characters are refused.
  if (/[\\:?#%*"<>|\u0000-\u001f\u007f]/.test(path)) return null;
  const segments = path.split("/");
  if (segments.some((s) => s === "" || s === "." || s === "..")) return null;
  return segments;
}

/** Checks a manifest before anything is downloaded: every path safe, sizes that add up. */
export function manifestProblem(m: OfflineManifest): string | null {
  if (!m.files.some((f) => f.path === m.launchPath)) return "launch_missing";
  if (m.files.some((f) => !safeSegments(f.path) || !(f.size >= 0))) return "unsafe_path";
  if (new Set(m.files.map((f) => f.path)).size !== m.files.length) return "duplicate";
  if (m.files.reduce((n, f) => n + f.size, 0) !== m.totalBytes) return "size_mismatch";
  if (!/^[0-9a-f]{64}$/.test(m.packageSha256)) return "hash";
  return null;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Reads the API's offline answer, or null when it is not one. */
export function parseManifest(body: unknown): OfflineManifest | null {
  if (typeof body !== "object" || body === null) return null;
  const b = body as Record<string, unknown>;
  if (
    typeof b.courseId !== "string" ||
    !UUID.test(b.courseId) ||
    typeof b.title !== "string" ||
    (b.standard !== "scorm_1_2" && b.standard !== "scorm_2004" && b.standard !== "xapi") ||
    typeof b.launchPath !== "string" ||
    typeof b.launchQuery !== "string" ||
    typeof b.packageSha256 !== "string" ||
    typeof b.totalBytes !== "number" ||
    !Array.isArray(b.files)
  ) {
    return null;
  }
  const files: { path: string; size: number }[] = [];
  for (const f of b.files) {
    if (typeof f !== "object" || f === null) return null;
    const { path, size } = f as { path?: unknown; size?: unknown };
    if (typeof path !== "string" || typeof size !== "number") return null;
    files.push({ path, size });
  }
  const manifest: OfflineManifest = {
    courseId: b.courseId,
    title: b.title,
    standard: b.standard,
    launchPath: b.launchPath,
    launchQuery: b.launchQuery,
    packageSha256: b.packageSha256,
    files,
    totalBytes: b.totalBytes,
  };
  return manifestProblem(manifest) ? null : manifest;
}

/** Where a tenant's course and attempt are kept in `sync_meta`. */
export const courseMetaId = (tenantId: string, courseId: string) =>
  `elearning-course:${tenantId}:${courseId}`;
export const attemptMetaId = (tenantId: string, courseId: string) =>
  `elearning-attempt:${tenantId}:${courseId}`;
export const COURSE_META_PREFIX = "elearning-course:";

export function parseDownloaded(value: string | null | undefined): DownloadedCourse | null {
  if (!value) return null;
  try {
    const kept = JSON.parse(value) as { manifest?: unknown; downloadedAt?: unknown };
    const manifest = parseManifest(kept.manifest);
    return manifest && typeof kept.downloadedAt === "string"
      ? { manifest, downloadedAt: kept.downloadedAt }
      : null;
  } catch {
    return null;
  }
}

export function parseAttempt(value: string | null | undefined): OfflineAttempt | null {
  if (!value) return null;
  try {
    const a = JSON.parse(value) as Record<string, unknown>;
    const status = a.status;
    if (
      typeof a.attemptId !== "string" ||
      !UUID.test(a.attemptId) ||
      typeof a.courseId !== "string" ||
      (status !== "in_progress" &&
        status !== "completed" &&
        status !== "passed" &&
        status !== "failed")
    ) {
      return null;
    }
    return {
      attemptId: a.attemptId,
      courseId: a.courseId,
      status,
      location: typeof a.location === "string" ? a.location : null,
      suspendData: typeof a.suspendData === "string" ? a.suspendData : null,
      statementsQueued: typeof a.statementsQueued === "number" ? a.statementsQueued : 0,
    };
  } catch {
    return null;
  }
}

export type CourseState = "online" | "downloading" | "on_phone" | "finished_waiting" | "finished";

const STATE_WORDS = {
  online: "mobile.training.state.online",
  downloading: "mobile.training.state.downloading",
  on_phone: "mobile.training.state.on_phone",
  finished_waiting: "mobile.training.state.finished_waiting",
  finished: "mobile.training.state.finished",
} as const satisfies Record<CourseState, MessageKey>;

/** What a course's card says about it, in words (never by colour alone). */
export function courseStatusWords(state: CourseState): string {
  return t(STATE_WORDS[state]);
}

/**
 * Whether an address the course asks to open is one of its own files: a `file:` address under the
 * course's folder once dot segments and escapes are resolved, never a folder beside it with a
 * similar name (security review of slice 72, L7).
 */
export function isInsideFolder(url: string, folder: string): boolean {
  let target: URL;
  let root: URL;
  try {
    target = new URL(url);
    root = new URL(folder.endsWith("/") ? folder : `${folder}/`);
  } catch {
    return false;
  }
  if (target.protocol !== "file:" || root.protocol !== "file:") return false;
  let path: string;
  try {
    path = decodeURIComponent(target.pathname);
  } catch {
    return false;
  }
  const rootPath = decodeURIComponent(root.pathname);
  if (path.split("/").some((s) => s === "..")) return false;
  return path.startsWith(rootPath) && path.length > rootPath.length;
}
