import type { OfflineWindowTable } from "@harbour/sync/client";
import { useRouter } from "expo-router";
import { useCallback, useState } from "react";
import { AccessibilityInfo } from "react-native";
import { appEnv } from "../config/app-env";
import { t } from "../i18n/t";
import type { EntryRow } from "./entries";
import { useSaveEntry } from "./hooks";

/**
 * Saving a form: writes the entry to the encrypted database (the upload queue sends it when there
 * is a connection), says so to screen readers, and goes back to the record. A failure to write
 * locally is shown, never swallowed.
 */
export function useSaveAndReturn() {
  const router = useRouter();
  const save = useSaveEntry();
  const [saving, setSaving] = useState(false);
  const [saveFailed, setSaveFailed] = useState(false);

  const submit = useCallback(
    async (table: OfflineWindowTable, row: EntryRow) => {
      setSaving(true);
      setSaveFailed(false);
      try {
        await save(table, row);
        AccessibilityInfo.announceForAccessibility(
          t(appEnv.demoMode ? "mobile.form.savedDemo" : "mobile.form.saved"),
        );
        router.back();
      } catch {
        setSaveFailed(true);
      } finally {
        setSaving(false);
      }
    },
    [save, router],
  );

  return { submit, saving, saveFailed };
}
