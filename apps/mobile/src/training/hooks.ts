/**
 * The training list and player's reads and writes on the phone (mobile slice 72; workforce.md
 * section 14.5): courses from the API when there is a connection, the courses and attempts kept
 * on the phone, downloads with a storage check first, and what a course reports while it runs,
 * queued with client UUIDs and sent when there is a connection.
 */
import { usePowerSync, useQuery, useStatus } from "@powersync/react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useSession } from "../app-state/session";
import { platformFetch } from "../auth/clients";
import { appEnv } from "../config/app-env";
import { newEntryId } from "../platform/ids";
import { TENANT_HEADER } from "../sync/session-signals";
import { messageStatement, nextLocalAttempt, startStatement } from "./actions";
import {
  attemptMetaId,
  courseMetaId,
  type DownloadedCourse,
  type OfflineAttempt,
  parseAttempt,
  parseDownloaded,
  parseManifest,
  storageCheck,
} from "./offline-plan";
import type { RuntimeMessage } from "./offline-runtime";
import { downloadCourse, freeBytes, removeCourseFiles } from "./store";
import { courseItems, type OnlineCourse } from "./view";

export const TRAINING_SELF = "workforce.self.read";

const WRITE_META_SQL = "INSERT OR REPLACE INTO sync_meta (id, key, value) VALUES (?, ?, ?)";
const KEPT_SQL = "SELECT id, value FROM sync_meta WHERE id LIKE ? ORDER BY id";
const WAITING_SQL = `SELECT data FROM ps_crud WHERE data LIKE '%"elearning_outbox"%'`;

export type DownloadOutcome =
  | { readonly kind: "done" }
  | { readonly kind: "refused"; readonly words: string }
  | { readonly kind: "failed" };

/** Attempts with work still in the upload queue, read from it (the outbox is insert-only). */
export function waitingAttempts(rows: readonly { readonly data: string | null }[]): Set<string> {
  const ids = new Set<string>();
  for (const row of rows) {
    try {
      const entry = JSON.parse(row.data ?? "") as {
        type?: unknown;
        data?: { attempt_id?: unknown };
      };
      if (entry.type === "elearning_outbox" && typeof entry.data?.attempt_id === "string") {
        ids.add(entry.data.attempt_id);
      }
    } catch {
      // Not one of ours.
    }
  }
  return ids;
}

export function useTraining() {
  const db = usePowerSync();
  const status = useStatus();
  const { me, token } = useSession();
  const tenantId = me?.tenant.id ?? "";
  const [online, setOnline] = useState<OnlineCourse[] | null>(null);
  const [downloading, setDownloading] = useState<string | null>(null);
  const [progress, setProgress] = useState<{ done: number; total: number } | null>(null);
  const [waiting, setWaiting] = useState<Set<string>>(new Set());
  const courseParams = useMemo(() => [`elearning-course:${tenantId}:%`], [tenantId]);
  const attemptParams = useMemo(() => [`elearning-attempt:${tenantId}:%`], [tenantId]);
  const { data: courseRows } = useQuery<{ id: string; value: string | null }>(
    KEPT_SQL,
    courseParams,
  );
  const { data: attemptRows } = useQuery<{ id: string; value: string | null }>(
    KEPT_SQL,
    attemptParams,
  );
  const downloaded = useMemo(
    () => courseRows.map((r) => parseDownloaded(r.value)).filter((d): d is DownloadedCourse => !!d),
    [courseRows],
  );
  const attempts = useMemo(
    () => attemptRows.map((r) => parseAttempt(r.value)).filter((a): a is OfflineAttempt => !!a),
    [attemptRows],
  );

  const headers = useMemo(
    () => ({
      Accept: "application/json",
      Authorization: `Bearer ${token ?? ""}`,
      [TENANT_HEADER]: tenantId,
    }),
    [token, tenantId],
  );

  const refresh = useCallback(() => {
    db.getAll<{ data: string | null }>(WAITING_SQL)
      .then((rows) => setWaiting(waitingAttempts(rows)))
      .catch(() => undefined);
    if (appEnv.demoMode || !token || !tenantId) return;
    platformFetch(`${appEnv.apiUrl}/v1/workforce/elearning/courses`, {
      headers,
      credentials: "omit",
    })
      .then(async (response) => {
        if (!response.ok) return;
        const body = (await response.json()) as { items?: unknown };
        if (!Array.isArray(body.items)) return;
        setOnline(
          body.items.flatMap((c) => {
            const item = c as { id?: unknown; title?: unknown; status?: unknown };
            return typeof item.id === "string" && typeof item.title === "string"
              ? [{ id: item.id, title: item.title, status: String(item.status ?? "") }]
              : [];
          }),
        );
      })
      // Offline: the list shows the courses on the phone.
      .catch(() => setOnline(null));
  }, [db, token, tenantId, headers]);

  useEffect(() => {
    refresh();
    return db.registerListener({ statusChanged: refresh });
  }, [db, refresh]);

  const items = useMemo(
    () =>
      courseItems({
        online: status.connected ? online : null,
        downloaded,
        attempts,
        waitingAttemptIds: waiting,
        downloading,
      }),
    [status.connected, online, downloaded, attempts, waiting, downloading],
  );

  const download = useCallback(
    async (courseId: string): Promise<DownloadOutcome> => {
      if (!token || !tenantId) return { kind: "failed" };
      setDownloading(courseId);
      try {
        const response = await platformFetch(
          `${appEnv.apiUrl}/v1/workforce/elearning/courses/${encodeURIComponent(courseId)}/offline`,
          { headers, credentials: "omit" },
        );
        if (!response.ok) return { kind: "failed" };
        const manifest = parseManifest(await response.json());
        if (!manifest) return { kind: "failed" };
        // The storage check comes first, in words, before anything is written (slice 72).
        const room = storageCheck(manifest.totalBytes, freeBytes());
        if (!room.ok) return { kind: "refused", words: room.words };
        const result = await downloadCourse({
          apiUrl: appEnv.apiUrl,
          token,
          tenantId,
          manifest,
          onProgress: (done, total) => setProgress({ done, total }),
        });
        if (result !== "done") return { kind: "failed" };
        const id = courseMetaId(tenantId, courseId);
        await db.execute(WRITE_META_SQL, [
          id,
          id,
          JSON.stringify({ manifest, downloadedAt: new Date().toISOString() }),
        ]);
        return { kind: "done" };
      } catch {
        return { kind: "failed" };
      } finally {
        setDownloading(null);
        setProgress(null);
      }
    },
    [db, token, tenantId, headers],
  );

  const remove = useCallback(
    async (courseId: string) => {
      removeCourseFiles(tenantId, courseId);
      // Work waiting to send stays in the upload queue and is still sent.
      await db.execute("DELETE FROM sync_meta WHERE id IN (?, ?)", [
        courseMetaId(tenantId, courseId),
        attemptMetaId(tenantId, courseId),
      ]);
    },
    [db, tenantId],
  );

  return { items, progress, waiting: waiting.size, download, remove, refresh };
}

/** The player's side: the course on the phone, its attempt, and what the course reports. */
export function useOfflineCourse(courseId: string) {
  const db = usePowerSync();
  const { me } = useSession();
  const tenantId = me?.tenant.id ?? "";
  const [state, setState] = useState<{
    course: DownloadedCourse | null;
    attempt: OfflineAttempt | null;
    ready: boolean;
  }>({ course: null, attempt: null, ready: false });
  // The attempt as it stands after each message, so quick commits never build on a stale one.
  const current = useRef<{ course: DownloadedCourse | null; attempt: OfflineAttempt | null }>({
    course: null,
    attempt: null,
  });

  useEffect(() => {
    let active = true;
    (async () => {
      const courseRow = await db.getOptional<{ value: string | null }>(
        "SELECT value FROM sync_meta WHERE id = ?",
        [courseMetaId(tenantId, courseId)],
      );
      const course = parseDownloaded(courseRow?.value);
      if (!course) {
        if (active) setState({ course: null, attempt: null, ready: true });
        return;
      }
      const attemptRow = await db.getOptional<{ value: string | null }>(
        "SELECT value FROM sync_meta WHERE id = ?",
        [attemptMetaId(tenantId, courseId)],
      );
      let attempt = parseAttempt(attemptRow?.value);
      // A settled attempt is final: taking the course again is a new attempt.
      if (attempt?.status !== "in_progress") {
        attempt = {
          attemptId: newEntryId(),
          courseId,
          status: "in_progress",
          location: null,
          suspendData: null,
        };
        const id = attemptMetaId(tenantId, courseId);
        const start = startStatement({
          attemptId: attempt.attemptId,
          tenantId,
          manifest: course.manifest,
          at: new Date(),
        });
        await db.writeTransaction(async (tx) => {
          await tx.execute(start.sql, start.params);
          await tx.execute(WRITE_META_SQL, [id, id, JSON.stringify(attempt)]);
        });
      }
      current.current = { course, attempt };
      if (active) setState({ course, attempt, ready: true });
    })().catch(() => {
      if (active) setState({ course: null, attempt: null, ready: true });
    });
    return () => {
      active = false;
    };
  }, [db, tenantId, courseId]);

  const report = useCallback(
    async (message: RuntimeMessage) => {
      const { course, attempt } = current.current;
      if (!course || !attempt) return;
      const next = nextLocalAttempt(attempt, course.manifest.standard, message);
      current.current = { course, attempt: next };
      const queued = messageStatement({
        id: newEntryId(),
        attemptId: attempt.attemptId,
        tenantId,
        message,
        at: new Date(),
        newId: newEntryId,
      });
      const id = attemptMetaId(tenantId, courseId);
      await db.writeTransaction(async (tx) => {
        await tx.execute(queued.sql, queued.params);
        await tx.execute(WRITE_META_SQL, [id, id, JSON.stringify(next)]);
      });
      setState((s) => ({ ...s, attempt: next }));
    },
    [db, tenantId, courseId],
  );

  return { ...state, tenantId, report };
}
