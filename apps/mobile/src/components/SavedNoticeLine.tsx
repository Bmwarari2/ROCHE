import { Button, useTheme } from "@harbour/ui-native";
import { useEffect } from "react";
import { View } from "react-native";
import { clearSavedNotice, savedNoticeWords, useSavedNotice } from "../care/saved-notice";
import { appEnv } from "../config/app-env";
import { t } from "../i18n/t";
import { StatusLine } from "./StatusLine";

/**
 * The save confirmation on a person's record (HZ-001): what was saved, for whom, in words with an
 * icon, until it is dismissed (a 44 pt button) or another person's record opens. It is part of
 * the page, not a live region: the save already announced it to screen readers.
 */
export function SavedNoticeLine({ personId }: { readonly personId: string }) {
  const theme = useTheme();
  const notice = useSavedNotice(personId);
  // Opening another person's record drops a notice that names someone else.
  useEffect(() => {
    if (!notice) clearSavedNotice();
  }, [notice]);
  if (!notice) return null;
  return (
    <View style={{ gap: theme.space[1] }} testID="saved-notice">
      <StatusLine tone="success">{savedNoticeWords(notice, t, appEnv.demoMode)}</StatusLine>
      <Button
        label={t("mobile.form.savedDismiss")}
        accessibilityHint={t("mobile.form.savedDismissHint")}
        variant="secondary"
        onPress={clearSavedNotice}
        testID="saved-notice-dismiss"
      />
    </View>
  );
}
