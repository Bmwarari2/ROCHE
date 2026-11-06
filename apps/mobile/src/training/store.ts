/**
 * Courses kept on the phone (mobile slice 72): each package file downloaded into the app's own
 * documents folder, under the organisation's and the course's folder, and the record of the
 * course kept in `sync_meta` only once every file has arrived at its expected size. A failed
 * download leaves nothing behind. Course files are the organisation's training content, not
 * personal data; the attempt's progress stays in the encrypted database.
 */
import { Directory, File, Paths } from "expo-file-system";
import { TENANT_HEADER } from "../sync/session-signals";
import { type OfflineManifest, safeSegments } from "./offline-plan";

export function courseFolder(tenantId: string, courseId: string): Directory {
  return new Directory(Paths.document, "elearning", tenantId, courseId);
}

export function freeBytes(): number {
  try {
    return Paths.availableDiskSpace;
  } catch {
    return Number.NaN;
  }
}

/** Downloads every file of a course, or nothing: "done" or "failed". */
export async function downloadCourse(input: {
  readonly apiUrl: string;
  readonly token: string;
  readonly tenantId: string;
  readonly manifest: OfflineManifest;
  readonly onProgress: (done: number, total: number) => void;
}): Promise<"done" | "failed"> {
  const { manifest } = input;
  const folder = courseFolder(input.tenantId, manifest.courseId);
  try {
    if (folder.exists) folder.delete();
    folder.create({ intermediates: true, idempotent: true });
    let done = 0;
    input.onProgress(done, manifest.files.length);
    for (const f of manifest.files) {
      const segments = safeSegments(f.path);
      if (!segments) throw new Error("unsafe path");
      const name = segments[segments.length - 1] ?? "";
      const parent = segments.length > 1 ? new Directory(folder, ...segments.slice(0, -1)) : folder;
      parent.create({ intermediates: true, idempotent: true });
      const target = new File(parent, name);
      const url = `${input.apiUrl}/v1/workforce/elearning/courses/${encodeURIComponent(
        manifest.courseId,
      )}/offline/files/${encodeURIComponent(f.path)}`;
      const saved = await File.downloadFileAsync(url, target, {
        headers: { Authorization: `Bearer ${input.token}`, [TENANT_HEADER]: input.tenantId },
        idempotent: true,
      });
      if (saved.size !== f.size) throw new Error("size");
      done += 1;
      input.onProgress(done, manifest.files.length);
    }
    return "done";
  } catch {
    try {
      if (folder.exists) folder.delete();
    } catch {
      // Nothing more to do: the course is not recorded as on the phone.
    }
    return "failed";
  }
}

export function removeCourseFiles(tenantId: string, courseId: string): void {
  const folder = courseFolder(tenantId, courseId);
  if (folder.exists) folder.delete();
}

/** The launch page's file on the phone, or null when it is not there. */
export function launchFile(tenantId: string, manifest: OfflineManifest): File | null {
  const segments = safeSegments(manifest.launchPath);
  if (!segments) return null;
  const file = new File(courseFolder(tenantId, manifest.courseId), ...segments);
  return file.exists ? file : null;
}

/**
 * Every course on the phone, for every organisation: removed with everything else when the
 * session ends, the phone is wiped or the database is held (security review of slice 72, L8).
 * Never throws: a failure leaves only training content, which holds no personal data.
 */
export function removeAllCourseFiles(): void {
  try {
    const all = new Directory(Paths.document, "elearning");
    if (all.exists) all.delete();
  } catch {
    // Training content only; the next wipe tries again.
  }
}
