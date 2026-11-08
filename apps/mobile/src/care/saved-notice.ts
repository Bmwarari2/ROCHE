import { formatUkTime } from "@harbour/domain";
import type { OfflineWindowTable } from "@harbour/sync/client";
import { useSyncExternalStore } from "react";
import type { MessageKey } from "../i18n/t";

/**
 * What a form saved, for whom (HZ-001: "the app confirms the save naming the person and returns to
 * that person or the list"; no automatic advance). The form sets it as it goes back; the person's
 * record shows it until it is dismissed or another person's record is opened. Held in memory
 * only: it names a person, so it never reaches storage or a log.
 */
/** What a notice can be about: an entry, or an incident report (`incidents.ts`). */
export type NoticeTable = OfflineWindowTable | "incident_outbox";

export interface SavedNotice {
  readonly personId: string;
  readonly personName: string;
  readonly table: NoticeTable;
  readonly corrected: boolean;
  readonly at: number;
}

let current: SavedNotice | null = null;
const listeners = new Set<() => void>();
const emit = () => {
  for (const listener of listeners) listener();
};

export function setSavedNotice(notice: SavedNotice): void {
  current = notice;
  emit();
}

export function clearSavedNotice(): void {
  if (current === null) return;
  current = null;
  emit();
}

/** The notice for this person's record, or null (another person's, or a stale one, never). */
export function savedNoticeFor(personId: string, now = Date.now()): SavedNotice | null {
  return current ? noticeIfFor(current, personId, now) : null;
}

/** Drops a notice that names someone else: called when a person's record opens. */
export function clearNoticeForOthers(personId: string): void {
  if (current && current.personId !== personId) clearSavedNotice();
}

export function useSavedNotice(personId: string): SavedNotice | null {
  const notice = useSyncExternalStore(
    (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    () => current,
    () => current,
  );
  return notice ? noticeIfFor(notice, personId, Date.now()) : null;
}

/** The one filter the record and the tests share: this person's notice, while current. */
export function noticeIfFor(
  notice: SavedNotice,
  personId: string,
  now: number,
): SavedNotice | null {
  return notice.personId === personId && noticeCurrent(notice, now) ? notice : null;
}

/**
 * How long a notice stays: a convenience for the screen, not a care rule. Past it the notice is
 * gone, so a record opened much later never says a save just happened (accessibility review M3).
 */
export const SAVED_NOTICE_MS = 15 * 60_000;

/** The kind of entry, for the one whole sentence the catalogue holds per kind (CONTENT.md). */
export function savedKind(table: NoticeTable, corrected: boolean): string {
  if (table === "incident_outbox") return "incident";
  const what =
    table === "care_note"
      ? "note"
      : table === "body_map_mark"
        ? "bodyMap"
        : table === "observation"
          ? "chart"
          : "entry";
  return corrected ? `${what}Corrected` : what;
}

/** Whether the notice is still current at `now`. */
export function noticeCurrent(notice: Pick<SavedNotice, "at">, now: number): boolean {
  return now - notice.at >= 0 && now - notice.at < SAVED_NOTICE_MS;
}

/** The confirmation in words, naming the person, what was saved and when (HZ-001). */
export function savedNoticeWords(
  notice: Pick<SavedNotice, "personName" | "table" | "corrected" | "at">,
  translate: (key: MessageKey, values?: Record<string, string>) => string,
  demo: boolean,
): string {
  return translate(demo ? "mobile.form.savedForDemo" : "mobile.form.savedFor", {
    kind: savedKind(notice.table, notice.corrected),
    name: notice.personName,
    time: formatUkTime(new Date(notice.at)),
  });
}
