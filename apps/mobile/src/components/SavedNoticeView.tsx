import { Button, useTheme } from "@harbour/ui-native";
import { View } from "react-native";
import { type SavedNotice, savedNoticeWords } from "../care/saved-notice";
import { t } from "../i18n/t";
import { StatusLine } from "./StatusLine";

/** The save confirmation as drawn: the words with their icon, and a 44 pt button to hide it. */
export function SavedNoticeView({
  notice,
  demo,
  onHide,
}: {
  readonly notice: SavedNotice;
  readonly demo: boolean;
  readonly onHide: () => void;
}) {
  const theme = useTheme();
  return (
    <View style={{ gap: theme.space[1] }} testID="saved-notice">
      <StatusLine tone="success">{savedNoticeWords(notice, t, demo)}</StatusLine>
      <Button
        label={t("mobile.form.savedDismiss")}
        variant="secondary"
        onPress={onHide}
        testID="saved-notice-dismiss"
      />
    </View>
  );
}
