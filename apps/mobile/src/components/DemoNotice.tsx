import { nativeMetrics, Text, useTheme } from "@harbour/ui-native";
import { StyleSheet, useWindowDimensions, View } from "react-native";
import { t } from "../i18n/t";

/**
 * The line that says the app is in demo mode, so invented people are never taken for real
 * records. Shown at the top of every signed-in screen (`Screen`) and on the mode chooser. At the
 * largest text sizes it keeps to a few words, since it never scrolls away; the whole sentence is
 * still spoken (iOS device check, 14/11/2026).
 */
export function DemoNotice() {
  const theme = useTheme();
  const { fontScale } = useWindowDimensions();
  const short = fontScale > nativeMetrics.wrapFontScale;
  return (
    <View
      testID="demo-notice"
      style={[
        styles.notice,
        {
          backgroundColor: theme.colors.accentContainer,
          borderBottomColor: theme.colors.border,
          paddingHorizontal: theme.space[2],
          paddingVertical: theme.space[1],
        },
      ]}
    >
      <Text
        variant="bodyDense"
        accessibilityLabel={t("mobile.demo.notice")}
        style={{ color: theme.colors.onAccentContainer }}
      >
        {short ? t("mobile.demo.noticeShort") : t("mobile.demo.notice")}
      </Text>
    </View>
  );
}

const styles = StyleSheet.create({
  notice: { borderBottomWidth: StyleSheet.hairlineWidth },
});
