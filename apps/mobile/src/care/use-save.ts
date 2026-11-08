import type { OfflineWindowTable } from "@harbour/sync/client";
import { usePowerSync } from "@powersync/react";
import { useRouter } from "expo-router";
import { useCallback, useState } from "react";
import { AccessibilityInfo, InteractionManager } from "react-native";
import { useCarePerson } from "../components/CarePersonHeader";
import { appEnv } from "../config/app-env";
import { t } from "../i18n/t";
import type { EntryRow } from "./entries";
import { useSaveEntry } from "./hooks";
import { INSERT_INCIDENT_SQL, type IncidentRow, insertIncidentParams } from "./incidents";
import { type NoticeTable, savedNoticeWords, setSavedNotice } from "./saved-notice";

/**
 * Saving a form for one person: writes the entry to the encrypted database (the upload queue
 * sends it when there is a connection), confirms the save naming the person and what was saved,
 * on their record and to screen readers, and goes back to that record or the list; never on to
 * another person (HZ-001). A failure to write locally is shown, never swallowed.
 */
export function useSaveAndReturn(personId: string) {
  const router = useRouter();
  const save = useSaveEntry();
  const db = usePowerSync();
  const { person } = useCarePerson(personId);
  const [saving, setSaving] = useState(false);
  const [saveFailed, setSaveFailed] = useState(false);
  const personName = person?.id === personId ? person.displayName : null;

  /** Runs the local write, then confirms naming the person and goes back (HZ-001). */
  const finish = useCallback(
    async (table: NoticeTable, corrected: boolean, write: () => Promise<void>) => {
      setSaving(true);
      setSaveFailed(false);
      try {
        await write();
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
    [router, personId, personName],
  );

  const submit = useCallback(
    (table: OfflineWindowTable, row: EntryRow) =>
      finish(table, typeof row.supersedes_id === "string" && row.supersedes_id !== "", () =>
        save(table, row),
      ),
    [finish, save],
  );

  /** An incident report: queued in `incident_outbox`, never an entry (`incidents.ts`). */
  const report = useCallback(
    (row: IncidentRow) =>
      finish("incident_outbox", false, () =>
        db.execute(INSERT_INCIDENT_SQL, [...insertIncidentParams(row)]).then(() => undefined),
      ),
    [finish, db],
  );

  return { submit, report, saving, saveFailed };
}
