import type { OfflineWindowTable } from "@harbour/sync/client";
import { useRouter } from "expo-router";
import { useCallback, useState } from "react";
import { AccessibilityInfo, InteractionManager } from "react-native";
import { useCarePerson } from "../components/CarePersonHeader";
import { appEnv } from "../config/app-env";
import { t } from "../i18n/t";
import type { EntryRow } from "./entries";
import { useSaveEntry } from "./hooks";
import { savedNoticeWords, setSavedNotice } from "./saved-notice";

/**
 * Saving a form for one person: writes the entry to the encrypted database (the upload queue
 * sends it when there is a connection), confirms the save naming the person and what was saved,
 * on their record and to screen readers, and goes back to that record or the list; never on to
 * another person (HZ-001). A failure to write locally is shown, never swallowed.
 */
export function useSaveAndReturn(personId: string) {
  const router = useRouter();
  const save = useSaveEntry();
  const { person } = useCarePerson(personId);
  const [saving, setSaving] = useState(false);
  const [saveFailed, setSaveFailed] = useState(false);
  const personName = person?.id === personId ? person.displayName : null;

  const submit = useCallback(
    async (table: OfflineWindowTable, row: EntryRow) => {
      setSaving(true);
      setSaveFailed(false);
      try {
        await save(table, row);
        const corrected = typeof row.supersedes_id === "string" && row.supersedes_id !== "";
        // The form shows Save only once the person has loaded, so the name is known; if sync
        // removed them meanwhile, the save is still confirmed, without a name.
        let words = t(appEnv.demoMode ? "mobile.form.savedDemo" : "mobile.form.saved");
        if (personName) {
          const notice = { personId, personName, table, corrected, at: Date.now() };
          setSavedNotice(notice);
          words = savedNoticeWords(notice, t, appEnv.demoMode);
        }
        router.back();
        // Said once the record is on screen, so the screen change does not cut it off
        // (accessibility review M1); the line itself is not a live region, so it is heard once.
        InteractionManager.runAfterInteractions(() => {
          AccessibilityInfo.announceForAccessibility(words);
        });
      } catch {
        setSaveFailed(true);
      } finally {
        setSaving(false);
      }
    },
    [save, router, personId, personName],
  );

  return { submit, saving, saveFailed };
}
