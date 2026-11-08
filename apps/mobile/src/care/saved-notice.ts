import type { OfflineWindowTable } from "@harbour/sync/client";
import { useSyncExternalStore } from "react";
import type { MessageKey } from "../i18n/t";

/**
 * What a form saved, for whom (HZ-001: "the app confirms the save naming the person and returns to
 * that person or the list"; no automatic advance). The form sets it as it goes back; the person's
 * record shows it until it is dismissed or another person's record is opened. Held in memory
 * only: it names a person, so it never reaches storage or a log.
 */
export interface SavedNotice {
  readonly personId: string;
  readonly personName: string;
  readonly table: OfflineWindowTable;
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

/** The notice for this person's record, or null (another person's is never shown here). */
export function savedNoticeFor(personId: string): SavedNotice | null {
  return current && current.personId === personId ? current : null;
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
  return notice && notice.personId === personId ? notice : null;
}

const SAVED_WHAT = {
  care_note: ["mobile.form.savedWhat.note", "mobile.form.savedWhat.noteCorrected"],
  observation: ["mobile.form.savedWhat.chart", "mobile.form.savedWhat.chartCorrected"],
  body_map_mark: ["mobile.form.savedWhat.bodyMap", "mobile.form.savedWhat.bodyMapCorrected"],
} as const satisfies Partial<Record<OfflineWindowTable, readonly [MessageKey, MessageKey]>>;

/** The words for what was saved: a note, a chart entry or a body map mark, or its correction. */
export function savedWhatKey(table: OfflineWindowTable, corrected: boolean): MessageKey {
  const keys = table in SAVED_WHAT ? SAVED_WHAT[table as keyof typeof SAVED_WHAT] : null;
  if (!keys)
    return corrected ? "mobile.form.savedWhat.entryCorrected" : "mobile.form.savedWhat.entry";
  return corrected ? keys[1] : keys[0];
}

/** The confirmation in words, naming the person and what was saved (HZ-001). */
export function savedNoticeWords(
  notice: Pick<SavedNotice, "personName" | "table" | "corrected">,
  translate: (key: MessageKey, values?: Record<string, string>) => string,
  demo: boolean,
): string {
  return translate(demo ? "mobile.form.savedForDemo" : "mobile.form.savedFor", {
    what: translate(savedWhatKey(notice.table, notice.corrected)),
    name: notice.personName,
  });
}
